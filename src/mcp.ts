import type { Env } from './index';
import { insert, parsePlayer, playerFields, teamFields, update } from './api';
import {
  formatPrague, isUpcoming, KIND_LABELS, listSchedule, matchResult, opponentLabel, requireOpponent, scheduleFields, type ScheduledMatch,
} from './schedule';
import { isSuperadmin, logActivity, type User } from './db';
import { listDrafts, playerGames, relinkDraftPlayers, saveDraft, summarizeGames, teamGameCheck, validateDraft, type DraftInput } from './drafts';
import { assertBodySize, HttpError, json } from './http';
import { userFromBearer } from './oauth';
import { syncTwitchVods } from './vods';
import { createFolder, getShotImage, loadCoaching, saveNote, savePool, saveRunePage, TIER_LABELS } from './coaching';
import { describeRunePage, getRuneData } from './runes';
import { createItem, createTab, loadPlan, PRIORITY_LABELS, requireSuperadmin, updateItem, updateTab } from './plan';
import { handleQueueApi, streamGuard } from './queue';
import { compactTournament, freeSlot, listTournament, SLOTS, tournamentFields, tournamentLabel } from './tournament';

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
Only team games are kept: at least 4 of the ally names must be players of the streamer's team (5, or 4 when a sub plays).
Solo queue / Streamers Queue games with random teammates are discarded (save_draft refuses them with not_team_game).
Coaching: get_coaching shows rune pages and coaching notes per player and folder; write notes with add_coaching_note.
Schedule: get_schedule lists our tournament matches, scrims and other events; the next opponent's opponent_team_id is the team to scout.
Coaching plan (superadmin only): get_coach_plan shows the coach's strategic plan – tabs with a goal and items to tick off when learned; add_coach_plan_items, update_coach_plan_item, save_coach_plan_tab change it. Items already done were learned – don't suggest them again.
Tournament: get_tournament lists every match of the whole tournament (all teams: group match days and the play-off bracket); assign teams and results with update_tournament_match.
Streamers Queue (the player auction before the tournament, admins only): queue_players lists players with price, role and the admins' scouting;
queue_draft_state shows the essence calculator budget (SGooB is our captain and jungler, 4 more players to buy), saved variants and who is already picked;
save_queue_variant / delete_queue_variant manage variants, set_queue_pick marks the real draft (us / other / free), get_pick_simulation / save_pick_simulation
the per-admin simulation of all captains' teams. After the draft, add_queue_player_to_team puts players into app teams (Riot ID from their profile) and
update_player sets Twitch/Kick channels so their VODs get fetched.
Reply to the user in Czech.`

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

const QROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];

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
      const b64 = row.image?.length ? toBase64(new Uint8Array(row.image)) : null;
      const t = row.ts_s;
      const at = `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
      return {
        content: [
          ...(b64 ? [{ type: 'image', data: b64, mimeType: 'image/jpeg' }] : []),
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
        not_team_game_ok: { type: 'boolean', description: 'Save even if fewer than 4 ally players are on the streamer\'s team. Only when the user confirmed it is a team game.' },
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
      if (!a.not_team_game_ok) {
        const tg = await teamGameCheck(env, draft);
        if (!tg.ok) {
          throw new HttpError(422, 'not_team_game', `Not a team game: only ${tg.matched} of the required ${tg.need} players of ${tg.team ?? 'the team'} are on the streamer's side (${tg.names.join(', ') || '–'}). Discard the frame with discard_draft_frame (reason "není týmová hra"), unless the ally names were misread – then fix player_name and retry, or pass not_team_game_ok: true if the user confirmed it is a team game.`);
        }
      }
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
  // --- Streamers Queue: players, essence calculator variants, picks, pick simulation ---
  {
    name: 'queue_players',
    description: 'Players of the Streamers Queue (the player auction before the tournament) with the admins\' scouting: price from the organizer\'s Excel, draft role, queue W/L, favourite roles, "blocked" (= we don\'t want him), "gone" (left the tournament), note, and picked state from the real draft ("us" = we got him, "other" = another team took him). Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: QROLES },
        search: { type: 'string', description: 'Part of a nickname' },
        priced_only: { type: 'boolean', description: 'Only players with a price (= in the auction). Default true.' },
        include_taken: { type: 'boolean', description: 'Include players another team already took. Default true.' },
        limit: { type: 'integer', description: 'Default 200' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a, { env, user }) {
      await requireQueue(env, user);
      const [{ results }, picked] = await Promise.all([
        env.DB.prepare(
          `SELECT p.key, p.nickname, p.wins, p.losses, p.games, p.elo, s.price, s.draft_role, s.is_captain, s.fav_roles, s.blocked, s.gone, s.note
             FROM queue_players p LEFT JOIN queue_scout s ON s.player_key = p.key`,
        ).all<Record<string, unknown>>(),
        env.DB.prepare(`SELECT v FROM queue_meta WHERE k = 'draft_picked'`).first<{ v: string }>(),
      ]);
      const pk = (picked ? JSON.parse(picked.v) : {}) as Record<string, string>;
      const f = a.search ? foldName(String(a.search)) : '';
      const list = results
        .filter((r) => (a.priced_only === false || r.price != null) && (!a.role || r.draft_role === a.role)
          && (!f || foldName(String(r.nickname)).includes(f)) && (a.include_taken !== false || pk[String(r.key)] !== 'other'))
        .sort((x, y) => Number(y.price ?? -1) - Number(x.price ?? -1) || Number(y.wins) - Number(x.wins))
        .slice(0, Math.min(Number(a.limit) || 200, 700))
        .map((r) => ({
          player: r.nickname, role: r.draft_role ?? null, price: r.price ?? null, captain: !!r.is_captain || undefined,
          queue: `${r.wins}W ${r.losses}L`, winrate: Number(r.games) ? Math.round((Number(r.wins) / Number(r.games)) * 100) : null, elo: r.elo ?? undefined,
          fav_roles: r.fav_roles && r.fav_roles !== '[]' ? JSON.parse(String(r.fav_roles)) : undefined,
          blocked: r.blocked ? true : undefined, gone: r.gone ? true : undefined, picked: pk[String(r.key)] ?? undefined,
          note: r.note || undefined,
        }));
      return text({ count: list.length, players: list });
    },
  },
  {
    name: 'queue_draft_state',
    description: 'The essence calculator ("Výpočet essence"): budget (start essence, our captain SGooB\'s price – he is the jungler, 4 more players to buy), the current user\'s calculator selection, every saved variant (author, players in priority order with prices, essence left), the picked state from the real draft and the shared notes under Varianty. Admin only.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(_a, { env, user }) {
      await requireQueue(env, user);
      const d = await queueCall(env, user, 'GET', '/api/queue/draft');
      const players = new Map(((d.players as Json[]) || []).map((p) => [String(p.key), p]));
      const nick = (k: string) => String(players.get(k)?.nickname ?? k);
      const picked = (d.picked || {}) as Record<string, string>;
      const plan = (d.plan as { start: number; captain_price: number; picks: { key: string; price: number | null }[] }) || { start: 1000, captain_price: 325, picks: [] };
      const show = (v: { start: number; captain_price: number; picks: { key: string; nickname?: string; price: number | null }[] }) => {
        const picks = v.picks.map((x, i) => {
          const p = players.get(x.key);
          const price = x.price ?? (p?.price as number | null) ?? 0;
          return { priority: i + 1, player: p ? nick(x.key) : x.nickname ?? x.key, role: p?.draft_role ?? null, price, picked: picked[x.key] ?? undefined, gone: p?.gone ? true : undefined };
        });
        return { start: v.start, captain_price: v.captain_price, players: picks, essence_left: v.start - v.captain_price - picks.reduce((s2, x) => s2 + x.price, 0) };
      };
      return text({
        budget: { start: plan.start, captain: 'SGooB (JUNGLE)', captain_price: plan.captain_price, slots: 4 },
        my_calculator: show(plan),
        variants: ((d.variants as Json[]) || []).map((v) => ({ id: v.id, name: v.name, author: v.author, mine: v.mine, ...show(v as never) })),
        picked: Object.fromEntries(Object.entries(picked).map(([k, st]) => [nick(k), st])),
        notes: (d.notes as { text?: string } | null)?.text || undefined,
      });
    },
  },
  {
    name: 'save_queue_variant',
    description: 'Saves a variant of our team for the essence calculator (visible to all admins under Varianty). Players in priority order (who we want first), up to 4, ideally one per missing role (TOP, MID, ADC, SUPPORT – SGooB is the jungler). price = expected auction price if different from the Excel price. Saving under an existing name of yours overwrites it. The same set of players can\'t be saved twice. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Variant name, e.g. "Agresivní bot"' },
        players: {
          type: 'array', maxItems: 4,
          items: { type: 'object', properties: { player: { type: 'string', description: 'Nickname' }, price: { type: 'number' } }, required: ['player'] },
        },
        start: { type: 'number', description: 'Start essence (default: from the calculator, usually 1000)' },
        captain_price: { type: 'number', description: 'SGooB\'s price (default: from the calculator, usually 325)' },
      },
      required: ['name', 'players'],
    },
    async run(a, { env, user }) {
      await requireQueue(env, user);
      const list = Array.isArray(a.players) ? (a.players as Json[]) : [];
      if (!list.length || list.length > 4) throw new HttpError(400, 'invalid', 'A variant has 1–4 players.');
      const [rows, d] = await Promise.all([queueRoster(env), queueCall(env, user, 'GET', '/api/queue/draft')]);
      const picked = (d.picked || {}) as Record<string, string>;
      const plan = (d.plan as { start?: number; captain_price?: number } | null) || {};
      const picks = list.map((x) => {
        const r = resolveQueuePlayer(rows, x.player);
        if (r.is_captain) throw new HttpError(400, 'invalid', `${r.nickname} is a captain, not in the auction.`);
        return { r, price: x.price === undefined || x.price === null ? null : Number(x.price) };
      });
      const keys = picks.map((x) => x.r.key);
      if (new Set(keys).size !== keys.length) throw new HttpError(400, 'invalid', 'A player is in the list twice.');
      const start = a.start != null ? Number(a.start) : plan.start ?? 1000;
      const captain = a.captain_price != null ? Number(a.captain_price) : plan.captain_price ?? 325;
      await queueCall(env, user, 'POST', '/api/queue/variants', {
        name: String(a.name ?? ''), start, captain_price: captain,
        picks: picks.map((x) => ({ key: x.r.key, nickname: x.r.nickname, price: x.price })),
      });
      const cost = picks.reduce((s2, x) => s2 + (x.price ?? x.r.price ?? 0), 0);
      const roles = new Set(['JUNGLE', ...picks.map((x) => x.r.draft_role)]);
      const warnings = [
        ...picks.filter((x) => x.r.price == null && x.price == null).map((x) => `${x.r.nickname} has no price (not in the auction?)`),
        ...picks.filter((x) => picked[x.r.key] === 'other').map((x) => `${x.r.nickname} was already taken by another team`),
        ...picks.filter((x) => x.r.gone).map((x) => `${x.r.nickname} left the tournament`),
        ...picks.filter((x) => x.r.blocked).map((x) => `${x.r.nickname} is marked as unwanted`),
        ...QROLES.filter((r) => !roles.has(r)).map((r) => `no ${r}`),
        ...(start - captain - cost < 0 ? [`over budget by ${captain + cost - start}`] : []),
      ];
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'queue.variant', null, null, { name: a.name, players: picks.map((x) => x.r.nickname) });
      return text({ ok: true, essence_left: start - captain - cost, warnings: warnings.length ? warnings : undefined });
    },
  },
  {
    name: 'delete_queue_variant',
    description: 'Deletes a saved variant (only your own; the superadmin can delete any). Get ids from queue_draft_state.',
    inputSchema: { type: 'object', properties: { variant_id: { type: 'integer' } }, required: ['variant_id'] },
    annotations: { destructiveHint: true },
    async run(a, { env, user }) {
      await requireQueue(env, user);
      await queueCall(env, user, 'DELETE', `/api/queue/variants/${int(a.variant_id, 'variant_id')}`);
      return text({ ok: true });
    },
  },
  {
    name: 'set_queue_pick',
    description: 'Marks a player in the real draft (shared by all admins, shown in Varianty and the essence calculator): "us" = we got him, "other" = another team took him, "free" = still available.',
    inputSchema: {
      type: 'object',
      properties: { player: { type: 'string' }, state: { type: 'string', enum: ['us', 'other', 'free'] } },
      required: ['player', 'state'],
    },
    async run(a, { env, user }) {
      await requireQueue(env, user);
      const r = resolveQueuePlayer(await queueRoster(env), a.player);
      await queueCall(env, user, 'PUT', '/api/queue/picked', { key: r.key, state: a.state === 'free' ? null : a.state });
      return text({ ok: true, player: r.nickname, state: a.state });
    },
  },
  {
    name: 'get_pick_simulation',
    description: 'The user\'s own pick simulation ("Simulace picku"): which players each captain buys and for how much. Lists the captains (with their role and price) and the current board. Admin only.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(_a, { env, user }) {
      await requireQueue(env, user);
      const d = await queueCall(env, user, 'GET', '/api/queue/sim');
      const players = (d.players as Json[]) || [];
      const nick = new Map(players.map((p) => [String(p.key), p]));
      const board = (d.board as { start: number; cap_roles: Record<string, string>; teams: Record<string, { key: string; price: number | null }[]> } | null);
      return text({
        captains: players.filter((p) => p.is_captain).map((p) => ({ captain: p.nickname, role: board?.cap_roles?.[String(p.key)] ?? p.draft_role ?? null, price: p.price })),
        start: board?.start ?? (d.plan as { start?: number } | null)?.start ?? 1000,
        teams: board ? Object.fromEntries(Object.entries(board.teams).map(([cap, l]) => [String(nick.get(cap)?.nickname ?? cap), l.map((x) => ({
          player: nick.get(x.key)?.nickname ?? x.key, role: nick.get(x.key)?.draft_role ?? null, price: x.price ?? nick.get(x.key)?.price ?? null,
        }))])) : {},
      });
    },
  },
  {
    name: 'save_pick_simulation',
    description: 'Replaces the user\'s pick simulation: for each captain the players he buys (one per role besides the captain\'s own role, a player can be in one team only), price = auction price if different from the Excel. Captains not listed keep an empty team. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'Start essence per captain (default 1000)' },
        teams: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              captain: { type: 'string' },
              captain_role: { type: 'string', enum: QROLES, description: 'Only when the captain\'s role should change' },
              players: { type: 'array', maxItems: 5, items: { type: 'object', properties: { player: { type: 'string' }, price: { type: 'number' } }, required: ['player'] } },
            },
            required: ['captain', 'players'],
          },
        },
      },
      required: ['teams'],
    },
    async run(a, { env, user }) {
      await requireQueue(env, user);
      const [rows, d] = await Promise.all([queueRoster(env), queueCall(env, user, 'GET', '/api/queue/sim')]);
      const prev = (d.board as { start?: number; cap_roles?: Record<string, string> } | null) || {};
      const capRoles: Record<string, string> = { ...(prev.cap_roles || {}) };
      const teams: Record<string, { key: string; price: number | null }[]> = {};
      for (const t of (Array.isArray(a.teams) ? a.teams : []) as Json[]) {
        const cap = resolveQueuePlayer(rows.filter((r) => r.is_captain), t.captain);
        if (t.captain_role) capRoles[cap.key] = String(t.captain_role);
        teams[cap.key] = ((t.players as Json[]) || []).map((x) => {
          const r = resolveQueuePlayer(rows.filter((q) => !q.is_captain), x.player);
          return { key: r.key, price: x.price === undefined || x.price === null ? null : Number(x.price) };
        });
      }
      await queueCall(env, user, 'PUT', '/api/queue/sim', { start: a.start ?? prev.start ?? 1000, cap_roles: capRoles, teams });
      return text({ ok: true, teams: Object.keys(teams).length });
    },
  },
  {
    name: 'add_queue_player_to_team',
    description: 'Adds a Streamers Queue player to a team in the app (e.g. after the real draft, to scout the opponents): creates the player with his best Riot ID from his Streamers Clash profile, linked to his queue stats. Twitch/Kick channel (name or link) is set too, and his Twitch VODs are fetched right away. Use list_teams/add_team for the team.',
    inputSchema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: 'Queue nickname' },
        team_id: { type: 'integer' },
        role: { type: 'string', enum: ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'SUB'], description: 'Default: his draft role' },
        twitch_login: { type: 'string' },
        kick_slug: { type: 'string' },
      },
      required: ['player', 'team_id'],
    },
    async run(a, { env, user }) {
      if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Admins only.');
      const r = resolveQueuePlayer(await queueRoster(env), a.player);
      const res = await queueCall(env, user, 'POST', '/api/queue/link', { player_key: r.key, team_id: int(a.team_id, 'team_id'), role: a.role ?? r.draft_role });
      const id = Number(res.player_id);
      const ch = playerFields({ ...(a.twitch_login !== undefined ? { twitch_login: a.twitch_login } : {}), ...(a.kick_slug !== undefined ? { kick_slug: a.kick_slug } : {}) }, true);
      if (Object.keys(ch).length) await update(env.DB, 'players', id, ch);
      if (ch.twitch_login) await syncTwitchVods(env, [String(ch.twitch_login)]).catch(() => {});
      const p = await env.DB.prepare('SELECT nickname, role, riot_game_name, riot_tag_line, twitch_login, kick_slug FROM players WHERE id = ?').bind(id).first();
      return text({ ok: true, player_id: id, player: p });
    },
  },
  {
    name: 'update_player',
    description: "Changes a player in the app: team, nickname, role, Riot ID (GameName#TAG, empty to clear), Twitch/Kick channel (name or link – a new Twitch channel fetches its VODs right away), notes. Only the fields given are changed.",
    inputSchema: {
      type: 'object',
      properties: {
        player_id: { type: 'integer' },
        team_id: { type: 'integer' },
        nickname: { type: 'string' },
        role: { type: 'string', enum: ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'SUB'] },
        riot_id: { type: 'string' },
        twitch_login: { type: 'string' },
        kick_slug: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['player_id'],
    },
    async run(a, { env, user }) {
      const id = int(a.player_id, 'player_id');
      const { player_id: _pid, team_id: teamRaw, ...rest } = a;
      const fields = playerFields(rest, true);
      if (teamRaw !== undefined) {
        const teamId = int(teamRaw, 'team_id');
        if (!(await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(teamId).first())) throw new HttpError(404, 'not_found', 'Team not found');
        fields.team_id = teamId;
      }
      if (!Object.keys(fields).length) throw new HttpError(400, 'invalid', 'Nothing to change.');
      await update(env.DB, 'players', id, fields);
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'player.update', 'player', id, fields);
      if ('riot_game_name' in fields || 'nickname' in fields || 'team_id' in fields) await relinkDraftPlayers(env).catch(() => {});
      if (fields.twitch_login) await syncTwitchVods(env, [String(fields.twitch_login)]).catch(() => {});
      return text({ ok: true });
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
      "Our team's schedule (harmonogram): tournament matches (kind 'match'), scrims ('scrim'), other events like training ('other') and free days with no practice ('off', volno). " +
      'Upcoming events first (soonest first), then recently played ones. Times are given in UTC and in Prague local time. ' +
      'opponent_team_id links to the opponent for get_team / scouting.',
    inputSchema: {
      type: 'object',
      properties: {
        include_past: { type: 'integer', minimum: 0, maximum: 50, description: 'How many played events to include (default 5)' },
        kind: { type: 'string', enum: ['match', 'scrim', 'other', 'off'], description: 'Only this type of event' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const all = await listSchedule(env, { kind: a.kind ? String(a.kind) : undefined });
      const past = all.filter((m) => !isUpcoming(m)).reverse().slice(0, Math.min(Number(a.include_past ?? 5) || 0, 50));
      return text({
        now_prague: formatPrague(new Date().toISOString()),
        upcoming: all.filter((m) => isUpcoming(m)).map(compactScheduled),
        recent: past.map(compactScheduled),
      });
    },
  },
  {
    name: 'get_tournament',
    description:
      'The whole Streamers Clash tournament, all teams: group-stage match days ("1. hrací den"…) and play-off days, every match with time, format, ' +
      'group, bracket position (bracket_slot: ' + Object.entries(SLOTS).map(([k, v]) => `${k} = ${v}`).join(', ') + '), both teams (TBD until known), score and link to streamersclash.cz. ' +
      'ours = our team plays. team_id filters to one team.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'integer', description: 'Only matches of this team' },
        stage: { type: 'string', enum: ['group', 'playoff'] },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const all = await listTournament(env, { teamId: a.team_id ? Number(a.team_id) : undefined });
      const list = a.stage ? all.filter((m) => m.stage === a.stage) : all;
      return text({ now_prague: formatPrague(new Date().toISOString()), matches: list.map((m) => compactTournament(m, formatPrague)) });
    },
  },
  {
    name: 'update_tournament_match',
    description:
      'Changes a tournament match (id from get_tournament): assign teams (team1_id/team2_id when the team is in the app, otherwise team1_name/team2_name), ' +
      'the group (group_name, e.g. "A"), the bracket position (bracket_slot; the match that held it before loses it), the score (score1/score2 for team1/team2), time or notes. ' +
      'Only the fields you pass are changed; pass null to clear. Ask Dao before changing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        team1_id: { type: ['integer', 'null'] },
        team1_name: { type: ['string', 'null'] },
        team2_id: { type: ['integer', 'null'] },
        team2_name: { type: ['string', 'null'] },
        group_name: { type: ['string', 'null'] },
        bracket_slot: { type: ['string', 'null'], enum: [...Object.keys(SLOTS), null] },
        score1: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
        score2: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
        starts_at: { type: 'string', description: '"YYYY-MM-DD HH:MM" Prague time' },
        format: { type: 'string', enum: ['BO1', 'BO2', 'BO3', 'BO5'] },
        day_label: { type: 'string' },
        notes: { type: ['string', 'null'] },
      },
      required: ['id'],
    },
    async run(a, { env, user }) {
      const id = int(a.id, 'id');
      const { id: _id, ...rest } = a;
      const [current] = await listTournament(env, { id });
      if (!current) throw new HttpError(404, 'not_found', 'Tournament match not found');
      const fields = await tournamentFields(env.DB, rest, true);
      if ('bracket_slot' in fields) await freeSlot(env.DB, fields.bracket_slot, id);
      await update(env.DB, 'tournament_matches', id, fields);
      const [t] = await listTournament(env, { id });
      await logActivity(env.DB, { kind: 'claude', userId: user.id }, 'tournament.update', 'tournament', id, { name: tournamentLabel(t) });
      return text({ ok: true, match: compactTournament(t, formatPrague) });
    },
  },
  {
    name: 'add_scheduled_match',
    description:
      'Adds an event to our schedule: a tournament match (kind "match", default), a scrim ("scrim"), something else like training ("other", needs title) or a free day ("off", volno – starts_at is the day at 00:00, title optional, e.g. the reason). ' +
      'starts_at: "YYYY-MM-DD HH:MM" in Prague time (or ISO with a zone). For matches and scrims give opponent_team_id when the opponent is in the app ' +
      '(list_teams/search), otherwise opponent_name. Ask Dao before adding.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['match', 'scrim', 'other', 'off'] },
        title: { type: 'string', description: 'Name of an "other" event, e.g. "Trénink", "Review VODek"; for "off" an optional reason' },
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
        kind: { type: 'string', enum: ['match', 'scrim', 'other', 'off'] },
        title: { type: 'string', description: 'Name of an "other" event, e.g. "Trénink", "Review VODek"; for "off" an optional reason' },
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
      'ward maps (only counts and labels of the markers – the map itself is drawn by Dao in the app), screenshots ' +
      'and each player\'s champion pool tier list with games/winrate from recorded drafts ' +
      '(look at one with get_coaching_screenshot). ' +
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
        champion_pools: (data.players as { id: number; nickname: string }[])
          .filter((p) => !pid || p.id === pid)
          .map((p) => {
            const stats = ((data.pool_stats as Record<number, any[]>)[p.id] ?? []);
            const entries = (data.pool as Record<string, any>[]).filter((e) => e.player_id === p.id);
            return {
              player: p.nickname, player_id: p.id,
              tiers: Object.fromEntries(Object.entries(TIER_LABELS).map(([t, label]) => [label, entries.filter((e) => e.tier === t).map((e) => {
                const st = stats.find((x) => x.champion === e.champion);
                return { champion: e.champion, note: e.note || undefined, games: st?.games ?? 0, winrate: st?.winrate ?? null };
              })])),
            };
          }),
        screenshots: (data.shots as Record<string, any>[]).filter(inScope).map((sh) => ({
          id: sh.id, player: playerName(sh.player_id), folder: folderName(sh.folder_id), title: sh.title, notes: sh.notes,
          size: sh.width && sh.height ? `${sh.width}×${sh.height}` : null, added: sh.created_at,
        })),
        notes: (data.notes as Record<string, any>[]).filter(inScope).map((n) => ({
          id: n.id, player: playerName(n.player_id), folder: folderName(n.folder_id), title: n.title, body: n.body,
          pinned: !!n.pinned, author: n.author_kind === 'claude' ? 'Claude' : n.author_name, updated_at: n.updated_at,
        })),
      });
    },
  },
  {
    name: 'get_coaching_screenshot',
    description: 'Shows one coaching screenshot (id from get_coaching) so you can look at it, with its title and notes.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
    async run(a, { env }) {
      const id = int(a.id, 'id');
      const meta = await env.DB.prepare('SELECT title, notes FROM coaching_shots WHERE id = ?').bind(id).first<{ title: string | null; notes: string | null }>();
      const img = await getShotImage(env, id);
      if (!meta || !img) throw new HttpError(404, 'not_found', `Screenshot ${id} not found`);
      return {
        content: [
          { type: 'image', data: toBase64(img.data), mimeType: img.mime },
          { type: 'text', text: JSON.stringify({ id, title: meta.title, notes: meta.notes }) },
        ],
      };
    },
  },
  {
    name: 'set_champion_pool_entry',
    description:
      "Puts a champion into one of our player's champion pool tiers, moves it, or removes it (tier null). " +
      'Tiers: S (main), A (strong), B (playable), C (emergency), L (learning). Ask Dao before changing.',
    inputSchema: {
      type: 'object',
      properties: {
        player_id: { type: 'integer' },
        champion: { type: 'string' },
        tier: { type: ['string', 'null'], enum: ['S', 'A', 'B', 'C', 'L', null] },
        note: { type: 'string', description: 'Short note, e.g. "jen proti AP botu"' },
      },
      required: ['player_id', 'champion'],
    },
    async run(a, { env, user }) {
      const playerId = int(a.player_id, 'player_id');
      const { results } = await env.DB.prepare('SELECT champion, tier, note FROM champion_pool WHERE player_id = ? ORDER BY sort').bind(playerId).all<{ champion: string; tier: string; note: string | null }>();
      const name = String(a.champion ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const items = results.filter((r) => r.champion.toLowerCase().replace(/[^a-z0-9]/g, '') !== name);
      if (a.tier) {
        const old = results.find((r) => r.champion.toLowerCase().replace(/[^a-z0-9]/g, '') === name);
        items.push({ champion: String(a.champion), tier: String(a.tier).toUpperCase(), note: a.note !== undefined ? String(a.note) : old?.note ?? null });
      }
      await savePool(env, { kind: 'claude', userId: user.id }, playerId, items);
      return text({ ok: true });
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
    name: 'get_coach_plan',
    description:
      "The coach's private strategic coaching plan (superadmin/Dao only): tabs (areas like Draft, Macro) each with a goal and deadline, and items the team should learn. done = already learned (with what the team took from it) – never suggest those again. focus = what the team trains right now.",
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
    async run(a, { env, user }) {
      requireSuperadmin(env, user);
      const { tabs, items, players } = await loadPlan(env);
      type T = { id: number; name: string; goal: string | null; deadline: string | null; archived: number };
      type I = Json & { tab_id: number; done_at: string | null; priority: number; focus: number };
      return text({
        players,
        tabs: (tabs as T[])
          .filter((t) => a.include_archived || !t.archived)
          .map((t) => {
            const its = (items as I[]).filter((i) => i.tab_id === t.id);
            const row = (i: I) => ({
              id: i.id, title: i.title, details: i.details, for: i.player_name ?? 'whole team',
              priority: PRIORITY_LABELS[i.priority], focus: !!i.focus, due_date: i.due_date,
              ...(i.done_at ? { done_at: i.done_at, learned_note: i.done_note } : {}),
            });
            return {
              id: t.id, name: t.name, goal: t.goal, deadline: t.deadline, archived: !!t.archived,
              progress: `${its.filter((i) => i.done_at).length}/${its.length}`,
              open: its.filter((i) => !i.done_at).map(row),
              learned: its.filter((i) => i.done_at).map(row),
            };
          }),
      });
    },
  },
  {
    name: 'save_coach_plan_tab',
    description: 'Create a tab (area) in the coaching plan, or update it when id is given. Superadmin only. Ask Dao before changing his plan.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Existing tab to update; omit to create' },
        name: { type: 'string' },
        goal: { type: 'string', description: 'What the team should be able to do at the end' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        archived: { type: 'boolean' },
      },
    },
    async run(a, { env, user }) {
      requireSuperadmin(env, user);
      const { id, ...rest } = a;
      if (id) {
        await updateTab(env, int(id, 'id'), rest);
        return text({ ok: true, tab_id: id });
      }
      return text({ ok: true, tab_id: await createTab(env, rest) });
    },
  },
  {
    name: 'add_coach_plan_items',
    description: 'Add items (things the team or a player should learn) to a coaching plan tab. Superadmin only. Ask Dao before adding.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'integer' },
        items: {
          type: 'array',
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              details: { type: 'string', description: 'How to train it / when it counts as learned' },
              player_id: { type: 'integer', description: 'One of our players; omit for the whole team' },
              priority: { type: 'integer', enum: [1, 2, 3], description: '1 high, 2 normal, 3 low' },
              due_date: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['title'],
          },
        },
      },
      required: ['tab_id', 'items'],
    },
    async run(a, { env, user }) {
      requireSuperadmin(env, user);
      const list = Array.isArray(a.items) ? (a.items as Json[]) : [];
      const ids: number[] = [];
      for (const it of list) ids.push(await createItem(env, { ...it, tab_id: a.tab_id }, 'claude'));
      return text({ ok: true, item_ids: ids });
    },
  },
  {
    name: 'update_coach_plan_item',
    description: 'Change a coaching plan item: tick it off (done: true, with learned_note), reopen it, set focus, edit text, priority, due date or move it to another tab. Superadmin only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        done: { type: 'boolean' },
        learned_note: { type: 'string', description: 'What the team took from it (when ticking off)' },
        focus: { type: 'boolean' },
        title: { type: 'string' },
        details: { type: 'string' },
        player_id: { type: ['integer', 'null'] },
        priority: { type: 'integer', enum: [1, 2, 3] },
        due_date: { type: ['string', 'null'] },
        tab_id: { type: 'integer' },
      },
      required: ['id'],
    },
    async run(a, { env, user }) {
      requireSuperadmin(env, user);
      const { id, learned_note, ...rest } = a;
      await updateItem(env, int(id, 'id'), learned_note !== undefined ? { ...rest, done_note: learned_note } : rest);
      return text({ ok: true });
    },
  },
  {
    name: 'get_activity',
    description: 'Recent changes in the app (who added or changed what), newest first. Only for the superadmin (Dao); others get an error.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 100 } } },
    annotations: { readOnlyHint: true },
    async run(a, { env, user }) {
      if (!isSuperadmin(env, user)) throw new HttpError(403, 'forbidden', 'The activity log is only visible to the superadmin.');
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
    ...(m.kind === 'other' || m.kind === 'off' ? { title: m.title } : { opponent: opponentLabel(m) }),
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


// --- Streamers Queue (player auction) helpers -------------------------------------
// The queue tools go through the same handler as the web pages (/api/queue/...), so they share its
// validation, the admin-only rule and the "live on Twitch" lock.

async function queueCall(env: Env, user: User, method: string, path: string, body?: Json): Promise<Json> {
  const req = new Request(`https://mcp.internal${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleQueueApi(req, env, path.split('?')[0], method, user, async (r) => (await r.json()) as Json);
  if (!res) throw new HttpError(404, 'not_found', `Unknown queue route ${path}`);
  const data = (await res.json()) as Json;
  if (!res.ok) throw new HttpError(res.status, 'error', String((data as { message?: string }).message ?? `HTTP ${res.status}`));
  return data;
}

async function requireQueue(env: Env, user: User): Promise<void> {
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Streamers Queue scouting is for admins only.');
  const g = await streamGuard(env, user);
  if (g.hidden) throw new HttpError(423, 'live', 'You are live on Twitch – queue scouting is locked until the stream ends.');
}

const foldName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

interface QueueRow { key: string; nickname: string; price: number | null; draft_role: string | null; is_captain: number | null; gone: number | null; blocked: number | null }

async function queueRoster(env: Env): Promise<QueueRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.key, p.nickname, s.price, s.draft_role, s.is_captain, s.gone, s.blocked
       FROM queue_players p LEFT JOIN queue_scout s ON s.player_key = p.key`,
  ).all<QueueRow>();
  return results;
}

/** Nickname (any case/diacritics) or key → the queue player; ambiguous or unknown names fail with candidates. */
function resolveQueuePlayer(rows: QueueRow[], name: unknown): QueueRow {
  const raw = String(name ?? '').trim();
  if (!raw) throw new HttpError(400, 'invalid', 'Missing player name.');
  const f = foldName(raw);
  const exact = rows.filter((r) => r.key === raw.toLowerCase() || foldName(r.nickname) === f);
  if (exact.length === 1) return exact[0];
  const priced = (l: QueueRow[]) => (l.filter((r) => r.price != null).length === 1 ? l.filter((r) => r.price != null) : l);
  if (exact.length > 1 && priced(exact).length === 1) return priced(exact)[0];
  const part = rows.filter((r) => foldName(r.nickname).includes(f));
  if (part.length === 1) return part[0];
  if (part.length > 1 && priced(part).length === 1) return priced(part)[0];
  const cand = (part.length ? part : exact).slice(0, 8).map((r) => r.nickname);
  throw new HttpError(404, 'not_found', cand.length ? `"${raw}" is ambiguous: ${cand.join(', ')}` : `No queue player "${raw}".`);
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
