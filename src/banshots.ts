// Bans for games whose draft wasn't read: blind-pick customs drafted on drafter.lol (or anywhere else on stream)
// that the reader didn't recognise. The reader keeps a few frames from just before each such game; Claude looks at
// them through the connector (list_games_missing_bans → get_ban_shot) and saves the bans, or marks that none show.
import type { Env } from './index';
import { getChampions, resolveChampion } from './champions';
import { saveBans } from './drafter';
import { HttpError } from './http';

export const MAX_SHOTS = 8;

/** A saved game that has no bans, hasn't been checked by hand and has no frames kept yet. */
export async function needBanShots(db: D1Database, matchId: number | null | undefined): Promise<boolean> {
  if (!matchId) return false;
  const row = await db
    .prepare(
      `SELECT m.vod_id, m.bans_checked,
              (SELECT COUNT(*) FROM draft_actions a WHERE a.match_id = m.id AND a.action = 'BAN') AS bans,
              (SELECT COUNT(*) FROM ban_shots s WHERE s.match_id = m.id) AS shots
         FROM matches m WHERE m.id = ?`,
    )
    .bind(matchId)
    .first<{ vod_id: number | null; bans_checked: number; bans: number; shots: number }>();
  return !!row && !!row.vod_id && !row.bans_checked && !row.bans && !row.shots;
}

/** Reader upload: frames from just before a game (kind 'frame') and one overview of them all (kind 'sheet'). */
export async function storeBanShots(
  env: Env,
  body: { match_id?: number; shots?: { ts_s: number; image_b64: string; kind?: string }[] },
  maxBytes: number,
): Promise<{ stored: number }> {
  const matchId = Number(body.match_id);
  const shots = Array.isArray(body.shots) ? body.shots.slice(0, MAX_SHOTS + 1) : [];
  if (!matchId || !shots.length) throw new HttpError(400, 'invalid', 'match_id and shots are required');
  if (!(await needBanShots(env.DB, matchId))) return { stored: 0 };
  const m = await env.DB.prepare('SELECT vod_id FROM matches WHERE id = ?').bind(matchId).first<{ vod_id: number }>();
  const stmts = [];
  for (const s of shots) {
    const bytes = Uint8Array.from(atob(String(s.image_b64 || '')), (c) => c.charCodeAt(0));
    if (!bytes.length || bytes.length > maxBytes) continue;
    stmts.push(
      env.DB.prepare(`INSERT OR IGNORE INTO ban_shots (match_id, vod_id, ts_s, kind, image) VALUES (?, ?, ?, ?, ?)`)
        .bind(matchId, m!.vod_id, Math.round(Number(s.ts_s) || 0), s.kind === 'sheet' ? 'sheet' : 'frame', bytes.buffer),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { stored: stmts.length };
}

const at = (t: number) => `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;

/** Games waiting for bans from their kept frames, newest first. */
export async function gamesMissingBans(env: Env, limit = 10, checked = false) {
  const db = env.DB;
  // frames of games that got their bans some other way (drafter.lol import, a rescan) aren't needed any more
  await db
    .prepare(
      `DELETE FROM ban_shots WHERE match_id IN (SELECT m.id FROM matches m
          WHERE EXISTS (SELECT 1 FROM draft_actions a WHERE a.match_id = m.id AND a.action = 'BAN'))
          OR (created_at < datetime('now', '-3 days') AND match_id IN (SELECT id FROM matches WHERE bans_checked = 1))`,
    )
    .run();
  const { results } = await db
    .prepare(
      `SELECT m.id, m.played_at, m.result, m.game_type, m.duration_s, m.vod_timestamp_s, v.url AS vod_url, p.nickname AS pov_player
         FROM matches m JOIN vods v ON v.id = m.vod_id LEFT JOIN players p ON p.id = m.pov_player_id
        WHERE EXISTS (SELECT 1 FROM ban_shots s WHERE s.match_id = m.id) AND m.bans_checked = ?
        ORDER BY COALESCE(m.played_at, m.created_at) DESC LIMIT ?`,
    )
    .bind(checked ? 1 : 0, Math.min(Math.max(limit, 1), 30))
    .all<{ id: number; played_at: string | null; result: string | null; game_type: string | null; duration_s: number | null; vod_timestamp_s: number | null; vod_url: string; pov_player: string | null }>();
  if (!results.length) return [];
  const ids = results.map((r) => r.id);
  const q = ids.map(() => '?').join(',');
  const [{ results: picks }, { results: shots }] = await Promise.all([
    db.prepare(
      `SELECT a.match_id, a.side, a.champion, COALESCE(pl.nickname, a.player_name) AS name, a.lane
         FROM draft_actions a LEFT JOIN players pl ON pl.id = a.player_id
        WHERE a.match_id IN (${q}) AND a.action = 'PICK' ORDER BY a.match_id, a.side, COALESCE(a.lane, a.seq)`,
    ).bind(...ids).all<{ match_id: number; side: string; champion: string; name: string | null }>(),
    db.prepare(`SELECT id, match_id, ts_s, kind FROM ban_shots WHERE match_id IN (${q}) ORDER BY match_id, kind DESC, ts_s`)
      .bind(...ids).all<{ id: number; match_id: number; ts_s: number; kind: string }>(),
  ]);
  return results.map((m) => {
    const side = (s: string) => picks.filter((p) => p.match_id === m.id && p.side === s).map((p) => `${p.champion}${p.name ? ` (${p.name})` : ''}`);
    const mine = shots.filter((s) => s.match_id === m.id);
    return {
      match_id: m.id,
      played_at: m.played_at,
      result: m.result,
      game_type: m.game_type,
      pov_player: m.pov_player,
      ally_picks: side('ALLY'),
      enemy_picks: side('ENEMY'),
      overview_shot_id: mine.find((s) => s.kind === 'sheet')?.id ?? null,
      shots: mine.filter((s) => s.kind === 'frame').map((s) => ({ shot_id: s.id, vod_link: `${m.vod_url}?t=${at(s.ts_s)}` })),
    };
  });
}

export async function getBanShot(env: Env, id: number) {
  const row = await env.DB.prepare(
    `SELECT s.image, s.ts_s, s.kind, s.match_id, v.url AS vod_url FROM ban_shots s JOIN vods v ON v.id = s.vod_id WHERE s.id = ?`,
  ).bind(id).first<{ image: number[]; ts_s: number; kind: string; match_id: number; vod_url: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'Shot not found (the game may have its bans already)');
  return { ...row, vod_link: `${row.vod_url}?t=${at(row.ts_s)}` };
}

/** Bans read from the frames by hand, or "none visible" – either way the game's frames are dropped. */
export async function resolveBans(env: Env, matchId: number, allyBans: string[], enemyBans: string[], none: boolean): Promise<{ saved: boolean; ally: string[]; enemy: string[] }> {
  const db = env.DB;
  const m = await db.prepare('SELECT id FROM matches WHERE id = ?').bind(matchId).first();
  if (!m) throw new HttpError(404, 'not_found', 'Game not found');
  let ally: string[] = [], enemy: string[] = [];
  if (!none) {
    const champions = await getChampions(env);
    const unknown: string[] = [];
    const clean = (l: string[]) => l.slice(0, 5).map((c) => {
      const r = resolveChampion(champions, String(c));
      if (!r) unknown.push(String(c));
      return r;
    }).filter((c): c is string => !!c);
    ally = clean(allyBans); enemy = clean(enemyBans);
    if (unknown.length) throw new HttpError(400, 'unknown_champion', `Neznámí championi: ${unknown.join(', ')}`);
    if (!ally.length && !enemy.length) throw new HttpError(400, 'invalid', 'Give the bans, or no_bans: true when none are visible');
    await saveBans(env, matchId, ally, enemy);
  }
  // "none visible" keeps the frames for 3 days so a person (or Claude) can take a second look
  await db.batch([
    db.prepare('UPDATE matches SET bans_checked = 1 WHERE id = ?').bind(matchId),
    ...(none ? [] : [db.prepare('DELETE FROM ban_shots WHERE match_id = ?').bind(matchId)]),
  ]);
  return { saved: !none, ally, enemy };
}
