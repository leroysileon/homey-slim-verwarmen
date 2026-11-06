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
  config: { usage: true, meterId: 'p1', meterCapability: 'meter_gas', price: 1.4, thermostatId: 'thermostaat', outdoorDeviceId: 'knmi', outdoorCapability: 'current_temp', ecoTemp: 16, maxPreheat: 180, preheat: true },
};
let mode = 'schedule';
let manualTemp = 21; let confirmedAt = 0;
let manualDur = 'next';
const untilOf = (d) => (d === 'manual' ? null : d === 'next' ? Date.now() + 466 * 60000 : Date.now() + d * 60000);
let manualUntil = untilOf('next');
const now = Date.now();
const status = () => ({
  updatedAt: Date.now(), targetConfirmed: Date.now() >= confirmedAt, mode, setupDone: mode !== 'setup', thermostatTarget: mode === 'manual' ? manualTemp : 15, indoor: 17.6, humidity: 63, outdoor: 3.5, weather: 'partly', room: 'Woonkamer', presence: { auto: store.config.autoPresence === true, home: ['Leroy Sileon'], count: 3 },
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
  { id: 'thermostaat', name: 'Thermostaat', zone: 'Woonkamer', thermostat: true, tempCaps: [{ id: 'measure_temperature', title: 'Temperatuur' }] },
  { id: 'plan', name: 'Plan Weekprogramma', zone: 'Woonkamer', thermostat: true, tempCaps: [] },
  { id: 'knmi', name: 'KNMI weather', zone: 'Tuin', thermostat: false, tempCaps: [{ id: 'current_temp', title: 'Temperatuur' }] },
  { id: 'kk', name: 'Temp. sensor', zone: 'Kinderkamer', thermostat: false, tempCaps: [{ id: 'measure_temperature', title: 'Temperatuur' }] },
  { id: 'p1', name: 'P1-meter', zone: 'Meterkast', thermostat: false, tempCaps: [], meterCaps: [{ id: 'meter_gas', title: 'Totaal gasverbruik' }, { id: 'meter_power.imported', title: 'Totale geïmporteerde energie' }] },
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
    if (url === '/states') { delete require.cache[require.resolve('./states')]; return send(200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${require('./states').build()}`, 'text/html'); } // alle toestanden van de widget
    if (url === '/homey.js') return send(200, mockHomey, 'text/javascript');
    if (url === '/tile.html') return send(200, fs.readFileSync(path.join(__dirname, '..', 'settings', 'tile.html'), 'utf8'), 'text/html');
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
        mode = 'manual'; manualTemp = b.temp; confirmedAt = Date.now() + 6000;
      } else if (b.action === 'setDuration') { manualDur = b.duration; manualUntil = untilOf(b.duration); } else if (b.action === 'resume') mode = 'schedule';
      return send(200, { status: status(), schedule: store.schedule });
    }
    if (url.startsWith('/__api/setting/')) {
      const k = url.split('/').pop();
      if (req.method === 'PUT') { store[k] = JSON.parse(data).value; console.log('SET', k, JSON.stringify(store[k])); return send(200, {}); }
      return send(200, store[k] === undefined ? null : store[k]);
    }
    if (url === '/__api/status') return send(200, status());
    if (url === '/__api/history' || url === '/__widget/history') {
      // Nepverloop: 's nachts afkoelen, ochtend opwarmen naar 18°, middag handmatig 20.5°.
      const day = Number(new URLSearchParams(req.url.split('?')[1]).get('day')) || 0;
      const d0 = new Date(); d0.setHours(0, 0, 0, 0); const start = d0.getTime() - day * 86400000; const end = start + 86400000;
      const upto = day === 0 ? Date.now() : end; const indoor = []; const target = []; const outdoor = []; const humidity = []; let t = 18;
      for (let k = start; k < upto; k += 300000) {
        const hr = (k - start) / 3600000; const sp = hr < 6.5 ? 15 : hr < 8.5 ? 18 : hr < 12 ? 17 : hr < 14 ? 20.5 : hr < 18 ? 17 : hr < 22.5 ? 18 : 15;
        t += sp > t ? 0.08 : -0.02; indoor.push([k, Math.round(t * 10) / 10]); target.push([k, sp]); outdoor.push([k, 2 + 5 * Math.sin((hr - 8) / 24 * Math.PI * 2)]); humidity.push([k, Math.round(60 + 4 * Math.sin(hr / 3))]);
      }
      const modes = [{ t: start, m: 'schedule' }, { t: start + 12 * 3600000, m: 'manual' }, { t: start + 14 * 3600000, m: 'schedule' }].filter((m) => m.t < upto);
      const usage = store.config.usage && store.config.meterId ? { amount: 2.3, unit: 'm³', price: store.config.price || 1.4, cost: Math.round(2.3 * (store.config.price || 1.4) * 100) / 100 } : null;
      return send(200, { day, start, end, now: Date.now(), room: 'Woonkamer', indoor, target, outdoor, humidity, modes, usage });
    }
    if (url === '/__api/devices') return send(200, devices);
    if (url === '/__api/action') {
      const { action, duration, temp } = JSON.parse(data || '{}');
      if (action === 'setTemp') {
        if (mode !== 'manual' || duration != null) { manualDur = duration != null ? duration : (store.config.overrideDefault || 'next'); manualUntil = untilOf(manualDur); }
        mode = 'manual'; manualTemp = temp; confirmedAt = Date.now() + 6000; return send(200, status());
      }
      if (action === 'setDuration') { manualDur = duration; manualUntil = untilOf(duration); return send(200, status()); }
      mode = { resume: 'schedule', away: 'away', home: 'schedule', pause: 'paused', enable: 'schedule', start: 'schedule' }[action] || mode;
      return send(200, status());
    }
    if (url === '/__mode') { mode = new URLSearchParams(req.url.split('?')[1]).get('m'); return send(200, { mode }); }
    send(404, 'not found', 'text/plain');
  });
}).listen(PORT, () => console.log(`Preview op http://localhost:${PORT}`));
