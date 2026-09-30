// A real yard's trips in the Office (ADR 0009, audit #2, #3, thin #5): the trip card on Today and on the truck page (its docket, asked
// against sent, and the steps people confirmed), the office confirming a step for a driver (recorded ON_BEHALF), booking a truck and driver
// for an order, and a driver's phone link (Copy link, Text it) with the phones signed in. Loaded only in a real yard (operations.js imports
// it when the company is LIVE, ADR 0007). The HTML functions are pure; loSetup wires one set of listeners on the document.
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
export const LO_ACTIONS = {
  packConfirmed: 'Packed',
  tripLoaded: 'Loaded & left',
  tripDelivered: 'Delivered',
  tripCollected: 'Collected',
  tripReturned: 'Back at yard',
};
const STEPS = [
  ['PACKED', 'Packed'],
  ['LOADED', 'Loaded & left'],
  ['COLLECTED', 'Collected'],
  ['DELIVERED', 'Delivered'],
  ['RETURNED', 'Back at yard'],
];
const TONE = {
  BOOKED: 'booked',
  PACKED: 'booked',
  LOADED: 'road',
  COLLECTED: 'road',
  DELIVERED: 'done',
  RETURNED: 'done',
  DELIVERED_SHORT: 'short',
  CANCELLED: 'off',
};
/** @type {any} */
const LO = {
  host: null,
  days: new Map(),
  busy: new Set(),
  open: null,
  form: { draft: {}, when: 'now', at: '', reason: '', rcv: '' },
  book: null,
  team: null,
  teamAt: 0,
  phone: null,
  devices: null,
  devAt: 0,
  working: false,
  err: null,
};
/** HH:MM of an ISO time on this computer's clock (the company's, for customer zero). @param {string} iso */
export const loHm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
// Today's booking times: 5:00 am to 5:00 pm, every half hour (src/domain/plantime.js PLAN_TIMES).
export const LO_TIMES = [];
for (let h = 5; h <= 17; h++)
  for (const m of [0, 30]) if (h < 17 || m === 0) LO_TIMES.push(String(h).padStart(2, '0') + ':' + (m ? '30' : '00'));
/** "7:00 am" @param {string} t */
export const loTimeWords = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return ((h + 11) % 12) + 1 + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'am' : 'pm');
};
/**
 * The time a booking form starts at: an hour after the truck's last trip that day, else 7:00 am; today, never a time already gone.
 * @param {any[]} trips the day's trips (GET /api/trips) @param {string|null} truck @param {string} day @param {string} today @param {number} [now]
 */
export function loSuggestTime(trips, truck, day, today, now = Date.now()) {
  // now: the company's clock as 'HH:MM' (GET /api/trips .now); a number is the browser's clock, only right in the company's own zone
  const mine = (trips ?? [])
    .filter((t) => t.truck === truck && t.day === day && t.state !== 'CANCELLED')
    .map((t) => t.time);
  const last = mine.sort().at(-1);
  let want = '07:00';
  if (last) {
    const [h, m] = last.split(':').map(Number);
    want = String(Math.min(23, h + 1)).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  if (day === today) {
    let hm = now;
    if (typeof now !== 'string') {
      const d = new Date(now);
      hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    if (want <= hm) want = hm;
  }
  return LO_TIMES.find((t) => t >= want) ?? LO_TIMES.at(-1);
}
/** The day after a 'YYYY-MM-DD' day. @param {string} day */
const loTomorrow = (day) => {
  const [y, m, d] = day.split('-').map(Number),
    n = new Date(Date.UTC(y, m - 1, d + 1));
  return n.toISOString().slice(0, 10);
};
const localInput = (ms) => {
  const d = new Date(ms),
    p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
};
// ---------------------------------------------------------------- data: one day's trips and orders (GET /api/trips?day=)
/** @param {{get:(p:string)=>Promise<any>,cmd:(a:string,d:any)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,refresh:()=>Promise<any>,state:()=>any}} host */
export function loSetup(host) {
  LO.host = host;
  if (typeof document === 'undefined' || LO.bound) return;
  LO.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('submit', onSubmit);
}
/** The trips and open orders of a day, fetched when missing or older than 10 s (the page redraws when they come). @param {string} day */
export function loDay(day) {
  const key = day || 'today',
    have = LO.days.get(key);
  if ((!have || Date.now() - have.at > 10000) && LO.host && !LO.busy.has(key)) {
    LO.busy.add(key);
    LO.host
      .get('trips' + (day ? '?day=' + encodeURIComponent(day) : ''))
      .then((d) => {
        LO.days.set(key, { at: Date.now(), data: d });
        LO.err = null;
      })
      .catch((e) => {
        LO.err = e?.message ?? 'Trips could not be loaded.';
        LO.days.set(key, { at: Date.now(), data: have?.data ?? null });
      })
      .finally(() => {
        LO.busy.delete(key);
        LO.host?.redraw();
      });
  }
  return have?.data ?? null;
}
export const loForget = () => {
  for (const v of LO.days.values()) v.at = 0;
};
function loTeam() {
  if ((!LO.team || Date.now() - LO.teamAt > 30000) && LO.host && !LO.teamBusy) {
    LO.teamBusy = true;
    LO.host
      .get('team')
      .then((d) => {
        LO.team = d;
      })
      .catch(() => {})
      .finally(() => {
        LO.teamBusy = false;
        LO.teamAt = Date.now();
        LO.host?.redraw();
      });
  }
  return LO.team;
}
function loDevices() {
  if ((!LO.devices || Date.now() - LO.devAt > 15000) && LO.host && !LO.devBusy) {
    LO.devBusy = true;
    LO.host
      .get('crew-devices')
      .then((d) => {
        LO.devices = d;
      })
      .catch(() => {})
      .finally(() => {
        LO.devBusy = false;
        LO.devAt = Date.now();
        LO.host?.redraw();
      });
  }
  return LO.devices;
}
// ---------------------------------------------------------------- the trip card
// The docket: per material, what the site asked for against what went and what arrived (or came back). A difference is amber.
/** @param {any} t */
export function loDocket(t) {
  const back = t.direction === 'BACK',
    cols = back ? ['Asked', 'Collected', 'Back'] : ['Asked', 'Sent', 'Delivered'],
    started = !!(t.steps?.LOADED || t.steps?.COLLECTED),
    ended = !!(t.steps?.DELIVERED || t.steps?.RETURNED);
  const rows = (t.lines ?? [])
    .map((l) => {
      const sent = back ? l.collected : l.loaded,
        got = back ? l.returned : l.delivered,
        endedHere = back ? !!t.steps?.RETURNED : !!t.steps?.DELIVERED;
      const off1 = started && sent !== l.asked,
        off2 = endedHere && got !== sent;
      return (
        '<tr><th scope="row">' +
        esc(l.name) +
        (!started && l.held < l.asked ? '<small>' + l.held + ' held in the yard</small>' : '') +
        '</th><td>' +
        l.asked +
        '</td><td' +
        (off1 ? ' class="off"' : '') +
        '>' +
        (started ? sent : '–') +
        '</td><td' +
        (off2 ? ' class="off"' : '') +
        '>' +
        (endedHere ? got : '–') +
        '</td></tr>'
      );
    })
    .join('');
  // a send that went short: what the site is still owed, said under the docket
  const owed = back
    ? []
    : (t.lines ?? [])
        .map((l) => ({ l, n: l.asked - (t.steps?.DELIVERED ? l.delivered : t.steps?.LOADED ? l.loaded : l.asked) }))
        .filter((x) => x.n > 0);
  return (
    '<table class="lo-docket"><thead><tr><th scope="col">' +
    (back ? 'Bring back' : 'Docket') +
    '</th>' +
    cols.map((c) => '<th scope="col">' + c + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table>' +
    (ended && (t.notBack ?? []).length
      ? '<p class="lo-warn">' +
        esc(
          plural(
            t.notBack.reduce((n, x) => n + x.quantity, 0),
            'piece',
          ),
        ) +
        ' not counted back yet.</p>'
      : '') +
    (owed.length && !t.undelivered
      ? '<p class="lo-warn">Short ' + esc(owed.map((x) => x.n + ' × ' + x.l.name).join(', ')) + ': still to send.</p>'
      : '')
  );
}
/** The steps people confirmed, with who, when and why a time is earlier. @param {any} t */
export function loSteps(t) {
  const out = [];
  for (const [k, words] of STEPS) {
    const s = t.steps?.[k];
    if (!s) continue;
    out.push(
      '<li><span class="lo-tick" aria-hidden="true">✓</span><span><b>' +
        esc(words + ' ' + loHm(s.at)) +
        '</b>' +
        (s.receivedBy ? ' · received by ' + esc(s.receivedBy) : '') +
        ' <small>' +
        (s.kind === 'ON_BEHALF'
          ? '· recorded by ' + esc(s.byName) + ' for ' + esc(t.driverName)
          : '· confirmed by ' + esc(s.byName)) +
        (s.reason ? ' · entered ' + esc(loHm(s.recordedAt)) + ': ' + esc(s.reason) : '') +
        '</small></span></li>',
    );
  }
  return out.length ? '<ol class="lo-steps">' + out.join('') + '</ol>' : '';
}
// The numbers a step starts from: what was asked (Loaded, Collected, Packed) or what is on the truck (Delivered, Back at yard).
/** @param {any} t @param {string} action */
export function loExpected(t, action) {
  return new Map(
    (t.lines ?? []).map((l) => [
      l.product,
      ['tripLoaded', 'tripCollected', 'packConfirmed'].includes(action) ? l.asked : (l.onTruck ?? 0),
    ]),
  );
}
/** The office's confirm form for one step (recorded for the driver). @param {any} t */
function formHTML(t) {
  const o = LO.open,
    f = LO.form,
    exp = loExpected(t, o.action),
    label = o.action === 'tripReturned' && t.state === 'LOADED' ? 'Back at yard, not delivered' : LO_ACTIONS[o.action],
    moves = o.action !== 'packConfirmed';
  const lines = (t.lines ?? [])
    .filter((l) => (exp.get(l.product) ?? 0) > 0 || o.action === 'tripLoaded' || o.action === 'tripCollected')
    .map((l) => {
      const q = f.draft[l.product] ?? exp.get(l.product) ?? 0;
      return (
        '<label class="lo-line' +
        (q !== exp.get(l.product) ? ' changed' : '') +
        '"><span>' +
        esc(l.name) +
        '</span><input type="number" min="0" step="1" inputmode="numeric" data-lo-q="' +
        esc(l.product) +
        '" value="' +
        q +
        '" aria-label="' +
        esc(label + ': ' + l.name) +
        '"></label>'
      );
    })
    .join('');
  return (
    '<form class="lo-form" data-lo-form="' +
    esc(t.id) +
    '"><p class="lo-form-title">' +
    esc(label) +
    (moves ? ' <small>for ' + esc(t.driverName) + '</small>' : '') +
    '</p><div class="lo-lines">' +
    lines +
    '</div>' +
    (o.action === 'tripDelivered'
      ? '<label class="lo-field"><span>Received by</span><input name="receivedBy" data-lo-f="rcv" maxlength="80" autocomplete="off" required value="' +
        esc(f.rcv) +
        '" placeholder="Their name"></label>'
      : '') +
    (moves
      ? '<fieldset class="lo-when"><legend>When</legend><label><input type="radio" name="lo-when" value="now" data-lo-f="when"' +
        (f.when === 'now' ? ' checked' : '') +
        '> Just now</label><label><input type="radio" name="lo-when" value="earlier" data-lo-f="when"' +
        (f.when === 'earlier' ? ' checked' : '') +
        '> Earlier</label>' +
        '<div class="lo-earlier"' +
        (f.when === 'earlier' ? '' : ' hidden') +
        '><label class="lo-field"><span>Time it happened</span><input type="datetime-local" data-lo-f="at" value="' +
        esc(f.at) +
        '" max="' +
        esc(localInput(Date.now())) +
        '"></label><label class="lo-field"><span>Why is it keyed in late? <small>(needed if more than 15 minutes ago)</small></span><input data-lo-f="reason" maxlength="200" value="' +
        esc(f.reason) +
        '" placeholder="e.g. paper docket, keyed in later"></label></div>' +
        '</fieldset>'
      : '') +
    (LO.formErr ? '<p class="lo-err" role="alert">' + esc(LO.formErr) + '</p>' : '') +
    '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
    (LO.working ? ' disabled' : '') +
    '>' +
    esc(moves ? 'Confirm ' + label.toLowerCase() : 'Mark packed') +
    '</button><button type="button" class="lo-link" data-lo-x>Never mind</button></div>' +
    (moves
      ? '<p class="lo-note">Recorded as done by the office for ' +
        esc(t.driverName) +
        '. Stock moves only when a step is confirmed.</p>'
      : '') +
    '</form>'
  );
}
/** "Thu 1 Oct" @param {string} day */
const dayShort = (day) =>
  new Date(day + 'T12:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
/** One trip, as the office sees it (day: the day on screen; a trip booked for another day says its day). @param {any} t @param {{ops?:boolean,compact?:boolean,day?:string|null}} [opts] */
export function loTripHTML(t, { ops = true, compact = false, day = null } = {}) {
  const open = LO.open?.trip === t.id,
    tone = t.flag ? 'late' : (TONE[t.state] ?? 'booked'),
    arrow = t.direction === 'BACK' ? ' ← ' : ' → ';
  const acts = ops
    ? (t.next ?? [])
        .map(
          (a) =>
            '<button type="button" class="lo-btn' +
            (a === 'packConfirmed' || (a === 'tripReturned' && ['DELIVERED', 'LOADED'].includes(t.state))
              ? ' soft'
              : '') +
            '" data-lo-go="' +
            a +
            '" data-trip="' +
            esc(t.id) +
            '">' +
            esc(a === 'tripReturned' && t.state === 'LOADED' ? 'Came back, not delivered' : LO_ACTIONS[a]) +
            '</button>',
        )
        .join('') +
      // a load that came back: the same pieces, as a new order waiting for a truck
      (t.undelivered && t.direction === 'OUT'
        ? '<button type="button" class="lo-btn" data-lo-again="' + esc(t.id) + '">Send again</button>'
        : '') +
      (['BOOKED', 'PACKED'].includes(t.state)
        ? '<button type="button" class="lo-link" data-lo-cancel="' + esc(t.id) + '">Cancel trip</button>'
        : '')
    : '';
  return (
    '<article class="lo-trip tone-' +
    tone +
    (open ? ' is-open' : '') +
    '" data-lo-trip="' +
    esc(t.id) +
    '"><div class="lo-trip-top"><span class="lo-dot" aria-hidden="true"></span><b>' +
    esc(
      t.label +
        ' · ' +
        (day && t.day && t.day !== day ? dayShort(t.day) + ' ' : '') +
        (t.time ?? '') +
        arrow +
        t.siteName,
    ) +
    '</b><span class="lo-pill">' +
    esc(t.stateWords) +
    '</span></div><p class="lo-who">' +
    esc([t.truckName, t.driverName, (t.orders ?? []).map((o) => o.label).join(', ')].filter(Boolean).join(' · ')) +
    '</p>' +
    (t.flag?.words ? '<p class="lo-warn">' + esc(t.flag.words) + '</p>' : '') +
    (compact && !open ? '' : loDocket(t)) +
    loSteps(t) +
    (open ? formHTML(t) : acts ? '<div class="lo-acts">' + acts + '</div>' : '') +
    '</article>'
  );
}
/** A day's trips for one truck booking (Today) or one truck (the truck page). */
export function loTripsFor({ day = null, truckPlan = null, truck = null, ops = true, empty = '' } = {}) {
  const d = loDay(day);
  if (!d) return '<p class="lo-quiet">Loading trips…</p>';
  // a truck's page: the day's trips and its next ones (booked for a later day); Today: the booking's trips that day
  const all = truck ? [...d.trips, ...(d.upcoming ?? []).filter((u) => !d.trips.some((t) => t.id === u.id))] : d.trips;
  const list = all.filter((t) => (!truckPlan || t.truckPlan === truckPlan) && (!truck || t.truck === truck));
  if (!list.length) return empty ? '<p class="lo-quiet">' + esc(empty) + '</p>' : '';
  return '<div class="lo-trips">' + list.map((t) => loTripHTML(t, { ops, day: d.day })).join('') + '</div>';
}
// ---------------------------------------------------------------- orders waiting for a truck, and booking one
/** @param {any} o */
const heldWords = (o) => {
  const asked = o.lines.reduce((n, l) => n + l.requested, 0),
    held = o.lines.reduce((n, l) => n + l.held, 0);
  return held >= asked ? 'held exactly' : held + ' of ' + asked + ' held (the rest is not in the yard now)';
};
/** A Today Materials list's order in a real yard: "O-1 · held exactly". @param {string} planItem @param {string} day */
export function loListOrder(planItem, day) {
  const d = loDay(day);
  const o = d?.orders.find((x) => x.planItem === planItem);
  if (!o) return '';
  return (
    '<p class="lo-order-line"><b>' +
    esc(o.label) +
    '</b> · ' +
    esc(o.statusWords) +
    (['OPEN', 'BOOKED'].includes(o.status) ? ' · ' + esc(heldWords(o)) : '') +
    '</p>'
  );
}
/** Orders not on a truck yet (from the board's Send and Bring back, or a list without a truck), with Book a truck. */
export function loWaitingHTML({ day = null, ops = true } = {}) {
  const d = loDay(day);
  const list = (d?.orders ?? []).filter((o) => o.status === 'OPEN' && !o.planItem); // a Today list books its truck on the list
  if (!list.length) return '';
  return (
    '<section class="lo-waiting" aria-label="Waiting for a truck"><p class="lo-waiting-h">Waiting for a truck</p>' +
    list
      .map(
        (o) =>
          '<div class="lo-wait-row" data-lo-order="' +
          esc(o.id) +
          '"><span class="lo-wait-t"><b>' +
          esc(o.label + (o.direction === 'BACK' ? ' ← ' : ' → ') + o.siteName) +
          '</b><small>' +
          esc(
            plural(
              o.lines.reduce((n, l) => n + l.requested, 0),
              'piece',
            ) +
              ' · ' +
              heldWords(o) +
              (o.neededOn ? ' · needed ' + o.neededOn.slice(8) + '/' + o.neededOn.slice(5, 7) : ''),
          ) +
          '</small></span>' +
          (ops
            ? '<span class="lo-wait-acts"><button type="button" class="lo-btn" data-lo-book="' +
              esc(o.id) +
              '">Book a truck</button><button type="button" class="lo-link" data-lo-ocancel="' +
              esc(o.id) +
              '">Cancel</button></span>'
            : '') +
          (LO.book?.order === o.id ? loBookHTML(o, day ?? d?.day) : '') +
          '</div>',
      )
      .join('') +
    '</section>'
  );
}
/** The booking form: a truck and its driver, on a day. @param {any} o @param {string} day */
export function loBookHTML(o, day) {
  const s = LO.host?.state?.() ?? {},
    trucks = (s.trucks ?? []).filter((t) => !t.retired && !t.hired),
    team = loTeam(),
    drivers = (team?.people ?? []).filter((p) => p.kind === 'driver'),
    b = LO.book;
  const opt = (v, words, sel) =>
    '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(words) + '</option>';
  if (!trucks.length)
    return '<p class="lo-warn">No trucks yet. Add one on the Office, Equipment, then book it here.</p>';
  if (team && !drivers.length)
    return '<p class="lo-warn">No drivers in your team yet. Add one on Workers, Your team.</p>';
  return (
    '<form class="lo-form lo-book" data-lo-book-form="' +
    esc(o.id) +
    '"><div class="lo-fields"><label class="lo-field"><span>Truck</span><select data-lo-b="truck">' +
    trucks.map((t) => opt(t.id, t.name, t.id === b.truck)).join('') +
    '</select></label><label class="lo-field"><span>Driver</span><select data-lo-b="driver">' +
    (drivers.length ? drivers.map((d) => opt(d.id, d.name, d.id === b.driver)).join('') : opt('', 'Loading…')) +
    '</select></label><label class="lo-field"><span>Day</span><input type="date" data-lo-b="day" value="' +
    esc(b.day ?? day ?? '') +
    '" required></label><label class="lo-field"><span>Time</span><select data-lo-b="time">' +
    LO_TIMES.map((x) => opt(x, loTimeWords(x), x === (b.time ?? '07:00'))).join('') +
    '</select></label></div>' +
    (LO.formErr ? '<p class="lo-err" role="alert">' + esc(LO.formErr) + '</p>' : '') +
    '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
    (LO.working ? ' disabled' : '') +
    '>Book it</button><button type="button" class="lo-link" data-lo-x>Never mind</button></div><p class="lo-note">' +
    (o.direction === 'BACK'
      ? 'The driver confirms Collected and Back at yard on their phone.'
      : 'The driver confirms Loaded &amp; left and Delivered on their phone.') +
    ' They are asked on Today, as for any truck booking.</p></form>'
  );
}
// ---------------------------------------------------------------- a driver's phone link (Your team)
/** "Phone link" beside a driver on Your team, and what it made. @param {{id:string,name:string}} driver */
export function loPhoneHTML(driver) {
  const dev = loDevices(),
    phones = (dev?.devices ?? []).filter((d) => d.driver === driver.id),
    links = (dev?.links ?? []).filter((l) => l.driver === driver.id),
    made = LO.phone?.driver === driver.id ? LO.phone : null;
  let h =
    '<div class="lo-phone" data-lo-phone="' +
    esc(driver.id) +
    '"><div class="lo-phone-top"><button type="button" class="lo-btn" data-lo-link="' +
    esc(driver.id) +
    '"' +
    (LO.working ? ' disabled' : '') +
    '>' +
    (made ? 'New phone link' : 'Phone link') +
    '</button><span class="lo-phone-state">' +
    (phones.length
      ? '<span class="lo-dot ok" aria-hidden="true"></span>' + esc(plural(phones.length, 'phone') + ' signed in')
      : 'No phone signed in yet') +
    '</span></div>';
  if (!made)
    h +=
      '<p class="lo-reach">Phones reach Scaffold Yard only while Wi-Fi sharing is on (Account, This computer), or once it is hosted.</p>';
  if (made)
    h +=
      '<div class="lo-link-box"><p class="lo-link-h">' +
      esc('Send this to ' + driver.name + '. It opens their trips on their phone. It works once, for 7 days.') +
      '</p><input class="lo-link-url" readonly value="' +
      esc(made.link) +
      '" aria-label="Phone link for ' +
      esc(driver.name) +
      '"><div class="lo-form-acts"><button type="button" class="lo-go" data-lo-copy>' +
      (LO.copied ? 'Copied' : 'Copy link') +
      '</button>' +
      (made.sms
        ? '<a class="lo-btn" href="' + esc(made.sms) + '">Text it</a>'
        : '<span class="lo-quiet">Add a mobile on Your team to text it.</span>') +
      '</div><p class="lo-reach' +
      (made.reachable ? '' : ' warn') +
      '">' +
      esc(made.reach) +
      '</p></div>';
  if (phones.length || links.length)
    h +=
      '<ul class="lo-devices">' +
      phones
        .map(
          (p) =>
            '<li><span>' +
            esc(p.label) +
            ' <small>signed in ' +
            esc(new Date(p.signedInAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) +
            '</small></span><button type="button" class="lo-link" data-lo-revoke="' +
            esc(p.id) +
            '">Sign out this phone</button></li>',
        )
        .join('') +
      links
        .map(
          (l) =>
            '<li><span>A link not opened yet <small>until ' +
            esc(new Date(l.expiresAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) +
            '</small></span><button type="button" class="lo-link" data-lo-unlink="' +
            esc(l.id) +
            '">Cancel link</button></li>',
        )
        .join('') +
      '</ul>';
  return h + '</div>';
}
// ---------------------------------------------------------------- events
const tripById = (id) => {
  for (const v of LO.days.values()) {
    const t = v.data?.trips?.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
};
const orderById = (id) => {
  for (const v of LO.days.values()) {
    const o = v.data?.orders?.find((x) => x.id === id);
    if (o) return o;
  }
  return null;
};
async function run(action, data, done) {
  if (LO.working) return;
  LO.working = true;
  LO.formErr = null;
  LO.host.redraw();
  try {
    const r = await LO.host.cmd(action, data);
    loForget();
    done?.(r);
    if (r?.message) LO.host.notify(r.message);
    await LO.host.refresh();
  } catch (e) {
    LO.formErr = e.message;
    if (!LO.open && !LO.book) LO.host.notify(e.message);
  } finally {
    LO.working = false;
    LO.host.redraw();
  }
}
function onClick(e) {
  const b = /** @type {HTMLElement} */ (e.target)?.closest?.('button,[data-lo-copy]');
  if (!b || !LO.host) return;
  const d = b.dataset;
  if (d.loGo) {
    LO.open = { trip: d.trip, action: d.loGo };
    LO.book = null;
    LO.formErr = null;
    // "Earlier" starts 30 minutes back, never before the earliest time a step can be dated (7 days, or when the real yard started)
    const from = Date.parse([...LO.days.values()].find((v) => v.data?.openFrom)?.data?.openFrom ?? '') || 0;
    LO.form = { draft: {}, when: 'now', at: localInput(Math.max(Date.now() - 30 * 60000, from)), reason: '', rcv: '' };
    LO.host.redraw();
    requestAnimationFrame(() =>
      document
        .querySelector('[data-lo-form="' + CSS.escape(d.trip) + '"] input:not([type=radio])')
        ?.focus({ preventScroll: true }),
    );
    return;
  }
  if (b.hasAttribute('data-lo-x')) {
    LO.open = null;
    LO.book = null;
    LO.formErr = null;
    LO.host.redraw();
    return;
  }
  if (d.loCancel) {
    const t = tripById(d.loCancel);
    if (!confirm('Cancel ' + (t?.label ?? 'this trip') + '? Its order goes back to waiting for a truck.')) return;
    run('tripCancel', { id: d.loCancel });
    return;
  }
  if (d.loAgain) {
    const t = tripById(d.loAgain);
    if (!t) return;
    const lines = (t.lines ?? []).map((l) => ({ product: l.product, quantity: l.asked })).filter((l) => l.quantity > 0);
    run('orderCreate', { site: t.site, lines, source: 'office', note: 'Sent again: ' + t.label + ' came back' });
    return;
  }
  if (d.loBook) {
    LO.book = { order: d.loBook, truck: null, driver: null, day: null, time: null };
    LO.open = null;
    LO.formErr = null;
    const s = LO.host.state?.() ?? {};
    LO.book.truck = (s.trucks ?? []).find((t) => !t.retired && !t.hired)?.id ?? null;
    LO.book.driver = (loTeam()?.people ?? []).find((p) => p.kind === 'driver')?.id ?? null;
    const o = orderById(d.loBook);
    // the company's day and clock come from the server; after 5 pm company time the booking starts on tomorrow
    const known = [...LO.days.values()].find((v) => v.data)?.data,
      today = known?.today,
      first = known?.dayOver && today ? loTomorrow(today) : today;
    LO.book.day = o?.neededOn && today && o.neededOn > today ? o.neededOn : (first ?? null);
    LO.book.time = loSuggestTime(
      loDay(LO.book.day)?.trips,
      LO.book.truck,
      LO.book.day,
      today,
      known?.now ?? Date.now(),
    );
    LO.host.redraw();
    return;
  }
  if (d.loOcancel) {
    const o = orderById(d.loOcancel);
    if (!confirm('Cancel ' + (o?.label ?? 'this order') + '? What was held for it is free again.')) return;
    run('orderCancel', { id: d.loOcancel });
    return;
  }
  if (d.loLink) {
    if (LO.working) return;
    LO.working = true;
    LO.copied = false;
    LO.host
      .post('crew-links', { driver: d.loLink })
      .then((r) => {
        LO.phone = { ...r, driver: d.loLink };
        LO.devAt = 0;
      })
      .catch((err) => LO.host.notify(err.message))
      .finally(() => {
        LO.working = false;
        LO.host.redraw();
      });
    return;
  }
  if (b.hasAttribute('data-lo-copy')) {
    const url = LO.phone?.link;
    if (!url) return;
    const done = () => {
      LO.copied = true;
      LO.host.redraw();
      setTimeout(() => {
        LO.copied = false;
        LO.host?.redraw();
      }, 2500);
    };
    try {
      navigator.clipboard.writeText(url).then(done, () => {
        /** @type {HTMLInputElement|null} */ (document.querySelector('.lo-link-url'))?.select();
      });
    } catch {
      /** @type {HTMLInputElement|null} */ (document.querySelector('.lo-link-url'))?.select();
    }
    return;
  }
  if (d.loRevoke || d.loUnlink) {
    if (d.loRevoke && !confirm('Sign out this phone? The driver needs a new link to sign in again.')) return;
    LO.host
      .post('crew-devices/revoke', d.loRevoke ? { device: d.loRevoke } : { link: d.loUnlink })
      .then(() => LO.host.notify(d.loRevoke ? 'That phone is signed out.' : 'The link is cancelled.'))
      .catch((err) => LO.host.notify(err.message))
      .finally(() => {
        LO.devAt = 0;
        if (d.loUnlink && LO.phone) LO.phone = null;
        LO.host.redraw();
      });
  }
}
function onInput(e) {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t?.dataset) return;
  if (t.dataset.loQ) LO.form.draft[t.dataset.loQ] = Math.max(0, Math.floor(Number(t.value) || 0));
  else if (t.dataset.loF === 'when') {
    if (t.checked) {
      LO.form.when = t.value;
      const box = /** @type {HTMLElement|null} */ (t.closest('.lo-when')?.querySelector('.lo-earlier'));
      if (box) box.hidden = t.value !== 'earlier';
    }
  } else if (t.dataset.loF) LO.form[t.dataset.loF] = t.value;
  else if (t.dataset.loB && LO.book) {
    LO.book[t.dataset.loB] = t.value;
    // a new truck or day: the time moves to that truck's next free hour (a time picked by hand stays)
    if ((t.dataset.loB === 'truck' || t.dataset.loB === 'day') && e.type === 'change' && !LO.book.timeSet) {
      const known = [...LO.days.values()].find((v) => v.data)?.data;
      LO.book.time = loSuggestTime(
        loDay(LO.book.day)?.trips,
        LO.book.truck,
        LO.book.day,
        known?.today,
        known?.now ?? Date.now(),
      );
      LO.host.redraw();
    }
    if (t.dataset.loB === 'time') LO.book.timeSet = true;
  }
}
function onSubmit(e) {
  const f = /** @type {HTMLFormElement} */ (e.target);
  if (f.dataset?.loForm) {
    e.preventDefault();
    const t = tripById(f.dataset.loForm),
      o = LO.open;
    if (!t || !o) return;
    const exp = loExpected(t, o.action),
      lines = [...exp].map(([product, q]) => ({ product, quantity: LO.form.draft[product] ?? q })),
      input = /** @type {any} */ ({ trip: t.id });
    if (lines.some((l) => l.quantity !== exp.get(l.product))) input.lines = lines;
    if (o.action === 'tripDelivered') input.receivedBy = LO.form.rcv.trim();
    if (o.action !== 'packConfirmed' && LO.form.when === 'earlier') {
      const ms = new Date(LO.form.at).getTime();
      if (Number.isNaN(ms)) {
        LO.formErr = 'Choose the time it happened.';
        LO.host.redraw();
        return;
      }
      input.at = new Date(ms).toISOString();
      if (LO.form.reason.trim()) input.reason = LO.form.reason.trim();
    }
    run(o.action, input, () => {
      LO.open = null;
    });
    return;
  }
  if (f.dataset?.loBookForm) {
    e.preventDefault();
    const b = LO.book;
    if (!b) return;
    for (const el of f.querySelectorAll('[data-lo-b]'))
      b[/** @type {any} */ (el).dataset.loB] = /** @type {any} */ (el).value;
    run(
      'tripBook',
      { orders: [b.order], truck: b.truck, driver: b.driver, day: b.day || undefined, time: b.time || undefined },
      () => {
        LO.book = null;
      },
    );
  }
}
export const __lo = {
  state: LO,
  reset() {
    Object.assign(LO, {
      days: new Map(),
      open: null,
      book: null,
      phone: null,
      devices: null,
      team: null,
      formErr: null,
    });
  },
  setDay(day, data) {
    LO.days.set(day || 'today', { at: Date.now(), data });
  },
  open(trip, action) {
    LO.open = { trip, action };
    LO.form = { draft: {}, when: 'now', at: '', reason: '', rcv: '' };
  },
};
