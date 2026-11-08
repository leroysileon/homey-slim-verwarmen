'use strict';

/**
 * Weekschema-logica. Alles werkt in "minuut van de week" (MOW) in lokale tijd:
 * zondag 00:00 = 0, maandag 00:00 = 1440, ... zaterdag 23:59 = 10079.
 *
 * Schema-formaat:
 *   { sun: [{ time: '07:00', temp: 20 }, ...], mon: [...], ... }
 * Een dag zonder blokken zet gewoon het laatste blok van de dag ervoor voort.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEK = 7 * 1440;

function parseTime(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Zet het schema om naar een gesorteerde lijst { mow, temp }. */
function toEvents(schedule) {
  const events = [];
  if (!schedule) return events;
  DAYS.forEach((day, dayIndex) => {
    for (const block of schedule[day] || []) {
      const minutes = parseTime(block.time);
      const temp = Number(block.temp);
      if (minutes === null || !Number.isFinite(temp)) continue;
      events.push({ mow: dayIndex * 1440 + minutes, temp });
    }
  });
  events.sort((a, b) => a.mow - b.mow);
  // Dubbele tijden: laatste wint.
  return events.filter((e, i) => i === events.length - 1 || events[i + 1].mow !== e.mow);
}

/** Lokale dag en minuut voor een Date in een tijdzone. */
function localMow(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return dayIndex * 1440 + Number(get('hour')) * 60 + Number(get('minute'));
}

/** Aantal minuten van nowMow tot targetMow (altijd vooruit, 1..WEEK). */
function minutesUntil(nowMow, targetMow) {
  const diff = (((targetMow - nowMow) % WEEK) + WEEK) % WEEK;
  return diff === 0 ? WEEK : diff;
}

/**
 * Huidig blok en het volgende blok.
 * @returns {null | { current: {mow,temp}, next: {mow,temp}, minutesToNext: number }}
 */
function currentAndNext(events, nowMow) {
  if (!events.length) return null;
  let idx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].mow <= nowMow) idx = i;
  }
  const current = idx === -1 ? events[events.length - 1] : events[idx];
  // Volgende blok met een ándere temperatuur (zelfde temp = geen wisseling).
  let next = null;
  let minutesToNext = null;
  for (let step = 1; step <= events.length; step++) {
    const candidate = events[(idx + step + events.length) % events.length];
    if (candidate.temp !== current.temp) {
      next = candidate;
      minutesToNext = minutesUntil(nowMow, candidate.mow);
      break;
    }
  }
  if (!next) {
    next = current;
    minutesToNext = WEEK;
  }
  return { current, next, minutesToNext };
}

function formatMow(mow) {
  const dayNames = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const day = Math.floor(mow / 1440) % 7;
  const m = mow % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${dayNames[day]} ${hh}:${mm}`;
}

const DEFAULT_SCHEDULE = DAYS.reduce((acc, day) => {
  const weekend = day === 'sat' || day === 'sun';
  acc[day] = weekend
    ? [{ time: '08:00', temp: 20 }, { time: '23:00', temp: 16 }]
    : [{ time: '06:30', temp: 20 }, { time: '08:30', temp: 16 }, { time: '16:00', temp: 20 }, { time: '22:30', temp: 16 }]; // werkweek met gezin: overdag weg
  return acc;
}, {});

module.exports = {
  DAYS,
  WEEK,
  DEFAULT_SCHEDULE,
  parseTime,
  toEvents,
  localMow,
  minutesUntil,
  currentAndNext,
  formatMow,
};
