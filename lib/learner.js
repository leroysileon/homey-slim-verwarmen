'use strict';

/**
 * Leert hoe snel het huis opwarmt.
 *
 * Per opwarmsessie meten we:
 *  - dode tijd: minuten tussen "thermostaat omhoog" en "temperatuur begint te stijgen"
 *  - opwarmsnelheid: °C per uur zodra de temperatuur stijgt
 * samen met de buitentemperatuur op dat moment. Met genoeg spreiding in
 * buitentemperatuur fitten we snelheid = a + b * buiten (kouder = trager).
 */

const DEFAULTS = {
  rate: 1.0, // °C per uur, voorzichtige startwaarde
  deadTime: 15, // minuten
  minRate: 0.2,
  maxRate: 6,
  maxSamples: 40,
};

const RISE_THRESHOLD = 0.2; // °C stijging = CV is echt aan het werk
const MIN_SESSION_RISE = 0.5; // te kleine sessies zijn te ruizig
const MIN_RISING_MINUTES = 10;
const MIN_PARTIAL_MINUTES = 20; // onderbroken sessie: langer gemeten stijging nodig om mee te tellen
const START_GAP = 0.8; // °C: zo ver onder de ingestelde temperatuur begint een meting
const MAX_SESSION_MINUTES = 8 * 60;
const MAX_TIMING = 20; // zoveel 'was het op tijd warm?'-metingen onthouden
const TIMING_MIN = 3; // vanaf zoveel metingen de voorverwarmtijd bijsturen

/** Theil-Sen: mediaan van alle hellingen tussen twee punten. Eén rare meting trekt de lijn niet scheef. */
function robustLine(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (Math.abs(dx) >= 1) slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  if (!slopes.length) return null;
  const b = Math.max(0, median(slopes)); // kouder buiten mag nooit snéller opwarmen: helling minstens 0
  const a = median(points.map((p) => p.y - b * p.x));
  return { a, b };
}

/** Mediaan van de afwijkingen (MAD), omgerekend naar iets wat op een standaardafwijking lijkt. */
function spreadOf(values) {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

class Learner {
  constructor(data = {}) {
    this.samples = Array.isArray(data.samples) ? data.samples : [];
    this.session = data.session || null;
    // Per voorverwarmmoment: hoeveel minuten nodig waren (need) tegenover wat het model vooraf dacht (base),
    // en hoeveel te laat (+) of te vroeg (−) het warm was. Hiermee stuurt de app de voorverwarmtijd bij.
    this.timing = Array.isArray(data.timing) ? data.timing : [];
  }

  toJSON() {
    return { samples: this.samples, session: this.session, timing: this.timing };
  }

  reset() {
    this.samples = [];
    this.session = null;
    this.timing = [];
  }

  /**
   * Metingen die zo ver van de rest afwijken dat ze waarschijnlijk mislukt zijn (raam open, ketel in storing,
   * zon op de thermostaat). Die tellen niet mee. Pas vanaf 5 metingen, en nooit meer dan een derde.
   */
  ignored() {
    const all = this.samples;
    if (all.length < 5) return new Set();
    const line = this.line(all);
    const expect = (s) => (line && Number.isFinite(s.outdoor) ? line.a + line.b * s.outdoor : median(all.map((x) => x.rate)));
    const res = all.map((s) => s.rate - expect(s));
    const resMid = median(res);
    const resSpread = spreadOf(res);
    const dts = all.map((s) => s.deadTime);
    const dtMid = median(dts);
    const dtSpread = spreadOf(dts);
    const scored = all.map((s, i) => {
      // Ruime ondergrens: bij metingen die heel dicht bij elkaar liggen is een kleine afwijking geen fout.
      const rateScore = Math.abs(res[i] - resMid) / Math.max(3 * resSpread, 0.4 * Math.max(0.3, expect(s)));
      const dtScore = Math.abs(s.deadTime - dtMid) / Math.max(3 * dtSpread, 20);
      return { at: s.at, score: Math.max(rateScore, dtScore) };
    }).filter((x) => x.score > 1).sort((a, b) => b.score - a.score);
    return new Set(scored.slice(0, Math.floor(all.length / 3)).map((x) => x.at));
  }

  /** Metingen die meetellen. */
  used() {
    const skip = this.ignored();
    return skip.size ? this.samples.filter((s) => !skip.has(s.at)) : this.samples;
  }

  /** Lijn snelheid = a + b × buiten, als er genoeg metingen met genoeg verschil in buitentemperatuur zijn. */
  line(samples) {
    const pts = samples.filter((s) => Number.isFinite(s.outdoor)).map((s) => ({ x: s.outdoor, y: s.rate }));
    if (pts.length < 6) return null;
    const xs = pts.map((p) => p.x);
    if (Math.max(...xs) - Math.min(...xs) < 4) return null;
    return robustLine(pts);
  }

  /** Eén meting weghalen (bijv. een mislukte: raam open, ketel in storing). at = tijdstip van de meting. */
  remove(at) {
    const before = this.samples.length;
    this.samples = this.samples.filter((s) => s.at !== at);
    return this.samples.length < before;
  }

  /** Verwachte opwarmsnelheid (°C/uur) bij een gegeven buitentemperatuur. */
  rateAt(outdoor) {
    const used = this.used();
    if (!used.length) return DEFAULTS.rate;
    const line = Number.isFinite(outdoor) ? this.line(used) : null;
    if (line) return clamp(line.a + line.b * outdoor, DEFAULTS.minRate, DEFAULTS.maxRate);
    return clamp(median(used.map((s) => s.rate)), DEFAULTS.minRate, DEFAULTS.maxRate);
  }

  deadTime() {
    const d = median(this.used().map((s) => s.deadTime));
    return d === null ? DEFAULTS.deadTime : clamp(d, 0, 90);
  }

  /** Minuten volgens het model, zonder marge of bijsturing. */
  estimate(from, to, outdoor) {
    if (!Number.isFinite(from) || to <= from) return 0;
    return this.deadTime() + ((to - from) / this.rateAt(outdoor)) * 60;
  }

  /**
   * Bijsturing uit de praktijk: hoeveel langer (> 1) of korter (< 1) het opwarmen echt duurde dan het model dacht.
   * Mediaan van de laatste 10 voorverwarmmomenten; null zolang er te weinig zijn.
   */
  factor() {
    const t = this.timing.slice(-10).filter((x) => x.base > 0 && x.need > 0);
    if (t.length < TIMING_MIN) return null;
    return Math.round(clamp(median(t.map((x) => x.need / x.base)), 0.7, 1.6) * 100) / 100;
  }

  /** Minuten die nodig zijn om van `from` naar `to` te komen. */
  preheatMinutes(from, to, outdoor, maxMinutes) {
    const base = this.estimate(from, to, outdoor);
    if (!base) return 0;
    const f = this.factor();
    // Nog niets over 'op tijd' geleerd: 10% marge. Wel: de bijsturing plus een kleine marge van 5%.
    return Math.round(clamp(base * (f == null ? 1.1 : f * 1.05), 0, maxMinutes));
  }

  /** Eén voorverwarmmoment afgerond: was het op tijd warm? */
  addTiming(t) {
    this.timing.push(t);
    if (this.timing.length > MAX_TIMING) this.timing.shift();
  }

  /** Mediaan van hoeveel minuten te laat (+) of te vroeg (−) het de laatste keren warm was. */
  lateness() {
    const t = this.timing.slice(-10);
    return t.length ? Math.round(median(t.map((x) => x.late))) : null;
  }

  /**
   * Elke tick aanroepen met de actuele waarden.
   * Start, volgt en beëindigt opwarmsessies vanzelf.
   */
  observe({ now, target, indoor, outdoor }) {
    if (!Number.isFinite(target) || !Number.isFinite(indoor)) return null;
    const s = this.session;

    if (!s) {
      if (target - indoor >= START_GAP) {
        this.session = {
          start: now, startTemp: indoor, target, outdoor: Number.isFinite(outdoor) ? outdoor : null,
          riseAt: null, riseTemp: null,
        };
      }
      return null;
    }

    const elapsed = (now - s.start) / 60000;
    if (Math.abs(target - s.target) > 0.05 || elapsed > MAX_SESSION_MINUTES) {
      // Onderbroken (iemand draaide aan de knop, of het duurde te lang): wat er al gestegen is telt
      // mee als het lang genoeg en duidelijk genoeg was. Daarna eventueel een nieuwe meting starten.
      this.session = null;
      const sample = this.finish(s, now, indoor, MIN_PARTIAL_MINUTES);
      this.observe({ now, target, indoor, outdoor });
      return sample;
    }

    if (s.riseAt === null && indoor >= s.startTemp + RISE_THRESHOLD) {
      s.riseAt = now;
      s.riseTemp = indoor;
    }

    if (indoor >= s.target - 0.2) {
      this.session = null;
      return this.finish(s, now, indoor, MIN_RISING_MINUTES);
    }
    return null;
  }

  /** Sessie afsluiten: meting opslaan als de stijging lang en groot genoeg was. */
  finish(s, now, indoor, minRisingMinutes) {
    if (s.riseAt === null) return null;
    const risingMinutes = (now - s.riseAt) / 60000;
    const rise = indoor - s.riseTemp;
    if (risingMinutes < minRisingMinutes || indoor - s.startTemp < MIN_SESSION_RISE || rise <= 0) return null;
    const sample = {
      at: now,
      rate: Math.round((rise / (risingMinutes / 60)) * 100) / 100,
      deadTime: Math.round((s.riseAt - s.start) / 60000),
      outdoor: s.outdoor,
      from: s.startTemp,
      to: Math.round(indoor * 10) / 10, // bereikte temperatuur (bij onderbreken lager dan het doel)
    };
    this.samples.push(sample);
    if (this.samples.length > DEFAULTS.maxSamples) this.samples.shift();
    return sample;
  }
}

module.exports = { Learner, DEFAULTS };
