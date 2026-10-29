import type { Env } from './index';
import { logActivity, type User } from './db';
import { cookie, parseCookies, randomToken, redirect, sha256Hex } from './http';

const SESSION_COOKIE = 'sc_session';
const STATE_COOKIE = 'sc_oauth_state';
const NEXT_COOKIE = 'sc_next';

/** Only same-site paths are allowed as a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}
const SESSION_DAYS = 30;

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export async function getSessionUser(req: Request, env: Env): Promise<User | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const hash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT u.id, u.twitch_login, u.twitch_id, u.display_name, u.avatar_url, u.role, u.can_stream
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(hash)
    .first<User>();
}

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  const redirectUri = `${url.origin}/auth/callback`;

  switch (url.pathname) {
    case '/auth/login': {
      const state = randomToken(16);
      const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
      authorize.search = new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: '',
        state,
      }).toString();
      return redirect(authorize.toString(), [
        cookie(STATE_COOKIE, state, { maxAge: 600, path: '/auth' }),
        cookie(NEXT_COOKIE, safeNext(url.searchParams.get('next')), { maxAge: 600, path: '/auth' }),
      ]);
    }

    case '/auth/callback': {
      const clearState = cookie(STATE_COOKIE, '', { maxAge: 0, path: '/auth' });
      if (url.searchParams.get('error')) return redirect('/login?error=denied', [clearState]);

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const expected = parseCookies(req)[STATE_COOKIE];
      if (!code || !state || !expected || state !== expected) {
        return redirect('/login?error=state', [clearState]);
      }
      if (!env.TWITCH_CLIENT_SECRET) {
        console.error('TWITCH_CLIENT_SECRET is not set');
        return redirect('/login?error=config', [clearState]);
      }

      let twitchUser: TwitchUser;
      try {
        twitchUser = await exchangeCodeForUser(env, code, redirectUri);
      } catch (err) {
        console.error('Twitch login failed', err);
        return redirect('/login?error=failed', [clearState]);
      }

      const user = await upsertAllowedUser(env, twitchUser);
      if (!user) return redirect('/login?error=not_allowed', [clearState]);

      const token = randomToken(32);
      await env.DB.prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
      )
        .bind(await sha256Hex(token), user.id)
        .run();
      // Housekeeping: drop expired sessions.
      await env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
      await logActivity(env.DB, { kind: 'user', userId: user.id }, 'login', 'user', user.id);

      const next = safeNext(parseCookies(req)[NEXT_COOKIE]);
      return redirect(next, [
        clearState,
        cookie(NEXT_COOKIE, '', { maxAge: 0, path: '/auth' }),
        cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 }),
      ]);
    }

    case '/auth/logout': {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
      }
      return redirect('/login', [cookie(SESSION_COOKIE, '', { maxAge: 0 })]);
    }
  }
  return new Response('Not found', { status: 404 });
}

async function exchangeCodeForUser(env: Env, code: string, redirectUri: string): Promise<TwitchUser> {
  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${access_token}`, 'Client-Id': env.TWITCH_CLIENT_ID },
  });
  if (!userRes.ok) throw new Error(`helix/users ${userRes.status}: ${await userRes.text()}`);
  const { data } = (await userRes.json()) as { data: TwitchUser[] };
  if (!data?.[0]) throw new Error('helix/users returned no user');

  // We only needed the token to identify the user; revoke it right away.
  await fetch('https://id.twitch.tv/oauth2/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, token: access_token }),
  }).catch(() => {});

  return data[0];
}

/**
 * Returns the app user for this Twitch account, or null if they aren't on the allowlist.
 * The very first person to log in (empty users table) becomes the admin.
 */
async function upsertAllowedUser(env: Env, tw: TwitchUser): Promise<User | null> {
  const db = env.DB;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();

  if (!count || count.n === 0) {
    await db
      .prepare(
        `INSERT INTO users (twitch_login, twitch_id, display_name, avatar_url, role, last_login_at)
         VALUES (?, ?, ?, ?, 'admin', datetime('now'))`,
      )
      .bind(tw.login, tw.id, tw.display_name, tw.profile_image_url)
      .run();
  } else {
    // Match by Twitch ID first (survives renames), then by the login the admin added.
    const existing = await db
      .prepare('SELECT id FROM users WHERE twitch_id = ? OR (twitch_id IS NULL AND twitch_login = ?) LIMIT 1')
      .bind(tw.id, tw.login)
      .first<{ id: number }>();
    if (!existing) return null;
    await db
      .prepare(
        `UPDATE users SET twitch_id = ?, twitch_login = ?, display_name = ?, avatar_url = ?, last_login_at = datetime('now')
          WHERE id = ?`,
      )
      .bind(tw.id, tw.login, tw.display_name, tw.profile_image_url, existing.id)
      .run();
  }

  return db
    .prepare('SELECT id, twitch_login, twitch_id, display_name, avatar_url, role FROM users WHERE twitch_id = ?')
    .bind(tw.id)
    .first<User>();
}
