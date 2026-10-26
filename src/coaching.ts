import type { Env } from './index';
import { getChampions, resolveChampion } from './champions';
import { playerGames, summarizeGames } from './drafts';
import { logActivity } from './db';
import { HttpError } from './http';
import { cleanRunePage, getRuneData } from './runes';

// Coaching: for the whole team (player_id NULL) or for one player, optionally inside a
// folder the coach names freely ("Supp – tank", "Supp – heal", "Lane fáze"…).
// Each place holds rune pages and notes.

export type Actor = { kind: 'user' | 'claude'; userId: number };

type Body = Record<string, unknown>;

function str(v: unknown, label: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, 'invalid', `${label}: max ${max} znaků.`);
  return s || null;
}

const optId = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'invalid', 'Neplatné ID.');
  return n;
};

/** Everything on the coaching page in one go – the data set is small. */
export async function loadCoaching(env: Env) {
  const db = env.DB;
  const [players, folders, runes, notes, maps, shots, pool] = await Promise.all([
    db.prepare(
      `SELECT p.id, p.nickname, p.role FROM players p JOIN teams t ON t.id = p.team_id
        WHERE t.is_own_team = 1
        ORDER BY CASE p.role WHEN 'TOP' THEN 1 WHEN 'JUNGLE' THEN 2 WHEN 'MID' THEN 3
                             WHEN 'ADC' THEN 4 WHEN 'SUPPORT' THEN 5 ELSE 6 END, p.nickname COLLATE NOCASE`,
    ).all(),
    db.prepare('SELECT * FROM coaching_folders ORDER BY sort, name COLLATE NOCASE').all(),
    db.prepare('SELECT * FROM coaching_runes ORDER BY updated_at DESC').all(),
    db.prepare(
      `SELECT n.*, u.display_name AS author_name FROM coaching_notes n LEFT JOIN users u ON u.id = n.author_user_id
        ORDER BY n.pinned DESC, n.updated_at DESC`,
    ).all(),
    db.prepare('SELECT * FROM coaching_maps ORDER BY updated_at DESC').all(),
    // Everything but the picture itself, which is loaded per image.
    db.prepare(
      `SELECT s.id, s.player_id, s.folder_id, s.title, s.notes, s.mime, s.width, s.height, s.size, s.created_by_kind,
              s.created_at, s.updated_at, u.display_name AS author_name
         FROM coaching_shots s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC`,
    ).all(),
    db.prepare('SELECT player_id, champion, tier, note, sort FROM champion_pool ORDER BY player_id, sort').all(),
  ]);
  // Per champion games and winrate from recorded drafts, shown next to the tier list.
  const poolStats: Record<number, unknown> = {};
  await Promise.all(
    (players.results as { id: number }[]).map(async (p) => {
      poolStats[p.id] = summarizeGames(await playerGames(env, p.id)).champions;
    }),
  );
  return {
    players: players.results, folders: folders.results, runes: runes.results, notes: notes.results, maps: maps.results, shots: shots.results,
    pool: pool.results, pool_stats: poolStats,
  };
}

/** Works out where an item lives. A folder decides the player; otherwise player_id (or none = whole team). */
async function resolvePlace(db: D1Database, body: Body): Promise<{ player_id: number | null; folder_id: number | null }> {
  const folderId = optId(body.folder_id);
  if (folderId) {
    const f = await db.prepare('SELECT player_id FROM coaching_folders WHERE id = ?').bind(folderId).first<{ player_id: number | null }>();
    if (!f) throw new HttpError(400, 'invalid', 'Složka neexistuje.');
    return { player_id: f.player_id, folder_id: folderId };
  }
  const playerId = optId(body.player_id);
  if (playerId && !(await db.prepare('SELECT 1 FROM players WHERE id = ?').bind(playerId).first())) {
    throw new HttpError(400, 'invalid', 'Hráč neexistuje.');
  }
  return { player_id: playerId, folder_id: null };
}

const placeName = async (db: D1Database, playerId: number | null) =>
  playerId ? (await db.prepare('SELECT nickname FROM players WHERE id = ?').bind(playerId).first<{ nickname: string }>())?.nickname ?? '?' : 'Tým';

// --- folders ---------------------------------------------------------------

export async function createFolder(env: Env, actor: Actor, body: Body): Promise<number> {
  const name = str(body.name, 'Název složky', 60);
  if (!name) throw new HttpError(400, 'invalid', 'Zadej název složky.');
  const { player_id } = await resolvePlace(env.DB, { player_id: body.player_id });
  const res = await env.DB.prepare('INSERT INTO coaching_folders (player_id, name) VALUES (?, ?)').bind(player_id, name).run();
  const id = res.meta.last_row_id;
  await logActivity(env.DB, actor, 'coaching.folder', 'coaching_folder', id, { name: `${await placeName(env.DB, player_id)} / ${name}` });
  return id;
}

export async function renameFolder(env: Env, id: number, body: Body): Promise<void> {
  const name = str(body.name, 'Název složky', 60);
  if (!name) throw new HttpError(400, 'invalid', 'Zadej název složky.');
  const res = await env.DB.prepare('UPDATE coaching_folders SET name = ? WHERE id = ?').bind(name, id).run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found', 'Složka neexistuje.');
}

export async function deleteFolder(env: Env, id: number): Promise<void> {
  // Explicit deletes so nothing is left behind even without foreign-key enforcement.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM coaching_runes WHERE folder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM coaching_notes WHERE folder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM coaching_maps WHERE folder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM coaching_shots WHERE folder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM coaching_folders WHERE id = ?').bind(id),
  ]);
}

// --- rune pages ---------------------------------------------------------------

export async function saveRunePage(env: Env, actor: Actor, body: Body, id?: number): Promise<number> {
  const db = env.DB;
  const existing = id ? await db.prepare('SELECT * FROM coaching_runes WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
  if (id && !existing) throw new HttpError(404, 'not_found', 'Runová stránka neexistuje.');
  // For updates, fields that weren't sent keep their old values.
  const has = (k: string) => k in body;
  const pick = (k: string, parse = false) => (has(k) ? body[k] : existing ? (parse ? JSON.parse(String(existing[k])) : existing[k]) : undefined);

  const place = has('folder_id') || has('player_id') || !existing
    ? await resolvePlace(db, body)
    : { player_id: existing.player_id as number | null, folder_id: existing.folder_id as number | null };

  const title = str(pick('title'), 'Název', 80);
  let champion = str(pick('champion'), 'Champion', 40);
  if (champion && (!existing || has('champion'))) {
    // If Data Dragon is down, keep the name as typed rather than blocking the save.
    const champions = await getChampions(env).catch(() => []);
    const resolved = resolveChampion(champions, champion);
    if (resolved) champion = resolved;
    else if (champions.length) {
      throw new HttpError(400, 'invalid', `„${champion}“ není champion. Název stránky patří do pole Název, champion je nepovinný.`);
    }
  }
  if (!title && !champion) throw new HttpError(400, 'invalid', 'Zadej název stránky, např. Supp – tank.');

  const page = cleanRunePage(await getRuneData(env), {
    primary_style: pick('primary_style'),
    secondary_style: pick('secondary_style'),
    perks: pick('perks', true),
    shards: pick('shards', true),
    summoners: pick('summoners', true),
  });
  const notes = str(pick('notes'), 'Poznámka', 5000);

  const values = [
    place.player_id, place.folder_id, title, champion, page.primary_style, page.secondary_style,
    JSON.stringify(page.perks), JSON.stringify(page.shards), JSON.stringify(page.summoners), notes,
  ];
  let outId = id ?? 0;
  if (existing) {
    await db.prepare(
      `UPDATE coaching_runes SET player_id = ?, folder_id = ?, title = ?, champion = ?, primary_style = ?, secondary_style = ?,
              perks = ?, shards = ?, summoners = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(...values, id).run();
  } else {
    const res = await db.prepare(
      `INSERT INTO coaching_runes (player_id, folder_id, title, champion, primary_style, secondary_style, perks, shards, summoners, notes, created_by_kind, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...values, actor.kind, actor.userId).run();
    outId = res.meta.last_row_id;
  }
  await logActivity(db, actor, existing ? 'coaching.runes.update' : 'coaching.runes.create', 'coaching_runes', outId, {
    name: `${await placeName(db, place.player_id)} – ${champion || title}`,
  });
  return outId;
}

export async function deleteRunePage(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM coaching_runes WHERE id = ?').bind(id).run();
}

// --- notes ---------------------------------------------------------------------

export async function saveNote(env: Env, actor: Actor, body: Body, id?: number): Promise<number> {
  const db = env.DB;
  const existing = id ? await db.prepare('SELECT * FROM coaching_notes WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
  if (id && !existing) throw new HttpError(404, 'not_found', 'Zápisek neexistuje.');
  const has = (k: string) => k in body;
  const pick = (k: string) => (has(k) ? body[k] : existing?.[k]);

  const place = has('folder_id') || has('player_id') || !existing
    ? await resolvePlace(db, body)
    : { player_id: existing.player_id as number | null, folder_id: existing.folder_id as number | null };
  const title = str(pick('title'), 'Nadpis', 120);
  const text = str(pick('body'), 'Zápisek', 20000);
  if (!text) throw new HttpError(400, 'invalid', 'Zápisek je prázdný.');
  const pinned = pick('pinned') ? 1 : 0;

  let outId = id ?? 0;
  if (existing) {
    await db.prepare(
      `UPDATE coaching_notes SET player_id = ?, folder_id = ?, title = ?, body = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(place.player_id, place.folder_id, title, text, pinned, id).run();
  } else {
    const res = await db.prepare(
      `INSERT INTO coaching_notes (player_id, folder_id, title, body, pinned, author_kind, author_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(place.player_id, place.folder_id, title, text, pinned, actor.kind, actor.userId).run();
    outId = res.meta.last_row_id;
  }
  await logActivity(db, actor, existing ? 'coaching.note.update' : 'coaching.note.create', 'coaching_note', outId, {
    name: `${await placeName(db, place.player_id)}${title ? ` – ${title}` : ''}`,
  });
  return outId;
}

export async function deleteNote(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM coaching_notes WHERE id = ?').bind(id).run();
}

// --- ward maps -------------------------------------------------------------------
// Markers sit on the Summoner's Rift minimap; x and y are 0–100 % from the top-left corner.

export const MARKER_TYPES = ['ward', 'control', 'farsight', 'sweep', 'note'] as const;

export function cleanMarkers(v: unknown) {
  if (!Array.isArray(v)) throw new HttpError(400, 'invalid', 'Značky musí být seznam.');
  if (v.length > 150) throw new HttpError(400, 'invalid', 'Na mapě může být nejvýš 150 značek.');
  return v.map((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const type = String(o.type);
    if (!(MARKER_TYPES as readonly string[]).includes(type)) throw new HttpError(400, 'invalid', `Neznámý typ značky: ${type}`);
    const coord = (c: unknown) => {
      const n = Number(c);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'invalid', 'Značka je mimo mapu.');
      return Math.round(n * 10) / 10;
    };
    const label = str(o.label, 'Popisek značky', 60);
    return { type, x: coord(o.x), y: coord(o.y), ...(label ? { label } : {}) };
  });
}

export async function saveMap(env: Env, actor: Actor, body: Body, id?: number): Promise<number> {
  const db = env.DB;
  const existing = id ? await db.prepare('SELECT * FROM coaching_maps WHERE id = ?').bind(id).first<Record<string, unknown>>() : null;
  if (id && !existing) throw new HttpError(404, 'not_found', 'Mapa neexistuje.');
  const has = (k: string) => k in body;
  const place = has('folder_id') || has('player_id') || !existing
    ? await resolvePlace(db, body)
    : { player_id: existing.player_id as number | null, folder_id: existing.folder_id as number | null };
  const title = str(has('title') ? body.title : existing?.title, 'Název', 80);
  if (!title) throw new HttpError(400, 'invalid', 'Zadej název mapy, např. Wardy před drakem.');
  const sideIn = has('side') ? body.side : existing?.side;
  const side = sideIn ? String(sideIn).toUpperCase() : null;
  if (side && side !== 'BLUE' && side !== 'RED') throw new HttpError(400, 'invalid', 'Strana musí být BLUE nebo RED.');
  const markers = JSON.stringify(has('markers') ? cleanMarkers(body.markers) : JSON.parse(String(existing?.markers ?? '[]')));
  const notes = str(has('notes') ? body.notes : existing?.notes, 'Poznámka', 5000);

  let outId = id ?? 0;
  if (existing) {
    await db.prepare(
      `UPDATE coaching_maps SET player_id = ?, folder_id = ?, title = ?, side = ?, markers = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(place.player_id, place.folder_id, title, side, markers, notes, id).run();
  } else {
    const res = await db.prepare(
      `INSERT INTO coaching_maps (player_id, folder_id, title, side, markers, notes, created_by_kind, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(place.player_id, place.folder_id, title, side, markers, notes, actor.kind, actor.userId).run();
    outId = res.meta.last_row_id;
  }
  await logActivity(db, actor, existing ? 'coaching.map.update' : 'coaching.map.create', 'coaching_map', outId, {
    name: `${await placeName(db, place.player_id)} – ${title}`,
  });
  return outId;
}

export async function deleteMap(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM coaching_maps WHERE id = ?').bind(id).run();
}

// --- own map picture -----------------------------------------------------------------------

const MAP_KEY = 'map';
const MAX_IMAGE = 1_900_000; // D1 keeps a value up to ~2 MB; the browser shrinks the picture before upload.

/** When the own map picture last changed (used to bust caches), or null if none is uploaded. */
export async function mapVersion(env: Env): Promise<string | null> {
  const row = await env.DB.prepare('SELECT updated_at FROM app_assets WHERE key = ?').bind(MAP_KEY).first<{ updated_at: string }>();
  return row?.updated_at ?? null;
}

export async function getMapImage(env: Env): Promise<Response | null> {
  const row = await env.DB.prepare('SELECT mime, data FROM app_assets WHERE key = ?').bind(MAP_KEY).first<{ mime: string; data: number[] }>();
  if (!row) return null;
  return new Response(new Uint8Array(row.data), {
    // The URL carries the version, so the picture can be cached for long.
    headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}

/** Decodes an uploaded image (base64 in JSON) and checks its type and size. */
function decodeImage(body: Body): { mime: string; bytes: Uint8Array } {
  const mime = String(body.mime ?? '');
  if (!['image/webp', 'image/jpeg', 'image/png'].includes(mime)) throw new HttpError(400, 'invalid', 'Obrázek musí být WebP, JPEG nebo PNG.');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(String(body.data ?? '')), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError(400, 'invalid', 'Obrázek se nepodařilo přečíst.');
  }
  if (!bytes.length) throw new HttpError(400, 'invalid', 'Obrázek je prázdný.');
  if (bytes.length > MAX_IMAGE) throw new HttpError(400, 'invalid', 'Obrázek je moc velký (max ~1,9 MB).');
  return { mime, bytes };
}

export async function setMapImage(env: Env, actor: Actor, body: Body): Promise<void> {
  const { mime, bytes } = decodeImage(body);
  await env.DB.prepare(
    `INSERT INTO app_assets (key, mime, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(MAP_KEY, mime, bytes).run();
  await logActivity(env.DB, actor, 'coaching.mapimage', null, null, { name: 'obrázek mapy' });
}

export async function resetMapImage(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM app_assets WHERE key = ?').bind(MAP_KEY).run();
}

// --- screenshots -----------------------------------------------------------------------------

export async function createShot(env: Env, actor: Actor, body: Body): Promise<number> {
  const { mime, bytes } = decodeImage(body);
  const place = await resolvePlace(env.DB, body);
  const title = str(body.title, 'Nadpis', 120);
  const notes = str(body.notes, 'Poznámka', 5000);
  const dim = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 20000 ? Number(v) : null);
  const res = await env.DB.prepare(
    `INSERT INTO coaching_shots (player_id, folder_id, title, notes, mime, width, height, size, data, created_by_kind, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(place.player_id, place.folder_id, title, notes, mime, dim(body.width), dim(body.height), bytes.length, bytes, actor.kind, actor.userId).run();
  const id = res.meta.last_row_id;
  await logActivity(env.DB, actor, 'coaching.shot.create', 'coaching_shot', id, {
    name: `${await placeName(env.DB, place.player_id)}${title ? ` – ${title}` : ''}`,
  });
  return id;
}

export async function updateShot(env: Env, id: number, body: Body): Promise<void> {
  const existing = await env.DB.prepare('SELECT player_id, folder_id, title, notes FROM coaching_shots WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!existing) throw new HttpError(404, 'not_found', 'Screenshot neexistuje.');
  const has = (k: string) => k in body;
  const place = has('folder_id') || has('player_id')
    ? await resolvePlace(env.DB, body)
    : { player_id: existing.player_id as number | null, folder_id: existing.folder_id as number | null };
  await env.DB.prepare(
    `UPDATE coaching_shots SET player_id = ?, folder_id = ?, title = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(
    place.player_id, place.folder_id,
    str(has('title') ? body.title : existing.title, 'Nadpis', 120),
    str(has('notes') ? body.notes : existing.notes, 'Poznámka', 5000),
    id,
  ).run();
}

export async function deleteShot(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM coaching_shots WHERE id = ?').bind(id).run();
}

export async function getShotImage(env: Env, id: number): Promise<{ mime: string; data: Uint8Array } | null> {
  const row = await env.DB.prepare('SELECT mime, data FROM coaching_shots WHERE id = ?').bind(id).first<{ mime: string; data: number[] }>();
  return row ? { mime: row.mime, data: new Uint8Array(row.data) } : null;
}

// --- champion pool (tier list per player) ---------------------------------------------------

export const TIERS = ['S', 'A', 'B', 'C', 'L'] as const; // L = learning (Učí se)
export const TIER_LABELS: Record<string, string> = { S: 'S – main', A: 'A – silný', B: 'B – hratelný', C: 'C – nouzově', L: 'Učí se' };

/**
 * Replaces a player's whole champion pool (the page sends the list after every drag).
 * items: [{ champion, tier, note? }] in display order.
 */
export async function savePool(env: Env, actor: Actor, playerId: number, items: unknown): Promise<void> {
  if (!(await env.DB.prepare('SELECT 1 FROM players WHERE id = ?').bind(playerId).first())) throw new HttpError(404, 'not_found', 'Hráč neexistuje.');
  if (!Array.isArray(items)) throw new HttpError(400, 'invalid', 'Seznam championů chybí.');
  if (items.length > 170) throw new HttpError(400, 'invalid', 'Moc championů.');
  const champions = await getChampions(env).catch(() => []);
  const seen = new Set<string>();
  const rows = items.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const tier = String(o.tier ?? '').toUpperCase();
    if (!(TIERS as readonly string[]).includes(tier)) throw new HttpError(400, 'invalid', `Neznámý tier: ${o.tier}`);
    const raw = str(o.champion, 'Champion', 40);
    if (!raw) throw new HttpError(400, 'invalid', 'Chybí champion.');
    const champion = resolveChampion(champions, raw) ?? (champions.length ? null : raw);
    if (!champion) throw new HttpError(400, 'invalid', `Neznámý champion: ${raw}`);
    if (seen.has(champion)) throw new HttpError(400, 'invalid', `${champion} je v poolu dvakrát.`);
    seen.add(champion);
    return { champion, tier, note: str(o.note, 'Poznámka', 300), sort: i };
  });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM champion_pool WHERE player_id = ?').bind(playerId),
    ...rows.map((r) =>
      env.DB.prepare('INSERT INTO champion_pool (player_id, champion, tier, note, sort) VALUES (?, ?, ?, ?, ?)').bind(playerId, r.champion, r.tier, r.note, r.sort),
    ),
  ]);
  await logActivity(env.DB, actor, 'coaching.pool', 'player', playerId, { name: await placeName(env.DB, playerId) });
}
