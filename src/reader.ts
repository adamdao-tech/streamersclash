import type { Env } from './index';
import { saveDraft, validateDraft, type DraftInput } from './drafts';
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
        `SELECT v.id, v.platform, v.url, v.title, v.channel_login, v.started_at, v.duration_s, v.player_id
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
      vod_id: number;
      ts_s: number;
      image_b64: string;
      width?: number;
      height?: number;
      reading?: DraftInput & { [k: string]: unknown };
      confidence?: number;
      auto?: boolean;
    };
    if (!body.vod_id || typeof body.ts_s !== 'number' || !body.image_b64) {
      throw new HttpError(400, 'invalid', 'vod_id, ts_s and image_b64 are required');
    }
    const bytes = Uint8Array.from(atob(body.image_b64), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', 'Image too large');

    const ins = await db
      .prepare(
        `INSERT INTO draft_frames (vod_id, ts_s, image, width, height, reading, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vod_id, ts_s) DO NOTHING`,
      )
      .bind(
        body.vod_id,
        Math.round(body.ts_s),
        bytes.buffer,
        body.width ?? null,
        body.height ?? null,
        body.reading ? JSON.stringify(body.reading) : null,
        body.confidence ?? null,
      )
      .run();
    if (!ins.meta.changes) return json({ ok: true, duplicate: true });
    const frameId = ins.meta.last_row_id;

    let matchId: number | null = null;
    let reviewReason: string | null = body.auto ? null : 'low confidence';
    if (body.auto && body.reading) {
      try {
        const draft = await validateDraft(env, { ...body.reading, vod_id: body.vod_id, ts_s: Math.round(body.ts_s) });
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
      await logActivity(db, { kind: 'sync' }, 'frame.review', 'frame', frameId, { vod_id: body.vod_id });
    }
    return json({ ok: true, frame_id: frameId, match_id: matchId, review: !matchId, reason: reviewReason }, 201);
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}
