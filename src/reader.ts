import type { Env } from './index';
import { applyPostgame, saveDraft, validateDraft, type DraftInput } from './drafts';
import { logActivity } from './db';
import { HttpError, json, sha256Hex } from './http';

// API for the draft reader running on Dao's PC (reader/ in this repo).
// Authenticated with a shared secret: Authorization: Bearer <READER_TOKEN>.

const MAX_IMAGE_BYTES = 1_500_000;

async function authorized(req: Request, env: Env): Promise<boolean> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!env.READER_TOKEN || !token) return false;
  // Compare hashes so the comparison time doesn't depend on the secret.
  return (await sha256Hex(token)) === (await sha256Hex(env.READER_TOKEN));
}

export async function handleReader(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);
    return await route(req, env, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
    console.error('reader API error', err);
    return json({ error: 'internal_error' }, 500);
  }
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  let m: RegExpMatchArray | null;

  // Claim finished VODs waiting for a scan. A claim expires after 6 h so a crashed reader doesn't block a VOD forever.
  if (path === '/api/reader/jobs' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1, 1), 5);
    const { results } = await db
      .prepare(
        `SELECT v.id, v.platform, v.url, v.stream_url, v.title, v.channel_login, v.started_at, v.duration_s, v.player_id
           FROM vods v
          WHERE (v.scan_status = 'pending' OR (v.scan_status = 'scanning' AND v.scanned_at < datetime('now', '-6 hours')))
            AND v.platform IN ('twitch', 'kick')
            -- skip VODs of streams still running: their duration keeps growing
            AND datetime(v.started_at, '+' || COALESCE(v.duration_s, 0) || ' seconds') < datetime('now', '-20 minutes')
          ORDER BY v.started_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<{ id: number }>();
    if (results.length) {
      await db.batch(
        results.map((v) =>
          db.prepare(`UPDATE vods SET scan_status = 'scanning', scanned_at = datetime('now') WHERE id = ?`).bind(v.id),
        ),
      );
    }
    return json({ jobs: results });
  }

  // --- Kick ------------------------------------------------------------------
  // Kick has no public VOD API and blocks requests from Cloudflare Workers, so the reader (a home
  // connection) lists the channels' VODs and sends them here.

  // Kick channels to sync: players' Kick channels + extra channels, least recently synced first.
  if (path === '/api/reader/kick/channels' && req.method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT c.slug, MIN(c.player_id) AS player_id, s.last_synced_at FROM (
           SELECT lower(kick_slug) AS slug, id AS player_id FROM players WHERE kick_slug IS NOT NULL AND kick_slug <> ''
           UNION ALL
           SELECT lower(login) AS slug, NULL AS player_id FROM channels WHERE platform = 'kick'
         ) c LEFT JOIN sync_state s ON s.key = 'kick:' || c.slug
         GROUP BY c.slug ORDER BY s.last_synced_at IS NOT NULL, s.last_synced_at`,
      )
      .all();
    return json({ channels: results });
  }

  // VODs of one Kick channel (or the error the reader got while fetching them).
  if (path === '/api/reader/kick/vods' && req.method === 'POST') {
    const body = (await req.json()) as {
      slug?: string;
      error?: string;
      vods?: { external_id: string; url: string; stream_url?: string | null; title?: string | null; started_at?: string | null;
               duration_s?: number | null; thumbnail_url?: string | null }[];
    };
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) throw new HttpError(400, 'invalid', 'slug is required');
    const setState = (error: string | null) =>
      db.prepare(
        `INSERT INTO sync_state (key, last_synced_at, last_error) VALUES (?, datetime('now'), ?)
         ON CONFLICT(key) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_error = excluded.last_error`,
      ).bind(`kick:${slug}`, error);
    if (body.error) {
      await setState(String(body.error).slice(0, 500)).run();
      return json({ ok: true, added: 0 });
    }
    const player = await db.prepare('SELECT MIN(id) AS id FROM players WHERE lower(kick_slug) = ?').bind(slug).first<{ id: number | null }>();
    const vods = (body.vods ?? []).filter((v) => v.external_id && v.url).slice(0, 20);
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM vods WHERE platform = 'kick'`).first<{ n: number }>();
    const upsert = db.prepare(
      `INSERT INTO vods (player_id, platform, external_id, url, stream_url, title, started_at, duration_s, thumbnail_url, channel_login)
       VALUES (?, 'kick', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, external_id) DO UPDATE SET
         title = excluded.title, duration_s = excluded.duration_s, stream_url = COALESCE(excluded.stream_url, vods.stream_url),
         thumbnail_url = COALESCE(excluded.thumbnail_url, vods.thumbnail_url), player_id = COALESCE(vods.player_id, excluded.player_id)`,
    );
    await db.batch([
      ...vods.map((v) =>
        upsert.bind(player?.id ?? null, String(v.external_id), String(v.url), v.stream_url ?? null, v.title ?? null,
          v.started_at ?? null, v.duration_s ?? null, v.thumbnail_url ?? null, slug),
      ),
      setState(null),
    ]);
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM vods WHERE platform = 'kick'`).first<{ n: number }>();
    const added = (after?.n ?? 0) - (before?.n ?? 0);
    if (added > 0) await logActivity(db, { kind: 'sync' }, 'vods.sync', null, null, { new: added, channels: 1, platform: 'kick', slug });
    return json({ ok: true, added });
  }

  // Report the outcome of a scan.
  if ((m = path.match(/^\/api\/reader\/jobs\/(\d+)$/)) && req.method === 'POST') {
    const body = (await req.json()) as { status?: string; drafts_found?: number; error?: string };
    const status = ['done', 'skipped', 'failed'].includes(String(body.status)) ? String(body.status) : 'failed';
    await db
      .prepare(`UPDATE vods SET scan_status = ?, scanned_at = datetime('now') WHERE id = ?`)
      .bind(status, Number(m[1]))
      .run();
    if (status === 'failed' && body.error) console.warn('reader failed on VOD', m[1], body.error);
    return json({ ok: true });
  }

  // Upload a final-draft frame with the reader's OCR result.
  // When the reader is confident (auto=true) and all champions validate, the draft is saved right away;
  // otherwise the frame waits for review (Claude via MCP, or a person).
  if (path === '/api/reader/frames' && req.method === 'POST') {
    const body = (await req.json()) as {
      vod_id?: number;
      vod_url?: string;
      ts_s: number;
      image_b64: string;
      width?: number;
      height?: number;
      reading?: DraftInput & { [k: string]: unknown };
      confidence?: number;
      auto?: boolean;
      postgame_image_b64?: string | null;
    };
    if (!body.vod_id && body.vod_url) {
      // Manual uploads (reader `test --upload`) name the VOD by its URL.
      const twitchId = /twitch\.tv\/videos\/(\d+)/.exec(body.vod_url)?.[1];
      const vod = await db
        .prepare(`SELECT id FROM vods WHERE url = ? OR (platform = 'twitch' AND external_id = ?) LIMIT 1`)
        .bind(body.vod_url, twitchId ?? '')
        .first<{ id: number }>();
      if (!vod) {
        throw new HttpError(404, 'vod_not_found', 'Tahle VODka v appce není. Přidej hráči nebo do „Další kanály“ jeho Twitch kanál a dej Synchronizovat.');
      }
      body.vod_id = vod.id;
    }
    if (!body.vod_id || typeof body.ts_s !== 'number' || !body.image_b64) {
      throw new HttpError(400, 'invalid', 'vod_id, ts_s and image_b64 are required');
    }
    const vodId = body.vod_id;
    const bytes = Uint8Array.from(atob(body.image_b64), (c) => c.charCodeAt(0));
    const pgBytes = body.postgame_image_b64 ? Uint8Array.from(atob(body.postgame_image_b64), (c) => c.charCodeAt(0)) : null;
    if (bytes.length > MAX_IMAGE_BYTES || (pgBytes?.length ?? 0) > MAX_IMAGE_BYTES) {
      throw new HttpError(413, 'too_large', 'Image too large');
    }

    // The same champ select read again (rescan): update instead of creating a duplicate game.
    const existing = await db
      .prepare(
        `SELECT id, match_id, status FROM draft_frames WHERE vod_id = ? AND ABS(ts_s - ?) <= 90
          ORDER BY ABS(ts_s - ?) LIMIT 1`,
      )
      .bind(vodId, Math.round(body.ts_s), Math.round(body.ts_s))
      .first<{ id: number; match_id: number | null; status: string }>();
    if (existing) {
      const pg = (body.reading as { postgame?: Parameters<typeof applyPostgame>[2] } | undefined)?.postgame;
      let updated = false;
      if (existing.match_id && pg) updated = await applyPostgame(env, existing.match_id, pg);
      if (existing.status === 'review' && body.reading) {
        await db.prepare('UPDATE draft_frames SET reading = ?, image = ?, confidence = ? WHERE id = ?')
          .bind(JSON.stringify(body.reading), bytes.buffer, body.confidence ?? null, existing.id)
          .run();
        updated = true;
      }
      if (pgBytes) {
        await db.prepare('UPDATE draft_frames SET postgame_image = ? WHERE id = ?').bind(pgBytes.buffer, existing.id).run();
      }
      return json({ ok: true, duplicate: true, updated, frame_id: existing.id, match_id: existing.match_id });
    }

    const ins = await db
      .prepare(
        `INSERT INTO draft_frames (vod_id, ts_s, image, width, height, reading, confidence, postgame_image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vod_id, ts_s) DO NOTHING`,
      )
      .bind(
        vodId,
        Math.round(body.ts_s),
        bytes.buffer,
        body.width ?? null,
        body.height ?? null,
        body.reading ? JSON.stringify(body.reading) : null,
        body.confidence ?? null,
        pgBytes ? pgBytes.buffer : null,
      )
      .run();
    if (!ins.meta.changes) return json({ ok: true, duplicate: true });
    const frameId = ins.meta.last_row_id;

    let matchId: number | null = null;
    let reviewReason: string | null = body.auto ? null : 'low confidence';
    if (body.auto && body.reading) {
      try {
        const draft = await validateDraft(env, { ...body.reading, vod_id: vodId, ts_s: Math.round(body.ts_s) });
        matchId = await saveDraft(env, draft, { kind: 'sync' });
        await db
          .prepare(`UPDATE draft_frames SET status = 'accepted', match_id = ? WHERE id = ?`)
          .bind(matchId, frameId)
          .run();
      } catch (err) {
        reviewReason = err instanceof Error ? err.message : String(err);
        await db.prepare('UPDATE draft_frames SET note = ? WHERE id = ?').bind(reviewReason.slice(0, 500), frameId).run();
      }
    }
    if (!matchId) {
      await logActivity(db, { kind: 'sync' }, 'frame.review', 'frame', frameId, { vod_id: vodId });
    }
    return json({ ok: true, frame_id: frameId, match_id: matchId, review: !matchId, reason: reviewReason }, 201);
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}
