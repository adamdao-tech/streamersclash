import { MIGRATIONS } from './schema';

let schemaReady: Promise<void> | null = null;

/** Applies pending migrations once per Worker instance. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrate(db).catch((err) => {
      schemaReady = null; // retry on the next request
      throw err;
    });
  }
  return schemaReady;
}

async function migrate(db: D1Database): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = await db.prepare('SELECT MAX(version) AS v FROM schema_version').first<{ v: number | null }>();
  const current = row?.v ?? 0;

  for (let i = current; i < MIGRATIONS.length; i++) {
    const statements = MIGRATIONS[i]
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql));
    statements.push(db.prepare('INSERT INTO schema_version (version) VALUES (?)').bind(i + 1));
    // A batch runs as a single transaction, so a failed migration leaves no half-applied state.
    await db.batch(statements);
  }
}

export interface User {
  id: number;
  twitch_login: string;
  twitch_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: 'admin' | 'member';
}

/** Superadmins (SUPERADMINS var, Twitch logins) are the only ones who see the activity log, admins included. */
export function isSuperadmin(env: { SUPERADMINS?: string }, user: Pick<User, 'twitch_login'>): boolean {
  const logins = String(env.SUPERADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return logins.includes(String(user.twitch_login).toLowerCase());
}

export async function logActivity(
  db: D1Database,
  actor: { kind: 'user' | 'claude' | 'sync'; userId?: number | null },
  action: string,
  targetType: string | null,
  targetId: number | null,
  details?: unknown,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO activity_log (actor_kind, actor_user_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(actor.kind, actor.userId ?? null, action, targetType, targetId, details === undefined ? null : JSON.stringify(details))
    .run();
}
