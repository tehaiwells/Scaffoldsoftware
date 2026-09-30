// @ts-check
// Company time (ADR 0002): days and times of day in the company's own time zone (companies.time_zone, e.g. Australia/Sydney or
// Australia/Perth), whatever zone the server runs in. Pure: no database. Daylight saving is the zone's own (Intl); the planner's times are
// 5:00 am to 5:00 pm, so the 2-3 am change-over is never asked for.
/** @type {Map<string,Intl.DateTimeFormat>} */
const formats = new Map();
/** @param {string} zone */
const format = (zone) => {
  let f = formats.get(zone);
  if (!f)
    formats.set(
      zone,
      (f = new Intl.DateTimeFormat('en-AU', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })),
    );
  return f;
};
export const DEFAULT_ZONE = 'Australia/Sydney';
/** Is this a time zone the computer knows? @param {unknown} zone */
export function validZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
/** The day ('YYYY-MM-DD') and time ('HH:MM') a moment is in a zone. @param {number} ms @param {string} zone */
export function zoneParts(ms, zone) {
  /** @type {Record<string,string>} */
  const p = {};
  for (const x of format(zone).formatToParts(new Date(ms))) p[x.type] = x.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return { day: p.year + '-' + p.month + '-' + p.day, hm: hour + ':' + p.minute, second: Number(p.second) };
}
/** @param {number} ms @param {string} zone */
export const zoneDay = (ms, zone) => zoneParts(ms, zone).day;
// How far the zone's wall clock is ahead of UTC at a moment (ms).
/** @param {number} ms @param {string} zone */
function offset(ms, zone) {
  const { day, hm, second } = zoneParts(ms, zone),
    [y, m, d] = day.split('-').map(Number),
    [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi, second) - Math.floor(ms / 1000) * 1000;
}
/** The moment a day and time of day happen in a zone. @param {string} day @param {string} hm @param {string} zone */
export function zoneAt(day, hm, zone) {
  const [y, m, d] = day.split('-').map(Number),
    [h, mi] = hm.split(':').map(Number),
    wall = Date.UTC(y, m - 1, d, h, mi);
  let at = wall - offset(wall, zone);
  const again = offset(at, zone); // the offset where the answer lands (differs only across a daylight-saving change)
  if (wall - again !== at) at = wall - again;
  return at;
}
