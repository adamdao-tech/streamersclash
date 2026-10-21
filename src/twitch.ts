import type { Env } from './index';

// Twitch Helix API with an app access token (client credentials). The token is
// cached in D1 (kv_cache) so we don't request a new one on every invocation.

const TOKEN_KEY = 'twitch:app_token';

export interface TwitchVideo {
  id: string;
  user_id: string;
  user_login: string;
  title: string;
  url: string;
  created_at: string;
  duration: string; // e.g. "3h2m15s"
  thumbnail_url: string;
  type: string;
}

export interface TwitchStream {
  user_login: string;
  title: string;
  game_name: string;
  viewer_count: number;
  started_at: string;
}

export async function cacheGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM kv_cache WHERE key = ? AND expires_at > datetime('now')`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function cacheSet(db: D1Database, key: string, value: string, ttlSeconds: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, datetime('now', ?))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    )
    .bind(key, value, `+${Math.floor(ttlSeconds)} seconds`)
    .run();
}

async function appToken(env: Env, forceNew = false): Promise<string> {
  if (!forceNew) {
    const cached = await cacheGet(env.DB, TOKEN_KEY);
    if (cached) return cached;
  }
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch app token ${res.status}: ${await res.text()}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh an hour before Twitch expires it.
  await cacheSet(env.DB, TOKEN_KEY, access_token, Math.max(60, expires_in - 3600));
  return access_token;
}

async function helix<T>(env: Env, path: string, params: [string, string][]): Promise<T> {
  const url = `https://api.twitch.tv/helix/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await appToken(env, attempt > 0);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': env.TWITCH_CLIENT_ID } });
    if (res.status === 401 && attempt === 0) continue; // token revoked/expired: get a fresh one
    if (!res.ok) throw new Error(`Twitch ${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
  throw new Error(`Twitch ${path}: unauthorized`);
}

/** Maps logins to Twitch user IDs (max 100 per call). Unknown logins are left out. */
export async function getUserIds(env: Env, logins: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < logins.length; i += 100) {
    const chunk = logins.slice(i, i + 100);
    const { data } = await helix<{ data: { id: string; login: string }[] }>(
      env,
      'users',
      chunk.map((l) => ['login', l]),
    );
    for (const u of data) out.set(u.login.toLowerCase(), u.id);
  }
  return out;
}

/** Latest past broadcasts (archives) of one channel. */
export async function getArchives(env: Env, userId: string, first = 10): Promise<TwitchVideo[]> {
  const { data } = await helix<{ data: TwitchVideo[] }>(env, 'videos', [
    ['user_id', userId],
    ['type', 'archive'],
    ['first', String(first)],
  ]);
  return data;
}

/** Which of these channels are live right now (max 100 per call). */
export async function getStreams(env: Env, logins: string[]): Promise<TwitchStream[]> {
  const out: TwitchStream[] = [];
  for (let i = 0; i < logins.length; i += 100) {
    const chunk = logins.slice(i, i + 100);
    const { data } = await helix<{ data: TwitchStream[] }>(env, 'streams', [
      ...chunk.map((l): [string, string] => ['user_login', l]),
      ['first', '100'],
    ]);
    out.push(...data);
  }
  return out;
}

/** "3h2m15s" → seconds */
export function parseTwitchDuration(d: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
