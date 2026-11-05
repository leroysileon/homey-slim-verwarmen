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
    if (body && body.action === 'setTemp') await c.setManual(Math.round(Number(body.temp) * 2) / 2, body.duration);
    else await homey.app.runAction(body);
    return { status: c.status, schedule: c.schedule };
  },
};
