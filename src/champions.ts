import type { Env } from './index';
import { cacheGet, cacheSet } from './twitch';

// Champion names from Riot's Data Dragon, cached for a day. Used to validate
// and normalise names coming from the draft reader and from Claude.

export interface Champion {
  id: string; // Data Dragon id, e.g. "MonkeyKing"
  name: string; // display name, e.g. "Wukong"
  tags?: string[]; // Data Dragon classes, e.g. ["Fighter", "Tank"] – a fallback for the identity analysis
  attack?: number; // Data Dragon info 0–10: physical / magic damage leaning
  magic?: number;
}

export function normName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export async function getChampionData(env: Env): Promise<{ version: string; champions: Champion[] }> {
  const cached = await cacheGet(env.DB, 'ddragon:champions:v3');
  if (cached) return JSON.parse(cached);

  const versions = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json()) as string[];
  const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/champion.json`);
  if (!res.ok) throw new Error(`Data Dragon ${res.status}`);
  const { data } = (await res.json()) as {
    data: Record<string, { id: string; name: string; tags?: string[]; info?: { attack?: number; magic?: number } }>;
  };
  const out = {
    version: versions[0],
    champions: Object.values(data).map((c) => ({ id: c.id, name: c.name, tags: c.tags ?? [], attack: c.info?.attack ?? 0, magic: c.info?.magic ?? 0 })),
  };
  await cacheSet(env.DB, 'ddragon:champions:v3', JSON.stringify(out), 86400);
  return out;
}

export async function getChampions(env: Env): Promise<Champion[]> {
  return (await getChampionData(env)).champions;
}

/** Returns the canonical champion name, or null if it isn't a champion. Accepts names and Data Dragon ids. */
export function resolveChampion(champions: Champion[], input: string): string | null {
  const n = normName(input);
  if (!n) return null;
  const hit = champions.find((c) => normName(c.name) === n || normName(c.id) === n);
  return hit?.name ?? null;
}
