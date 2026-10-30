import { handleApi } from './api';
import { getSessionUser, handleAuth, safeNext } from './auth';
import { ensureSchema } from './db';
import { json, redirect } from './http';
import { handleMcp } from './mcp';
import { handleOAuth, isOAuthPath } from './oauth';
import { handleReader } from './reader';
import { syncTwitchVods } from './vods';
import { syncProfiles, syncQueue } from './queue';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  READER_TOKEN?: string;
  /** Twitch logins (comma-separated) that see the activity log – superadmins, above admins. */
  SUPERADMINS?: string;
  /** Streamers Queue API (Candi) – secret key and base URL */
  SQ_API_KEY?: string;
  SQ_BASE_URL?: string;
}

/** Paths reachable without logging in. */
const PUBLIC_PATHS = new Set(['/login', '/login.html']);

/** Static files every page needs, login page included: served straight from assets, no DB or session lookup. */
const STATIC_PATHS = new Set(['/app.css', '/favicon.svg', '/map-rift.webp']);

async function serveStatic(req: Request, env: Env, url: URL): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  if (url.pathname === '/map-rift.webp' && res.ok) {
    // The built-in map picture: cache it for a day instead of downloading it on every map.
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'public, max-age=86400');
    return out;
  }
  if (!url.pathname.startsWith('/fonts/') || !res.ok) return res;
  // Font files never change under the same name: let the browser keep them for a year.
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return out;
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (STATIC_PATHS.has(url.pathname) || url.pathname.startsWith('/fonts/')) return serveStatic(req, env, url);

    try {
      return await route(req, env, url);
    } catch (err) {
      // usually the database (D1 free plan daily limits reset at 00:00 UTC): say so instead of Cloudflare's error 1101
      const msg = (err as Error)?.message ?? String(err);
      console.error('request failed', url.pathname, msg);
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return json({ error: 'server_error', detail: msg }, 503);
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dočasně nedostupné</title>
<link rel="stylesheet" href="/app.css"><main style="max-width:560px;margin:15vh auto;padding:0 16px">
<h1>Dočasně nedostupné</h1><p>Databáze teď neodpovídá (nejspíš denní limit Cloudflare D1, obnoví se v 1:00 / 2:00 v létě).</p>
<p class="muted" style="font:12px ui-monospace,monospace">${msg.replace(/[<>&]/g, '')}</p></main>`,
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '300', 'cache-control': 'no-store' } },
      );
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        // Independent jobs: one failing must not stop the other.
        await Promise.all([
          syncTwitchVods(env).then((r) => console.log('VOD sync', JSON.stringify(r)), (e) => console.error('VOD sync failed', e)),
          // Streamers Queue: leaderboard + newly ended lobbies (their API keeps only the last ~36).
          // then a batch of players' profiles (op.gg accounts, preferred role)
          syncQueue(env)
            .then((r) => console.log('Queue sync', JSON.stringify(r)), (e) => console.error('Queue sync failed', e))
            .then(() => syncProfiles(env))
            .then((r) => console.log('Profiles', JSON.stringify(r)), (e) => console.error('Profiles failed', e)),
        ]);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
    await ensureSchema(env.DB);

    if (url.pathname.startsWith('/auth/')) return handleAuth(req, env, url);
    if (url.pathname.startsWith('/api/reader/')) return handleReader(req, env, url);
    if (isOAuthPath(url.pathname)) return handleOAuth(req, env, url);
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') return handleMcp(req, env, url);

    const user = await getSessionUser(req, env);

    if (url.pathname.startsWith('/api/')) {
      if (!user) return json({ error: 'unauthorized' }, 401);
      return handleApi(req, env, url, user);
    }

    if (!user && !PUBLIC_PATHS.has(url.pathname)) return redirect('/login');
    if (user && (url.pathname === '/login' || url.pathname === '/login.html')) {
      return redirect(safeNext(url.searchParams.get('next')));
    }

    const res = await env.ASSETS.fetch(req);
    // Pages behind login must not be cached by the browser or shared caches.
    const out = new Response(res.body, res);
    if (!PUBLIC_PATHS.has(url.pathname)) out.headers.set('Cache-Control', 'private, no-store');
    return out;
}
