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
const MAX_SESSION_MINUTES = 8 * 60;

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
  }

  toJSON() {
    return { samples: this.samples, session: this.session };
  }

  reset() {
    this.samples = [];
    this.session = null;
  }

  /** Verwachte opwarmsnelheid (°C/uur) bij een gegeven buitentemperatuur. */
  rateAt(outdoor) {
    const rates = this.samples.map((s) => s.rate);
    if (!rates.length) return DEFAULTS.rate;

    const withOutdoor = this.samples.filter((s) => Number.isFinite(s.outdoor));
    if (Number.isFinite(outdoor) && withOutdoor.length >= 6) {
      const xs = withOutdoor.map((s) => s.outdoor);
      const spread = Math.max(...xs) - Math.min(...xs);
      if (spread >= 4) {
        const n = withOutdoor.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = withOutdoor.reduce((a, s) => a + s.rate, 0) / n;
        let sxy = 0;
        let sxx = 0;
        for (const s of withOutdoor) {
          sxy += (s.outdoor - mx) * (s.rate - my);
          sxx += (s.outdoor - mx) ** 2;
        }
        // Kouder buiten mag nooit snéller opwarmen: helling minstens 0.
        const b = Math.max(0, sxy / sxx);
        const a = my - b * mx;
        return clamp(a + b * outdoor, DEFAULTS.minRate, DEFAULTS.maxRate);
      }
    }
    return clamp(median(rates), DEFAULTS.minRate, DEFAULTS.maxRate);
  }

  deadTime() {
    const d = median(this.samples.map((s) => s.deadTime));
    return d === null ? DEFAULTS.deadTime : clamp(d, 0, 90);
  }

  /** Minuten die nodig zijn om van `from` naar `to` te komen. */
  preheatMinutes(from, to, outdoor, maxMinutes) {
    if (!Number.isFinite(from) || to <= from) return 0;
    const minutes = this.deadTime() + ((to - from) / this.rateAt(outdoor)) * 60;
    return Math.round(clamp(minutes * 1.1, 0, maxMinutes)); // 10% marge
  }

  /**
   * Elke tick aanroepen met de actuele waarden.
   * Start, volgt en beëindigt opwarmsessies vanzelf.
   */
  observe({ now, target, indoor, outdoor }) {
    if (!Number.isFinite(target) || !Number.isFinite(indoor)) return null;
    const s = this.session;

    if (!s) {
      if (target - indoor >= 1) {
        this.session = {
          start: now, startTemp: indoor, target, outdoor: Number.isFinite(outdoor) ? outdoor : null,
          riseAt: null, riseTemp: null,
        };
      }
      return null;
    }

    const elapsed = (now - s.start) / 60000;
    if (Math.abs(target - s.target) > 0.05 || elapsed > MAX_SESSION_MINUTES) {
      this.session = null; // onderbroken: niet meetellen
      return this.observe({ now, target, indoor, outdoor });
    }

    if (s.riseAt === null && indoor >= s.startTemp + RISE_THRESHOLD) {
      s.riseAt = now;
      s.riseTemp = indoor;
    }

    if (indoor >= s.target - 0.2) {
      this.session = null;
      if (s.riseAt === null) return null;
      const risingMinutes = (now - s.riseAt) / 60000;
      const rise = indoor - s.riseTemp;
      if (risingMinutes < MIN_RISING_MINUTES || indoor - s.startTemp < MIN_SESSION_RISE || rise <= 0) {
        return null;
      }
      const sample = {
        at: now,
        rate: Math.round((rise / (risingMinutes / 60)) * 100) / 100,
        deadTime: Math.round((s.riseAt - s.start) / 60000),
        outdoor: s.outdoor,
        from: s.startTemp,
        to: s.target,
      };
      this.samples.push(sample);
      if (this.samples.length > DEFAULTS.maxSamples) this.samples.shift();
      return sample;
    }
    return null;
  }
}

module.exports = { Learner, DEFAULTS };
