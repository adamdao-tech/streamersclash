import type { Env } from './index';
import { logActivity, type User } from './db';
import { HttpError, json } from './http';
import { parseStart } from './schedule';

// Streamers Queue scouting (admin only).
// Data come from the public Streamers Clash endpoints the queue page itself uses:
//   board – leaderboard with every player's total W/L, tier
//   lobby – live/waiting lobbies + the ~36 most recently ended ones (with winner)
// The API only keeps the last ~36 ended lobbies, so ended ones are stored in D1 on every
// sync (cron every 10 min) and the match history grows over time.

const SC = 'https://streamersclash.cz/api/streamers-queue';
const UA = 'sgoob-scouting (sc.daotech.dev)';
export const QUEUE_ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'] as const;
const LIVE_CACHE_SECONDS = 30;

interface ScPlayer { nickname: string; avatar?: string | null; href?: string | null; linked?: boolean }
interface ScLobby {
  id: string; number: number; state: string; winner: 'blue' | 'red' | null;
  day?: string; from?: string; to?: string | null; blue: ScPlayer[]; red: ScPlayer[];
  opgg?: Record<string, { server: string; url: string; players: number }[]>;
}
interface ScBoardEntry {
  rank: number; nickname: string; wins: number; losses: number; games: number;
  avatar?: string | null; href?: string | null; qualified?: boolean; tier?: string | null;
}

const key = (nick: string) => nick.trim().toLowerCase();
const abs = (u?: string | null) => (!u ? null : /^https?:/.test(u) ? u : u.startsWith('/') ? `https://streamersclash.cz${u}` : u);
const slim = (p: ScPlayer) => ({ nickname: p.nickname, avatar: abs(p.avatar), href: abs(p.href) });

export const OPGG_REGIONS = ['eune', 'euw'] as const;
type Region = (typeof OPGG_REGIONS)[number];

/** "https://op.gg/lol/multisearch/euw?summoners=A%23EUW%2CB%23TAG" → { region: 'euw', ids: ['A#EUW', 'B#TAG'] } */
function parseMultisearch(url: string): { region: Region; ids: string[] } | null {
  try {
    const u = new URL(url);
    const region = (u.pathname.match(/multisearch\/([a-z]+)/i)?.[1] || '').toLowerCase().replace(/^eun$/, 'eune');
    if (!(OPGG_REGIONS as readonly string[]).includes(region)) return null;
    const ids = (u.searchParams.get('summoners') || '').split(',').map((x) => x.trim()).filter((x) => x.includes('#'));
    return ids.length ? { region: region as Region, ids } : null;
  } catch {
    return null;
  }
}

/**
 * Remembers which Riot IDs were listed for each player's team in a live lobby. A player's own account
 * is the one that keeps showing up in all their lobbies – that's what the suggestions are built from.
 */
async function recordOpgg(db: D1Database, lobbies: ScLobby[]): Promise<void> {
  const ins = db.prepare('INSERT OR IGNORE INTO queue_opgg_seen (player_key, lobby_uid, region, candidates) VALUES (?, ?, ?, ?)');
  const stmts: D1PreparedStatement[] = [];
  for (const l of lobbies) {
    if (!l.opgg) continue;
    for (const side of ['blue', 'red'] as const) {
      for (const entry of l.opgg[side] ?? []) {
        const parsed = parseMultisearch(entry.url);
        if (!parsed) continue;
        for (const p of l[side] ?? []) stmts.push(ins.bind(key(p.nickname), l.id, parsed.region, JSON.stringify(parsed.ids)));
      }
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Riot game name looks like the queue nickname ("Skodix" ~ "SköDiXx#EUNE"). */
function nameLike(nick: string, riotId: string): boolean {
  const a = fold(nick), b = fold(riotId.split('#')[0]);
  if (a.length < 3 || b.length < 3) return a === b && a.length > 0;
  return a.includes(b) || b.includes(a) || editDistance(a, b) <= 2;
}

interface Suggestion { riot: string; seen: number; of: number; name_match: boolean; source: 'lobby' | 'team' }

/** Riot ID suggestions per player and region. */
async function opggSuggestions(db: D1Database): Promise<Record<string, Partial<Record<Region, Suggestion[]>>>> {
  const out: Record<string, Partial<Record<Region, Suggestion[]>>> = {};
  const [seen, players, own] = await Promise.all([
    db.prepare('SELECT player_key, region, candidates FROM queue_opgg_seen').all<{ player_key: string; region: Region; candidates: string }>(),
    db.prepare('SELECT key, nickname FROM queue_players').all<{ key: string; nickname: string }>(),
    // players already in the app's teams with a Riot ID filled in
    db.prepare(`SELECT nickname, riot_game_name, riot_tag_line, region FROM players WHERE riot_game_name IS NOT NULL AND riot_tag_line IS NOT NULL`)
      .all<{ nickname: string; riot_game_name: string; riot_tag_line: string; region: string }>(),
  ]);
  const nickOf = new Map(players.results.map((p) => [p.key, p.nickname]));
  const groups = new Map<string, string[][]>();
  for (const row of seen.results) {
    const g = `${row.player_key}|${row.region}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(JSON.parse(row.candidates));
  }
  for (const [g, lists] of groups) {
    const [pk, region] = g.split('|') as [string, Region];
    const nick = nickOf.get(pk) ?? pk;
    const counts = new Map<string, number>();
    for (const list of lists) for (const id of new Set(list)) counts.set(id, (counts.get(id) || 0) + 1);
    const ranked = [...counts.entries()]
      .map(([riot, n]) => ({ riot, seen: n, of: lists.length, name_match: nameLike(nick, riot), source: 'lobby' as const }))
      // a real candidate: in every lobby the player was seen in (2+), or the name matches
      .filter((x) => x.name_match || (x.of >= 2 && x.seen === x.of))
      .sort((a, b) => Number(b.name_match) - Number(a.name_match) || b.seen - a.seen)
      .slice(0, 3);
    if (ranked.length) (out[pk] ??= {})[region] = ranked;
  }
  for (const p of own.results) {
    const pk = key(p.nickname);
    const region = p.region.toLowerCase() as Region;
    const riot = `${p.riot_game_name}#${p.riot_tag_line}`;
    const list = ((out[pk] ??= {})[region] ??= []);
    if (!list.some((x) => x.riot.toLowerCase() === riot.toLowerCase())) list.unshift({ riot, seen: 0, of: 0, name_match: true, source: 'team' });
  }
  return out;
}

async function getSc<T>(path: string): Promise<T> {
  const res = await fetch(`${SC}/${path}`, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`Streamers Clash ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** "27. 10." + "22:00" (Prague time) → UTC ISO. The year comes from today (a December game seen in January is last year). */
function startedAt(day?: string, from?: string): string | null {
  const m = String(day ?? '').match(/(\d{1,2})\.\s*(\d{1,2})\./);
  if (!m) return null;
  const now = new Date();
  let year = now.getUTCFullYear();
  if (+m[2] > now.getUTCMonth() + 2) year--;
  try {
    return parseStart(`${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${from && /^\d{1,2}:\d{2}$/.test(from) ? from : '00:00'}`);
  } catch {
    return null;
  }
}

/** Pulls the leaderboard and newly ended lobbies into D1. */
export async function syncQueue(env: Env): Promise<{ players: number; added: number; stored: number }> {
  const db = env.DB;
  const [board, lobby] = await Promise.all([
    getSc<{ entries: ScBoardEntry[] }>('board'),
    getSc<{ live?: ScLobby[]; recent?: ScLobby[] }>('lobby'),
  ]);

  const upsertPlayer = db.prepare(
    `INSERT INTO queue_players (key, nickname, avatar, profile, rank, wins, losses, games, tier, qualified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar, profile = excluded.profile,
       rank = excluded.rank, wins = excluded.wins, losses = excluded.losses, games = excluded.games,
       tier = excluded.tier, qualified = excluded.qualified, updated_at = excluded.updated_at`,
  );
  const stmts = (board.entries ?? [])
    .filter((e) => e.nickname)
    .map((e) =>
      upsertPlayer.bind(key(e.nickname), e.nickname, abs(e.avatar), abs(e.href), e.rank ?? null,
        e.wins | 0, e.losses | 0, e.games | 0, e.tier ?? null, e.qualified ? 1 : 0),
    );
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));

  await recordOpgg(db, (lobby.live ?? []) as ScLobby[]).catch((e) => console.error('opgg record', e));

  const insertMatch = db.prepare(
    `INSERT OR IGNORE INTO queue_matches (uid, number, winner, started_at, day, time_from, time_to, blue, red)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ended = [...(lobby.recent ?? []), ...(lobby.live ?? [])].filter((l) => l.state === 'ended' && l.winner);
  let added = 0;
  if (ended.length) {
    const res = await db.batch(ended.map((l) =>
      insertMatch.bind(l.id, l.number ?? null, l.winner, startedAt(l.day, l.from), l.day ?? null, l.from ?? null,
        l.to ?? null, JSON.stringify(l.blue.map(slim)), JSON.stringify(l.red.map(slim))),
    ));
    added = res.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }
  await db.prepare(`INSERT INTO queue_meta (k, v) VALUES ('synced_at', datetime('now'))
                    ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run();
  const stored = await db.prepare('SELECT COUNT(*) AS n FROM queue_matches').first<{ n: number }>();
  return { players: stmts.length, added, stored: stored?.n ?? 0 };
}

/** Live and waiting lobbies, straight from Streamers Clash (cached for a few seconds). */
async function liveLobbies(db: D1Database): Promise<unknown[]> {
  const cache = caches.default;
  const cacheKey = new Request('https://sc-scouting.internal/queue-live');
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const lobby = await getSc<{ live?: ScLobby[] }>('lobby');
  await recordOpgg(db, lobby.live ?? []).catch((e) => console.error('opgg record', e));
  const live = (lobby.live ?? []).filter((l) => l.state !== 'ended').map((l) => ({
    uid: l.id, number: l.number, state: l.state, day: l.day ?? null, time_from: l.from ?? null,
    blue: l.blue.map(slim), red: l.red.map(slim), opgg: l.opgg ?? null,
  }));
  await cache.put(cacheKey, new Response(JSON.stringify(live), { headers: { 'Cache-Control': `max-age=${LIVE_CACHE_SECONDS}` } }));
  return live;
}

/** "Name#TAG" (or an op.gg link) → "Name#TAG"; empty → null. */
function riotId(v: unknown, label: string): string | null {
  let t = String(v ?? '').trim();
  if (!t) return null;
  const link = t.match(/op\.gg\/(?:lol\/)?summoners\/[a-z]+\/([^/?#]+)/i);
  if (link) {
    const raw = decodeURIComponent(link[1]);
    const i = raw.lastIndexOf('-');
    t = i > 0 ? `${raw.slice(0, i)}#${raw.slice(i + 1)}` : raw;
  }
  const m = t.match(/^(.{2,32}?)\s*#\s*([^#\s]{2,8})$/u);
  if (!m) throw new HttpError(400, 'invalid', `${label}: zadej Riot ID ve tvaru Jméno#TAG (nebo vlož odkaz na op.gg).`);
  return `${m[1].trim()}#${m[2]}`;
}

/** Only the fields present in the body are changed (toggling a role keeps the note, Riot IDs…). */
function mergeScout(prev: Record<string, unknown> | null, body: Record<string, unknown>) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  let fav = prev ? (JSON.parse(String(prev.fav_roles || '[]')) as string[]) : [];
  if (has('fav_roles')) fav = Array.isArray(body.fav_roles) ? body.fav_roles.map(String).filter((r) => (QUEUE_ROLES as readonly string[]).includes(r)) : [];
  let price = (prev?.price as number | null) ?? null;
  if (has('price')) {
    if (body.price === null || String(body.price).trim() === '') price = null;
    else {
      price = Number(String(body.price).replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'invalid', 'Cena musí být kladné číslo.');
    }
  }
  const note = has('note') ? (body.note == null ? null : String(body.note).slice(0, 4000).trim() || null) : ((prev?.note as string) ?? null);
  const riot_eune = has('riot_eune') ? riotId(body.riot_eune, 'EUNE') : ((prev?.riot_eune as string) ?? null);
  const riot_euw = has('riot_euw') ? riotId(body.riot_euw, 'EUW') : ((prev?.riot_euw as string) ?? null);
  return { fav_roles: JSON.stringify([...new Set(fav)]), price, note, riot_eune, riot_euw };
}

/** Routes under /api/queue. Returns null when the path isn't ours. */
export async function handleQueueApi(
  req: Request, env: Env, path: string, method: string, user: User, readBody: (r: Request) => Promise<Record<string, unknown>>,
): Promise<Response | null> {
  if (!path.startsWith('/api/queue')) return null;
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Scouting queue je jen pro adminy.');
  const db = env.DB;
  let m: RegExpMatchArray | null;

  if (path === '/api/queue' && method === 'GET') {
    const [players, matches, scout, meta, suggestions] = await Promise.all([
      db.prepare('SELECT * FROM queue_players ORDER BY rank IS NULL, rank, nickname COLLATE NOCASE').all(),
      db.prepare('SELECT * FROM queue_matches ORDER BY number DESC').all(),
      db.prepare(`SELECT s.*, u.display_name AS updated_by_name FROM queue_scout s LEFT JOIN users u ON u.id = s.updated_by`).all(),
      db.prepare(`SELECT v FROM queue_meta WHERE k = 'synced_at'`).first<{ v: string }>(),
      opggSuggestions(db),
    ]);
    return json({
      suggestions,
      players: players.results,
      matches: matches.results.map((r: Record<string, unknown>) => ({ ...r, blue: JSON.parse(String(r.blue)), red: JSON.parse(String(r.red)) })),
      scout: scout.results.map((r: Record<string, unknown>) => ({ ...r, fav_roles: JSON.parse(String(r.fav_roles || '[]')) })),
      synced_at: meta?.v ?? null,
    });
  }

  // Lightweight poll for the page's auto-refresh: admins' edits + whether a new sync happened.
  if (path === '/api/queue/updates' && method === 'GET') {
    const [scout, meta, count] = await Promise.all([
      db.prepare(`SELECT s.*, u.display_name AS updated_by_name FROM queue_scout s LEFT JOIN users u ON u.id = s.updated_by`).all(),
      db.prepare(`SELECT v FROM queue_meta WHERE k = 'synced_at'`).first<{ v: string }>(),
      db.prepare('SELECT COUNT(*) AS n FROM queue_matches').first<{ n: number }>(),
    ]);
    return json({
      scout: scout.results.map((r: Record<string, unknown>) => ({ ...r, fav_roles: JSON.parse(String(r.fav_roles || '[]')) })),
      synced_at: meta?.v ?? null,
      matches: count?.n ?? 0,
    });
  }

  if (path === '/api/queue/live' && method === 'GET') {
    try {
      return json({ live: await liveLobbies(db) });
    } catch (err) {
      return json({ live: [], error: String((err as Error).message) });
    }
  }

  if (path === '/api/queue/sync' && method === 'POST') {
    try {
      const result = await syncQueue(env);
      await logActivity(db, { kind: 'user', userId: user.id }, 'queue.sync', null, null, result);
      return json(result);
    } catch (err) {
      throw new HttpError(502, 'upstream', `Streamers Clash API nedostupné: ${(err as Error).message}`);
    }
  }

  if ((m = path.match(/^\/api\/queue\/scout\/(.+)$/)) && method === 'PUT') {
    const playerKey = key(decodeURIComponent(m[1]));
    if (!playerKey) throw new HttpError(400, 'invalid', 'Chybí hráč.');
    const prev = await db.prepare('SELECT * FROM queue_scout WHERE player_key = ?').bind(playerKey).first<Record<string, unknown>>();
    const s = mergeScout(prev, await readBody(req));
    await db
      .prepare(
        `INSERT INTO queue_scout (player_key, fav_roles, price, note, riot_eune, riot_euw, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(player_key) DO UPDATE SET fav_roles = excluded.fav_roles, price = excluded.price,
           note = excluded.note, riot_eune = excluded.riot_eune, riot_euw = excluded.riot_euw,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(playerKey, s.fav_roles, s.price, s.note, s.riot_eune, s.riot_euw, user.id)
      .run();
    await logActivity(db, { kind: 'user', userId: user.id }, 'queue.scout', 'queue_player', null, { player: playerKey, ...s });
    return json({ ok: true, scout: { ...s, fav_roles: JSON.parse(s.fav_roles) } });
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}
