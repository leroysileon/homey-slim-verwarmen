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
  // 'next' = tot het volgende blok in het schema, 'manual' = tot je het schema hervat,
  // of een aantal minuten.
  overrideDefault: 'next',
  autoPresence: false, // thuis/afwezig volgen via de Homey-app (locatie van de gebruikers)
  limit: false, // maximumtemperatuur aan/uit
  maxTemp: 21, // nooit warmer dan dit (schema, widget en draaien aan de knop)
  // Raam open herkennen aan een snelle temperatuurdaling en vragen of de verwarming lager moet.
  // Niet ingesteld = aan, behalve als de thermostaat dat zelf al doet (bijv. tado): dan uit, anders dubbel.
  windowDetect: undefined,
  windowAction: 'off', // bij raam open: 'off' = thermostaat uit (5°), 'eco' = temperatuur van afwezig
  windowMinutes: 15, // zo lang lager bij raam open: 10, 15, 30 of 60
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
// Meldt de thermostaat na onze wijziging nog de óude waarde, dan is hij gewoon traag (Matter/tado kan minuten duren): geen 'handmatig'.
const SLOW_CONFIRM_MS = 5 * 60 * 1000;
const TOLERANCE = 0.1;

// Op tijd warm?
const REACHED = 0.2; // zo dicht bij het doel telt als 'warm'
const LATE_GIVE_UP = 3 * 60; // minuten na het schema-moment: dan niet meer meten

// Raam open: zakt de temperatuur binnen 10 minuten zoveel, dan vragen we of de verwarming uit moet.
const WINDOW_DROP = 0.6; // startwaarde; wordt hoger als je de vraag vaak negeert
const WINDOW_DROP_MAX = 1.2;
const WINDOW_LOG_DAYS = 30;
const WINDOW_SPAN = 10 * 60000;
const WINDOW_TEMP = 5; // 'uit' (laagste stand van de meeste thermostaten, vorstvrij)
const WINDOW_MINUTES = 15;
const WINDOW_ASK_MS = 30 * 60000; // zo lang blijft de vraag staan
const WINDOW_QUIET_MS = 60 * 60000; // na 'Negeren' of 'Raam dicht' even niet opnieuw vragen

/**
 * Het brein. Bevat geen Homey-code, zodat het los te testen is.
 *
 * io = {
 *   now(): number (ms),
 *   timeZone(): string,
 *   readThermostat(): Promise<{ target: number, indoor: number } | null>,
 *   readOutdoor(): Promise<number | null>,
 *   weather?(): string | null,   // weertype van de laatste meting: clear, night, partly, cloudy, rain, …
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
    // Nieuwe installatie: eerst stil, tot de gebruiker op 'Start' tikt. Bestaande installaties: gewoon door.
    const saved = store.get('state');
    this.state = {
      enabled: !!saved,
      setupDone: !!saved,
      away: false,
      override: null, // { temp, since, until (null = tot je het schema hervat), duration }
      lastWritten: null, // { temp, at }
      preheatFor: null, // mow van het blok waarvoor we voorverwarmen
      run: null, // lopend voorverwarmmoment waarvan we meten of het op tijd warm is
      window: null, // { since, until }: verwarming uit omdat het raam open is
      windowAsk: null, // { at, from, to }: temperatuur zakte snel, vraag of de verwarming uit moet
      windowQuiet: 0,
      restore: false, // raam weer dicht: handmatige temperatuur terugzetten
      ...(store.get('state') || {}),
    };
    this.status = {};
    this.busy = null;
    this.modeLog = store.get('modelog') || []; // [{ t, m }] standwissels, voor het dagverloop
    this.indoorLog = []; // [{ t, v }] binnentemperatuur van het laatste kwartier, voor 'raam open'
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
  /** Ingestelde maximumtemperatuur, of null als die uit staat. */
  maxTemp() {
    const cfg = this.config;
    return cfg.limit === true && Number.isFinite(Number(cfg.maxTemp)) ? Number(cfg.maxTemp) : null;
  }

  /** Temperatuur bij raam open: uit (5°) of de temperatuur van afwezig, volgens de instellingen. */
  windowTemp() {
    const cfg = this.config;
    return cfg.windowAction === 'eco' && Number.isFinite(Number(cfg.ecoTemp)) ? Number(cfg.ecoTemp) : WINDOW_TEMP;
  }

  /** Staat 'raam open herkennen' aan? Niet ingesteld: aan, tenzij de thermostaat het zelf al doet. */
  windowDetectOn() {
    const d = this.config.windowDetect;
    if (d === true || d === false) return d;
    return !this.ownWindow;
  }

  /** Hoeveel minuten lager bij raam open (instelling). */
  windowMinutes() {
    const m = Math.round(Number(this.config.windowMinutes));
    return [10, 15, 30, 60].includes(m) ? m : WINDOW_MINUTES;
  }

  /**
   * Hoe sterk de temperatuur moet zakken voor de vraag. Leert van je keuzes: negeer je hem vaker dan je
   * de verwarming lager zet, dan reageert de app pas bij een grotere daling (stapjes van 0,15°, hooguit 1,2°).
   */
  windowDrop() {
    const decided = (this.state.windowLog || []).filter((x) => x.c === 'off' || x.c === 'ignore').slice(-6);
    const ign = decided.filter((x) => x.c === 'ignore').length;
    const off = decided.length - ign;
    return Math.round(Math.min(WINDOW_DROP_MAX, WINDOW_DROP + 0.15 * Math.max(0, ign - off)) * 100) / 100;
  }

  /** Keuze bij de laatste vraag onthouden ('off' | 'ignore'). */
  noteWindowChoice(c) {
    const log = this.state.windowLog || [];
    const last = log[log.length - 1];
    if (last && last.c === 'none') last.c = c;
  }

  /** Plan van het schema, begrensd op de maximumtemperatuur. */
  plan(now, indoor, outdoor) {
    const p = this.rawPlan(now, indoor, outdoor);
    const max = this.maxTemp();
    if (p && max != null && p.temp > max) p.temp = max;
    return p;
  }

  rawPlan(now, indoor, outdoor) {
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
    // Loopt er al een ronde? Dan daarna nog één, zodat een wijziging van nu (bijv. 'Hervat schema') niet
    // het antwoord krijgt van een ronde die nog met de oude stand rekende.
    if (this.busy) {
      if (!this.next) this.next = this.busy.then(() => { this.next = null; return this.tick(); });
      return this.next;
    }
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
      // Geen thermostaat gekozen, of hij geeft geen waarde: niets regelen en dat ook duidelijk laten zien
      // (niet de oude status blijven tonen, dan lijkt alles gewoon te werken).
      const chosen = !!this.config.thermostatId;
      this.status = {
        ...this.buildStatus(now, { target: null, indoor: null }, null, null, 'none'),
        mode: 'nodevice',
        modeLabel: chosen ? 'Thermostaat niet bereikbaar' : 'Geen thermostaat',
        nextLabel: null,
        error: chosen ? 'De thermostaat reageert niet. Controleer hem in de Homey-app.' : 'Kies een thermostaat in de instellingen van Slim verwarmen.',
      };
      this.onEvent('status', this.status);
      return;
    }
    const outdoor = await this.io.readOutdoor().catch(() => null);
    this.lastOutdoor = outdoor;
    // Heeft de thermostaat zelf raam-open-detectie (bijv. tado)? Dan staat onze eigen detectie standaard uit.
    this.ownWindow = th.ownWindow || null;
    // De thermostaat staat zelf uit, of meldt zelf een open raam: niet tegenin sturen en niets als 'handmatig' zien.
    const held = th.windowOpen === true || th.mode === 'off';
    this.held = held ? (th.windowOpen === true ? 'window' : 'off') : null;

    const sample = this.learner.observe({ now, target: th.target, indoor: th.indoor, outdoor });
    if (sample) this.onEvent('learned', sample);

    const plan = this.plan(now, th.indoor, outdoor);
    const st = this.state;
    this.watchWindow(now, th.indoor);
    if (held) {
      st.windowAsk = null; // de thermostaat regelt het al
      st.run = null;
      // lastWritten laten staan: zet de thermostaat straks zelf de oude waarde terug, dan is dat geen 'handmatig'.
      this.save();
      this.status = this.buildStatus(now, th, outdoor, plan, 'none');
      this.logMode(now, this.status.mode);
      this.status.targetConfirmed = true;
      this.onEvent('status', this.status);
      return;
    }

    // 0. Raam-open-stand en iemand draait aan de knop: dan is het raam kennelijk dicht en geldt wat hij instelde.
    // (Alleen als we 'uit' al verstuurd hebben; anders is het gewoon de temperatuur van vóór het raam.)
    const winTemp = this.windowTemp();
    if (st.window && st.lastWritten && Math.abs(st.lastWritten.temp - winTemp) <= TOLERANCE
        && Math.abs(th.target - winTemp) > TOLERANCE
        && now - (st.lastWritten ? st.lastWritten.at : 0) > SELF_WRITE_GRACE_MS && !this.stillOld(th.target, now)) {
      this.endWindow(now, false);
    }

    // 1. Heeft iemand aan de thermostaat (of een andere app) gezeten?
    if (st.enabled && !st.window && !st.restore && st.override && Math.abs(st.override.temp - th.target) > TOLERANCE
        && now - (st.lastWritten ? st.lastWritten.at : 0) > SELF_WRITE_GRACE_MS
        && !this.stillOld(th.target, now)) {
      // Tijdens een handmatige stand nog eens verdraaid: nieuwe waarde, zelfde eindtijd.
      st.override.temp = th.target;
    } else if (st.enabled && !st.window && !st.override && st.lastWritten
        && Math.abs(th.target - st.lastWritten.temp) > TOLERANCE
        && now - st.lastWritten.at > SELF_WRITE_GRACE_MS
        && !this.stillOld(th.target, now)) {
      st.override = this.newOverride(th.target, now, this.config.overrideDefault, plan);
      const { until } = st.override;
      this.log(`Handmatig ingesteld op ${th.target}° tot ${until ? new Date(until).toISOString() : 'het schema wordt hervat'}`);
      this.onEvent('override_started', { temp: th.target, until });
    }

    // 1b. Maximumtemperatuur: hoger gedraaid (knop, andere app)? Terugzetten naar het maximum.
    const max = this.maxTemp();
    if (st.enabled && max != null && th.target > max + TOLERANCE
        && now - (st.lastWritten ? st.lastWritten.at : 0) > SELF_WRITE_GRACE_MS && !this.stillOld(th.target, now)) {
      if (st.override) st.override.temp = Math.min(st.override.temp, max);
      await this.io.writeTarget(max);
      st.lastWritten = { temp: max, at: now, prev: th.target };
      this.log(`Boven het maximum (${th.target}°): teruggezet naar ${max}°`);
      this.onEvent('setpoint_changed', { temp: max, reason: 'limit', from: th.target });
    }

    // 2. Override voorbij?
    if (st.override && st.override.until != null && now >= st.override.until) {
      st.override = null;
      this.onEvent('override_ended', {});
    }

    // 3. Schema toepassen (of: raam open = uit, raam weer dicht = handmatige temperatuur terug)
    let action = 'none';
    let want = null;
    if (st.window) want = { temp: winTemp, reason: 'window' };
    else if (st.override) want = st.restore ? { temp: st.override.temp, reason: 'restore' } : null;
    else want = plan;
    // Al geschreven en de thermostaat is nog bezig met overnemen? Niet nog eens sturen.
    const waiting = st.lastWritten && Math.abs(st.lastWritten.temp - (want ? want.temp : NaN)) <= 0.05 && this.stillOld(th.target, now);
    if (st.enabled && want && Math.abs(th.target - want.temp) > 0.05 && !waiting) {
      await this.io.writeTarget(want.temp);
      st.lastWritten = { temp: want.temp, at: now, prev: th.target };
      action = 'write';
      this.onEvent('setpoint_changed', { temp: want.temp, reason: want.reason });
    } else if (st.enabled && !st.override && plan && !st.lastWritten) {
      st.lastWritten = { temp: th.target, at: now }; // klopt al; begin met bijhouden
    }
    st.restore = false;

    this.trackTiming(now, th.indoor, plan);

    this.save();
    // Net zelf ingesteld maar de thermostaat meldt nog de oude waarde? Toon dan alvast de nieuwe.
    const lw = st.lastWritten;
    const shown = lw && Math.abs(th.target - lw.temp) > TOLERANCE && (now - lw.at < SELF_WRITE_GRACE_MS || this.stillOld(th.target, now))
      ? { ...th, target: lw.temp } : th;
    this.status = this.buildStatus(now, shown, outdoor, plan, action);
    this.logMode(now, this.status.mode);
    // Heeft de thermostaat de ingestelde temperatuur al overgenomen? (widget laat de golfjes dan stoppen met knipperen)
    this.status.targetConfirmed = shown === th;
    this.onEvent('status', this.status);
  }

  /**
   * Was het op tijd warm? Volgt één voorverwarmmoment: begin, wanneer het doel gehaald werd en
   * hoe dat zich verhoudt tot het schema-moment. Onderbroken (handmatig, afwezig, raam open) = niets leren.
   */
  trackTiming(now, indoor, plan) {
    const st = this.state;
    const blocked = !st.enabled || st.away || !!st.override || !!st.window;
    let run = st.run;
    if (run && (blocked || !plan || Math.abs(plan.temp - run.temp) > 0.05)) { st.run = null; return null; }
    if (!run) {
      if (blocked || !plan || plan.reason !== 'preheat' || !Number.isFinite(indoor)) return null;
      if (indoor >= plan.temp - REACHED) return null; // al warm genoeg: niets te meten
      const base = this.learner.estimate(indoor, plan.temp, this.lastOutdoor);
      if (base < 10) return null;
      st.run = { start: now, blockAt: plan.nextChangeAt, temp: plan.temp, base: Math.round(base), reachedAt: null };
      return null;
    }
    if (run.reachedAt == null && Number.isFinite(indoor) && indoor >= run.temp - REACHED) run.reachedAt = now;
    if (run.reachedAt != null && now >= run.blockAt) {
      st.run = null;
      const need = Math.round((run.reachedAt - run.start) / 60000);
      if (need < 5) return null;
      const t = { at: now, base: run.base, need, late: Math.round((run.reachedAt - run.blockAt) / 60000), temp: run.temp };
      this.learner.addTiming(t);
      this.onEvent('timing', t);
      return t;
    }
    if (now > run.blockAt + LATE_GIVE_UP * 60000) st.run = null; // nooit warm geworden: niets leren
    return null;
  }

  /** Raam open? Zakt de binnentemperatuur snel, dan vragen we of de verwarming even uit moet. */
  watchWindow(now, indoor) {
    const st = this.state;
    if (Number.isFinite(indoor)) this.indoorLog.push({ t: now, v: indoor });
    while (this.indoorLog.length && this.indoorLog[0].t < now - WINDOW_SPAN) this.indoorLog.shift();
    if (st.window && now >= st.window.until) this.endWindow(now, true);
    if (st.windowAsk && now - st.windowAsk.at > WINDOW_ASK_MS) st.windowAsk = null;
    if (!this.windowDetectOn()) { st.windowAsk = null; return; } // uit (instelling, of de thermostaat doet het zelf)
    if (!st.enabled || !st.setupDone || st.away || st.window || st.windowAsk || now < (st.windowQuiet || 0)) return;
    if (!Number.isFinite(indoor) || this.indoorLog.length < 2) return;
    const peak = Math.max(...this.indoorLog.map((x) => x.v));
    if (peak - indoor >= this.windowDrop() - 1e-9) {
      st.windowAsk = { at: now, from: peak, to: indoor };
      st.windowLog = [...(st.windowLog || []), { at: now, c: 'none' }].filter((x) => x.at > now - WINDOW_LOG_DAYS * 86400000);
      this.log(`Raam open? Binnen zakte van ${peak}° naar ${indoor}°`);
      this.onEvent('window_open', { from: peak, to: indoor, drop: Math.round((peak - indoor) * 10) / 10 });
    }
  }

  /** Raam dicht (of tijd om): terug naar het schema of de handmatige temperatuur. */
  endWindow(now, restore) {
    if (!this.state.window) return;
    this.state.window = null;
    this.state.restore = restore && !!this.state.override;
    this.state.windowQuiet = now + WINDOW_QUIET_MS; // na het luchten stijgt de temperatuur weer: niet meteen opnieuw vragen
    this.indoorLog = [];
    this.onEvent('window_closed', {});
  }

  /** Meldt de thermostaat kort na onze wijziging nog de waarde van vóór die wijziging? */
  stillOld(target, now) {
    const lw = this.state.lastWritten;
    return !!(lw && lw.prev != null && Math.abs(target - lw.prev) <= TOLERANCE && now - lw.at < SLOW_CONFIRM_MS);
  }

  /** Standwissel onthouden (schema, handmatig, afwezig, …), 8 dagen lang. */
  logMode(now, mode) {
    const last = this.modeLog[this.modeLog.length - 1];
    if (last && last.m === mode) return;
    this.modeLog.push({ t: now, m: mode });
    const keep = now - 8 * 86400000;
    while (this.modeLog.length > 1 && this.modeLog[1].t < keep) this.modeLog.shift();
    this.store.set('modelog', this.modeLog);
  }

  buildStatus(now, th, outdoor, plan, action) {
    const st = this.state;
    let mode = 'schedule';
    if (!st.setupDone) mode = 'setup';
    else if (!st.enabled) mode = 'paused';
    else if (this.held) mode = this.held === 'window' ? 'deviceWindow' : 'deviceOff';
    else if (st.window) mode = 'window';
    else if (st.override) mode = 'manual';
    else if (plan) mode = plan.reason;
    return {
      updatedAt: now,
      mode,
      setupDone: !!st.setupDone,
      action,
      thermostatTarget: th.target,
      maxTemp: this.maxTemp(), // null = geen maximum
      indoor: th.indoor,
      humidity: Number.isFinite(th.humidity) ? Math.round(th.humidity) : null,
      room: th.room || null, // zone van de thermostaat in Homey, bijv. Woonkamer
      outdoor,
      weather: this.io.weather ? this.io.weather() : null,
      presence: this.io.presence ? this.io.presence() : null, // { auto, home: [namen] }
      planned: plan ? plan.temp : null,
      currentBlock: plan ? { at: formatMow(plan.current.mow), temp: plan.current.temp } : null,
      nextBlock: plan ? { at: formatMow(plan.next.mow), temp: plan.next.temp, inMinutes: plan.minutesToNext } : null,
      preheatMinutes: plan ? plan.preheatMinutes : 0,
      override: st.override,
      overrideDefault: normDuration(this.config.overrideDefault),
      nextChangeAt: plan ? plan.nextChangeAt : null, // eindtijd van 'tot het volgende blok in het schema'
      away: st.away,
      enabled: st.enabled,
      window: st.window, // { since, until }
      windowAsk: st.window || !this.windowDetectOn() ? null : st.windowAsk, // { at, from, to }: vraag in de widget
      windowInfo: (() => {
        const log = (st.windowLog || []).filter((x) => x.at > now - WINDOW_LOG_DAYS * 86400000);
        return {
          on: this.windowDetectOn(), own: this.ownWindow, minutes: this.windowMinutes(), drop: this.windowDrop(),
          asked: log.length, off: log.filter((x) => x.c === 'off').length, ignored: log.filter((x) => x.c === 'ignore').length,
        };
      })(),
      windowTemp: this.windowTemp(), // 5 = uit, anders de temperatuur van afwezig
      learned: {
        samples: this.learner.samples.length,
        ignored: this.learner.ignored().size,
        factor: this.learner.factor(), // null = nog niet bijgestuurd
        late: this.learner.lateness(), // mediaan minuten te laat (+) / te vroeg (−)
        timing: this.learner.timing.slice(-5),
        rate: Math.round(this.learner.rateAt(outdoor) * 100) / 100,
        deadTime: this.learner.deadTime(),
        heatingNow: !!this.learner.session,
        recent: (() => { const skip = this.learner.ignored(); return this.learner.samples.slice(-5).map((x) => (skip.has(x.at) ? { ...x, ignored: true } : x)); })(),
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
      schedule: 'Volgens schema', preheat: 'Voorverwarmen', away: 'Niemand thuis', paused: 'Gepauzeerd', window: 'Raam open',
      deviceWindow: 'Raam open', deviceOff: 'Thermostaat uit',
    }[mode] || mode;
  }

  // ---- Acties (flowkaarten / instellingenpagina) ----

  async setAway(away) {
    // Alleen bij een echte wissel (thuis <-> afwezig) de handmatige stand wissen.
    // Een telefoon die 's nachts kort 'weg' en weer 'thuis' meldt, mag die niet weggooien.
    if (this.state.away === !!away) { await this.tick(); return; }
    this.state.away = !!away;
    this.state.window = null; this.state.windowAsk = null;
    this.state.override = null; // thuiskomen of vertrekken = schema weer leidend
    this.state.lastWritten = null;
    await this.tick();
  }

  async setEnabled(enabled) {
    this.state.enabled = !!enabled;
    this.state.window = null; this.state.windowAsk = null;
    if (enabled) this.state.setupDone = true; // aanzetten = ingesteld (ook via Flow)
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
    const max = this.maxTemp(); if (max != null) temp = Math.min(temp, max); // nooit boven het maximum
    const now = this.io.now();
    if (this.state.window) { this.state.window = null; this.state.windowQuiet = now + WINDOW_QUIET_MS; } // zelf een temperatuur kiezen = raam dicht
    this.state.windowAsk = null;
    const cur = this.state.enabled && this.state.override;
    let override;
    if (duration == null && cur) override = { ...cur, temp };
    else override = this.newOverride(temp, now, duration == null ? this.config.overrideDefault : duration, await this.currentPlan(now));
    const before = await this.io.readThermostat().catch(() => null); // om een trage thermostaat te herkennen
    await this.io.writeTarget(temp);
    this.state.lastWritten = { temp, at: now, prev: before && Number.isFinite(before.target) ? before.target : null };
    this.state.override = override;
    this.onEvent('override_started', { temp, until: override.until });
    await this.tick();
  }

  /** Andere duur voor de lopende handmatige stand. */
  async setOverrideDuration(duration) {
    const cur = this.state.override;
    if (!cur) { await this.tick(); return; }
    const now = this.io.now();
    this.state.override = { ...this.newOverride(cur.temp, now, duration, await this.currentPlan(now)), since: cur.since };
    this.onEvent('override_started', { temp: cur.temp, until: this.state.override.until });
    await this.tick();
  }

  /** Raam open: verwarming lager, zo lang als ingesteld (of `minutes`, bijv. vanuit een flow). */
  async startWindow(minutes) {
    const now = this.io.now();
    const m = Math.max(5, Math.min(240, Math.round(Number(minutes) || this.windowMinutes())));
    if (this.state.windowAsk) this.noteWindowChoice('off');
    this.state.window = { since: now, until: now + m * 60000 };
    this.state.windowAsk = null;
    await this.tick();
  }

  /** Raam weer dicht. */
  async stopWindow() {
    this.endWindow(this.io.now(), true);
    await this.tick();
  }

  /** Vraag 'raam open?' wegklikken: een uur niet opnieuw vragen. */
  async ignoreWindow() {
    if (this.state.windowAsk) this.noteWindowChoice('ignore');
    this.state.windowAsk = null;
    this.state.windowQuiet = this.io.now() + WINDOW_QUIET_MS;
    await this.tick();
  }

  resetLearning() {
    this.learner.reset();
    this.save();
  }

  /** Eén meting van de opwarmtijd verwijderen (naar links vegen op de instellingenpagina). */
  deleteSample(at) {
    if (!this.learner.remove(at)) return false;
    this.save();
    return true;
  }
}

module.exports = { Controller, DEFAULT_CONFIG, normDuration, WINDOW_TEMP };
