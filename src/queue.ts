import type { Env } from './index';
import { isSuperadmin, logActivity, type User } from './db';
import { cacheGet, cacheSet, getStreams } from './twitch';
import { relinkDraftPlayers } from './drafts';
import { flattenGame, SqError, sqEnabled, sqFetch, rankStatement, storeSqGames, syncSqGames, syncSqPlayers, type SqGame } from './sq';
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

// --- accounts from the player's Streamers Clash profile -----------------------
// The profile page lists the player's linked LoL accounts ("Účty": Riot ID, region, rank – each an op.gg
// link) and sometimes a preferred role. Profiles are read a few at a time from the cron so the
// organizer's site isn't hammered: PROFILE_BATCH per run, each refreshed once a day.

const PROFILE_BATCH = 15; // keeps the cron under the free plan's 50 subrequests (VODs + queue + API)
const PROFILE_CONCURRENCY = 2;

export interface Account { region: string; riot: string; rank: string | null; url: string }

const RANK_TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
const RANK_DIV: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };
/** "Diamond I · 75 LP" → comparable number (Unranked/unknown = -1). */
export function rankValue(rank: string | null | undefined): number {
  const m = String(rank ?? '').match(/^([A-Za-z]+)\s*(IV|III|II|I)?\D*?(\d+)?\s*LP/i) || String(rank ?? '').match(/^([A-Za-z]+)\s*(IV|III|II|I)?/i);
  const t = m ? RANK_TIERS.indexOf(m[1].toLowerCase()) : -1;
  if (t < 0) return -1;
  const lp = Number(m?.[3] ?? 0);
  return m?.[2] ? t * 10000 + RANK_DIV[m[2].toUpperCase()] * 1000 + Math.min(lp, 999) : t * 10000 + Math.min(lp, 9999);
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const ROLE_ALIASES: Record<string, string> = {
  TOP: 'TOP', JUNGLE: 'JUNGLE', JNG: 'JUNGLE', JG: 'JUNGLE', MID: 'MID', MIDDLE: 'MID',
  ADC: 'ADC', BOT: 'ADC', BOTTOM: 'ADC', SUPPORT: 'SUPPORT', SUP: 'SUPPORT', SUPP: 'SUPPORT',
};

/** Reads accounts and preferred role from a profile page's HTML. */
export function parseProfile(html: string): { accounts: Account[]; preferred_role: string | null } {
  const accounts: Account[] = [];
  const re = /<a\b[^>]*\bhref="(https?:\/\/(?:www\.)?op\.gg\/(?:lol\/)?summoners\/([a-z]+)\/([^"?#]+))"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const url = decodeEntities(m[1]);
    const region = m[2].toLowerCase() === 'eun' ? 'eune' : m[2].toLowerCase();
    let slug: string;
    try { slug = decodeURIComponent(decodeEntities(m[3])); } catch { continue; }
    const i = slug.lastIndexOf('-');
    if (i <= 0) continue;
    const riot = `${slug.slice(0, i)}#${slug.slice(i + 1)}`;
    const text = stripTags(m[4]);
    // Only the account cards: their text starts with the Riot ID (a link pasted in a comment doesn't).
    if (!text.replace(/\s/g, '').toLowerCase().startsWith(riot.replace(/\s/g, '').toLowerCase())) continue;
    // "ESB Esko#LUKÁŠ EUW Master · 1245 LP" → "Master · 1245 LP"
    const tag = `#${slug.slice(i + 1)}`.toLowerCase();
    const at = text.toLowerCase().indexOf(tag);
    const rest = at >= 0 ? text.slice(at + tag.length).trim() : '';
    const rank: string | null = rest.replace(/^(eune|euw|eun|na|kr)\b/i, '').trim() || null;
    if (!accounts.some((a) => a.region === region && a.riot.toLowerCase() === riot.toLowerCase())) accounts.push({ region, riot, rank, url });
  }
  const text = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, ' '));
  const pref = text.match(/Preferovan[áa] pozice:?\s*([A-Za-z]+)/i)?.[1]?.toUpperCase();
  return { accounts, preferred_role: pref ? ROLE_ALIASES[pref] ?? null : null };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ProfileResult =
  | { ok: true; accounts: Account[]; preferred_role: string | null }
  | { ok: false; error: string; throttled: boolean };

export async function fetchProfile(profileUrl: string, attempt = 1): Promise<ProfileResult> {
  let res: Response;
  try {
    res = await fetch(profileUrl, { headers: { accept: 'text/html', 'user-agent': UA }, redirect: 'follow' });
  } catch (err) {
    return { ok: false, error: `síť: ${(err as Error).message}`, throttled: false };
  }
  if (res.status === 404) return { ok: true, accounts: [], preferred_role: null };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, throttled: res.status === 429 || res.status === 403 || res.status === 503 };
  const html = await res.text();
  const parsed = parseProfile(html);
  if (parsed.accounts.length) return { ok: true, ...parsed };

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  if (/nenalezena/i.test(title)) return { ok: true, accounts: [], preferred_role: null };
  // The "Účty" section (or op.gg links) is there but no account was read: under load their site sometimes
  // renders the profile with the accounts still missing. Try once more, then leave it for the next run.
  if (/ÚČTY|>\s*Účty\s*</.test(html) || /op\.gg\/(?:lol\/)?summoners\//i.test(html)) {
    if (attempt < 2) {
      await pause(1500);
      return fetchProfile(profileUrl, attempt + 1);
    }
    return { ok: false, error: 'účty se na profilu nenačetly', throttled: false };
  }
  // A profile page with no "Účty" section: usually the player has no linked accounts, but their site
  // sometimes leaves the section out under load – so look once more (and saveProfile rechecks soon).
  if (/·\s*Streamers Clash/i.test(title)) {
    if (attempt < 2) {
      await pause(1500);
      return fetchProfile(profileUrl, attempt + 1);
    }
    return { ok: true, ...parsed };
  }
  return { ok: false, error: 'místo profilu přišla jiná stránka', throttled: true };
}

async function saveProfile(db: D1Database, playerKey: string, data: ProfileResult): Promise<void> {
  if (!data.ok) {
    // try again in about an hour; keep whatever accounts were read before
    await db
      .prepare(`UPDATE queue_players SET profile_checked_at = datetime('now', '-23 hours'), profile_error = ? WHERE key = ?`)
      .bind(data.error, playerKey)
      .run();
    return;
  }
  // No accounts found: check again in ~2 h instead of tomorrow (their page sometimes omits them).
  await db
    .prepare(
      `UPDATE queue_players SET accounts = ?, preferred_role = COALESCE(?, preferred_role),
         profile_checked_at = CASE WHEN ? THEN datetime('now') ELSE datetime('now', '-22 hours') END, profile_error = NULL
       WHERE key = ?`,
    )
    .bind(JSON.stringify(data.accounts), data.preferred_role, data.accounts.length ? 1 : 0, playerKey)
    .run();
}


/**
 * Reads the next batch of profiles (never read, failed earlier, or older than a day). Gentle on their site:
 * two at a time with a short pause, and the batch stops as soon as the site starts throttling.
 */
export async function syncProfiles(env: Env, limit = PROFILE_BATCH): Promise<{
  checked: number; with_accounts: number; failed: number; throttled: boolean; remaining: number; errors: number; total: number;
}> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT key, profile FROM queue_players
        WHERE profile IS NOT NULL
          AND (profile_checked_at IS NULL OR profile_checked_at < datetime('now', '-1 day')
               OR (profile_error IS NOT NULL AND profile_checked_at < datetime('now', '-22 hours', '-50 minutes')))
        ORDER BY profile_checked_at IS NOT NULL, profile_error IS NULL DESC, profile_checked_at, rank LIMIT ?`,
    )
    .bind(limit)
    .all<{ key: string; profile: string }>();
  let withAccounts = 0, failed = 0, checked = 0, throttled = false;
  for (let i = 0; i < results.length && !throttled; i += PROFILE_CONCURRENCY) {
    if (i) await pause(300);
    await Promise.all(results.slice(i, i + PROFILE_CONCURRENCY).map(async (p) => {
      const data = await fetchProfile(p.profile);
      checked++;
      if (data.ok) { if (data.accounts.length) withAccounts++; }
      else { failed++; if (data.throttled) throttled = true; }
      await saveProfile(db, p.key, data);
    }));
  }
  const left = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN profile_checked_at IS NULL OR profile_checked_at < datetime('now', '-1 day') OR profile_error IS NOT NULL THEN 1 ELSE 0 END) AS remaining,
              SUM(CASE WHEN profile_error IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM queue_players WHERE profile IS NOT NULL`,
    )
    .first<{ total: number; remaining: number | null; errors: number | null }>();
  return {
    checked, with_accounts: withAccounts, failed, throttled,
    remaining: left?.remaining ?? 0, errors: left?.errors ?? 0, total: left?.total ?? 0,
  };
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
       wins = CASE WHEN sq_id IS NULL THEN excluded.wins ELSE wins END,
       losses = CASE WHEN sq_id IS NULL THEN excluded.losses ELSE losses END,
       games = CASE WHEN sq_id IS NULL THEN excluded.games ELSE games END,
       tier = excluded.tier, qualified = excluded.qualified, updated_at = excluded.updated_at
     -- only a real change is written (D1 free plan: 100k written rows a day); W/L of API-paired players come from the API
     WHERE nickname IS NOT excluded.nickname OR avatar IS NOT excluded.avatar OR profile IS NOT excluded.profile
       OR tier IS NOT excluded.tier OR qualified IS NOT excluded.qualified
       OR (sq_id IS NULL AND (wins IS NOT excluded.wins OR losses IS NOT excluded.losses OR games IS NOT excluded.games))`,
  );
  const stmts = (board.entries ?? [])
    .filter((e) => e.nickname)
    .map((e) =>
      upsertPlayer.bind(key(e.nickname), e.nickname, abs(e.avatar), abs(e.href), e.rank ?? null,
        e.wins | 0, e.losses | 0, e.games | 0, e.tier ?? null, e.qualified ? 1 : 0),
    );
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));

  await recordOpgg(db, (lobby.live ?? []) as ScLobby[]).catch((e) => console.error('opgg record', e));

  // a game already stored from the Streamers Queue API (same number, other uid) isn't added again
  const insertMatch = db.prepare(
    `INSERT OR IGNORE INTO queue_matches (uid, number, winner, started_at, day, time_from, time_to, blue, red)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE NOT EXISTS (SELECT 1 FROM queue_matches WHERE number = ?2)`,
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
  // Streamers Queue API: ELO + pairing, newly finished games (a failure there keeps the site data above)
  let sq: Record<string, unknown> | null = null;
  if (sqEnabled(env)) {
    try {
      const site = new Map((board.entries ?? []).filter((e) => e.nickname).map((e) => [key(e.nickname), { wins: e.wins | 0, losses: e.losses | 0 }]));
      const pl = await syncSqPlayers(env, site);
      const gm = await syncSqGames(env);
      sq = { ...pl, ...gm };
      added += gm.stored;
    } catch (err) {
      sq = { error: (err as Error).message };
      console.error('SQ sync', err);
    }
  }
  if (!sq || 'error' in sq) await rankStatement(db).run();
  const stored = await db.prepare('SELECT COUNT(*) AS n FROM queue_matches').first<{ n: number }>();
  // the page polls these two every 10 s: a meta row instead of COUNT(*) over all matches each time
  await db.batch([
    db.prepare(`INSERT INTO queue_meta (k, v) VALUES ('synced_at', datetime('now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v`),
    db.prepare(`INSERT INTO queue_meta (k, v) VALUES ('match_count', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE v IS NOT excluded.v`)
      .bind(String(stored?.n ?? 0)),
  ]);
  return { players: stmts.length, added, stored: stored?.n ?? 0, ...(sq ? { sq } : {}) } as { players: number; added: number; stored: number };
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

// --- stream guard -----------------------------------------------------------------
// A web page can't tell that OBS/Discord is capturing it, but the app knows each user's Twitch login:
// while they're live on Twitch, the scouting data (notes, prices, favourites) isn't sent to them and the
// page goes black. Superadmins and users with can_stream = 1 are exempt.

export interface StreamGuard { live: boolean; allowed: boolean; hidden: boolean; title: string | null }

export async function streamGuard(env: Env, user: User): Promise<StreamGuard> {
  const allowed = isSuperadmin(env, user) || !!user.can_stream;
  const login = String(user.twitch_login).toLowerCase();
  const cacheKey = `live:user:${login}`;
  let state: { live: boolean; title: string | null } | null = null;
  const cached = await cacheGet(env.DB, cacheKey).catch(() => null);
  if (cached) state = JSON.parse(cached);
  else {
    try {
      const [stream] = await getStreams(env, [login]);
      state = { live: !!stream, title: stream?.title ?? null };
      await cacheSet(env.DB, cacheKey, JSON.stringify(state), 45);
    } catch (err) {
      console.error('stream guard', err);
      state = { live: false, title: null };
    }
  }
  return { live: state!.live, allowed, hidden: state!.live && !allowed, title: state!.title };
}

/** Routes under /api/queue. Returns null when the path isn't ours. */
export async function handleQueueApi(
  req: Request, env: Env, path: string, method: string, user: User, readBody: (r: Request) => Promise<Record<string, unknown>>,
): Promise<Response | null> {
  if (!path.startsWith('/api/queue')) return null;
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Scouting queue je jen pro adminy.');
  const db = env.DB;
  let m: RegExpMatchArray | null;

  const guard = await streamGuard(env, user);

  if (path === '/api/queue/stream' && method === 'GET') return json({ stream: guard });

  if (path === '/api/queue' && method === 'GET') {
    const [players, matches, scout, meta, suggestions, links, teams] = await Promise.all([
      db.prepare('SELECT * FROM queue_players ORDER BY rank IS NULL, rank, nickname COLLATE NOCASE').all(),
      db.prepare('SELECT * FROM queue_matches ORDER BY number DESC').all(),
      db.prepare(`SELECT s.*, u.display_name AS updated_by_name FROM queue_scout s LEFT JOIN users u ON u.id = s.updated_by`).all(),
      db.prepare(`SELECT v FROM queue_meta WHERE k = 'synced_at'`).first<{ v: string }>(),
      opggSuggestions(db),
      db.prepare(
        `SELECT p.id AS player_id, p.nickname, p.role, p.queue_key, t.id AS team_id, t.name AS team_name, t.tag AS team_tag, t.is_own_team
           FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.queue_key IS NOT NULL`,
      ).all(),
      db.prepare('SELECT id, name, tag, is_own_team FROM teams ORDER BY is_own_team DESC, name COLLATE NOCASE').all(),
    ]);
    const rest = JSON.stringify({
      links: links.results,
      teams: teams.results,
      suggestions,
      players: players.results.map((r: Record<string, unknown>) => ({ ...r, accounts: r.accounts ? JSON.parse(String(r.accounts)) : null })),
      // live on Twitch without permission → the admins' notes, prices and favourites stay on the server
      scout: guard.hidden ? [] : scout.results.map((r: Record<string, unknown>) => ({ ...r, fav_roles: JSON.parse(String(r.fav_roles || '[]')) })),
      synced_at: meta?.v ?? null,
      stream: guard,
      sq_enabled: sqEnabled(env),
    });
    // the full history is >1000 games: the stored team JSON goes out as is instead of parse + stringify
    // (keeps the request well inside the free plan's CPU time)
    const q = (v: unknown) => JSON.stringify(v ?? null);
    const m = (matches.results as Record<string, unknown>[]).map((r) =>
      `{"uid":${q(r.uid)},"number":${q(r.number)},"winner":${q(r.winner)},"started_at":${q(r.started_at)},"day":${q(r.day)},` +
      `"time_from":${q(r.time_from)},"time_to":${q(r.time_to)},"blue":${r.blue || '[]'},"red":${r.red || '[]'}}`);
    return new Response(`${rest.slice(0, -1)},"matches":[${m.join(',')}]}`, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // Lightweight poll for the page's auto-refresh: admins' edits + whether a new sync happened.
  if (path === '/api/queue/updates' && method === 'GET') {
    const [scout, meta] = await Promise.all([
      db.prepare(`SELECT s.*, u.display_name AS updated_by_name FROM queue_scout s LEFT JOIN users u ON u.id = s.updated_by`).all(),
      db.prepare(`SELECT k, v FROM queue_meta WHERE k IN ('synced_at', 'match_count')`).all<{ k: string; v: string }>(),
    ]);
    const m = new Map(meta.results.map((r) => [r.k, r.v]));
    if (!m.has('match_count')) {
      const c = await db.prepare('SELECT COUNT(*) AS n FROM queue_matches').first<{ n: number }>();
      m.set('match_count', String(c?.n ?? 0));
      await db.prepare(`INSERT OR IGNORE INTO queue_meta (k, v) VALUES ('match_count', ?)`).bind(m.get('match_count')).run();
    }
    return json({
      scout: guard.hidden ? [] : scout.results.map((r: Record<string, unknown>) => ({ ...r, fav_roles: JSON.parse(String(r.fav_roles || '[]')) })),
      synced_at: m.get('synced_at') ?? null,
      matches: Number(m.get('match_count') ?? 0),
      stream: guard,
    });
  }

  if (path === '/api/queue/live' && method === 'GET') {
    try {
      return json({ live: await liveLobbies(db) });
    } catch (err) {
      return json({ live: [], error: String((err as Error).message) });
    }
  }

  // Full history from the Streamers Queue API, passed through unparsed (~8 MB): the page parses it and
  // sends it back in chunks to /api/queue/import.
  if (path === '/api/queue/sq-history' && method === 'GET') {
    try {
      const res = await sqFetch(env, '/api/games?state=ENDED');
      if (!res.ok) throw new SqError(res.status, `Streamers Queue API vrátilo HTTP ${res.status}`);
      return new Response(res.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (err) {
      throw new HttpError(err instanceof SqError ? (err.status === 429 ? 429 : 502) : 502, 'upstream', (err as Error).message);
    }
  }

  if (path === '/api/queue/import' && method === 'POST') {
    const body = await readBody(req);
    const games = (Array.isArray(body.games) ? body.games : []).slice(0, 200) as Record<string, unknown>[];
    const parsed: SqGame[] = games.map((g) => (g.blue && g.red ? (g as unknown as SqGame) : flattenGame(g)));
    const r = await storeSqGames(env, parsed);
    if (body.last) {
      await logActivity(db, { kind: 'user', userId: user.id }, 'queue.import', null, null, { games: body.total ?? null });
      await db.prepare(`INSERT INTO queue_meta (k, v) VALUES ('synced_at', datetime('now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run();
    }
    return json(r);
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

  // "Načíst účty všem": the page calls this repeatedly, one small batch at a time, until remaining = 0.
  if (path === '/api/queue/profiles' && method === 'POST') {
    const body = await readBody(req);
    const limit = Math.min(Math.max(Number(body.limit) || 15, 1), 20);
    return json(await syncProfiles(env, limit));
  }

  // Link a queue player to a player in the app: an existing one (player_id) or a new one in a team (team_id + role).
  if (path === '/api/queue/link' && method === 'POST') {
    const body = await readBody(req);
    const playerKey = key(String(body.player_key ?? ''));
    const q = await db.prepare('SELECT * FROM queue_players WHERE key = ?').bind(playerKey).first<Record<string, unknown>>();
    if (!q) throw new HttpError(404, 'not_found', 'Hráč v queue není.');
    const actor = { kind: 'user' as const, userId: user.id };

    if (body.unlink) {
      await db.prepare('UPDATE players SET queue_key = NULL WHERE queue_key = ?').bind(playerKey).run();
      await logActivity(db, actor, 'queue.unlink', 'queue_player', null, { player: playerKey });
      return json({ ok: true });
    }

    let playerId = Number(body.player_id) || null;
    if (!playerId) {
      const teamId = Number(body.team_id);
      const team = teamId ? await db.prepare('SELECT id, region FROM teams WHERE id = ?').bind(teamId).first<{ id: number; region: string }>() : null;
      if (!team) throw new HttpError(400, 'invalid', 'Vyber tým.');
      const role = (['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'SUB'] as const).find((r) => r === body.role) ?? null;
      // Riot ID: the highest-ranked account from the player's Streamers Clash profile
      const accounts = (q.accounts ? JSON.parse(String(q.accounts)) : []) as Account[];
      const best = [...accounts].sort((a, b) => rankValue(b.rank) - rankValue(a.rank))[0];
      const [gameName, tagLine] = best ? best.riot.split('#') : [null, null];
      const region = best ? (best.region === 'euw' ? 'EUW' : 'EUNE') : team.region || 'EUNE';
      const res = await db
        .prepare(
          `INSERT INTO players (team_id, nickname, role, riot_game_name, riot_tag_line, region, queue_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(teamId, String(q.nickname), role, gameName ?? null, tagLine ?? null, region, playerKey)
        .run();
      playerId = res.meta.last_row_id;
      await logActivity(db, actor, 'player.create', 'player', playerId, { nickname: q.nickname, team_id: teamId, from: 'queue' });
      await relinkDraftPlayers(env).catch(() => {});
    } else {
      const exists = await db.prepare('SELECT id FROM players WHERE id = ?').bind(playerId).first();
      if (!exists) throw new HttpError(404, 'not_found', 'Hráč v appce neexistuje.');
      // one app player per queue player
      await db.batch([
        db.prepare('UPDATE players SET queue_key = NULL WHERE queue_key = ? AND id <> ?').bind(playerKey, playerId),
        db.prepare('UPDATE players SET queue_key = ? WHERE id = ?').bind(playerKey, playerId),
      ]);
      await logActivity(db, actor, 'queue.link', 'player', playerId, { player: playerKey });
    }
    return json({ ok: true, player_id: playerId });
  }

  if ((m = path.match(/^\/api\/queue\/profile\/(.+)$/)) && method === 'POST') {
    const playerKey = key(decodeURIComponent(m[1]));
    const row = await db.prepare('SELECT profile FROM queue_players WHERE key = ?').bind(playerKey).first<{ profile: string | null }>();
    if (!row?.profile) throw new HttpError(404, 'not_found', 'Hráč nemá profil na Streamers Clash.');
    const data = await fetchProfile(row.profile);
    await saveProfile(db, playerKey, data);
    if (!data.ok) throw new HttpError(502, 'upstream', `Profil se nepodařilo načíst (${data.error}), zkus to za chvíli.`);
    return json(data);
  }

  if ((m = path.match(/^\/api\/queue\/scout\/(.+)$/)) && method === 'PUT') {
    if (guard.hidden) throw new HttpError(423, 'live', 'Jsi live na Twitchi – během streamu se scouting upravovat nedá.');
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
