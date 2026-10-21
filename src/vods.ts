import type { Env } from './index';
import { logActivity } from './db';
import { cacheGet, cacheSet, getArchives, getStreams, getUserIds, parseTwitchDuration } from './twitch';

// Free Workers plan allows ~50 subrequests and ~50 D1 queries per invocation,
// so each run syncs a limited batch of channels, least recently synced first.
const CHANNELS_PER_RUN = 10;
const VIDEOS_PER_CHANNEL = 10; // 9 bound params per row; D1 allows 100 per query

interface TrackedChannel {
  login: string;
  playerId: number | null;
}

/** All Twitch channels we follow: players' channels plus extra channels (e.g. the tournament broadcast). */
async function trackedTwitchChannels(db: D1Database): Promise<TrackedChannel[]> {
  const { results } = await db
    .prepare(
      `SELECT lower(twitch_login) AS login, MIN(id) AS player_id FROM players
        WHERE twitch_login IS NOT NULL GROUP BY lower(twitch_login)
       UNION
       SELECT lower(login) AS login, NULL AS player_id FROM channels WHERE platform = 'twitch'`,
    )
    .all<{ login: string; player_id: number | null }>();
  // A channel can appear twice (player + extra channel); prefer the player link.
  const map = new Map<string, TrackedChannel>();
  for (const r of results) {
    const prev = map.get(r.login);
    if (!prev || (prev.playerId === null && r.player_id !== null)) map.set(r.login, { login: r.login, playerId: r.player_id });
  }
  return [...map.values()];
}

export interface SyncResult {
  synced: string[];
  newVods: number;
  errors: { login: string; error: string }[];
}

/** Syncs the given channel logins, or the next batch of tracked channels if none are given. */
export async function syncTwitchVods(env: Env, onlyLogins?: string[]): Promise<SyncResult> {
  const db = env.DB;
  const all = await trackedTwitchChannels(db);
  let batch: TrackedChannel[];

  if (onlyLogins?.length) {
    const wanted = new Set(onlyLogins.map((l) => l.toLowerCase()));
    batch = all.filter((c) => wanted.has(c.login));
  } else {
    const { results: states } = await db
      .prepare(`SELECT key, last_synced_at FROM sync_state WHERE key LIKE 'twitch:%'`)
      .all<{ key: string; last_synced_at: string | null }>();
    const last = new Map(states.map((s) => [s.key.slice('twitch:'.length), s.last_synced_at ?? '']));
    batch = [...all].sort((a, b) => (last.get(a.login) ?? '').localeCompare(last.get(b.login) ?? '')).slice(0, CHANNELS_PER_RUN);
  }

  const result: SyncResult = { synced: [], newVods: 0, errors: [] };
  if (!batch.length) return result;

  const startedAt = await db.prepare(`SELECT datetime('now') AS t`).first<{ t: string }>();
  let ids: Map<string, string>;
  try {
    ids = await getUserIds(env, batch.map((c) => c.login));
  } catch (err) {
    // Usually a bad/missing TWITCH_CLIENT_SECRET or Twitch being down.
    const msg = err instanceof Error ? err.message : String(err);
    for (const ch of batch) await setSyncState(db, `twitch:${ch.login}`, msg.slice(0, 500));
    result.errors.push(...batch.map((ch) => ({ login: ch.login, error: msg })));
    return result;
  }

  for (const ch of batch) {
    const key = `twitch:${ch.login}`;
    try {
      const userId = ids.get(ch.login);
      if (!userId) throw new Error('Twitch kanál neexistuje');
      const videos = (await getArchives(env, userId, VIDEOS_PER_CHANNEL)).slice(0, VIDEOS_PER_CHANNEL);

      if (videos.length) {
        const rows = videos.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params = videos.flatMap((v) => [
          ch.playerId,
          'twitch',
          v.id,
          v.url,
          v.title,
          v.created_at,
          parseTwitchDuration(v.duration),
          v.thumbnail_url ? v.thumbnail_url.replace('%{width}', '320').replace('%{height}', '180') : null,
          ch.login,
        ]);
        await db
          .prepare(
            `INSERT INTO vods (player_id, platform, external_id, url, title, started_at, duration_s, thumbnail_url, channel_login)
             VALUES ${rows}
             ON CONFLICT(platform, external_id) DO UPDATE SET
               title = excluded.title,
               duration_s = excluded.duration_s,
               thumbnail_url = COALESCE(excluded.thumbnail_url, vods.thumbnail_url),
               player_id = COALESCE(vods.player_id, excluded.player_id)`,
          )
          .bind(...params)
          .run();
      }

      await setSyncState(db, key, null);
      result.synced.push(ch.login);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setSyncState(db, key, msg.slice(0, 500));
      result.errors.push({ login: ch.login, error: msg });
    }
  }

  const fresh = await db
    .prepare(`SELECT COUNT(*) AS n FROM vods WHERE created_at >= ?`)
    .bind(startedAt?.t ?? '')
    .first<{ n: number }>();
  result.newVods = fresh?.n ?? 0;
  if (result.newVods > 0) {
    await logActivity(db, { kind: 'sync' }, 'vods.sync', null, null, { new: result.newVods, channels: result.synced.length });
  }
  return result;
}

async function setSyncState(db: D1Database, key: string, error: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (key, last_synced_at, last_error) VALUES (?, datetime('now'), ?)
       ON CONFLICT(key) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_error = excluded.last_error`,
    )
    .bind(key, error)
    .run();
}

/** Live Twitch channels among the tracked ones, cached for 60 s. */
export async function getLiveChannels(env: Env): Promise<Record<string, { title: string; game: string; viewers: number; started_at: string }>> {
  const cached = await cacheGet(env.DB, 'live:twitch');
  if (cached) return JSON.parse(cached);

  const logins = (await trackedTwitchChannels(env.DB)).map((c) => c.login);
  const live: Record<string, { title: string; game: string; viewers: number; started_at: string }> = {};
  if (logins.length) {
    for (const s of await getStreams(env, logins)) {
      live[s.user_login.toLowerCase()] = { title: s.title, game: s.game_name, viewers: s.viewer_count, started_at: s.started_at };
    }
  }
  await cacheSet(env.DB, 'live:twitch', JSON.stringify(live), 60);
  return live;
}
