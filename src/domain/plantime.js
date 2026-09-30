// Times of day for the Today planner (src/domain/plan.js). Pure: no database. A day is a local 'YYYY-MM-DD' string (schedule.js rules) and a
// time is 'HH:MM' from PLAN_TIMES (5:00 am to 5:00 pm every half hour, so the 2-3 am daylight-saving gap is never offered). Every clock moment
// is process-local time, like localDay: the owner's PC is the clock.
import { requireRule } from './geometry.js';
import { localDay, pad2 } from './schedule.js';
export const PLAN_TIMES = [];
for (let h = 5; h <= 17; h++) for (const m of [0, 30]) if (h < 17 || m === 0) PLAN_TIMES.push(pad2(h) + ':' + pad2(m));
// Hired trucks arrive and pack messages go out at DAY_START; allocations go out the day before at SEND_BEFORE; at DAY_END hired trucks go
// back, borrowed workers go home and a re-stack stops.
export const DAY_START = '06:00',
  SEND_BEFORE = '15:00',
  DAY_END = '17:00',
  DEFAULT_TIME = '07:00';
export const atLocal = (day, hm) => {
  const [y, m, d] = day.split('-').map(Number),
    [h, mi] = hm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};
export const localParts = (ms) => {
  const d = new Date(ms);
  return { day: localDay(d), hm: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) };
};
export function parseTime(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_TIME;
  requireRule(typeof v === 'string' && PLAN_TIMES.includes(v), 'Choose a time between 5:00 am and 5:00 pm.');
  return v;
}
export const timeWords = (hm) => {
  const [h, m] = String(hm ?? DEFAULT_TIME)
    .split(':')
    .map(Number);
  return ((h + 11) % 12) + 1 + ':' + pad2(m) + ' ' + (h < 12 ? 'am' : 'pm');
};
// 32-bit FNV-1a over the string's UTF-16 code units (stable across runs and machines).
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
// Simulated replies (a demo: the app has no text-message provider). The same person, day, kind of ask and attempt always answer the same way,
// 15 to 90 seconds after the message went out; about one in eight can't make it, with a plain reason.
export const REASONS = [
  "Got a doctor's appointment",
  "Ute's in for a service",
  'Already promised to another job that day',
  'Family thing on',
  'Crook, not feeling well',
];
export function planSimAnswer(msg) {
  const h = fnv1a(msg.person + '|' + msg.day + '|' + msg.subject + '|' + (msg.attempt ?? 1));
  const no = (h >>> 8) % 8 === 0;
  return { delaySec: 15 + (h % 76), yes: !no, reason: no ? REASONS[(h >>> 12) % REASONS.length] : null };
}
