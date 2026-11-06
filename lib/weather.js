'use strict';

/**
 * Weertype uit een weer-apparaat halen, los van het merk of de app.
 * Zoekt een tekst-capability met een omschrijving ("Onbewolkt", "Lichte regen", "Partly cloudy", …)
 * en zet die om naar een icoon: clear, partly, cloudy, rain, snow, fog, thunder.
 * 's Nachts wordt 'clear' 'night' en 'partly' 'nightpartly' (zon onder volgens het apparaat, anders 18–7 uur).
 */
const TEXT_CAPS = ['recap', 'weather_condition', 'condition', 'weather', 'conditions', 'summary', 'description', 'measure_weather', 'weather_description'];

const RULES = [
  ['clear', /onbewolkt|wolkeloos|wolkenloos|cloudless/], // vóór 'bewolkt'
  ['thunder', /onweer|thunder|storm/],
  ['snow', /sneeuw|hagel|ijzel|snow|sleet|hail/],
  ['rain', /regen|bui|motregen|drizzle|rain|shower/],
  ['fog', /mist|nevel|fog|mist|haze/],
  ['partly', /half ?bewolkt|licht bewolkt|wisselend|opklaring|partly|few clouds|scattered/],
  ['cloudy', /bewolkt|betrokken|cloud|overcast/],
  ['clear', /onbewolkt|zon|helder|clear|sunny|fair/],
];

function classify(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  return null;
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** device: Homey-apparaat met capabilitiesObj; nowMin: minuten sinds middernacht (lokale tijd). */
function weatherOf(device, nowMin) {
  const caps = (device && device.capabilitiesObj) || {};
  let kind = null;
  for (const id of TEXT_CAPS) {
    if (caps[id] && typeof caps[id].value === 'string') { kind = classify(caps[id].value); if (kind) break; }
  }
  if (!kind) return null;
  const up = toMinutes(caps.sun_up && caps.sun_up.value) ?? 7 * 60;
  const down = toMinutes(caps.sun_down && caps.sun_down.value) ?? 18 * 60;
  const dark = nowMin < up || nowMin >= down;
  if (dark && kind === 'clear') return 'night';
  if (dark && kind === 'partly') return 'nightpartly';
  return kind;
}

module.exports = { weatherOf, classify };
