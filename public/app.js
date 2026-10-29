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
    ...(user.role === 'admin' ? [['/scouting', 'Queue scouting', 'scouting'], ['/users', 'Uživatelé', 'users']] : []),
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
      if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; continue; }
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
        if (el.type === 'radio') el.checked = String(values[el.name]) === el.value;
        else if (el.type === 'checkbox') el.checked = !!values[el.name];
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
  // Kick: the VOD id the app stores (from Kick's API) doesn't open on kick.com any more → the channel's videos
  const kick = /^https?:\/\/(?:www\.)?kick\.com\/([^/]+)\/videos\//.exec(url);
  if (kick) return `https://kick.com/${kick[1]}/videos`;
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

// --- champion statistics table (team and player pages) ----------------------------

/**
 * Aggregates picks per champion. A pick: { champion, win (true/false/null), kills, deaths, assists, who, played_at }.
 * Returns rows with games, wins, losses, KDA sums, who played it (name → count) and the last time it was played.
 */
export function aggregateChampions(picks) {
  const map = new Map();
  for (const p of picks) {
    const c = map.get(p.champion) || { name: p.champion, g: 0, w: 0, l: 0, k: 0, d: 0, a: 0, kn: 0, who: new Map(), last: null };
    c.g++;
    if (p.win === true) c.w++; else if (p.win === false) c.l++;
    if (p.kills !== null && p.kills !== undefined) { c.kn++; c.k += p.kills; c.d += p.deaths; c.a += p.assists; }
    if (p.who) c.who.set(p.who, (c.who.get(p.who) || 0) + 1);
    if (p.played_at && (!c.last || p.played_at > c.last)) c.last = p.played_at;
    map.set(p.champion, c);
  }
  return [...map.values()].map((c) => ({
    ...c,
    wr: c.w + c.l ? Math.round((c.w / (c.w + c.l)) * 100) : null,
    kda: c.kn ? (c.k + c.a) / Math.max(c.d, 1) : null,
  }));
}

const CHAMP_SORTS = {
  g: (x, y) => y.g - x.g || y.w - x.w,
  wr: (x, y) => (y.wr ?? -1) - (x.wr ?? -1) || y.g - x.g,
  kda: (x, y) => (y.kda ?? -1) - (x.kda ?? -1) || y.g - x.g,
  last: (x, y) => String(y.last || '').localeCompare(String(x.last || '')),
  name: (x, y) => x.name.localeCompare(y.name, 'cs'),
};

/** The champion table; headers with data-sort switch the order (the page keeps the sort key and re-renders). */
export function championTableHtml(rows, icons, { sort = 'g', showWho = false, whoLabel = 'Hráli' } = {}) {
  if (!rows.length) return '<tr><td class="muted">Zatím žádné odehrané hry.</td></tr>';
  const sorted = [...rows].sort(CHAMP_SORTS[sort] || CHAMP_SORTS.g);
  const n = (v, digits = 1) => v.toFixed(digits).replace('.', ',');
  const th = (key, label, cls = '') => `<th class="${cls}"><button class="th-sort${sort === key ? ' on' : ''}" data-sort="${key}">${label}${sort === key ? ' ↓' : ''}</button></th>`;
  const wr = (v) => v === null ? '<span class="muted">–</span>'
    : `<span class="wrbar"><span class="bar"><span style="width:${v}%"></span></span><span class="wrv ${v >= 55 ? 'good' : v < 45 ? 'bad' : ''}">${v} %</span></span>`;
  return `
    <thead><tr>
      ${th('name', 'Champion')}${th('g', 'Hry', 'num')}<th class="num">V–P</th>${th('wr', 'Winrate')}${th('kda', 'KDA', 'num')}
      <th class="num">Ø K / D / A</th>${showWho ? `<th>${whoLabel}</th>` : ''}${th('last', 'Naposledy', 'num')}
    </tr></thead>
    <tbody>${sorted.map((c) => `<tr>
      <td><span class="gchamp">${champIcon(icons, c.name, 'row')}<b>${esc(c.name)}</b></span></td>
      <td class="num">${c.g}</td>
      <td class="num muted">${c.w + c.l ? `${c.w}–${c.l}` : '–'}</td>
      <td>${wr(c.wr)}</td>
      <td class="num strong">${c.kda === null ? '–' : n(c.kda, 2)}</td>
      <td class="num muted">${c.kn ? `${n(c.k / c.kn)} / ${n(c.d / c.kn)} / ${n(c.a / c.kn)}` : '–'}</td>
      ${showWho ? `<td class="muted">${[...c.who.entries()].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${esc(w)}${c.who.size > 1 ? ` (${k})` : ''}`).join(', ')}</td>` : ''}
      <td class="num muted">${c.last ? new Date(c.last).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }) : '–'}</td>
    </tr>`).join('')}</tbody>`;
}

// --- schedule (harmonogram) ------------------------------------------------------

const WEEKDAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** Parts of a match start in the viewer's local time. */
export function matchWhen(iso) {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { weekday: WEEKDAYS[d.getDay()], date: `${d.getDate()}. ${d.getMonth() + 1}.`, year: d.getFullYear(), time: hm };
}

const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

/** Whole calendar days from today to the day of `iso` (0 = today, negative = past). */
function daysUntil(iso) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(iso); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86_400_000);
}

/** "za 2 dny 4 h", "za 35 min", "právě se hraje"; for a free day "dnes", "zítra", "za 3 dny". */
export function countdown(iso, kind) {
  if (kind === 'off') {
    const d = daysUntil(iso);
    if (d < 0) return 'proběhlo';
    if (d === 0) return 'dnes';
    if (d === 1) return 'zítra';
    return `za ${d} ${plural(d, 'den', 'dny', 'dní')}`;
  }
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return ms > -3 * 3600_000 ? 'právě se hraje' : 'odehráno';
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d >= 1) return `za ${d} ${plural(d, 'den', 'dny', 'dní')}${h ? ` ${h} h` : ''}`;
  if (h >= 1) return `za ${h} h ${m} min`;
  return `za ${m} min`;
}

/** A free day lasts the whole day; other events count as upcoming until 3 hours after the start. */
export function isUpcoming(m) {
  return new Date(m.starts_at).getTime() + (m.kind === 'off' ? 24 : 3) * 3600_000 > Date.now();
}

export const KINDS = {
  match: { label: 'Turnaj', next: 'Další turnajový zápas' },
  scrim: { label: 'Scrim', next: 'Další scrim' },
  other: { label: 'Jiné', next: 'Další akce' },
  off: { label: 'Volno', next: 'Volno' },
};

/** Opponent for matches and scrims, the title for other events (training, meeting…) and free days. */
export function opponentName(m) {
  if (m.kind === 'off') return m.title ? `Volno – ${m.title}` : 'Volno';
  if (m.kind === 'other') return m.title || '?';
  return m.team_name || m.opponent_name || '?';
}

/** "vs Soupeř" for matches and scrims, just the title for other events. */
export function eventName(m) {
  return m.kind === 'other' || m.kind === 'off' ? esc(opponentName(m)) : `vs ${esc(opponentName(m))}`;
}

export function kindBadge(m) {
  const k = KINDS[m.kind] ? m.kind : 'match';
  return `<span class="kind kind-${k}">${KINDS[k].label}</span>`;
}

const ICONS = {
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
};
export function icon(name) { return ICONS[name] || ''; }

export function opponentLogo(m, large = false) {
  if (m.kind === 'other' || m.kind === 'off') {
    return `<div class="${large ? 'logo logo-lg' : 'logo'} logo-${m.kind}" aria-hidden="true">${ICONS[m.kind]}</div>`;
  }
  return logoHtml({ name: opponentName(m), tag: m.team_tag, logo_url: m.team_logo_url }, large);
}

/** The event to feature: the next tournament match, or the nearest event if no match is planned (free days never). */
export function featuredEvent(events) {
  const upcoming = events.filter((m) => m.kind !== 'off' && isUpcoming(m));
  return upcoming.find((m) => m.kind === 'match') || upcoming[0] || null;
}

/** Win/loss badge with the score, from our side. */
export function scoreBadge(m) {
  if (m.our_score === null || m.their_score === null) return '';
  const cls = m.our_score > m.their_score ? 'res-win' : m.our_score < m.their_score ? 'res-loss' : 'res-none';
  const word = m.our_score > m.their_score ? 'Výhra' : m.our_score < m.their_score ? 'Prohra' : 'Remíza';
  return `<span class="score ${cls}">${word} ${m.our_score} : ${m.their_score}</span>`;
}

/** Tournament and scrim records from played events with a score: { match: {w, l}, scrim: {w, l} }. */
export function seasonRecord(events) {
  const rec = { match: { w: 0, l: 0 }, scrim: { w: 0, l: 0 } };
  for (const m of events) {
    if (!rec[m.kind] || m.our_score === null || m.their_score === null || m.our_score === m.their_score) continue;
    rec[m.kind][m.our_score > m.their_score ? 'w' : 'l']++;
  }
  return rec;
}

function tiles(iso) {
  return `
    <div class="cd-tiles" data-countdown-tiles="${esc(iso)}">
      <div class="cd-tile"><b data-u="d">00</b><span>dny</span></div>
      <div class="cd-tile"><b data-u="h">00</b><span>hodin</span></div>
      <div class="cd-tile"><b data-u="m">00</b><span>minut</span></div>
    </div>`;
}

/**
 * The big "next match" card (Match Day). Options: own = our team row (crest on the left),
 * record = "3 V – 1 P" under our name, compact = smaller version for the home page, editable = show "Upravit".
 */
export function nextMatchHtml(m, { compact = false, own = null, record = '', editable = false } = {}) {
  const w = matchWhen(m.starts_at);
  const k = KINDS[m.kind] ? m.kind : 'match';
  const isGame = k === 'match' || k === 'scrim';
  const label = [m.stage, `${KINDS[k].next}`].filter(Boolean).map(esc).join(' · ');
  const oppName = esc(opponentName(m));
  const opp = m.opponent_team_id ? `<a href="/team?id=${m.opponent_team_id}">${oppName}</a>` : oppName;
  const side = (logo, name, sub, accent = '') => `
    <div class="hero-team"${accent ? ` style="--accent:${esc(accent)}"` : ''}>${logo}<div><div class="hero-name">${name}</div>${sub ? `<div class="hero-sub">${sub}</div>` : ''}</div></div>`;
  const teams = isGame
    ? `${own ? side(logoHtml(own, !compact), esc(own.name), esc(record), own.accent_color || '#e8b84a') + '<span class="hero-x">VS</span>' : ''}${side(opponentLogo(m, !compact), opp, '')}`
    : side(opponentLogo(m, !compact), oppName, '');
  const meta = [
    `<span>${ICONS.cal}${w.weekday} ${w.date} ${w.year} · <b>${w.time}</b></span>`,
    m.location ? `<span>${ICONS.pin}${esc(m.location)}</span>` : '',
    isGame && m.format ? `<span class="chip">${esc(m.format)}</span>` : '',
  ].join('');
  return `
    <section class="hero${compact ? ' compact' : ''}" style="--accent:${esc(m.team_accent_color || '#e8b84a')}" aria-label="${esc(KINDS[k].next)}">
      <div class="hero-main">
        <div class="hero-label">${kindBadge(m)}<span>${label}</span></div>
        <div class="hero-teams">${teams}</div>
        <div class="hero-meta">${meta}</div>
        <div class="hero-actions">
          ${m.opponent_team_id ? `<a class="btn btn-light" href="/team?id=${m.opponent_team_id}">${ICONS.search}Scouting soupeře</a>` : ''}
          ${m.stream_url ? `<a class="btn" href="${esc(m.stream_url)}" target="_blank" rel="noopener">${ICONS.play}Stream</a>` : ''}
          ${editable ? `<button class="btn btn-ghost" data-edit="${m.id}">Upravit</button>` : ''}
          ${compact ? '<a class="btn btn-ghost" href="/schedule">Celý harmonogram</a>' : ''}
        </div>
      </div>
      <div class="hero-count">
        <span class="hero-count-label">Začátek</span>
        ${tiles(m.starts_at)}
        <span class="hero-count-rel" data-countdown="${esc(m.starts_at)}">${countdown(m.starts_at)}</span>
      </div>
    </section>`;
}

/** Updates every [data-countdown] text and [data-countdown-tiles] block on the page once. */
export function tickCountdowns() {
  const p2 = (n) => String(n).padStart(2, '0');
  document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdown(el.dataset.countdown, el.dataset.kind); });
  document.querySelectorAll('[data-countdown-tiles]').forEach((el) => {
    const min = Math.max(0, Math.floor((new Date(el.dataset.countdownTiles).getTime() - Date.now()) / 60_000));
    el.querySelector('[data-u=d]').textContent = p2(Math.floor(min / 1440));
    el.querySelector('[data-u=h]').textContent = p2(Math.floor((min % 1440) / 60));
    el.querySelector('[data-u=m]').textContent = p2(min % 60);
  });
}

/** Keeps the countdowns ticking. */
export function startCountdowns() {
  tickCountdowns();
  return setInterval(tickCountdowns, 15_000);
}

// --- ward maps ------------------------------------------------------------------------------

export const MARKERS = {
  ward: { label: 'Ward', hint: 'Žlutý (stealth) ward' },
  control: { label: 'Control ward', hint: 'Růžový control ward' },
  farsight: { label: 'Farsight', hint: 'Modrý farsight ward' },
  sweep: { label: 'Sweeper', hint: 'Oblast, kterou projet sweeperem' },
  note: { label: 'Poznámka', hint: 'Očíslovaný bod s popiskem' },
};

const DDRAGON_MAP = (v) => `https://ddragon.leagueoflegends.com/cdn/${v || '15.1.1'}/img/map/map11.png`;

/** Built-in map picture (Summoner's Rift without anything drawn on it). */
const BUILTIN_MAP = '/map-rift.webp';

/** The uploaded map picture when there is one, otherwise the built-in one; Riot's small minimap if those fail. */
export function mapImageSrc(mapVersion, ddVersion) {
  return mapVersion
    ? { src: `/api/coaching/map-image?v=${encodeURIComponent(mapVersion)}`, alt: BUILTIN_MAP }
    : { src: BUILTIN_MAP, alt: DDRAGON_MAP(ddVersion) };
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

// --- image uploads -------------------------------------------------------------------------

/**
 * Shrinks an image file for upload: optionally cropped to a centred square, at most `maxSide`
 * pixels, WebP (JPEG where WebP isn't supported), lowering quality and size until it fits `maxBytes`.
 * Returns { blob, width, height }.
 */
export async function shrinkImage(file, { maxSide = 2560, square = false, maxBytes = 1_800_000 } = {}) {
  const bmp = await createImageBitmap(file);
  const sw = square ? Math.min(bmp.width, bmp.height) : bmp.width;
  const sh = square ? sw : bmp.height;
  const sx = (bmp.width - sw) / 2, sy = (bmp.height - sh) / 2;
  const longest = Math.max(sw, sh);
  for (const limit of [maxSide, Math.round(maxSide * 0.75), Math.round(maxSide * 0.5)]) {
    const scale = Math.min(1, limit / longest);
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    for (const q of [0.9, 0.82, 0.72, 0.6]) {
      let blob = await new Promise((res) => c.toBlob(res, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) return { blob, width: w, height: h };
    }
  }
  throw new Error('Obrázek se nepodařilo zmenšit pod limit.');
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
