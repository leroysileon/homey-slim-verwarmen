'use strict';
// Bouwt één losse HTML-pagina met de widget in elke toestand, licht en donker naast elkaar.
// Gebruik: node dev/states.js [uitvoerbestand]   (standaard: dev/states.html, staat in .gitignore)
// De preview-server toont hem ook op /states.
const fs = require('fs');
const path = require('path');

const MIN = 60000;

/** Gedeelde basis; elke toestand past alleen aan wat anders is. */
function base(now) {
  return {
    updatedAt: now, targetConfirmed: true, mode: 'schedule', setupDone: true, enabled: true, away: false,
    thermostatTarget: 15, indoor: 17.6, humidity: 58, outdoor: 3.5, weather: 'partly', room: 'Woonkamer',
    currentBlock: { at: 'vr 08:30', temp: 15 }, nextBlock: { at: 'vr 18:00', temp: 18, inMinutes: 150 },
    nextChangeAt: now + 150 * MIN, preheatMinutes: 64, override: null, overrideDefault: 'next',
    learned: { samples: 3, rate: 1.35, deadTime: 14, heatingNow: false, recent: [] },
    presence: { auto: true, home: ['Leroy'] }, error: null,
  };
}

const STATES = [
  ['Rust (op temperatuur)', {}],
  ['Verwarmen', { thermostatTarget: 18, mode: 'schedule' }],
  ['Wacht op thermostaat', { thermostatTarget: 18, targetConfirmed: false }],
  ['Voorverwarmen', { mode: 'preheat', thermostatTarget: 18 }],
  ['Handmatig warmer', { mode: 'manual', thermostatTarget: 20.5, override: { temp: 20.5, duration: 'next' } }],
  ['Handmatig, op temperatuur', { mode: 'manual', thermostatTarget: 17.5, override: { temp: 17.5, duration: 120 } }],
  ['Te koud', { indoor: 15.2, thermostatTarget: 15 }],
  ['Te vochtig', { humidity: 72 }],
  ['Duur kiezen (verwarmen)', { mode: 'manual', thermostatTarget: 20.5, override: { temp: 20.5, duration: 120 } }, { open: true }],
  ['Duur kiezen (rust)', { mode: 'manual', thermostatTarget: 17.5, override: { temp: 17.5, duration: 'next' } }, { open: true }],
  ['Duur kiezen (te koud)', { mode: 'manual', indoor: 15.2, thermostatTarget: 15, override: { temp: 15, duration: 'manual' } }, { open: true }],
  ['Niemand thuis', { mode: 'away', away: true, thermostatTarget: 16 }],
  ['Gepauzeerd', { mode: 'paused', enabled: false }],
  ['Nog niet gestart', { mode: 'setup', setupDone: false, enabled: false }],
];

const SCHEDULE = (() => {
  const day = [{ time: '07:00', temp: 17 }, { time: '08:30', temp: 15 }, { time: '18:00', temp: 18 }, { time: '22:30', temp: 15 }];
  return Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, day]));
})();

/** Nepverloop van vandaag voor de tweede kaart. */
function history(now) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0); const start = d0.getTime();
  const indoor = []; const target = []; const humidity = []; let t = 18;
  for (let k = start; k < now; k += 5 * MIN) {
    const hr = (k - start) / 3600000; const sp = hr < 6.5 ? 15 : hr < 8.5 ? 18 : hr < 12 ? 17 : hr < 14 ? 20.5 : hr < 18 ? 17 : 18;
    t += sp > t ? 0.08 : -0.02; indoor.push([k, Math.round(t * 10) / 10]); target.push([k, sp]); humidity.push([k, 60]);
  }
  return { day: 0, start, end: start + 86400000, now, room: 'Woonkamer', indoor, target, humidity, outdoor: [],
    modes: [{ t: start, m: 'schedule' }, { t: start + 12 * 3600000, m: 'manual' }, { t: start + 14 * 3600000, m: 'schedule' }].filter((m) => m.t < now) };
}

function build() {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'verwarming', 'public', 'index.html'), 'utf8');
  // Zonder eigen <html>/<head>/<body>: zo werkt hij ook als losse webpagina (die zet het geraamte er zelf omheen).
  return `<title>Widget toestanden</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
  /* Twee kolommen per toestand (licht | donker), stapelt op een smal scherm. */
  :root { --bg: #f2f1ef; --text: #17171a; --muted: #6b6f76; --tile-light: #f2f2f7; --tile-dark: #000; --tag: #8a8d93; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #111214; --text: #f5f5f5; --muted: #9a9aa0; color-scheme: dark; } }
  :root[data-theme="dark"] { --bg: #111214; --text: #f5f5f5; --muted: #9a9aa0; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding-block: 24px 48px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); background: var(--bg); color: var(--text); font: 15px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  h1 { font-size: 24px; margin: 0 0 4px; } p.sub { margin: 0 0 20px; color: var(--muted); }
  .grid { display: grid; gap: 22px; max-width: 820px; }
  .row h2 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .cell { border-radius: 18px; padding: 10px 10px 4px; }
  .cell.light { background: var(--tile-light); } .cell.dark { background: var(--tile-dark); }
  .cell small { display: block; font-size: 11px; margin: 0 4px 6px; color: var(--tag); }
  iframe { display: block; width: 100%; height: 232px; border: 0; background: transparent; }
</style>
<h1>Widget toestanden</h1>
<p class="sub">Elke toestand van de widget, links licht en rechts donker. Tik en veeg zoals in Homey; acties doen hier niets.</p>
<div class="grid" id="grid"></div>
<script>
const WIDGET = ${JSON.stringify(widget).replace(/<\/script/gi, '<\\/script')};
const STATES = ${JSON.stringify(STATES)};
const SCHEDULE = ${JSON.stringify(SCHEDULE)};
const BASE = ${JSON.stringify(base.toString())};
const HIST = ${JSON.stringify(history.toString())};
function mock(over, opt) {
  // Duur kiezen: na het laden op het potloodje tikken en het automatisch sluiten (5 s) uitzetten, zodat het open blijft staan.
  // Animaties uit: dit is een overzicht van eindstanden.
  const open = opt && opt.open ? 'document.head.insertAdjacentHTML("beforeend","<style>*{animation:none!important;transition:none!important}</style>");var _st=window.setTimeout;window.setTimeout=function(f,ms){return _st(f,ms===5000?1e9:ms);};window.addEventListener("load",function(){_st(function(){var b=document.querySelector("[data-duropen]");if(b)b.click();},400);});' : '';
  return '<script>var MIN=60000;function base(now){return (' + BASE + ')(now);} function history(now){return (' + HIST + ')(now);}'
    + '(function(){var now=Date.now();var s=Object.assign(base(now),' + JSON.stringify(over) + ');'
    + 'if(s.override){s.override=Object.assign({since:now-3600000,until:s.override.duration==="manual"?null:now+(s.override.duration==="next"?150:s.override.duration)*60000},s.override);}'
    + 'var H={ready:function(){},setHeight:function(){return Promise.resolve();},on:function(){},popup:function(){return Promise.resolve();},hapticFeedback:function(){},'
    + 'api:function(m,p){return Promise.resolve(p.indexOf("/history")===0?history(now):{status:s,schedule:' + JSON.stringify(SCHEDULE) + '});}};'
    + 'window.addEventListener("load",function(){window.onHomeyReady(H);});})();' + open + '<\\/script>';
}
const grid = document.getElementById('grid');
for (const [name, over, opt] of STATES) {
  const row = document.createElement('section'); row.className = 'row';
  row.innerHTML = '<h2></h2><div class="pair"></div>'; row.querySelector('h2').textContent = name;
  for (const scheme of ['light', 'dark']) {
    const cell = document.createElement('div'); cell.className = 'cell ' + scheme;
    cell.innerHTML = '<small>' + (scheme === 'light' ? 'Licht' : 'Donker') + '</small>';
    const f = document.createElement('iframe'); f.title = name + ' (' + scheme + ')';
    // Donker afdwingen: de donkere regels altijd laten gelden (een iframe volgt het thema van de pagina niet overal).
    const html = WIDGET.split('@media (prefers-color-scheme: dark)').join(scheme === 'dark' ? '@media all' : '@media not all');
    f.srcdoc = html.replace('</head>', mock(over, opt) + '</head>');
    cell.appendChild(f); row.querySelector('.pair').appendChild(cell);
  }
  grid.appendChild(row);
}
</script>
`;
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'states.html');
  fs.writeFileSync(out, build());
  console.log(`Geschreven: ${out}`);
}

module.exports = { build };
