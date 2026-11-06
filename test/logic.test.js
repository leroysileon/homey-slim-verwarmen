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
