'use strict';

/**
 * Aanwezigheid uit de Homey-gebruikers (locatie via de Homey-app).
 * Geen Homey-code, zodat het los te testen is.
 */

/** Wie er thuis is. Alleen ingeschakelde gebruikers tellen mee. */
function presenceOf(users) {
  const list = Object.values(users || {}).filter((u) => u && u.enabled !== false);
  const home = list.filter((u) => u.present === true).map((u) => u.name).filter(Boolean);
  return { anyHome: home.length > 0, home, count: list.length };
}

/**
 * Reageert alleen op een echte wissel: de laatste vertrekt ('away') of de eerste komt thuis ('home').
 * De eerste meting na het opstarten zet alleen de beginstand, zodat een herstart niets omzet.
 */
class PresenceWatcher {
  constructor() {
    this.last = null;
  }

  update(anyHome) {
    const prev = this.last;
    this.last = !!anyHome;
    if (prev === null || prev === this.last) return null;
    return this.last ? 'home' : 'away';
  }
}

module.exports = { presenceOf, PresenceWatcher };
