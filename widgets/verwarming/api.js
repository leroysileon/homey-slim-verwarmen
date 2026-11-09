'use strict';

module.exports = {
  async getStatus({ homey }) {
    return {
      status: homey.app.controller.status,
      schedule: homey.app.controller.schedule,
    };
  },
  async getHistory({ homey }) {
    return homey.app.getHistory(0); // vandaag, voor de tweede pagina van de widget
  },
  async postAction({ homey, body }) {
    const c = homey.app.controller;
    const status = await homey.app.runAction(body); // kan een snelle status zijn (thermostaat volgt op de achtergrond)
    return { status, schedule: c.schedule };
  },
};
