import type { Env } from './index';
import { HttpError } from './http';
import { FORMATS, parseStart } from './schedule';

// The whole tournament (all teams): group-stage match days and the play-off bracket, as published on
// streamersclash.cz/schedule. Teams are assigned by hand (or by Claude) once they are known; a slot in the
// bracket (bracket_slot) places a play-off match in the "Pavouk" view.

/** Bracket positions, laid out like the official site (horní pavouk, dolní pavouk, finále). */
export const SLOTS = {
  UB1: 'Horní pavouk – 1. kolo (1)',
  UB2: 'Horní pavouk – 1. kolo (2)',
  UBF: 'Horní pavouk – finále',
  LB1: 'Dolní pavouk – 1. kolo (1)',
  LB2: 'Dolní pavouk – 1. kolo (2)',
  LB3: 'Dolní pavouk – 2. kolo (1)',
  LB4: 'Dolní pavouk – 2. kolo (2)',
  LB5: 'Dolní pavouk – 3. kolo',
  LBF: 'Dolní pavouk – finále',
  GF: 'Finále',
  F2: 'Finále – spodní zápas',
} as const;
export type Slot = keyof typeof SLOTS;
export const STAGES = ['group', 'playoff'] as const;

type Row = Record<string, string | number | null>;

export interface TournamentMatch {
  id: number;
  sc_match_id: number | null;
  starts_at: string;
  format: string;
  stage: 'group' | 'playoff';
  day_label: string | null;
  group_name: string | null;
  bracket_slot: Slot | null;
  team1_id: number | null;
  team1_name: string | null;
  team2_id: number | null;
  team2_name: string | null;
  score1: number | null;
  score2: number | null;
  notes: string | null;
  t1_name: string | null;
  t1_tag: string | null;
  t1_logo: string | null;
  t1_own: number | null;
  t2_name: string | null;
  t2_tag: string | null;
  t2_logo: string | null;
  t2_own: number | null;
}

export async function listTournament(env: Env, opts: { id?: number; teamId?: number } = {}): Promise<TournamentMatch[]> {
  const where: string[] = [];
  const params: number[] = [];
  if (opts.id) (where.push('m.id = ?'), params.push(opts.id));
  if (opts.teamId) (where.push('(m.team1_id = ? OR m.team2_id = ?)'), params.push(opts.teamId, opts.teamId));
  const { results } = await env.DB.prepare(
    `SELECT m.*,
            a.name AS t1_name, a.tag AS t1_tag, a.logo_url AS t1_logo, a.is_own_team AS t1_own,
            b.name AS t2_name, b.tag AS t2_tag, b.logo_url AS t2_logo, b.is_own_team AS t2_own
       FROM tournament_matches m
       LEFT JOIN teams a ON a.id = m.team1_id
       LEFT JOIN teams b ON b.id = m.team2_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.starts_at, m.id`,
  )
    .bind(...params)
    .all<TournamentMatch>();
  return results;
}

/** "Tým A vs Tým B" (TBD for an unknown side). */
export function tournamentLabel(m: TournamentMatch): string {
  return `${m.t1_name || m.team1_name || 'TBD'} vs ${m.t2_name || m.team2_name || 'TBD'}`;
}

function str(v: unknown, label: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, 'invalid', `${label}: max ${max} znaků.`);
  return s || null;
}

function score(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new HttpError(400, 'invalid', `${label}: zadej číslo 0–9.`);
  return n;
}

async function teamId(db: D1Database, v: unknown, label: string): Promise<number | null> {
  if (v === null || v === undefined || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !(await db.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first())) {
    throw new HttpError(400, 'invalid', `${label}: tým neexistuje.`);
  }
  return id;
}

/** Validates tournament match input from the web UI or Claude (only the fields present are returned when partial). */
export async function tournamentFields(db: D1Database, body: Record<string, unknown>, partial: boolean): Promise<Row> {
  const out: Row = {};
  const has = (k: string) => !partial || k in body;
  if (has('starts_at')) out.starts_at = parseStart(body.starts_at);
  if (has('format')) {
    const f = String(body.format ?? 'BO1').toUpperCase();
    if (!(FORMATS as readonly string[]).includes(f)) throw new HttpError(400, 'invalid', 'Formát musí být BO1, BO2, BO3 nebo BO5.');
    out.format = f;
  }
  if (has('stage')) {
    const s = String(body.stage ?? 'group');
    if (!(STAGES as readonly string[]).includes(s)) throw new HttpError(400, 'invalid', 'Fáze musí být group nebo playoff.');
    out.stage = s;
  }
  if (has('day_label')) out.day_label = str(body.day_label, 'Hrací den', 40);
  if (has('group_name')) out.group_name = str(body.group_name, 'Skupina', 20);
  if (has('bracket_slot')) {
    const s = str(body.bracket_slot, 'Pozice v pavouku', 8);
    if (s && !(s in SLOTS)) throw new HttpError(400, 'invalid', `Pozice v pavouku musí být jedna z: ${Object.keys(SLOTS).join(', ')}.`);
    out.bracket_slot = s;
  }
  if (has('team1_id')) out.team1_id = await teamId(db, body.team1_id, 'Tým 1');
  if (has('team1_name')) out.team1_name = str(body.team1_name, 'Tým 1', 80);
  if (has('team2_id')) out.team2_id = await teamId(db, body.team2_id, 'Tým 2');
  if (has('team2_name')) out.team2_name = str(body.team2_name, 'Tým 2', 80);
  if (has('score1')) out.score1 = score(body.score1, 'Skóre týmu 1');
  if (has('score2')) out.score2 = score(body.score2, 'Skóre týmu 2');
  if (has('notes')) out.notes = str(body.notes, 'Poznámky', 2000);
  if (has('sc_match_id')) {
    const v = body.sc_match_id;
    out.sc_match_id = v === null || v === undefined || v === '' ? null : Number(v);
    if (out.sc_match_id !== null && !Number.isInteger(out.sc_match_id)) throw new HttpError(400, 'invalid', 'ID zápasu na streamersclash.cz musí být číslo.');
  }
  // A team picked from the app replaces the typed name and the other way round.
  if (out.team1_id) out.team1_name = null;
  if (out.team2_id) out.team2_name = null;
  return out;
}

/** Puts a match into a bracket slot; whatever held that slot before is taken out of it. */
export async function freeSlot(db: D1Database, slot: unknown, exceptId: number | null): Promise<void> {
  if (!slot) return;
  await db.prepare('UPDATE tournament_matches SET bracket_slot = NULL WHERE bracket_slot = ? AND id IS NOT ?').bind(String(slot), exceptId).run();
}

/** Compact form for Claude, with Prague time. */
export function compactTournament(m: TournamentMatch, formatPrague: (iso: string) => string): Json {
  return {
    id: m.id,
    starts_at: m.starts_at,
    prague: formatPrague(m.starts_at),
    format: m.format,
    stage: m.stage,
    day: m.day_label,
    group: m.group_name,
    bracket_slot: m.bracket_slot,
    bracket_label: m.bracket_slot ? SLOTS[m.bracket_slot] : null,
    team1: m.t1_name || m.team1_name || 'TBD',
    team1_id: m.team1_id,
    team2: m.t2_name || m.team2_name || 'TBD',
    team2_id: m.team2_id,
    score: m.score1 !== null && m.score2 !== null ? `${m.score1}:${m.score2}` : null,
    ours: !!(m.t1_own || m.t2_own),
    notes: m.notes,
    url: m.sc_match_id ? `https://streamersclash.cz/matches/${m.sc_match_id}` : null,
  };
}
type Json = Record<string, unknown>;
