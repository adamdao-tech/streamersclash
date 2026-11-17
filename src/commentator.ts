import type { Env } from './index';
import type { User } from './db';
import { HttpError, json } from './http';
import { summarizeGames, type PlayerGame } from './drafts';

// Komentátor: a read-only account for casters. He sees the opposing teams (list, team page, player pages,
// their drafts and VODs) and nothing about our team: no own team, no games our players played in,
// no schedule, coaching, drafts, queue scouting, users or Claude. Our private notes are stripped too.
//
// Requests are checked here and then answered by the normal API (`next`), whose JSON is filtered.

type Next = () => Promise<Response>;

/** Pages a commentator may open; everything else redirects to the team list. */
export const COMMENTATOR_PAGES = new Set(['/', '/index.html', '/team', '/team.html', '/player', '/player.html']);

export const isCommentator = (user: Pick<User, 'commentator'> | null | undefined): boolean => !!user?.commentator;

async function ownIds(env: Env): Promise<{ teams: Set<number>; players: Set<number> }> {
  const [t, p] = await Promise.all([
    env.DB.prepare('SELECT id FROM teams WHERE is_own_team = 1').all<{ id: number }>(),
    env.DB.prepare('SELECT id FROM players WHERE team_id IN (SELECT id FROM teams WHERE is_own_team = 1)').all<{ id: number }>(),
  ]);
  return { teams: new Set(t.results.map((r) => r.id)), players: new Set(p.results.map((r) => r.id)) };
}

/** A team the commentator may see: exists and isn't ours. */
async function checkTeam(env: Env, id: number, own: Set<number>): Promise<void> {
  if (own.has(id) || !(await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first())) {
    throw new HttpError(404, 'not_found', 'Tým neexistuje.');
  }
}

/** A player the commentator may see: in an opposing team (players without a team are hidden too). `own` = our team ids. */
async function checkPlayer(env: Env, id: number, own: Set<number>): Promise<void> {
  const row = await env.DB.prepare('SELECT team_id FROM players WHERE id = ?').bind(id).first<{ team_id: number | null }>();
  if (!row || row.team_id == null || own.has(row.team_id)) throw new HttpError(404, 'not_found', 'Hráč neexistuje.');
}

/** Saved games (match ids) one of our players took part in – as the streamer (POV) or in the draft. */
async function ownMatchIds(env: Env, ownPlayers: Set<number>): Promise<Set<number>> {
  if (!ownPlayers.size) return new Set();
  const ids = [...ownPlayers];
  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id FROM matches WHERE pov_player_id IN (${marks})
     UNION SELECT match_id FROM draft_actions WHERE player_id IN (${marks})`,
  )
    .bind(...ids, ...ids)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const stripPlayer = (p: Record<string, unknown>) => ({ ...p, notes: null, tags: [] });

export async function handleCommentatorApi(req: Request, env: Env, url: URL, next: Next): Promise<Response> {
  if (req.method !== 'GET') throw new HttpError(403, 'forbidden', 'Komentátor může data jen prohlížet.');
  const path = url.pathname.replace(/\/+$/, '');
  let m: RegExpMatchArray | null;

  if (path === '/api/me' || path === '/api/champions' || path === '/api/live') return next();

  const own = await ownIds(env);

  if (path === '/api/teams') {
    const data = await body(await next());
    const teams = (data.teams as Record<string, unknown>[]).filter((t) => !t.is_own_team).map((t) => ({ ...t, notes: null }));
    return json({ teams });
  }

  if ((m = path.match(/^\/api\/teams\/(\d+)$/))) {
    await checkTeam(env, Number(m[1]), own.teams);
    const data = await body(await next());
    return json({
      ...data,
      team: { ...(data.team as Record<string, unknown>), notes: null },
      players: (data.players as Record<string, unknown>[]).map(stripPlayer),
      pools: [], // our coaching tier lists
    });
  }

  if ((m = path.match(/^\/api\/players\/(\d+)$/))) {
    await checkPlayer(env, Number(m[1]), own.teams);
    const data = await body(await next());
    const hidden = await ownMatchIds(env, own.players);
    const games = (data.games as PlayerGame[]).filter((g) => !hidden.has(g.match_id));
    return json({ ...data, player: stripPlayer(data.player as Record<string, unknown>), games, stats: summarizeGames(games), notes: [] });
  }

  if (path === '/api/drafts' || path === '/api/vods') {
    const teamId = url.searchParams.get('team_id');
    const playerId = url.searchParams.get('player_id');
    if (!teamId && !playerId) throw new HttpError(403, 'forbidden', 'Komentátor vidí hry a VODky jen u konkrétního týmu nebo hráče.');
    if (url.searchParams.get('vod_id') || url.searchParams.get('channel')) throw new HttpError(403, 'forbidden', 'Jen podle týmu nebo hráče.');
    if (teamId) await checkTeam(env, Number(teamId), own.teams);
    if (playerId) await checkPlayer(env, Number(playerId), own.teams);
    const data = await body(await next());
    if (path === '/api/vods') {
      return json({ vods: (data.vods as Record<string, unknown>[]).filter((v) => v.team_id == null || !own.teams.has(Number(v.team_id))) });
    }
    const hidden = await ownMatchIds(env, own.players);
    return json({ drafts: (data.drafts as { id: number }[]).filter((d) => !hidden.has(d.id)).map((d) => ({ ...d, notes: null })) });
  }

  throw new HttpError(403, 'forbidden', 'Tohle komentátor nevidí.');
}
