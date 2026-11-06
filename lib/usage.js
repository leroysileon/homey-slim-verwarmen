'use strict';

/**
 * Verbruik van één dag uit een oplopende meterstand (gas in m³ of stroom in kWh).
 * Geen Homey-code, zodat het los te testen is.
 */

/** Eenheid bij een meter-capability. */
const unitOf = (cap) => (/^meter_gas/.test(String(cap)) ? 'm³' : 'kWh');

/** Standaardprijs als je zelf nog niets hebt ingevuld (euro per eenheid). */
const defaultPrice = (cap) => (unitOf(cap) === 'm³' ? 1.4 : 0.3);

/**
 * rows: [[tijd, meterstand], …] van één dag. Telt alle stijgingen op; een daling (meter vervangen of teruggezet)
 * telt niet mee, zodat de dag niet negatief of absurd hoog wordt.
 */
function usageOf(rows, cap, price) {
  const vals = (rows || []).map((r) => Number(r[1])).filter(Number.isFinite);
  if (vals.length < 2) return null;
  let amount = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1]) amount += vals[i] - vals[i - 1];
  const p = Number.isFinite(Number(price)) && Number(price) >= 0 ? Number(price) : defaultPrice(cap);
  amount = Math.round(amount * 100) / 100;
  return { amount, unit: unitOf(cap), price: p, cost: Math.round(amount * p * 100) / 100 };
}

module.exports = { usageOf, unitOf, defaultPrice };
