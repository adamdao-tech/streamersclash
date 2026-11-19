// Twitch panel: our team's Streamers Clash matches, live from the SC Scouting app (public data only).
(function () {
  var API = 'https://sc.daotech.dev/rozpis.json';
  var tz = 'Europe/Prague';
  function f(d, o) { o.timeZone = tz; return new Intl.DateTimeFormat('cs-CZ', o).format(d); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  var KIND = { match: 'TURNAJ', scrim: 'SCRIM', other: 'AKCE', off: 'VOLNO' };
  // how long an event counts as "now": a free day the whole day, the rest 3 h from the start
  function endOf(e) {
    var t = new Date(e.starts_at).getTime();
    return e.kind === 'off' ? t + 24 * 3600e3 : t + 3 * 3600e3;
  }

  function render(data) {
    var name = (data.team && data.team.name) || '';
    document.getElementById('team').textContent = 'Tým ' + (name.toLowerCase() === 'sgoob' ? 'SGooB' : name);
    var list = document.getElementById('list');
    list.textContent = '';
    var now = Date.now();
    var all = data.events || (data.matches || []).map(function (m) { m.kind = 'match'; return m; });
    var upcoming = all.filter(function (e) { return endOf(e) > now; });
    var played = all.filter(function (e) { return e.kind === 'match' && e.score && endOf(e) <= now; }).slice(-1);
    var rows = played.concat(upcoming).slice(0, 6);
    if (!rows.length) { list.appendChild(el('li', 'empty', 'Termíny zatím nejsou.')); return; }
    var nextMarked = false;
    rows.forEach(function (e) {
      var d = new Date(e.starts_at), t = d.getTime();
      var li = el('li', 'k-' + e.kind);
      if (!e.score && !nextMarked && e.kind !== 'off') { li.className += ' next'; nextMarked = true; }
      var date = el('div', 'date');
      date.appendChild(el('div', 'dow', f(d, { weekday: 'short' }).replace('.', '').toUpperCase()));
      date.appendChild(el('div', 'dm', f(d, { day: 'numeric', month: 'numeric' }).replace(/\s/g, '')));
      var mid = el('div');
      var top = el('div', 'vs');
      if (e.opponent) { top.appendChild(el('small', null, 'vs')); top.appendChild(document.createTextNode(e.opponent)); }
      else top.appendChild(document.createTextNode(e.title || (e.kind === 'off' ? 'Volno' : 'Akce')));
      mid.appendChild(top);
      var sub = el('div', 'stage');
      sub.appendChild(el('span', 'tag', KIND[e.kind] || ''));
      var extra = e.kind === 'match' ? [e.stage && e.stage.replace(/^Skupina \S+ · /, ''), e.format] : e.kind === 'scrim' ? [e.format] : e.kind === 'off' && e.title ? [] : [];
      extra = extra.filter(Boolean).join(' · ');
      if (extra) sub.appendChild(document.createTextNode(' ' + extra));
      mid.appendChild(sub);
      var when;
      if (e.score) {
        var win = e.score[0] > e.score[1];
        when = el('div', 'when ' + (win ? 'win' : 'loss'), e.score[0] + ':' + e.score[1]);
        when.appendChild(el('small', null, win ? 'VÝHRA' : 'PROHRA'));
      } else if (e.kind === 'off') {
        when = el('div', 'when off', '—');
      } else if (now >= t && now < endOf(e)) {
        when = el('div', 'when'); when.appendChild(el('span', 'live', e.kind === 'match' ? 'HRAJEME' : 'PRÁVĚ'));
      } else {
        when = el('div', 'when', f(d, { hour: '2-digit', minute: '2-digit' }));
      }
      li.appendChild(date); li.appendChild(mid); li.appendChild(when);
      list.appendChild(li);
    });
  }

  function load() {
    fetch(API).then(function (r) { return r.json(); }).then(render).catch(function () {
      var list = document.getElementById('list');
      if (!list.querySelector('.vs')) { list.textContent = ''; list.appendChild(el('li', 'empty', 'Harmonogram se teď nepodařilo načíst.')); }
    });
  }
  if (window.Twitch && window.Twitch.ext) window.Twitch.ext.onAuthorized(function () {});
  load();
  setInterval(load, 10 * 60 * 1000);
})();
