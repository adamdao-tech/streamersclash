import type { Env } from './index';
import { getChampions, resolveChampion } from './champions';
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
  const [players, folders, runes, notes] = await Promise.all([
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
  ]);
  return { players: players.results, folders: folders.results, runes: runes.results, notes: notes.results };
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
