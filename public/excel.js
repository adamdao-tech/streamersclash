// Čtení tabulek v prohlížeči (ceny hráčů v Queue scoutingu): .xlsx, .csv/.tsv nebo vložený text.
// Bez knihovny: xlsx je zip s XML, rozbalí ho DecompressionStream. Soubor nikam neodchází,
// na server jdou jen spárovaní hráči a jejich ceny.

const MAX_FILE = 15 * 1024 * 1024;
const MAX_XML = 80 * 1024 * 1024;

/* ---------- zip ---------- */

function zipEntries(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Soubor není platný .xlsx (nepodařilo se ho otevřít).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen)).replace(/\\/g, '/').replace(/^\/+/, '');
    out.set(name, { method, csize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function zipRead(buf, entry) {
  if (entry.size > MAX_XML) throw new Error('List v excelu je moc velký.');
  const dv = new DataView(buf);
  const start = entry.offset + 30 + dv.getUint16(entry.offset + 26, true) + dv.getUint16(entry.offset + 28, true);
  const raw = new Uint8Array(buf, start, entry.csize);
  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) throw new Error('Excel používá nepodporovanou kompresi.');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/* ---------- xlsx ---------- */

const xml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Excel se nepodařilo přečíst (poškozené XML).');
  return doc;
};
const all = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const child = (node, tag) => [...node.children].find((c) => c.localName === tag);

/** Text buňky bez fonetických přepisů (rPh), které Excel ukládá vedle bohatého textu. */
const richText = (si) => all(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + c - 64;
  }
  return n - 1;
}

function parseSheet(text, strings) {
  const rows = [];
  let rowNo = 0;
  for (const r of all(xml(text), 'row')) {
    const at = Number(r.getAttribute('r'));
    rowNo = at > 0 ? at : rowNo + 1;
    const cells = [];
    let col = -1;
    for (const c of [...r.children].filter((x) => x.localName === 'c')) {
      const ref = c.getAttribute('r');
      col = ref ? colIndex(ref) : col + 1;
      const type = c.getAttribute('t') || 'n';
      const v = child(c, 'v')?.textContent;
      let val = '';
      if (type === 's') val = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') { const is = child(c, 'is'); val = is ? richText(is) : ''; }
      else if (type === 'str') val = v ?? '';
      else if (type === 'n' && v != null && v !== '') val = Number(v);
      while (cells.length < col) cells.push('');
      cells[col] = val;
    }
    rows[rowNo - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

async function readXlsx(buf) {
  const zip = zipEntries(buf);
  const read = async (name) => { const e = zip.get(name); return e ? zipRead(buf, e) : null; };
  const wbText = await read('xl/workbook.xml');
  if (!wbText) throw new Error('V souboru není sešit Excelu.');
  const relsText = await read('xl/_rels/workbook.xml.rels');
  const rels = new Map(relsText ? all(xml(relsText), 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]) : []);
  const ssText = await read('xl/sharedStrings.xml');
  const strings = ssText ? all(xml(ssText), 'si').map(richText) : [];
  const sheets = [];
  for (const s of all(xml(wbText), 'sheet')) {
    if (s.getAttribute('state') && s.getAttribute('state') !== 'visible') continue;
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    const target = rels.get(rid);
    if (!target) continue;
    const text = await read(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    if (text) sheets.push({ name: s.getAttribute('name') || `List ${sheets.length + 1}`, rows: parseSheet(text, strings) });
  }
  if (!sheets.length) throw new Error('V excelu není žádný list.');
  return sheets;
}

/* ---------- csv / vložený text ---------- */

export function parseDelimited(text) {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const delim = ['\t', ';', ','].map((d) => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  const endCell = () => { row.push(cell.trim()); cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delim) endCell();
    else if (ch === '\n') { endCell(); rows.push(row); row = []; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { endCell(); rows.push(row); }
  return rows;
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1250').decode(buf); } // český Excel ukládá CSV v této kódové stránce
}

/** Soubor → [{ name, rows: [[buňky]] }] */
export async function readTable(file) {
  if (file.size > MAX_FILE) throw new Error('Soubor je moc velký (max 15 MB).');
  const name = file.name.toLowerCase();
  if (/\.xls$|\.xlsb$|\.ods$/.test(name)) throw new Error('Tenhle formát neumím – v Excelu ho ulož jako .xlsx, nebo tabulku zkopíruj a vlož.');
  const buf = await file.arrayBuffer();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return readXlsx(buf);
  return [{ name: file.name, rows: parseDelimited(decodeText(buf)) }];
}

/* ---------- ceny a sloupce ---------- */

/** 1500 · "1 500 Kč" · "1.500,-" · "1,5k" · "2 mil" → číslo; text bez ceny ("nedostal se", "-", "") → null */
export function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  let t = String(v ?? '').toLowerCase().replace(/[\s  ]/g, '').replace(/[.,]-+$/, '');
  const m = t.match(/^(\d[\d.,]*)(k|tis\.?|m|mil\.?)?(kč|czk|eur|€|\$|b|bod[yůu]?|pts|coins?)?$/);
  if (!m) return null;
  t = m[1].replace(/[.,]$/, '');
  if (t.includes('.') && t.includes(',')) {
    const dec = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    t = t.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '');
  else t = t.replace(',', '.');
  const n = Number(t) * (m[2]?.[0] === 'k' || m[2]?.[0] === 't' ? 1000 : m[2]?.[0] === 'm' ? 1e6 : 1);
  return Number.isFinite(n) ? n : null;
}

export const foldName = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

const NAME_HEAD = /^(hrac|nick|prezdivka|jmeno|name|player|streamer|ucastnik|kapitan|discord|twitch|riot|summoner|ign)/;
const PRICE_HEAD = /(cen[aeyu]?$|cena|price|prize|hodnot|cost|kredit|coin|budget|naklad)/;

const ROLE_HEAD = /^(primar|hlavni|pozice|role|lane|linka)/;
const ROLE_ALIASES = { top: 'TOP', jungle: 'JUNGLE', jng: 'JUNGLE', jgl: 'JUNGLE', jg: 'JUNGLE', mid: 'MID', middle: 'MID', adc: 'ADC', bot: 'ADC', bottom: 'ADC', support: 'SUPPORT', supp: 'SUPPORT', sup: 'SUPPORT' };
export const parseRole = (v) => ROLE_ALIASES[foldName(v)] ?? null;

/** Odhad: který sloupec je hráč, který cena a na kterém řádku (od 1) začínají data. */
export function guessColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const heads = (rows[i] || []).map(foldName);
    const priceCol = heads.findIndex((h) => PRICE_HEAD.test(h));
    const nameCol = heads.findIndex((h, c) => c !== priceCol && NAME_HEAD.test(h));
    if (priceCol >= 0 && nameCol >= 0) return { nameCol, priceCol, roleCol: heads.findIndex((h) => ROLE_HEAD.test(h)), start: i + 2 };
  }
  // bez hlavičky: cena = sloupec s nejvíc čísly (ne pořadí 1, 2, 3…), hráč = sloupec s nejvíc texty
  const width = Math.max(0, ...rows.map((r) => r.length));
  const stats = Array.from({ length: width }, (_, c) => {
    const vals = rows.slice(0, 1000).map((r) => r[c]).filter((v) => v !== '' && v != null);
    const nums = vals.map(parsePrice).filter((n) => n != null);
    const sequence = nums.length > 2 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    return { c, nums: sequence ? 0 : nums.length, texts: vals.length - nums.length };
  });
  const priceCol = [...stats].sort((a, b) => b.nums - a.nums)[0]?.c ?? 0;
  const nameCol = [...stats].filter((s) => s.c !== priceCol).sort((a, b) => b.texts - a.texts)[0]?.c ?? 0;
  const first = rows.findIndex((r) => String(r[nameCol] ?? '').trim() && parsePrice(r[priceCol]) != null);
  return { nameCol, priceCol, roleCol: -1, start: first < 0 ? 1 : first + 1 };
}

/** Kolik řádků má při daných sloupcích hráče i cenu – podle toho se pozná, který list je ten pravý. */
export function countPriced(rows, { nameCol, priceCol, start }) {
  return rows.slice(Math.max(start - 1, 0)).filter((r) => String(r[nameCol] ?? '').trim() && parsePrice(r[priceCol]) != null).length;
}

export const columnLabel = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
