'use strict';
// De statustegel op de instellingenpagina ís de widget: settings/tile.html is een kopie van het widgetbestand.
// Na een wijziging aan de widget: node dev/sync-tile.js (de test 'tegel gelijk aan widget' bewaakt dit).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, 'widgets/verwarming/public/index.html'), path.join(root, 'settings/tile.html'));
console.log('settings/tile.html bijgewerkt');
