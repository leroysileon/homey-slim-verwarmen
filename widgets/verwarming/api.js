'use strict';

module.exports = {
  async getStatus({ homey }) {
    return {
      status: homey.app.controller.status,
      schedule: homey.app.controller.schedule,
    };
  },
  async postAction({ homey, body }) {
    const c = homey.app.controller;
    await homey.app.runAction(body);
    return { status: c.status, schedule: c.schedule };
  },
};
