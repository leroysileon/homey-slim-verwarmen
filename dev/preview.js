'use strict';
// Lokale preview van de instellingenpagina met een nep-Homey. Start: node dev/preview.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4321;
const store = {
  schedule: {
    mon: [{ time: '07:00', temp: 17 }, { time: '07:45', temp: 15 }, { time: '18:00', temp: 18 }, { time: '22:30', temp: 15 }],
    tue: [{ time: '07:00', temp: 17 }, { time: '07:45', temp: 15 }, { time: '18:00', temp: 18 }, { time: '22:30', temp: 15 }],
    wed: [{ time: '07:00', temp: 17 }, { time: '07:45', temp: 15 }, { time: '18:00', temp: 18 }, { time: '22:30', temp: 15 }],
    thu: [{ time: '08:30', temp: 17 }, { time: '12:00', temp: 15 }, { time: '18:00', temp: 18 }, { time: '22:30', temp: 15 }],
    fri: [{ time: '08:30', temp: 17 }, { time: '12:00', temp: 15 }, { time: '18:00', temp: 18 }, { time: '22:30', temp: 15 }],
    sat: [{ time: '10:00', temp: 18 }, { time: '23:00', temp: 15 }],
    sun: [{ time: '10:00', temp: 18 }, { time: '23:00', temp: 15 }],
  },
  config: { thermostatId: 'tado', outdoorDeviceId: 'knmi', outdoorCapability: 'current_temp', ecoTemp: 16, maxPreheat: 180, preheat: true },
};
let mode = 'schedule';
let manualTemp = 21;
let manualDur = 'next';
const untilOf = (d) => (d === 'manual' ? null : d === 'next' ? Date.now() + 466 * 60000 : Date.now() + d * 60000);
let manualUntil = untilOf('next');
const now = Date.now();
const status = () => ({
  updatedAt: Date.now(), mode, thermostatTarget: mode === 'manual' ? manualTemp : 15, indoor: 17.6, outdoor: 3.5,
  currentBlock: { at: 'do 22:30', temp: 15 }, nextBlock: { at: 'vr 08:30', temp: 17, inMinutes: 530 }, preheatMinutes: 64,
  override: mode === 'manual' ? { temp: manualTemp, since: now, until: manualUntil, duration: manualDur } : null,
  overrideDefault: store.config.overrideDefault || 'next',
  nextChangeAt: Date.now() + 466 * 60000,
  away: mode === 'away', enabled: mode !== 'paused',
  learned: { samples: 3, rate: 1.35, deadTime: 14, heatingNow: false, recent: [
    { at: now - 86400000, from: 15.2, to: 18, rate: 1.4, deadTime: 12, outdoor: 4 },
    { at: now - 2 * 86400000, from: 15.6, to: 17, rate: 1.2, deadTime: 16, outdoor: 2.5 },
  ] },
  error: null,
});
const devices = [
  { id: 'tado', name: 'Tado X', zone: 'Woonkamer', thermostat: true, tempCaps: [{ id: 'measure_temperature', title: 'Temperatuur' }] },
  { id: 'plan', name: 'Plan Weekprogramma', zone: 'Woonkamer', thermostat: true, tempCaps: [] },
  { id: 'knmi', name: 'KNMI weather', zone: 'Tuin', thermostat: false, tempCaps: [{ id: 'current_temp', title: 'Temperatuur' }] },
  { id: 'kk', name: 'Temp. sensor', zone: 'Kinderkamer', thermostat: false, tempCaps: [{ id: 'measure_temperature', title: 'Temperatuur' }] },
];

const mockHomey = `
(function(){
  const call = async (m, p, b) => { const r = await fetch('/__api' + p, { method: m, headers: {'content-type':'application/json'}, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
  const Homey = {
    ready(){ console.log('Homey.ready'); },
    on(ev, cb){ if (ev === 'status') setInterval(async () => cb(await call('GET', '/status')), 3000); },
    get(k, cb){ call('GET', '/setting/' + k).then(v => cb(null, v), cb); },
    set(k, v, cb){ call('PUT', '/setting/' + k, { value: v }).then(() => cb && cb(null), cb); },
    api(m, p, b, cb){ call(m, p, b).then(v => cb(null, v), cb); },
    alert(msg, icon, cb){ window.alert(msg); cb && cb(null); },
    confirm(msg, icon, cb){ cb(null, window.confirm(msg)); },
  };
  window.addEventListener('load', () => window.onHomeyReady && window.onHomeyReady(Homey));
})();`;

http.createServer((req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') return send(200, fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8'), 'text/html');
    if (url === '/homey.js') return send(200, mockHomey, 'text/javascript');
    if (url === '/widget') {
      const html = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'verwarming', 'public', 'index.html'), 'utf8')
        .replace('</head>', '<meta name="viewport" content="width=device-width, initial-scale=1"><style>html{background:#000}body{max-width:380px;margin:16px auto;padding:0 12px}</style><script src="/widget-homey.js"></script></head>');
      return send(200, html, 'text/html');
    }
    if (url === '/widget-homey.js') return send(200, `
      (function(){
        const H = {
          ready(o){ window.__h = o && o.height; }, setHeight(h){ window.__h = h; return Promise.resolve(); }, on(){}, popup(u){ console.log('POPUP', u); window.__popup = u; return Promise.resolve(); }, hapticFeedback(){},
          async api(m, p, b){ const r = await fetch('/__widget' + p, { method: m, headers: {'content-type':'application/json'}, body: b ? JSON.stringify(b) : undefined }); return r.json(); },
        };
        window.addEventListener('load', () => window.onHomeyReady(H));
      })();`, 'text/javascript');
    if (url === '/__widget/status') return send(200, { status: status(), schedule: store.schedule });
    if (url === '/__widget/action' || url === '/__api/action') {
      if (!req.__delayed) { req.__delayed = true; return setTimeout(() => req.emit('end'), 1500); }
    }
    if (url === '/__widget/action') {
      const b = JSON.parse(data || '{}');
      if (b.action === 'setTemp') {
        if (mode !== 'manual' || b.duration != null) { manualDur = b.duration != null ? b.duration : (store.config.overrideDefault || 'next'); manualUntil = untilOf(manualDur); }
        mode = 'manual'; manualTemp = b.temp;
      } else if (b.action === 'setDuration') { manualDur = b.duration; manualUntil = untilOf(b.duration); } else if (b.action === 'resume') mode = 'schedule';
      return send(200, { status: status(), schedule: store.schedule });
    }
    if (url.startsWith('/__api/setting/')) {
      const k = url.split('/').pop();
      if (req.method === 'PUT') { store[k] = JSON.parse(data).value; console.log('SET', k, JSON.stringify(store[k])); return send(200, {}); }
      return send(200, store[k] === undefined ? null : store[k]);
    }
    if (url === '/__api/status') return send(200, status());
    if (url === '/__api/devices') return send(200, devices);
    if (url === '/__api/action') {
      const { action, duration } = JSON.parse(data || '{}');
      if (action === 'setDuration') { manualDur = duration; manualUntil = untilOf(duration); return send(200, status()); }
      mode = { resume: 'schedule', away: 'away', home: 'schedule', pause: 'paused', enable: 'schedule' }[action] || mode;
      return send(200, status());
    }
    if (url === '/__mode') { mode = new URLSearchParams(req.url.split('?')[1]).get('m'); return send(200, { mode }); }
    send(404, 'not found', 'text/plain');
  });
}).listen(PORT, () => console.log(`Preview op http://localhost:${PORT}`));
