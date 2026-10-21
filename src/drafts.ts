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
}

export interface DraftInput {
  vod_id?: number | null;
  ts_s?: number | null;
  ally: DraftSlot[];
  enemy: DraftSlot[];
  ally_bans?: string[];
  enemy_bans?: string[];
  notes?: string | null;
}

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
  const slots = (list: DraftSlot[] | undefined, label: string) => {
    if (!Array.isArray(list) || list.length === 0 || list.length > 5) {
      throw new HttpError(400, 'invalid', `${label}: expected 1–5 champions`);
    }
    return list.map((s) => ({
      champion: fix(s?.champion),
      player_name: s?.player_name ? String(s.player_name).slice(0, 60) : null,
      role: normRole(s?.role),
    }));
  };
  const bans = (list: string[] | undefined) =>
    (Array.isArray(list) ? list : []).slice(0, 5).filter((b) => b && String(b).toLowerCase() !== 'none').map(fix);

  const out: DraftInput = {
    vod_id: input.vod_id ?? null,
    ts_s: input.ts_s ?? null,
    ally: slots(input.ally, 'ally'),
    enemy: slots(input.enemy, 'enemy'),
    ally_bans: bans(input.ally_bans),
    enemy_bans: bans(input.enemy_bans),
    notes: input.notes ? String(input.notes).slice(0, 2000) : null,
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

  // Link named players to our database by nickname or Riot game name.
  const names = [...draft.ally, ...draft.enemy].map((s) => s.player_name).filter((n): n is string => !!n);
  const playerIds = new Map<string, number>();
  if (names.length) {
    const { results } = await db
      .prepare(
        `SELECT id, lower(nickname) AS nick, lower(riot_game_name) AS riot FROM players
          WHERE lower(nickname) IN (${names.map(() => '?').join(',')}) OR lower(riot_game_name) IN (${names.map(() => '?').join(',')})`,
      )
      .bind(...names.map((n) => n.toLowerCase()), ...names.map((n) => n.toLowerCase()))
      .all<{ id: number; nick: string; riot: string | null }>();
    for (const r of results) {
      playerIds.set(r.nick, r.id);
      if (r.riot) playerIds.set(r.riot, r.id);
    }
  }

  const match = await db
    .prepare(
      `INSERT INTO matches (played_at, source, vod_id, vod_timestamp_s, notes, created_by_kind, pov_player_id)
       VALUES (?, 'vod', ?, ?, ?, ?, ?)`,
    )
    .bind(playedAt, draft.vod_id ?? null, draft.ts_s ?? null, draft.notes ?? null, actor.kind === 'user' ? 'user' : actor.kind, povPlayerId)
    .run();
  const matchId = match.meta.last_row_id;

  const stmts: D1PreparedStatement[] = [];
  let seq = 0;
  const insert = (side: string, action: string, slot: number, champion: string, playerName: string | null, role: string | null) => {
    const pid = playerName ? playerIds.get(playerName.toLowerCase()) ?? null : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO draft_actions (match_id, seq, side, action, slot, champion, player_id, player_name, role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(matchId, ++seq, side, action, slot, champion, pid, playerName, role),
    );
  };
  draft.ally_bans?.forEach((c, i) => insert('ALLY', 'BAN', i, c, null, null));
  draft.enemy_bans?.forEach((c, i) => insert('ENEMY', 'BAN', i, c, null, null));
  draft.ally.forEach((s, i) => insert('ALLY', 'PICK', i, s.champion, s.player_name ?? null, s.role ?? null));
  draft.enemy.forEach((s, i) => insert('ENEMY', 'PICK', i, s.champion, s.player_name ?? null, s.role ?? null));
  await db.batch(stmts);

  await logActivity(db, actor, 'draft.create', 'match', matchId, {
    name: `${draft.ally.map((s) => s.champion).join(', ')} vs ${draft.enemy.map((s) => s.champion).join(', ')}`,
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
      `SELECT * FROM draft_actions WHERE match_id IN (${matches.map(() => '?').join(',')}) ORDER BY match_id, seq`,
    )
    .bind(...matches.map((m) => m.id))
    .all<Record<string, unknown> & { match_id: number }>();
  return matches.map((m) => ({ ...m, actions: actions.filter((a) => a.match_id === m.id) }));
}
