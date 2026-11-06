'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Controller } = require('./lib/controller');
const { weatherOf } = require('./lib/weather');

const TICK_MS = 60 * 1000;
const REASONS = { schedule: 'schema', preheat: 'voorverwarmen', away: 'afwezig' };

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
        writeTarget: (temp) => this.writeTarget(temp),
      },
      store: this.homey.settings,
      log: (...args) => this.log(...args),
      onEvent: (event, data) => this.onControllerEvent(event, data).catch(this.error),
    });

    this.registerFlowCards();
    await this.autoDetect();

    this.homey.settings.on('set', (key) => {
      if (key === 'schedule' || key === 'config') {
        this.watchThermostat().catch(this.error);
        this.controller.tick();
      }
    });

    await this.watchThermostat();
    this.homey.setInterval(() => this.controller.tick(), TICK_MS);
    await this.controller.tick();
    this.log('Slim verwarmen gestart');
  }

  get config() {
    return this.controller.config;
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
      humidity: caps.measure_humidity ? caps.measure_humidity.value : null,
    };
  }

  async readOutdoor() {
    const { outdoorDeviceId, outdoorCapability } = this.config;
    const device = await this.getDeviceSafe(outdoorDeviceId, true);
    const cap = device && device.capabilitiesObj && device.capabilitiesObj[outdoorCapability];
    // Weertype voor het icoon in de widget (zon, wolk, regen, …), als het apparaat een omschrijving heeft.
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() }));
    this.lastWeather = device ? weatherOf(device, t.getHours() * 60 + t.getMinutes()) : null;
    const value = cap ? Number(cap.value) : NaN;
    return Number.isFinite(value) ? value : null;
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
          tempCaps: tempCaps.map((c) => ({ id: c, title: (capsObj[c] && capsObj[c].title) || c })),
        };
      })
      .filter((d) => d.thermostat || d.tempCaps.length)
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
    const [indoor, target, humidity, outdoor] = await Promise.all([
      dev ? read(dev, 'measure_temperature') : [],
      dev ? read(dev, 'target_temperature') : [],
      dev ? read(dev, 'measure_humidity') : [],
      read('homey:manager:weather', 'temperature'),
    ]);
    const log = this.controller.modeLog || [];
    const before = log.filter((x) => x.t < start).pop();
    const modes = [...(before ? [{ t: start, m: before.m }] : []), ...log.filter((x) => x.t >= start && x.t < end)];
    if (!indoor.length && errors.length) this.error('Inzichten:', errors.join(' | '));
    return { day, start, end, now, room: this.controller.status.room || null, indoor, target, humidity, outdoor, modes, errors: indoor.length ? [] : errors.slice(0, 2) };
  }

  async runAction({ action, duration, temp } = {}) {
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

    flow.getConditionCard('is_manual').registerRunListener(() => !!c.state.override);
    flow.getConditionCard('is_preheating').registerRunListener(() => c.status.mode === 'preheat');

    this.triggers = {
      override_started: flow.getTriggerCard('override_started'),
      override_ended: flow.getTriggerCard('override_ended'),
      setpoint_changed: flow.getTriggerCard('setpoint_changed'),
      learned: flow.getTriggerCard('learned'),
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
    const card = this.triggers && this.triggers[event];
    if (!card) return;
    if (event === 'override_started') {
      await card.trigger({ temp: data.temp, until: data.until == null ? 'schema hervat' : this.formatTime(data.until) });
    } else if (event === 'setpoint_changed') {
      await card.trigger({ temp: data.temp, reason: REASONS[data.reason] || data.reason });
    } else if (event === 'learned') {
      await card.trigger({ rate: data.rate, dead_time: data.deadTime });
    } else {
      await card.trigger();
    }
  }

}

module.exports = SlimVerwarmenApp;
