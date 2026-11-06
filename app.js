'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Controller } = require('./lib/controller');

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

  async readThermostat() {
    const device = await this.getDeviceSafe(this.config.thermostatId, true);
    if (!device || !device.capabilitiesObj) return null;
    const caps = device.capabilitiesObj;
    return {
      target: caps.target_temperature ? caps.target_temperature.value : null,
      indoor: caps.measure_temperature ? caps.measure_temperature.value : null,
      humidity: caps.measure_humidity ? caps.measure_humidity.value : null,
    };
  }

  async readOutdoor() {
    const { outdoorDeviceId, outdoorCapability } = this.config;
    const device = await this.getDeviceSafe(outdoorDeviceId, true);
    const cap = device && device.capabilitiesObj && device.capabilitiesObj[outdoorCapability];
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

  /** Eerste start: kies zelf de Tado en de KNMI-buitentemperatuur als die er zijn. */
  async autoDetect() {
    const cfg = { ...(this.homey.settings.get('config') || {}) };
    let changed = false;
    const devices = Object.values(await this.api.devices.getDevices());

    if (!cfg.thermostatId) {
      const thermostats = devices.filter((d) => (d.capabilities || []).includes('target_temperature')
        && (d.capabilities || []).includes('measure_temperature'));
      const pick = thermostats.find((d) => /tado/i.test(d.name)) || thermostats[0];
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

  async runAction({ action, duration } = {}) {
    const c = this.controller;
    switch (action) {
      case 'resume': await c.clearOverride(); break;
      case 'setDuration': await c.setOverrideDuration(duration); break;
      case 'away': await c.setAway(true); break;
      case 'home': await c.setAway(false); break;
      case 'pause': await c.setEnabled(false); break;
      case 'enable': await c.setEnabled(true); break;
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
