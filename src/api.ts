import type { Env } from './index';
import { logActivity, type User } from './db';
import { HttpError, json } from './http';
import { getLiveChannels, syncTwitchVods } from './vods';
import { listDrafts, playerGames, relinkDraftPlayers, summarizeGames } from './drafts';
import { getChampionData } from './champions';
import { listSchedule, opponentLabel, requireOpponent, scheduleFields } from './schedule';
import { createFolder, deleteFolder, deleteNote, deleteRunePage, loadCoaching, renameFolder, saveNote, saveRunePage } from './coaching';
import { getRuneData } from './runes';

const ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'SUB'] as const;
const REGIONS = ['EUNE', 'EUW'] as const;

export async function handleApi(req: Request, env: Env, url: URL, user: User): Promise<Response> {
  try {
    return await route(req, env, url, user);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
    console.error('API error', err);
    return json({ error: 'internal_error' }, 500);
  }
}

async function route(req: Request, env: Env, url: URL, user: User): Promise<Response> {
  const db = env.DB;
  const method = req.method;
  const path = url.pathname.replace(/\/+$/, '');
  const actor = { kind: 'user' as const, userId: user.id };
  let m: RegExpMatchArray | null;

  if (method !== 'GET' && method !== 'DELETE' && !req.headers.get('Content-Type')?.includes('application/json')) {
    throw new HttpError(415, 'json_required', 'Expected application/json');
  }

  // --- me ---------------------------------------------------------------
  if (path === '/api/me' && method === 'GET') return json({ user });

  // --- users (allowlist, admin only) -------------------------------------
  if (path === '/api/users') {
    requireAdmin(user);
    if (method === 'GET') {
      const { results } = await db
        .prepare(
          'SELECT id, twitch_login, display_name, avatar_url, role, created_at, last_login_at FROM users ORDER BY role, twitch_login',
        )
        .all();
      return json({ users: results });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const login = normalizeChannel(body.twitch_login, 'twitch.tv');
      if (!login) throw new HttpError(400, 'invalid', 'Zadej Twitch login.');
      const role = body.role === 'admin' ? 'admin' : 'member';
      const res = await db
        .prepare('INSERT INTO users (twitch_login, role, added_by) VALUES (?, ?, ?) ON CONFLICT(twitch_login) DO NOTHING')
        .bind(login, role, user.id)
        .run();
      if (!res.meta.changes) throw new HttpError(409, 'exists', 'Tenhle uživatel už v seznamu je.');
      await logActivity(db, actor, 'user.add', 'user', res.meta.last_row_id, { login, role });
      return json({ ok: true }, 201);
    }
  }
  if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === 'DELETE') {
    requireAdmin(user);
    const id = Number(m[1]);
    if (id === user.id) throw new HttpError(400, 'self', 'Sám sebe odebrat nemůžeš.');
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    await logActivity(db, actor, 'user.remove', 'user', id);
    return json({ ok: true });
  }

  // --- teams -------------------------------------------------------------
  if (path === '/api/teams') {
    if (method === 'GET') {
      const { results } = await db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS player_count
             FROM teams t ORDER BY t.is_own_team DESC, t.name COLLATE NOCASE`,
        )
        .all();
      return json({ teams: results });
    }
    if (method === 'POST') {
      const fields = teamFields(await readBody(req), false);
      const id = await insert(db, 'teams', { ...fields, created_by: user.id });
      await logActivity(db, actor, 'team.create', 'team', id, { name: fields.name });
      return json({ id }, 201);
    }
  }
  if ((m = path.match(/^\/api\/teams\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const team = await db.prepare('SELECT * FROM teams WHERE id = ?').bind(id).first();
      if (!team) throw new HttpError(404, 'not_found', 'Tým neexistuje.');
      const { results: players } = await db
        .prepare(
          `SELECT * FROM players WHERE team_id = ?
            ORDER BY CASE role WHEN 'TOP' THEN 1 WHEN 'JUNGLE' THEN 2 WHEN 'MID' THEN 3
                               WHEN 'ADC' THEN 4 WHEN 'SUPPORT' THEN 5 ELSE 6 END, nickname COLLATE NOCASE`,
        )
        .bind(id)
        .all();
      return json({ team, players: players.map(parsePlayer) });
    }
    if (method === 'PUT') {
      const fields = teamFields(await readBody(req), true);
      await update(db, 'teams', id, fields);
      await logActivity(db, actor, 'team.update', 'team', id, fields);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM teams WHERE id = ?').bind(id).run();
      await logActivity(db, actor, 'team.delete', 'team', id);
      return json({ ok: true });
    }
  }

  // --- players -----------------------------------------------------------
  if ((m = path.match(/^\/api\/teams\/(\d+)\/players$/)) && method === 'POST') {
    const teamId = Number(m[1]);
    const team = await db.prepare('SELECT region FROM teams WHERE id = ?').bind(teamId).first<{ region: string }>();
    if (!team) throw new HttpError(404, 'not_found', 'Tým neexistuje.');
    const fields = playerFields(await readBody(req), false);
    const id = await insert(db, 'players', { region: team.region, ...fields, team_id: teamId });
    await logActivity(db, actor, 'player.create', 'player', id, { nickname: fields.nickname, team_id: teamId });
    await relinkDraftPlayers(env);
    // Pull the new player's VODs right away.
    if (fields.twitch_login) await syncTwitchVods(env, [String(fields.twitch_login)]).catch(() => {});
    return json({ id }, 201);
  }
  if ((m = path.match(/^\/api\/players\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const player = await db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<Record<string, unknown>>();
      if (!player) throw new HttpError(404, 'not_found', 'Hráč neexistuje.');
      const [team, games, notes, vods] = await Promise.all([
        player.team_id ? db.prepare('SELECT id, name, tag, accent_color, logo_url, is_own_team FROM teams WHERE id = ?').bind(player.team_id).first() : null,
        playerGames(env, id),
        db.prepare(
          `SELECT n.*, u.display_name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_user_id
            WHERE n.target_type = 'player' AND n.target_id = ? ORDER BY n.id DESC LIMIT 50`,
        ).bind(id).all(),
        db.prepare(
          `SELECT id, title, url, started_at, duration_s, thumbnail_url, scan_status FROM vods WHERE player_id = ? ORDER BY started_at DESC LIMIT 8`,
        ).bind(id).all(),
      ]);
      return json({ player: parsePlayer(player), team, stats: summarizeGames(games), games, notes: notes.results, vods: vods.results });
    }
    if (method === 'PUT') {
      const fields = playerFields(await readBody(req), true);
      await update(db, 'players', id, fields);
      await logActivity(db, actor, 'player.update', 'player', id, fields);
      await relinkDraftPlayers(env);
      if (fields.twitch_login) await syncTwitchVods(env, [String(fields.twitch_login)]).catch(() => {});
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM players WHERE id = ?').bind(id).run();
      await logActivity(db, actor, 'player.delete', 'player', id);
      return json({ ok: true });
    }
  }

  // --- vods & channels ----------------------------------------------------
  if (path === '/api/vods' && method === 'GET') {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const teamId = url.searchParams.get('team_id');
    const playerId = url.searchParams.get('player_id');
    const channel = url.searchParams.get('channel');
    if (teamId) (where.push('p.team_id = ?'), params.push(Number(teamId)));
    if (playerId) (where.push('v.player_id = ?'), params.push(Number(playerId)));
    if (channel) (where.push('v.channel_login = ?'), params.push(channel.toLowerCase()));
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);
    const { results } = await db
      .prepare(
        `SELECT v.*, p.nickname AS player_nickname, p.role AS player_role, p.team_id,
                (SELECT COUNT(*) FROM matches m WHERE m.vod_id = v.id) AS draft_count,
                (SELECT COUNT(*) FROM draft_frames f WHERE f.vod_id = v.id AND f.status = 'review') AS review_count,
                t.name AS team_name, t.accent_color AS team_color, c.label AS channel_label
           FROM vods v
           LEFT JOIN players p ON p.id = v.player_id
           LEFT JOIN teams t ON t.id = p.team_id
           LEFT JOIN channels c ON c.platform = v.platform AND lower(c.login) = v.channel_login
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY v.started_at DESC LIMIT ${limit}`,
      )
      .bind(...params)
      .all();
    return json({ vods: results });
  }

  if (path === '/api/vods/sync' && method === 'POST') {
    const body = await readBody(req);
    const login = normalizeChannel(body.login, 'twitch.tv');
    const result = await syncTwitchVods(env, login ? [login] : undefined);
    return json(result);
  }

  if (path === '/api/live' && method === 'GET') {
    try {
      return json({ twitch: await getLiveChannels(env) });
    } catch (err) {
      console.error('live status failed', err);
      throw new HttpError(502, 'twitch_unavailable', 'Twitch teď neodpovídá.');
    }
  }

  if (path === '/api/channels') {
    if (method === 'GET') {
      const { results } = await db
        .prepare(
          `SELECT c.*, s.last_synced_at, s.last_error,
                  (SELECT COUNT(*) FROM vods v WHERE v.platform = c.platform AND v.channel_login = lower(c.login)) AS vod_count
             FROM channels c LEFT JOIN sync_state s ON s.key = c.platform || ':' || lower(c.login)
            ORDER BY c.label COLLATE NOCASE, c.login`,
        )
        .all();
      return json({ channels: results });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const platform = body.platform === 'kick' ? 'kick' : 'twitch';
      const login = normalizeChannel(body.login, platform === 'kick' ? 'kick.com' : 'twitch.tv');
      if (!login) throw new HttpError(400, 'invalid', 'Zadej kanál.');
      const label = str(body.label, 'Popisek', 80);
      const res = await db
        .prepare('INSERT INTO channels (platform, login, label) VALUES (?, ?, ?) ON CONFLICT(platform, login) DO NOTHING')
        .bind(platform, login, label)
        .run();
      if (!res.meta.changes) throw new HttpError(409, 'exists', 'Tenhle kanál už sledujeme.');
      await logActivity(db, actor, 'channel.add', 'channel', res.meta.last_row_id, { login, label });
      // Fetch its VODs right away so the user sees something.
      if (platform === 'twitch') await syncTwitchVods(env, [login]).catch(() => {});
      return json({ id: res.meta.last_row_id }, 201);
    }
  }
  if ((m = path.match(/^\/api\/channels\/(\d+)$/)) && method === 'DELETE') {
    const id = Number(m[1]);
    await db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
    await logActivity(db, actor, 'channel.remove', 'channel', id);
    return json({ ok: true });
  }

  // --- drafts & reader frames ---------------------------------------------
  if (path === '/api/champions' && method === 'GET') {
    try {
      return json(await getChampionData(env), 200, { 'Cache-Control': 'private, max-age=3600' });
    } catch {
      throw new HttpError(502, 'ddragon_unavailable', 'Seznam championů teď není dostupný.');
    }
  }

  if (path === '/api/drafts' && method === 'GET') {
    const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
    const drafts = await listDrafts(env, {
      teamId: num('team_id'),
      playerId: num('player_id'),
      vodId: num('vod_id'),
      limit: num('limit'),
    });
    return json({ drafts });
  }

  if (path === '/api/frames' && method === 'GET') {
    const status = url.searchParams.get('status') ?? 'review';
    const { results } = await db
      .prepare(
        `SELECT f.id, f.vod_id, f.ts_s, f.width, f.height, f.reading, f.confidence, f.status, f.match_id, f.note, f.created_at,
                v.url AS vod_url, v.title AS vod_title, v.channel_login
           FROM draft_frames f JOIN vods v ON v.id = f.vod_id
          WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 100`,
      )
      .bind(status)
      .all();
    return json({ frames: results });
  }

  if ((m = path.match(/^\/api\/frames\/(\d+)\/image$/)) && method === 'GET') {
    const row = await db.prepare('SELECT image FROM draft_frames WHERE id = ?').bind(Number(m[1])).first<{ image: number[] }>();
    if (!row) throw new HttpError(404, 'not_found', 'Snímek neexistuje.');
    return new Response(new Uint8Array(row.image), {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
    });
  }

  if ((m = path.match(/^\/api\/vods\/(\d+)\/rescan$/)) && method === 'POST') {
    const id = Number(m[1]);
    await db.prepare(`UPDATE vods SET scan_status = 'pending', scanned_at = NULL WHERE id = ?`).bind(id).run();
    await logActivity(db, actor, 'vod.rescan', 'vod', id);
    return json({ ok: true });
  }

  // --- schedule (our matches) ------------------------------------------------
  if (path === '/api/schedule') {
    if (method === 'GET') {
      const teamId = url.searchParams.get('team_id');
      const kind = url.searchParams.get('kind') ?? undefined;
      return json({ matches: await listSchedule(env, { teamId: teamId ? Number(teamId) : undefined, kind }) });
    }
    if (method === 'POST') {
      const fields = await scheduleFields(db, await readBody(req), false);
      requireOpponent(fields);
      const id = await insert(db, 'schedule', { ...fields, created_by_kind: 'user', created_by: user.id });
      const [m] = await listSchedule(env, { id });
      await logActivity(db, actor, 'schedule.create', 'schedule', id, { name: opponentLabel(m), kind: m.kind });
      return json({ id }, 201);
    }
  }
  if ((m = path.match(/^\/api\/schedule\/(\d+)$/))) {
    const id = Number(m[1]);
    const [current] = await listSchedule(env, { id });
    if (!current) throw new HttpError(404, 'not_found', 'Zápas neexistuje.');
    if (method === 'PUT') {
      const fields = await scheduleFields(db, await readBody(req), true);
      requireOpponent({ ...current, ...fields });
      await update(db, 'schedule', id, fields);
      await logActivity(db, actor, 'schedule.update', 'schedule', id, { name: opponentLabel(current), kind: current.kind });
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM schedule WHERE id = ?').bind(id).run();
      await logActivity(db, actor, 'schedule.delete', 'schedule', id, { name: opponentLabel(current), kind: current.kind });
      return json({ ok: true });
    }
  }

  // --- coaching --------------------------------------------------------------
  if (path === '/api/runes' && method === 'GET') {
    try {
      return json(await getRuneData(env), 200, { 'Cache-Control': 'private, max-age=3600' });
    } catch {
      throw new HttpError(502, 'ddragon_unavailable', 'Seznam run teď není dostupný.');
    }
  }
  if (path === '/api/coaching' && method === 'GET') return json(await loadCoaching(env));
  if (path === '/api/coaching/folders' && method === 'POST') {
    return json({ id: await createFolder(env, actor, await readBody(req)) }, 201);
  }
  if ((m = path.match(/^\/api\/coaching\/folders\/(\d+)$/))) {
    if (method === 'PUT') return (await renameFolder(env, Number(m[1]), await readBody(req)), json({ ok: true }));
    if (method === 'DELETE') return (await deleteFolder(env, Number(m[1])), json({ ok: true }));
  }
  if (path === '/api/coaching/runes' && method === 'POST') {
    return json({ id: await saveRunePage(env, actor, await readBody(req)) }, 201);
  }
  if ((m = path.match(/^\/api\/coaching\/runes\/(\d+)$/))) {
    if (method === 'PUT') return json({ id: await saveRunePage(env, actor, await readBody(req), Number(m[1])) });
    if (method === 'DELETE') return (await deleteRunePage(env, Number(m[1])), json({ ok: true }));
  }
  if (path === '/api/coaching/notes' && method === 'POST') {
    return json({ id: await saveNote(env, actor, await readBody(req)) }, 201);
  }
  if ((m = path.match(/^\/api\/coaching\/notes\/(\d+)$/))) {
    if (method === 'PUT') return json({ id: await saveNote(env, actor, await readBody(req), Number(m[1])) });
    if (method === 'DELETE') return (await deleteNote(env, Number(m[1])), json({ ok: true }));
  }

  // --- notes -------------------------------------------------------------
  if (path === '/api/notes' && method === 'POST') {
    const body = await readBody(req);
    const type = String(body.target_type);
    if (!['team', 'player', 'match'].includes(type)) throw new HttpError(400, 'invalid', 'Neplatný cíl poznámky.');
    const targetId = Number(body.target_id);
    const text = str(body.body, 'Poznámka', 5000);
    if (!text || !Number.isInteger(targetId)) throw new HttpError(400, 'invalid', 'Poznámka je prázdná.');
    const res = await db
      .prepare(`INSERT INTO notes (target_type, target_id, body, author_kind, author_user_id) VALUES (?, ?, ?, 'user', ?)`)
      .bind(type, targetId, text, user.id)
      .run();
    await logActivity(db, actor, 'note.add', type, targetId);
    return json({ id: res.meta.last_row_id }, 201);
  }
  if ((m = path.match(/^\/api\/notes\/(\d+)$/)) && method === 'DELETE') {
    await db.prepare('DELETE FROM notes WHERE id = ?').bind(Number(m[1])).run();
    return json({ ok: true });
  }

  // --- activity ----------------------------------------------------------
  if (path === '/api/activity' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT a.*, u.display_name AS actor_name FROM activity_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
          ORDER BY a.id DESC LIMIT 50`,
      )
      .all();
    return json({ activity: results });
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}

// --- helpers ---------------------------------------------------------------

function requireAdmin(user: User): void {
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Jen pro admina.');
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, 'invalid_json', 'Neplatný JSON.');
}

type Row = Record<string, string | number | null>;

/** Trimmed string or null; throws if too long. */
function str(v: unknown, label: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, 'invalid', `${label}: max ${max} znaků.`);
  return s || null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).toUpperCase() as T;
  if (!allowed.includes(s)) throw new HttpError(400, 'invalid', `${label}: neplatná hodnota.`);
  return s;
}

/** Accepts "name", "@name" or a full channel URL and returns the bare channel name. */
function normalizeChannel(v: unknown, host: string): string | null {
  const s = str(v, 'Kanál', 200);
  if (!s) return null;
  let name = s.replace(/^@/, '');
  const i = name.toLowerCase().indexOf(host);
  if (i >= 0) name = name.slice(i + host.length).replace(/^\/+/, '').split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_.-]{1,50}$/.test(name)) throw new HttpError(400, 'invalid', `Neplatný kanál: ${s}`);
  return name.toLowerCase();
}

export function teamFields(body: Record<string, unknown>, partial: boolean): Row {
  const out: Row = {};
  const has = (k: string) => !partial || k in body;
  if (has('name')) {
    const name = str(body.name, 'Název', 80);
    if (!name) throw new HttpError(400, 'invalid', 'Název týmu je povinný.');
    out.name = name;
  }
  if (has('tag')) out.tag = str(body.tag, 'Tag', 10);
  if (has('logo_url')) {
    const u = str(body.logo_url, 'Logo URL', 500);
    if (u && !/^https:\/\//i.test(u)) throw new HttpError(400, 'invalid', 'Logo URL musí začínat https://');
    out.logo_url = u;
  }
  if (has('accent_color')) {
    const c = str(body.accent_color, 'Barva', 7);
    if (c && !/^#[0-9a-f]{6}$/i.test(c)) throw new HttpError(400, 'invalid', 'Barva musí být ve tvaru #rrggbb.');
    out.accent_color = c;
  }
  if (has('is_own_team')) out.is_own_team = body.is_own_team ? 1 : 0;
  if (has('tournament')) out.tournament = str(body.tournament, 'Turnaj', 100);
  if (has('region')) out.region = oneOf(body.region, REGIONS, 'Region') ?? 'EUNE';
  if (has('notes')) out.notes = str(body.notes, 'Poznámky', 5000);
  return out;
}

export function playerFields(body: Record<string, unknown>, partial: boolean): Row {
  const out: Row = {};
  const has = (k: string) => !partial || k in body;
  if (has('nickname')) {
    const n = str(body.nickname, 'Přezdívka', 60);
    if (!n) throw new HttpError(400, 'invalid', 'Přezdívka je povinná.');
    out.nickname = n;
  }
  if (has('role')) out.role = oneOf(body.role, ROLES, 'Role');
  if (has('riot_id')) {
    const r = str(body.riot_id, 'Riot ID', 60);
    if (r) {
      const [name, tag] = r.split('#');
      if (!name?.trim() || !tag?.trim()) throw new HttpError(400, 'invalid', 'Riot ID musí být ve tvaru Jméno#TAG.');
      out.riot_game_name = name.trim();
      out.riot_tag_line = tag.trim();
    } else {
      out.riot_game_name = null;
      out.riot_tag_line = null;
    }
    out.riot_puuid = null; // re-resolved on the next Riot sync
  }
  if ('region' in body) out.region = oneOf(body.region, REGIONS, 'Region') ?? 'EUNE';
  if (has('twitch_login')) out.twitch_login = normalizeChannel(body.twitch_login, 'twitch.tv');
  if (has('kick_slug')) out.kick_slug = normalizeChannel(body.kick_slug, 'kick.com');
  if (has('tags')) {
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(',');
    out.tags = JSON.stringify(
      tags
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((t) => t.slice(0, 40)),
    );
  }
  if (has('notes')) out.notes = str(body.notes, 'Poznámky', 5000);
  return out;
}

export function parsePlayer(p: Record<string, unknown>) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(String(p.tags ?? '[]'));
  } catch {}
  const riot_id = p.riot_game_name && p.riot_tag_line ? `${p.riot_game_name}#${p.riot_tag_line}` : null;
  return { ...p, tags, riot_id };
}

// Table/column names below come from our own code, never from user input.
export async function insert(db: D1Database, table: string, row: Row): Promise<number> {
  const cols = Object.keys(row);
  const res = await db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return res.meta.last_row_id;
}

export async function update(db: D1Database, table: string, id: number, row: Row): Promise<void> {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const res = await db
    .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...cols.map((c) => row[c]), id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found', 'Záznam neexistuje.');
}
