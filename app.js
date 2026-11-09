'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Controller, WINDOW_TEMP } = require('./lib/controller');
const { weatherOf } = require('./lib/weather');
const { presenceOf, PresenceWatcher } = require('./lib/presence');
const { usageOf } = require('./lib/usage');

const TICK_MS = 60 * 1000;
const JOURNAL_MAX = 800; // regels in het logboek (instellingen > Logboek)

/** Eén logregel van losse argumenten, zoals console.log ze zou tonen. */
function line(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack ? a.stack.split('\n').slice(0, 2).join(' | ') : a.message;
    if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }).join(' ');
}
const REASONS = { schedule: 'schema', preheat: 'voorverwarmen', away: 'afwezig', vacation: 'vakantie', limit: 'maximumtemperatuur', window: 'raam open', restore: 'raam dicht' };

class SlimVerwarmenApp extends Homey.App {

  async onInit() {
    // Logboek: alles wat de app logt, doet en meldt, met tijdstip. Te lezen in de instellingen (Logboek).
    const baseLog = this.log.bind(this); const baseError = this.error.bind(this);
    this.log = (...args) => { baseLog(...args); this.journal('info', line(args)); };
    this.error = (...args) => { baseError(...args); this.journal('fout', line(args)); };
    this.journal('start', `app ${this.homey.manifest.version} start (homey ${this.homey.version || '?'}, tz ${this.homey.clock.getTimezone()})`);
    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    try {
      await this.api.devices.connect();
    } catch (err) {
      this.error('Realtime koppeling niet gelukt, val terug op elke minuut controleren:', err.message);
    }

    this.controller = new Controller({
      io: {
        now: () => Date.now(),
        timeZone: () => this.homey.clock.getTimezone(),
        readThermostat: () => this.readThermostat(),
        readOutdoor: () => this.readOutdoor(),
        weather: () => this.lastWeather || null,
        presence: () => ({ auto: this.config.autoPresence === true, home: this.lastPresence ? this.lastPresence.home : null, count: this.lastPresence ? this.lastPresence.count : 0 }),
        writeTarget: (temp) => this.writeTarget(temp),
      },
      store: this.homey.settings,
      log: (...args) => this.log(...args),
      onEvent: (event, data) => this.onControllerEvent(event, data).catch(this.error),
    });

    // Eenmalig: proefrondes van 8 nov 2026 (afwezig, pauze, vakantie aan en uit) uit het dagverloop halen, wordt gewoon thuis.
    if (!this.homey.settings.get('tidied_20261108')) {
      const n = this.controller.tidyLog(Date.UTC(2026, 10, 7, 23, 0)); // 8 nov 00:00 Nederlandse tijd
      this.homey.settings.set('tidied_20261108', true);
      this.log(`Dagverloop opgeruimd: ${n} testwissels weg`);
    }
    this.registerFlowCards();
    await this.autoDetect();

    // Aanwezigheid: wie er thuis is volgens de Homey-app. Werkt alleen als 'Automatisch thuis en afwezig' aan staat.
    this.presence = new PresenceWatcher();
    this.autoPresenceOn = this.config.autoPresence === true;
    try {
      await this.api.users.connect();
      this.api.users.on('user.update', () => this.checkPresence().catch(this.error));
    } catch (err) {
      this.error('Gebruikers niet realtime te volgen, val terug op elke minuut controleren:', err.message);
    }
    await this.checkPresence().catch(this.error);

    this.homey.settings.on('set', (key) => {
      if (key !== 'journal' && key !== 'weatherlog' && key !== 'modelog' && key !== 'changelog' && key !== 'state' && key !== 'learner') this.journal('opslag', `instelling '${key}' opgeslagen`);
      if (key === 'config') {
        const on = this.config.autoPresence === true;
        if (on && !this.autoPresenceOn) this.checkPresence(true).catch(this.error); // net aangezet: meteen volgen
        this.autoPresenceOn = on;
      }
      if (key === 'schedule' || key === 'config') {
        this.watchThermostat().catch(this.error);
        this.controller.tick();
      }
    });

    await this.watchThermostat();
    this.homey.setInterval(() => { this.checkPresence().catch(this.error); this.controller.tick(); }, TICK_MS);
    await this.controller.tick();
    this.log('Slim verwarmen gestart');
  }

  get config() {
    return this.controller.config;
  }

  // ---------- Aanwezigheid ----------

  /** Iedereen weg = afwezig, eerste thuis = terug naar het schema. apply=true: huidige stand meteen toepassen. */
  async checkPresence(apply = false) {
    const users = await this.api.users.getUsers();
    const p = presenceOf(users);
    if (!p.count) return; // geen gebruikers te zien: niets doen
    this.lastPresence = p;
    const change = this.presence.update(p.anyHome);
    if (this.config.autoPresence !== true) return;
    if (apply) { await this.controller.setAway(!p.anyHome); return; }
    if (change) {
      this.log(`Aanwezigheid: ${change === 'home' ? 'iemand thuis' : 'iedereen weg'}`);
      await this.controller.setAway(change === 'away');
    }
  }

  // ---------- Apparaten ----------

  /** fresh=true: altijd de actuele waarden ophalen, niet de kopie in het geheugen
   *  (die werkt waarden van apparaten niet altijd bij). */
  async getDeviceSafe(id, fresh = false) {
    if (!id) return null;
    try {
      return await this.api.devices.getDevice({ id, $cache: !fresh });
    } catch (err) {
      return null;
    }
  }

  /** Naam van de Homey-zone (bijv. Woonkamer), even onthouden. */
  async zoneName(id) {
    if (!id) return null;
    this.zoneCache = this.zoneCache || {};
    const hit = this.zoneCache[id];
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.name;
    const zone = await this.api.zones.getZone({ id }).catch(() => null);
    const name = zone && zone.name ? zone.name : (hit ? hit.name : null);
    this.zoneCache[id] = { name, at: Date.now() };
    return name;
  }

  async readThermostat() {
    const device = await this.getDeviceSafe(this.config.thermostatId, true);
    if (!device || !device.capabilitiesObj) return null;
    const caps = device.capabilitiesObj;
    return {
      room: await this.zoneName(device.zone),
      target: caps.target_temperature ? caps.target_temperature.value : null,
      indoor: caps.measure_temperature ? caps.measure_temperature.value : null,
      humidity: this.pickHumidity(caps),
      mode: caps.thermostat_mode ? caps.thermostat_mode.value : null, // 'off' = thermostaat staat zelf uit
      windowOpen: this.windowCap(caps), // true = de thermostaat meldt zelf een open raam
      ownWindow: this.ownWindowDetection(device, caps), // naam als hij zelf raam-open-detectie heeft
    };
  }

  /** Meldt de thermostaat zelf een open raam (capability met 'window' erin, aan/uit)? null = kan hij niet. */
  windowCap(caps) {
    const k = Object.keys(caps).find((c) => /window/i.test(c) && typeof (caps[c] && caps[c].value) === 'boolean');
    return k ? caps[k].value === true : null;
  }

  /**
   * Heeft de thermostaat zelf raam-open-detectie? Dan zou die van ons dubbel werken.
   * Herkend aan een raam-capability, of aan het merk: tado doet het altijd zelf (ook via Matter, waar je het niet ziet).
   */
  ownWindowDetection(device, caps) {
    if (this.windowCap(caps) !== null) return device.name;
    const text = [device.name, device.driverId, device.driverUri, device.ownerUri,
      device.settings && device.settings.vendorName, device.settings && device.settings.manufacturer].filter(Boolean).join(' ');
    return /tado/i.test(text) ? 'tado' : null;
  }

  /** Luchtvochtigheid: sommige thermostaten (bijv. Tado X via Matter) hebben er meerdere, zoals
   *  measure_humidity én measure_humidity.matter-2-1029, waarvan er één blijft hangen. Neem de verste. */
  pickHumidity(caps) {
    const all = Object.keys(caps).filter((k) => (k === 'measure_humidity' || k.startsWith('measure_humidity.'))
      && Number.isFinite(Number(caps[k] && caps[k].value)));
    if (!all.length) { this.humidityCap = null; return null; }
    const at = (k) => { const t = new Date(caps[k].lastUpdated || 0).getTime(); return Number.isFinite(t) ? t : 0; };
    all.sort((a, b) => at(b) - at(a) || (a === 'measure_humidity' ? -1 : 1));
    this.humidityCap = all[0];
    return Number(caps[all[0]].value);
  }

  async readOutdoor() {
    const { outdoorDeviceId, outdoorCapability } = this.config;
    const device = await this.getDeviceSafe(outdoorDeviceId, true);
    const cap = device && device.capabilitiesObj && device.capabilitiesObj[outdoorCapability];
    // Weertype voor het icoon in de widget (zon, wolk, regen, …), als het apparaat een omschrijving heeft.
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() }));
    this.lastWeather = device ? weatherOf(device, t.getHours() * 60 + t.getMinutes()) : null;
    this.logWeather(this.lastWeather);
    const value = cap ? Number(cap.value) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  /** Weertype onthouden bij elke wissel (8 dagen), voor het weericoon in het verloop. Weer-apps houden dat zelf niet bij. */
  logWeather(k) {
    if (!k) return;
    if (!this.weatherLog) this.weatherLog = this.homey.settings.get('weatherlog') || [];
    const log = this.weatherLog; const last = log[log.length - 1];
    if (last && last.k === k) return;
    const now = Date.now();
    log.push({ t: now, k });
    while (log.length > 1 && log[1].t < now - 8 * 86400000) log.shift();
    this.homey.settings.set('weatherlog', log);
  }

  async writeTarget(temp) {
    await this.turnOn().catch((err) => this.error('Thermostaat aanzetten:', err));
    this.log(`Thermostaat -> ${temp}°`);
    await this.api.devices.setCapabilityValue({
      deviceId: this.config.thermostatId,
      capabilityId: 'target_temperature',
      value: temp,
    });
  }

  /**
   * Staat de thermostaat op 'uit' (de tado X meldt dat soms bij een lage temperatuur)? Dan eerst weer aan,
   * anders doet een nieuwe temperatuur niets. Verwarmen als dat kan, anders automatisch.
   */
  async turnOn() {
    const device = await this.getDeviceSafe(this.config.thermostatId, true);
    const cap = device && device.capabilitiesObj && device.capabilitiesObj.thermostat_mode;
    if (!cap || cap.value !== 'off') return;
    const ids = (cap.values || []).map((v) => v.id);
    const mode = ['heat', 'auto'].find((m) => ids.includes(m)) || ids.find((m) => m !== 'off' && m !== 'cool') || 'heat';
    this.log(`Thermostaat aan -> ${mode}`);
    await this.api.devices.setCapabilityValue({ deviceId: this.config.thermostatId, capabilityId: 'thermostat_mode', value: mode });
  }

  /** Reageer binnen enkele seconden als iemand aan de thermostaat draait. */
  async watchThermostat() {
    if (this.targetListener) {
      try { this.targetListener.destroy(); } catch (err) { /* al weg */ }
      this.targetListener = null;
    }
    const device = await this.getDeviceSafe(this.config.thermostatId);
    if (!device || typeof device.makeCapabilityInstance !== 'function') return;
    try {
      this.targetListener = device.makeCapabilityInstance('target_temperature', (v) => {
        this.journal('apparaat', `thermostaat meldt doel ${v}°`);
        // Wacht even: de controller negeert z'n eigen wijzigingen, maar draaien
        // aan de knop geeft vaak meerdere tussenstanden.
        if (this.debounce) this.homey.clearTimeout(this.debounce);
        this.debounce = this.homey.setTimeout(() => this.controller.tick(), 2000);
      });
    } catch (err) {
      this.error('Kon thermostaat niet volgen:', err.message);
    }
  }

  /** Eerste start: kies zelf een thermostaat en een buitentemperatuur als die er zijn. */
  async autoDetect() {
    const cfg = { ...(this.homey.settings.get('config') || {}) };
    let changed = false;
    const devices = Object.values(await this.api.devices.getDevices());

    if (!cfg.thermostatId) {
      const thermostats = devices.filter((d) => (d.capabilities || []).includes('target_temperature')
        && (d.capabilities || []).includes('measure_temperature'));
      // Voorkeur: een echte thermostaat die ook luchtvochtigheid meet (virtuele schema-apparaten doen dat niet).
      const pick = thermostats.find((d) => (d.capabilities || []).includes('measure_humidity')) || thermostats[0];
      if (pick) { cfg.thermostatId = pick.id; changed = true; }
    }
    if (!cfg.outdoorDeviceId) {
      const knmi = devices.find((d) => (d.capabilities || []).includes('current_temp'));
      if (knmi) { cfg.outdoorDeviceId = knmi.id; cfg.outdoorCapability = 'current_temp'; changed = true; }
    }
    if (cfg.meterId === undefined) {
      // Slimme meter (P1) met gas: die gebruiken voor het verbruik per dag. Geen gevonden = niets tonen.
      const p1 = devices.find((d) => (d.capabilities || []).includes('meter_gas'));
      cfg.meterId = p1 ? p1.id : null; cfg.meterCapability = p1 ? 'meter_gas' : null; changed = true;
    }
    if (changed) this.homey.settings.set('config', cfg);
  }

  /** Voor de instellingenpagina: apparaten met getallen die op temperatuur lijken. */
  async listDevices() {
    const [devices, zones] = await Promise.all([
      this.api.devices.getDevices(),
      this.api.zones.getZones().catch(() => ({})),
    ]);
    return Object.values(devices)
      .map((d) => {
        const capsObj = d.capabilitiesObj || {};
        const tempCaps = (d.capabilities || []).filter((c) => {
          const o = capsObj[c];
          return o && o.type === 'number' && /temp/i.test(c);
        });
        return {
          id: d.id,
          name: d.name,
          zone: zones[d.zone] ? zones[d.zone].name : '',
          thermostat: (d.capabilities || []).includes('target_temperature'),
          ownWindow: (d.capabilities || []).includes('target_temperature') ? this.ownWindowDetection(d, capsObj) : null, // tado e.d.: doet raam open zelf
          tempCaps: tempCaps.map((c) => ({ id: c, title: (capsObj[c] && capsObj[c].title) || c })),
          // Oplopende meterstanden voor gas (m³) of stroom (kWh), zonder dag-, tarief- of terugleverwaarden.
          meterCaps: (d.capabilities || []).filter((c) => /^meter_(gas|power)(\.|$)/.test(c) && !/today|export|tariff|phase/i.test(c))
            .map((c) => ({ id: c, title: (capsObj[c] && capsObj[c].title) || c })),
        };
      })
      .filter((d) => d.thermostat || d.tempCaps.length || d.meterCaps.length)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Verloop van één dag (0 = vandaag, 1 = gisteren, … 6) voor de kaart 'Verloop'.
   * Temperaturen uit Homey Inzichten (5-minutenwaarden), stand uit de eigen standlog.
   */
  async getHistory(day = 0) {
    day = Math.max(0, Math.min(6, Math.round(day)));
    const tz = this.homey.clock.getTimezone();
    const now = Date.now();
    const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: tz }));
    const start = now - ((local.getHours() * 60 + local.getMinutes()) * 60 + local.getSeconds()) * 1000 - day * 86400000;
    const end = start + 86400000;
    const resolution = day === 0 ? 'today' : day === 1 ? 'yesterday' : 'last7Days';
    const errors = [];
    // Inzichten ophalen. Homey-versies verschillen in hoe een log heet (los 'id' of 'uri:id'), dus beide proberen.
    const toRows = (res) => {
      const raw = (res && (res.values || res.entries || res.data)) || (Array.isArray(res) ? res : []);
      return raw.map((r) => (Array.isArray(r) ? [Number(r[0]), r[1]] : [new Date(r.t != null ? r.t : r.time).getTime(), r.v != null ? r.v : r.value]))
        .filter(([t, v]) => Number.isFinite(t) && v != null && t >= start && t < end && t <= now); // niets van na 'nu'
    };
    const read = async (uri, id) => {
      // homey-api verwacht het volledige log-id ('homey:device:<id>:measure_temperature'); de korte vorm als reserve.
      for (const args of [{ id: `${uri}:${id}`, resolution }, { uri, id, resolution }]) {
        try {
          const rows = toRows(await this.api.insights.getLogEntries(args));
          if (rows.length) return rows;
        } catch (err) { errors.push(`${args.id}: ${err.message || err}`); }
      }
      return [];
    };
    const dev = this.config.thermostatId ? `homey:device:${this.config.thermostatId}` : null;
    const cfg = this.config;
    const [indoor, target, humidity, outdoor, meter] = await Promise.all([
      dev ? read(dev, 'measure_temperature') : [],
      dev ? read(dev, 'target_temperature') : [],
      dev ? read(dev, this.humidityCap || 'measure_humidity') : [],
      read('homey:manager:weather', 'temperature'),
      cfg.usage === true && cfg.meterId && cfg.meterCapability ? read(`homey:device:${cfg.meterId}`, cfg.meterCapability) : [],
    ]);
    // Verbruik van die dag (gas of stroom) en wat het kostte, als er een meter is gekozen.
    const usage = cfg.usage === true && cfg.meterId && cfg.meterCapability ? usageOf(meter, cfg.meterCapability, cfg.price) : null; // alleen als 'Verbruik en kosten' aan staat
    const log = this.controller.modeLog || [];
    const before = log.filter((x) => x.t < start).pop();
    const modes = [...(before ? [{ t: start, m: before.m }] : []), ...log.filter((x) => x.t >= start && x.t < end)];
    const wlog = this.weatherLog || this.homey.settings.get('weatherlog') || [];
    const wBefore = wlog.filter((x) => x.t < start).pop();
    const weather = [...(wBefore ? [{ t: start, k: wBefore.k }] : []), ...wlog.filter((x) => x.t >= start && x.t < end)]; // [{ t, k }] weertype
    if (!indoor.length && errors.length) this.error('Inzichten:', errors.join(' | '));
    return { day, start, end, now, room: this.controller.status.room || null, indoor, target, humidity, outdoor, weather, modes, usage, errors: indoor.length ? [] : errors.slice(0, 2) };
  }

  async runAction(body = {}) {
    // Uitzonderingen (vakantie, afwezig, pauze): niet laten wachten op een trage thermostaat (Tado gaat via de cloud).
    // Na 0,3 s antwoorden met de nieuwe stand (snelle thermostaten zijn dan al klaar); de rest gaat op de achtergrond.
    const QUICK = ['vacation', 'vacationEnd', 'vacationPlanOn', 'vacationPlanOff', 'away', 'home', 'pause', 'enable'];
    this.journal('actie', `${body.action || '?'}${Object.keys(body).length > 1 ? ` ${JSON.stringify({ ...body, action: undefined })}` : ''}`);
    const job = this.doAction(body);
    if (!QUICK.includes(body.action)) return job;
    const done = await Promise.race([job.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
    if (done) return job;
    job.catch((err) => this.error('Actie op de achtergrond:', err));
    return this.controller.quickStatus();
  }

  async doAction({ action, duration, temp, at, until, from } = {}) {
    const c = this.controller;
    switch (action) {
      case 'setTemp': await c.setManual(Math.round(Number(temp) * 2) / 2, duration, 'app'); break; // −/+ in de tegel
      case 'resume': await c.clearOverride(); break;
      case 'setDuration': await c.setOverrideDuration(duration); break;
      case 'away': await c.setAway(true, true); break; // zelf gekozen: pauze en vakantie uit
      case 'home': await c.setAway(false, true); break;
      case 'pause': await c.setEnabled(false); break;
      case 'enable': await c.setEnabled(true); break;
      case 'start': await c.setEnabled(true); break; // eerste keer: welkomstkaart 'Start slim verwarmen'
      case 'resetLearning': c.resetLearning(); await c.tick(); break;
      case 'deleteSample': c.deleteSample(Number(at)); await c.tick(); break; // één meting weg
      case 'windowOff': await c.startWindow(duration); break; // raam open: verwarming even uit
      case 'windowIgnore': await c.ignoreWindow(); break;
      case 'windowEnd': await c.stopWindow(); break; // raam weer dicht
      case 'vacation': await c.setVacation(Number(until), from == null ? undefined : Number(from)); break; // tot het begin van de terugkomstdag; met `from` gepland
      case 'vacationEnd': await c.stopVacation(); break;
      case 'vacationPlanOn': await c.setVacationPlanOn(true); break; // geplande vakantie weer aan (datums bewaard)
      case 'vacationPlanOff': await c.setVacationPlanOn(false); break; // geplande vakantie uit, datums blijven staan
      default: await c.tick();
    }
    return c.status;
  }

  // ---------- Flow ----------

  registerFlowCards() {
    const c = this.controller;
    const flow = this.homey.flow;
    const act = (id) => ({ registerRunListener: (fn) => flow.getActionCard(id).registerRunListener((args, state) => { this.journal('flow', `${id} ${line([args])}`); return fn(args, state); }) });

    act('set_presence').registerRunListener(({ mode }) => c.setAway(mode === 'away', true));
    act('resume_schedule').registerRunListener(() => c.clearOverride());
    act('set_temporary').registerRunListener(({ temp, hours }) => c.setOverride(temp, hours));
    act('set_manual').registerRunListener(({ temp, duration }) => c.setManual(temp, duration, 'flow'));
    act('set_enabled').registerRunListener(({ state }) => c.setEnabled(state === 'on'));
    // Met een raamsensor: open = verwarming uit (tot het raam dicht is, maximaal 4 uur), dicht = verder waar hij was.
    act('set_window').registerRunListener(({ state }) => (state === 'open' ? c.startWindow(240) : c.stopWindow()));
    // Prijs per m³/kWh vanuit een flow (bijv. met een tag van de app van je energieleverancier), zodat de kosten actueel blijven.
    act('set_price').registerRunListener(({ price }) => {
      const p = Math.round(Number(price) * 1000) / 1000;
      if (!Number.isFinite(p) || p < 0) throw new Error('Ongeldige prijs');
      this.homey.settings.set('config', { ...(this.homey.settings.get('config') || {}), price: p });
      return true;
    });

    flow.getConditionCard('is_manual').registerRunListener(() => !!c.state.override);
    flow.getConditionCard('is_preheating').registerRunListener(() => c.status.mode === 'preheat');
    flow.getConditionCard('is_window').registerRunListener(() => !!c.state.window);

    this.triggers = {
      override_started: flow.getTriggerCard('override_started'),
      override_ended: flow.getTriggerCard('override_ended'),
      setpoint_changed: flow.getTriggerCard('setpoint_changed'),
      learned: flow.getTriggerCard('learned'),
      window_open: flow.getTriggerCard('window_open'),
    };
  }

  // ---------- Logboek ----------

  journal(kind, msg) {
    if (!this.journalLog) { const j = this.homey.settings.get('journal'); this.journalLog = Array.isArray(j) ? j : []; }
    const e = { t: Date.now(), k: kind, m: String(msg).slice(0, 600) };
    this.journalLog.push(e);
    if (this.journalLog.length > JOURNAL_MAX) this.journalLog.splice(0, this.journalLog.length - JOURNAL_MAX);
    try { this.homey.api.realtime('journal', e); } catch (err) { /* geen pagina open */ }
    if (!this.journalTimer) {
      this.journalTimer = this.homey.setTimeout(() => {
        this.journalTimer = null;
        try { this.homey.settings.set('journal', this.journalLog); } catch (err) { /* volgende keer */ }
      }, 5000);
    }
  }

  getJournal() {
    return { tz: this.homey.clock.getTimezone(), version: this.homey.manifest.version, now: Date.now(), entries: this.journalLog || this.homey.settings.get('journal') || [] };
  }

  clearJournal() {
    this.journalLog = []; this.homey.settings.set('journal', []);
    this.journal('start', 'logboek gewist');
    return this.getJournal();
  }

  async notifyManual() {
    const d = this.lastManual; this.manualTimer = null; if (!d) return;
    // Wie het deed, vertelt Homey een app niet; wel waar het vandaan kwam.
    // Geen eindtijd: een melding kan achteraf niet meer worden aangepast, en de duur kan nog veranderen.
    const where = { thermostat: 'via de thermostaat', app: 'via Homey', flow: 'via een flow' }[d.via] || '';
    await this.homey.notifications.createNotification({
      excerpt: `Handmatig op **${String(d.temp).replace('.', ',')}°** gezet ${where}.`,
    });
  }

  formatTime(ms) {
    return new Date(ms).toLocaleTimeString('nl-NL', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    });
  }

  async onControllerEvent(event, data) {
    if (event === 'status') {
      const sig = `${data.mode}|${data.target}`;
      if (sig !== this.lastSig) { // standwissel of nieuw doel: één regel, geen regel per minuut
        this.journal('stand', `${this.lastSig ? this.lastSig.replace('|', ' ') + '° -> ' : ''}${data.mode} ${data.target}°  binnen ${data.indoor}°  (${data.modeLabel || ''})`);
        this.lastSig = sig;
      }
      // Live naar een geopende instellingenpagina sturen.
      this.homey.api.realtime('status', data);
      const driver = this.homey.drivers.getDriver('thermostat');
      for (const device of driver.getDevices()) await device.showStatus(data).catch(this.error);
      return;
    }
    this.journal('gebeurt', `${event} ${data == null ? '' : line([data])}`);
    // Boven het maximum teruggezet: melding in de Homey-tijdlijn, zodat je ziet dat er is ingegrepen.
    if (event === 'setpoint_changed' && data.reason === 'limit') {
      const f = (v) => `${String(v).replace('.', ',')}°`;
      await this.homey.notifications.createNotification({
        excerpt: `Thermostaat teruggezet van ${f(data.from)} naar **${f(data.temp)}** (maximumtemperatuur).`,
      }).catch(this.error);
    }
    // Raam open? Melding in de tijdlijn; kiezen doe je in de widget (of met een flow op deze trigger).
    if (event === 'window_open') {
      const f = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')}°`;
      const room = this.controller.status.room ? ` in de ${this.controller.status.room.toLowerCase()}` : '';
      await this.homey.notifications.createNotification({
        excerpt: `Staat er een raam open${room}? De temperatuur zakte snel van ${f(data.from)} naar ${f(data.to)}. In de widget kun je de verwarming ${this.controller.windowMinutes()} minuten ${this.controller.windowTemp() === WINDOW_TEMP ? 'uitzetten' : 'lager zetten'}.`,
      }).catch(this.error);
    }
    // Raam is open geweest: achteraf één melding in de tijdlijn met hoe lang.
    if (event === 'window_closed' && data.since) {
      const min = Math.round((data.until - data.since) / 60000);
      if (min >= 1) {
        // Alleen hoe lang; wanneer zie je aan het tijdstip van de melding.
        const dur = min < 60 ? `${min} min` : `${Math.floor(min / 60)} uur${min % 60 ? ` ${min % 60} min` : ''}`;
        const excerpt = data.device ? `Thermostaat meldde **${dur}** een open raam.`
          : `Raam stond **${dur}** open, verwarming stond ${data.temp != null && data.temp > WINDOW_TEMP ? `lager (${String(data.temp).replace('.', ',')}°)` : 'uit'}.`;
        await this.homey.notifications.createNotification({ excerpt }).catch(this.error);
      }
    }
    // Handmatig verstellen: één melding nadat het een minuut stil is (vijf keer op + = één melding met de eindstand).
    if (event === 'manual_change') {
      this.lastManual = data;
      if (this.manualTimer) this.homey.clearTimeout(this.manualTimer);
      this.manualTimer = this.homey.setTimeout(() => this.notifyManual().catch(this.error), 60000);
    }
    const card = this.triggers && this.triggers[event];
    if (!card) return;
    if (event === 'override_started') {
      await card.trigger({ temp: data.temp, until: data.until == null ? 'schema hervat' : this.formatTime(data.until) });
    } else if (event === 'setpoint_changed') {
      await card.trigger({ temp: data.temp, reason: REASONS[data.reason] || data.reason });
    } else if (event === 'window_open') {
      await card.trigger({ drop: data.drop, temp: data.to });
    } else if (event === 'learned') {
      await card.trigger({ rate: data.rate, dead_time: data.deadTime });
    } else {
      await card.trigger();
    }
  }

}

module.exports = SlimVerwarmenApp;
