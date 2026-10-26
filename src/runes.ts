import type { Env } from './index';
import { normName } from './champions';
import { HttpError } from './http';
import { cacheGet, cacheSet } from './twitch';

// Rune paths and summoner spells from Riot's Data Dragon, cached for a day.
// Stat shards aren't in Data Dragon, so they're listed here.

export interface Rune { id: number; key: string; name: string; icon: string; shortDesc?: string }
export interface RunePath { id: number; key: string; name: string; icon: string; slots: { runes: Rune[] }[] }
export interface Summoner { id: string; key: string; name: string; image: string }
export interface RuneData { version: string; paths: RunePath[]; shards: Rune[][]; summoners: Summoner[] }

const SHARD = (id: number, name: string, icon: string): Rune => ({ id, key: String(id), name, icon: `perk-images/StatMods/${icon}.png` });

/** Stat shard rows (offense, flex, defense) as in the client since season 2024. */
export const SHARDS: Rune[][] = [
  [SHARD(5008, 'Adaptive Force', 'StatModsAdaptiveForceIcon'), SHARD(5005, 'Attack Speed', 'StatModsAttackSpeedIcon'), SHARD(5007, 'Ability Haste', 'StatModsCDRScalingIcon')],
  [SHARD(5008, 'Adaptive Force', 'StatModsAdaptiveForceIcon'), SHARD(5010, 'Move Speed', 'StatModsMovementSpeedIcon'), SHARD(5001, 'Health Scaling', 'StatModsHealthScalingIcon')],
  [SHARD(5011, 'Health', 'StatModsHealthPlusIcon'), SHARD(5013, 'Tenacity and Slow Resist', 'StatModsTenacityIcon'), SHARD(5001, 'Health Scaling', 'StatModsHealthScalingIcon')],
];

const CACHE_KEY = 'ddragon:runes:v1';

export async function getRuneData(env: Env): Promise<RuneData> {
  const cached = await cacheGet(env.DB, CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const versions = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json()) as string[];
  const v = versions[0];
  const [runesRes, spellsRes] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/runesReforged.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/summoner.json`),
  ]);
  if (!runesRes.ok || !spellsRes.ok) throw new Error(`Data Dragon ${runesRes.status}/${spellsRes.status}`);
  const rawPaths = (await runesRes.json()) as RunePath[];
  const { data: spells } = (await spellsRes.json()) as {
    data: Record<string, { id: string; key: string; name: string; modes: string[]; image: { full: string } }>;
  };
  const out: RuneData = {
    version: v,
    paths: rawPaths.map((p) => ({
      id: p.id, key: p.key, name: p.name, icon: p.icon,
      slots: p.slots.map((s) => ({ runes: s.runes.map((r) => ({ id: r.id, key: r.key, name: r.name, icon: r.icon, shortDesc: r.shortDesc })) })),
    })),
    shards: SHARDS,
    summoners: Object.values(spells)
      .filter((s) => s.modes.includes('CLASSIC'))
      .map((s) => ({ id: s.id, key: s.key, name: s.name, image: s.image.full }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  await cacheSet(env.DB, CACHE_KEY, JSON.stringify(out), 86400);
  return out;
}

export interface RunePageInput {
  primary_style?: unknown;
  secondary_style?: unknown;
  perks?: unknown;
  shards?: unknown;
  summoners?: unknown;
}

export interface RunePageClean {
  primary_style: number | null;
  secondary_style: number | null;
  perks: (number | null)[];
  shards: (number | null)[];
  summoners: string[];
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** Matches a rune by id or (loosely) by name among the given candidates. */
function findRune(list: Rune[], v: unknown): Rune | undefined {
  if (blank(v)) return undefined;
  const n = Number(v);
  if (Number.isInteger(n)) return list.find((r) => r.id === n);
  const name = normName(String(v));
  return list.find((r) => normName(r.name) === name || normName(r.key) === name);
}

function findPath(paths: RunePath[], v: unknown): RunePath | undefined {
  if (blank(v)) return undefined;
  const n = Number(v);
  if (Number.isInteger(n)) return paths.find((p) => p.id === n);
  const name = normName(String(v));
  return paths.find((p) => normName(p.name) === name || normName(p.key) === name);
}

/**
 * Validates a rune page. Accepts rune ids or names (so Claude can write "Aftershock").
 * Pages may be incomplete, but everything that is filled in must be legal:
 * perks = [keystone, primary row 1, row 2, row 3, secondary A, secondary B].
 */
export function cleanRunePage(data: RuneData, input: RunePageInput): RunePageClean {
  const bad = (msg: string) => new HttpError(400, 'invalid', msg);
  const primary = findPath(data.paths, input.primary_style);
  if (!blank(input.primary_style) && !primary) throw bad(`Neznámá hlavní větev run: ${input.primary_style}`);
  const secondary = findPath(data.paths, input.secondary_style);
  if (!blank(input.secondary_style) && !secondary) throw bad(`Neznámá vedlejší větev run: ${input.secondary_style}`);
  if (primary && secondary && primary.id === secondary.id) throw bad('Hlavní a vedlejší větev musí být různé.');

  const perksIn = Array.isArray(input.perks) ? input.perks : [];
  if (perksIn.length > 6) throw bad('Runová stránka má nejvýš 6 run.');
  const perks: (number | null)[] = [null, null, null, null, null, null];
  for (let i = 0; i < 4; i++) {
    if (blank(perksIn[i])) continue;
    if (!primary) throw bad('Nejdřív vyber hlavní větev run.');
    const r = findRune(primary.slots[i]?.runes ?? [], perksIn[i]);
    if (!r) throw bad(`${perksIn[i]} nepatří do ${i === 0 ? 'keystonu' : `${i}. řady`} větve ${primary.name}.`);
    perks[i] = r.id;
  }
  const usedRows = new Set<number>();
  for (let i = 4; i < 6; i++) {
    if (blank(perksIn[i])) continue;
    if (!secondary) throw bad('Nejdřív vyber vedlejší větev run.');
    const row = secondary.slots.findIndex((s, si) => si > 0 && findRune(s.runes, perksIn[i]));
    if (row < 1) throw bad(`${perksIn[i]} nepatří do vedlejší větve ${secondary.name} (keystone tam být nemůže).`);
    if (usedRows.has(row)) throw bad('Ve vedlejší větvi musí být runy ze dvou různých řad.');
    usedRows.add(row);
    perks[i] = findRune(secondary.slots[row].runes, perksIn[i])!.id;
  }

  const shardsIn = Array.isArray(input.shards) ? input.shards : [];
  const shards: (number | null)[] = [null, null, null];
  for (let i = 0; i < 3; i++) {
    if (blank(shardsIn[i])) continue;
    const r = findRune(data.shards[i], shardsIn[i]);
    if (!r) throw bad(`Shard ${shardsIn[i]} nepatří do ${i + 1}. řady.`);
    shards[i] = r.id;
  }

  const sumIn = Array.isArray(input.summoners) ? input.summoners : [];
  if (sumIn.length > 2) throw bad('Summonery jsou jen dva.');
  const summoners: string[] = [];
  for (const s of sumIn) {
    if (blank(s)) continue;
    const name = normName(String(s));
    const hit = data.summoners.find((x) => normName(x.id) === name || normName(x.name) === name || x.key === String(s));
    if (!hit) throw bad(`Neznámý summoner: ${s}`);
    if (summoners.includes(hit.id)) throw bad('Dva stejné summonery nejdou.');
    summoners.push(hit.id);
  }

  return {
    primary_style: primary?.id ?? null,
    secondary_style: secondary?.id ?? null,
    perks: perks.some((p) => p !== null) ? perks : [],
    shards: shards.some((p) => p !== null) ? shards : [],
    summoners,
  };
}

/** Human-readable version of a stored page, for Claude. */
export function describeRunePage(data: RuneData, page: { primary_style: number | null; secondary_style: number | null; perks: string; shards: string; summoners: string }) {
  const all = data.paths.flatMap((p) => p.slots.flatMap((s) => s.runes));
  const runeName = (id: number | null) => (id === null ? null : all.find((r) => r.id === id)?.name ?? String(id));
  const perks = JSON.parse(page.perks || '[]') as (number | null)[];
  const shards = JSON.parse(page.shards || '[]') as (number | null)[];
  const summoners = JSON.parse(page.summoners || '[]') as string[];
  return {
    primary: data.paths.find((p) => p.id === page.primary_style)?.name ?? null,
    keystone: runeName(perks[0] ?? null),
    primary_runes: perks.slice(1, 4).map(runeName),
    secondary: data.paths.find((p) => p.id === page.secondary_style)?.name ?? null,
    secondary_runes: perks.slice(4, 6).map(runeName),
    shards: shards.map((id, i) => (id === null ? null : data.shards[i].find((s) => s.id === id)?.name ?? String(id))),
    summoners: summoners.map((id) => data.summoners.find((s) => s.id === id)?.name ?? id),
  };
}
