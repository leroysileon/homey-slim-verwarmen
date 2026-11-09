'use strict';

module.exports = {
  async getDevices({ homey }) {
    return homey.app.listDevices();
  },
  async getStatus({ homey }) {
    return homey.app.controller.status;
  },
  async getHistory({ homey, query }) {
    return homey.app.getHistory(Number(query && query.day) || 0);
  },
  async getLog({ homey }) {
    return homey.app.getJournal();
  },
  async deleteLog({ homey }) {
    return homey.app.clearJournal();
  },
  async postAction({ homey, body }) {
    return homey.app.runAction(body);
  },
};
