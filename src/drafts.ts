import type { Env } from './index';
import { getChampions, resolveChampion } from './champions';
import { logActivity } from './db';
import { HttpError } from './http';

// A draft as seen from one player's stream (POV): their team on the left ("ally"),
// the opponents on the right ("enemy"). Blue/red side isn't visible in champ select.

export interface DraftSlot {
  champion: string;
  player_name?: string | null;
  role?: string | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  lane?: number | null; // 0–4 = row on the post-game scoreboard (top … support); same lane = lane opponent
}

export interface PostGameInput {
  result?: string | null; // WIN / LOSS from the ally side
  game_type?: string | null;
  duration_s?: number | null;
  ts_s?: number | null;
  ally?: DraftSlot[];
  enemy?: DraftSlot[];
}

export interface DraftInput {
  vod_id?: number | null;
  ts_s?: number | null;
  ally: DraftSlot[];
  enemy: DraftSlot[];
  ally_bans?: string[];
  enemy_bans?: string[];
  notes?: string | null;
  result?: string | null;
  game_type?: string | null;
  duration_s?: number | null;
  postgame_ts?: number | null;
  /** Post-game scoreboard as read by the reader; merged into the slots by champion. */
  postgame?: PostGameInput | null;
}

const num = (v: unknown, max = 99): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isInteger(n) || n < 0 || n > max ? null : n;
};

const ROLES = new Set(['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']);
const ROLE_ALIASES: Record<string, string> = { BOTTOM: 'ADC', BOT: 'ADC', UTILITY: 'SUPPORT', SUP: 'SUPPORT', JNG: 'JUNGLE', MIDDLE: 'MID' };

function normRole(r: unknown): string | null {
  if (!r) return null;
  const u = String(r).trim().toUpperCase();
  const v = ROLE_ALIASES[u] ?? u;
  return ROLES.has(v) ? v : null;
}

/** Validates champion names against Data Dragon; throws a readable error listing unknown names. */
export async function validateDraft(env: Env, input: DraftInput): Promise<DraftInput> {
  const champions = await getChampions(env);
  const unknown: string[] = [];
  const fix = (name: unknown): string => {
    const resolved = resolveChampion(champions, String(name ?? ''));
    if (!resolved) unknown.push(String(name));
    return resolved ?? String(name);
  };
  const slots = (list: DraftSlot[] | undefined, label: string, scoreboard?: DraftSlot[]) => {
    if (!Array.isArray(list) || list.length === 0 || list.length > 5) {
      throw new HttpError(400, 'invalid', `${label}: expected 1–5 champions`);
    }
    return list.map((s) => {
      const champion = fix(s?.champion);
      // The same champion's row on the post-game scoreboard, if we have it.
      const sb = scoreboard?.find((r) => resolveChampion(champions, String(r?.champion ?? '')) === champion);
      return {
        champion,
        player_name: (s?.player_name || sb?.player_name) ? String(s?.player_name || sb?.player_name).slice(0, 60) : null,
        role: normRole(sb?.role) ?? normRole(s?.role),
        kills: num(s?.kills ?? sb?.kills),
        deaths: num(s?.deaths ?? sb?.deaths),
        assists: num(s?.assists ?? sb?.assists),
        lane: num(s?.lane ?? sb?.lane, 4),
      };
    });
  };
  const bans = (list: string[] | undefined) =>
    (Array.isArray(list) ? list : []).slice(0, 5).filter((b) => b && String(b).toLowerCase() !== 'none').map(fix);

  const pg = input.postgame ?? null;
  const resultRaw = String(input.result ?? pg?.result ?? '').toUpperCase();
  const result = resultRaw === 'WIN' || resultRaw === 'VICTORY' ? 'WIN' : resultRaw === 'LOSS' || resultRaw === 'DEFEAT' ? 'LOSS' : null;
  const out: DraftInput = {
    vod_id: input.vod_id ?? null,
    ts_s: input.ts_s ?? null,
    ally: slots(input.ally, 'ally', pg?.ally),
    enemy: slots(input.enemy, 'enemy', pg?.enemy),
    ally_bans: bans(input.ally_bans),
    enemy_bans: bans(input.enemy_bans),
    notes: input.notes ? String(input.notes).slice(0, 2000) : null,
    result,
    game_type: (input.game_type ?? pg?.game_type) ? String(input.game_type ?? pg?.game_type).slice(0, 40) : null,
    duration_s: num(input.duration_s ?? pg?.duration_s, 6 * 3600),
    postgame_ts: num(input.postgame_ts ?? pg?.ts_s, 24 * 3600),
  };
  if (unknown.length) throw new HttpError(400, 'unknown_champion', `Neznámí championi: ${unknown.join(', ')}`);
  return out;
}

/** Stores a validated draft as a match with draft actions. Returns the match id. */
export async function saveDraft(
  env: Env,
  draft: DraftInput,
  actor: { kind: 'user' | 'claude' | 'sync'; userId?: number | null },
): Promise<number> {
  const db = env.DB;
  let povPlayerId: number | null = null;
  let playedAt: string | null = null;

  if (draft.vod_id) {
    const vod = await db
      .prepare('SELECT player_id, started_at FROM vods WHERE id = ?')
      .bind(draft.vod_id)
      .first<{ player_id: number | null; started_at: string | null }>();
    if (!vod) throw new HttpError(404, 'not_found', 'VOD neexistuje.');
    povPlayerId = vod.player_id;
    if (vod.started_at) {
      playedAt = new Date(new Date(vod.started_at).getTime() + (draft.ts_s ?? 0) * 1000).toISOString();
    }
  }

  // Link named players to our database (nickname or Riot game name, tolerant to OCR mistakes).
  const players = await loadPlayerNames(db);
  const match = await db
    .prepare(
      `INSERT INTO matches (played_at, source, vod_id, vod_timestamp_s, notes, created_by_kind, pov_player_id,
                            result, game_type, duration_s, postgame_ts)
       VALUES (?, 'vod', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      playedAt, draft.vod_id ?? null, draft.ts_s ?? null, draft.notes ?? null, actor.kind === 'user' ? 'user' : actor.kind,
      povPlayerId, draft.result ?? null, draft.game_type ?? null, draft.duration_s ?? null, draft.postgame_ts ?? null,
    )
    .run();
  const matchId = match.meta.last_row_id;

  const stmts: D1PreparedStatement[] = [];
  let seq = 0;
  const insert = (side: string, action: string, slot: number, s: DraftSlot) => {
    const playerName = s.player_name ?? null;
    const pid = playerName ? matchPlayer(players, playerName) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO draft_actions (match_id, seq, side, action, slot, champion, player_id, player_name, role, kills, deaths, assists, lane)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(matchId, ++seq, side, action, slot, s.champion, pid, playerName, s.role ?? null,
          s.kills ?? null, s.deaths ?? null, s.assists ?? null, s.lane ?? null),
    );
  };
  draft.ally_bans?.forEach((c, i) => insert('ALLY', 'BAN', i, { champion: c }));
  draft.enemy_bans?.forEach((c, i) => insert('ENEMY', 'BAN', i, { champion: c }));
  draft.ally.forEach((s, i) => insert('ALLY', 'PICK', i, s));
  draft.enemy.forEach((s, i) => insert('ENEMY', 'PICK', i, s));
  await db.batch(stmts);

  await logActivity(db, actor, 'draft.create', 'match', matchId, {
    name: `${draft.ally.map((s) => s.champion).join(', ')} vs ${draft.enemy.map((s) => s.champion).join(', ')}`,
    result: draft.result ?? undefined,
  });
  return matchId;
}

/** Matches with their draft actions, newest first. */
export async function listDrafts(
  env: Env,
  filter: { playerId?: number; teamId?: number; vodId?: number; limit?: number },
) {
  const db = env.DB;
  const where: string[] = [];
  const params: number[] = [];
  if (filter.vodId) (where.push('m.vod_id = ?'), params.push(filter.vodId));
  if (filter.playerId) {
    where.push('(m.pov_player_id = ? OR m.id IN (SELECT match_id FROM draft_actions WHERE player_id = ?))');
    params.push(filter.playerId, filter.playerId);
  }
  if (filter.teamId) {
    where.push(
      `(m.pov_player_id IN (SELECT id FROM players WHERE team_id = ?)
        OR m.id IN (SELECT match_id FROM draft_actions WHERE player_id IN (SELECT id FROM players WHERE team_id = ?)))`,
    );
    params.push(filter.teamId, filter.teamId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
  const { results: matches } = await db
    .prepare(
      `SELECT m.*, p.nickname AS pov_nickname, v.url AS vod_url, v.platform AS vod_platform
         FROM matches m
         LEFT JOIN players p ON p.id = m.pov_player_id
         LEFT JOIN vods v ON v.id = m.vod_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(m.played_at, m.created_at) DESC LIMIT ${limit}`,
    )
    .bind(...params)
    .all<Record<string, unknown> & { id: number }>();
  if (!matches.length) return [];

  const { results: actions } = await db
    .prepare(
      `SELECT a.*, p.nickname AS player_nickname FROM draft_actions a LEFT JOIN players p ON p.id = a.player_id
        WHERE a.match_id IN (${matches.map(() => '?').join(',')}) ORDER BY a.match_id, a.seq`,
    )
    .bind(...matches.map((m) => m.id))
    .all<Record<string, unknown> & { match_id: number }>();
  return matches.map((m) => ({ ...m, actions: actions.filter((a) => a.match_id === m.id) }));
}

// --- player name matching ---------------------------------------------------------

interface PlayerNames {
  id: number;
  keys: string[];
}

function nameKey(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

async function loadPlayerNames(db: D1Database): Promise<PlayerNames[]> {
  const { results } = await db
    .prepare('SELECT id, nickname, riot_game_name FROM players')
    .all<{ id: number; nickname: string; riot_game_name: string | null }>();
  return results.map((p) => ({ id: p.id, keys: [p.nickname, p.riot_game_name].filter((n): n is string => !!n).map(nameKey) }));
}

/** Best player for a name read by OCR: exact match, or up to 1–2 wrong letters for longer names. */
function matchPlayer(players: PlayerNames[], name: string): number | null {
  const key = nameKey(name);
  if (key.length < 3) return null;
  let best: { id: number; d: number } | null = null;
  for (const p of players) {
    for (const k of p.keys) {
      if (!k) continue;
      const d = levenshtein(key, k);
      const allowed = Math.max(key.length, k.length) >= 6 ? 2 : Math.max(key.length, k.length) >= 4 ? 1 : 0;
      if (d <= allowed && (!best || d < best.d)) best = { id: p.id, d };
    }
  }
  return best?.id ?? null;
}

/** Links draft picks that were saved before the player existed (or before their Riot ID was filled in). */
export async function relinkDraftPlayers(env: Env): Promise<number> {
  const db = env.DB;
  const { results } = await db
    .prepare('SELECT id, player_name FROM draft_actions WHERE player_id IS NULL AND player_name IS NOT NULL')
    .all<{ id: number; player_name: string }>();
  if (!results.length) return 0;
  const players = await loadPlayerNames(db);
  const updates = results
    .map((r) => ({ id: r.id, pid: matchPlayer(players, r.player_name) }))
    .filter((u): u is { id: number; pid: number } => u.pid !== null);
  for (let i = 0; i < updates.length; i += 50) {
    await db.batch(
      updates.slice(i, i + 50).map((u) => db.prepare('UPDATE draft_actions SET player_id = ? WHERE id = ?').bind(u.pid, u.id)),
    );
  }
  return updates.length;
}

// --- player statistics -------------------------------------------------------------

export interface PlayerGame {
  match_id: number;
  played_at: string | null;
  result: 'WIN' | 'LOSS' | null; // from this player's point of view
  champion: string;
  role: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  opponent: { champion: string; player_name: string | null; player_id: number | null } | null;
  duration_s: number | null;
  game_type: string | null;
  vod_url: string | null;
  vod_timestamp_s: number | null;
}

/** Every recorded game of a player, newest first, with result and lane opponent from their side. */
export async function playerGames(env: Env, playerId: number, limit = 200): Promise<PlayerGame[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.match_id, a.side, a.champion, a.role, a.kills, a.deaths, a.assists, a.lane,
            m.played_at, m.result, m.duration_s, m.game_type, m.vod_timestamp_s, v.url AS vod_url,
            o.champion AS opp_champion, o.player_name AS opp_name, o.player_id AS opp_player_id
       FROM draft_actions a
       JOIN matches m ON m.id = a.match_id
       LEFT JOIN vods v ON v.id = m.vod_id
       LEFT JOIN draft_actions o ON o.match_id = a.match_id AND o.action = 'PICK' AND o.side <> a.side
                                AND a.lane IS NOT NULL AND o.lane = a.lane
      WHERE a.player_id = ? AND a.action = 'PICK'
      ORDER BY COALESCE(m.played_at, m.created_at) DESC
      LIMIT ?`,
  )
    .bind(playerId, limit)
    .all<Record<string, unknown>>();
  return results.map((r) => {
    const raw = r.result as string | null;
    const result = raw ? ((r.side === 'ALLY') === (raw === 'WIN') ? 'WIN' : 'LOSS') : null;
    return {
      match_id: r.match_id as number,
      played_at: r.played_at as string | null,
      result,
      champion: r.champion as string,
      role: r.role as string | null,
      kills: r.kills as number | null,
      deaths: r.deaths as number | null,
      assists: r.assists as number | null,
      opponent: r.opp_champion
        ? { champion: r.opp_champion as string, player_name: r.opp_name as string | null, player_id: r.opp_player_id as number | null }
        : null,
      duration_s: r.duration_s as number | null,
      game_type: r.game_type as string | null,
      vod_url: r.vod_url as string | null,
      vod_timestamp_s: r.vod_timestamp_s as number | null,
    };
  });
}

export function summarizeGames(games: PlayerGame[]) {
  const pool = new Map<string, { champion: string; games: number; wins: number; losses: number; k: number; d: number; a: number; kdaGames: number }>();
  let wins = 0, losses = 0, k = 0, d = 0, a = 0, kdaGames = 0;
  for (const g of games) {
    const p = pool.get(g.champion) ?? { champion: g.champion, games: 0, wins: 0, losses: 0, k: 0, d: 0, a: 0, kdaGames: 0 };
    p.games++;
    if (g.result === 'WIN') (p.wins++, wins++);
    if (g.result === 'LOSS') (p.losses++, losses++);
    if (g.kills !== null && g.deaths !== null && g.assists !== null) {
      p.k += g.kills; p.d += g.deaths; p.a += g.assists; p.kdaGames++;
      k += g.kills; d += g.deaths; a += g.assists; kdaGames++;
    }
    pool.set(g.champion, p);
  }
  const kda = (k: number, d: number, a: number) => Math.round(((k + a) / Math.max(d, 1)) * 100) / 100;
  return {
    games: games.length,
    wins,
    losses,
    winrate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : null,
    kda: kdaGames ? kda(k, d, a) : null,
    avg: kdaGames ? { kills: +(k / kdaGames).toFixed(1), deaths: +(d / kdaGames).toFixed(1), assists: +(a / kdaGames).toFixed(1) } : null,
    champions: [...pool.values()]
      .sort((x, y) => y.games - x.games || y.wins - x.wins)
      .map((p) => ({
        champion: p.champion,
        games: p.games,
        wins: p.wins,
        losses: p.losses,
        winrate: p.wins + p.losses ? Math.round((p.wins / (p.wins + p.losses)) * 100) : null,
        kda: p.kdaGames ? kda(p.k, p.d, p.a) : null,
      })),
  };
}
