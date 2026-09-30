// The board in a real yard (ADR 0009, audit #3, #22). Send and Bring back make an order of EXACT pieces (the number typed is kept; the pack
// size is a hint beside it, never a gate), then offer a truck and driver; nothing on the map moves until a person confirms a step. Trucks
// are listed by their last confirmed step (state.liveBoard), and each confirmed delivery is replayed once on this screen. Pure: no DOM at
// import (the board's tests import it in Node).
import { esc, num } from './visual.js';

/** The free pieces per product from GET /api/live-items. @param {any[]|null} list */
export const glFree = (list) => new Map((list ?? []).map((x) => [x.product, x]));
/**
 * The first amount when a part is tapped. Send: one pack if that many are free, else all that is free. Bring back: all of it on the site
 * (loose pieces on a site come in no packs); the owner types fewer if fewer come back.
 * @param {any} item @param {string} [mode]
 */
export const glFirst = (item, mode = 'send') => {
  if (!item || !(item.free > 0)) return 0;
  if (mode === 'back') return item.free;
  return item.pack > 0 && item.pack <= item.free ? item.pack : item.free;
};
// Today's booking times: 5:00 am to 5:00 pm, every half hour (src/domain/plantime.js PLAN_TIMES).
export const GL_TIMES = [];
for (let h = 5; h <= 17; h++)
  for (const m of [0, 30]) if (h < 17 || m === 0) GL_TIMES.push(String(h).padStart(2, '0') + ':' + (m ? '30' : '00'));
/** "7:00 am" @param {string} t */
export const glTimeWords = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return ((h + 11) % 12) + 1 + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'am' : 'pm');
};
/**
 * The time a booking starts at: an hour after that truck's last trip that day, else 7:00 am; today, never a time already gone.
 * @param {any[]|null} trips that day's trips (GET /api/trips?day=) @param {string} truck @param {string} day @param {string} today @param {number} [now]
 */
export function glSuggestTime(trips, truck, day, today, now = Date.now()) {
  const last = (trips ?? [])
    .filter((t) => t.truck === truck && t.day === day && t.state !== 'CANCELLED')
    .map((t) => t.time)
    .sort()
    .at(-1);
  let want = '07:00';
  if (last) {
    const [h, m] = last.split(':').map(Number);
    want = String(Math.min(23, h + 1)).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  if (day === today) {
    const d = new Date(now),
      hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (want <= hm) want = hm;
  }
  return GL_TIMES.find((t) => t >= want) ?? GL_TIMES.at(-1);
}
/** "13 pieces · packs of 30" and, when more is asked than is free, how many are short. */
export function glWords(q, item, mode) {
  const free = item?.free ?? 0,
    where = mode === 'back' ? 'on site' : 'in the yard';
  let w = q ? num(q) + (q === 1 ? ' piece' : ' pieces') : 'None yet';
  if (q && q > free) w += ' · only ' + num(free) + ' free ' + where;
  return w;
}
/** The amount row: the exact number, a slider in single pieces up to what is free, and the pack size as a hint. */
export function glAmountHTML(p, q, item, mode, pic) {
  const free = item?.free ?? 0,
    max = Math.max(free, q),
    pack = item?.pack > 0 ? item.pack : null;
  return (
    '<div class="gm-amt gm-amt-live"><div class="gm-amt-top">' +
    pic +
    '<div class="gm-amt-name"><b>' +
    esc(p.name) +
    '</b><small data-gm-words>' +
    esc(glWords(q, item, mode)) +
    '</small></div><button type="button" class="gm-chip" data-gm-unpick>Remove</button></div>' +
    '<div class="gm-amt-row"><button type="button" class="gm-step" data-gm-step="-1" aria-label="One less">&minus;</button><input type="range" class="gm-range" data-gm-live data-gm-range min="0" max="' +
    max +
    '" step="1" value="' +
    q +
    '" aria-label="How many of ' +
    esc(p.name) +
    '"><button type="button" class="gm-step" data-gm-step="1" aria-label="One more">+</button><input type="number" class="gm-num" data-gm-live data-gm-num min="0" step="1" value="' +
    q +
    '" inputmode="numeric" aria-label="Amount of ' +
    esc(p.name) +
    '"></div>' +
    '<p class="gm-pack-hint">' +
    (mode === 'back'
      ? 'Exact pieces: the number you type is what the driver collects.'
      : pack
        ? 'Comes in packs of ' +
          num(pack) +
          (q && q % pack ? ' · ' + num(q) + ' is kept exactly' : '') +
          ' · <button type="button" class="gm-link" data-gm-pack="' +
          pack +
          '">Round to a pack</button>'
        : 'Exact pieces: the number you type is what is held and sent.') +
    '</p></div>'
  );
}
// The trucks in words, top left: only the ones with something recorded today (booked, on the road, at a site). Tap one to follow it.
const STATE_CLASS = { BOOKED: 'wait', TO_SITE: 'road', TO_YARD: 'road', AT_SITE: 'busy' };
/** @param {any} s @param {string|null} on @param {(t:any)=>string} pic */
export function glTripsHTML(s, on, pic) {
  const lb = s?.liveBoard;
  if (!lb) return '';
  const byId = new Map((s.trucks ?? []).map((t) => [t.id, t]));
  return (lb.trucks ?? [])
    .filter((x) => x.state !== 'PARKED')
    .map((x) => {
      const t = byId.get(x.truck),
        warn = x.late || x.flag;
      return (
        '<button type="button" class="gm-trip ' +
        (warn ? 'warn' : (STATE_CLASS[x.state] ?? 'idle')) +
        (x.estimate ? ' is-estimate' : '') +
        (on === x.truck ? ' on' : '') +
        '" data-gm-truck="' +
        esc(x.truck) +
        '" title="' +
        esc(x.name + ': ' + (x.words ?? '')) +
        '">' +
        (t ? pic(t) : '') +
        '<span class="gm-trip-t"><b>' +
        esc(glTripTitle(s, x)) +
        '</b><small>' +
        esc(warn ? (x.flag?.words ?? 'Late: not confirmed yet') : (x.words ?? '')) +
        '</small></span></button>'
      );
    })
    .join('');
}
const placeName = (s, id) =>
  (s?.sites ?? []).find((x) => x.id === id)?.name ?? (s?.yards ?? []).find((y) => y.id === id)?.name ?? 'the site';
/** @param {any} s @param {any} x */
export function glTripTitle(s, x) {
  if (x.state === 'BOOKED') return x.name + ' · booked';
  if (x.state === 'TO_SITE') return x.name + ' → ' + placeName(s, x.to);
  if (x.state === 'TO_YARD') return x.name + ' → yard';
  if (x.state === 'AT_SITE') return x.name + ' at ' + placeName(s, x.place);
  return x.name + ' at the yard';
}
/** The board's row for one truck in a real yard, or null. @param {any} s @param {string} id */
export const glRow = (s, id) => (s?.liveBoard?.trucks ?? []).find((x) => x.truck === id) ?? null;
/** The truck window's words in a real yard. @param {any} s @param {any} t */
export function glTruckWord(s, t) {
  const x = glRow(s, t.id);
  if (!x) return 'Parked at the yard';
  if (x.state === 'PARKED') return 'Parked at the yard';
  return (
    glTripTitle(s, x)
      .replace(x.name + ' ', '')
      .replace(/^· /, '') + (x.words ? ' · ' + x.words : '')
  );
}
// ---------------------------------------------------------------- after Send / Bring back: a truck and a driver
/** The day after a 'YYYY-MM-DD' day. @param {string} day */
export const glTomorrow = (day) => {
  const d = new Date((day ?? '2000-01-01') + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
/** @param {{order:any,message:string,truck?:string,driver?:string,day?:string,time?:string,trips?:Record<string,any[]>,err?:string,busy?:boolean}} w @param {any} s @param {any} team @param {string} today */
export function glBookHTML(w, s, team, today) {
  const trucks = (s?.trucks ?? []).filter((t) => !t.retired && !t.hired),
    drivers = (team?.people ?? []).filter((p) => p.kind === 'driver'),
    o = w.order;
  const tomorrow = glTomorrow(today);
  const opt = (v, words, sel) =>
    '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(words) + '</option>';
  // Today's truck bookings close at 5 pm (Today's rule): after that the booking starts on tomorrow
  const late = typeof Date === 'function' && new Date().getHours() >= 17,
    day = w.day ?? (late ? tomorrow : today),
    truck = w.truck ?? trucks[0]?.id ?? null,
    // the time: as picked, else the truck's next free hour that day (07:00 for its first trip)
    time = w.time ?? glSuggestTime(w.trips?.[day] ?? null, truck, day, today);
  let body;
  if (!trucks.length)
    body =
      '<p class="gm-bk-note">No trucks yet. Add one in the Office (Equipment), then book it on Today.</p><button type="button" class="gm-go" data-gm-win-x>OK</button>';
  else if (team && !drivers.length)
    body =
      '<p class="gm-bk-note">No drivers in your team yet. Add one on Workers, Your team, then book it on Today.</p><button type="button" class="gm-go" data-gm-win-x>OK</button>';
  else
    body =
      '<form class="gm-bk" data-gm-book-form><label><span>Truck</span><select name="truck">' +
      trucks
        .map((t) => opt(t.id, t.name + (t.payload >= 10000000 ? ' · big truck' : ' · small truck'), t.id === w.truck))
        .join('') +
      '</select></label><label><span>Driver</span><select name="driver">' +
      (drivers.length ? drivers.map((d) => opt(d.id, d.name, d.id === w.driver)).join('') : opt('', 'Loading…')) +
      '</select></label><div class="gm-bk-days" role="radiogroup" aria-label="Day"><label class="gm-bk-day"><input type="radio" name="day" value="' +
      esc(today ?? '') +
      '"' +
      (day === today ? ' checked' : '') +
      (late ? ' disabled' : '') +
      '><span>' +
      (late ? 'Today: too late' : 'Today') +
      '</span></label><label class="gm-bk-day"><input type="radio" name="day" value="' +
      esc(tomorrow) +
      '"' +
      (day === tomorrow ? ' checked' : '') +
      '><span>Tomorrow</span></label></div><label><span>Time</span><select name="time">' +
      GL_TIMES.map((t) => opt(t, glTimeWords(t), t === time)).join('') +
      '</select></label>' +
      (w.err ? '<p class="gm-bk-err" role="alert">' + esc(w.err) + '</p>' : '') +
      '<button type="submit" class="gm-go gm-go-big"' +
      (w.busy ? ' disabled' : '') +
      '>Book the truck</button><button type="button" class="gm-link" data-gm-later>Later, on Today</button><p class="gm-bk-note">' +
      (o.direction === 'BACK'
        ? 'The driver confirms Collected and Back at yard on their phone.'
        : 'The driver confirms Loaded &amp; left and Delivered on their phone.') +
      ' The truck moves on the map only then.</p></form>';
  return (
    '<div class="gm-nw gm-book" role="dialog" aria-labelledby="gm-bk-h"><button type="button" class="gm-x" data-gm-win-x aria-label="Close">&times;</button><h3 id="gm-bk-h">' +
    esc(o.label + (o.direction === 'BACK' ? ' from ' : ' for ') + o.siteName) +
    '</h3><p class="gm-bk-held">' +
    esc(
      o.lines.map((l) => num(l.requested) + ' × ' + l.name).join(', ') +
        ' · ' +
        (o.lines.every((l) => l.held >= l.requested)
          ? 'held exactly'
          : o.lines.reduce((n, l) => n + l.held, 0) + ' of ' + o.lines.reduce((n, l) => n + l.requested, 0) + ' held'),
    ) +
    '</p><p class="gm-bk-q">Which truck takes it?</p>' +
    body +
    '</div>'
  );
}
// ---------------------------------------------------------------- the replay queue: each confirmation shown once on this screen
/**
 * The confirmations of the last 15 minutes this screen has not shown yet (by id), and marks them shown. The first look after the page opens
 * shows only the newest one, so opening the board never plays a burst of old news.
 * @param {any} s @param {{get:(k:string)=>string|null,set:(k:string,v:string)=>void}} store @param {string} key
 */
export function glReplaysDue(s, store, key) {
  const list = s?.liveBoard?.replays ?? [];
  if (!list.length) return [];
  let played;
  try {
    played = new Set(JSON.parse(store.get(key) ?? '[]'));
  } catch {
    played = new Set();
  }
  const fresh = list.filter((r) => !played.has(r.id));
  if (!fresh.length) return [];
  const first = !store.get(key);
  for (const r of fresh) played.add(r.id);
  const keep = [...played].slice(-60);
  store.set(key, JSON.stringify(keep));
  return first ? fresh.slice(-1) : fresh;
}
