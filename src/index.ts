import { handleApi } from './api';
import { getSessionUser, handleAuth } from './auth';
import { ensureSchema } from './db';
import { json, redirect } from './http';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
}

/** Paths reachable without logging in. */
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/app.css', '/favicon.svg']);

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    await ensureSchema(env.DB);

    if (url.pathname.startsWith('/auth/')) return handleAuth(req, env, url);

    const user = await getSessionUser(req, env);

    if (url.pathname.startsWith('/api/')) {
      if (!user) return json({ error: 'unauthorized' }, 401);
      return handleApi(req, env, url, user);
    }

    if (!user && !PUBLIC_PATHS.has(url.pathname)) return redirect('/login');
    if (user && (url.pathname === '/login' || url.pathname === '/login.html')) return redirect('/');

    const res = await env.ASSETS.fetch(req);
    // Pages behind login must not be cached by the browser or shared caches.
    const out = new Response(res.body, res);
    if (!PUBLIC_PATHS.has(url.pathname)) out.headers.set('Cache-Control', 'private, no-store');
    return out;
  },
} satisfies ExportedHandler<Env>;
