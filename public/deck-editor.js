// Presentations: a PowerPoint-like slide editor and a full-screen player.
// A slide is a 1600 × 900 canvas with free-form elements (text boxes, shapes, pictures, arrows).
// Everything is sized in container units of the slide, so the same markup is a thumbnail, the
// editing canvas and the full-screen slide.
import { api, esc, shrinkImage, blobToBase64 } from '/app.js';

export const W = 1600;
export const H = 900;
const u = (v) => `${(v / 16).toFixed(3)}cqw`; // 1600 units = 100cqw
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = (x) => JSON.parse(JSON.stringify(x));
const deckImg = (id) => `/api/coaching/deck-images/${id}`;

export const THEMES = {
  sc: { name: 'SC – tmavý se zlatou', bg: 'radial-gradient(120% 90% at 0% 0%, #1b2744 0%, #0d1424 55%, #0a0f1c 100%)', fg: '#c5cdde', title: '#ffffff', accent: '#e8b84a' },
  dark: { name: 'Černý', bg: '#050608', fg: '#d9dde6', title: '#ffffff', accent: '#e8b84a' },
  blue: { name: 'Modrý', bg: 'linear-gradient(135deg, #0d3270 0%, #071633 100%)', fg: '#dbe7ff', title: '#ffffff', accent: '#7dbbff' },
  light: { name: 'Světlý', bg: '#ffffff', fg: '#3a4050', title: '#111827', accent: '#c8901a' },
};
const themeOf = (t) => THEMES[t] || THEMES.sc;
const PLACEHOLDER = { title: 'Klikněte a zadejte nadpis', sub: 'Klikněte a zadejte podnadpis', body: 'Klikněte a zadejte text', none: 'Zadejte text' };

// --- slide layouts (like "Nový snímek ▾" in PowerPoint) ------------------------------------
const T = (o) => ({ id: uid(), type: 'text', html: '', size: 32, font: 'inter', color: null, align: 'l', valign: 't', fill: null, stroke: null, shape: 'none', role: 'none', ...o });
const titleBox = () => T({ x: 90, y: 50, w: 1420, h: 140, size: 60, font: 'display', valign: 'b', role: 'title' });
export const LAYOUTS = {
  title: { name: 'Úvodní snímek', make: () => [T({ x: 120, y: 260, w: 1360, h: 220, size: 88, font: 'display', align: 'c', valign: 'b', role: 'title' }), T({ x: 220, y: 500, w: 1160, h: 120, size: 36, align: 'c', role: 'sub' })] },
  content: { name: 'Nadpis a obsah', make: () => [titleBox(), T({ x: 90, y: 220, w: 1420, h: 620, size: 34, role: 'body' })] },
  two: { name: 'Text a obrázek', make: () => [titleBox(), T({ x: 90, y: 220, w: 690, h: 620, size: 32, role: 'body' }), { id: uid(), type: 'image', x: 820, y: 220, w: 690, h: 620, image_id: null, fit: 'contain' }] },
  picture: { name: 'Nadpis a obrázek', make: () => [titleBox(), { id: uid(), type: 'image', x: 90, y: 220, w: 1420, h: 620, image_id: null, fit: 'contain' }] },
  section: { name: 'Záhlaví oddílu', make: () => [T({ x: 120, y: 330, w: 1360, h: 160, size: 80, font: 'display', valign: 'b', role: 'title' }), T({ x: 120, y: 510, w: 1360, h: 90, size: 32, role: 'sub' })] },
  titleonly: { name: 'Jen nadpis', make: () => [titleBox()] },
  blank: { name: 'Prázdný', make: () => [] },
};
export const newSlide = (layout = 'content') => ({ elements: (LAYOUTS[layout] || LAYOUTS.content).make(), notes: null, bg: null });

// --- old slides ({ title, body, image_id }) → elements ----------------------------------------
function legacyText(body) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', list = false;
  for (const raw of String(body || '').split('\n')) {
    const m = raw.match(/^\s*[-•*]\s+(.*)$/);
    if (m) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (raw.trim()) html += `<div>${inline(raw.trim())}</div>`;
  }
  return list ? html + '</ul>' : html;
}
export function normalizeSlide(s) {
  if (Array.isArray(s?.elements)) return { elements: s.elements, notes: s.notes ?? null, bg: s.bg ?? null };
  const hasBody = !!(s?.body && s.body.trim());
  const layout = s?.image_id ? (hasBody ? 'two' : 'picture') : 'content';
  const slide = newSlide(layout);
  for (const e of slide.elements) {
    if (e.role === 'title') e.html = esc(s?.title || '');
    if (e.role === 'body') e.html = legacyText(s?.body);
    if (e.type === 'image') e.image_id = s?.image_id ?? null;
  }
  return slide;
}

// --- text HTML sanitizing (what contenteditable produces, nothing else) ---------------------------
const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'SPAN', 'FONT']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'LINK', 'META', 'IMG', 'VIDEO', 'AUDIO']);
const STYLES = ['color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'background-color'];
function cleanNode(node) {
  for (const ch of [...node.childNodes]) {
    if (ch.nodeType === 3) continue;
    if (ch.nodeType !== 1 || DROP.has(ch.tagName)) { ch.remove(); continue; }
    cleanNode(ch);
    if (!KEEP.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); continue; }
    const keep = STYLES.map((p) => [p, ch.style.getPropertyValue(p)])
      .filter(([p, v]) => v && !/url|expression|\\/i.test(v) && !(p === 'background-color' && /transparent|rgba\([^)]*,\s*0\)/.test(v)));
    const fontColor = ch.tagName === 'FONT' ? ch.getAttribute('color') : null;
    for (const a of [...ch.attributes]) ch.removeAttribute(a.name);
    for (const [p, v] of keep) ch.style.setProperty(p, v);
    if (fontColor && /^#?[0-9a-z]{3,20}$/i.test(fontColor)) ch.style.color = fontColor;
    if ((ch.tagName === 'SPAN' || ch.tagName === 'FONT') && !ch.getAttribute('style')) ch.replaceWith(...ch.childNodes);
  }
}
const parser = new DOMParser();
export function sanitize(html) {
  const root = parser.parseFromString(`<div>${html || ''}</div>`, 'text/html').body.firstElementChild;
  if (!root) return '';
  cleanNode(root);
  return root.innerHTML;
}
const isEmptyHtml = (html) => !String(html || '').replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

// --- rendering ----------------------------------------------------------------------------
function boxStyle(e) { return `left:${u(e.x)};top:${u(e.y)};width:${u(e.w)};height:${u(e.h)}`; }
function textEl(e, editor) {
  const empty = isEmptyHtml(e.html);
  if (empty && !editor && !e.fill && !e.stroke) return '';
  const st = [
    boxStyle(e), `font-size:${u(e.size)}`,
    e.color ? `color:${e.color}` : '',
    e.fill ? `background:${e.fill}` : '',
    e.stroke ? `border:${u(4)} solid ${e.stroke}` : '',
  ].filter(Boolean).join(';');
  const cls = ['el', 'el-text', `va-${e.valign}`, `al-${e.align}`, `ff-${e.font}`, `sh-${e.shape}`, `ro-${e.role}`, empty ? 'empty' : ''].join(' ');
  return `<div class="${cls}" data-el="${e.id}" style="${st}"><div class="el-c" data-ph="${esc(PLACEHOLDER[e.role] || PLACEHOLDER.none)}">${empty ? '' : sanitize(e.html)}</div></div>`;
}
function imageEl(e, editor) {
  if (!e.image_id) return editor ? `<div class="el el-img el-ph" data-el="${e.id}" style="${boxStyle(e)}"><div class="ph-in"><span class="ph-ico">🖼</span><span>Klikni a vlož obrázek<br><small>Ctrl+V, přetažení nebo soubor</small></span></div></div>` : '';
  return `<div class="el el-img" data-el="${e.id}" style="${boxStyle(e)}"><img src="${deckImg(e.image_id)}" alt="" draggable="false" style="object-fit:${e.fit}"></div>`;
}
function head(x1, y1, x2, y2, w) {
  const a = Math.atan2(y2 - y1, x2 - x1), len = Math.max(18, w * 3.2), wid = Math.max(14, w * 2.4);
  const bx = x2 - Math.cos(a) * len, by = y2 - Math.sin(a) * len;
  const px = -Math.sin(a) * wid / 2, py = Math.cos(a) * wid / 2;
  return { pts: `${x2},${y2} ${bx + px},${by + py} ${bx - px},${by - py}`, bx, by };
}
function lineEl(e) {
  let { x1, y1, x2, y2 } = e;
  let heads = '';
  if (e.head !== 'none') { const h = head(x1, y1, x2, y2, e.width); heads += `<polygon points="${h.pts}" fill="${e.color}"/>`; x2 = h.bx; y2 = h.by; }
  if (e.head === 'both') { const h = head(e.x2, e.y2, x1, y1, e.width); heads += `<polygon points="${h.pts}" fill="${e.color}"/>`; x1 = h.bx; y1 = h.by; }
  return `<svg class="el el-line" data-el="${e.id}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${e.color}" stroke-width="${e.width}" stroke-linecap="round" ${e.dash ? `stroke-dasharray="${e.width * 2.5} ${e.width * 2}"` : ''}/>${heads}
    <line class="hit" x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="transparent" stroke-width="${Math.max(30, e.width + 20)}"/></svg>`;
}
export function elementHtml(e, editor = false) {
  if (e.type === 'text') return textEl(e, editor);
  if (e.type === 'image') return imageEl(e, editor);
  if (e.type === 'line') return lineEl(e);
  return '';
}
export function slideStyle(slide, theme) {
  const t = themeOf(theme);
  return `--sl-bg:${slide.bg || t.bg};--sl-fg:${t.fg};--sl-title:${t.title};--sl-accent:${t.accent}`;
}
/** Read-only slide (thumbnails, player). */
export function slideHtml(slide, theme) {
  const s = normalizeSlide(slide);
  return `<div class="slide" style="${slideStyle(s, theme)}"><div class="sl-in">${s.elements.map((e) => elementHtml(e)).join('')}</div></div>`;
}

// --- full-screen player ----------------------------------------------------------------------
let presenter = null;
let show = null;
function ensurePresenter() {
  if (presenter) return presenter;
  presenter = document.createElement('div');
  presenter.className = 'presenter';
  presenter.hidden = true;
  presenter.tabIndex = -1;
  presenter.innerHTML = `<div class="pr-stage" id="pr-stage"></div>
    <div class="pr-bar"><button type="button" data-pr="-1" aria-label="Předchozí">‹</button><span id="pr-count"></span>
    <button type="button" data-pr="1" aria-label="Další">›</button><button type="button" data-pr="x" aria-label="Ukončit">✕</button></div>`;
  presenter.addEventListener('keydown', (e) => {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(e.key)) { e.preventDefault(); step(1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key)) { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(show.slides.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopShow(); }
  });
  presenter.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pr]');
    if (b) { if (b.dataset.pr === 'x') stopShow(); else step(Number(b.dataset.pr)); return; }
    if (e.target.closest('.pr-stage')) step(e.clientX < window.innerWidth / 3 ? -1 : 1);
  });
  presenter.addEventListener('contextmenu', (e) => { e.preventDefault(); step(-1); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && show) stopShow(); });
  return presenter;
}
function go(i) {
  if (!show || i < 0 || i >= show.slides.length) return;
  show.i = i;
  presenter.querySelector('#pr-stage').innerHTML = slideHtml(show.slides[i], show.theme);
  presenter.querySelector('#pr-count').textContent = `${i + 1} / ${show.slides.length}`;
}
const step = (d) => show && go(show.i + d);
function stopShow() {
  if (!show) return;
  const { onEnd, i } = show;
  show = null;
  presenter.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  onEnd?.(i);
}
/** Plays slides full screen. host = an open <dialog> to put the player into (top layer), or nothing. */
export function present(slides, theme, start = 0, { host, onEnd } = {}) {
  if (!slides.length) return;
  const p = ensurePresenter();
  show = { slides: slides.map(normalizeSlide), theme, i: 0, onEnd };
  for (const s of show.slides) for (const e of s.elements) if (e.type === 'image' && e.image_id) new Image().src = deckImg(e.image_id);
  (host || document.body).appendChild(p);
  p.hidden = false;
  go(Math.max(0, Math.min(start, slides.length - 1)));
  p.focus();
  p.requestFullscreen?.().catch(() => {});
}

// --- editor ----------------------------------------------------------------------------------
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 88, 100, 120, 150];
const COLORS = ['#ffffff', '#e8ecf4', '#8e9ab3', '#111827', '#e8b84a', '#f2c85b', '#e5484d', '#ff8f93', '#2fbf71', '#7fd18b', '#3b82f6', '#7dbbff', '#9146ff', '#c4a6ff'];
const SHAPES = [['text', 'Textové pole'], ['rect', 'Obdélník'], ['round', 'Zaoblený obdélník'], ['ellipse', 'Elipsa'], ['arrow', 'Šipka'], ['line', 'Čára']];
const ico = {
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  shape: '<svg viewBox="0 0 24 24"><rect x="3" y="10" width="11" height="11" rx="1"/><circle cx="16" cy="8" r="5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 19 19 5M10 5h9v9"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 10h10M4 14h16M4 18h10"/></svg>',
  center: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 10h10M4 14h16M7 18h10"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M4 6h16M10 10h10M4 14h16M10 18h10"/></svg>',
  top: '<svg viewBox="0 0 24 24"><path d="M4 4h16M12 20V8m-4 4 4-4 4 4"/></svg>',
  middle: '<svg viewBox="0 0 24 24"><path d="M4 12h16M12 3v5m0 8v5M9 6l3 3 3-3M9 18l3-3 3 3"/></svg>',
  bottom: '<svg viewBox="0 0 24 24"><path d="M4 20h16M12 4v12m-4-4 4 4 4-4"/></svg>',
  ul: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/></svg>',
  ol: '<svg viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M4 4h1.5v4M4 10.5c1-1 2.5-.5 2.2.6L4 14h2.5M4 16.5h2.3l-1 1.3c1 0 1.4.6 1.1 1.3-.3.7-1.6.8-2.4.2"/></svg>',
  indent: '<svg viewBox="0 0 24 24"><path d="M4 6h16M10 12h10M4 18h16M4 9l3 3-3 3"/></svg>',
  outdent: '<svg viewBox="0 0 24 24"><path d="M4 6h16M10 12h10M4 18h16M7 9l-3 3 3 3"/></svg>',
  front: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".35"/><path d="M15 5H5v10"/></svg>',
  back: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".35"/><path d="M9 19h10V9"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  caret: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
  fill: '<svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7-7 7z"/><path d="M19 15s2 2.5 2 3.5a2 2 0 0 1-4 0c0-1 2-3.5 2-3.5"/></svg>',
  stroke: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
};

function editorMarkup() {
  const btn = (cmd, icon, title, extra = '') => `<button type="button" class="tb" data-cmd="${cmd}" title="${title}" ${extra}>${icon}</button>`;
  const swatches = (cmd) => `<div class="swatches">${COLORS.map((c) => `<button type="button" class="sw" style="background:${c}" data-cmd="${cmd}" data-val="${c}" title="${c}"></button>`).join('')}
    <label class="sw sw-custom" title="Vlastní barva">+<input type="color" data-cmd="${cmd}" data-custom></label>
    <button type="button" class="sw sw-none" data-cmd="${cmd}" data-val="" title="Výchozí / žádná">⌀</button></div>`;
  return `
  <div class="de-top">
    <input id="de-title" maxlength="120" aria-label="Název prezentace" spellcheck="false">
    <select id="de-folder" aria-label="Složka"></select>
    <span class="de-status" id="de-status"></span>
    <span class="spacer"></span>
    ${btn('undo', ico.undo, 'Zpět (Ctrl+Z)')}${btn('redo', ico.redo, 'Znovu (Ctrl+Y)')}
    <button type="button" class="btn btn-small btn-ghost" data-cmd="delete-deck">Smazat prezentaci</button>
    <button type="button" class="btn btn-small" data-cmd="close">Zavřít</button>
    <div class="split-btn">
      <button type="button" class="btn btn-primary" data-cmd="play-start" title="Přehrát od začátku (F5)">${ico.play} Prezentovat</button>
      <button type="button" class="btn btn-primary" data-cmd="play-here" title="Od aktuálního snímku (Shift+F5)">od tohoto</button>
    </div>
  </div>
  <div class="de-ribbon" id="de-ribbon">
    <div class="rb-group">
      <div class="split-btn">
        <button type="button" class="tb tb-wide" data-cmd="new-slide" title="Nový snímek (Ctrl+M)">${ico.plus}<span>Nový snímek</span></button>
        <button type="button" class="tb tb-caret" data-menu="layouts" title="Rozložení nového snímku">${ico.caret}</button>
      </div>
      <button type="button" class="tb tb-wide" data-menu="layout-cur" title="Změnit rozložení snímku"><span>Rozložení</span>${ico.caret}</button>
      <span class="rb-label">Snímky</span>
    </div>
    <div class="rb-group">
      ${btn('add-text', ico.text, 'Textové pole')}
      ${btn('add-image', ico.image, 'Obrázek')}
      <button type="button" class="tb" data-menu="shapes" title="Tvary">${ico.shape}</button>
      ${btn('add-arrow', ico.arrow, 'Šipka')}
      <span class="rb-label">Vložit</span>
    </div>
    <div class="rb-group">
      <select data-cmd="font" title="Písmo"><option value="inter">Inter</option><option value="display">Rajdhani</option></select>
      <select data-cmd="size" title="Velikost písma">${SIZES.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
      ${btn('grow', '<b>A</b><sup>+</sup>', 'Zvětšit písmo (Ctrl+])')}${btn('shrink', '<b>A</b><sup>−</sup>', 'Zmenšit písmo (Ctrl+[)')}
      <span class="rb-break"></span>
      ${btn('bold', '<b>B</b>', 'Tučné (Ctrl+B)')}${btn('italic', '<i>I</i>', 'Kurzíva (Ctrl+I)')}${btn('underline', '<u>U</u>', 'Podtržení (Ctrl+U)')}
      <button type="button" class="tb" data-menu="color" title="Barva písma"><b class="fc">A</b><span class="fc-bar" id="fc-bar"></span></button>
      <span class="rb-label">Písmo</span>
    </div>
    <div class="rb-group">
      ${btn('ul', ico.ul, 'Odrážky')}${btn('ol', ico.ol, 'Číslování')}${btn('outdent', ico.outdent, 'Zmenšit odsazení')}${btn('indent', ico.indent, 'Zvětšit odsazení')}
      <span class="rb-break"></span>
      ${btn('align-l', ico.left, 'Zarovnat doleva')}${btn('align-c', ico.center, 'Na střed')}${btn('align-r', ico.right, 'Doprava')}
      ${btn('valign-t', ico.top, 'Nahoru')}${btn('valign-m', ico.middle, 'Doprostřed')}${btn('valign-b', ico.bottom, 'Dolů')}
      <span class="rb-label">Odstavec</span>
    </div>
    <div class="rb-group">
      <button type="button" class="tb" data-menu="fill" title="Výplň tvaru">${ico.fill}</button>
      <button type="button" class="tb" data-menu="stroke" title="Obrys / barva čáry">${ico.stroke}</button>
      <button type="button" class="tb" data-menu="line" title="Čára a šipka">─</button>
      <span class="rb-break"></span>
      ${btn('front', ico.front, 'Přenést do popředí')}${btn('back', ico.back, 'Přenést do pozadí')}
      ${btn('dup', ico.copy, 'Duplikovat (Ctrl+D)')}${btn('del', ico.trash, 'Odstranit (Delete)')}
      <span class="rb-label">Kreslení</span>
    </div>
    <div class="rb-group">
      <select data-cmd="theme" title="Motiv prezentace">${Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')}</select>
      <button type="button" class="tb tb-wide" data-menu="bg" title="Pozadí tohoto snímku"><span>Pozadí</span>${ico.caret}</button>
      <span class="rb-label">Návrh</span>
    </div>
  </div>
  <div class="de-main">
    <aside class="de-thumbs" id="de-thumbs" tabindex="0"></aside>
    <div class="de-work">
      <div class="de-canvas-wrap" id="de-canvas-wrap"><div class="de-canvas" id="de-canvas"></div></div>
      <textarea class="de-notes" id="de-notes" placeholder="Klikněte sem a přidejte poznámky ke snímku (vidíš je jen ty)" maxlength="5000"></textarea>
    </div>
  </div>
  <div class="de-statusbar"><span id="de-pos"></span><span class="muted" id="de-hint">Dvojklik na text = psaní · Shift = zachovat poměr · Delete = smazat prvek</span></div>
  <div class="de-menu" id="de-menu" hidden></div>
  <input type="file" id="de-file" accept="image/*" hidden>
  <div class="menus-src" hidden>
    <template id="m-color">${swatches('color')}</template>
    <template id="m-fill">${swatches('fill')}</template>
    <template id="m-stroke">${swatches('stroke')}</template>
    <template id="m-bg">${swatches('bg')}</template>
    <template id="m-shapes">${SHAPES.map(([k, l]) => `<button type="button" class="mi" data-cmd="shape" data-val="${k}">${l}</button>`).join('')}</template>
    <template id="m-line">
      <div class="mi-row"><span>Tloušťka</span>${[4, 8, 12, 18].map((w) => `<button type="button" class="tb" data-cmd="lw" data-val="${w}" title="${w}"><span style="display:block;width:18px;height:${Math.max(1, w / 3)}px;background:currentColor;border-radius:2px"></span></button>`).join('')}</div>
      <button type="button" class="mi" data-cmd="lhead" data-val="end">→ Šipka na konci</button>
      <button type="button" class="mi" data-cmd="lhead" data-val="both">↔ Šipky na obou koncích</button>
      <button type="button" class="mi" data-cmd="lhead" data-val="none">— Bez šipky</button>
      <button type="button" class="mi" data-cmd="ldash">┅ Plná / čárkovaná</button>
    </template>
  </div>`;
}

let dlg = null;
let ed = null; // the open editor state

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'deck-ed';
  dlg.innerHTML = editorMarkup();
  document.body.appendChild(dlg);
  wire();
  return dlg;
}
const $ = (sel) => dlg.querySelector(sel);

/**
 * Opens the editor for a deck: { id, title, theme, folder_id, player_id, slides }.
 * opts: { folderOptions(select, playerId), onSaved(deck), onClose(), onDeleted() }
 */
export function openDeckEditor(deck, opts = {}) {
  ensureDialog();
  ed = {
    opts,
    deck: { ...deck, theme: deck.theme || 'sc', slides: (deck.slides?.length ? deck.slides : [newSlide('title')]).map((s) => clone(normalizeSlide(s))) },
    cur: 0, sel: [], editing: null, undo: [], redo: [], saveTimer: null, saving: Promise.resolve(), clip: null, savedRange: null, thumbTimer: null,
  };
  $('#de-title').value = ed.deck.title;
  opts.folderOptions?.($('#de-folder'), ed.deck.player_id ?? null);
  $('#de-folder').value = ed.deck.folder_id ?? '';
  $('[data-cmd=theme]').value = ed.deck.theme;
  status('');
  renderThumbs();
  renderCanvas();
  dlg.showModal();
  fitCanvas();
  $('#de-canvas-wrap').focus({ preventScroll: true });
}

// --- state helpers ---
const slide = () => ed.deck.slides[ed.cur];
const elById = (id) => slide().elements.find((e) => e.id === id);
const selected = () => ed.sel.map(elById).filter(Boolean);
function status(t, err) { const s = $('#de-status'); s.textContent = t; s.classList.toggle('err', !!err); }
function snap() {
  ed.undo.push(JSON.stringify({ slides: ed.deck.slides, cur: ed.cur, theme: ed.deck.theme }));
  if (ed.undo.length > 120) ed.undo.shift();
  ed.redo = [];
}
function restore(from, to) {
  const s = from.pop();
  if (!s) return;
  to.push(JSON.stringify({ slides: ed.deck.slides, cur: ed.cur, theme: ed.deck.theme }));
  const o = JSON.parse(s);
  stopEditing(false);
  ed.deck.slides = o.slides; ed.deck.theme = o.theme; ed.cur = Math.min(o.cur, o.slides.length - 1); ed.sel = [];
  $('[data-cmd=theme]').value = ed.deck.theme;
  renderThumbs(); renderCanvas(); changed();
}
function changed({ thumbs = 'cur' } = {}) {
  status('Neuloženo');
  clearTimeout(ed.saveTimer);
  ed.saveTimer = setTimeout(save, 800);
  clearTimeout(ed.thumbTimer);
  ed.thumbTimer = setTimeout(() => (thumbs === 'all' ? renderThumbs() : renderThumb(ed.cur)), 120);
}
function save() {
  clearTimeout(ed.saveTimer);
  ed.saveTimer = null;
  if (ed.editing) syncEditing();
  const d = ed.deck;
  const body = { title: d.title.trim() || 'Bez názvu', folder_id: d.folder_id ?? null, player_id: d.player_id ?? null, theme: d.theme, slides: clone(d.slides) };
  for (const s of body.slides) for (const e of s.elements) if (e.type === 'text') e.html = isEmptyHtml(e.html) ? '' : sanitize(e.html);
  const opts = ed.opts;
  ed.saving = ed.saving.then(async () => {
    status('Ukládám…');
    try {
      await api(`/api/coaching/decks/${d.id}`, { method: 'PUT', body });
      status('✓ Uloženo');
      opts.onSaved?.({ ...d, title: body.title, slides: body.slides });
    } catch (err) {
      status(err.message, true);
    }
  });
  return ed.saving;
}

// --- thumbnails ---
function renderThumbs() {
  const box = $('#de-thumbs');
  box.innerHTML = ed.deck.slides.map((s, i) => `
    <div class="th ${i === ed.cur ? 'on' : ''}" data-slide="${i}" draggable="true">
      <span class="th-n">${i + 1}</span>
      <div class="th-s">${slideHtml(s, ed.deck.theme)}</div>
    </div>`).join('') + '<button type="button" class="th-add" data-cmd="new-slide" title="Nový snímek">+</button>';
  $('#de-pos').textContent = `Snímek ${ed.cur + 1} z ${ed.deck.slides.length}`;
}
function renderThumb(i) {
  const t = $(`#de-thumbs [data-slide="${i}"] .th-s`);
  if (t) t.innerHTML = slideHtml(ed.deck.slides[i], ed.deck.theme);
}
function goSlide(i) {
  if (i < 0 || i >= ed.deck.slides.length || i === ed.cur) return;
  stopEditing();
  ed.cur = i; ed.sel = [];
  $('#de-thumbs .th.on')?.classList.remove('on');
  const th = $(`#de-thumbs [data-slide="${i}"]`);
  th?.classList.add('on');
  th?.scrollIntoView({ block: 'nearest' });
  $('#de-pos').textContent = `Snímek ${ed.cur + 1} z ${ed.deck.slides.length}`;
  renderCanvas();
}

// --- canvas ---
function canvasSlide() { return $('#de-canvas .slide'); }
function renderCanvas() {
  const s = slide();
  $('#de-canvas').innerHTML = `<div class="slide ed" style="${slideStyle(s, ed.deck.theme)}"><div class="sl-in">${s.elements.map((e) => elementHtml(e, true)).join('')}</div><div class="guides"></div><div class="sel-layer"></div></div>`;
  $('#de-notes').value = s.notes || '';
  drawSelection();
  updateRibbon();
}
function rerenderEl(e) {
  const old = $(`#de-canvas .sl-in [data-el="${e.id}"]`);
  const tmp = document.createElement('div');
  tmp.innerHTML = elementHtml(e, true);
  const fresh = tmp.firstElementChild;
  if (old && fresh) old.replaceWith(fresh);
  else if (!old && fresh) $('#de-canvas .sl-in').appendChild(fresh);
}
function fitCanvas() {
  const wrap = $('#de-canvas-wrap');
  const r = wrap.getBoundingClientRect();
  const pad = 36;
  const w = Math.max(200, Math.min(r.width - pad * 2, (r.height - pad * 2) * 16 / 9));
  $('#de-canvas').style.width = `${w}px`;
}
const scale = () => canvasSlide().getBoundingClientRect().width / W;
function toUnits(ev) {
  const r = canvasSlide().getBoundingClientRect();
  return { x: (ev.clientX - r.left) / (r.width / W), y: (ev.clientY - r.top) / (r.width / W) };
}

// selection frame with handles
function drawSelection() {
  const layer = $('#de-canvas .sel-layer');
  if (!layer) return;
  $('#de-canvas').querySelectorAll('.sl-in .is-sel').forEach((x) => x.classList.remove('is-sel'));
  layer.innerHTML = selected().map((e) => {
    $(`#de-canvas .sl-in [data-el="${e.id}"]`)?.classList.add('is-sel');
    if (e.type === 'line') {
      return ['1', '2'].map((p) => `<div class="hd hd-pt" data-h="p${p}" data-id="${e.id}" style="left:${u(e[`x${p}`])};top:${u(e[`y${p}`])}"></div>`).join('');
    }
    const single = ed.sel.length === 1;
    const hs = single ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<div class="hd hd-${h}" data-h="${h}" data-id="${e.id}"></div>`).join('') : '';
    return `<div class="sel-box ${ed.editing === e.id ? 'editing' : ''}" style="${boxStyle(e)}">${hs}</div>`;
  }).join('');
}

// --- ribbon state ---
function updateRibbon() {
  const els = selected();
  const t = els.find((e) => e.type === 'text');
  const has = (types) => els.some((e) => types.includes(e.type));
  const r = $('#de-ribbon');
  const textOn = !!t;
  r.querySelectorAll('[data-cmd=font],[data-cmd=size],[data-cmd=grow],[data-cmd=shrink],[data-cmd=bold],[data-cmd=italic],[data-cmd=underline],[data-menu=color],[data-cmd=ul],[data-cmd=ol],[data-cmd=indent],[data-cmd=outdent],[data-cmd^=align-],[data-cmd^=valign-]')
    .forEach((b) => { b.disabled = !textOn; });
  r.querySelector('[data-menu=fill]').disabled = !textOn;
  r.querySelector('[data-menu=stroke]').disabled = !has(['text', 'line']);
  r.querySelector('[data-menu=line]').disabled = !has(['line']);
  ['front', 'back', 'dup', 'del'].forEach((c) => { r.querySelector(`[data-cmd=${c}]`).disabled = !els.length; });
  $('[data-cmd=undo]').disabled = !ed.undo.length;
  $('[data-cmd=redo]').disabled = !ed.redo.length;
  if (t) {
    r.querySelector('[data-cmd=font]').value = t.font;
    const sz = r.querySelector('[data-cmd=size]');
    if (![...sz.options].some((o) => Number(o.value) === t.size)) sz.insertAdjacentHTML('beforeend', `<option value="${t.size}">${t.size}</option>`);
    sz.value = String(t.size);
    ['l', 'c', 'r'].forEach((a) => r.querySelector(`[data-cmd=align-${a}]`).classList.toggle('on', t.align === a));
    ['t', 'm', 'b'].forEach((a) => r.querySelector(`[data-cmd=valign-${a}]`).classList.toggle('on', t.valign === a));
    $('#fc-bar').style.background = t.color || 'var(--sl-ink, #e8ecf4)';
  }
  updateInlineState();
}
function updateInlineState() {
  const r = $('#de-ribbon');
  const on = !!ed.editing;
  for (const [cmd, q] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['ul', 'insertUnorderedList'], ['ol', 'insertOrderedList']]) {
    let v = false;
    try { v = on && document.queryCommandState(q); } catch {}
    r.querySelector(`[data-cmd=${cmd}]`).classList.toggle('on', v);
  }
}

// --- text editing ---
function contentOf(id) { return $(`#de-canvas .sl-in [data-el="${id}"] .el-c`); }
function startEditing(id, ev) {
  const e = elById(id);
  if (!e || e.type !== 'text') return;
  if (ed.editing === id) return;
  stopEditing();
  snap();
  ed.editing = id;
  ed.savedRange = null;
  ed.sel = [id];
  const box = $(`#de-canvas .sl-in [data-el="${id}"]`);
  box.classList.add('editing');
  const c = box.querySelector('.el-c');
  // An empty content box starts as a bullet list, like a PowerPoint content placeholder.
  if (isEmptyHtml(e.html) && e.role === 'body') c.innerHTML = '<ul><li><br></li></ul>';
  c.contentEditable = 'true';
  c.spellcheck = false;
  c.focus();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('defaultParagraphSeparator', false, 'div');
  const sel = getSelection();
  let range = null;
  if (ev && document.caretRangeFromPoint) range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  else if (ev && document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(ev.clientX, ev.clientY); if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); } }
  if (!range || !c.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(c); range.collapse(false); }
  sel.removeAllRanges(); sel.addRange(range);
  box.classList.remove('empty');
  drawSelection(); updateRibbon();
}
function syncEditing() {
  const e = elById(ed.editing);
  const c = ed.editing && contentOf(ed.editing);
  if (e && c) e.html = c.innerHTML;
}
function stopEditing(keepSel = true) {
  if (!ed?.editing) return;
  const id = ed.editing;
  syncEditing();
  ed.editing = null;
  ed.savedRange = null;
  const e = elById(id);
  if (e) { e.html = isEmptyHtml(e.html) ? '' : sanitize(e.html); rerenderEl(e); }
  if (!keepSel) ed.sel = [];
  getSelection()?.removeAllRanges();
  drawSelection(); updateRibbon();
  changed();
}
function saveRange() {
  const s = getSelection();
  if (ed.editing && s.rangeCount && contentOf(ed.editing)?.contains(s.anchorNode)) ed.savedRange = s.getRangeAt(0).cloneRange();
}
function restoreRange() {
  const c = ed.editing && contentOf(ed.editing);
  if (!c) return;
  // Still typing in the box: the live selection is the right one.
  const live = getSelection();
  if (document.activeElement === c && live.rangeCount && c.contains(live.anchorNode)) return;
  if (!ed.savedRange || !c.contains(ed.savedRange.startContainer)) { c.focus(); return; }
  c.focus();
  const s = getSelection(); s.removeAllRanges(); s.addRange(ed.savedRange);
}
/** Runs a text command on the selection while typing, or on all text of the selected boxes. */
function textCommand(cmd, val = null) {
  if (ed.editing) {
    restoreRange();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, val);
    syncEditing(); saveRange(); updateInlineState(); changed();
    return;
  }
  const texts = selected().filter((e) => e.type === 'text');
  if (!texts.length) return;
  snap();
  for (const e of texts) {
    const c = contentOf(e.id);
    if (!c) continue;
    if (isEmptyHtml(e.html) && (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList')) c.innerHTML = '<div><br></div>';
    c.contentEditable = 'true';
    c.focus();
    const r = document.createRange(); r.selectNodeContents(c);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, val);
    c.contentEditable = 'false';
    e.html = sanitize(c.innerHTML);
    rerenderEl(e);
  }
  getSelection().removeAllRanges();
  drawSelection(); changed();
}
function setProp(prop, val, types = ['text']) {
  const els = selected().filter((e) => types.includes(e.type));
  if (!els.length) return;
  snap();
  for (const e of els) { e[prop] = val; if (ed.editing !== e.id) rerenderEl(e); else applyLiveStyle(e); }
  drawSelection(); updateRibbon(); changed();
}
function applyLiveStyle(e) {
  // While typing, change the box in place so the caret stays.
  const box = $(`#de-canvas .sl-in [data-el="${e.id}"]`);
  const tmp = document.createElement('div');
  tmp.innerHTML = elementHtml({ ...e, html: 'x' }, true);
  const f = tmp.firstElementChild;
  box.className = f.className + ' editing is-sel';
  box.setAttribute('style', f.getAttribute('style'));
}

// --- adding things ---
function addElement(e) {
  stopEditing();
  snap();
  slide().elements.push(e);
  rerenderEl(e);
  ed.sel = [e.id];
  drawSelection(); updateRibbon(); changed();
  return e;
}
function addText(shape = 'none') {
  const isShape = shape !== 'none';
  const t = ed.deck.theme;
  const e = addElement(T({
    x: isShape ? 600 : 500, y: isShape ? 300 : 380, w: isShape ? 400 : 600, h: isShape ? 300 : 120, size: isShape ? 32 : 32,
    shape, fill: isShape ? (THEMES[t]?.accent || '#e8b84a') : null, color: isShape ? (t === 'light' ? '#ffffff' : '#0a0f1c') : null,
    align: isShape ? 'c' : 'l', valign: isShape ? 'm' : 't',
  }));
  if (!isShape) startEditing(e.id);
}
function addLine(head) {
  addElement({ id: uid(), type: 'line', x1: 560, y1: 560, x2: 1040, y2: 340, color: THEMES[ed.deck.theme]?.accent || '#e8b84a', width: 10, head, dash: false });
}
async function addImageFile(file, target) {
  if (!file || !file.type.startsWith('image/')) return;
  status('Nahrávám obrázek…');
  try {
    const img = await shrinkImage(file, { maxSide: 2560 });
    const { id } = await api(`/api/coaching/decks/${ed.deck.id}/images`, { method: 'POST', body: { mime: img.blob.type, data: await blobToBase64(img.blob) } });
    const ph = target || selected().find((e) => e.type === 'image' && !e.image_id) || slide().elements.find((e) => e.type === 'image' && !e.image_id);
    if (ph) {
      snap();
      ph.image_id = id;
      rerenderEl(ph);
      ed.sel = [ph.id];
      drawSelection(); updateRibbon(); changed();
    } else {
      const k = Math.min(1100 / img.width, 660 / img.height, 1.5);
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      addElement({ id: uid(), type: 'image', x: Math.round((W - w) / 2), y: Math.round((H - h) / 2 + 30), w, h, image_id: id, fit: 'contain' });
    }
    status('✓ Obrázek vložen');
  } catch (err) {
    status(err.message, true);
  }
}

// --- slides ---
function insertSlide(s, at = ed.cur + 1) {
  stopEditing();
  snap();
  ed.deck.slides.splice(at, 0, s);
  ed.cur = at; ed.sel = [];
  renderThumbs(); renderCanvas(); changed({ thumbs: 'all' });
  $(`#de-thumbs [data-slide="${at}"]`)?.scrollIntoView({ block: 'nearest' });
}
function deleteSlide(i = ed.cur) {
  if (ed.deck.slides.length < 2) return;
  stopEditing();
  snap();
  ed.deck.slides.splice(i, 1);
  ed.cur = Math.min(ed.cur, ed.deck.slides.length - 1); ed.sel = [];
  renderThumbs(); renderCanvas(); changed({ thumbs: 'all' });
}
function changeLayout(key) {
  // Keeps what is written: text moves into the new layout's boxes by role, pictures into picture boxes.
  // Empty placeholders of the old layout go away; everything else (own text boxes, shapes, arrows) stays.
  stopEditing();
  snap();
  const old = slide().elements;
  const isPh = (e) => (e.type === 'text' && e.role !== 'none') || (e.type === 'image' && !e.image_id);
  const fresh = LAYOUTS[key].make();
  const used = new Set();
  const take = (pred) => { const e = old.find((x) => !used.has(x.id) && pred(x)); if (e) used.add(e.id); return e; };
  for (const n of fresh) {
    if (n.type === 'text') {
      const src = take((x) => x.type === 'text' && x.role === n.role && !isEmptyHtml(x.html))
        ?? (n.role === 'body' ? take((x) => x.type === 'text' && x.role === 'sub' && !isEmptyHtml(x.html)) : null)
        ?? (n.role === 'sub' ? take((x) => x.type === 'text' && x.role === 'body' && !isEmptyHtml(x.html)) : null);
      if (src) n.html = src.html;
    } else if (n.type === 'image') {
      const src = take((x) => x.type === 'image' && x.image_id);
      if (src) { n.image_id = src.image_id; n.fit = src.fit; }
    }
  }
  const rest = old.filter((e) => !used.has(e.id) && !(isPh(e) && (e.type === 'image' || isEmptyHtml(e.html))));
  slide().elements = [...fresh, ...rest];
  ed.sel = [];
  renderCanvas(); changed();
}
function layoutPreview(key) {
  const box = (e) => `left:${e.x / 16}%;top:${e.y / 9}%;width:${e.w / 16}%;height:${e.h / 9}%`;
  return `<div class="lp">${LAYOUTS[key].make().map((e) => (e.type === 'image'
    ? `<i class="lp-img" style="${box(e)}"></i>`
    : `<i class="lp-${e.role}" style="${box(e)}"></i>`)).join('')}</div>`;
}

// --- menus ---
function openMenu(kind, anchor) {
  const m = $('#de-menu');
  if (!m.hidden && m.dataset.kind === kind) { closeMenu(); return; }
  if (kind === 'layouts' || kind === 'layout-cur') {
    m.innerHTML = `<div class="lay-grid">${Object.entries(LAYOUTS).map(([k, l]) => `
      <button type="button" class="lay" data-cmd="${kind === 'layouts' ? 'new-slide' : 'set-layout'}" data-val="${k}">${layoutPreview(k)}<span>${l.name}</span></button>`).join('')}</div>`;
  } else {
    m.innerHTML = $(`#m-${kind}`).innerHTML;
  }
  m.dataset.kind = kind;
  m.hidden = false;
  const r = anchor.getBoundingClientRect(), dr = dlg.getBoundingClientRect();
  m.style.left = `${Math.min(r.left - dr.left, dr.width - m.offsetWidth - 8)}px`;
  m.style.top = `${r.bottom - dr.top + 4}px`;
}
function closeMenu() { const m = $('#de-menu'); m.hidden = true; m.dataset.kind = ''; }

// --- commands ---
function run(cmd, val, el) {
  switch (cmd) {
    case 'undo': return restore(ed.undo, ed.redo);
    case 'redo': return restore(ed.redo, ed.undo);
    case 'close': return close();
    case 'delete-deck': return deleteDeck();
    case 'play-start': return play(0);
    case 'play-here': return play(ed.cur);
    case 'new-slide': closeMenu(); return insertSlide(newSlide(val || 'content'));
    case 'set-layout': closeMenu(); return changeLayout(val);
    case 'add-text': return addText();
    case 'add-image': ed.imageTarget = null; return $('#de-file').click();
    case 'add-arrow': return addLine('end');
    case 'shape': closeMenu(); if (val === 'text') return addText(); if (val === 'arrow') return addLine('end'); if (val === 'line') return addLine('none'); return addText(val);
    case 'font': return setProp('font', val);
    case 'size': return setProp('size', Number(val));
    case 'grow': case 'shrink': {
      const t = selected().find((e) => e.type === 'text');
      if (!t) return;
      const i = SIZES.findIndex((s) => s >= t.size);
      const next = cmd === 'grow' ? SIZES[Math.min(SIZES.length - 1, SIZES[i] === t.size ? i + 1 : i)] : SIZES[Math.max(0, i - 1)];
      return setProp('size', next ?? t.size);
    }
    case 'bold': return textCommand('bold');
    case 'italic': return textCommand('italic');
    case 'underline': return textCommand('underline');
    case 'ul': return textCommand('insertUnorderedList');
    case 'ol': return textCommand('insertOrderedList');
    case 'indent': return textCommand('indent');
    case 'outdent': return textCommand('outdent');
    case 'align-l': case 'align-c': case 'align-r': return setProp('align', cmd.slice(-1));
    case 'valign-t': case 'valign-m': case 'valign-b': return setProp('valign', cmd.slice(-1));
    case 'color':
      closeMenu();
      // Typing with text selected: colour the selection; otherwise the whole box.
      if (ed.editing && ed.savedRange && !ed.savedRange.collapsed) return textCommand('foreColor', val || THEMES[ed.deck.theme].fg);
      return setProp('color', val || null);
    case 'fill': closeMenu(); { const t = selected().filter((e) => e.type === 'text'); if (t.length && val && t.every((e) => e.shape === 'none')) setProp('shape', 'rect'); } return setProp('fill', val || null);
    case 'stroke': closeMenu(); { const els = selected(); if (els.some((e) => e.type === 'line')) setProp('color', val || THEMES[ed.deck.theme].accent, ['line']); if (els.some((e) => e.type === 'text')) setProp('stroke', val || null); } return;
    case 'lw': closeMenu(); return setProp('width', Number(val), ['line']);
    case 'lhead': closeMenu(); return setProp('head', val, ['line']);
    case 'ldash': closeMenu(); { const l = selected().find((e) => e.type === 'line'); if (l) setProp('dash', !l.dash, ['line']); } return;
    case 'bg': closeMenu(); snap(); slide().bg = val || null; renderCanvas(); return changed();
    case 'theme': snap(); ed.deck.theme = val; renderThumbs(); renderCanvas(); return changed({ thumbs: 'all' });
    case 'front': case 'back': {
      if (!ed.sel.length) return;
      snap();
      const els = slide().elements, picked = els.filter((e) => ed.sel.includes(e.id)), rest = els.filter((e) => !ed.sel.includes(e.id));
      slide().elements = cmd === 'front' ? [...rest, ...picked] : [...picked, ...rest];
      renderCanvas(); return changed();
    }
    case 'dup': return duplicate();
    case 'del': return deleteSelected();
    case 'dup-slide': return insertSlide(clone(ed.deck.slides[Number(val)]), Number(val) + 1);
    case 'del-slide': return deleteSlide(Number(val));
  }
}
function duplicate() {
  const els = selected();
  if (!els.length) return;
  stopEditing();
  snap();
  const copies = els.map((e) => (e.type === 'line'
    ? { ...clone(e), id: uid(), x1: e.x1 + 30, y1: e.y1 + 30, x2: e.x2 + 30, y2: e.y2 + 30 }
    : { ...clone(e), id: uid(), x: e.x + 30, y: e.y + 30 }));
  slide().elements.push(...copies);
  ed.sel = copies.map((e) => e.id);
  renderCanvas(); changed();
}
function deleteSelected() {
  if (!ed.sel.length) return;
  stopEditing();
  snap();
  slide().elements = slide().elements.filter((e) => !ed.sel.includes(e.id));
  ed.sel = [];
  renderCanvas(); changed();
}
async function close() {
  closeMenu();
  stopEditing();
  if (ed.saveTimer) save();
  await ed.saving;
  dlg.close();
}
async function deleteDeck() {
  if (!confirm(`Smazat celou prezentaci „${ed.deck.title}“?`)) return;
  clearTimeout(ed.saveTimer); ed.saveTimer = null;
  await ed.saving;
  await api(`/api/coaching/decks/${ed.deck.id}`, { method: 'DELETE' });
  ed.deleted = true;
  dlg.close();
  ed.opts.onDeleted?.();
}
function play(start) {
  stopEditing();
  if (ed.saveTimer) save();
  present(ed.deck.slides, ed.deck.theme, start, { host: dlg, onEnd: (i) => { goSlide(i); } });
}

// --- pointer: select, move, resize, edit ----------------------------------------------------
let drag = null;
const SNAP = 10;
function showGuides(gx, gy) {
  const g = $('#de-canvas .guides');
  g.innerHTML = gx.map((x) => `<i class="gv" style="left:${u(x)}"></i>`).join('') + gy.map((y) => `<i class="gh" style="top:${u(y)}"></i>`).join('');
}
function onPointerDown(ev) {
  if (ev.button !== 0) return;
  closeMenu();
  const canvas = canvasSlide();
  if (!canvas || !canvas.contains(ev.target)) return;
  const handle = ev.target.closest('[data-h]');
  const p = toUnits(ev);
  if (handle) {
    const e = elById(handle.dataset.id);
    ev.preventDefault();
    snap();
    drag = { kind: 'resize', h: handle.dataset.h, e, start: p, orig: clone(e), moved: false };
    canvas.setPointerCapture(ev.pointerId);
    return;
  }
  const node = ev.target.closest('.sl-in [data-el]');
  if (!node) {
    // Empty place on the slide.
    stopEditing(false);
    ed.sel = [];
    drawSelection(); updateRibbon();
    return;
  }
  const id = node.dataset.el;
  if (ed.editing === id) return; // normal text selection while typing
  ev.preventDefault();
  if (ed.editing) stopEditing();
  const wasSelected = ed.sel.includes(id);
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
    ed.sel = wasSelected ? ed.sel.filter((x) => x !== id) : [...ed.sel, id];
  } else if (!wasSelected) {
    ed.sel = [id];
  }
  drawSelection(); updateRibbon();
  $('#de-canvas-wrap').focus({ preventScroll: true });
  const els = selected();
  drag = { kind: 'move', id, start: p, orig: els.map(clone), moved: false, wasSelected, ev };
  canvas.setPointerCapture(ev.pointerId);
}
function onPointerMove(ev) {
  if (!drag) return;
  const p = toUnits(ev);
  let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) * scale() < 3) return;
  if (!drag.moved) { drag.moved = true; if (drag.kind === 'move') snap(); }
  if (drag.kind === 'move') {
    // Snap the moved group to the slide's edges and centre.
    const boxes = drag.orig.filter((e) => e.type !== 'line');
    const gx = [], gy = [];
    if (boxes.length && !ev.altKey) {
      const L = Math.min(...boxes.map((e) => e.x)) + dx, R = Math.max(...boxes.map((e) => e.x + e.w)) + dx;
      const Tt = Math.min(...boxes.map((e) => e.y)) + dy, B = Math.max(...boxes.map((e) => e.y + e.h)) + dy;
      const others = slide().elements.filter((e) => e.type !== 'line' && !ed.sel.includes(e.id));
      const xs = [0, W / 2, W, ...others.flatMap((e) => [e.x, e.x + e.w / 2, e.x + e.w])];
      const ys = [0, H / 2, H, ...others.flatMap((e) => [e.y, e.y + e.h / 2, e.y + e.h])];
      const fit = (vals, cands) => { let best = null; for (const v of vals) for (const c of cands) { const d = c - v; if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, c }; } return best; };
      const sx = fit([L, (L + R) / 2, R], xs), sy = fit([Tt, (Tt + B) / 2, B], ys);
      if (sx) { dx += sx.d; gx.push(sx.c); }
      if (sy) { dy += sy.d; gy.push(sy.c); }
    }
    showGuides(gx, gy);
    for (const o of drag.orig) {
      const e = elById(o.id);
      if (!e) continue;
      if (e.type === 'line') { e.x1 = Math.round(o.x1 + dx); e.y1 = Math.round(o.y1 + dy); e.x2 = Math.round(o.x2 + dx); e.y2 = Math.round(o.y2 + dy); rerenderEl(e); }
      else {
        e.x = Math.round(o.x + dx); e.y = Math.round(o.y + dy);
        const n = $(`#de-canvas .sl-in [data-el="${e.id}"]`);
        if (n) { n.style.left = u(e.x); n.style.top = u(e.y); }
      }
    }
    drawSelection();
    return;
  }
  // resize
  const { e, orig: o, h } = drag;
  if (h === 'p1' || h === 'p2') {
    let x = p.x, y = p.y;
    if (ev.shiftKey) { // 45° steps
      const ox = h === 'p1' ? o.x2 : o.x1, oy = h === 'p1' ? o.y2 : o.y1;
      const a = Math.round(Math.atan2(y - oy, x - ox) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(x - ox, y - oy);
      x = ox + Math.cos(a) * len; y = oy + Math.sin(a) * len;
    }
    e[`x${h[1]}`] = Math.round(x); e[`y${h[1]}`] = Math.round(y);
    rerenderEl(e); drawSelection();
    return;
  }
  let x = o.x, y = o.y, w = o.w, hh = o.h;
  if (h.includes('e')) w = o.w + dx;
  if (h.includes('s')) hh = o.h + dy;
  if (h.includes('w')) { w = o.w - dx; x = o.x + dx; }
  if (h.includes('n')) { hh = o.h - dy; y = o.y + dy; }
  const keepRatio = (e.type === 'image' && !ev.shiftKey && h.length === 2) || (e.type !== 'image' && ev.shiftKey && h.length === 2);
  if (keepRatio) {
    const r = o.w / o.h;
    if (w / hh > r) w = hh * r; else hh = w / r;
    if (h.includes('w')) x = o.x + o.w - w;
    if (h.includes('n')) y = o.y + o.h - hh;
  }
  if (w < 20) { if (h.includes('w')) x -= 20 - w; w = 20; }
  if (hh < 20) { if (h.includes('n')) y -= 20 - hh; hh = 20; }
  Object.assign(e, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) });
  const n = $(`#de-canvas .sl-in [data-el="${e.id}"]`);
  if (n) Object.assign(n.style, { left: u(e.x), top: u(e.y), width: u(e.w), height: u(e.h) });
  drawSelection();
}
function onPointerUp(ev) {
  if (!drag) return;
  const d = drag;
  drag = null;
  showGuides([], []);
  if (d.moved) { changed(); return; }
  if (d.kind === 'resize') { ed.undo.pop(); return; } // nothing changed
  // A click without moving: clicking a selected text box again starts typing there (like PowerPoint);
  // clicking an empty picture box opens the file picker.
  const e = elById(d.id);
  if (!e || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  if (e.type === 'text' && (d.wasSelected || e.role !== 'none' && isEmptyHtml(e.html))) startEditing(e.id, ev);
  else if (e.type === 'image' && !e.image_id) { ed.imageTarget = e; $('#de-file').click(); }
}

// --- keyboard ---
function onKey(ev) {
  if (!dlg.open || (presenter && !presenter.hidden)) return;
  const k = ev.key, mod = ev.ctrlKey || ev.metaKey;
  const inField = ev.target.matches('input, textarea, select') && !ev.target.closest('.de-canvas');
  if (k === 'F5') { ev.preventDefault(); return play(ev.shiftKey ? ed.cur : 0); }
  if (mod && k.toLowerCase() === 'm') { ev.preventDefault(); return insertSlide(newSlide('content')); }
  if (inField) return;
  if (ed.editing) {
    if (k === 'Escape') { ev.preventDefault(); return stopEditing(); }
    if (k === 'Tab') { ev.preventDefault(); return textCommand(ev.shiftKey ? 'outdent' : 'indent'); }
    if (mod && ['b', 'i', 'u'].includes(k.toLowerCase())) { ev.preventDefault(); return run({ b: 'bold', i: 'italic', u: 'underline' }[k.toLowerCase()]); }
    if (mod && (k === ']' || k === '[')) { ev.preventDefault(); return run(k === ']' ? 'grow' : 'shrink'); }
    return;
  }
  if (mod && k.toLowerCase() === 'z') { ev.preventDefault(); return run(ev.shiftKey ? 'redo' : 'undo'); }
  if (mod && k.toLowerCase() === 'y') { ev.preventDefault(); return run('redo'); }
  if (k === 'Escape') { if (!$('#de-menu').hidden) { ev.preventDefault(); return closeMenu(); } ev.preventDefault(); ed.sel = []; drawSelection(); updateRibbon(); return; }
  const inThumbs = document.activeElement?.closest?.('#de-thumbs');
  if (inThumbs) {
    if (k === 'ArrowDown' || k === 'ArrowRight') { ev.preventDefault(); return goSlide(ed.cur + 1); }
    if (k === 'ArrowUp' || k === 'ArrowLeft') { ev.preventDefault(); return goSlide(ed.cur - 1); }
    if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); return deleteSlide(); }
    if (mod && k.toLowerCase() === 'd') { ev.preventDefault(); return run('dup-slide', ed.cur); }
    if (k === 'Enter') { ev.preventDefault(); return insertSlide(newSlide('content')); }
    return;
  }
  if (mod && k.toLowerCase() === 'a') { ev.preventDefault(); ed.sel = slide().elements.map((e) => e.id); drawSelection(); updateRibbon(); return; }
  if (!ed.sel.length) {
    if (k === 'PageDown') { ev.preventDefault(); return goSlide(ed.cur + 1); }
    if (k === 'PageUp') { ev.preventDefault(); return goSlide(ed.cur - 1); }
    return;
  }
  if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); return deleteSelected(); }
  if (mod && k.toLowerCase() === 'd') { ev.preventDefault(); return duplicate(); }
  if (mod && k.toLowerCase() === 'c') { ed.clip = clone(selected()); return; }
  if (mod && ['b', 'i', 'u'].includes(k.toLowerCase())) { ev.preventDefault(); return run({ b: 'bold', i: 'italic', u: 'underline' }[k.toLowerCase()]); }
  if (mod && (k === ']' || k === '[')) { ev.preventDefault(); return run(k === ']' ? 'grow' : 'shrink'); }
  if (k === 'Enter' || k === 'F2') { const t = selected().find((e) => e.type === 'text'); if (t) { ev.preventDefault(); return startEditing(t.id); } }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[k]) {
    ev.preventDefault();
    if (!ev.repeat) snap();
    const [ax, ay] = arrows[k].map((v) => v * (ev.shiftKey ? 50 : 5));
    for (const e of selected()) {
      if (e.type === 'line') { e.x1 += ax; e.x2 += ax; e.y1 += ay; e.y2 += ay; } else { e.x += ax; e.y += ay; }
      rerenderEl(e);
    }
    drawSelection(); changed();
    return;
  }
  // Typing a letter on a selected text box starts typing in it (replacing nothing – it goes to the end).
  if (k.length === 1 && !mod && !ev.altKey) {
    const t = selected().find((e) => e.type === 'text');
    if (t && ed.sel.length === 1) startEditing(t.id);
  }
}

function onPaste(ev) {
  if (!dlg.open || (presenter && !presenter.hidden)) return;
  if (ev.target.matches?.('input, textarea')) return;
  const file = [...(ev.clipboardData?.items || [])].find((it) => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile();
  if (file) { ev.preventDefault(); stopEditing(); return addImageFile(file); }
  if (ed.editing) {
    // Paste plain text only, so the slide keeps its own look.
    ev.preventDefault();
    const text = ev.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    syncEditing(); changed();
    return;
  }
  if (ed.clip?.length) {
    ev.preventDefault();
    snap();
    const copies = ed.clip.map((e) => (e.type === 'line' ? { ...clone(e), id: uid(), x1: e.x1 + 20, y1: e.y1 + 20, x2: e.x2 + 20, y2: e.y2 + 20 } : { ...clone(e), id: uid(), x: e.x + 20, y: e.y + 20 }));
    slide().elements.push(...copies);
    ed.clip = clone(copies);
    ed.sel = copies.map((e) => e.id);
    renderCanvas(); changed();
  }
}

function wire() {
  dlg.addEventListener('click', (ev) => {
    const menuBtn = ev.target.closest('[data-menu]');
    if (menuBtn && !menuBtn.disabled) { saveRange(); return openMenu(menuBtn.dataset.menu, menuBtn); }
    const b = ev.target.closest('[data-cmd]');
    if (b && !b.disabled && b.tagName !== 'SELECT' && !b.matches('input')) {
      ev.preventDefault();
      if (b.closest('#de-thumbs') && b.dataset.cmd !== 'new-slide') return run(b.dataset.cmd, b.dataset.val, b);
      return run(b.dataset.cmd, b.dataset.val, b);
    }
    if (!ev.target.closest('#de-menu')) closeMenu();
    const th = ev.target.closest('#de-thumbs [data-slide]');
    if (th) { goSlide(Number(th.dataset.slide)); $('#de-thumbs').focus({ preventScroll: true }); }
  });
  // Toolbar buttons must not steal the focus from the text being typed.
  dlg.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('.de-ribbon button, #de-menu button, .de-top .tb')) ev.preventDefault();
  });
  dlg.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('select[data-cmd]')) { run(t.dataset.cmd, t.value); return; }
    if (t.matches('input[data-custom]')) { restoreRange(); run(t.dataset.cmd, t.value); }
    if (t.id === 'de-folder') { ed.deck.folder_id = t.value ? Number(t.value) : null; changed(); }
    if (t.id === 'de-file') { const f = t.files[0]; t.value = ''; addImageFile(f, ed.imageTarget); ed.imageTarget = null; }
  });
  $('#de-title').addEventListener('input', (ev) => { ed.deck.title = ev.target.value; changed(); });
  $('#de-notes').addEventListener('focus', () => snap());
  $('#de-notes').addEventListener('input', (ev) => { slide().notes = ev.target.value || null; changed(); });

  const wrap = $('#de-canvas-wrap');
  wrap.tabIndex = -1;
  wrap.addEventListener('pointerdown', (ev) => {
    if (!canvasSlide()?.contains(ev.target)) { closeMenu(); stopEditing(false); ed.sel = []; drawSelection(); updateRibbon(); return; }
    onPointerDown(ev);
  });
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  wrap.addEventListener('dblclick', (ev) => {
    const n = ev.target.closest('.sl-in [data-el]');
    if (!n) return;
    const e = elById(n.dataset.el);
    if (e?.type === 'text' && ed.editing !== e.id) startEditing(e.id, ev);
    if (e?.type === 'image') { ed.imageTarget = e; $('#de-file').click(); }
  });
  wrap.addEventListener('input', (ev) => {
    if (!ed.editing || !ev.target.closest('.el-c')) return;
    syncEditing(); changed();
  });
  wrap.addEventListener('dragover', (ev) => { if ([...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); });
  wrap.addEventListener('drop', (ev) => {
    const f = [...ev.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    ev.preventDefault();
    const n = ev.target.closest('.sl-in [data-el]');
    const e = n && elById(n.dataset.el);
    addImageFile(f, e?.type === 'image' ? e : null);
  });
  document.addEventListener('selectionchange', () => { if (ed?.editing && dlg.open) { saveRange(); updateInlineState(); } });

  // Slide list: drag to reorder.
  const thumbs = $('#de-thumbs');
  let dragFrom = null;
  thumbs.addEventListener('dragstart', (ev) => { const t = ev.target.closest('[data-slide]'); if (!t) return; dragFrom = Number(t.dataset.slide); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(dragFrom)); t.classList.add('dragging'); });
  thumbs.addEventListener('dragover', (ev) => {
    if (dragFrom === null) return;
    const t = ev.target.closest('[data-slide]');
    if (!t) return;
    ev.preventDefault();
    const after = ev.clientY > t.getBoundingClientRect().top + t.offsetHeight / 2;
    thumbs.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    t.classList.add(after ? 'drop-after' : 'drop-before');
  });
  thumbs.addEventListener('drop', (ev) => {
    const t = ev.target.closest('[data-slide]');
    if (dragFrom === null || !t) return;
    ev.preventDefault();
    let to = Number(t.dataset.slide) + (t.classList.contains('drop-after') ? 1 : 0);
    const from = dragFrom;
    dragFrom = null;
    if (to > from) to--;
    if (to === from) { renderThumbs(); return; }
    stopEditing();
    snap();
    const curSlide = slide();
    const [m] = ed.deck.slides.splice(from, 1);
    ed.deck.slides.splice(to, 0, m);
    ed.cur = ed.deck.slides.indexOf(curSlide);
    renderThumbs(); changed({ thumbs: 'all' });
  });
  thumbs.addEventListener('dragend', () => { dragFrom = null; thumbs.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
  // Right-click a slide: duplicate / delete.
  thumbs.addEventListener('contextmenu', (ev) => {
    const t = ev.target.closest('[data-slide]');
    if (!t) return;
    ev.preventDefault();
    goSlide(Number(t.dataset.slide));
    const m = $('#de-menu');
    const i = Number(t.dataset.slide);
    m.innerHTML = `<button type="button" class="mi" data-cmd="new-slide">Nový snímek</button>
      <button type="button" class="mi" data-cmd="dup-slide" data-val="${i}">Duplikovat snímek</button>
      <button type="button" class="mi" data-cmd="del-slide" data-val="${i}" ${ed.deck.slides.length < 2 ? 'disabled' : ''}>Odstranit snímek</button>`;
    m.dataset.kind = 'ctx';
    m.hidden = false;
    const dr = dlg.getBoundingClientRect();
    m.style.left = `${ev.clientX - dr.left}px`;
    m.style.top = `${ev.clientY - dr.top}px`;
  });

  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);
  window.addEventListener('resize', () => { if (dlg.open) { fitCanvas(); drawSelection(); } });
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); }); // Esc is handled by onKey
  dlg.addEventListener('close', () => {
    closeMenu();
    if (!ed.deleted) ed.opts.onClose?.();
  });
}
