import type { Env } from './index';
import { logActivity, type User } from './db';
import { HttpError, json } from './http';
import { getChampions, resolveChampion } from './champions';

// Draft (page /drafty): drafts the admins prepare for different situations – 5 bans and 5 picks per side
// (with roles), which side is ours, the opponent and notes. Shared by all admins; Claude can make them via MCP.

export const BOARD_ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'] as const;
type Role = (typeof BOARD_ROLES)[number];
export interface BoardPick { champion: string | null; role: Role | null; note?: string | null }
export interface BoardSide { bans: (string | null)[]; picks: BoardPick[] }
export interface BoardData { blue: BoardSide; red: BoardSide }

type Body = Record<string, unknown>;

const s = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return t ? t.slice(0, max) : null;
};

/** Normalises board data: 5 bans and 5 picks per side, real champion names, a champion only once. */
export async function cleanBoardData(env: Env, raw: unknown): Promise<BoardData> {
  const champions = await getChampions(env).catch(() => null);
  const used = new Set<string>();
  const unknown: string[] = [];
  const champ = (v: unknown): string | null => {
    const t = s(v, 40);
    if (!t) return null;
    const c = champions ? resolveChampion(champions, t) : t;
    if (!c) { unknown.push(t); return null; }
    if (used.has(c)) throw new HttpError(400, 'duplicate_champion', `${c} je v draftu dvakrát.`);
    used.add(c);
    return c;
  };
  const side = (v: unknown): BoardSide => {
    const o = (v && typeof v === 'object' ? v : {}) as { bans?: unknown[]; picks?: unknown[] };
    const bans = Array.from({ length: 5 }, (_, i) => champ(Array.isArray(o.bans) ? o.bans[i] : null));
    const picks = Array.from({ length: 5 }, (_, i) => {
      const p = (Array.isArray(o.picks) ? o.picks[i] : null) as Body | string | null;
      const obj = typeof p === 'string' ? { champion: p } : (p ?? {});
      const role = BOARD_ROLES.find((r) => r === String(obj.role ?? '').toUpperCase()) ?? BOARD_ROLES[i];
      return { champion: champ(obj.champion), role, note: s(obj.note, 200) };
    });
    return { bans, picks };
  };
  const o = (raw && typeof raw === 'object' ? raw : {}) as { blue?: unknown; red?: unknown };
  const out = { blue: side(o.blue), red: side(o.red) };
  if (unknown.length) throw new HttpError(400, 'unknown_champion', `Neznámí championi: ${unknown.join(', ')}`);
  return out;
}

export async function listBoards(env: Env, folder?: string | null) {
  const { results } = await env.DB.prepare(
    `SELECT b.*, t.name AS opponent_name, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
       FROM draft_boards b LEFT JOIN teams t ON t.id = b.opponent_team_id
       LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users uu ON uu.id = b.updated_by
      ${folder ? 'WHERE b.folder = ?' : ''}
      ORDER BY b.folder IS NULL, b.folder COLLATE NOCASE, b.updated_at DESC`,
  ).bind(...(folder ? [folder] : [])).all<Record<string, unknown>>();
  return results.map((r) => ({ ...r, data: JSON.parse(String(r.data)) as BoardData }) as Record<string, unknown> & { data: BoardData });
}

async function fields(env: Env, b: Body, partial: boolean): Promise<Record<string, string | number | null>> {
  const out: Record<string, string | number | null> = {};
  const has = (k: string) => !partial || k in b;
  if (has('name')) {
    const name = s(b.name, 120);
    if (!name) throw new HttpError(400, 'invalid', 'Draft musí mít název.');
    out.name = name;
  }
  if (has('folder')) out.folder = s(b.folder, 80);
  if (has('our_side')) out.our_side = String(b.our_side ?? 'BLUE').toUpperCase() === 'RED' ? 'RED' : 'BLUE';
  if (has('opponent_team_id')) {
    const id = Number(b.opponent_team_id) || null;
    if (id && !(await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first())) throw new HttpError(404, 'not_found', 'Tým neexistuje.');
    out.opponent_team_id = id;
  }
  if (has('notes')) out.notes = s(b.notes, 10000);
  if (has('data')) out.data = JSON.stringify(await cleanBoardData(env, b.data));
  return out;
}

export async function createBoard(env: Env, user: User, b: Body, kind: 'user' | 'claude' = 'user'): Promise<number> {
  const f = await fields(env, b, false);
  const res = await env.DB.prepare(
    `INSERT INTO draft_boards (name, folder, our_side, opponent_team_id, data, notes, created_by, created_by_kind, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(f.name, f.folder, f.our_side, f.opponent_team_id, f.data, f.notes, user.id, kind, user.id).run();
  const id = res.meta.last_row_id;
  await logActivity(env.DB, { kind, userId: user.id }, 'draftboard.create', 'draft_board', id, { name: f.name });
  return id;
}

export async function updateBoard(env: Env, user: User, id: number, b: Body, kind: 'user' | 'claude' = 'user'): Promise<void> {
  const f = await fields(env, b, true);
  const cols = Object.keys(f);
  if (!cols.length) return;
  const res = await env.DB.prepare(
    `UPDATE draft_boards SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(...cols.map((c) => f[c]), user.id, id).run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found', 'Draft neexistuje.');
}

export async function handleDraftBoardsApi(
  req: Request, env: Env, path: string, method: string, user: User, readBody: (req: Request) => Promise<Body>,
): Promise<Response | null> {
  if (!path.startsWith('/api/draft-boards')) return null;
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Draft je jen pro adminy.');
  const db = env.DB;
  if (path === '/api/draft-boards' && method === 'GET') return json({ boards: await listBoards(env) });
  if (path === '/api/draft-boards' && method === 'POST') return json({ id: await createBoard(env, user, await readBody(req)) }, 201);
  const m = path.match(/^\/api\/draft-boards\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      await updateBoard(env, user, id, await readBody(req));
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const row = await db.prepare('SELECT name FROM draft_boards WHERE id = ?').bind(id).first<{ name: string }>();
      await db.prepare('DELETE FROM draft_boards WHERE id = ?').bind(id).run();
      if (row) await logActivity(db, { kind: 'user', userId: user.id }, 'draftboard.delete', 'draft_board', id, { name: row.name });
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}
