'use strict';

const {
  DEFAULT_SCHEDULE, WEEK, toEvents, localMow, currentAndNext, formatMow,
} = require('./schedule');
const { Learner } = require('./learner');

const DEFAULT_CONFIG = {
  ecoTemp: 16, // afwezig
  maxPreheat: 180, // minuten
  preheat: true,
  // Hoe lang een handmatige stand geldt als je niets kiest:
  // 'next' = tot het volgende moment in het schema, 'manual' = tot je het schema hervat,
  // of een aantal minuten.
  overrideDefault: 'next',
};

const MAX_OVERRIDE_MINUTES = 7 * 24 * 60;

/** 'next' | 'manual' | minuten (getal). Onbekend = 'next'. */
function normDuration(d) {
  if (d === 'manual' || d === 'next') return d;
  const m = Math.round(Number(d));
  if (Number.isFinite(m) && m > 0) return Math.min(MAX_OVERRIDE_MINUTES, Math.max(5, m));
  return 'next';
}

const SELF_WRITE_GRACE_MS = 15 * 1000; // na eigen wijziging even geen "handmatig" detecteren
const TOLERANCE = 0.1;

/**
 * Het brein. Bevat geen Homey-code, zodat het los te testen is.
 *
 * io = {
 *   now(): number (ms),
 *   timeZone(): string,
 *   readThermostat(): Promise<{ target: number, indoor: number } | null>,
 *   readOutdoor(): Promise<number | null>,
 *   writeTarget(temp): Promise<void>,
 * }
 * store = { get(key), set(key, value) }   (Homey settings)
 */
class Controller {
  constructor({ io, store, log = () => {}, onEvent = () => {} }) {
    this.io = io;
    this.store = store;
    this.log = log;
    this.onEvent = onEvent;
    this.learner = new Learner(store.get('learner') || {});
    this.state = {
      enabled: true,
      away: false,
      override: null, // { temp, since, until (null = tot je het schema hervat), duration }
      lastWritten: null, // { temp, at }
      preheatFor: null, // mow van het blok waarvoor we voorverwarmen
      ...(store.get('state') || {}),
    };
    this.status = {};
    this.busy = null;
  }

  get schedule() {
    return this.store.get('schedule') || DEFAULT_SCHEDULE;
  }

  get config() {
    return { ...DEFAULT_CONFIG, ...(this.store.get('config') || {}) };
  }

  save() {
    this.store.set('state', this.state);
    this.store.set('learner', this.learner.toJSON());
  }

  /** Wat zou de temperatuur nu moeten zijn, zonder handmatige override? */
  plan(now, indoor, outdoor) {
    const cfg = this.config;
    const nowMow = localMow(new Date(now), this.io.timeZone());
    const cn = currentAndNext(toEvents(this.schedule), nowMow);
    if (!cn) return null;

    const { current, next, minutesToNext } = cn;
    const at = (minutes) => now + minutes * 60000;
    const info = { current, next, minutesToNext };

    if (this.state.away) {
      this.state.preheatFor = null;
      return { ...info, temp: cfg.ecoTemp, reason: 'away', nextChangeAt: at(minutesToNext), preheatMinutes: 0 };
    }

    let preheatMinutes = 0;
    if (cfg.preheat && next.temp > current.temp && minutesToNext < WEEK) {
      preheatMinutes = this.learner.preheatMinutes(indoor, next.temp, outdoor, cfg.maxPreheat);
      // Eenmaal begonnen met voorverwarmen: doorzetten (de binnentemp stijgt,
      // waardoor de berekende voorverwarmtijd anders weer zou krimpen).
      if (this.state.preheatFor === next.mow || minutesToNext <= preheatMinutes) {
        this.state.preheatFor = next.mow;
        return { ...info, temp: next.temp, reason: 'preheat', nextChangeAt: at(minutesToNext), preheatMinutes };
      }
    }
    this.state.preheatFor = null;
    return {
      ...info,
      temp: current.temp,
      reason: 'schedule',
      nextChangeAt: at(Math.max(1, minutesToNext - preheatMinutes)),
      preheatMinutes,
    };
  }

  /** Eén regelronde. Veilig om vaak aan te roepen; gelijktijdige aanroepen worden samengevoegd. */
  tick() {
    if (!this.busy) {
      this.busy = this._tick()
        .catch((err) => {
          this.status.error = err.message;
          this.log('Fout in regelronde:', err);
        })
        .finally(() => { this.busy = null; });
    }
    return this.busy;
  }

  async _tick() {
    const now = this.io.now();
    const th = await this.io.readThermostat();
    if (!th || !Number.isFinite(th.target)) {
      this.status = { ...this.status, error: 'Thermostaat niet gevonden of geen waarde. Kies hem in de instellingen.' };
      return;
    }
    const outdoor = await this.io.readOutdoor().catch(() => null);

    const sample = this.learner.observe({ now, target: th.target, indoor: th.indoor, outdoor });
    if (sample) this.onEvent('learned', sample);

    const plan = this.plan(now, th.indoor, outdoor);
    const st = this.state;

    // 1. Heeft iemand aan de thermostaat (of de tado-app) gezeten?
    if (st.enabled && st.override && Math.abs(st.override.temp - th.target) > TOLERANCE
        && now - (st.lastWritten ? st.lastWritten.at : 0) > SELF_WRITE_GRACE_MS) {
      // Tijdens een handmatige stand nog eens verdraaid: nieuwe waarde, zelfde eindtijd.
      st.override.temp = th.target;
    } else if (st.enabled && !st.override && st.lastWritten
        && Math.abs(th.target - st.lastWritten.temp) > TOLERANCE
        && now - st.lastWritten.at > SELF_WRITE_GRACE_MS) {
      st.override = this.newOverride(th.target, now, this.config.overrideDefault, plan);
      const { until } = st.override;
      this.log(`Handmatig ingesteld op ${th.target}° tot ${until ? new Date(until).toISOString() : 'het schema wordt hervat'}`);
      this.onEvent('override_started', { temp: th.target, until });
    }

    // 2. Override voorbij?
    if (st.override && st.override.until != null && now >= st.override.until) {
      st.override = null;
      this.onEvent('override_ended', {});
    }

    // 3. Schema toepassen
    let action = 'none';
    if (st.enabled && !st.override && plan && Math.abs(th.target - plan.temp) > 0.05) {
      await this.io.writeTarget(plan.temp);
      st.lastWritten = { temp: plan.temp, at: now };
      action = 'write';
      this.onEvent('setpoint_changed', { temp: plan.temp, reason: plan.reason });
    } else if (st.enabled && !st.override && plan && !st.lastWritten) {
      st.lastWritten = { temp: th.target, at: now }; // klopt al; begin met bijhouden
    }

    this.save();
    // Net zelf ingesteld maar de thermostaat meldt nog de oude waarde? Toon dan alvast de nieuwe.
    const lw = st.lastWritten;
    const shown = lw && now - lw.at < SELF_WRITE_GRACE_MS && Math.abs(th.target - lw.temp) > TOLERANCE
      ? { ...th, target: lw.temp } : th;
    this.status = this.buildStatus(now, shown, outdoor, plan, action);
    this.onEvent('status', this.status);
  }

  buildStatus(now, th, outdoor, plan, action) {
    const st = this.state;
    let mode = 'schedule';
    if (!st.enabled) mode = 'paused';
    else if (st.override) mode = 'manual';
    else if (plan) mode = plan.reason;
    return {
      updatedAt: now,
      mode,
      action,
      thermostatTarget: th.target,
      indoor: th.indoor,
      outdoor,
      planned: plan ? plan.temp : null,
      currentBlock: plan ? { at: formatMow(plan.current.mow), temp: plan.current.temp } : null,
      nextBlock: plan ? { at: formatMow(plan.next.mow), temp: plan.next.temp, inMinutes: plan.minutesToNext } : null,
      preheatMinutes: plan ? plan.preheatMinutes : 0,
      override: st.override,
      overrideDefault: normDuration(this.config.overrideDefault),
      away: st.away,
      enabled: st.enabled,
      learned: {
        samples: this.learner.samples.length,
        rate: Math.round(this.learner.rateAt(outdoor) * 100) / 100,
        deadTime: this.learner.deadTime(),
        heatingNow: !!this.learner.session,
        recent: this.learner.samples.slice(-5),
      },
      modeLabel: this.modeLabel(mode, st.override),
      nextLabel: plan && mode !== 'manual' ? `${formatMow(plan.next.mow)} → ${plan.next.temp}°` : null,
      error: null,
    };
  }

  modeLabel(mode, override) {
    if (mode === 'manual' && override) {
      if (override.until == null) return 'Handmatig, tot je het schema hervat';
      const t = new Date(override.until).toLocaleTimeString('nl-NL', {
        timeZone: this.io.timeZone(), hour: '2-digit', minute: '2-digit',
      });
      return `Handmatig tot ${t}`;
    }
    return {
      schedule: 'Volgens schema', preheat: 'Voorverwarmen', away: 'Niemand thuis', paused: 'Gepauzeerd',
    }[mode] || mode;
  }

  // ---- Acties (flowkaarten / instellingenpagina) ----

  async setAway(away) {
    // Alleen bij een echte wissel (thuis <-> afwezig) de handmatige stand wissen.
    // Een telefoon die 's nachts kort 'weg' en weer 'thuis' meldt, mag die niet weggooien.
    if (this.state.away === !!away) { await this.tick(); return; }
    this.state.away = !!away;
    this.state.override = null; // thuiskomen of vertrekken = schema weer leidend
    this.state.lastWritten = null;
    await this.tick();
  }

  async setEnabled(enabled) {
    this.state.enabled = !!enabled;
    this.state.override = null;
    this.state.lastWritten = null;
    await this.tick();
  }

  async clearOverride() {
    if (this.state.override) this.onEvent('override_ended', {});
    this.state.override = null;
    this.state.lastWritten = null;
    await this.tick();
  }

  /** Nieuwe handmatige stand met eindtijd volgens `duration` ('next' | 'manual' | minuten). */
  newOverride(temp, now, duration, plan) {
    const d = normDuration(duration);
    let until;
    if (d === 'manual') until = null;
    else if (d === 'next') until = plan ? plan.nextChangeAt : now + 4 * 3600000;
    else until = now + d * 60000;
    return { temp, since: now, until, duration: d };
  }

  async currentPlan(now) {
    const th = await this.io.readThermostat();
    const outdoor = await this.io.readOutdoor().catch(() => null);
    return this.plan(now, th ? th.indoor : null, outdoor);
  }

  async setOverride(temp, hours) {
    return this.setManual(temp, Number(hours) * 60);
  }

  /**
   * Zoals aan de knop draaien. Zonder duur: loopt er al een handmatige stand, dan blijft
   * de eindtijd staan; anders geldt de standaard uit de instellingen.
   */
  async setManual(temp, duration) {
    const now = this.io.now();
    const cur = this.state.enabled && this.state.override;
    let override;
    if (duration == null && cur) override = { ...cur, temp };
    else override = this.newOverride(temp, now, duration == null ? this.config.overrideDefault : duration, await this.currentPlan(now));
    await this.io.writeTarget(temp);
    this.state.lastWritten = { temp, at: now };
    this.state.override = override;
    this.onEvent('override_started', { temp, until: override.until });
    await this.tick();
  }

  /** Andere duur voor de lopende handmatige stand (zoals 'hoe lang?' in de tado-app). */
  async setOverrideDuration(duration) {
    const cur = this.state.override;
    if (!cur) { await this.tick(); return; }
    const now = this.io.now();
    this.state.override = { ...this.newOverride(cur.temp, now, duration, await this.currentPlan(now)), since: cur.since };
    this.onEvent('override_started', { temp: cur.temp, until: this.state.override.until });
    await this.tick();
  }

  resetLearning() {
    this.learner.reset();
    this.save();
  }
}

module.exports = { Controller, DEFAULT_CONFIG, normDuration };
