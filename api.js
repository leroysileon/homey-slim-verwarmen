'use strict';

module.exports = {
  async getDevices({ homey }) {
    return homey.app.listDevices();
  },
  async getStatus({ homey }) {
    return homey.app.controller.status;
  },
  async postAction({ homey, body }) {
    return homey.app.runAction(body);
  },
};
