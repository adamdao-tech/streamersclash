import type { Env } from './index';
import { getSessionUser } from './auth';
import type { User } from './db';
import { logActivity } from './db';
import { assertBodySize, cookie, json, parseCookies, randomToken, redirect, sha256Hex } from './http';

// Minimal OAuth 2.1 authorization server for the MCP connector (what claude.ai
// expects from a remote MCP server): metadata discovery, dynamic client
// registration, authorization code + PKCE (S256), refresh tokens.
// Users authenticate with the app's normal Twitch login and approve access on a consent page.

const ACCESS_TTL = 3600; // 1 h
const REFRESH_DAYS = 30;
const CSRF_COOKIE = 'sc_csrf';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function oauthError(error: string, description: string, status = 400): Response {
  return withCors(json({ error, error_description: description }, status));
}

export function isOAuthPath(path: string): boolean {
  return path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-');
}

export async function handleOAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const origin = url.origin;
  const path = url.pathname;

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    return withCors(
      json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      }),
    );
  }

  if (path.startsWith('/.well-known/oauth-authorization-server')) {
    return withCors(
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
      }),
    );
  }

  if (path === '/oauth/register' && req.method === 'POST') return register(req, env);
  if (path === '/oauth/authorize' && req.method === 'GET') return authorizePage(req, env, url);
  if (path === '/oauth/authorize' && req.method === 'POST') return authorizeDecision(req, env);
  if (path === '/oauth/token' && req.method === 'POST') return token(req, env);

  return oauthError('not_found', 'Unknown OAuth endpoint', 404);
}

// --- dynamic client registration (RFC 7591) ---------------------------------

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}

async function register(req: Request, env: Env): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be JSON');
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be https URLs');
  }
  // Public endpoint (MCP clients register themselves): a cap keeps anyone from flooding D1 with rows.
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_clients WHERE created_at > datetime('now', '-1 hour')`).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 20) return oauthError('temporarily_unavailable', 'Too many registrations, try again later', 429);
  // registrations nobody ever used are dropped after a day
  await env.DB.prepare(`DELETE FROM oauth_clients WHERE created_at < datetime('now', '-1 day')
                          AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`).run();
  const clientId = `sc_${randomToken(18)}`;
  const name = body.client_name ? String(body.client_name).slice(0, 100) : null;
  await env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)')
    .bind(clientId, name, JSON.stringify(uris))
    .run();
  return withCors(
    json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    ),
  );
}

// --- authorization endpoint ---------------------------------------------------

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
}

async function loadClient(env: Env, clientId: string) {
  const row = await env.DB.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?')
    .bind(clientId)
    .first<{ client_id: string; client_name: string | null; redirect_uris: string }>();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

/** Validates the request; returns an error page/response, or null when OK. */
async function checkParams(env: Env, p: AuthParams) {
  const client = await loadClient(env, p.client_id);
  // Without a known client and an exact redirect match we must not redirect anywhere.
  if (!client || !client.redirect_uris.includes(p.redirect_uri)) {
    return { error: page('Neplatná žádost', '<p>Neznámá aplikace nebo neplatná adresa pro návrat.</p>', 400), client: null };
  }
  if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge) {
    const u = new URL(p.redirect_uri);
    u.searchParams.set('error', 'invalid_request');
    u.searchParams.set('error_description', 'PKCE S256 and response_type=code are required');
    if (p.state) u.searchParams.set('state', p.state);
    return { error: redirect(u.toString()), client };
  }
  return { error: null, client };
}

function paramsFrom(src: URLSearchParams | FormData): AuthParams {
  const g = (k: string) => String(src.get(k) ?? '');
  return {
    client_id: g('client_id'),
    redirect_uri: g('redirect_uri'),
    state: g('state'),
    code_challenge: g('code_challenge'),
    code_challenge_method: g('code_challenge_method') || 'S256',
    response_type: g('response_type'),
  };
}

async function authorizePage(req: Request, env: Env, url: URL): Promise<Response> {
  const p = paramsFrom(url.searchParams);
  const { error, client } = await checkParams(env, p);
  if (error) return error;

  const user = await getSessionUser(req, env);
  if (!user) {
    // Log in first, then come back here.
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const csrf = randomToken(16);
  const hidden = Object.entries(p)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('');
  const appName = escapeHtml(client!.client_name || 'Aplikace');
  const host = escapeHtml(new URL(p.redirect_uri).host);
  const res = page(
    'Povolit přístup',
    `<p><b>${appName}</b> (${host}) chce přístup k SGooBovo šedl scouting pod tvým účtem
       <b>${escapeHtml(user.display_name || user.twitch_login)}</b>.</p>
     <p class="muted">Bude moct číst týmy, hráče, VODky a drafty, a přidávat drafty a poznámky. Každá změna se ukáže v aktivitě jako „Claude“.</p>
     <form method="post" action="/oauth/authorize">
       ${hidden}<input type="hidden" name="csrf" value="${csrf}">
       <div class="actions">
         <button class="btn" name="decision" value="deny">Zamítnout</button>
         <button class="btn btn-primary" name="decision" value="allow">Povolit</button>
       </div>
     </form>`,
  );
  res.headers.append('Set-Cookie', cookie(CSRF_COOKIE, csrf, { maxAge: 600, path: '/oauth' }));
  return res;
}

async function authorizeDecision(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const p = paramsFrom(form);
  const { error } = await checkParams(env, p);
  if (error) return error;

  const user = await getSessionUser(req, env);
  if (!user) return page('Nepřihlášen', '<p>Přihlášení vypršelo, zkus to znovu.</p>', 401);
  const csrf = parseCookies(req)[CSRF_COOKIE];
  if (!csrf || csrf !== form.get('csrf')) return page('Neplatná žádost', '<p>Formulář vypršel, zkus to znovu.</p>', 400);

  const back = new URL(p.redirect_uri);
  if (p.state) back.searchParams.set('state', p.state);
  const clearCsrf = cookie(CSRF_COOKIE, '', { maxAge: 0, path: '/oauth' });

  if (form.get('decision') !== 'allow') {
    back.searchParams.set('error', 'access_denied');
    return redirect(back.toString(), [clearCsrf]);
  }

  const code = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+10 minutes'))`,
  )
    .bind(await sha256Hex(code), p.client_id, user.id, p.redirect_uri, p.code_challenge)
    .run();
  await logActivity(env.DB, { kind: 'user', userId: user.id }, 'mcp.authorize', 'user', user.id);
  back.searchParams.set('code', code);
  return redirect(back.toString(), [clearCsrf]);
}

// --- token endpoint -----------------------------------------------------------

async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function issueTokens(env: Env, clientId: string, userId: number): Promise<Response> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES (?, 'access', ?, ?, datetime('now', '+${ACCESS_TTL} seconds'))`,
    ).bind(await sha256Hex(access), clientId, userId),
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES (?, 'refresh', ?, ?, datetime('now', '+${REFRESH_DAYS} days'))`,
    ).bind(await sha256Hex(refresh), clientId, userId),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE expires_at <= datetime('now')`),
    env.DB.prepare(`DELETE FROM oauth_codes WHERE expires_at <= datetime('now')`),
  ]);
  const res = json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'mcp' });
  res.headers.set('Pragma', 'no-cache');
  return withCors(res);
}

async function token(req: Request, env: Env): Promise<Response> {
  let form: URLSearchParams;
  const type = req.headers.get('Content-Type') ?? '';
  if (type.includes('application/json')) {
    form = new URLSearchParams((await req.json()) as Record<string, string>);
  } else {
    form = new URLSearchParams(await req.text());
  }
  const grant = form.get('grant_type');
  const clientId = form.get('client_id') ?? '';

  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const hash = await sha256Hex(code);
    // Single use: delete and read in one step.
    const row = await env.DB.prepare(
      `DELETE FROM oauth_codes WHERE code_hash = ? AND expires_at > datetime('now')
       RETURNING client_id, user_id, redirect_uri, code_challenge`,
    )
      .bind(hash)
      .first<{ client_id: string; user_id: number; redirect_uri: string; code_challenge: string }>();
    if (!row) return oauthError('invalid_grant', 'Code is invalid or expired');
    if (clientId && clientId !== row.client_id) return oauthError('invalid_grant', 'Client mismatch');
    if (form.get('redirect_uri') && form.get('redirect_uri') !== row.redirect_uri) {
      return oauthError('invalid_grant', 'redirect_uri mismatch');
    }
    if (!verifier || (await pkceS256(verifier)) !== row.code_challenge) {
      return oauthError('invalid_grant', 'PKCE verification failed');
    }
    return issueTokens(env, row.client_id, row.user_id);
  }

  if (grant === 'refresh_token') {
    const hash = await sha256Hex(form.get('refresh_token') ?? '');
    const row = await env.DB.prepare(
      `DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND expires_at > datetime('now')
       RETURNING client_id, user_id`,
    )
      .bind(hash)
      .first<{ client_id: string; user_id: number }>();
    if (!row) return oauthError('invalid_grant', 'Refresh token is invalid or expired');
    if (clientId && clientId !== row.client_id) return oauthError('invalid_grant', 'Client mismatch');
    return issueTokens(env, row.client_id, row.user_id);
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

/** The user behind an MCP bearer token, or null. Users removed from the allowlist lose access (tokens cascade). */
export async function userFromBearer(req: Request, env: Env): Promise<User | null> {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const hash = await sha256Hex(header.slice(7));
  return env.DB.prepare(
    `SELECT u.id, u.twitch_login, u.twitch_id, u.display_name, u.avatar_url, u.role
       FROM oauth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > datetime('now')`,
  )
    .bind(hash)
    .first<User>();
}

// --- tiny HTML pages ------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · SGooBovo šedl scouting</title><link rel="icon" href="/favicon.svg"><link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/fonts/rajdhani-700.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/app.css">
<style>.muted{color:var(--muted)} .actions{display:flex;gap:10px;justify-content:center;margin-top:24px}</style></head>
<body><div class="login-wrap"><div class="login-card"><h1>SGooBovo šedl <span>scouting</span></h1><h2 style="margin:18px 0 8px">${escapeHtml(title)}</h2>${body}</div></div></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' },
  });
}
