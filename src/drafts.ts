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

  // Link named players to our database (nickname or Riot game name, tolerant to OCR mistakes).
  const players = await loadPlayerNames(db);
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
    const pid = playerName ? matchPlayer(players, playerName) : null;
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
