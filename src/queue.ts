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
async function liveLobbies(): Promise<unknown[]> {
  const cache = caches.default;
  const cacheKey = new Request('https://sc-scouting.internal/queue-live');
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const lobby = await getSc<{ live?: ScLobby[] }>('lobby');
  const live = (lobby.live ?? []).filter((l) => l.state !== 'ended').map((l) => ({
    uid: l.id, number: l.number, state: l.state, day: l.day ?? null, time_from: l.from ?? null,
    blue: l.blue.map(slim), red: l.red.map(slim), opgg: l.opgg ?? null,
  }));
  await cache.put(cacheKey, new Response(JSON.stringify(live), { headers: { 'Cache-Control': `max-age=${LIVE_CACHE_SECONDS}` } }));
  return live;
}

function parseScout(body: Record<string, unknown>) {
  const roles = Array.isArray(body.fav_roles) ? body.fav_roles.map(String).filter((r) => (QUEUE_ROLES as readonly string[]).includes(r)) : [];
  let price: number | null = null;
  if (body.price !== undefined && body.price !== null && String(body.price).trim() !== '') {
    price = Number(String(body.price).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'invalid', 'Cena musí být kladné číslo.');
  }
  const note = body.note === undefined || body.note === null ? null : String(body.note).slice(0, 4000).trim() || null;
  return { fav_roles: JSON.stringify([...new Set(roles)]), price, note };
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
    const [players, matches, scout, meta] = await Promise.all([
      db.prepare('SELECT * FROM queue_players ORDER BY rank IS NULL, rank, nickname COLLATE NOCASE').all(),
      db.prepare('SELECT * FROM queue_matches ORDER BY number DESC').all(),
      db.prepare(`SELECT s.*, u.display_name AS updated_by_name FROM queue_scout s LEFT JOIN users u ON u.id = s.updated_by`).all(),
      db.prepare(`SELECT v FROM queue_meta WHERE k = 'synced_at'`).first<{ v: string }>(),
    ]);
    return json({
      players: players.results,
      matches: matches.results.map((r: Record<string, unknown>) => ({ ...r, blue: JSON.parse(String(r.blue)), red: JSON.parse(String(r.red)) })),
      scout: scout.results.map((r: Record<string, unknown>) => ({ ...r, fav_roles: JSON.parse(String(r.fav_roles || '[]')) })),
      synced_at: meta?.v ?? null,
    });
  }

  if (path === '/api/queue/live' && method === 'GET') {
    try {
      return json({ live: await liveLobbies() });
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
    const s = parseScout(await readBody(req));
    await db
      .prepare(
        `INSERT INTO queue_scout (player_key, fav_roles, price, note, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(player_key) DO UPDATE SET fav_roles = excluded.fav_roles, price = excluded.price,
           note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(playerKey, s.fav_roles, s.price, s.note, user.id)
      .run();
    await logActivity(db, { kind: 'user', userId: user.id }, 'queue.scout', 'queue_player', null, { player: playerKey, ...s });
    return json({ ok: true });
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}
