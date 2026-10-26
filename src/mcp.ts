import type { Env } from './index';
import { insert, parsePlayer, playerFields, teamFields, update } from './api';
import {
  formatPrague, KIND_LABELS, listSchedule, matchResult, opponentLabel, requireOpponent, scheduleFields, type ScheduledMatch,
} from './schedule';
import { logActivity, type User } from './db';
import { listDrafts, playerGames, relinkDraftPlayers, saveDraft, summarizeGames, validateDraft, type DraftInput } from './drafts';
import { HttpError, json } from './http';
import { userFromBearer } from './oauth';
import { syncTwitchVods } from './vods';
import { createFolder, loadCoaching, saveNote, saveRunePage } from './coaching';
import { describeRunePage, getRuneData } from './runes';

// Remote MCP server (Streamable HTTP transport, JSON responses only).
// Claude connects through the OAuth flow in oauth.ts and acts as the user who approved it;
// everything it writes is logged as actor "claude".

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `SGooBovo šedl scouting (SC Scouting): scouting tool for the Czech League of Legends tournament Streamers Clash.
Data: teams (one is ours, is_own_team), players with Riot ID and Twitch/Kick channels, their stream VODs,
and drafts read from those VODs. Drafts are seen from one player's stream (POV): "ally" = that player's team
(left column of the client), "enemy" = the opponents (right column).
Draft review workflow: list_drafts_for_review → get_draft_frame (look at the image) → save_draft with the
correct champions, or discard_draft_frame if it isn't a finished draft (dodge, lobby, unreadable).
Coaching: get_coaching shows rune pages and coaching notes per player and folder; write notes with add_coaching_note.
Schedule: get_schedule lists our tournament matches, scrims and other events; the next opponent's opponent_team_id is the team to scout.
Reply to the user in Czech.`;

type Json = Record<string, unknown>;
type ToolResult = { content: Json[]; isError?: boolean };

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (args: Json, ctx: { env: Env; user: User }) => Promise<ToolResult>;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const int = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'invalid', `${name} must be a positive integer`);
  return n;
};

const slotSchema = {
  type: 'object',
  properties: {
    champion: { type: 'string', description: 'Champion name, e.g. "Xin Zhao"' },
    player_name: { type: 'string', description: 'Player name (from champ select for allies, from the post-game scoreboard for both teams)' },
    role: { type: 'string', enum: ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'] },
    kills: { type: 'integer' },
    deaths: { type: 'integer' },
    assists: { type: 'integer' },
    lane: { type: 'integer', minimum: 0, maximum: 4, description: 'Row on the post-game scoreboard (0 = top … 4 = support); same lane = lane opponents' },
  },
  required: ['champion'],
};

const TOOLS: Tool[] = [
  {
    name: 'list_teams',
    description: 'All teams with player counts. Our own team has is_own_team = 1.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(_a, { env }) {
      const { results } = await env.DB.prepare(
        `SELECT t.id, t.name, t.tag, t.is_own_team, t.tournament, t.notes,
                (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS player_count
           FROM teams t ORDER BY t.is_own_team DESC, t.name COLLATE NOCASE`,
      ).all();
      return text(results);
    },
  },
  {
    name: 'get_team',
    description: "A team's roster, notes and recent drafts involving its players.",
    inputSchema: { type: 'object', properties: { team_id: { type: 'integer' } }, required: ['team_id'] },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const id = int(a.team_id, 'team_id');
      const team = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(id).first();
      if (!team) throw new HttpError(404, 'not_found', 'Team not found');
      const { results } = await env.DB.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY role, nickname').bind(id).all();
      const drafts = await listDrafts(env, { teamId: id, limit: 15 });
      return text({ team, players: results.map(parsePlayer), recent_drafts: drafts.map(compactDraft) });
    },
  },
  {
    name: 'get_player',
    description: "A player's details, champion pool from recorded drafts, recent drafts and VODs.",
    inputSchema: { type: 'object', properties: { player_id: { type: 'integer' } }, required: ['player_id'] },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const id = int(a.player_id, 'player_id');
      const player = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
      if (!player) throw new HttpError(404, 'not_found', 'Player not found');
      const { results: pool } = await env.DB.prepare(
        `SELECT champion, COUNT(*) AS games FROM draft_actions
          WHERE player_id = ? AND action = 'PICK' GROUP BY champion ORDER BY games DESC`,
      )
        .bind(id)
        .all();
      const { results: vods } = await env.DB.prepare(
        'SELECT id, title, url, started_at, duration_s, scan_status FROM vods WHERE player_id = ? ORDER BY started_at DESC LIMIT 10',
      )
        .bind(id)
        .all();
      const games = await playerGames(env, id);
      return text({
        player: parsePlayer(player),
        stats: summarizeGames(games),
        recent_games: games.slice(0, 20).map((g) => ({
          played_at: g.played_at, result: g.result, champion: g.champion, role: g.role,
          kda: g.kills !== null ? `${g.kills}/${g.deaths}/${g.assists}` : null,
          vs: g.opponent ? `${g.opponent.champion}${g.opponent.player_name ? ` (${g.opponent.player_name})` : ''}` : null,
          game_type: g.game_type,
        })),
        champion_pool_all_appearances: pool,
        vods,
      });
    },
  },
  {
    name: 'search',
    description: 'Find teams and players by (part of) name, nickname, Riot ID or channel.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const q = `%${String(a.query ?? '').trim().toLowerCase()}%`;
      const [teams, players] = await Promise.all([
        env.DB.prepare('SELECT id, name, tag FROM teams WHERE lower(name) LIKE ? OR lower(tag) LIKE ? LIMIT 20').bind(q, q).all(),
        env.DB.prepare(
          `SELECT p.id, p.nickname, p.role, p.riot_game_name, p.riot_tag_line, p.twitch_login, p.kick_slug, t.name AS team
             FROM players p LEFT JOIN teams t ON t.id = p.team_id
            WHERE lower(p.nickname) LIKE ? OR lower(p.riot_game_name) LIKE ? OR lower(p.twitch_login) LIKE ? OR lower(p.kick_slug) LIKE ?
            LIMIT 20`,
        )
          .bind(q, q, q, q)
          .all(),
      ]);
      return text({ teams: teams.results, players: players.results });
    },
  },
  {
    name: 'list_vods',
    description: 'Recent stream VODs, optionally for one team or player. scan_status tells whether the draft reader processed it.',
    inputSchema: {
      type: 'object',
      properties: { team_id: { type: 'integer' }, player_id: { type: 'integer' }, limit: { type: 'integer', maximum: 50 } },
    },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const where: string[] = [];
      const params: number[] = [];
      if (a.team_id) (where.push('p.team_id = ?'), params.push(int(a.team_id, 'team_id')));
      if (a.player_id) (where.push('v.player_id = ?'), params.push(int(a.player_id, 'player_id')));
      const limit = Math.min(Number(a.limit) || 20, 50);
      const { results } = await env.DB.prepare(
        `SELECT v.id, v.title, v.url, v.started_at, v.duration_s, v.channel_login, v.scan_status, p.nickname AS player
           FROM vods v LEFT JOIN players p ON p.id = v.player_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.started_at DESC LIMIT ${limit}`,
      )
        .bind(...params)
        .all();
      return text(results);
    },
  },
  {
    name: 'list_drafts',
    description: 'Saved drafts (picks and bans), newest first, optionally for a team, player or VOD.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'integer' },
        player_id: { type: 'integer' },
        vod_id: { type: 'integer' },
        limit: { type: 'integer', maximum: 50 },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const drafts = await listDrafts(env, {
        teamId: a.team_id ? int(a.team_id, 'team_id') : undefined,
        playerId: a.player_id ? int(a.player_id, 'player_id') : undefined,
        vodId: a.vod_id ? int(a.vod_id, 'vod_id') : undefined,
        limit: Number(a.limit) || 20,
      });
      return text(drafts.map(compactDraft));
    },
  },
  {
    name: 'list_drafts_for_review',
    description:
      'Draft screenshots the reader could not read with confidence. Each has the reader\'s best guess; open one with get_draft_frame.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 30 } } },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const limit = Math.min(Number(a.limit) || 10, 30);
      const { results } = await env.DB.prepare(
        `SELECT f.id AS frame_id, f.vod_id, f.ts_s, f.confidence, f.note, f.reading, v.title AS vod_title, v.url AS vod_url,
                p.nickname AS pov_player
           FROM draft_frames f JOIN vods v ON v.id = f.vod_id LEFT JOIN players p ON p.id = v.player_id
          WHERE f.status = 'review' ORDER BY f.created_at LIMIT ${limit}`,
      ).all<Json & { reading: string | null }>();
      const { count } = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM draft_frames WHERE status = 'review'`).first<{
        count: number;
      }>())!;
      return text({
        waiting_total: count,
        frames: results.map((r) => ({ ...r, reading: undefined, reader_guess: guessSummary(r.reading) })),
      });
    },
  },
  {
    name: 'get_draft_frame',
    description:
      "Shows a champion select screenshot from a VOD with the reader's guess. Left column = ally (streamer's team), right = enemy; bans are the small icons top-left (ally) and top-right (enemy). When the game was played out, a second image shows the post-game scoreboard (VICTORY/DEFEAT, names, champions, K/D/A in role order).",
    inputSchema: { type: 'object', properties: { frame_id: { type: 'integer' } }, required: ['frame_id'] },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const id = int(a.frame_id, 'frame_id');
      const row = await env.DB.prepare(
        `SELECT f.image, f.postgame_image, f.vod_id, f.ts_s, f.reading, f.status, f.note, v.url AS vod_url, p.nickname AS pov_player
           FROM draft_frames f JOIN vods v ON v.id = f.vod_id LEFT JOIN players p ON p.id = v.player_id WHERE f.id = ?`,
      )
        .bind(id)
        .first<{ image: number[]; postgame_image: number[] | null; vod_id: number; ts_s: number; reading: string | null; status: string; note: string | null; vod_url: string; pov_player: string | null }>();
      if (!row) throw new HttpError(404, 'not_found', 'Frame not found');
      const b64 = toBase64(new Uint8Array(row.image));
      const t = row.ts_s;
      const at = `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
      return {
        content: [
          { type: 'image', data: b64, mimeType: 'image/jpeg' },
          ...(row.postgame_image ? [{ type: 'image', data: toBase64(new Uint8Array(row.postgame_image)), mimeType: 'image/jpeg' }] : []),
          {
            type: 'text',
            text: JSON.stringify(
              {
                frame_id: id,
                status: row.status,
                vod_id: row.vod_id,
                vod_link: `${row.vod_url}?t=${at}`,
                pov_player: row.pov_player,
                reader_guess: guessSummary(row.reading),
                reader_note: row.note,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  },
  {
    name: 'save_draft',
    description:
      'Saves a draft. Give frame_id when it comes from a review frame (VOD and time are taken from it). Champions must be real champion names; ally = left column, enemy = right column, in top-to-bottom order.',
    inputSchema: {
      type: 'object',
      properties: {
        frame_id: { type: 'integer' },
        vod_id: { type: 'integer', description: 'Only when not using frame_id' },
        ts_s: { type: 'integer', description: 'Seconds into the VOD, only when not using frame_id' },
        ally: { type: 'array', items: slotSchema, minItems: 1, maxItems: 5 },
        enemy: { type: 'array', items: slotSchema, minItems: 1, maxItems: 5 },
        ally_bans: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        enemy_bans: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        result: { type: 'string', enum: ['WIN', 'LOSS'], description: 'From the ally (streamer) side: VICTORY = WIN, DEFEAT = LOSS' },
        game_type: { type: 'string', description: 'e.g. Custom, Normal Draft, Ranked Solo/Duo' },
        duration_s: { type: 'integer' },
        notes: { type: 'string' },
      },
      required: ['ally', 'enemy'],
    },
    async run(args, { env, user }) {
      let a = args;
      let vodId = a.vod_id ? int(a.vod_id, 'vod_id') : null;
      let ts = typeof a.ts_s === 'number' ? Math.round(a.ts_s) : null;
      let frameId: number | null = null;
      if (a.frame_id) {
        frameId = int(a.frame_id, 'frame_id');
        const f = await env.DB.prepare('SELECT vod_id, ts_s, status, reading FROM draft_frames WHERE id = ?')
          .bind(frameId)
          .first<{ vod_id: number; ts_s: number; status: string; reading: string | null }>();
        if (!f) throw new HttpError(404, 'not_found', 'Frame not found');
        if (f.status === 'accepted') throw new HttpError(409, 'already_saved', 'This frame already has a saved draft');
        vodId = f.vod_id;
        ts = f.ts_s;
        // Keep the reader's post-game scoreboard (result, names, K/D/A) unless Claude gave its own.
        try {
          const pg = f.reading ? JSON.parse(f.reading).postgame : null;
          if (pg && a.postgame === undefined) a = { ...a, postgame: pg };
        } catch {}
      }
      const draft = await validateDraft(env, { ...(a as unknown as DraftInput), vod_id: vodId, ts_s: ts });
      const matchId = await saveDraft(env, draft, { kind: 'claude', userId: user.id });
      if (frameId) {
        await env.DB.prepare(`UPDATE draft_frames SET status = 'accepted', match_id = ? WHERE id = ?`).bind(matchId, frameId).run();
      }
      return text({ ok: true, match_id: matchId });
    },
  },
  {
    name: 'discard_draft_frame',
    description: "Marks a review frame as not a usable draft (dodge, lobby, wrong screen, unreadable).",
    inputSchema: {
      type: 'object',
      properties: { frame_id: { type: 'integer' }, reason: { type: 'string' } },
      required: ['frame_id', 'reason'],
    },
    annotations: { destructiveHint: false },
    async run(a, { env, user }) {
      const id = int(a.frame_id, 'frame_id');
      const res = await env.DB.prepare(`UPDATE draft_frames SET status = 'discarded', note = ? WHERE id = ? AND status = 'review'`)
        .bind(String(a.reason ?? '').slice(0, 500), id)
        .run();
      if (!res.meta.changes) throw new HttpError(404, 'not_found', 'No frame waiting for review with this id');
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'frame.discard', 'frame', id, { reason: a.reason });
      return text({ ok: true });
    },
  },
  {
    name: 'add_scouting_note',
    description: 'Adds a scouting note to a team, player or saved draft (match).',
    inputSchema: {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['team', 'player', 'match'] },
        target_id: { type: 'integer' },
        text: { type: 'string' },
      },
      required: ['target_type', 'target_id', 'text'],
    },
    async run(a, { env, user }) {
      const type = String(a.target_type);
      if (!['team', 'player', 'match'].includes(type)) throw new HttpError(400, 'invalid', 'target_type must be team, player or match');
      const id = int(a.target_id, 'target_id');
      const body = String(a.text ?? '').trim().slice(0, 5000);
      if (!body) throw new HttpError(400, 'invalid', 'text is empty');
      const table = type === 'match' ? 'matches' : `${type}s`;
      if (!(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first())) {
        throw new HttpError(404, 'not_found', `${type} ${id} not found`);
      }
      const res = await env.DB.prepare(
        `INSERT INTO notes (target_type, target_id, body, author_kind, author_user_id) VALUES (?, ?, ?, 'claude', ?)`,
      )
        .bind(type, id, body, user.id)
        .run();
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'note.add', type, id);
      return text({ ok: true, note_id: res.meta.last_row_id });
    },
  },
  {
    name: 'add_team',
    description: 'Creates a team.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tag: { type: 'string' },
        is_own_team: { type: 'boolean' },
        tournament: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
    async run(a, { env, user }) {
      const fields = teamFields(a, false);
      const id = await insert(env.DB, 'teams', { ...fields, created_by: user.id });
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'team.create', 'team', id, { name: fields.name });
      return text({ ok: true, team_id: id });
    },
  },
  {
    name: 'add_player',
    description: "Adds a player to a team. Twitch/Kick accept a channel name or link; the player's Twitch VODs are fetched right away.",
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'integer' },
        nickname: { type: 'string' },
        role: { type: 'string', enum: ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'SUB'] },
        riot_id: { type: 'string', description: 'GameName#TAG' },
        twitch_login: { type: 'string' },
        kick_slug: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['team_id', 'nickname'],
    },
    async run(a, { env, user }) {
      const teamId = int(a.team_id, 'team_id');
      if (!(await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(teamId).first())) {
        throw new HttpError(404, 'not_found', 'Team not found');
      }
      const fields = playerFields(a, false);
      const id = await insert(env.DB, 'players', { ...fields, team_id: teamId });
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'player.create', 'player', id, { nickname: fields.nickname, team_id: teamId });
      await relinkDraftPlayers(env);
      if (fields.twitch_login) await syncTwitchVods(env, [String(fields.twitch_login)]).catch(() => {});
      return text({ ok: true, player_id: id });
    },
  },
  {
    name: 'rescan_vod',
    description: 'Queues a VOD to be scanned by the draft reader again.',
    inputSchema: { type: 'object', properties: { vod_id: { type: 'integer' } }, required: ['vod_id'] },
    async run(a, { env, user }) {
      const id = int(a.vod_id, 'vod_id');
      const res = await env.DB.prepare(`UPDATE vods SET scan_status = 'pending', scanned_at = NULL WHERE id = ?`).bind(id).run();
      if (!res.meta.changes) throw new HttpError(404, 'not_found', 'VOD not found');
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'vod.rescan', 'vod', id);
      return text({ ok: true });
    },
  },
  {
    name: 'get_schedule',
    description:
      "Our team's schedule (harmonogram): tournament matches (kind 'match'), scrims ('scrim') and other events like training ('other'). " +
      'Upcoming events first (soonest first), then recently played ones. Times are given in UTC and in Prague local time. ' +
      'opponent_team_id links to the opponent for get_team / scouting.',
    inputSchema: {
      type: 'object',
      properties: {
        include_past: { type: 'integer', minimum: 0, maximum: 50, description: 'How many played events to include (default 5)' },
        kind: { type: 'string', enum: ['match', 'scrim', 'other'], description: 'Only this type of event' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const all = await listSchedule(env, { kind: a.kind ? String(a.kind) : undefined });
      const now = Date.now();
      // A match counts as upcoming until 3 hours after its start (a Bo3 can run long).
      const isUpcoming = (m: { starts_at: string }) => new Date(m.starts_at).getTime() + 3 * 3600_000 > now;
      const past = all.filter((m) => !isUpcoming(m)).reverse().slice(0, Math.min(Number(a.include_past ?? 5) || 0, 50));
      return text({
        now_prague: formatPrague(new Date().toISOString()),
        upcoming: all.filter(isUpcoming).map(compactScheduled),
        recent: past.map(compactScheduled),
      });
    },
  },
  {
    name: 'add_scheduled_match',
    description:
      'Adds an event to our schedule: a tournament match (kind "match", default), a scrim ("scrim") or something else like training ("other", needs title). ' +
      'starts_at: "YYYY-MM-DD HH:MM" in Prague time (or ISO with a zone). For matches and scrims give opponent_team_id when the opponent is in the app ' +
      '(list_teams/search), otherwise opponent_name. Ask Dao before adding.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['match', 'scrim', 'other'] },
        title: { type: 'string', description: 'Name of an "other" event, e.g. "Trénink", "Review VODek"' },
        starts_at: { type: 'string', description: 'e.g. "2026-11-02 18:00" (Prague time)' },
        opponent_team_id: { type: 'integer' },
        opponent_name: { type: 'string', description: 'Only when the opponent team is not in the app' },
        format: { type: 'string', enum: ['BO1', 'BO2', 'BO3', 'BO5'] },
        stage: { type: 'string', description: 'e.g. "Skupina A – 2. kolo", "Playoff"' },
        location: { type: 'string' },
        stream_url: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['starts_at'],
    },
    async run(a, { env, user }) {
      const fields = await scheduleFields(env.DB, a, false);
      requireOpponent(fields);
      const id = await insert(env.DB, 'schedule', { ...fields, created_by_kind: 'claude', created_by: user.id });
      const [m] = await listSchedule(env, { id });
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'schedule.create', 'schedule', id, { name: opponentLabel(m), kind: m.kind });
      return text({ ok: true, match: compactScheduled(m) });
    },
  },
  {
    name: 'update_scheduled_match',
    description:
      'Changes a schedule event: move it, change its type, opponent or format, or fill in the result (our_score / their_score, e.g. 2 and 1 for a 2:1 Bo3 win). ' +
      'Only the fields you pass are changed. Ask Dao before changing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        kind: { type: 'string', enum: ['match', 'scrim', 'other'] },
        title: { type: 'string', description: 'Name of an "other" event, e.g. "Trénink", "Review VODek"' },
        starts_at: { type: 'string' },
        opponent_team_id: { type: 'integer' },
        opponent_name: { type: 'string' },
        format: { type: 'string', enum: ['BO1', 'BO2', 'BO3', 'BO5'] },
        stage: { type: 'string' },
        location: { type: 'string' },
        stream_url: { type: 'string' },
        our_score: { type: 'integer', minimum: 0, maximum: 9 },
        their_score: { type: 'integer', minimum: 0, maximum: 9 },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
    async run(a, { env, user }) {
      const id = int(a.id, 'id');
      const [current] = await listSchedule(env, { id });
      if (!current) throw new HttpError(404, 'not_found', `Scheduled match ${id} not found`);
      const { id: _id, ...rest } = a;
      const fields = await scheduleFields(env.DB, rest, true);
      requireOpponent({ ...current, ...fields });
      await update(env.DB, 'schedule', id, fields);
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'schedule.update', 'schedule', id, { name: opponentLabel(current), kind: current.kind });
      const [m] = await listSchedule(env, { id });
      return text({ ok: true, match: compactScheduled(m) });
    },
  },
  {
    name: 'get_coaching',
    description:
      'Coaching material for our team: folders per player (e.g. "Supp – tank", "Supp – heal") or team-wide, rune pages, coaching notes ' +
      'and ward maps (only counts and labels of the markers – the map itself is drawn by Dao in the app). ' +
      'Without player_id returns everything; player_id narrows to one player (team-wide items are always included).',
    inputSchema: { type: 'object', properties: { player_id: { type: 'integer' } } },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const data = await loadCoaching(env);
      const runeData = await getRuneData(env).catch(() => null);
      const pid = a.player_id ? int(a.player_id, 'player_id') : null;
      const inScope = (x: Record<string, any>) => !pid || x.player_id === null || x.player_id === pid;
      const folders = (data.folders as { id: number; player_id: number | null; name: string }[]).filter(inScope);
      const folderName = (id: unknown) => folders.find((f) => f.id === id)?.name ?? null;
      const playerName = (id: unknown) => (data.players as { id: number; nickname: string }[]).find((p) => p.id === id)?.nickname ?? (id ? `player ${id}` : 'Tým');
      return text({
        players: data.players,
        folders: folders.map((f) => ({ id: f.id, name: f.name, player: playerName(f.player_id), player_id: f.player_id })),
        rune_pages: (data.runes as Record<string, any>[]).filter(inScope).map((r) => ({
          id: r.id, player: playerName(r.player_id), folder: folderName(r.folder_id), title: r.title, champion: r.champion,
          ...(runeData ? describeRunePage(runeData, r as any) : {}), notes: r.notes,
        })),
        ward_maps: (data.maps as Record<string, any>[]).filter(inScope).map((m) => {
          const markers = JSON.parse(m.markers || '[]') as { type: string; x: number; y: number; label?: string }[];
          const counts: Record<string, number> = {};
          for (const k of markers) counts[k.type] = (counts[k.type] ?? 0) + 1;
          return {
            id: m.id, player: playerName(m.player_id), folder: folderName(m.folder_id), title: m.title, side: m.side, notes: m.notes,
            marker_counts: counts,
            labelled_markers: markers.filter((k) => k.label).map((k) => ({ type: k.type, label: k.label })),
          };
        }),
        notes: (data.notes as Record<string, any>[]).filter(inScope).map((n) => ({
          id: n.id, player: playerName(n.player_id), folder: folderName(n.folder_id), title: n.title, body: n.body,
          pinned: !!n.pinned, author: n.author_kind === 'claude' ? 'Claude' : n.author_name, updated_at: n.updated_at,
        })),
      });
    },
  },
  {
    name: 'add_coaching_folder',
    description: 'Creates a coaching folder for a player (or team-wide without player_id), e.g. "Supp – tank". Ask Dao first.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, player_id: { type: 'integer' } },
      required: ['name'],
    },
    async run(a, { env, user }) {
      const id = await createFolder(env, { kind: 'claude', userId: user.id }, a);
      return text({ ok: true, folder_id: id });
    },
  },
  {
    name: 'add_coaching_note',
    description:
      'Writes a coaching note (zápisek) for a player, into a folder, or team-wide (neither player_id nor folder_id). ' +
      'Pass id to update an existing note. Write in Czech. Ask Dao before saving.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Existing note to update' },
        player_id: { type: 'integer' },
        folder_id: { type: 'integer' },
        title: { type: 'string' },
        body: { type: 'string' },
        pinned: { type: 'boolean' },
      },
      required: ['body'],
    },
    async run(a, { env, user }) {
      const { id, ...rest } = a;
      const noteId = await saveNote(env, { kind: 'claude', userId: user.id }, rest, id ? int(id, 'id') : undefined);
      return text({ ok: true, note_id: noteId });
    },
  },
  {
    name: 'save_rune_page',
    description:
      'Creates or updates (with id) a rune page in coaching. Runes, paths, shards and summoners can be given by English name. ' +
      'perks = [keystone, primary row 1, row 2, row 3, secondary rune A, secondary rune B]; shards = [offense, flex, defense], ' +
      'e.g. ["Adaptive Force", "Adaptive Force", "Health"]; summoners e.g. ["Flash", "Ignite"]. Ask Dao before saving.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        player_id: { type: 'integer' },
        folder_id: { type: 'integer' },
        title: { type: 'string', description: 'e.g. "Tank supp – engage"' },
        champion: { type: 'string', description: 'Optional – leave out for general pages like "Supp – tank"' },
        primary_style: { type: 'string', description: 'Precision, Domination, Sorcery, Resolve or Inspiration' },
        secondary_style: { type: 'string' },
        perks: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        shards: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        summoners: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        notes: { type: 'string' },
      },
    },
    async run(a, { env, user }) {
      const { id, ...rest } = a;
      const pageId = await saveRunePage(env, { kind: 'claude', userId: user.id }, rest, id ? int(id, 'id') : undefined);
      return text({ ok: true, rune_page_id: pageId });
    },
  },
  {
    name: 'get_activity',
    description: 'Recent changes in the app (who added or changed what), newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 100 } } },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const limit = Math.min(Number(a.limit) || 30, 100);
      const { results } = await env.DB.prepare(
        `SELECT a.created_at, a.actor_kind, u.display_name AS actor, a.action, a.target_type, a.target_id, a.details
           FROM activity_log a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT ${limit}`,
      ).all();
      return text(results);
    },
  },
];

function compactScheduled(m: ScheduledMatch) {
  return {
    id: m.id,
    kind: m.kind,
    type: KIND_LABELS[m.kind] ?? m.kind,
    starts_at_utc: m.starts_at,
    starts_at_prague: formatPrague(m.starts_at),
    ...(m.kind === 'other' ? { title: m.title } : { opponent: opponentLabel(m) }),
    opponent_team_id: m.opponent_team_id,
    format: m.format,
    stage: m.stage,
    location: m.location,
    stream_url: m.stream_url,
    score: m.our_score !== null && m.their_score !== null ? `${m.our_score}:${m.their_score}` : null,
    result: matchResult(m),
    notes: m.notes,
  };
}

function compactDraft(d: Json & { actions?: Json[] }) {
  const acts = (d.actions ?? []) as {
    side: string; action: string; champion: string; player_name: string | null; role: string | null;
    kills: number | null; deaths: number | null; assists: number | null;
  }[];
  const pick = (side: string) =>
    acts
      .filter((x) => x.side === side && x.action === 'PICK')
      .map((x) => [x.role, x.champion, x.player_name && `(${x.player_name})`, x.kills !== null && `${x.kills}/${x.deaths}/${x.assists}`].filter(Boolean).join(' '));
  const ban = (side: string) => acts.filter((x) => x.side === side && x.action === 'BAN').map((x) => x.champion);
  return {
    match_id: d.id,
    played_at: d.played_at,
    result: d.result,
    game_type: d.game_type,
    duration_s: d.duration_s,
    pov_player: d.pov_nickname,
    source: d.created_by_kind,
    vod: d.vod_url ? `${d.vod_url}${d.vod_timestamp_s ? `?t=${d.vod_timestamp_s}s` : ''}` : null,
    ally: pick('ALLY'),
    enemy: pick('ENEMY'),
    ally_bans: ban('ALLY'),
    enemy_bans: ban('ENEMY'),
    notes: d.notes,
  };
}

function guessSummary(reading: string | null) {
  if (!reading) return null;
  try {
    const r = JSON.parse(reading) as {
      ocr?: { ally?: { champion: string | null; score: number }[]; enemy?: { champion: string | null; score: number }[] };
      ally?: { champion: string; player_name?: string | null }[];
      ally_bans?: string[];
      enemy_bans?: string[];
    };
    const fmt = (l?: { champion: string | null; score: number }[]) =>
      (l ?? []).map((s) => (s.champion ? `${s.champion} (${Math.round(s.score)}%)` : '?'));
    const pg = (r as { postgame?: Record<string, unknown> }).postgame;
    return {
      ally: fmt(r.ocr?.ally),
      enemy: fmt(r.ocr?.enemy),
      ally_players: (r.ally ?? []).map((s) => s.player_name ?? null),
      ally_bans: r.ally_bans ?? [],
      enemy_bans: r.enemy_bans ?? [],
      postgame: pg ?? null,
    };
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// --- JSON-RPC over HTTP -----------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Json;
}

function rpcResult(id: RpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function dispatch(msg: RpcRequest, env: Env, user: User): Promise<unknown | null> {
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sc-scouting', title: 'SGooBovo šedl scouting', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const args = (msg.params?.arguments ?? {}) as Json;
        return rpcResult(msg.id, await tool.run(args, { env, user }));
      } catch (err) {
        // Tool errors go back to the model as a result it can read and fix, not as a protocol error.
        const message = err instanceof HttpError ? err.message : 'Internal error';
        if (!(err instanceof HttpError)) console.error('MCP tool error', name, err);
        return rpcResult(msg.id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized etc.
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Request, env: Env, url: URL): Promise<Response> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const user = await userFromBearer(req, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  // No server-initiated streams: GET (SSE) isn't offered, sessions are stateless.
  if (req.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { ...cors, Allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withHeaders(json(rpcError(null, -32700, 'Parse error'), 400), cors);
  }

  const messages = (Array.isArray(body) ? body : [body]) as RpcRequest[];
  const responses = [];
  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Responses from the client (to our requests) or junk: nothing to answer.
      continue;
    }
    const out = await dispatch(msg, env, user);
    if (out) responses.push(out);
  }
  if (!responses.length) return new Response(null, { status: 202, headers: cors });
  return withHeaders(json(Array.isArray(body) ? responses : responses[0]), cors);
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
