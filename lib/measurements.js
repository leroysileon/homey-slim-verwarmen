'use strict';

/**
 * Eigen meetlog: elke 5 minuten één regel met binnen- en doeltemperatuur, luchtvochtigheid, buiten en de stand.
 * Homey Inzichten geeft voor oudere dagen maar één waarde per uur en bewaart niet alles even lang; dit log wel.
 * Eén bestand per dag (lokale datum) in /userdata, standaard 2 jaar bewaard (± 10 kB per dag).
 *
 * Regel: [t, binnen, doel, vocht, buiten, stand]. t = begin van het 5-minutenvak (ms).
 * Binnen, vocht en buiten zijn het gemiddelde van de metingen in dat vak, doel en stand de laatste waarde.
 */

const STEP = 5 * 60 * 1000;
const COLS = ['t', 'indoor', 'target', 'humidity', 'outdoor', 'mode'];

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

class Measurements {
  constructor({ dir, timeZone, keepDays = 730, fs = require('fs'), path = require('path') }) {
    this.dir = dir;
    this.timeZone = timeZone; // functie: tijdzone kan na het starten nog veranderen
    this.keepDays = keepDays;
    this.fs = fs.promises;
    this.path = path;
    this.days = new Map(); // dag -> regels (in het geheugen, bijgewerkt)
    this.dirty = new Set();
    this.loaded = new Set(); // dagen waarvan het bestand al is ingelezen
    this.slot = null; // lopend vak: { t, n: {…}, sum: {…}, target, mode }
    this.writing = null;
  }

  /** Lokale datum 'YYYY-MM-DD' van een tijdstip. */
  dayKey(t) {
    return new Date(t).toLocaleDateString('en-CA', { timeZone: this.timeZone() });
  }

  file(key) {
    return this.path.join(this.dir, `${key}.json`);
  }

  /** Eén meting toevoegen (elke regelronde, ± elke minuut). */
  add(now, { indoor, target, humidity, outdoor, mode } = {}) {
    const t = Math.floor(now / STEP) * STEP;
    if (this.slot && this.slot.t !== t) this.close();
    if (!this.slot) this.slot = { t, sum: { indoor: 0, humidity: 0, outdoor: 0 }, n: { indoor: 0, humidity: 0, outdoor: 0 }, target: null, mode: null };
    const s = this.slot;
    [['indoor', indoor], ['humidity', humidity], ['outdoor', outdoor]].forEach(([k, v]) => {
      if (Number.isFinite(v)) { s.sum[k] += v; s.n[k]++; }
    });
    if (Number.isFinite(target)) s.target = target;
    if (mode) s.mode = mode;
  }

  /** Regel van het lopende vak (null als er nog niets in zit). */
  slotRow() {
    const s = this.slot; if (!s) return null;
    const avg = (k) => (s.n[k] ? s.sum[k] / s.n[k] : null);
    const row = [s.t, r1(avg('indoor')), s.target, avg('humidity') == null ? null : Math.round(avg('humidity')), r1(avg('outdoor')), s.mode];
    return row.slice(1).some((v) => v != null) ? row : null;
  }

  /** Lopend vak afsluiten en bij de dag zetten. */
  close() {
    const row = this.slotRow(); this.slot = null;
    if (!row) return;
    const key = this.dayKey(row[0]);
    const rows = this.days.get(key) || [];
    if (!this.days.has(key)) this.days.set(key, rows);
    rows.push(row);
    this.dirty.add(key);
  }

  async load(key) {
    if (this.loaded.has(key)) return this.days.get(key);
    let rows = [];
    try {
      const d = JSON.parse(await this.fs.readFile(this.file(key), 'utf8'));
      if (Array.isArray(d.rows)) rows = d.rows;
    } catch (err) { /* nog geen bestand voor die dag */ }
    // Tussendoor in het geheugen gezet (vóór het laden)? Samenvoegen, op tijd en zonder dubbelen.
    const mem = this.days.get(key);
    if (mem) { const seen = new Set(rows.map((r) => r[0])); mem.forEach((r) => { if (!seen.has(r[0])) rows.push(r); }); rows.sort((a, b) => a[0] - b[0]); }
    this.days.set(key, rows); this.loaded.add(key);
    return rows;
  }

  /** Gewijzigde dagen wegschrijven (± elk half uur en bij afsluiten). Eerst een tijdelijk bestand: nooit half geschreven. */
  async flush() {
    if (this.writing) return this.writing;
    this.writing = (async () => {
      await this.fs.mkdir(this.dir, { recursive: true });
      for (const key of [...this.dirty]) {
        this.dirty.delete(key);
        const rows = await this.load(key); // bestaand bestand eerst inlezen (na een herstart), dan aanvullen
        const tmp = `${this.file(key)}.tmp`;
        await this.fs.writeFile(tmp, JSON.stringify({ v: 1, step: STEP, cols: COLS, rows }));
        await this.fs.rename(tmp, this.file(key));
      }
      // Alleen vandaag en gisteren in het geheugen houden.
      const keep = new Set([this.dayKey(Date.now()), this.dayKey(Date.now() - 86400000)]);
      [...this.days.keys()].forEach((k) => { if (!keep.has(k) && !this.dirty.has(k)) { this.days.delete(k); this.loaded.delete(k); } });
      await this.prune();
    })().finally(() => { this.writing = null; });
    return this.writing;
  }

  /** Bestanden ouder dan keepDays weg. */
  async prune() {
    const oldest = this.dayKey(Date.now() - this.keepDays * 86400000);
    const names = await this.fs.readdir(this.dir).catch(() => []);
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n);
      if (m && m[1] < oldest) await this.fs.unlink(this.path.join(this.dir, n)).catch(() => {});
    }
  }

  /** Alle regels met start <= t < end, inclusief het lopende vak. */
  async range(start, end) {
    const keys = new Set();
    for (let t = start; t < end; t += 6 * 3600000) keys.add(this.dayKey(t));
    keys.add(this.dayKey(end - 1));
    const out = [];
    for (const k of keys) (await this.load(k)).forEach((r) => { if (r[0] >= start && r[0] < end) out.push(r); });
    const cur = this.slotRow();
    if (cur && cur[0] >= start && cur[0] < end && !out.some((r) => r[0] === cur[0])) out.push(cur);
    return out.sort((a, b) => a[0] - b[0]);
  }

  /** Welke dagen er zijn (oudste eerst). */
  async list() {
    const names = await this.fs.readdir(this.dir).catch(() => []);
    const keys = new Set(names.map((n) => (/^(\d{4}-\d{2}-\d{2})\.json$/.exec(n) || [])[1]).filter(Boolean));
    this.days.forEach((rows, k) => { if (rows.length) keys.add(k); });
    return [...keys].sort();
  }
}

/** Kolom uit de regels als [[t, v], …] (lege waarden overgeslagen). */
function series(rows, col) {
  const i = COLS.indexOf(col);
  return rows.filter((r) => r[i] != null).map((r) => [r[0], r[i]]);
}

/**
 * Eigen reeks aanvullen met een andere (Homey Inzichten): waar het eigen log metingen heeft, telt alleen het eigen log.
 * Een stuk eigen log loopt door zolang er hooguit 15 minuten tussen twee regels zit.
 */
function mergeSeries(own, other, gap = 3 * STEP) {
  if (!own.length) return other;
  const runs = [];
  own.forEach(([t]) => { const last = runs[runs.length - 1]; if (last && t - last[1] <= gap) last[1] = t; else runs.push([t, t]); });
  const covered = (t) => runs.some(([a, b]) => t >= a - STEP && t <= b + STEP);
  return [...own, ...other.filter(([t]) => !covered(t))].sort((a, b) => a[0] - b[0]);
}

module.exports = { Measurements, series, mergeSeries, STEP, COLS };
