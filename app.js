'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Controller, WINDOW_TEMP } = require('./lib/controller');
const { weatherOf } = require('./lib/weather');
const { presenceOf, PresenceWatcher } = require('./lib/presence');
const { usageOf } = require('./lib/usage');

const TICK_MS = 60 * 1000;
const REASONS = { schedule: 'schema', preheat: 'voorverwarmen', away: 'afwezig', limit: 'maximumtemperatuur', window: 'raam open', restore: 'raam dicht' };

class SlimVerwarmenApp extends Homey.App {

  async onInit() {
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
    this.log(`Thermostaat -> ${temp}°`);
    await this.api.devices.setCapabilityValue({
      deviceId: this.config.thermostatId,
      capabilityId: 'target_temperature',
      value: temp,
    });
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
      this.targetListener = device.makeCapabilityInstance('target_temperature', () => {
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

  async runAction({ action, duration, temp, at } = {}) {
    const c = this.controller;
    switch (action) {
      case 'setTemp': await c.setManual(Math.round(Number(temp) * 2) / 2, duration); break; // −/+ in de tegel
      case 'resume': await c.clearOverride(); break;
      case 'setDuration': await c.setOverrideDuration(duration); break;
      case 'away': await c.setAway(true); break;
      case 'home': await c.setAway(false); break;
      case 'pause': await c.setEnabled(false); break;
      case 'enable': await c.setEnabled(true); break;
      case 'start': await c.setEnabled(true); break; // eerste keer: welkomstkaart 'Start slim verwarmen'
      case 'resetLearning': c.resetLearning(); await c.tick(); break;
      case 'deleteSample': c.deleteSample(Number(at)); await c.tick(); break; // één meting weg
      case 'windowOff': await c.startWindow(duration); break; // raam open: verwarming even uit
      case 'windowIgnore': await c.ignoreWindow(); break;
      case 'windowEnd': await c.stopWindow(); break; // raam weer dicht
      default: await c.tick();
    }
    return c.status;
  }

  // ---------- Flow ----------

  registerFlowCards() {
    const c = this.controller;
    const flow = this.homey.flow;

    flow.getActionCard('set_presence').registerRunListener(({ mode }) => c.setAway(mode === 'away'));
    flow.getActionCard('resume_schedule').registerRunListener(() => c.clearOverride());
    flow.getActionCard('set_temporary').registerRunListener(({ temp, hours }) => c.setOverride(temp, hours));
    flow.getActionCard('set_manual').registerRunListener(({ temp, duration }) => c.setManual(temp, duration));
    flow.getActionCard('set_enabled').registerRunListener(({ state }) => c.setEnabled(state === 'on'));
    // Met een raamsensor: open = verwarming uit (tot het raam dicht is, maximaal 4 uur), dicht = verder waar hij was.
    flow.getActionCard('set_window').registerRunListener(({ state }) => (state === 'open' ? c.startWindow(240) : c.stopWindow()));
    // Prijs per m³/kWh vanuit een flow (bijv. met een tag van de app van je energieleverancier), zodat de kosten actueel blijven.
    flow.getActionCard('set_price').registerRunListener(({ price }) => {
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

  formatTime(ms) {
    return new Date(ms).toLocaleTimeString('nl-NL', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    });
  }

  async onControllerEvent(event, data) {
    if (event === 'status') {
      // Live naar een geopende instellingenpagina sturen.
      this.homey.api.realtime('status', data);
      const driver = this.homey.drivers.getDriver('thermostat');
      for (const device of driver.getDevices()) await device.showStatus(data).catch(this.error);
      return;
    }
    // Boven het maximum teruggezet: melding in de Homey-tijdlijn, zodat je ziet dat er is ingegrepen.
    if (event === 'setpoint_changed' && data.reason === 'limit') {
      const f = (v) => `${String(v).replace('.', ',')}°`;
      await this.homey.notifications.createNotification({
        excerpt: `Slim verwarmen: thermostaat teruggezet van ${f(data.from)} naar ${f(data.temp)} (maximumtemperatuur).`,
      }).catch(this.error);
    }
    // Raam open? Melding in de tijdlijn; kiezen doe je in de widget (of met een flow op deze trigger).
    if (event === 'window_open') {
      const f = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')}°`;
      const room = this.controller.status.room ? ` in de ${this.controller.status.room.toLowerCase()}` : '';
      await this.homey.notifications.createNotification({
        excerpt: `Slim verwarmen: staat er een raam open${room}? De temperatuur zakte snel van ${f(data.from)} naar ${f(data.to)}. In de widget kun je de verwarming ${this.controller.windowMinutes()} minuten ${this.controller.windowTemp() === WINDOW_TEMP ? 'uitzetten' : 'lager zetten'}.`,
      }).catch(this.error);
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
