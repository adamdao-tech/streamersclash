import type { Env } from './index';
import { isSuperadmin, type User } from './db';
import { HttpError, json } from './http';

// Plán koučování: the coach's private strategic plan. Only superadmins (Dao) see it –
// the page, the API and the MCP tools all check isSuperadmin.
// Tabs ("Draft", "Makro", "Lajny"…) each have a goal; items inside are ticked off when the
// team has learned them, with a short note, so finished topics don't come back.

type Body = Record<string, unknown>;
type Row = Record<string, string | number | null>;

export const PRIORITY_LABELS: Record<number, string> = { 1: 'vysoká', 2: 'normální', 3: 'nízká' };

export function requireSuperadmin(env: Env, user: User): void {
  if (!isSuperadmin(env, user)) throw new HttpError(403, 'forbidden', 'Plán koučování vidí jen superadmin.');
}

function str(v: unknown, label: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, 'invalid', `${label}: max ${max} znaků.`);
  return s || null;
}

function date(v: unknown, label: string): string | null {
  const s = str(v, label, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'invalid', `${label}: datum ve tvaru RRRR-MM-DD.`);
  return s;
}

function id(v: unknown, label = 'ID'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'invalid', `Neplatné ${label}.`);
  return n;
}

async function ownPlayer(db: D1Database, v: unknown): Promise<number | null> {
  if (v === undefined || v === null || v === '') return null;
  const pid = id(v, 'player_id');
  const ok = await db
    .prepare('SELECT 1 FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = ? AND t.is_own_team = 1')
    .bind(pid)
    .first();
  if (!ok) throw new HttpError(400, 'invalid', 'Hráč není z našeho týmu.');
  return pid;
}

/** The whole plan in one go – it's small. */
export async function loadPlan(env: Env) {
  const db = env.DB;
  const [tabs, items, players] = await Promise.all([
    db.prepare('SELECT * FROM coach_plan_tabs ORDER BY archived, sort, id').all(),
    db
      .prepare(
        `SELECT i.*, p.nickname AS player_name, p.role AS player_role FROM coach_plan_items i
           LEFT JOIN players p ON p.id = i.player_id
          ORDER BY i.tab_id, i.done_at IS NOT NULL, i.sort, i.id`,
      )
      .all(),
    db
      .prepare(
        `SELECT p.id, p.nickname, p.role FROM players p JOIN teams t ON t.id = p.team_id WHERE t.is_own_team = 1
          ORDER BY CASE p.role WHEN 'TOP' THEN 1 WHEN 'JUNGLE' THEN 2 WHEN 'MID' THEN 3
                               WHEN 'ADC' THEN 4 WHEN 'SUPPORT' THEN 5 ELSE 6 END, p.nickname COLLATE NOCASE`,
      )
      .all(),
  ]);
  return { tabs: tabs.results, items: items.results, players: players.results };
}

async function tabFields(b: Body, partial: boolean): Promise<Row> {
  const row: Row = {};
  if (!partial || 'name' in b) {
    const name = str(b.name, 'Název', 60);
    if (!name) throw new HttpError(400, 'invalid', 'Zadej název oblasti.');
    row.name = name;
  }
  if ('goal' in b) row.goal = str(b.goal, 'Cíl', 2000);
  if ('deadline' in b) row.deadline = date(b.deadline, 'Termín');
  if ('archived' in b) row.archived = b.archived ? 1 : 0;
  return row;
}

async function itemFields(db: D1Database, b: Body, partial: boolean): Promise<Row> {
  const row: Row = {};
  if (!partial || 'title' in b) {
    const title = str(b.title, 'Úkol', 200);
    if (!title) throw new HttpError(400, 'invalid', 'Zadej, co se má tým naučit.');
    row.title = title;
  }
  if ('details' in b) row.details = str(b.details, 'Detail', 4000);
  if ('player_id' in b) row.player_id = await ownPlayer(db, b.player_id);
  if ('priority' in b) {
    const p = Number(b.priority);
    if (![1, 2, 3].includes(p)) throw new HttpError(400, 'invalid', 'Priorita je 1 (vysoká), 2 nebo 3 (nízká).');
    row.priority = p;
  }
  if ('focus' in b) row.focus = b.focus ? 1 : 0;
  if ('due_date' in b) row.due_date = date(b.due_date, 'Termín');
  if ('done_note' in b) row.done_note = str(b.done_note, 'Poznámka', 2000);
  if ('done' in b) row.done_at = b.done ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null;
  // A finished item is no longer the current focus.
  if (b.done) row.focus = 0;
  return row;
}

async function insert(db: D1Database, table: string, row: Row): Promise<number> {
  const cols = Object.keys(row);
  const res = await db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return res.meta.last_row_id;
}

async function update(db: D1Database, table: string, rowId: number, row: Row): Promise<void> {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const res = await db
    .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...cols.map((c) => row[c]), rowId)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found', 'Záznam neexistuje.');
}

export async function createTab(env: Env, b: Body): Promise<number> {
  const row = await tabFields(b, false);
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM coach_plan_tabs').first<{ s: number }>();
  return insert(env.DB, 'coach_plan_tabs', { ...row, sort: (max?.s ?? 0) + 1 });
}

export async function updateTab(env: Env, tabId: number, b: Body): Promise<void> {
  await update(env.DB, 'coach_plan_tabs', tabId, await tabFields(b, true));
}

export async function createItem(env: Env, b: Body, kind: 'user' | 'claude' = 'user'): Promise<number> {
  const tabId = id(b.tab_id, 'tab_id');
  const tab = await env.DB.prepare('SELECT 1 FROM coach_plan_tabs WHERE id = ?').bind(tabId).first();
  if (!tab) throw new HttpError(404, 'not_found', 'Oblast neexistuje.');
  const row = await itemFields(env.DB, b, false);
  const max = await env.DB
    .prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM coach_plan_items WHERE tab_id = ?')
    .bind(tabId)
    .first<{ s: number }>();
  return insert(env.DB, 'coach_plan_items', { ...row, tab_id: tabId, sort: (max?.s ?? 0) + 1, created_by_kind: kind });
}

export async function updateItem(env: Env, itemId: number, b: Body): Promise<void> {
  const row = await itemFields(env.DB, b, true);
  if ('tab_id' in b) {
    const tabId = id(b.tab_id, 'tab_id');
    if (!(await env.DB.prepare('SELECT 1 FROM coach_plan_tabs WHERE id = ?').bind(tabId).first())) {
      throw new HttpError(404, 'not_found', 'Oblast neexistuje.');
    }
    row.tab_id = tabId;
  }
  await update(env.DB, 'coach_plan_items', itemId, row);
}

/** Saves a new order: ids in the order they should appear. */
async function reorder(db: D1Database, table: string, ids: unknown, where = '', bind: number[] = []): Promise<void> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new HttpError(400, 'invalid', 'Pošli seznam ID.');
  await db.batch(
    ids.map((v, i) => db.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?${where}`).bind(i + 1, id(v), ...bind)),
  );
}

/** /api/plan… – returns null when the path isn't ours. */
export async function handlePlanApi(
  req: Request,
  env: Env,
  path: string,
  method: string,
  user: User,
  readBody: (req: Request) => Promise<Body>,
): Promise<Response | null> {
  if (!path.startsWith('/api/plan')) return null;
  requireSuperadmin(env, user);
  const db = env.DB;
  let m: RegExpMatchArray | null;

  if (path === '/api/plan' && method === 'GET') return json(await loadPlan(env));

  if (path === '/api/plan/tabs' && method === 'POST') return json({ id: await createTab(env, await readBody(req)) }, 201);
  if (path === '/api/plan/tabs/order' && method === 'PUT') {
    await reorder(db, 'coach_plan_tabs', (await readBody(req)).ids);
    return json({ ok: true });
  }
  if ((m = path.match(/^\/api\/plan\/tabs\/(\d+)$/))) {
    const tabId = Number(m[1]);
    if (method === 'PATCH') {
      await updateTab(env, tabId, await readBody(req));
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM coach_plan_items WHERE tab_id = ?').bind(tabId).run();
      await db.prepare('DELETE FROM coach_plan_tabs WHERE id = ?').bind(tabId).run();
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/api\/plan\/tabs\/(\d+)\/order$/)) && method === 'PUT') {
    const tabId = Number(m[1]);
    await reorder(db, 'coach_plan_items', (await readBody(req)).ids, ' AND tab_id = ?', [tabId]);
    return json({ ok: true });
  }

  if (path === '/api/plan/items' && method === 'POST') return json({ id: await createItem(env, await readBody(req)) }, 201);
  if ((m = path.match(/^\/api\/plan\/items\/(\d+)$/))) {
    const itemId = Number(m[1]);
    if (method === 'PATCH') {
      await updateItem(env, itemId, await readBody(req));
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM coach_plan_items WHERE id = ?').bind(itemId).run();
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}
