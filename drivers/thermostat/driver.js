'use strict';

const Homey = require('homey');

class SlimVerwarmenDriver extends Homey.Driver {
  async onPairListDevices() {
    return [{ name: 'Slim verwarmen', data: { id: 'slim-verwarmen' } }];
  }
}

module.exports = SlimVerwarmenDriver;
