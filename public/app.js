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

const SOURCE = { sync: 'Čtečka', claude: 'Claude', user: 'Ručně' };

export function draftHtml(d, icons, highlightPlayerIds = new Set()) {
  const side = (s) => d.actions.filter((a) => a.side === s);
  const picks = (s) =>
    side(s)
      .filter((a) => a.action === 'PICK')
      .map((a) => {
        const mine = a.player_id && highlightPlayerIds.has(a.player_id);
        return `<div class="pick${mine ? ' mine' : ''}">${champIcon(icons, a.champion)}<div><b>${esc(a.champion)}</b>${a.player_name ? `<small>${esc(a.player_name)}</small>` : ''}</div></div>`;
      })
      .join('');
  const bans = (s) => side(s).filter((a) => a.action === 'BAN').map((a) => champIcon(icons, a.champion, 'sm')).join('');
  const when = d.played_at ? new Date(d.played_at).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const link = vodLink(d.vod_url, d.vod_timestamp_s);
  return `
    <article class="draft">
      <div class="draft-meta">
        <span>${esc(when)}</span>
        ${d.pov_nickname ? `<span>POV: <b>${esc(d.pov_nickname)}</b></span>` : ''}
        <span class="badge">${SOURCE[d.created_by_kind] || esc(d.created_by_kind)}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">▶ Champ select ve VODce</a>` : ''}
      </div>
      <div class="draft-body">
        <div class="draft-side ally">
          <div class="side-label">Spoluhráči ${bans('ALLY') ? `<span class="bans">${bans('ALLY')}</span>` : ''}</div>
          ${picks('ALLY')}
        </div>
        <div class="draft-vs">VS</div>
        <div class="draft-side enemy">
          <div class="side-label">Soupeři ${bans('ENEMY') ? `<span class="bans">${bans('ENEMY')}</span>` : ''}</div>
          ${picks('ENEMY')}
        </div>
      </div>
    </article>`;
}

/** Champion pool of one player from saved drafts: [{champion, games}] sorted by games. */
export function championPool(drafts, playerId) {
  const counts = new Map();
  for (const d of drafts) {
    for (const a of d.actions) {
      if (a.action === 'PICK' && a.player_id === playerId) counts.set(a.champion, (counts.get(a.champion) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([champion, games]) => ({ champion, games })).sort((a, b) => b.games - a.games);
}
