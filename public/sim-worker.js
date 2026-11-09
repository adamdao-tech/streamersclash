// Velká simulace picku – běží ve Web Workeru, každé jádro jeden worker.
// Jedna simulace = jedna celá aukce. Pravidla: každý kapitán musí mít všech 5 pozic (sebe + 4 hráče)
// a nikdo nesmí jít s essence do mínusu. Aukce, ve které to nevyjde, se nepočítá (je „neplatná“).
//
// Zprávy: main → { type: 'init', data } / { type: 'run', count } / { type: 'pause' } / { type: 'snapshot' }
//         worker → { type: 'progress', done, valid } / { type: 'snapshot', ... } / { type: 'done' }

const STEP_DEFAULT = 5;
const LINEUP_CAP = 8000;    // kolik různých sestav na kapitána si worker pamatuje (paměť: × kapitáni × vlákna)
const CHUNK = 5000;         // simulací mezi kontrolami zpráv

let D = null;               // připravená data
let S = null;               // statistiky
let remaining = 0, running = false, doneTotal = 0;
let rngState = 1;

function rand() {
  // mulberry32
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function init(data) {
  // data: { players: [{price, role(0-4), blocked, fav}], caps: [{budget, role(-1..4), own, fixed: [playerIdx]}], aggr, step, seed }
  const n = data.players.length, C = data.caps.length;
  const price = new Float64Array(n), role = new Int8Array(n), blocked = new Uint8Array(n), fav = new Uint8Array(n);
  data.players.forEach((p, i) => { price[i] = p.price; role[i] = p.role; blocked[i] = p.blocked ? 1 : 0; fav[i] = p.fav ? 1 : 0; });
  const byRole = [0, 1, 2, 3, 4].map((r) => [...Array(n).keys()].filter((i) => role[i] === r).sort((a, b) => price[a] - price[b]));
  const fixedTaken = new Uint8Array(n);
  for (const c of data.caps) for (const i of c.fixed) fixedTaken[i] = 1;
  D = {
    n, C, price, role, blocked, fav, byRole, fixedTaken,
    capBudget: data.caps.map((c) => c.budget), capRole: data.caps.map((c) => c.role), capOwn: data.caps.map((c) => !!c.own),
    capFixed: data.caps.map((c) => c.fixed), aggr: data.aggr, step: data.step || STEP_DEFAULT,
    // pracovní pole (znovupoužívaná)
    taken: new Uint8Array(n), owner: new Int16Array(n), paid: new Float64Array(n),
    taste: new Float64Array(C * n), order: new Int32Array(n), key: new Float64Array(n),
    budget: new Float64Array(C), has: new Uint8Array(C * 5), cnt: new Int8Array(C), needCount: new Int32Array(5),
    kth: [0, 1, 2, 3, 4].map(() => new Float64Array(C + 1)), // kth[r][k] = cena k-tého nejlevnějšího volného na pozici r
    lk: new Float64Array(C),
    bidC: new Int32Array(C), bidMax: new Float64Array(C), tmp: new Float64Array(5), unsold: new Int32Array(n),
  };
  rngState = (data.seed >>> 0) || 1;
  S = {
    valid: 0, invalid: 0,
    sold: new Float64Array(n), sum: new Float64Array(n), min: new Float64Array(n).fill(Infinity), max: new Float64Array(n),
    by: new Float64Array(n * C), left: new Float64Array(C), lineups: Array.from({ length: C }, () => new Map()), lineupOverflow: new Float64Array(C),
  };
}

/** Přepočítá ceny k-tého nejlevnějšího volného hráče na pozici r. */
function refreshKth(r) {
  const list = D.byRole[r], arr = D.kth[r], taken = D.taken;
  let k = 0;
  for (let j = 0; j < list.length && k < arr.length; j++) if (!taken[list[j]]) arr[k++] = D.price[list[j]];
  for (; k < arr.length; k++) arr[k] = Infinity; // málo hráčů na pozici = nesplnitelné
}
function freeCount(r) { const a = D.kth[r]; let k = 0; while (k < a.length && a[k] !== Infinity) k++; return k; }

/**
 * Kolik si kapitán c musí nechat, když teď kupuje na pozici r. Opatrně: na každou další potřebnou pozici
 * počítá s cenou toho hráče, na kterého dojde řada, i když ostatní kapitáni s potřebou té pozice koupí ty levnější.
 */
function reserve(c, r, safe) {
  const has = D.has, tmp = D.tmp;
  const slotsAfter = 4 - D.cnt[c] - 1;
  if (slotsAfter <= 0) return 0;
  let m = 0;
  for (let q = 0; q < 5; q++) {
    if (q === r || has[c * 5 + q] || D.capRole[c] === q) continue;
    const k = safe ? Math.max(1, D.needCount[q]) : 1;
    const arr = D.kth[q];
    tmp[m++] = arr[Math.min(k, arr.length) - 1];
  }
  // kapitán bez pozice potřebuje jen 4 hráče: bere nejlevnější kombinaci
  if (m > slotsAfter) { const t = Array.from(tmp.subarray(0, m)).sort((a, b) => a - b); let s = 0; for (let i = 0; i < slotsAfter; i++) s += t[i]; return s; }
  let s = 0; for (let i = 0; i < m; i++) s += tmp[i];
  return s;
}
const needs = (c, r) => D.cnt[c] < 4 && !D.has[c * 5 + r] && D.capRole[c] !== r;

function buy(c, p, amount) {
  const r = D.role[p];
  D.taken[p] = 1; D.owner[p] = c; D.paid[p] = amount;
  D.budget[c] -= amount; D.has[c * 5 + r] = 1; D.cnt[c]++;
  D.needCount[r] = 0;
  for (let k = 0; k < D.C; k++) if (needs(k, r)) D.needCount[r]++;
  refreshKth(r);
}

function simulateOnce() {
  const { n, C, price, role, taken, owner, taste, order, key, budget, has, cnt, needCount, bidC, bidMax, aggr, step } = D;
  taken.set(D.fixedTaken); owner.fill(-1); has.fill(0); cnt.fill(0);
  for (let c = 0; c < C; c++) {
    budget[c] = D.capBudget[c];
    for (const p of D.capFixed[c]) { owner[p] = c; D.paid[p] = price[p]; has[c * 5 + role[p]] = 1; cnt[c]++; }
  }
  // pevné (naklikané) ceny jsou už odečtené v capBudget
  for (let r = 0; r < 5; r++) { needCount[r] = 0; for (let c = 0; c < C; c++) if (needs(c, r)) needCount[r]++; refreshKth(r); }
  for (let r = 0; r < 5; r++) if (freeCount(r) < needCount[r]) return false; // na pozici není dost hráčů

  // pořadí vyvolávání: od nejdražších s trochou náhody (klíč a index zabalené do jednoho čísla kvůli rychlému řazení)
  let m = 0;
  for (let p = 0; p < n; p++) if (!taken[p]) key[m++] = -Math.floor(price[p] * (0.85 + rand() * 0.3) * 64) * 1024 - p;
  const sorted = key.subarray(0, m).sort();
  const ord = order;
  for (let i = 0; i < m; i++) ord[i] = (-sorted[i]) % 1024;

  let un = 0;
  for (let oi = 0; oi < m; oi++) {
    const p = ord[oi], r = role[p], pr = price[p];
    if (!needCount[r]) continue;
    let nb = 0;
    for (let c = 0; c < C; c++) {
      if (!needs(c, r)) continue;
      const room = budget[c] - reserve(c, r, true);
      if (room < pr) continue;
      let t = 1 + aggr * (rand() * 1.25 - 0.25);
      if (D.capOwn[c]) { if (D.blocked[p]) continue; if (D.fav[p]) t += 0.1; }
      taste[c * n + p] = t;
      const max = Math.floor(Math.min(pr * t, room));
      if (max >= pr) { bidC[nb] = c; bidMax[nb] = max + rand() * 0.5; nb++; }
    }
    if (!nb) { D.unsold[un++] = p; continue; }
    let w = 0, s = -1;
    for (let i = 1; i < nb; i++) {
      if (bidMax[i] > bidMax[w]) { s = w; w = i; } else if (s < 0 || bidMax[i] > bidMax[s]) s = i;
    }
    const wm = Math.floor(bidMax[w]);
    const amount = s >= 0 ? Math.min(wm, Math.max(pr, Math.floor(bidMax[s]) + step)) : pr;
    buy(bidC[w], p, amount);
  }
  // dobírání za vyvolávací cenu: o koho nikdo nestál, dostane kapitán, kterému zbylo nejvíc
  const rest = Array.from(D.unsold.subarray(0, un)).sort((a, b) => price[b] - price[a]);
  for (const p of rest) {
    const r = role[p], pr = price[p];
    if (!needCount[r]) continue;
    let best = -1;
    for (let c = 0; c < C; c++) {
      if (!needs(c, r) || (D.capOwn[c] && D.blocked[p])) continue;
      if (budget[c] - reserve(c, r, true) >= pr && (best < 0 || budget[c] > budget[best])) best = c;
    }
    if (best >= 0) buy(best, p, pr);
  }
  // doplnění: komu něco chybí, dostane nejlevnějšího volného, kterého si může dovolit (i SGooB ✕, když jinak nejde)
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < C; c++) {
      while (cnt[c] < 4) {
        let pick = -1, pr = Infinity;
        for (let r = 0; r < 5; r++) {
          if (!needs(c, r)) continue;
          for (const p of D.byRole[r]) {
            if (taken[p]) continue;
            if (pass === 0 && D.capOwn[c] && D.blocked[p]) continue;
            if (price[p] < pr && budget[c] - price[p] >= reserve(c, r, false)) { pick = p; pr = price[p]; }
            break; // seznam je seřazený: první volný je nejlevnější
          }
        }
        if (pick < 0) break;
        buy(c, pick, pr);
      }
    }
  }
  for (let c = 0; c < C; c++) if (cnt[c] < 4 || budget[c] < 0) return false;
  return true;
}

function record() {
  const { n, C, owner, paid } = D;
  S.valid++;
  const lk = D.lk;
  lk.fill(0);
  for (let p = 0; p < n; p++) {
    const c = owner[p];
    if (c < 0) continue;
    lk[c] = lk[c] * 1024 + p + 1; // hráči jdou vzestupně → stejná sestava = stejné číslo
    if (D.fixedTaken[p]) continue;
    const a = paid[p];
    S.sold[p]++; S.sum[p] += a; if (a < S.min[p]) S.min[p] = a; if (a > S.max[p]) S.max[p] = a;
    S.by[p * C + c]++;
  }
  for (let c = 0; c < C; c++) {
    S.left[c] += D.budget[c];
    const k = lk[c];
    const map = S.lineups[c];
    const v = map.get(k);
    if (v !== undefined) map.set(k, v + 1);
    else if (map.size < LINEUP_CAP) map.set(k, 1);
    else S.lineupOverflow[c]++;
  }
}

function snapshot() {
  // číslo sestavy → seznam indexů hráčů
  const decode = (k) => { const out = []; while (k > 0) { out.unshift((k % 1024) - 1); k = Math.floor(k / 1024); } return out; };
  const top = S.lineups.map((map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([k, v]) => [decode(k), v]));
  postMessage({
    type: 'snapshot', valid: S.valid, invalid: S.invalid,
    sold: S.sold, sum: S.sum, min: S.min, max: S.max, by: S.by, left: S.left,
    lineups: top, lineupDistinct: S.lineups.map((m) => m.size), lineupOverflow: S.lineupOverflow,
  });
}

let sinceSnap = 0;
function loop() {
  if (!running) return;
  const t0 = performance.now();
  let k = 0;
  while (remaining > 0 && performance.now() - t0 < 150) {
    const batch = Math.min(CHUNK, remaining);
    for (let i = 0; i < batch; i++) { if (simulateOnce()) record(); else S.invalid++; }
    remaining -= batch; doneTotal += batch; k += batch;
  }
  postMessage({ type: 'progress', done: doneTotal, valid: S.valid });
  if (++sinceSnap >= 12 || remaining <= 0) { sinceSnap = 0; snapshot(); }
  if (remaining <= 0) { running = false; postMessage({ type: 'done' }); return; }
  setTimeout(loop, 0);
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { init(m.data); doneTotal = 0; remaining = 0; running = false; }
  else if (m.type === 'run') { remaining = m.count; if (!running) { running = true; loop(); } }
  else if (m.type === 'pause') { running = false; snapshot(); }
  else if (m.type === 'snapshot') snapshot();
};
