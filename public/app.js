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
