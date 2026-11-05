'use strict';

const Homey = require('homey');

/**
 * Laat het schema zien in het Klimaat-overzicht van Homey.
 * De temperatuur hier verzetten werkt als draaien aan de thermostaat:
 * die stand geldt zo lang als ingesteld bij 'Handmatige stand geldt' (standaard tot het volgende blok).
 */
class SlimVerwarmenDevice extends Homey.Device {
  async onInit() {
    const controller = () => {
      if (!this.homey.app.controller) throw new Error('Slim verwarmen is nog aan het opstarten');
      return this.homey.app.controller;
    };
    this.registerCapabilityListener('target_temperature', (value) => controller().setManual(value));
    this.registerCapabilityListener('sv_resume', () => controller().clearOverride());
    const status = this.homey.app.controller && this.homey.app.controller.status;
    if (status && status.updatedAt) await this.showStatus(status);
  }

  async showStatus(s) {
    const set = async (cap, value) => {
      if (value === null || value === undefined || !this.hasCapability(cap)) return;
      if (this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value).catch(this.error);
    };
    await set('target_temperature', s.thermostatTarget);
    await set('measure_temperature', s.indoor);
    await set('sv_mode', s.modeLabel);
    await set('sv_next', s.nextLabel);
  }
}

module.exports = SlimVerwarmenDevice;
