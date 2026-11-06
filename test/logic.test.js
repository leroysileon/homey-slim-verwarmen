'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toEvents, currentAndNext, localMow } = require('../lib/schedule');
const { Learner } = require('../lib/learner');
const { Controller } = require('../lib/controller');

const TZ = 'Europe/Amsterdam';
const MIN = 60000;
// Woensdag 4 nov 2026, Amsterdam = UTC+1
const at = (hhmm, day = 4) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 10, day, h - 1, m);
};

const SCHEDULE = {
  sun: [], mon: [], tue: [{ time: '06:30', temp: 20 }, { time: '22:30', temp: 16 }],
  wed: [{ time: '06:30', temp: 20 }, { time: '22:30', temp: 16 }],
  thu: [{ time: '06:30', temp: 20 }, { time: '22:30', temp: 16 }],
  fri: [], sat: [],
};

function memoryStore(initial = {}) {
  const data = { ...initial };
  return { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); }, data };
}

function setup({ now, target = 16, indoor = 17, outdoor = 4, store } = {}) {
  const sim = { now, target, indoor, outdoor, writes: [] };
  const events = [];
  const io = {
    now: () => sim.now,
    timeZone: () => TZ,
    readThermostat: async () => ({ target: sim.target, indoor: sim.indoor }),
    readOutdoor: async () => sim.outdoor,
    writeTarget: async (t) => { sim.target = t; sim.writes.push({ t, at: sim.now }); },
  };
  const c = new Controller({
    io, store: store || memoryStore({ schedule: SCHEDULE, state: {} }), onEvent: (e, d) => events.push({ e, d }), // state: bestaande installatie
  });
  return { c, sim, events };
}

test('lokale tijd en schema-blokken', () => {
  assert.equal(localMow(new Date(at('06:30')), TZ), 3 * 1440 + 390);
  const ev = toEvents(SCHEDULE);
  const cn = currentAndNext(ev, localMow(new Date(at('12:00')), TZ));
  assert.equal(cn.current.temp, 20);
  assert.equal(cn.next.temp, 16);
  assert.equal(cn.minutesToNext, 630);
  // vrijdag t/m maandag leeg: dinsdag 06:30 is volgende wissel na do 22:30
  const fri = currentAndNext(ev, localMow(new Date(at('12:00', 6)), TZ));
  assert.equal(fri.current.temp, 16);
  assert.equal(fri.minutesToNext, (4 * 24 - 5.5) * 60);
});

test('volgt het schema', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 16, indoor: 19.5 });
  await c.tick();
  assert.equal(sim.target, 20);
  sim.now = at('22:31');
  await c.tick();
  assert.equal(sim.target, 16);
});

test('handmatig verstellen blijft staan tot het volgende blok', async () => {
  const { c, sim, events } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  sim.now = at('19:00');
  await c.tick();
  sim.target = 22; // iemand draait aan de knop
  sim.now = at('19:01');
  await c.tick();
  assert.equal(c.status.mode, 'manual');
  assert.ok(events.some((x) => x.e === 'override_started'));
  sim.now = at('22:00');
  await c.tick();
  assert.equal(sim.target, 22, 'niet overschrijven tijdens handmatige stand');
  sim.now = at('22:30');
  await c.tick();
  assert.equal(sim.target, 16, 'volgende blok neemt het over');
  assert.equal(c.status.mode, 'schedule');
});

test('voorverwarmen start op tijd en houdt vol', async () => {
  const { c, sim } = setup({ now: at('03:00'), target: 16, indoor: 17, outdoor: 4 });
  // geleerd: 1 °C/uur, 15 min dode tijd => 17->20 = 15 + 180 min = 195 * 1.1 = 214 -> max 180
  await c.tick();
  assert.equal(sim.target, 16);
  assert.equal(c.status.preheatMinutes, 180);
  sim.now = at('03:29');
  await c.tick();
  assert.equal(sim.target, 16);
  sim.now = at('03:30');
  await c.tick();
  assert.equal(sim.target, 20, 'start 180 min van tevoren');
  sim.indoor = 19.5; // warmt op -> berekende tijd krimpt, maar we blijven doorstoken
  sim.now = at('05:30');
  await c.tick();
  assert.equal(sim.target, 20);
  assert.equal(c.status.mode, 'preheat');
});

test('leert opwarmsnelheid en dode tijd', () => {
  const l = new Learner();
  let now = 0;
  l.observe({ now, target: 20, indoor: 17, outdoor: 5 });
  for (let m = 1; m <= 200; m++) {
    now = m * MIN;
    const indoor = m < 20 ? 17 : 17 + (m - 20) * (2 / 60); // 20 min dode tijd, daarna 2 °C/uur
    const s = l.observe({ now, target: 20, indoor: Math.round(indoor * 10) / 10, outdoor: 5 });
    if (s) {
      assert.ok(Math.abs(s.rate - 2) < 0.25, `rate ${s.rate}`);
      assert.ok(s.deadTime >= 20 && s.deadTime <= 30, `dead ${s.deadTime}`);
      break;
    }
  }
  assert.equal(l.samples.length, 1);
});

test('onderbroken opwarmen telt mee als de stijging lang genoeg duurde', () => {
  const l = new Learner();
  l.observe({ now: 0, target: 21, indoor: 18, outdoor: 5 });
  for (let m = 1; m <= 60; m++) { // 10 min dode tijd, daarna 2 °C/uur
    const indoor = m < 10 ? 18 : 18 + (m - 10) * (2 / 60);
    l.observe({ now: m * MIN, target: 21, indoor: Math.round(indoor * 10) / 10, outdoor: 5 });
  }
  const s = l.observe({ now: 61 * MIN, target: 19, indoor: 19.7, outdoor: 5 }); // iemand verandert de knop
  assert.ok(s, 'meting opgeslagen');
  assert.ok(Math.abs(s.rate - 2) < 0.3, `rate ${s.rate}`);
  assert.equal(l.samples.length, 1);
});

test('kort onderbroken opwarmen telt niet mee', () => {
  const l = new Learner();
  l.observe({ now: 0, target: 21, indoor: 18, outdoor: 5 });
  for (let m = 1; m <= 20; m++) l.observe({ now: m * MIN, target: 21, indoor: 18 + Math.max(0, m - 5) * 0.04, outdoor: 5 });
  assert.equal(l.observe({ now: 21 * MIN, target: 19, indoor: 18.6, outdoor: 5 }), null);
  assert.equal(l.samples.length, 0);
});

test('meting begint al bij 0,8° verschil', () => {
  const l = new Learner();
  l.observe({ now: 0, target: 18, indoor: 17.2, outdoor: 5 });
  assert.ok(l.session, 'sessie gestart');
});

test('kouder buiten = langer voorverwarmen', () => {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const outdoor = -2 + i * 1.5;
    samples.push({ rate: 1 + outdoor * 0.1, deadTime: 15, outdoor });
  }
  const l = new Learner({ samples });
  assert.ok(l.preheatMinutes(17, 20, -3, 300) > l.preheatMinutes(17, 20, 12, 300));
});

test('afwezig = eco, thuiskomen hervat schema en wist override', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setAway(true);
  assert.equal(sim.target, 16);
  sim.target = 18;
  sim.now = at('12:05');
  await c.tick();
  assert.equal(c.status.mode, 'manual');
  await c.setAway(false);
  assert.equal(sim.target, 20);
});

test('eigen schrijfactie telt niet als handmatig', async () => {
  const { c, sim } = setup({ now: at('06:00'), target: 16, indoor: 20.5 });
  await c.tick(); // geen voorverwarming nodig, binnen al warm
  sim.now = at('06:30');
  await c.tick();
  assert.equal(sim.target, 20);
  sim.now = at('06:40');
  await c.tick();
  assert.notEqual(c.status.mode, 'manual');
});

test('temperatuur zetten via Homey = handmatig tot volgende blok', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setManual(22);
  assert.equal(sim.target, 22);
  assert.equal(c.status.mode, 'manual');
  assert.match(c.status.modeLabel, /^Handmatig tot 22:30$/);
  sim.now = at('22:30');
  await c.tick();
  assert.equal(sim.target, 16);
  assert.equal(c.status.modeLabel, 'Volgens schema');
});

test('na eigen wijziging toont de status meteen de nieuwe waarde', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  // thermostaat die de nieuwe waarde nog niet bevestigt
  const realWrite = c.io.writeTarget;
  c.io.writeTarget = async () => {};
  await c.setManual(21);
  assert.equal(sim.target, 20);
  assert.equal(c.status.thermostatTarget, 21);
  c.io.writeTarget = realWrite;
});

test('nogmaals "thuis" melden laat de handmatige stand staan', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setManual(22);
  sim.now = at('12:05');
  await c.setAway(false); // was al thuis
  assert.equal(c.status.mode, 'manual');
  assert.equal(sim.target, 22);
});

test('handmatig met een vaste duur, daarna weer het schema', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setManual(22, 90);
  assert.equal(c.status.override.duration, 90);
  assert.match(c.status.modeLabel, /^Handmatig tot 13:30$/);
  sim.now = at('13:29');
  await c.tick();
  assert.equal(sim.target, 22);
  sim.now = at('13:30');
  await c.tick();
  assert.equal(sim.target, 20);
  assert.equal(c.status.mode, 'schedule');
});

test('handmatig zonder eindtijd blijft staan tot je het schema hervat', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setManual(19, 'manual');
  assert.equal(c.status.override.until, null);
  assert.equal(c.status.modeLabel, 'Handmatig, tot je het schema hervat');
  sim.now = at('23:00', 5);
  await c.tick();
  assert.equal(sim.target, 19, 'schemablokken overschrijven de stand niet');
  await c.clearOverride();
  assert.equal(sim.target, 16);
});

test('duur van een lopende handmatige stand aanpassen', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setManual(22);
  assert.match(c.status.modeLabel, /tot 22:30$/);
  sim.now = at('12:10');
  await c.setOverrideDuration(60);
  assert.match(c.status.modeLabel, /tot 13:10$/);
  assert.equal(sim.target, 22);
  // Nog eens + drukken houdt de gekozen eindtijd vast.
  await c.setManual(22.5);
  assert.match(c.status.modeLabel, /tot 13:10$/);
  await c.setOverrideDuration('next');
  assert.match(c.status.modeLabel, /tot 22:30$/);
});

test('standaardduur uit de instellingen geldt ook voor draaien aan de knop', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, config: { overrideDefault: 120 } });
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20, store });
  await c.tick();
  sim.target = 21; // iemand draait aan de knop
  sim.now = at('12:01');
  await c.tick();
  assert.match(c.status.modeLabel, /^Handmatig tot 14:01$/);
  await c.setManual(21.5); // via widget, loopt al: zelfde eindtijd
  assert.match(c.status.modeLabel, /tot 14:01$/);
  await c.clearOverride();
  await c.setManual(22); // nieuwe stand: standaard 2 uur
  assert.match(c.status.modeLabel, /tot 14:01$/);
});

test('status meldt of de thermostaat de nieuwe temperatuur heeft bevestigd', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  assert.equal(c.status.targetConfirmed, true);
  const realWrite = c.io.writeTarget;
  c.io.writeTarget = async () => {}; // thermostaat neemt het nog niet over
  await c.setManual(21);
  assert.equal(c.status.thermostatTarget, 21);
  assert.equal(c.status.targetConfirmed, false);
  c.io.writeTarget = realWrite;
  sim.target = 21; // nu wel overgenomen
  sim.now = at('12:00') + 5000;
  await c.tick();
  assert.equal(c.status.targetConfirmed, true);
});

test('nieuwe installatie: eerst stil, pas na Start volgt de thermostaat het schema', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 15, store: memoryStore({ schedule: SCHEDULE }) });
  await c.tick();
  assert.equal(c.status.mode, 'setup');
  assert.equal(c.status.setupDone, false);
  assert.equal(sim.target, 15); // niets aangeraakt
  await c.setEnabled(true); // 'Start slim verwarmen'
  assert.equal(c.status.setupDone, true);
  assert.notEqual(c.status.mode, 'setup');
  assert.notEqual(sim.target, 15); // volgt nu het schema
});

test('tegel op de instellingenpagina is gelijk aan de widget', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..');
  const a = fs.readFileSync(path.join(root, 'widgets/verwarming/public/index.html'), 'utf8');
  const b = fs.readFileSync(path.join(root, 'settings/tile.html'), 'utf8');
  assert.equal(b, a, 'voer node dev/sync-tile.js uit');
});

test('aanwezigheid: alleen een echte wissel telt, uitgeschakelde gebruikers niet', () => {
  const { presenceOf, PresenceWatcher } = require('../lib/presence');
  const users = {
    a: { name: 'Leroy', present: false, enabled: true },
    b: { name: 'Marleen', present: true, enabled: true },
    c: { name: 'Gast', present: true, enabled: false },
  };
  assert.deepEqual(presenceOf(users), { anyHome: true, home: ['Marleen'], count: 2 });
  const w = new PresenceWatcher();
  assert.equal(w.update(true), null); // opstarten: alleen beginstand
  assert.equal(w.update(true), null);
  assert.equal(w.update(false), 'away'); // laatste vertrekt
  assert.equal(w.update(false), null);
  assert.equal(w.update(true), 'home'); // eerste komt thuis
});

test('trage thermostaat na Hervat schema wordt niet als handmatig gezien', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 19.5 });
  await c.tick();
  await c.setManual(22);
  sim.now += 60000; await c.tick();
  // Thermostaat neemt een nieuwe waarde pas na 2 minuten over.
  c.io.writeTarget = async (t) => { const at0 = sim.now; sim.writes.push({ t, at: at0 }); sim.later = { t, at: at0 + 120000 }; };
  await c.clearOverride();
  assert.equal(c.status.mode, 'schedule');
  for (let i = 0; i < 4; i++) {
    sim.now += 30000;
    if (sim.later && sim.now >= sim.later.at) { sim.target = sim.later.t; sim.later = null; }
    await c.tick();
    assert.equal(c.status.mode, 'schedule', `na ${(i + 1) * 30} s`);
  }
  assert.equal(sim.target, 20);
});

test('trage thermostaat zet een handmatige wijziging niet terug', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 19.5 });
  await c.tick();
  // Thermostaat neemt een nieuwe waarde pas na 2 minuten over.
  c.io.writeTarget = async (t) => { sim.writes.push({ t, at: sim.now }); sim.later = { t, at: sim.now + 120000 }; };
  await c.setManual(21.5, 60);
  for (let i = 0; i < 6; i++) {
    sim.now += 30000;
    if (sim.later && sim.now >= sim.later.at) { sim.target = sim.later.t; sim.later = null; }
    await c.tick();
    assert.equal(c.status.mode, 'manual');
    assert.equal(c.state.override.temp, 21.5, `na ${(i + 1) * 30} s`);
    assert.equal(c.status.thermostatTarget, 21.5);
  }
});

test('scripts van widget en instellingenpagina zijn geldige JavaScript', () => {
  const fs = require('fs'); const path = require('path'); const vm = require('vm');
  const root = path.join(__dirname, '..');
  for (const f of ['widgets/verwarming/public/index.html', 'settings/index.html']) {
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, `${f}: geen script gevonden`);
    // Alleen inlezen (niet uitvoeren): een tikfout laat de hele pagina hangen op 'laden'.
    scripts.forEach((code) => assert.doesNotThrow(() => new vm.Script(code, { filename: f }), `${f} bevat een syntaxfout`));
  }
});

test('verbruik per dag uit een oplopende meterstand, met kosten', () => {
  const { usageOf, unitOf } = require('../lib/usage');
  const rows = [[1, 1000.0], [2, 1000.4], [3, 1001.1], [4, 1002.3]];
  assert.deepEqual(usageOf(rows, 'meter_gas', 1.5), { amount: 2.3, unit: 'm³', price: 1.5, cost: 3.45 });
  assert.equal(unitOf('meter_power'), 'kWh');
  // Meter teruggezet halverwege: de daling telt niet mee.
  assert.equal(usageOf([[1, 50], [2, 51], [3, 0.2], [4, 1.2]], 'meter_gas', 1).amount, 2);
  assert.equal(usageOf([[1, 5]], 'meter_gas', 1), null); // te weinig gegevens
  assert.equal(usageOf(rows, 'meter_power').price, 0.3); // geen prijs: standaard
});

test('maximumtemperatuur begrenst schema, widget en draaien aan de knop', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, config: { limit: true, maxTemp: 19 } });
  const { c, sim, events } = setup({ now: at('12:00'), target: 16, indoor: 17, store });
  await c.tick();
  assert.equal(sim.target, 19); // schema zegt 20, maximum 19
  await c.setManual(23);
  assert.equal(sim.target, 19); // widget: niet hoger dan het maximum
  assert.equal(c.status.maxTemp, 19);
  // Iemand draait aan de knop naar 22: na de wachttijd terug naar 19, handmatige stand blijft.
  sim.now += 60000; sim.target = 22; await c.tick();
  assert.equal(sim.target, 19);
  assert.equal(c.state.override.temp, 19);
  // Melding voor de tijdlijn: van welke waarde naar het maximum.
  assert.ok(events.some((e) => e.e === 'setpoint_changed' && e.d.reason === 'limit' && e.d.from === 22 && e.d.temp === 19));
  // Maximum uit: dan geldt het schema weer gewoon.
  store.set('config', { limit: false, maxTemp: 19 });
  await c.clearOverride();
  assert.equal(sim.target, 20);
});

test('schema: geen Klaar-knop, een tik buiten het schema klapt het open blok in', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'settings/index.html'), 'utf8');
  assert.ok(!html.includes('>Klaar</button>'), 'Klaar-knop hoort weg te zijn');
  // Pad van het tikmoment gebruiken: e.target.closest() faalt omdat het schema intussen opnieuw getekend is.
  assert.ok(html.includes("e.composedPath().some((n) => n.id === 'week' || n.id === 'savebar' || n.id === 'haptic')"), 'tik buiten het schema klapt in, maar het trilklikje niet');
  assert.ok(html.includes("l.id = 'haptic'"), 'trilklikje heeft id haptic');
  assert.ok(!html.includes("e.target.closest('#week, #savebar')"), 'niet e.target.closest gebruiken voor buiten-tik');
  assert.ok(html.includes('<button class="up" data-slot="${id}"'), 'pijltje omhoog naast Verwijderen klapt in');
});

test('verbruik in Terugkijken heeft een i-knopje met uitleg over de meter van het hele huis', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings/index.html'), 'utf8');
  assert.ok(html.includes('<button class="ucost" data-info="usage"'), 'het hele bedrag is aantikbaar');
  assert.ok(html.includes('.ucost[aria-expanded="true"] .info { color: var(--link); }'), 'open: i-tje in selectiekleur');
  assert.ok(html.includes('id="usageNote"'), 'plek voor de uitleg');
  assert.ok(/Douchen, koken op gas en de verwarming in andere kamers/.test(html), 'gas: ook douchen en koken tellen mee');
  assert.ok(/zonder vaste kosten/.test(html), 'vaste kosten niet meegeteld');
  // Specifiek genoeg om van de algemene i-regel (16px) te winnen.
  assert.ok(html.includes('#sv .hsum .ucost .info svg { width: 9px; height: 9px;'), 'i-tje bij de kosten is 9px');
  // INFO_ICON moet boven het eerste gebruik staan (anders een fout bij het laden).
  assert.ok(html.indexOf('const INFO_ICON') < html.indexOf('${INFO_ICON}'));
});

test('Herstel klapt alleen het open tijdsblok in, niet de dagen', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings/index.html'), 'utf8');
  const line = html.split('\n').find((l) => l.includes("$('undo').addEventListener"));
  assert.ok(line && line.includes('editing = null'), 'open tijdsblok klapt in');
  assert.ok(!line.includes('open.clear()'), 'open dagen blijven open');
});

test('widget: kosten hebben een klein i-tje met een kort ballonnetje', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'widgets/verwarming/public/index.html'), 'utf8');
  assert.ok(html.includes('data-costinfo'), 'kosten zijn aantikbaar');
  assert.ok(html.includes('Gas van het hele huis, dus ook douchen en koken. Zonder vaste kosten.'));
  assert.ok(/button\.cost \.ci \{ width: 10px; height: 10px;/.test(html), 'i-tje is heel klein');
  // Variabelen staan boven de functie die ze gebruikt (anders fout bij het laden).
  assert.ok(html.indexOf('let costInfo') < html.indexOf('function chartPage'));
  assert.ok(html.indexOf('const INFO_ICON') < html.indexOf('function chartPage'));
});

// Draait het widgetscript echt (met een nep-DOM) en tekent de grafiekkaart met een open kosten-ballonnetje.
// Vangt fouten die pas bij het uitvoeren optreden, zoals een variabele buiten zijn blok (ReferenceError).
test('widget: grafiekkaart met kosten en ballonnetje tekent zonder fouten', () => {
  const fs = require('fs'); const path = require('path'); const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'widgets/verwarming/public/index.html'), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const rect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 });
  const el = () => new Proxy(function stub() {}, {
    get: (t, k) => {
      if (k === 'offsetWidth' || k === 'offsetHeight') return 300;
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'getBoundingClientRect') return rect;
      return k in t ? t[k] : el();
    },
    set: (t, k, v) => { t[k] = v; return true; },
    apply: () => el(),
  });
  const mm = () => ({ matches: false, addEventListener() {} });
  const doc = { querySelector: () => el(), querySelectorAll: () => [], getElementById: () => el(), addEventListener() {}, createElement: () => el(), body: el(), documentElement: el() };
  const ctx = vm.createContext({ document: doc, window: { addEventListener() {}, matchMedia: mm, location: { search: '' } }, location: { search: '' }, navigator: {}, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, matchMedia: mm, URLSearchParams, Date, Math, JSON });
  vm.runInContext(code, ctx);
  const now = Date.now(); const start = now - 12 * 3600e3;
  ctx.sample = { day: 'x', start, end: start + 24 * 3600e3, now, indoor: [[start, 17], [now, 18]], target: [[start, 17]], humidity: [], outdoor: [], modes: [], usage: { amount: 2.3, unit: 'm³', price: 1.4, cost: 3.22 } };
  vm.runInContext("hist = sample; costInfo = true; globalThis.p1 = document.querySelector('.p1'); chartPage(p1, document.querySelector('.p0'));", ctx);
  assert.ok(String(ctx.p1.innerHTML).includes('cpop'), 'ballonnetje getekend');
});
