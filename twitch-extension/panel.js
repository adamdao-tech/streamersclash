// Twitch panel: our team's Streamers Clash matches, live from the SC Scouting app (public data only).
(function () {
  var API = 'https://sc.daotech.dev/rozpis.json';
  var tz = 'Europe/Prague';
  function f(d, o) { o.timeZone = tz; return new Intl.DateTimeFormat('cs-CZ', o).format(d); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render(data) {
    var name = (data.team && data.team.name) || '';
    document.getElementById('team').textContent = 'Tým ' + (name.toLowerCase() === 'sgoob' ? 'SGooB' : name);
    var list = document.getElementById('list');
    list.textContent = '';
    var now = Date.now();
    var all = data.matches || [];
    // upcoming first (until 3 h after the start), then the last results
    var upcoming = all.filter(function (m) { return new Date(m.starts_at).getTime() + 3 * 3600e3 > now; });
    var played = all.filter(function (m) { return upcoming.indexOf(m) < 0 && m.score; }).slice(-2);
    var rows = played.concat(upcoming).slice(0, 7);
    if (!rows.length) { list.appendChild(el('li', 'empty', 'Termíny zatím nejsou.')); return; }
    var nextMarked = false;
    rows.forEach(function (m) {
      var d = new Date(m.starts_at), t = d.getTime();
      var li = el('li');
      if (!m.score && !nextMarked) { li.className = 'next'; nextMarked = true; }
      var date = el('div', 'date');
      date.appendChild(el('div', 'dow', f(d, { weekday: 'short' }).replace('.', '').toUpperCase()));
      date.appendChild(el('div', 'dm', f(d, { day: 'numeric', month: 'numeric' }).replace(/\s/g, '')));
      var mid = el('div');
      var vs = el('div', 'vs'); vs.appendChild(el('small', null, 'vs')); vs.appendChild(document.createTextNode(m.opponent));
      mid.appendChild(vs);
      mid.appendChild(el('div', 'stage', [m.stage, m.format].filter(Boolean).join(' · ')));
      var when;
      if (m.score) {
        var win = m.score[0] > m.score[1];
        when = el('div', 'when ' + (win ? 'win' : 'loss'), m.score[0] + ':' + m.score[1]);
        when.appendChild(el('small', null, win ? 'VÝHRA' : 'PROHRA'));
      } else if (now >= t && now < t + 3 * 3600e3) {
        when = el('div', 'when'); when.appendChild(el('span', 'live', 'HRAJEME'));
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
