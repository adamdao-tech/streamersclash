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
    ['/vods', 'VODky', 'vods'],
    ...(user.role === 'admin' ? [['/users', 'Uživatelé', 'users']] : []),
  ];
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = `
    <a class="brand" href="/">SC <span>Scouting</span></a>
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
