// The Today calendar's pure helpers, shared by the browser (public/operations.js) and the server (src/domain/plan.js builds GET /api/plan with
// the same grid). No DOM, no database. Days are 'YYYY-MM-DD' strings; arithmetic goes through Date.UTC so daylight saving never shifts a day.
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const p2 = (n) => String(n).padStart(2, '0');
const utcDay = (ms) => {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
};
export const isMonth = (m) =>
  typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) && Number(m.slice(5)) >= 1 && Number(m.slice(5)) <= 12;
// 'YYYY-MM' plus n months.
export function monthAdd(month, n) {
  const y = Number(month.slice(0, 4)),
    m = Number(month.slice(5)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1);
}
// Whole months from a to b ('YYYY-MM'): positive when b is later.
export const monthsBetween = (a, b) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5)) - Number(a.slice(5));
// Always 6 weeks (42 days), Monday first, starting on the Monday on or before the 1st: the calendar keeps a steady height month to month.
export function monthGrid(month) {
  const y = Number(month.slice(0, 4)),
    m = Number(month.slice(5)) - 1,
    first = Date.UTC(y, m, 1),
    wd = (new Date(first).getUTCDay() + 6) % 7,
    start = first - wd * 86400000;
  return Array.from({ length: 42 }, (_, i) => utcDay(start + i * 86400000));
}
export const monthTitle = (month) => MONTH_NAMES[Number(month.slice(5)) - 1] + ' ' + month.slice(0, 4);
// A text message link for the phone's own Messages app, with the words already written (the ?& form works on iPhone and Android).
export const smsHref = (e164, text) => 'sms:' + e164 + '?&body=' + encodeURIComponent(text ?? '');
// One calendar chip per thing on a day: its kind (the tone class), sprite and short label. entry: a plan item view, a run or a delivery.
export const CHIP_KINDS = {
  TRUCK: { tone: 'truck', icon: 'spr-truck12' },
  MATERIALS: { tone: 'mat', icon: 'spr-stillage' },
  WORKERS: { tone: 'crew', icon: 'spr-worker' },
  RESTACK: { tone: 'restack', icon: 'spr-forklift' },
  LOAD: { tone: 'load', icon: 'spr-forklift-load' },
  COLLECTION: { tone: 'back', icon: 'rt-collect' },
  DELIVERED: { tone: 'done', icon: 'tick' },
};
export function chipOf(e) {
  if (e.type === 'TRUCK') {
    const big = e.hire ? e.hire.size !== 'SMALL' : e.big !== false;
    return {
      kind: 'TRUCK',
      ...CHIP_KINDS.TRUCK,
      icon: big ? 'spr-truck12' : 'spr-truck2',
      label: e.hire
        ? 'Hire truck' + (e.driverName ? ' · ' + e.driverName : '')
        : (e.truckName ?? 'Truck') + (e.driverName ? ' · ' + e.driverName : ''),
    };
  }
  // a gear list (ADR 0011): its name, its time and an arrow by direction ('Bondi gear · 7:00 am → Bondi', 'A → B', '← Bondi')
  if (e.type === 'MATERIALS' && e.gear)
    return {
      kind: 'MATERIALS',
      ...CHIP_KINDS.MATERIALS,
      label: (e.name ?? 'Gear') + (e.timeWords ? ' · ' + e.timeWords : '') + (e.arrow ? ' ' + e.arrow : ''),
    };
  if (e.type === 'MATERIALS')
    return { kind: 'MATERIALS', ...CHIP_KINDS.MATERIALS, label: 'List → ' + (e.siteName ?? 'site') };
  if (e.type === 'WORKERS')
    return { kind: 'WORKERS', ...CHIP_KINDS.WORKERS, label: e.count + ' → ' + (e.siteName ?? 'site') };
  if (e.type === 'RESTACK') return { kind: 'RESTACK', ...CHIP_KINDS.RESTACK, label: 'Re-stack' };
  if (e.kind === 'collection')
    return { kind: 'COLLECTION', ...CHIP_KINDS.COLLECTION, label: 'Back ← ' + (e.siteName ?? 'site') };
  if (e.kind === 'loadList' || e.kind === 'request')
    return { kind: 'LOAD', ...CHIP_KINDS.LOAD, label: 'Load → ' + (e.siteName ?? 'site') };
  if (e.kind === 'trip')
    return { kind: 'LOAD', ...CHIP_KINDS.LOAD, icon: 'spr-truck12', label: 'Going → ' + (e.siteName ?? 'site') }; // sent from the yard board today
  return { kind: 'DELIVERED', ...CHIP_KINDS.DELIVERED, label: 'Delivered ' + (e.siteName ?? '') };
}
// The planner's times of day (5:00 am to 5:00 pm every half hour, as src/domain/plantime.js) and their words: '07:00' -> '7:00 am'.
export const PLAN_TIMES = [];
for (let h = 5; h <= 17; h++)
  for (const m of ['00', '30']) if (h < 17 || m === '00') PLAN_TIMES.push(String(h).padStart(2, '0') + ':' + m);
export const planTimeWords = (hm) => {
  const [h, m] = String(hm ?? '07:00')
    .split(':')
    .map(Number);
  return ((h + 11) % 12) + 1 + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'am' : 'pm');
};
