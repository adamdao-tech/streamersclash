// Shared helpers for all logged-in pages.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function initials(name) {
  return esc(String(name || '?').trim().slice(0, 3).toUpperCase());
}

export function logoHtml(team, large = false) {
  const cls = large ? 'logo logo-lg' : 'logo';
  const inner = team.logo_url ? `<img src="${esc(team.logo_url)}" alt="">` : esc(team.tag || initials(team.name));
  return `<div class="${cls}">${inner}</div>`;
}

export const ROLE_LABELS = { TOP: 'TOP', JUNGLE: 'JNG', MID: 'MID', ADC: 'ADC', SUPPORT: 'SUP', SUB: 'SUB' };

/** Renders the top bar and returns the logged-in user. */
export async function initPage(active) {
  const { user } = await api('/api/me');
  const nav = [
    ['/', 'Týmy', 'teams'],
    ['/schedule', 'Harmonogram', 'schedule'],
    ['/coaching', 'Koučing', 'coaching'],
    ['/vods', 'VODky', 'vods'],
    ...(user.role === 'admin' ? [['/users', 'Uživatelé', 'users']] : []),
  ];
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = `
    <a class="brand" href="/">SGooBovo šedl <span>scouting</span></a>
    <nav class="nav">${nav.map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
    <div class="me">
      ${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : ''}
      <span>${esc(user.display_name || user.twitch_login)}</span>
      <a class="btn btn-small" href="/auth/logout">Odhlásit</a>
    </div>`;
  document.body.prepend(header);
  return user;
}

/** Wires a <dialog> form: fills it, collects values, shows errors. */
export function formDialog(dialog, { onSubmit }) {
  const form = dialog.querySelector('form');
  const error = form.querySelector('.form-error');
  form.querySelector('[data-cancel]')?.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const values = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      await onSubmit(values);
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
  return {
    open(values = {}) {
      form.reset();
      error.textContent = '';
      for (const el of form.elements) {
        if (!el.name || !(el.name in values)) continue;
        if (el.type === 'checkbox') el.checked = !!values[el.name];
        else el.value = values[el.name] ?? '';
      }
      dialog.showModal();
    },
  };
}

export function timeAgo(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'teď';
  if (s < 3600) return `před ${Math.floor(s / 60)} min`;
  if (s < 86400) return `před ${Math.floor(s / 3600)} h`;
  return d.toLocaleDateString('cs-CZ');
}

// --- champions & drafts ----------------------------------------------------

let championsPromise = null;
/** Map of champion name → icon URL (Riot Data Dragon). */
export function loadChampions() {
  championsPromise ??= api('/api/champions')
    .then(({ version, champions }) => {
      const map = new Map();
      for (const c of champions) map.set(c.name, `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.id}.png`);
      return map;
    })
    .catch(() => new Map());
  return championsPromise;
}

export function champIcon(icons, name, size = 'md') {
  const src = icons.get(name);
  return `<span class="champ champ-${size}" title="${esc(name)}">${src ? `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy">` : esc(String(name).slice(0, 2))}</span>`;
}

export function vodLink(url, seconds) {
  if (!url) return null;
  if (!seconds) return url;
  const s = Math.max(0, seconds - 60); // start a minute before the draft ended
  const t = `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
  return `${url}${url.includes('?') ? '&' : '?'}t=${t}`;
}

// --- compact draft rows & player helpers ------------------------------------------

export function fmtDuration(s) {
  if (!s && s !== 0) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function kdaText(a) {
  return a.kills === null || a.kills === undefined ? '' : `${a.kills}/${a.deaths}/${a.assists}`;
}

/** Result badge from a given side's point of view ('ALLY' = streamer's team). */
export function resultBadge(result, side = 'ALLY') {
  if (!result) return '<span class="res res-none" title="Výsledek neznámý">–</span>';
  const win = (side === 'ALLY') === (result === 'WIN');
  return win ? '<span class="res res-win">V</span>' : '<span class="res res-loss">P</span>';
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One draft as a single line; click to expand lane-by-lane details. */
export function draftRow(d, icons, ours = new Set()) {
  const picks = (side) => d.actions.filter((a) => a.side === side && a.action === 'PICK');
  const bans = (side) => d.actions.filter((a) => a.side === side && a.action === 'BAN');
  const ally = picks('ALLY'), enemy = picks('ENEMY');
  // From our team's perspective: if one of our players is on the enemy side, flip the result.
  const oursOnEnemy = enemy.some((a) => ours.has(a.player_id)) && !ally.some((a) => ours.has(a.player_id));
  const strip = (list) =>
    list.map((a) => `<span class="${ours.has(a.player_id) ? 'mine' : ''}">${champIcon(icons, a.champion, 'row')}</span>`).join('');
  const link = vodLink(d.vod_url, d.vod_timestamp_s);
  const pgLink = d.postgame_ts ? vodLink(d.vod_url, d.postgame_ts + 60) : null;

  const byLane = ally.every((a) => a.lane !== null && a.lane !== undefined) && enemy.every((a) => a.lane !== null && a.lane !== undefined);
  const line = (a) =>
    a
      ? `<div class="pl">${champIcon(icons, a.champion, 'md')}<div><b>${esc(a.champion)}</b><small>${a.player_id ? `<a href="/player?id=${a.player_id}" title="Přečteno: ${esc(a.player_name || '')}">${esc(a.player_nickname || a.player_name || '')}</a>` : esc(a.player_name || '')}</small></div><span class="kda">${kdaText(a)}</span></div>`
      : '<div></div>';
  const ROLE = { TOP: 'TOP', JUNGLE: 'JNG', MID: 'MID', ADC: 'ADC', SUPPORT: 'SUP' };
  let rows;
  if (byLane) {
    const sorted = (l) => [...l].sort((x, y) => x.lane - y.lane);
    const A = sorted(ally), E = sorted(enemy);
    rows = A.map((a, i) => `<div class="lane"><div class="side-a">${line(a)}</div><span class="lane-role">${ROLE[a.role] || ''}</span><div class="side-e">${line(E[i])}</div></div>`).join('');
  } else {
    rows = Array.from({ length: Math.max(ally.length, enemy.length) }, (_, i) =>
      `<div class="lane"><div class="side-a">${line(ally[i])}</div><span class="lane-role"></span><div class="side-e">${line(enemy[i])}</div></div>`).join('');
  }
  const banList = (l) => l.map((a) => champIcon(icons, a.champion, 'sm')).join('') || '<span class="muted">–</span>';

  return `
    <details class="drow">
      <summary>
        ${resultBadge(d.result, oursOnEnemy ? 'ENEMY' : 'ALLY')}
        <span class="when">${shortDate(d.played_at)}</span>
        <span class="strip ally-strip">${strip(oursOnEnemy ? enemy : ally)}</span>
        <span class="vs">vs</span>
        <span class="strip">${strip(oursOnEnemy ? ally : enemy)}</span>
        <span class="meta">${[d.game_type, fmtDuration(d.duration_s), d.pov_nickname ? `POV ${esc(d.pov_nickname)}` : ''].filter(Boolean).map(esc).join(' · ')}</span>
        ${link ? `<a class="play" href="${esc(link)}" target="_blank" rel="noopener" title="Champ select ve VODce">▶</a>` : ''}
      </summary>
      <div class="drow-detail">
        <div class="lanes">
          <div class="lane head"><div class="side-a">Spoluhráči (POV)</div><span></span><div class="side-e">Soupeři</div></div>
          ${rows}
        </div>
        <div class="drow-foot">
          <span>Bany: ${banList(bans('ALLY'))} <span class="muted">vs</span> ${banList(bans('ENEMY'))}</span>
          <span class="badge">${{ sync: 'Čtečka', claude: 'Claude', user: 'Ručně' }[d.created_by_kind] || esc(d.created_by_kind)}</span>
          ${pgLink ? `<a href="${esc(pgLink)}" target="_blank" rel="noopener">Konec hry ve VODce</a>` : ''}
        </div>
      </div>
    </details>`;
}

// --- schedule (harmonogram) ------------------------------------------------------

const WEEKDAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** Parts of a match start in the viewer's local time. */
export function matchWhen(iso) {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { weekday: WEEKDAYS[d.getDay()], date: `${d.getDate()}. ${d.getMonth() + 1}.`, year: d.getFullYear(), time: hm };
}

/** "za 2 dny 4 h", "za 35 min", "právě se hraje". */
export function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return ms > -3 * 3600_000 ? 'právě se hraje' : 'odehráno';
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d >= 1) return `za ${d} ${d === 1 ? 'den' : d <= 4 ? 'dny' : 'dní'}${h ? ` ${h} h` : ''}`;
  if (h >= 1) return `za ${h} h ${m} min`;
  return `za ${m} min`;
}

/** A match still counts as upcoming until 3 hours after its start. */
export function isUpcoming(m) {
  return new Date(m.starts_at).getTime() + 3 * 3600_000 > Date.now();
}

export const KINDS = {
  match: { label: 'Turnaj', next: 'Další turnajový zápas' },
  scrim: { label: 'Scrim', next: 'Další scrim' },
  other: { label: 'Jiné', next: 'Další akce' },
};

/** Opponent for matches and scrims, the title for other events (training, meeting…). */
export function opponentName(m) {
  if (m.kind === 'other') return m.title || '?';
  return m.team_name || m.opponent_name || '?';
}

/** "vs Soupeř" for matches and scrims, just the title for other events. */
export function eventName(m) {
  return m.kind === 'other' ? esc(opponentName(m)) : `vs ${esc(opponentName(m))}`;
}

export function kindBadge(m) {
  const k = KINDS[m.kind] ? m.kind : 'match';
  return `<span class="kind kind-${k}">${KINDS[k].label}</span>`;
}

export function opponentLogo(m, large = false) {
  if (m.kind === 'other') return `<div class="${large ? 'logo logo-lg' : 'logo'} logo-other" aria-hidden="true">●</div>`;
  return logoHtml({ name: opponentName(m), tag: m.team_tag, logo_url: m.team_logo_url }, large);
}

/** The event to feature: the next tournament match, or the nearest event if no match is planned. */
export function featuredEvent(events) {
  const upcoming = events.filter(isUpcoming);
  return upcoming.find((m) => m.kind === 'match') || upcoming[0] || null;
}

/** Win/loss badge with the score, from our side. */
export function scoreBadge(m) {
  if (m.our_score === null || m.their_score === null) return '';
  const cls = m.our_score > m.their_score ? 'res-win' : m.our_score < m.their_score ? 'res-loss' : 'res-none';
  return `<span class="score ${cls}">${m.our_score}:${m.their_score}</span>`;
}

/** The big "next match" card; compact = smaller version for the home page. */
export function nextMatchHtml(m, { compact = false } = {}) {
  const w = matchWhen(m.starts_at);
  const chips = [m.kind !== 'other' && m.format, m.stage, m.location].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  const k = KINDS[m.kind] ? m.kind : 'match';
  return `
    <div class="next-match${compact ? ' compact' : ''}" style="--accent:${esc(m.team_accent_color || '#c8a64b')}">
      <div class="nm-label">${KINDS[k].next} · <span data-countdown="${esc(m.starts_at)}">${countdown(m.starts_at)}</span></div>
      <div class="nm-main">
        ${opponentLogo(m, !compact)}
        <div class="nm-text">
          <div class="nm-vs">${m.kind === 'other' ? `<b>${esc(opponentName(m))}</b>` : `vs <b>${esc(opponentName(m))}</b>`}</div>
          <div class="nm-when">${w.weekday} ${w.date} ${w.year} · <b>${w.time}</b></div>
          ${chips ? `<div class="chips">${chips}</div>` : ''}
        </div>
        <div class="nm-actions">
          ${m.opponent_team_id ? `<a class="btn btn-primary" href="/team?id=${m.opponent_team_id}">Scouting soupeře</a>` : ''}
          ${m.stream_url ? `<a class="btn" href="${esc(m.stream_url)}" target="_blank" rel="noopener">Stream</a>` : ''}
          ${compact ? '<a class="btn" href="/schedule">Celý harmonogram</a>' : ''}
        </div>
      </div>
    </div>`;
}

/** Keeps every [data-countdown] element on the page ticking. */
export function startCountdowns() {
  const tick = () => document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdown(el.dataset.countdown); });
  tick();
  return setInterval(tick, 30_000);
}

// --- maps (ward maps and the Riftkit board) ----------------------------------------------

export const MARKERS = {
  ward: { label: 'Ward', hint: 'Žlutý (stealth) ward' },
  control: { label: 'Control ward', hint: 'Růžový control ward' },
  farsight: { label: 'Farsight', hint: 'Modrý farsight ward' },
  sweep: { label: 'Sweeper', hint: 'Oblast, kterou projet sweeperem' },
  note: { label: 'Poznámka', hint: 'Očíslovaný bod s popiskem' },
};

const DDRAGON_MAP = (v) => `https://ddragon.leagueoflegends.com/cdn/${v || '15.1.1'}/img/map/map11.png`;

/** The uploaded map picture when there is one, otherwise Riot's small minimap. */
export function mapImageSrc(mapVersion, ddVersion) {
  return mapVersion
    ? { src: `/api/coaching/map-image?v=${encodeURIComponent(mapVersion)}`, alt: DDRAGON_MAP(ddVersion) }
    : { src: DDRAGON_MAP(ddVersion), alt: null };
}

// If the uploaded picture can't be loaded, fall back to Riot's minimap.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.alt) {
    const alt = img.dataset.alt;
    delete img.dataset.alt;
    img.src = alt;
  }
}, true);

/** SVG for all markers; coordinates are 0–100 % of the map in both axes. */
export function markersSvg(markers, selected = -1) {
  let noteNo = 0;
  const out = markers.map((m, i) => {
    const on = i === selected ? ' sel' : '';
    let shape;
    if (m.type === 'sweep') shape = `<circle class="mk-sweep${on}" cx="${m.x}" cy="${m.y}" r="6"/>`;
    else if (m.type === 'note') {
      noteNo++;
      shape = `<circle class="mk-note${on}" cx="${m.x}" cy="${m.y}" r="2.3"/><text class="mk-num" x="${m.x}" y="${m.y}">${noteNo}</text>`;
    } else shape = `<circle class="mk-${m.type}${on}" cx="${m.x}" cy="${m.y}" r="${m.type === 'farsight' ? 1.7 : 1.9}"/>`;
    const label = m.label ? `<text class="mk-label" x="${m.x + 2.8}" y="${m.y + 0.9}">${esc(m.label)}</text>` : '';
    return `<g class="mk" data-i="${i}"><title>${esc(MARKERS[m.type]?.label || m.type)}${m.label ? ` – ${esc(m.label)}` : ''}</title>${shape}${label}</g>`;
  });
  return `<svg class="map-svg" viewBox="0 0 100 100" preserveAspectRatio="none">${out.join('')}</svg>`;
}

export function mapBoxHtml(markers, selected, image) {
  return `<div class="map-box"><img src="${esc(image.src)}"${image.alt ? ` data-alt="${esc(image.alt)}"` : ''} alt="Summoner's Rift" draggable="false">${markersSvg(markers, selected)}</div>`;
}
