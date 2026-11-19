// What each champion brings to a team – used by the "Identita" tab on the coaching page to show
// which style of play the champion pools lean towards and to check a composition.
// Hand-made and rough on purpose: one line per champion, "Name|damage|traits".
//   damage: AD, AP or MIX
//   traits: engage, pick, poke, peel, split, early, scaling, front (frontline / tank)
// Champions missing here (new ones) fall back to their Data Dragon class.

const RAW = `
Aatrox|AD|front,early,split
Ahri|AP|pick
Akali|AP|pick,split
Akshan|AD|pick,split,early
Alistar|AP|engage,peel,front
Ambessa|AD|early,split
Amumu|AP|engage,front
Anivia|AP|peel,scaling
Annie|AP|engage,pick
Aphelios|AD|scaling
Ashe|AD|engage,pick,peel
Aurelion Sol|AP|scaling,poke
Aurora|AP|pick,early
Azir|AP|scaling,poke
Bard|AP|pick,peel
Bel'Veth|AD|scaling,split
Blitzcrank|AP|pick,engage,early
Brand|AP|poke
Braum|AP|peel,front
Briar|AD|early,engage
Caitlyn|AD|poke,early
Camille|AD|split,pick
Cassiopeia|AP|scaling
Cho'Gath|AP|front,scaling
Corki|MIX|poke,scaling
Darius|AD|early,front
Diana|AP|engage
Dr. Mundo|AD|front,scaling
Draven|AD|early
Ekko|AP|pick,split
Elise|AP|early,pick
Evelynn|AP|pick
Ezreal|AD|poke,scaling
Fiddlesticks|AP|engage
Fiora|AD|split,scaling
Fizz|AP|pick
Galio|AP|engage,peel,front
Gangplank|AD|scaling,split
Garen|AD|front,split
Gnar|AD|front,engage
Gragas|AP|engage,pick,front
Graves|AD|early
Gwen|AP|split,scaling
Hecarim|AD|engage,early
Heimerdinger|AP|poke
Hwei|AP|poke,pick
Illaoi|AD|split,front
Irelia|AD|split,early
Ivern|AP|peel
Janna|AP|peel
Jarvan IV|AD|engage,early
Jax|AD|split,scaling
Jayce|AD|poke,early
Jhin|AD|pick,poke
Jinx|AD|scaling
K'Sante|AD|front,engage
Kai'Sa|MIX|scaling
Kalista|AD|early
Karma|AP|poke,peel,early
Karthus|AP|scaling
Kassadin|AP|scaling,pick
Katarina|AP|pick
Kayle|MIX|scaling
Kayn|AD|pick
Kennen|AP|engage
Kha'Zix|AD|pick
Kindred|AD|scaling
Kled|AD|engage,early
Kog'Maw|MIX|scaling
LeBlanc|AP|pick,early
Lee Sin|AD|early,pick
Leona|AP|engage,pick,front
Lillia|AP|engage,scaling
Lissandra|AP|engage,pick,peel
Lucian|AD|early
Lulu|AP|peel
Lux|AP|poke,pick
Malphite|AP|engage,front
Malzahar|AP|pick
Maokai|AP|engage,peel,front
Master Yi|AD|scaling
Mel|AP|poke,scaling
Milio|AP|peel
Miss Fortune|AD|poke,early
Mordekaiser|AP|front,split
Morgana|AP|pick,peel
Naafiri|AD|pick,early
Nami|AP|peel
Nasus|AD|split,scaling,front
Nautilus|AP|engage,pick,front
Neeko|AP|engage,pick
Nidalee|AP|poke,early
Nilah|AD|scaling
Nocturne|AD|pick
Nunu & Willump|AP|pick,front
Olaf|AD|early,front
Orianna|AP|engage,scaling
Ornn|AP|engage,front
Pantheon|AD|early,pick
Poppy|AD|front,peel,engage
Pyke|AD|pick
Qiyana|AD|pick,engage
Quinn|AD|split,early
Rakan|AP|engage
Rammus|AP|front,engage
Rek'Sai|AD|early,pick
Rell|AP|engage,front
Renata Glasc|AP|peel
Renekton|AD|early,front
Rengar|AD|pick
Riven|AD|split,early
Rumble|AP|engage,early
Ryze|AP|scaling,split
Samira|AD|early
Sejuani|AP|engage,front
Senna|AD|poke,scaling
Seraphine|AP|peel,poke,engage
Sett|AD|front,engage,early
Shaco|AD|pick,early
Shen|AD|front,peel
Shyvana|MIX|scaling,front
Singed|AP|front,split
Sion|AD|front,engage
Sivir|AD|scaling
Skarner|AP|pick,engage,front
Smolder|MIX|scaling
Sona|AP|peel,scaling
Soraka|AP|peel
Swain|AP|front
Sylas|AP|pick
Syndra|AP|pick,poke
Tahm Kench|AP|peel,front
Taliyah|AP|pick,engage
Talon|AD|pick,early
Taric|AP|peel,front
Teemo|AP|split,poke
Thresh|AP|pick,peel,engage
Tristana|AD|scaling
Trundle|AD|split,early,front
Tryndamere|AD|split
Twisted Fate|AP|pick
Twitch|AD|scaling,pick
Udyr|AP|front,split
Urgot|AD|front
Varus|AD|poke,pick
Vayne|AD|scaling,split
Veigar|AP|scaling
Vel'Koz|AP|poke
Vex|AP|pick,engage
Vi|AD|engage,pick,early
Viego|AD|early
Viktor|AP|poke,scaling
Vladimir|AP|scaling
Volibear|AP|front,early
Warwick|AD|early,pick
Wukong|AD|engage,front
Xayah|AD|scaling
Xerath|AP|poke
Xin Zhao|AD|early,engage
Yasuo|AD|scaling
Yone|AD|engage,scaling
Yorick|AD|split
Yuumi|AP|peel
Zac|AP|engage,front
Zed|AD|pick,split
Zeri|AD|scaling
Ziggs|AP|poke
Zilean|AP|peel
Zoe|AP|poke,pick
Zyra|AP|poke
`;

export const TRAIT_LABELS = {
  engage: 'Engage', pick: 'Pick', poke: 'Poke', peel: 'Peel', split: 'Split', early: 'Early', scaling: 'Scaling', front: 'Frontline',
};

/** The styles of play an identity can have – each is carried by champions with one trait. */
// adc = what an ADC needs to fit the style (the ADC carries in engage and protect comps, it doesn't start fights or peel).
export const STYLES = [
  { key: 'engage', label: 'Engage / teamfight', trait: 'engage', adc: ['engage', 'scaling'], desc: 'Začínáme fighty my – tank nebo jungler skočí, zbytek navazuje. Hraje se přes draky a 5v5.' },
  { key: 'pick', label: 'Pick (chytání)', trait: 'pick', desc: 'Chytáme jednotlivce ve vizi i mimo ni, pak bereme objektiv v přesile.' },
  { key: 'poke', label: 'Poke & siege', trait: 'poke', desc: 'Ubíráme na dálku, nevstupujeme do fightu, dokud nemají málo HP. Tlačíme věže.' },
  { key: 'protect', label: 'Protect the carry', trait: 'peel', adc: ['scaling'], desc: 'Všechno pro jednoho carry (většinou ADC) – peel, štíty, hrajeme na late.' },
  { key: 'split', label: 'Split push', trait: 'split', desc: 'Jeden silný hráč tlačí side lane (4-1 / 1-3-1), zbytek drží mid a objektivy.' },
  { key: 'early', label: 'Early skirmish', trait: 'early', desc: 'Silní do 20. minuty – invady, ganky, 2v2 a 3v3, rychlé věže. Hru ukončit dřív, než se škáluje.' },
];
export const STYLE_LABELS = Object.fromEntries(STYLES.map((s) => [s.key, s.label]));

const TABLE = new Map();
for (const line of RAW.trim().split('\n')) {
  const [name, dmg, traits] = line.split('|');
  TABLE.set(name, { dmg, traits: traits.split(',').filter(Boolean) });
}

/** { dmg: 'AD'|'AP'|'MIX', traits: [...], guessed: bool } for a champion; info = Data Dragon { tags, attack, magic }. */
export function traitsOf(name, info) {
  const hit = TABLE.get(name);
  if (hit) return { ...hit, guessed: false };
  const tags = info?.tags || [];
  const traits = new Set();
  if (tags.includes('Tank')) traits.add('front').add('engage');
  if (tags.includes('Assassin')) traits.add('pick');
  if (tags.includes('Marksman')) traits.add('scaling');
  if (tags.includes('Support')) traits.add('peel');
  if (tags.includes('Mage') && !tags.includes('Support')) traits.add('poke');
  if (tags.includes('Fighter') && !tags.includes('Tank')) traits.add('split');
  const attack = info?.attack || 0;
  const magic = info?.magic || 0;
  const dmg = Math.abs(attack - magic) <= 1 && attack && magic ? 'MIX' : magic > attack ? 'AP' : 'AD';
  return { dmg, traits: [...traits], guessed: true };
}

/** Does a champion (traits t) fit a style when played in role? */
export function styleFits(style, t, role) {
  const st = STYLES.find((s) => s.key === style);
  if (!st) return false;
  const need = role === 'ADC' && st.adc ? st.adc : [st.trait];
  return need.some((x) => t.traits.includes(x));
}

/**
 * Checks a composition (list of champion names, ideally 5). Returns
 * { ad, ap, counts: {trait: n}, warnings: [...], good: [...] }.
 */
export function analyzeComp(champs, infoMap) {
  const list = champs.filter(Boolean).map((c) => ({ name: c, ...traitsOf(c, infoMap?.get(c)) }));
  let ad = 0, ap = 0;
  const counts = Object.fromEntries(Object.keys(TRAIT_LABELS).map((k) => [k, 0]));
  for (const c of list) {
    // A tank adds less damage than a carry.
    const w = c.traits.includes('front') ? 0.5 : 1;
    if (c.dmg === 'AD') ad += w; else if (c.dmg === 'AP') ap += w; else { ad += w / 2; ap += w / 2; }
    for (const t of c.traits) counts[t] = (counts[t] || 0) + 1;
  }
  const warnings = [];
  const good = [];
  if (list.length >= 4) {
    const total = ad + ap || 1;
    if (ap / total < 0.2) warnings.push('Skoro celé AD – soupeř stačí stavět armor.');
    else if (ad / total < 0.2) warnings.push('Skoro celé AP – soupeř stačí stavět magic resist.');
    else good.push('Vyvážený damage AD / AP.');
    if (!counts.front) warnings.push('Žádný frontline – nikdo nevydrží první spelly.');
    if (!counts.engage && !counts.pick) warnings.push('Nikdo neumí začít fight ani chytit hráče.');
    if (counts.scaling >= 3 && counts.early === 0) warnings.push('Hodně scalingu, nic na early – první 15 minut přežít, ne bojovat.');
    if (counts.early >= 3 && counts.scaling === 0) warnings.push('Silné early, slabý late – hru je potřeba ukončit do ~25. minuty.');
    if (counts.engage >= 2) good.push(`${counts.engage}× engage – umíte začít teamfight.`);
    if (counts.peel >= 2) good.push(`${counts.peel}× peel – carry se dá ochránit.`);
  }
  return { ad, ap, counts, warnings, good, list };
}
