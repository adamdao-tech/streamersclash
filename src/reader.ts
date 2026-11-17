import type { Env } from './index';
import { applyPostgame, findSameGame, saveDraft, teamGameCheck, validateDraft, type DraftInput, type DraftSlot } from './drafts';
import { logActivity } from './db';
import { assertBodySize, HttpError, json, sha256Hex } from './http';
import { getStreams } from './twitch';

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
    if (req.method === 'POST') assertBodySize(req, 8_000_000); // draft screenshots arrive base64
    return await route(req, env, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
    console.error('reader API error', err);
    return json({ error: 'internal_error' }, 500);
  }
}

/** Read VODs of the same team that cover ≥ 80 % of this VOD's time and had team games in them (null = not covered). */
async function coveredBy(db: D1Database, v: { id: number; team_id: number | null; started_at: string; duration_s: number | null }): Promise<string[] | null> {
  const start = new Date(v.started_at).getTime(), end = start + (v.duration_s || 0) * 1000;
  if (!(end > start)) return null;
  const { results } = await db
    .prepare(
      `SELECT o.started_at, o.duration_s, p.nickname FROM vods o JOIN players p ON p.id = o.player_id
        WHERE p.team_id = ? AND o.id <> ? AND o.scan_status = 'done'
          AND EXISTS (SELECT 1 FROM matches m WHERE m.vod_id = o.id)`,
    )
    .bind(v.team_id, v.id)
    .all<{ started_at: string; duration_s: number | null; nickname: string }>();
  const parts = results
    .map((o) => { const s = new Date(o.started_at).getTime(); return { s: Math.max(s, start), e: Math.min(s + (o.duration_s || 0) * 1000, end), who: o.nickname }; })
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s);
  let covered = 0, curS = -1, curE = -1;
  for (const x of parts) {
    if (x.s > curE) { if (curE > curS) covered += curE - curS; curS = x.s; curE = x.e; } else curE = Math.max(curE, x.e);
  }
  if (curE > curS) covered += curE - curS;
  return covered >= 0.8 * (end - start) ? [...new Set(parts.map((x) => x.who))] : null;
}

/** Start of data collection (env SCAN_FROM, ISO time): VODs and games before it are not read. */
function scanFrom(env: Env): string | null {
  const v = String(env.SCAN_FROM ?? '').trim();
  return v && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString().slice(0, 19).replace('T', ' ') : null;
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  let m: RegExpMatchArray | null;

  // Claim finished VODs waiting for a scan. A claim expires after 1 h (a VOD takes minutes to read now) so a restarted or crashed reader doesn't block it for long.
  if (path === '/api/reader/jobs' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1, 1), 5);
    const { results: candidates } = await db
      .prepare(
        `SELECT v.id, v.platform, v.url, v.stream_url, v.title, v.channel_login, v.started_at, v.duration_s, v.player_id,
                COALESCE(p.is_captain, 0) AS is_captain, p.team_id
           FROM vods v LEFT JOIN players p ON p.id = v.player_id
          WHERE (v.scan_status = 'pending' OR (v.scan_status = 'scanning' AND v.scanned_at < datetime('now', '-1 hours')))
            AND v.platform IN ('twitch', 'kick')
            -- skip VODs of streams still running: their duration keeps growing
            AND datetime(v.started_at, '+' || COALESCE(v.duration_s, 0) || ' seconds') < datetime('now', '-20 minutes')
            -- only VODs that run past the start of data collection (SCAN_FROM); older ones are left alone
            AND (? IS NULL OR datetime(v.started_at, '+' || COALESCE(v.duration_s, 0) || ' seconds') > datetime(?))
          -- captains first: their team games then cover the same games on the teammates' VODs
          ORDER BY COALESCE(p.is_captain, 0) DESC, v.started_at DESC LIMIT ?`,
      )
      .bind(scanFrom(env), scanFrom(env), limit * 8)
      .all<{ id: number; platform: string; channel_login: string | null; started_at: string; duration_s: number | null; is_captain: number; team_id: number | null }>();
    // A Twitch VOD of a stream that is still running (e.g. a 24/7 subathon) can't be read yet: its stored
    // duration is from the last sync and the reader would crawl through it in real time. Leave it for later.
    const logins = [...new Set(candidates.filter((v) => v.platform === 'twitch' && v.channel_login).map((v) => v.channel_login!))];
    const live = logins.length ? await getStreams(env, logins).catch(() => []) : [];
    const notLive = candidates.filter((v) => !live.some((st) => st.user_login.toLowerCase() === String(v.channel_login).toLowerCase()
      && Math.abs(new Date(st.started_at).getTime() - new Date(v.started_at).getTime()) < 30 * 60_000));
    // A teammate's VOD whose time is already covered by read VODs of his team with team games in them
    // (usually the captain's) has the same games from another POV: skip it instead of reading it again.
    const results: typeof candidates = [];
    for (const v of notLive) {
      if (results.length >= limit) break;
      const cover = !v.is_captain && v.team_id ? await coveredBy(db, v) : null;
      if (cover) {
        await db.prepare(`UPDATE vods SET scan_status = 'skipped', scanned_at = datetime('now') WHERE id = ?`).bind(v.id).run();
        await logActivity(db, { kind: 'sync' }, 'vod.skip_covered', 'vod', v.id, { covered_by: cover });
        continue;
      }
      results.push(v);
    }
    if (!results.length) return json({ jobs: [] });
    // Several reader workers claim at the same time: take a VOD only if it is still free, so no two read the same one.
    const claimed = await db.batch(
      results.map((v) =>
        db.prepare(
          `UPDATE vods SET scan_status = 'scanning', scanned_at = datetime('now')
            WHERE id = ? AND (scan_status = 'pending' OR (scan_status = 'scanning' AND scanned_at < datetime('now', '-1 hours')))`,
        ).bind(v.id),
      ),
    );
    return json({ jobs: results.filter((_, i) => (claimed[i]?.meta?.changes ?? 0) > 0) });
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
      if (pgBytes && existing.status === 'review') {
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

    // A game from before the start of data collection (SCAN_FROM) – e.g. early in a VOD that started before it – isn't saved.
    const from = scanFrom(env);
    if (from) {
      const v = await db.prepare('SELECT started_at FROM vods WHERE id = ?').bind(vodId).first<{ started_at: string | null }>();
      const at = v?.started_at ? new Date(v.started_at).getTime() + Math.round(body.ts_s) * 1000 : NaN;
      const fromMs = new Date(from.replace(' ', 'T') + 'Z').getTime();
      if (Number.isFinite(at) && at < fromMs) {
        const note = `Hra před začátkem sběru dat (${new Date(fromMs).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })})`;
        await db.prepare(`UPDATE draft_frames SET status = 'discarded', note = ? WHERE id = ?`).bind(note, frameId).run();
        return json({ ok: true, frame_id: frameId, match_id: null, review: false, skipped: 'before_scan_from', reason: note }, 201);
      }
    }

    // Games read (partly) from the post-game screen – blind pick, or drafted outside the client (drafter.lol):
    // only team games are kept, also those going to review, so solo queue scoreboards don't flood the queue.
    // Without a champ select (source "postgame") the scoreboard doesn't say which team is the streamer's:
    // the one with his teammates is.
    const rd = body.reading as (DraftInput & { source?: string; postgame?: { open?: boolean; ally?: DraftSlot[]; enemy?: DraftSlot[] } }) | undefined;
    if (rd?.postgame?.open) {
      const pg = rd.postgame;
      const side = (rows?: DraftSlot[]) => (rows ?? []).map((r) => ({ champion: r.champion ?? '?', player_name: r.player_name ?? null }));
      const fromBoard = rd.source === 'postgame';
      const t1 = fromBoard ? side(pg.ally) : rd.ally;
      const t2 = side(pg.enemy);
      // the streamer's own roster on either side …
      const a = await teamGameCheck(env, { vod_id: vodId, ally: t1 });
      const e = fromBoard ? await teamGameCheck(env, { vod_id: vodId, ally: t2 }) : null;
      // … or a full roster of another team on the other side: a scrim, even when the streamer's teammates
      // play on accounts the app doesn't know (the scoreboard shows the account names)
      const vsT2 = await teamGameCheck(env, { vod_id: null, ally: t2 });
      const vsT1 = fromBoard ? await teamGameCheck(env, { vod_id: null, ally: t1 }) : null;
      const scrimVsT2 = vsT2.ok && vsT2.team !== a.team;
      const scrimVsT1 = !!vsT1?.ok && vsT1.team !== a.team;
      let swap = false;
      if (a.ok || e?.ok) swap = !!e?.ok && (!a.ok || e.matched > a.matched);
      else if (scrimVsT2) swap = false;
      else if (scrimVsT1) swap = true;
      else {
        const note = `Není týmová hra: ze soupisky ${a.team ?? 'týmu'} jen ${a.matched} z ${a.need} (${a.names.join(', ') || '–'}), soupeř není tým z appky`;
        await db.prepare(`UPDATE draft_frames SET status = 'discarded', note = ? WHERE id = ?`).bind(note.slice(0, 500), frameId).run();
        await logActivity(db, { kind: 'sync' }, 'frame.not_team', 'frame', frameId, { vod_id: vodId, matched: a.matched, need: a.need });
        return json({ ok: true, frame_id: frameId, match_id: null, review: false, skipped: 'not_team_game', reason: note }, 201);
      }
      if (swap) {
        // the streamer's team is the second one on the scoreboard: swap the sides
        [pg.ally, pg.enemy] = [pg.enemy, pg.ally];
        rd.ally = (pg.ally ?? []).map((r) => ({ champion: r.champion ?? '?', player_name: r.player_name ?? null, role: r.role ?? null }));
        rd.enemy = (pg.enemy ?? []).map((r) => ({ champion: r.champion ?? '?' }));
        await db.prepare('UPDATE draft_frames SET reading = ? WHERE id = ?').bind(JSON.stringify(rd), frameId).run();
      }
      // A scrim against another team's roster with the streamer's teammates on unknown accounts: the normal
      // team check in saveDraft would refuse it, so it goes to review instead of being dropped.
      if (!a.ok && !e?.ok) body.auto = false;
    }

    // The same game already saved (scoreboard left on screen for minutes, or the game read on another stream):
    // add what this read knows to it instead of saving it twice.
    const pgDur = (rd?.postgame as { duration_s?: number | null } | undefined)?.duration_s;
    const same = rd ? await findSameGame(env, [...(rd.ally ?? []), ...(rd.enemy ?? [])].map((s) => s.champion), pgDur) : null;
    if (same) {
      if (rd?.postgame) await applyPostgame(env, same, rd.postgame as Parameters<typeof applyPostgame>[2]);
      await db.prepare(`UPDATE draft_frames SET status = 'accepted', match_id = ?, note = ? WHERE id = ?`)
        .bind(same, 'Stejná hra už je uložená', frameId).run();
      return json({ ok: true, duplicate: true, frame_id: frameId, match_id: same }, 201);
    }

    let matchId: number | null = null;
    let reviewReason: string | null = body.auto ? null : 'low confidence';
    if (body.auto && body.reading) {
      try {
        const draft = await validateDraft(env, { ...body.reading, vod_id: vodId, ts_s: Math.round(body.ts_s) });
        // Only games of the streamer's team (at least 4 of its players on his side) are saved – no solo queue / Streamers Queue.
        const tg = await teamGameCheck(env, draft);
        if (!tg.ok) {
          const note = `Není týmová hra: ze soupisky ${tg.team ?? 'týmu'} jen ${tg.matched} z ${tg.need} (${tg.names.join(', ') || '–'})`;
          await db.prepare(`UPDATE draft_frames SET status = 'discarded', note = ? WHERE id = ?`).bind(note.slice(0, 500), frameId).run();
          await logActivity(db, { kind: 'sync' }, 'frame.not_team', 'frame', frameId, { vod_id: vodId, matched: tg.matched, need: tg.need });
          return json({ ok: true, frame_id: frameId, match_id: null, review: false, skipped: 'not_team_game', reason: note }, 201);
        }
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
