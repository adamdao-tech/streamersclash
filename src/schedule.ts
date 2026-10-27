import type { Env } from './index';
import { HttpError } from './http';

// Our team's match schedule (harmonogram). Start times are stored as UTC ISO strings
// ("2026-11-02T17:00:00.000Z"); the web UI converts from the browser's local time, and
// times typed without a zone (e.g. from Claude) are read as Prague time.

export const FORMATS = ['BO1', 'BO2', 'BO3', 'BO5'] as const;
/** match = tournament match, scrim = practice game vs another team, other = training, meeting…, off = a free day (volno) */
export const KINDS = ['match', 'scrim', 'other', 'off'] as const;
export type Kind = (typeof KINDS)[number];
const TZ = 'Europe/Prague';

type Row = Record<string, string | number | null>;

export interface ScheduledMatch {
  id: number;
  kind: Kind;
  title: string | null;
  starts_at: string;
  opponent_team_id: number | null;
  opponent_name: string | null;
  format: string;
  stage: string | null;
  location: string | null;
  stream_url: string | null;
  our_score: number | null;
  their_score: number | null;
  notes: string | null;
  created_by_kind: string;
  team_name: string | null;
  team_tag: string | null;
  team_logo_url: string | null;
  team_accent_color: string | null;
}

/** Offset of Prague from UTC (in ms) at a given instant. */
function pragueOffset(utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Parses a start time. Accepts ISO with a zone ("…Z", "+01:00") or a local Prague time
 * "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM". Returns a UTC ISO string.
 */
export function parseStart(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, 'invalid', 'Zadej datum a čas zápasu.');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid', `Neplatné datum: ${s}`);
    return d.toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) throw new HttpError(400, 'invalid', `Datum musí být ve tvaru RRRR-MM-DD HH:MM, dostal jsem: ${s}`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(naive)) throw new HttpError(400, 'invalid', `Neplatné datum: ${s}`);
  // Two passes handle the DST switch correctly.
  let utc = naive - pragueOffset(naive);
  utc = naive - pragueOffset(utc);
  return new Date(utc).toISOString();
}

/** "po 2. 11. 2026 18:00" in Prague time. */
export function formatPrague(iso: string): string {
  return new Intl.DateTimeFormat('cs-CZ', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
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

/** Validates schedule input from the web UI or Claude. */
export async function scheduleFields(db: D1Database, body: Record<string, unknown>, partial: boolean): Promise<Row> {
  const out: Row = {};
  const has = (k: string) => !partial || k in body;
  if (has('kind')) {
    const k = String(body.kind ?? 'match').toLowerCase();
    if (!(KINDS as readonly string[]).includes(k)) throw new HttpError(400, 'invalid', 'Typ musí být match, scrim, other nebo off.');
    out.kind = k;
  }
  if (has('title')) out.title = str(body.title, 'Název', 80);
  if (has('starts_at')) out.starts_at = parseStart(body.starts_at);
  if (has('opponent_team_id')) {
    const v = body.opponent_team_id;
    if (v === null || v === undefined || v === '') out.opponent_team_id = null;
    else {
      const id = Number(v);
      if (!Number.isInteger(id) || !(await db.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first())) {
        throw new HttpError(400, 'invalid', 'Soupeř (tým) neexistuje.');
      }
      out.opponent_team_id = id;
    }
  }
  if (has('opponent_name')) out.opponent_name = str(body.opponent_name, 'Soupeř', 80);
  if (has('format')) {
    const f = String(body.format ?? 'BO1').toUpperCase();
    if (!(FORMATS as readonly string[]).includes(f)) throw new HttpError(400, 'invalid', 'Formát musí být BO1, BO2, BO3 nebo BO5.');
    out.format = f;
  }
  if (has('stage')) out.stage = str(body.stage, 'Fáze', 80);
  if (has('location')) out.location = str(body.location, 'Místo', 120);
  if (has('stream_url')) {
    const u = str(body.stream_url, 'Stream', 300);
    if (u && !/^https?:\/\//i.test(u)) throw new HttpError(400, 'invalid', 'Odkaz na stream musí začínat https://');
    out.stream_url = u;
  }
  if (has('our_score')) out.our_score = score(body.our_score, 'Naše skóre');
  if (has('their_score')) out.their_score = score(body.their_score, 'Skóre soupeře');
  if (has('notes')) out.notes = str(body.notes, 'Poznámky', 2000);
  return out;
}

/**
 * Checks a complete row (after merging an update): matches and scrims need an opponent,
 * other events (training, meeting) need a title, a free day (off) needs nothing.
 */
export function requireOpponent(row: { kind?: unknown; title?: unknown; opponent_team_id?: unknown; opponent_name?: unknown }): void {
  if (row.kind === 'off') return;
  if ((row.kind ?? 'match') === 'other') {
    if (!row.title) throw new HttpError(400, 'invalid', 'Napiš, co se děje (např. Trénink).');
    return;
  }
  if (!row.opponent_team_id && !row.opponent_name) throw new HttpError(400, 'invalid', 'Vyber soupeře, nebo napiš jeho jméno.');
}

export const KIND_LABELS: Record<Kind, string> = { match: 'Turnaj', scrim: 'Scrim', other: 'Jiné', off: 'Volno' };

export async function listSchedule(env: Env, opts: { teamId?: number; id?: number; kind?: string } = {}): Promise<ScheduledMatch[]> {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (opts.kind) (where.push('s.kind = ?'), params.push(opts.kind));
  if (opts.teamId) (where.push('s.opponent_team_id = ?'), params.push(opts.teamId));
  if (opts.id) (where.push('s.id = ?'), params.push(opts.id));
  const { results } = await env.DB.prepare(
    `SELECT s.*, t.name AS team_name, t.tag AS team_tag, t.logo_url AS team_logo_url, t.accent_color AS team_accent_color
       FROM schedule s LEFT JOIN teams t ON t.id = s.opponent_team_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.starts_at`,
  )
    .bind(...params)
    .all<ScheduledMatch>();
  return results;
}

/** What the event is called: the opponent for matches and scrims, the title for other events and free days. */
export function opponentLabel(m: { kind?: string; title?: string | null; team_name?: string | null; opponent_name?: string | null }): string {
  if (m.kind === 'off') return m.title ? `Volno – ${m.title}` : 'Volno';
  if (m.kind === 'other') return m.title || '?';
  return m.team_name || m.opponent_name || '?';
}

/** Result from our side, or null while the score isn't filled in or is a draw. */
/** A free day lasts the whole day; other events count as upcoming until 3 hours after the start (a Bo3 can run long). */
export function isUpcoming(m: { kind?: string; starts_at: string }, now = Date.now()): boolean {
  return new Date(m.starts_at).getTime() + (m.kind === 'off' ? 24 : 3) * 3600_000 > now;
}

export function matchResult(m: { our_score: number | null; their_score: number | null }): 'WIN' | 'LOSS' | 'DRAW' | null {
  if (m.our_score === null || m.their_score === null) return null;
  return m.our_score > m.their_score ? 'WIN' : m.our_score < m.their_score ? 'LOSS' : 'DRAW';
}
