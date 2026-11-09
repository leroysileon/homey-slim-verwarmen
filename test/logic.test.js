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

test('handmatig voor een half uur', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setManual(22);
  await c.setOverrideDuration(30);
  assert.match(c.status.modeLabel, /tot 12:30$/);
  sim.now = at('12:31');
  await c.tick();
  assert.equal(c.state.override, null);
  assert.equal(sim.target, 20);
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
  assert.ok(html.includes('#sv .hsum .ucost .info svg { width: 11px; height: 11px;'), 'i-tje bij de kosten is 11px');
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

test('tegel in de instellingen gebruikt hetzelfde kleurschema (geen wit vlak op desktop)', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'widgets/verwarming/public/index.html'), 'utf8');
  assert.ok(html.includes("if (IN_SETTINGS) document.documentElement.style.colorScheme = 'light dark';"));
  // Laadbeeld in de instellingen = knoppen i.p.v. dagbalk, en dezelfde schaduwruimte als fitHeight.
  assert.ok(html.includes('<div class="acts"><span class="sk ab"></span><span class="sk ab"></span></div>'));
  assert.ok(html.includes('lastHeight = sk ? sk + 6 : lastHeight;'));
  const settings = fs.readFileSync(path.join(__dirname, '..', 'settings/index.html'), 'utf8');
  assert.ok(settings.includes('#tileframe { display: block; width: 100%; height: 242px;'), 'start op de hoogte van de geladen tegel');
});

test('widget: horizontaal vegen wordt bij de eerste beweging geclaimd (Android)', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'widgets/verwarming/public/index.html'), 'utf8');
  assert.ok(html.includes('  if (!drag.mode && Math.abs(dx) >= Math.abs(dy) && e.cancelable) e.preventDefault();'), 'niet alleen op de grafiek');
  assert.ok(!html.includes('if (drag.onChart && !drag.mode && Math.abs(dx) >= Math.abs(dy)'), 'oude, alleen-grafiek-regel is weg');
});

test('learner: één meting verwijderen, de rest blijft', () => {
  const samples = [
    { at: 1, rate: 1, deadTime: 10, outdoor: 5 },
    { at: 2, rate: 9, deadTime: 60, outdoor: 5 }, // uitschieter
    { at: 3, rate: 1.2, deadTime: 12, outdoor: 5 },
  ];
  const l = new Learner({ samples: samples.map((x) => ({ ...x })) });
  assert.equal(l.remove(2), true);
  assert.deepEqual(l.samples.map((x) => x.at), [1, 3]);
  assert.equal(l.remove(42), false, 'onbekende meting: niets veranderd');
  assert.equal(l.samples.length, 2);
});

test('learner: een mislukte meting (raam open) telt niet mee', () => {
  const ok = [1.0, 1.1, 0.9, 1.05, 0.95, 1.0].map((rate, i) => ({ at: i + 1, rate, deadTime: 12 + i, outdoor: 5 }));
  const bad = { at: 99, rate: 0.25, deadTime: 70, outdoor: 5 };
  const l = new Learner({ samples: [...ok, bad] });
  assert.deepEqual([...l.ignored()], [99]);
  assert.ok(Math.abs(l.rateAt(5) - 1.0) < 0.06, 'snelheid zonder de uitschieter');
  assert.ok(l.deadTime() < 20, 'opstarttijd zonder de uitschieter');
  // Gewone spreiding is geen fout.
  assert.equal(new Learner({ samples: ok }).ignored().size, 0);
  // Weinig metingen: nog niets negeren.
  assert.equal(new Learner({ samples: [ok[0], ok[1], bad] }).ignored().size, 0);
});

test('learner: één rare meting trekt de buitentemperatuur-lijn niet scheef', () => {
  // Echt verband: snelheid = 0,8 + 0,05 × buiten
  const s = [-2, 0, 2, 4, 6, 8, 10].map((x, i) => ({ at: i + 1, rate: 0.8 + 0.05 * x, deadTime: 15, outdoor: x }));
  s.push({ at: 50, rate: 3.5, deadTime: 15, outdoor: -2 }); // zon op de thermostaat
  const l = new Learner({ samples: s });
  assert.ok(Math.abs(l.rateAt(0) - 0.8) < 0.05, `verwacht ~0,8, kreeg ${l.rateAt(0)}`);
  assert.ok(Math.abs(l.rateAt(10) - 1.3) < 0.05);
});

test('learner: te laat warm = voortaan eerder beginnen', () => {
  const l = new Learner({ samples: [{ at: 1, rate: 1, deadTime: 15, outdoor: 5 }] });
  const before = l.preheatMinutes(17, 19, 5, 600); // (15 + 120) × 1,1
  assert.equal(before, 149);
  for (let i = 0; i < 3; i++) l.addTiming({ at: i, base: 135, need: 162, late: 13, temp: 19 }); // duurde 20% langer
  assert.equal(l.factor(), 1.2);
  assert.equal(l.preheatMinutes(17, 19, 5, 600), Math.round(135 * 1.2 * 1.05));
  assert.equal(l.lateness(), 13);
  // Te vroeg warm: korter voorverwarmen (scheelt stoken), maar nooit onder 70%.
  const e = new Learner({ samples: [{ at: 1, rate: 1, deadTime: 15, outdoor: 5 }] });
  for (let i = 0; i < 3; i++) e.addTiming({ at: i, base: 135, need: 60, late: -75, temp: 19 });
  assert.equal(e.factor(), 0.7);
  // Opslaan en weer laden houdt het vast.
  assert.equal(new Learner(JSON.parse(JSON.stringify(l.toJSON()))).factor(), 1.2);
});

test('op tijd warm: controller meet hoe laat het doel gehaald werd', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, learner: { samples: [{ at: 1, rate: 2, deadTime: 10, outdoor: 4 }] } });
  const { c, sim, events } = setup({ now: at('05:00'), target: 16, indoor: 18, outdoor: 4, store });
  // 18 -> 20 bij 2 °/u: 10 + 60 = 70 × 1,1 = 77 min -> begint 05:13
  await c.tick();
  sim.now = at('05:13'); await c.tick();
  assert.equal(c.status.mode, 'preheat');
  assert.ok(c.state.run, 'meting loopt');
  sim.now = at('06:00'); sim.indoor = 19; await c.tick();
  sim.now = at('06:30'); sim.indoor = 19.5; await c.tick(); // schema-moment, nog niet warm
  assert.ok(c.state.run);
  sim.now = at('06:45'); sim.indoor = 19.85; await c.tick(); // 15 min te laat
  const t = events.find((x) => x.e === 'timing');
  assert.ok(t, 'meting afgerond');
  assert.equal(t.d.late, 15);
  assert.equal(t.d.need, 92);
  assert.equal(c.state.run, null);
  assert.equal(c.status.learned.late, 15);
});

test('op tijd warm: handmatig ingrijpen = niets leren', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, learner: { samples: [{ at: 1, rate: 2, deadTime: 10, outdoor: 4 }] } });
  const { c, sim, events } = setup({ now: at('05:13'), target: 16, indoor: 18, outdoor: 4, store });
  await c.tick();
  assert.ok(c.state.run);
  await c.setManual(21);
  sim.now = at('06:40'); sim.indoor = 20; await c.tick();
  assert.equal(c.state.run, null);
  assert.ok(!events.some((x) => x.e === 'timing'));
});

test('raam open: snelle daling = vraag, kiezen = verwarming uit, daarna terug', async () => {
  const { c, sim, events } = setup({ now: at('12:00'), target: 20, indoor: 20.5 });
  await c.tick();
  sim.now = at('12:04'); sim.indoor = 20.3; await c.tick();
  assert.equal(c.status.windowAsk, null, 'kleine daling: niets');
  sim.now = at('12:08'); sim.indoor = 19.8; await c.tick();
  assert.ok(c.status.windowAsk, 'vraag in de widget');
  assert.ok(events.some((x) => x.e === 'window_open'));
  assert.equal(sim.target, 20, 'zonder keuze verandert er niets');
  await c.startWindow();
  assert.equal(sim.target, 5);
  assert.equal(c.status.mode, 'window');
  assert.equal(c.status.windowAsk, null);
  sim.now = at('12:20'); sim.indoor = 18; await c.tick();
  assert.equal(c.status.mode, 'window', 'geen handmatig: dit stelden we zelf in');
  sim.now = at('12:39'); await c.tick();
  assert.equal(sim.target, 20, 'na een half uur terug naar het schema');
  assert.equal(c.status.mode, 'schedule');
  sim.now = at('12:45'); sim.indoor = 19; await c.tick();
  assert.equal(c.status.windowAsk, null, 'na het luchten niet meteen opnieuw vragen');
});

test('raam open tijdens handmatige stand: daarna komt je eigen temperatuur terug', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 21 });
  await c.tick();
  await c.setManual(22, 'manual');
  await c.startWindow(10);
  assert.equal(sim.target, 5);
  sim.now = at('12:11'); await c.tick();
  assert.equal(sim.target, 22);
  assert.equal(c.status.mode, 'manual');
  assert.equal(c.state.override.temp, 22);
});

test('raam open: zelf aan de knop draaien beëindigt de raamstand', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 21 });
  await c.tick();
  await c.startWindow();
  sim.now = at('12:05'); sim.target = 21; await c.tick();
  assert.equal(c.status.mode, 'manual');
  assert.equal(sim.target, 21);
  // Negeren: een uur niet opnieuw vragen.
  const r = setup({ now: at('12:00'), target: 20, indoor: 21 });
  await r.c.tick();
  r.sim.now = at('12:05'); r.sim.indoor = 20.2; await r.c.tick();
  assert.ok(r.c.status.windowAsk);
  await r.c.ignoreWindow();
  r.sim.now = at('12:10'); r.sim.indoor = 19.4; await r.c.tick();
  assert.equal(r.c.status.windowAsk, null);
});

test('instellingenpagina en widget: elke id komt maar één keer voor', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['settings/index.html', 'widgets/verwarming/public/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"$]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dup, [], `${f}: dubbele id`);
  }
});

test('raam open: instelling kiest uit of de temperatuur van afwezig, of zet herkennen uit', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, config: { windowAction: 'eco', ecoTemp: 15 } });
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 21, store });
  await c.tick();
  await c.startWindow();
  assert.equal(sim.target, 15, 'naar de temperatuur van afwezig');
  assert.equal(c.status.windowTemp, 15);
  sim.now = at('12:10'); await c.tick();
  assert.equal(c.status.mode, 'window', 'eigen 15° telt niet als aan de knop draaien');
  // Herkennen uit: geen vraag bij een snelle daling.
  const off = setup({ now: at('12:00'), target: 20, indoor: 21, store: memoryStore({ schedule: SCHEDULE, state: {}, config: { windowDetect: false } }) });
  await off.c.tick();
  off.sim.now = at('12:05'); off.sim.indoor = 19.8; await off.c.tick();
  assert.equal(off.c.status.windowAsk, null);
  assert.ok(!off.c.state.windowAsk);
});

test('raam open: duur uit de instellingen, en leren van je keuzes', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, config: { windowMinutes: 10 } });
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 21, store });
  await c.tick();
  await c.startWindow();
  assert.equal(c.state.window.until - c.state.window.since, 10 * MIN);
  // Vaak negeren = pas bij een grotere daling vragen.
  const r = setup({ now: at('08:00'), target: 20, indoor: 21 });
  await r.c.tick();
  assert.equal(r.c.windowDrop(), 0.6);
  for (let i = 0; i < 3; i++) {
    r.sim.now += 2 * 3600000; r.sim.indoor = 21; await r.c.tick();
    r.sim.now += 5 * MIN; r.sim.indoor = 19.8; await r.c.tick(); // flink kouder: telt altijd
    assert.ok(r.c.state.windowAsk, `vraag ${i + 1}`);
    await r.c.ignoreWindow();
  }
  assert.equal(r.c.windowDrop(), 1.05);
  assert.equal(r.c.status.windowInfo.ignored, 3);
  r.sim.now += 2 * 3600000; r.sim.indoor = 21; await r.c.tick();
  r.sim.now += 5 * MIN; r.sim.indoor = 20.3; await r.c.tick();
  assert.equal(r.c.state.windowAsk, null, '0,7° is nu niet genoeg');
});

test('raam open: thermostaat met eigen detectie (tado) = onze detectie standaard uit, en niet tegenin sturen', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 21 });
  const read = c.io.readThermostat;
  let extra = { ownWindow: 'tado' };
  c.io.readThermostat = async () => ({ ...(await read()), ...extra });
  await c.tick();
  sim.now = at('12:05'); sim.indoor = 20.1; await c.tick();
  assert.equal(c.status.windowAsk, null, 'tado doet het zelf');
  assert.equal(c.status.windowInfo.on, false);
  // Zelf aangezet in de instellingen: dan wel.
  c.store.set('config', { windowDetect: true });
  sim.now = at('12:30'); sim.indoor = 21; await c.tick();
  sim.now = at('12:35'); sim.indoor = 20.2; await c.tick();
  assert.ok(c.status.windowAsk);
  // De thermostaat meldt zelf een open raam en zet zich laag: wij sturen niet terug en zien het niet als handmatig.
  extra = { ownWindow: 'tado', windowOpen: true };
  sim.target = 5; sim.now = at('12:40'); await c.tick();
  assert.equal(sim.target, 5);
  assert.equal(c.status.mode, 'deviceWindow');
  extra = { ownWindow: 'tado', windowOpen: false };
  sim.target = 20; sim.now = at('12:55'); await c.tick();
  assert.equal(c.status.mode, 'schedule', 'raam dicht: gewoon verder, geen handmatige stand');
  // De thermostaat meldt 'uit' (tado X doet dat ook bij een lage schematemperatuur): gewoon blijven regelen.
  extra = { mode: 'off' };
  sim.now = at('22:31'); await c.tick();
  assert.equal(sim.target, 16, 'schema gaat door');
  assert.notEqual(c.status.mode, 'deviceOff');
  await c.setManual(21);
  assert.equal(sim.target, 21, 'zelf een temperatuur kiezen werkt ook');
});

test('geen thermostaat gekozen: duidelijke melding, geen oude status', async () => {
  const store = memoryStore({ schedule: SCHEDULE, state: {}, config: { thermostatId: 'x' } });
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20, store });
  await c.tick();
  assert.equal(c.status.mode, 'schedule');
  c.io.readThermostat = async () => null; // thermostaat weg
  sim.now = at('12:05'); await c.tick();
  assert.equal(c.status.mode, 'nodevice');
  assert.equal(c.status.indoor, null, 'geen oude temperatuur meer tonen');
  assert.match(c.status.error, /reageert niet/);
  c.store.set('config', {}); // niets gekozen
  await c.tick();
  assert.match(c.status.error, /Kies een thermostaat/);
  assert.ok(c.status.learned, 'opwarmgegevens blijven zichtbaar');
});

test('instellingen: lege standen en verborgen delen hangen alleen af van wel/geen thermostaat', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  assert.match(html, /#sv\.nodev \[data-needdev\] \{ display: none !important; \}/);
  assert.match(html, /#sv:not\(\.nodev\) \[data-nodev\] \{ display: none !important; \}/);
});

test('handmatig: bron wordt onthouden (thermostaat, Homey, flow) en raam-einde meldt hoe lang', async () => {
  const { c, sim, events } = setup({ now: at('12:00'), target: 20, indoor: 21 });
  await c.tick();
  sim.now = at('12:05'); sim.target = 21.5; await c.tick(); // aan de knop
  await c.setManual(22); // widget
  await c.setManual(19, 60, 'flow');
  assert.deepEqual(c.changeLog.map((x) => [x.temp, x.via]), [[21.5, 'thermostat'], [22, 'app'], [19, 'flow']]);
  assert.equal(events.filter((x) => x.e === 'manual_change').length, 3);
  await c.clearOverride();
  await c.startWindow(10);
  sim.now = at('12:20'); await c.tick();
  const w = events.find((x) => x.e === 'window_closed');
  assert.ok(w && w.d.since && w.d.until > w.d.since, 'begin en einde voor de melding');
});

test('vakantie: temperatuur van afwezig tot de terugkomstdag, daarna weer het schema', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setVacation(at('00:00', 6)); // terug op vrijdag 6 nov
  assert.equal(sim.target, 16, 'eco');
  assert.equal(c.status.mode, 'vacation');
  sim.now = at('12:00', 5); await c.tick();
  assert.equal(sim.target, 16, 'nog op vakantie');
  // Iemand komt even thuis (thuis/afwezig): vakantie blijft.
  await c.setAway(false);
  assert.equal(c.status.mode, 'vacation');
  sim.now = at('00:05', 6); await c.tick();
  assert.equal(c.state.vacation, null, 'terugkomstdag: vakantie voorbij');
  assert.notEqual(c.status.mode, 'vacation');
  // Pauzeren stopt een vakantie.
  await c.setVacation(at('00:00', 10));
  await c.setEnabled(false);
  assert.equal(c.state.vacation, null);
  await assert.rejects(c.setVacation(at('00:00', 1)), /toekomst/);
});

test('geplande vakantie: tot de vertrekdag niets anders, dan vanzelf vakantie tot de terugkomdag', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setVacation(at('00:00', 9), at('00:00', 6)); // weg vanaf vrijdag 6, terug maandag 9
  assert.ok(c.state.vacationPlan, 'gepland');
  assert.equal(c.state.vacation, null);
  assert.notEqual(c.status.mode, 'vacation');
  assert.deepEqual(c.status.vacationPlan, { from: at('00:00', 6), until: at('00:00', 9) });
  sim.now = at('00:05', 6); await c.tick();
  assert.equal(c.status.mode, 'vacation', 'vertrekdag: vakantie gaat in');
  assert.equal(c.state.vacationPlan, null);
  assert.equal(sim.target, 16);
  sim.now = at('00:05', 9); await c.tick();
  assert.equal(c.state.vacation, null, 'terugkomdag: voorbij');
  // Plannen en annuleren; terug vóór vertrek kan niet.
  await c.setVacation(at('00:00', 14), at('00:00', 12));
  await c.stopVacation();
  assert.equal(c.state.vacationPlan, null);
  await assert.rejects(c.setVacation(at('00:00', 12), at('00:00', 12)), /na de vertrekdag/);
  // Vertrekdag vandaag (begin van de dag ligt al achter ons) = meteen vakantie.
  await c.setVacation(at('00:00', 14), at('00:00', 9));
  assert.equal(c.status.mode, 'vacation');
});

test('geplande vakantie uit- en weer aanzetten: datums blijven, uit = gaat niet in', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setVacation(at('00:00', 9), at('00:00', 6));
  await c.setVacationPlanOn(false);
  assert.deepEqual(c.status.vacationPlan, { from: at('00:00', 6), until: at('00:00', 9), off: true }, 'uit, datums bewaard');
  sim.now = at('00:05', 6); await c.tick();
  assert.notEqual(c.status.mode, 'vacation', 'uit: gaat niet in op de vertrekdag');
  assert.ok(c.state.vacationPlan, 'maar blijft bewaard');
  await c.setVacationPlanOn(true);
  assert.equal(c.status.mode, 'vacation', 'weer aan na de vertrekdag: meteen vakantie');
  assert.equal(c.state.vacation.until, at('00:00', 9));
  // Uit laten staan tot na de terugkomdag: opgeruimd.
  await c.stopVacation();
  await c.setVacation(at('00:00', 14), at('00:00', 12)); await c.setVacationPlanOn(false);
  sim.now = at('00:05', 14); await c.tick();
  assert.equal(c.state.vacationPlan, null);
});

test('lopende vakantie: vertrek verzetten naar later = nu stoppen en opnieuw plannen', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setVacation(at('00:00', 9));
  assert.equal(c.status.mode, 'vacation');
  await c.setVacation(at('00:00', 12), at('09:00', 10)); // toch pas woensdag weg
  assert.equal(c.state.vacation, null, 'lopende vakantie gestopt');
  assert.deepEqual(c.status.vacationPlan, { from: at('09:00', 10), until: at('00:00', 12) });
  assert.notEqual(c.status.mode, 'vacation');
  sim.now = at('09:05', 10); await c.tick();
  assert.equal(c.status.mode, 'vacation', 'nieuwe vertrekdag: weer vakantie');
});

test('vakantie mag zo lang duren als je wilt (lopend en gepland)', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setVacation(sim.now + 300 * 86400000);
  assert.equal(c.state.vacation.until, sim.now + 300 * 86400000, 'niet afgekapt');
  await c.stopVacation();
  const from = sim.now + 10 * 86400000;
  await c.setVacation(from + 250 * 86400000, from);
  assert.equal(c.state.vacationPlan.until, from + 250 * 86400000);
});

test('afwezig, pauzeren en vakantie sluiten elkaar uit', async () => {
  const { c, sim } = setup({ now: at('12:00'), target: 20, indoor: 20 });
  await c.tick();
  await c.setEnabled(false); // pauze
  await c.setAway(true); // thuis/afwezig-detectie: pauze blijft
  assert.equal(c.state.enabled, false);
  await c.setAway(true, true); // zelf gekozen: pauze uit, afwezig aan
  assert.equal(c.state.enabled, true);
  assert.equal(c.status.mode, 'away');
  assert.equal(sim.target, 16);
  await c.setVacation(at('00:00', 7)); // vakantie vervangt afwezig
  assert.equal(c.state.away, false);
  assert.equal(c.status.mode, 'vacation');
  await c.setAway(true, true); // afwezig vervangt vakantie
  assert.equal(c.state.vacation, null);
  await c.setEnabled(false); // pauze zet afwezig uit
  assert.equal(c.state.away, false);
});

test('tidyLog: na de laatste handmatige stand wordt alles schema', () => {
  const { c } = setup({ now: at('12:00') });
  c.modeLog = [{ t: 0, m: 'schedule' }, { t: 100, m: 'manual' }, { t: 200, m: 'schedule' }, { t: 210, m: 'away' }, { t: 220, m: 'paused' }, { t: 230, m: 'vacation' }];
  assert.strictEqual(c.tidyLog(50), 3);
  assert.deepStrictEqual(c.modeLog, [{ t: 0, m: 'schedule' }, { t: 100, m: 'manual' }, { t: 200, m: 'schedule' }]);
});

test('quickStatus: nieuwe stand meteen zichtbaar, ook als de thermostaat nog niet klaar is', async () => {
  const { c, sim } = setup({ now: at('12:00') });
  await c.tick();
  c.io.writeTarget = () => new Promise(() => {}); // trage thermostaat: schrijven komt nooit terug
  c.setVacation(sim.now + 3 * 86400000);
  const s = c.quickStatus();
  assert.equal(s.mode, 'vacation');
  assert.equal(s.targetConfirmed, false);
});

test('pauzeren en hervatten laat een lopende handmatige stand staan', async () => {
  const { c, sim } = setup({ now: at('22:57'), target: 15, indoor: 19 });
  await c.tick();
  await c.setManual(20, 60, 'widget'); // tot 23:57
  assert.equal(sim.target, 20);
  sim.now = at('23:13'); await c.setEnabled(false); // pauze
  assert.equal(c.status.mode, 'paused');
  sim.now = at('23:14'); await c.setEnabled(true); // hervat
  assert.equal(c.status.mode, 'manual');
  assert.equal(sim.target, 20);
  sim.now = at('23:58'); await c.tick(); // eindtijd voorbij: terug naar het schema
  assert.notEqual(c.status.mode, 'manual');
});

test('hervatten na de eindtijd van de handmatige stand: gewoon het schema', async () => {
  const { c, sim } = setup({ now: at('22:57'), target: 15, indoor: 19 });
  await c.tick();
  await c.setManual(20, 60, 'widget');
  await c.setEnabled(false);
  sim.now = at('23:59'); await c.setEnabled(true);
  assert.equal(c.state.override, null);
});
