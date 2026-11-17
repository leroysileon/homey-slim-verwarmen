'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Measurements, series, mergeSeries, STEP } = require('../lib/measurements');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'metingen-'));
const make = (dir, keepDays) => new Measurements({ dir, timeZone: () => 'Europe/Amsterdam', keepDays });
const T0 = Date.UTC(2026, 10, 14, 7, 0); // za 14 nov 08:00 Amsterdam

test('meetlog: één regel per 5 minuten, gemiddelde binnen, laatste doel', async () => {
  const m = make(tmp());
  m.add(T0, { indoor: 15, target: 19.5, humidity: 60, outdoor: 4, mode: 'schedule' });
  m.add(T0 + 60000, { indoor: 15.4, target: 19.5, humidity: 62, outdoor: 4, mode: 'manual' });
  m.add(T0 + STEP, { indoor: 16, target: 20, humidity: 61, outdoor: 4.2, mode: 'manual' });
  const rows = await m.range(T0, T0 + 3600000);
  assert.deepEqual(rows, [[T0, 15.2, 19.5, 61, 4, 'manual'], [T0 + STEP, 16, 20, 61, 4.2, 'manual']]);
});

test('meetlog: blijft bewaard na herstart en vult een bestaand dagbestand aan', async () => {
  const dir = tmp();
  const a = make(dir);
  a.add(T0, { indoor: 15, target: 19.5 }); a.close(); await a.flush();
  const b = make(dir); // herstart: dagbestand nog niet ingelezen
  b.add(T0 + STEP, { indoor: 16, target: 19.5 }); b.close(); await b.flush();
  const c = make(dir);
  assert.deepEqual((await c.range(T0 - 3600000, T0 + 3600000)).map((r) => r[1]), [15, 16]);
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-14.json']);
});

test('meetlog: oude dagen worden opgeruimd', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2020-01-01.json'), '{"rows":[]}');
  const m = make(dir, 730);
  m.add(Date.now(), { indoor: 18 }); m.close(); await m.flush();
  assert.ok(!fs.existsSync(path.join(dir, '2020-01-01.json')));
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('mergeSeries: eigen log gaat voor, Inzichten vult de rest aan', () => {
  const H = 3600000;
  const own = series([[10 * H, 18, 19.5], [10 * H + STEP, 18.1, 19.5], [10 * H + 2 * STEP, 18.2, 19.5]], 'indoor');
  const ins = [[8 * H, 15], [9 * H, 16.5], [10 * H, 99], [11 * H, 19]];
  assert.deepEqual(mergeSeries(own, ins).map((r) => r[1]), [15, 16.5, 18, 18.1, 18.2, 19]);
  assert.deepEqual(mergeSeries([], ins), ins);
});
