import type { Env } from './index';
import { getChampions, resolveChampion } from './champions';
import { HttpError } from './http';

// drafter.lol: an external draft tool many teams use for scrims and fearless series. Its public
// series endpoint returns every game's bans and picks (blue/red, in draft order), so bans that the
// client never shows (custom lobbies are blind pick) can be added to games read from VODs.

interface DrafterGame {
  draftId: string;
  done: boolean;
  patch?: string;
  createdAt?: string;
  drafterBlue?: string;
  drafterRed?: string;
  fearless?: boolean;
  [key: string]: unknown;
}

export interface DrafterImportGame {
  game: number;
  blue: string | null;
  red: string | null;
  blue_picks: string[];
  red_picks: string[];
  blue_bans: string[];
  red_bans: string[];
  match_id: number | null;
  /** Which drafter side the saved game's ally (POV) team was on. */
  ally_side: 'blue' | 'red' | null;
  bans_saved: number;
  status: 'updated' | 'unchanged' | 'no_bans' | 'not_found' | 'not_done';
}

/** Series id from a drafter.lol link (https://drafter.lol/draft/ZF2as-8D?game=1) or a bare id. */
export function parseDrafterSeries(input: string): string {
  const s = String(input ?? '').trim();
  const m = s.match(/drafter\.lol\/draft\/([A-Za-z0-9_-]+)/i) ?? s.match(/^([A-Za-z0-9_-]{4,40})$/);
  if (!m) throw new HttpError(400, 'bad_link', 'Čekám odkaz ve tvaru https://drafter.lol/draft/…');
  return m[1];
}

async function fetchSeries(seriesId: string): Promise<DrafterGame[]> {
  const res = await fetch(`https://drafter.lol/api/draft-view/${encodeURIComponent(seriesId)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'sc-scouting (sc.daotech.dev)' },
  });
  if (!res.ok) throw new HttpError(502, 'drafter_unavailable', `drafter.lol odpověděl ${res.status}`);
  const body = (await res.json()) as { status?: string; drafts?: DrafterGame[] };
  if (body.status !== 'ok' || !Array.isArray(body.drafts)) throw new HttpError(404, 'drafter_not_found', 'Tahle série na drafter.lol není.');
  return body.drafts;
}

const EMPTY = new Set(['', 'none', 'null', 'undefined']);

/**
 * Adds drafter.lol bans to the saved games of a series. Each drafter game is matched to a saved game by its
 * ten champions (at least 9 must agree); the POV team's picks decide which drafter side is "ally".
 * Empty ban slots ("None") are skipped, and a game with no bans on drafter.lol keeps whatever it had.
 */
export async function importDrafterSeries(env: Env, input: string): Promise<{ series: string; games: DrafterImportGame[] }> {
  const seriesId = parseDrafterSeries(input);
  const drafts = await fetchSeries(seriesId);
  const champions = await getChampions(env);
  const champ = (v: unknown) => {
    const s = String(v ?? '').trim();
    return EMPTY.has(s.toLowerCase()) ? null : resolveChampion(champions, s) ?? s;
  };
  const list = (d: DrafterGame, prefix: string) =>
    [1, 2, 3, 4, 5].map((i) => champ(d[`${prefix}${i}`])).filter((c): c is string => !!c);

  const out: DrafterImportGame[] = [];
  for (const [i, d] of drafts.entries()) {
    const g: DrafterImportGame = {
      game: i + 1,
      blue: d.drafterBlue ?? null,
      red: d.drafterRed ?? null,
      blue_picks: list(d, 'bluePick'),
      red_picks: list(d, 'redPick'),
      blue_bans: list(d, 'blueBan'),
      red_bans: list(d, 'redBan'),
      match_id: null,
      ally_side: null,
      bans_saved: 0,
      status: 'not_found',
    };
    out.push(g);
    if (!d.done || g.blue_picks.length + g.red_picks.length < 10) {
      g.status = 'not_done';
      continue;
    }

    const found = await findMatch(env, g.blue_picks, g.red_picks, d.createdAt);
    if (!found) continue;
    g.match_id = found.matchId;
    g.ally_side = found.allySide;

    const allyBans = found.allySide === 'blue' ? g.blue_bans : g.red_bans;
    const enemyBans = found.allySide === 'blue' ? g.red_bans : g.blue_bans;
    if (!allyBans.length && !enemyBans.length) {
      g.status = 'no_bans';
      continue;
    }
    g.bans_saved = allyBans.length + enemyBans.length;
    g.status = (await saveBans(env, found.matchId, allyBans, enemyBans)) ? 'updated' : 'unchanged';
    await addSideNote(env, found.matchId, seriesId, g);
  }
  return { series: seriesId, games: out };
}

async function findMatch(env: Env, blue: string[], red: string[], createdAt?: string) {
  // Saved games from a few days around the draft; drafter.lol only gives the date.
  const day = /^\d{4}-\d{2}-\d{2}/.test(createdAt ?? '') ? createdAt!.slice(0, 10) : null;
  const { results } = await env.DB.prepare(
    `SELECT a.match_id, a.side, a.champion FROM draft_actions a JOIN matches m ON m.id = a.match_id
     WHERE a.action = 'PICK' ${day ? `AND (m.played_at IS NULL OR date(m.played_at) BETWEEN date(?, '-2 day') AND date(?, '+2 day'))` : ''}`,
  )
    .bind(...(day ? [day, day] : []))
    .all<{ match_id: number; side: string; champion: string }>();

  const byMatch = new Map<number, { ally: Set<string>; enemy: Set<string> }>();
  for (const r of results) {
    const e = byMatch.get(r.match_id) ?? { ally: new Set<string>(), enemy: new Set<string>() };
    (r.side === 'ALLY' || r.side === 'BLUE' ? e.ally : e.enemy).add(r.champion);
    byMatch.set(r.match_id, e);
  }
  const B = new Set(blue), R = new Set(red);
  const hits = (s: Set<string>, t: Set<string>) => [...s].filter((c) => t.has(c)).length;
  let best: { matchId: number; allySide: 'blue' | 'red'; score: number } | null = null;
  for (const [matchId, { ally, enemy }] of byMatch) {
    const asBlue = hits(ally, B) + hits(enemy, R);
    const asRed = hits(ally, R) + hits(enemy, B);
    const score = Math.max(asBlue, asRed);
    if (score >= 9 && (!best || score > best.score)) best = { matchId, allySide: asBlue >= asRed ? 'blue' : 'red', score };
  }
  return best;
}

/** Replaces the game's bans with drafter.lol's. Returns false when they were already the same. */
async function saveBans(env: Env, matchId: number, ally: string[], enemy: string[]): Promise<boolean> {
  const db = env.DB;
  const { results: old } = await db
    .prepare(`SELECT side, champion FROM draft_actions WHERE match_id = ? AND action = 'BAN' ORDER BY seq`)
    .bind(matchId)
    .all<{ side: string; champion: string }>();
  const key = (side: string, l: string[]) => l.map((c) => `${side}:${c}`).join('|');
  const before = [old.filter((b) => b.side === 'ALLY').map((b) => `ALLY:${b.champion}`).join('|'), old.filter((b) => b.side === 'ENEMY').map((b) => `ENEMY:${b.champion}`).join('|')];
  if (before[0] === key('ALLY', ally) && before[1] === key('ENEMY', enemy)) return false;

  const max = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM draft_actions WHERE match_id = ?').bind(matchId).first<{ s: number }>();
  let seq = max?.s ?? 0;
  const ins = (side: string, champion: string, slot: number) =>
    db
      .prepare(`INSERT INTO draft_actions (match_id, seq, side, action, slot, champion) VALUES (?, ?, ?, 'BAN', ?, ?)`)
      .bind(matchId, ++seq, side, slot, champion);
  await db.batch([
    db.prepare(`DELETE FROM draft_actions WHERE match_id = ? AND action = 'BAN'`).bind(matchId),
    ...ally.map((c, i) => ins('ALLY', c, i)),
    ...enemy.map((c, i) => ins('ENEMY', c, i)),
  ]);
  return true;
}

/** Notes which side the POV team was on (drafter.lol knows blue/red, the client view doesn't). Added once. */
async function addSideNote(env: Env, matchId: number, seriesId: string, g: DrafterImportGame): Promise<void> {
  const tag = `drafter.lol ${seriesId} hra ${g.game}`;
  const row = await env.DB.prepare('SELECT notes FROM matches WHERE id = ?').bind(matchId).first<{ notes: string | null }>();
  if (row?.notes?.includes(tag)) return;
  const allyName = g.ally_side === 'blue' ? g.blue : g.red;
  const line = `${tag}: ${allyName ?? 'POV tým'} na ${g.ally_side === 'blue' ? 'modré' : 'červené'} straně.`;
  await env.DB.prepare('UPDATE matches SET notes = ? WHERE id = ?')
    .bind(row?.notes ? `${row.notes}\n${line}` : line, matchId)
    .run();
}
