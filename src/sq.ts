import type { Env } from './index';

// Streamers Queue API (Candi, https://sq.candycz01.xyz) – full queue history with ELO.
// The key is a secret (SQ_API_KEY), never in code. Limit: 1800 requests/hour per key.
//
// Players there are Discord users (id = Discord ID, displayName = Discord name), while the
// streamersclash.cz board (queue_players.key) uses the site nickname ("DVLK" vs "dvlk696").
// They're paired by: the stored sq_id, the Discord ID inside the site's avatar URL, the name,
// and – from games known from both sources – the one unpaired player per team.
//
// The full history (~8 MB) is too big to parse in a free-plan Worker: the page downloads it once
// ("Načíst historii z API") and sends it back in small chunks to /api/queue/import. The cron then
// keeps it up to date with small requests (active games + the games that just ended).

export interface SqPlayer {
  id: string;
  username?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  elo?: number | null;
  wins?: number;
  losses?: number;
  totalGames?: number;
  lastPlayedAt?: string | null;
  team?: string | null;
}

/** A game as stored/imported: teams flattened to player lists. */
export interface SqGame {
  id: string;
  gameNumber: number;
  state: string;
  winner: string | null;
  createdAt?: string | null;
  endedAt?: string | null;
  blue: SqPlayer[];
  red: SqPlayer[];
}

const ENDED_PER_RUN = 6; // individual /api/games/:n lookups per cron run

export function sqEnabled(env: Env): boolean {
  return !!env.SQ_API_KEY;
}

function base(env: Env): string {
  return String(env.SQ_BASE_URL || 'https://sq.candycz01.xyz').replace(/\/+$/, '');
}

export class SqError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function sqFetch(env: Env, path: string): Promise<Response> {
  if (!env.SQ_API_KEY) throw new SqError(503, 'SQ_API_KEY není nastavený');
  const res = await fetch(base(env) + path, {
    headers: { accept: 'application/json', 'x-api-key': env.SQ_API_KEY, 'user-agent': 'sgoob-scouting (sc.daotech.dev)' },
  });
  if (res.status === 429) throw new SqError(429, `Streamers Queue API: limit vyčerpaný (zkus za ${res.headers.get('retry-after') ?? '?'} s)`);
  return res;
}

async function sqJson<T>(env: Env, path: string): Promise<T | null> {
  const res = await sqFetch(env, path);
  if (res.status === 404) return null;
  if (!res.ok) throw new SqError(res.status, `Streamers Queue API ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Raw game from the API → teams as player lists. */
export function flattenGame(g: Record<string, unknown>): SqGame {
  const teams = (g.teams ?? {}) as Record<string, { players?: SqPlayer[] } | undefined>;
  const flat = (Array.isArray(g.players) ? g.players : []) as SqPlayer[];
  const side = (s: 'blue' | 'red') => {
    const list = teams[s]?.players ?? [];
    return list.length ? list : flat.filter((p) => String(p.team ?? '').toLowerCase() === s);
  };
  return {
    id: String(g.id), gameNumber: Number(g.gameNumber), state: String(g.state ?? ''),
    winner: g.winner == null ? null : String(g.winner),
    createdAt: (g.createdAt as string) ?? null, endedAt: (g.endedAt as string) ?? null,
    blue: side('blue').map(slimPlayer), red: side('red').map(slimPlayer),
  };
}

const slimPlayer = (p: SqPlayer): SqPlayer => ({
  id: String(p.id), displayName: p.displayName ?? null, username: p.username ?? null, avatar: p.avatar ?? null,
});

const lower = (s: unknown) => String(s ?? '').trim().toLowerCase();
const discordIdOf = (u: unknown) => /discordapp\.com\/avatars\/(\d+)\//.exec(String(u ?? ''))?.[1] ?? null;
const nameOf = (p: SqPlayer) => String(p.displayName || p.username || p.id).trim();

// "2026-10-28T20:15:00.000Z" → day "28. 10.", time "21:15" (Prague), like the streamersclash.cz data
function pragueParts(iso: string | null | undefined): { day: string | null; time: string | null } {
  if (!iso) return { day: null, time: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: null, time: null };
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { day: `${p.day}. ${p.month}.`, time: `${p.hour}:${p.minute}` };
}

interface Row { key: string; nickname: string; avatar: string | null; sq_id: string | null }

class Pairing {
  byKey = new Map<string, Row>();
  bySq = new Map<string, string>(); // sq id → key
  byDiscordAvatar = new Map<string, string>();
  constructor(rows: Row[]) {
    for (const r of rows) {
      this.byKey.set(r.key, r);
      if (r.sq_id) this.bySq.set(r.sq_id, r.key);
      const d = discordIdOf(r.avatar);
      if (d) this.byDiscordAvatar.set(d, r.key);
    }
  }
  static async load(db: D1Database): Promise<Pairing> {
    const { results } = await db.prepare('SELECT key, nickname, avatar, sq_id FROM queue_players').all<Row>();
    return new Pairing(results);
  }
  /** Existing queue player for an API player, or null. */
  find(p: SqPlayer): string | null {
    const known = this.bySq.get(p.id);
    if (known) return known;
    const free = (k: string | undefined | null) => (k && this.byKey.has(k) && !this.byKey.get(k)!.sq_id ? k : null);
    return free(this.byDiscordAvatar.get(p.id)) ?? free(lower(p.displayName)) ?? free(lower(p.username));
  }
  nick(p: SqPlayer): string {
    const k = this.bySq.get(p.id);
    return (k && this.byKey.get(k)?.nickname) || nameOf(p);
  }
}

/** Pairs a site player (scKey) with an API player; a placeholder row made for the API player is merged into it. */
function linkStatements(db: D1Database, pairing: Pairing, scKey: string, sqId: string): D1PreparedStatement[] {
  const old = pairing.bySq.get(sqId);
  const out = [db.prepare('UPDATE queue_players SET sq_id = ? WHERE key = ?').bind(sqId, scKey)];
  if (old && old !== scKey) {
    out.unshift(
      db.prepare(`UPDATE queue_players SET elo = (SELECT elo FROM queue_players WHERE key = ?1),
                    last_played = (SELECT last_played FROM queue_players WHERE key = ?1) WHERE key = ?2`).bind(old, scKey),
      db.prepare(`UPDATE queue_scout SET player_key = ?2 WHERE player_key = ?1
                    AND NOT EXISTS (SELECT 1 FROM queue_scout WHERE player_key = ?2)`).bind(old, scKey),
      db.prepare('UPDATE players SET queue_key = ?2 WHERE queue_key = ?1').bind(old, scKey),
      db.prepare('DELETE FROM queue_players WHERE key = ?').bind(old),
    );
    pairing.byKey.delete(old);
  }
  pairing.bySq.set(sqId, scKey);
  const row = pairing.byKey.get(scKey);
  if (row) row.sq_id = sqId;
  return out;
}

async function runChunks(db: D1Database, stmts: D1PreparedStatement[], size = 100): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

const fold = (s: unknown) => lower(s).normalize('NFD').replace(/[^a-z0-9]/g, '');
function similar(a: string, b: string): boolean {
  const x = fold(a), y = fold(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return d[x.length][y.length] <= 2;
}

/**
 * Site players (from the streamersclash.cz board) that have no API player yet are paired by their
 * record: both sources count the same games, so "45 W 27 L" on both sides is the same person
 * ("Coach Robko" = "Robko"). Several with the same record → only a similar name decides.
 */
function pairByRecord(
  pairing: Pairing, list: SqPlayer[], site: Map<string, { wins: number; losses: number }>,
): Map<string, string> {
  const out = new Map<string, string>(); // sq id → site key
  const siteFree = new Map<string, string[]>();
  for (const [k, r] of site) {
    if (pairing.byKey.get(k)?.sq_id) continue;
    const rec = `${r.wins}-${r.losses}`;
    siteFree.set(rec, [...(siteFree.get(rec) ?? []), k]);
  }
  const apiFree = new Map<string, SqPlayer[]>();
  for (const p of list) {
    const k = pairing.bySq.get(p.id);
    if (k && site.has(k)) continue; // already paired with a site player
    if (!k && pairing.find(p)) continue; // pairs by ID/name anyway
    const rec = `${p.wins ?? 0}-${p.losses ?? 0}`;
    apiFree.set(rec, [...(apiFree.get(rec) ?? []), p]);
  }
  for (const [rec, ps] of apiFree) {
    const ks = siteFree.get(rec) ?? [];
    if (!ks.length || rec === '0-0') continue;
    if (ks.length === 1 && ps.length === 1) { out.set(ps[0].id, ks[0]); continue; }
    for (const p of ps) {
      const hits = ks.filter((k) => similar(pairing.byKey.get(k)?.nickname ?? k, nameOf(p)) || similar(k, p.username ?? ''));
      if (hits.length === 1 && ![...out.values()].includes(hits[0])) out.set(p.id, hits[0]);
    }
  }
  return out;
}

/**
 * ELO, W/L and pairing of all API players; players only in the API get their own row.
 * `site`: the streamersclash.cz board of this sync (key → record), for pairing by record.
 */
export async function syncSqPlayers(
  env: Env, site: Map<string, { wins: number; losses: number }> = new Map(),
): Promise<{ players: number; paired: number; created: number; byRecord: number }> {
  const db = env.DB;
  const list = (await sqJson<SqPlayer[]>(env, '/api/players')) ?? [];
  const pairing = await Pairing.load(db);
  const stmts: D1PreparedStatement[] = [];
  let paired = 0, created = 0;
  const byRecord = pairByRecord(pairing, list, site);
  for (const [sqId, key] of byRecord) stmts.push(...linkStatements(db, pairing, key, sqId));
  for (const p of list) {
    if (!p?.id) continue;
    const stats = [p.elo ?? null, p.wins ?? 0, p.losses ?? 0, p.totalGames ?? (p.wins ?? 0) + (p.losses ?? 0), p.lastPlayedAt ?? null] as const;
    const key = pairing.find(p);
    if (key) {
      if (!pairing.bySq.has(p.id)) stmts.push(...linkStatements(db, pairing, key, p.id));
      stmts.push(db.prepare(
        `UPDATE queue_players SET elo = ?, wins = ?, losses = ?, games = ?, last_played = ?, avatar = COALESCE(avatar, ?), updated_at = datetime('now')
          WHERE key = ?`,
      ).bind(...stats, p.avatar ?? null, key));
      paired++;
    } else {
      let k = lower(nameOf(p));
      if (pairing.byKey.has(k)) k = `${k}#${p.id.slice(-4)}`;
      stmts.push(db.prepare(
        `INSERT INTO queue_players (key, nickname, avatar, sq_id, elo, wins, losses, games, last_played, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET sq_id = excluded.sq_id, elo = excluded.elo, wins = excluded.wins, losses = excluded.losses,
           games = excluded.games, last_played = excluded.last_played, updated_at = excluded.updated_at`,
      ).bind(k, nameOf(p), p.avatar ?? null, p.id, ...stats));
      pairing.byKey.set(k, { key: k, nickname: nameOf(p), avatar: p.avatar ?? null, sq_id: p.id });
      pairing.bySq.set(p.id, k);
      created++;
    }
  }
  // place by wins, like the official board (same wins = same place)
  stmts.push(db.prepare('UPDATE queue_players SET rank = 1 + (SELECT COUNT(*) FROM queue_players q WHERE q.wins > queue_players.wins)'));
  await runChunks(db, stmts);
  return { players: list.length, paired, created, byRecord: byRecord.size };
}

/**
 * Stores finished games. A game already stored from streamersclash.cz (same number) is replaced;
 * before that its players are used to pair the remaining site/API players team by team.
 */
export async function storeSqGames(env: Env, games: SqGame[]): Promise<{ stored: number; paired: number }> {
  const db = env.DB;
  const done = games.filter((g) => g.state === 'ENDED' && g.winner && Number.isFinite(g.gameNumber));
  if (!done.length) return { stored: 0, paired: 0 };
  const pairing = await Pairing.load(db);
  const stmts: D1PreparedStatement[] = [];
  let paired = 0;

  // pairing from games known from both sources
  const nums = done.map((g) => g.gameNumber);
  const siteRows: { number: number; uid: string; blue: string; red: string }[] = [];
  for (let i = 0; i < nums.length; i += 90) {
    const chunk = nums.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT number, uid, blue, red FROM queue_matches WHERE number IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ number: number; uid: string; blue: string; red: string }>();
    siteRows.push(...results);
  }
  const byNum = new Map(done.map((g) => [g.gameNumber, g]));
  for (const row of siteRows) {
    const g = byNum.get(row.number);
    if (!g || row.uid === g.id) continue;
    for (const side of ['blue', 'red'] as const) {
      let site: { nickname?: string }[] = [];
      try { site = JSON.parse(side === 'blue' ? row.blue : row.red); } catch { continue; }
      const siteKeys = new Set(site.map((p) => lower(p.nickname)).filter((k) => pairing.byKey.has(k)));
      const unpairedApi: SqPlayer[] = [];
      for (const p of g[side]) {
        const k = pairing.bySq.get(p.id);
        if (k && siteKeys.has(k)) siteKeys.delete(k);
        else unpairedApi.push(p);
      }
      const unpairedSite = [...siteKeys].filter((k) => !pairing.byKey.get(k)?.sq_id);
      if (unpairedSite.length === 1 && unpairedApi.length === 1) {
        stmts.push(...linkStatements(db, pairing, unpairedSite[0], unpairedApi[0].id));
        paired++;
      }
    }
  }

  // replace site copies (other uid, same number), then upsert the API games (9 params per row, ≤ 100 per statement)
  for (let i = 0; i < done.length; i += 50) {
    const chunk = done.slice(i, i + 50);
    stmts.push(db.prepare(
      `DELETE FROM queue_matches WHERE number IN (${chunk.map(() => '?').join(',')}) AND uid NOT IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk.map((g) => g.gameNumber), ...chunk.map((g) => g.id)));
  }
  const team = (list: SqPlayer[]) => JSON.stringify(list.map((p) => ({ nickname: pairing.nick(p), sq_id: p.id })));
  for (let i = 0; i < done.length; i += 11) {
    const chunk = done.slice(i, i + 11);
    stmts.push(db.prepare(
      `INSERT INTO queue_matches (uid, number, winner, started_at, day, time_from, time_to, blue, red)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(uid) DO UPDATE SET winner = excluded.winner, time_to = excluded.time_to, blue = excluded.blue, red = excluded.red`,
    ).bind(...chunk.flatMap((g) => {
      const from = pragueParts(g.createdAt), to = pragueParts(g.endedAt);
      return [g.id, g.gameNumber, lower(g.winner), g.createdAt ?? null, from.day, from.time, to.time, team(g.blue), team(g.red)];
    })));
  }
  await runChunks(db, stmts);
  return { stored: done.length, paired };
}

async function meta(db: D1Database, k: string): Promise<string | null> {
  return (await db.prepare('SELECT v FROM queue_meta WHERE k = ?').bind(k).first<{ v: string }>())?.v ?? null;
}
function setMeta(db: D1Database, k: string, v: string): D1PreparedStatement {
  return db.prepare('INSERT INTO queue_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v);
}

/**
 * Keeps the history current with few requests: the active games, then individually the games that
 * were active last time (or are above the newest stored one) and aren't active any more.
 */
export async function syncSqGames(env: Env): Promise<{ active: number; checked: number; stored: number }> {
  const db = env.DB;
  const active = ((await sqJson<Record<string, unknown>[]>(env, '/api/games?state=ACTIVE')) ?? []).map(flattenGame);
  const activeNums = new Set(active.map((g) => g.gameNumber));
  const prev: number[] = JSON.parse((await meta(db, 'sq_pending')) ?? '[]');
  const cancelled = new Set<number>(JSON.parse((await meta(db, 'sq_cancelled')) ?? '[]'));
  const maxStored = (await db.prepare('SELECT MAX(number) AS n FROM queue_matches').first<{ n: number | null }>())?.n ?? 0;
  const maxActive = Math.max(0, ...activeNums);

  const candidates = new Set<number>(prev.filter((n) => !activeNums.has(n)));
  for (let n = maxStored + 1; n < maxActive; n++) if (!activeNums.has(n)) candidates.add(n);
  const todo = [...candidates].filter((n) => !cancelled.has(n)).sort((a, b) => a - b);

  const finished: SqGame[] = [];
  const stillOpen: number[] = [];
  for (const n of todo.slice(0, ENDED_PER_RUN)) {
    const raw = await sqJson<Record<string, unknown>>(env, `/api/games/${n}`);
    if (!raw) continue;
    const g = flattenGame(raw);
    if (g.state === 'ENDED' && g.winner) finished.push(g);
    else if (g.state === 'CANCELLED') cancelled.add(n);
    else stillOpen.push(n);
  }
  const { stored } = await storeSqGames(env, finished);
  const pending = [...new Set([...activeNums, ...stillOpen, ...todo.slice(ENDED_PER_RUN)])].sort((a, b) => a - b);
  await db.batch([
    setMeta(db, 'sq_pending', JSON.stringify(pending.slice(-200))),
    setMeta(db, 'sq_cancelled', JSON.stringify([...cancelled].sort((a, b) => a - b).slice(-300))),
  ]);
  return { active: active.length, checked: Math.min(todo.length, ENDED_PER_RUN), stored };
}
