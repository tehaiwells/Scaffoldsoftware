// A person's phone (ADR 0009 and 0010, audit thin #5, #33). Opened from the link the office makes (/crew#t=<token>): the page claims the
// link once (POST /api/crew/claim), which signs this phone in for that person only, then clears the link from the address bar. Big type,
// high contrast, big buttons, for a phone in the sun. A driver sees "My trips": each trip has one next step, Loaded & left (check the list,
// change a number if different), Delivered (received by: a name), and for bring-backs Collected and Back at yard. Everyone sees their own
// asks with I'll be there / Can't make it; a yard hand sees the lists to pack (Packed, with counts), the returns to count and the re-stack
// (Done); a leading hand sees the gang (On site, Day done). Every tap is kept on the phone first with its own idempotency key
// (public/crew-queue.js) and sent when there is signal, so a tap is never lost and never counted twice. Nothing here answers by itself.
// The render functions are pure (the tests import them in Node); the page wiring runs only in a browser.
import { createCrewQueue, sendTap } from './crew-queue.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
export const CREW_ACTIONS = {
  tripLoaded: { label: 'Loaded & left', ask: 'Check what is on the truck. Change a number if it is different.' },
  tripDelivered: { label: 'Delivered', ask: 'Check what came off. Then type who took it.' },
  tripCollected: { label: 'Collected', ask: 'Check what went on the truck. Change a number if it is different.' },
  tripReturned: { label: 'Back at yard', ask: 'Check what came off at the yard.' },
  // the yard hand, the leading hand and everyone's own answers (ADR 0010)
  packConfirmed: { label: 'Packed', ask: 'Check what you packed. Change a number if it is different.' },
  returnCount: { label: 'Counted back', ask: 'Count what came off the truck at the yard.' },
  messageAnswer: { label: 'Your answer', ask: '' },
  messageSeen: { label: 'Got it', ask: '' },
  crewSignOn: { label: 'On site', ask: 'Who is here?' },
  planDone: { label: 'Done', ask: '' },
};
// Why someone can't make it: three taps, or their own words.
export const CREW_REASONS = ['Crook', 'Another job', "Something's come up"];
// Back at yard straight after Loaded & left: the site would not take it (refused, or shut), so the load came back.
export const CREW_UNDELIVERED = {
  label: 'Came back, not delivered',
  ask: 'The site did not take it? Check what came back off the truck at the yard.',
  go: 'Back at yard, not delivered',
};
// What the phone expects next after a tap it has not sent yet (so a driver without signal can still tap Loaded & left, then Delivered).
const AFTER = {
  tripLoaded: ['tripDelivered', 'tripReturned'],
  tripDelivered: ['tripReturned'],
  tripCollected: ['tripReturned'],
  tripReturned: [],
};
// The last step, confirmed or waiting on this phone, was a full delivery (nothing left on the truck): Back at yard is only a courtesy then.
const fullyDelivered = (trip) => {
  const w = trip.waiting?.at(-1);
  if (w) return w.action === 'tripDelivered' && !w.lines;
  return trip.state === 'DELIVERED';
};
// Loaded & left is the last step (confirmed or waiting): Back at yard now means it came back not delivered.
const onTheRoad = (trip) => {
  const w = trip.waiting?.at(-1);
  return w ? w.action === 'tripLoaded' : trip.state === 'LOADED';
};
/**
 * The big button, and a quieter second one, for a trip: the next step people expect, never a finished trip's courtesy step.
 * @param {any} trip @returns {{main:string|null,soft:string|null,softLabel:string|null}}
 */
export function crewButtons(trip) {
  const next = trip.next ?? [];
  if (next.includes('tripDelivered'))
    return {
      main: 'tripDelivered',
      soft: next.includes('tripReturned') ? 'tripReturned' : null,
      softLabel: CREW_UNDELIVERED.label,
    };
  if (next.length === 1 && next[0] === 'tripReturned' && fullyDelivered(trip))
    return { main: null, soft: 'tripReturned', softLabel: 'Truck back at yard' };
  return { main: next[0] ?? null, soft: null, softLabel: null };
}
// The day a trip belongs to on the phone: the day it left (a trip booked for tomorrow but driven today is today's), else its booked day.
// Packed alone does not move it: a list packed tonight for tomorrow is still tomorrow's.
/** @param {any} trip */
export const crewDay = (trip) => {
  const first = Object.entries(trip.steps ?? {})
    .filter(([k, x]) => k !== 'PACKED' && x?.at)
    .map(([, x]) => x.at)
    .sort()[0];
  if (!first) return trip.day;
  const d = new Date(first);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
/** HH:MM from an ISO time, on the phone's clock. @param {string} iso */
export const hm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const addDay = (day, n) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayWords = (day, today) => {
  if (!day || !today) return '';
  if (day === today) return 'Today';
  if (day === addDay(today, 1)) return 'Tomorrow';
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
/**
 * A trip as the phone shows it: the server's view plus the taps still waiting on this phone.
 * @param {any} trip @param {any[]} pending
 */
export function crewTrip(trip, pending = []) {
  const mine = pending.filter((t) => t.input?.trip === trip.id);
  let next = trip.next ?? [];
  for (const t of mine) next = AFTER[t.action] ?? [];
  const waiting = mine.map((t) => ({ action: t.action, at: t.input?.at ?? t.tappedAt, lines: t.input?.lines ?? null }));
  return { ...trip, next, waiting };
}
// The numbers a confirmation starts from (what the server takes when nothing is changed).
/** @param {any} trip @param {string} action */
export function expected(trip, action) {
  const m = new Map();
  const earlier = (trip.waiting ?? []).at(-1);
  for (const l of trip.lines ?? []) {
    let q;
    // Loaded starts from what the yard packed (its own count), else what was asked
    if (action === 'tripLoaded' || action === 'tripCollected') q = l.packed ?? l.asked;
    else if (earlier && (earlier.action === 'tripLoaded' || earlier.action === 'tripCollected'))
      q = earlier.lines ? (earlier.lines.find((x) => x.product === l.product)?.quantity ?? 0) : (l.packed ?? l.asked);
    else q = l.onTruck;
    m.set(l.product, Math.max(0, q ?? 0));
  }
  return m;
}
// The number beside each material on the card, by where the trip is.
const shown = (trip, l) => {
  const w = trip.waiting?.at(-1)?.action;
  if (trip.direction === 'BACK') {
    if (trip.state === 'RETURNED' || w === 'tripReturned') return l.returned || l.collected;
    if (trip.state === 'COLLECTED' || w === 'tripCollected') return l.collected || l.asked;
    return l.asked;
  }
  if (['DELIVERED', 'DELIVERED_SHORT', 'RETURNED'].includes(trip.state)) return l.delivered;
  if (trip.state === 'LOADED' || w === 'tripLoaded') return l.loaded || l.packed || l.asked;
  return l.packed ?? l.asked;
};
const TRUCK =
  '<svg class="cr-truck" viewBox="0 0 64 36" aria-hidden="true"><rect x="2" y="8" width="36" height="18" rx="2" fill="#d2ea83"/><path d="M38 12h13l9 9v5H38z" fill="#fff"/><path d="M42 15h8l5 6H42z" fill="#16382c"/><circle cx="14" cy="28" r="5" fill="#16382c"/><circle cx="50" cy="28" r="5" fill="#16382c"/><circle cx="14" cy="28" r="2" fill="#fff"/><circle cx="50" cy="28" r="2" fill="#fff"/></svg>';
/** The step lines under a trip: what was confirmed, and taps still waiting on this phone. */
function stepsHTML(trip, offline) {
  const out = [];
  for (const [k, words] of [
    ['LOADED', 'Loaded & left'],
    ['COLLECTED', 'Collected'],
    ['DELIVERED', 'Delivered'],
    ['RETURNED', 'Back at yard'],
  ]) {
    const s = trip.steps?.[k];
    if (!s) continue;
    out.push(
      '<li class="cr-done"><span class="cr-tick" aria-hidden="true">✓</span>' +
        esc(words + ' ' + hm(s.at)) +
        (s.receivedBy ? ' · ' + esc(s.receivedBy) : '') +
        '</li>',
    );
  }
  for (const w of trip.waiting ?? [])
    out.push(
      '<li class="cr-wait"><span class="cr-dot" aria-hidden="true"></span>' +
        esc(CREW_ACTIONS[w.action]?.label + ' ' + hm(w.at)) +
        ' · ' +
        (offline ? 'saved, sends when there is signal' : 'sending…') +
        '</li>',
    );
  return out.length ? '<ul class="cr-steps">' + out.join('') + '</ul>' : '';
}
/** "Delivered 17:46 · Jarrah Smith": a finished trip in one line. @param {any} trip */
function doneWords(trip) {
  const last = ['RETURNED', 'DELIVERED', 'COLLECTED', 'LOADED'].find((k) => trip.steps?.[k]);
  const s = last ? trip.steps[last] : null;
  if (!s) return trip.stateWords ?? '';
  if (last === 'DELIVERED') return 'Delivered ' + hm(s.at) + (s.receivedBy ? ' · ' + s.receivedBy : '');
  return (trip.stateWords ?? 'Back at yard') + ' ' + hm(s.at);
}
/** One trip card. @param {any} trip @param {any} v the page view */
export function tripCard(trip, v) {
  const open = v.open?.trip === trip.id ? v.open : null,
    { main, soft, softLabel } = crewButtons(trip),
    pieces = (trip.lines ?? []).reduce((n, l) => n + (shown(trip, l) || 0), 0);
  // a finished trip: one line under "Done", with the courtesy Back at yard when the truck has not been said back yet
  if (!main && !open)
    return (
      '<article class="cr-card is-done cr-one" id="trip-' +
      esc(trip.id) +
      '"><p class="cr-one-line"><span class="cr-time">' +
      esc(trip.time ?? '') +
      '</span><span><b>' +
      esc((trip.direction === 'BACK' ? 'From ' : '') + trip.siteName) +
      '</b><small>' +
      esc(
        trip.waiting?.length ? CREW_ACTIONS[trip.waiting.at(-1).action].label + ' (waiting to send)' : doneWords(trip),
      ) +
      '</small></span></p>' +
      (soft
        ? '<button type="button" class="cr-link cr-back" data-cr-go="' +
          esc(soft) +
          '" data-trip="' +
          esc(trip.id) +
          '">' +
          esc(softLabel) +
          ' <small>(when you are back)</small></button>'
        : '') +
      '</article>'
    );
  const head =
    '<div class="cr-card-head"><span class="cr-time">' +
    esc(trip.time ?? '') +
    '</span><span class="cr-where"><b>' +
    (trip.direction === 'BACK' ? 'Bring back from ' : 'To ') +
    esc(trip.siteName) +
    '</b>' +
    (trip.address ? '<small>' + esc(trip.address) + '</small>' : '') +
    '</span></div>' +
    '<p class="cr-state st-' +
    esc(String(trip.state).toLowerCase()) +
    (trip.flag ? ' is-flag' : '') +
    '">' +
    esc(
      trip.waiting?.length ? CREW_ACTIONS[trip.waiting.at(-1).action].label + ' (waiting to send)' : trip.stateWords,
    ) +
    '</p>' +
    (trip.contact || trip.phone
      ? '<p class="cr-contact">' +
        esc(trip.contact ?? 'Site') +
        (trip.phone
          ? ' · <a href="tel:' + esc(String(trip.phone).replace(/[^+\d]/g, '')) + '">' + esc(trip.phone) + '</a>'
          : '') +
        '</p>'
      : '');
  let body;
  if (open) {
    const exp = expected(trip, open.action),
      a = open.action === 'tripReturned' && onTheRoad(trip) ? CREW_UNDELIVERED : CREW_ACTIONS[open.action],
      last = open.action === 'tripDelivered' && !v.rcv ? (v.lastRcv ?? '') : '';
    body =
      '<form class="cr-confirm" data-cr-form="' +
      esc(trip.id) +
      '"><p class="cr-ask">' +
      esc(a.ask) +
      '</p><ul class="cr-lines cr-edit">' +
      (trip.lines ?? [])
        .map((l) => {
          const q = v.draft?.[l.product] ?? exp.get(l.product) ?? 0,
            changed = q !== (exp.get(l.product) ?? 0);
          return (
            '<li' +
            (changed ? ' class="changed"' : '') +
            '><span class="cr-name">' +
            esc(l.name) +
            (changed ? '<small>Was ' + (exp.get(l.product) ?? 0) + '</small>' : '') +
            '</span><span class="cr-qty"><button type="button" class="cr-step" data-cr-step="-1" data-p="' +
            esc(l.product) +
            '" aria-label="One less ' +
            esc(l.name) +
            '">−</button><input type="number" inputmode="numeric" min="0" step="1" data-cr-q="' +
            esc(l.product) +
            '" value="' +
            q +
            '" aria-label="How many ' +
            esc(l.name) +
            '"><button type="button" class="cr-step" data-cr-step="1" data-p="' +
            esc(l.product) +
            '" aria-label="One more ' +
            esc(l.name) +
            '">+</button></span></li>'
          );
        })
        .join('') +
      '</ul>' +
      (open.action === 'tripDelivered'
        ? '<label class="cr-rcv"><span>Received by</span><input name="receivedBy" required maxlength="80" autocomplete="off" autocapitalize="words" placeholder="Their name" value="' +
          esc(v.rcv ?? '') +
          '"></label>' +
          (last
            ? '<button type="button" class="cr-chip" data-cr-rcv="' + esc(last) + '">' + esc(last) + ' again?</button>'
            : '')
        : '') +
      (v.formError ? '<p class="cr-err" role="alert">' + esc(v.formError) + '</p>' : '') +
      '<button type="submit" class="cr-big">' +
      esc(a.go ?? a.label) +
      '</button><button type="button" class="cr-link" data-cr-cancel>Not yet</button></form>';
  } else
    body =
      '<ul class="cr-lines">' +
      (trip.lines ?? [])
        .map(
          (l) =>
            '<li><span class="cr-name">' +
            esc(l.name) +
            '</span><b class="cr-n">' +
            (shown(trip, l) || 0) +
            '</b></li>',
        )
        .join('') +
      '</ul>' +
      (trip.lines?.length > 1 ? '<p class="cr-total">' + plural(pieces, 'piece') + '</p>' : '') +
      stepsHTML(trip, v.offline) +
      (main
        ? '<button type="button" class="cr-big" data-cr-go="' +
          esc(main) +
          '" data-trip="' +
          esc(trip.id) +
          '">' +
          esc(CREW_ACTIONS[main].label) +
          '</button>'
        : '') +
      (soft
        ? '<button type="button" class="cr-big cr-soft" data-cr-go="' +
          esc(soft) +
          '" data-trip="' +
          esc(trip.id) +
          '">' +
          esc(softLabel) +
          '</button>'
        : '');
  return (
    '<article class="cr-card' +
    (open ? ' is-open' : '') +
    (trip.flag ? ' is-flag' : '') +
    '" id="trip-' +
    esc(trip.id) +
    '">' +
    head +
    body +
    '</article>'
  );
}
// "The office already recorded Delivered for Bondi: 5 × Standard, received by Site foreman. You said 4 × Standard, Mo Ali. Call the office."
/** @param {any} p a problem from the tap queue @param {any} me */
export function conflictWords(p, me) {
  const c = p.conflict,
    trip = (me?.trips ?? []).find((t) => t.id === p.input?.trip);
  const names = new Map((trip?.lines ?? []).map((l) => [l.product, l.name]));
  const list = (lines) =>
    (lines ?? []).map((l) => l.quantity + ' × ' + (l.name ?? names.get(l.product) ?? 'material')).join(', ');
  const said = p.input?.lines ? list(p.input.lines.filter((l) => l.quantity > 0)) : list(c.said?.lines);
  return (
    '<b>' +
    esc('The office already recorded ' + (CREW_ACTIONS[p.action]?.label ?? 'this step')) +
    (trip ? ' for ' + esc(trip.siteName) : '') +
    ':</b> ' +
    esc(list(c.recorded?.lines) + (c.recorded?.receivedBy ? ', received by ' + c.recorded.receivedBy : '') + '.') +
    ' ' +
    esc('You said ' + said + (p.input?.receivedBy ? ', ' + p.input.receivedBy : '') + '. Call the office.')
  );
}
// ---------------------------------------------------------------- everyone's own asks; the yard hand's packs, counts and task; the leading hand's gang
/** A tap already waiting on this phone for a record (an ask, a trip, a booking). @param {any[]} pending @param {string} action @param {string} id */
const waitingFor = (pending, action, id) =>
  (pending ?? []).find(
    (t) => t.action === action && (t.input?.id === id || t.input?.trip === id || t.input?.item === id),
  );
const sending = (v) => (v.offline ? 'saved, sends when there is signal' : 'sending…');
/** One ask: "Can you make it?" with I'll be there / Can't make it (or Got it for a list to pack). @param {any} a @param {any} v */
export function askCard(a, v) {
  const w = waitingFor(v.pending, 'messageAnswer', a.id) ?? waitingFor(v.pending, 'messageSeen', a.id),
    open = v.open?.ask === a.id,
    when = esc(a.dayLabel + ' ' + (a.timeWords ?? '')),
    where = a.siteName ? esc(a.siteName) : '',
    done = !!w || !!a.answeredAt || a.seen || (!a.canAnswer && !a.canSee);
  const said = w
    ? w.action === 'messageSeen'
      ? 'Got it'
      : w.input?.yes
        ? 'I’ll be there'
        : 'Can’t make it' + (w.input?.reason ? ': ' + w.input.reason : '')
    : a.words;
  let body = '';
  if (open)
    body =
      '<form class="cr-confirm cr-no" data-cr-ask-form="' +
      esc(a.id) +
      '"><p class="cr-ask">Why not? One tap, or your own words.</p><div class="cr-reasons">' +
      CREW_REASONS.map(
        (r) =>
          '<button type="button" class="cr-chip' +
          (v.reason === r ? ' on' : '') +
          '" data-cr-reason="' +
          esc(r) +
          '">' +
          esc(r) +
          '</button>',
      ).join('') +
      '</div><label class="cr-rcv"><span>Or say why</span><input name="reason" maxlength="200" autocomplete="off" placeholder="A few words" value="' +
      esc(v.reason && !CREW_REASONS.includes(v.reason) ? v.reason : '') +
      '"></label>' +
      (v.formError ? '<p class="cr-err" role="alert">' + esc(v.formError) + '</p>' : '') +
      '<button type="submit" class="cr-big cr-soft">Send: can’t make it</button><button type="button" class="cr-link" data-cr-cancel>Never mind</button></form>';
  else if (!done)
    body =
      a.subject === 'PACK'
        ? '<button type="button" class="cr-big" data-cr-seen="' + esc(a.id) + '">Got it</button>'
        : '<div class="cr-two"><button type="button" class="cr-big" data-cr-yes="' +
          esc(a.id) +
          '">I’ll be there</button><button type="button" class="cr-big cr-soft" data-cr-no="' +
          esc(a.id) +
          '">Can’t make it</button></div>';
  return (
    '<article class="cr-card cr-askcard' +
    (done ? ' is-done' : '') +
    (open ? ' is-open' : '') +
    '" id="ask-' +
    esc(a.id) +
    '"><div class="cr-card-head"><span class="cr-time">' +
    esc(a.time ?? '') +
    '</span><span class="cr-where"><b>' +
    (a.subject === 'DRIVE'
      ? 'Drive' + (where ? ' to ' + where : '')
      : a.subject === 'PACK'
        ? 'Pack a list for ' + (where || 'a site')
        : 'Work at ' + (where || 'a site')) +
    '</b><small>' +
    when +
    (a.address ? ' · ' + esc(a.address) : '') +
    '</small></span></div>' +
    (a.text ? '<p class="cr-msg">' + esc(a.text) + '</p>' : '') +
    (done
      ? '<p class="cr-state st-' +
        (w ? 'wait' : a.answer === 'YES' || a.seen ? 'yes' : a.answer === 'NO' ? 'no' : 'off') +
        '">' +
        esc(said) +
        (w ? ' · ' + sending(v) : '') +
        '</p>'
      : '') +
    (a.directions && !done
      ? '<p class="cr-contact"><a href="' + esc(a.directions) + '" rel="noopener">Directions</a></p>'
      : '') +
    body +
    '</article>'
  );
}
const lineEdit = (l, q, was) =>
  '<li' +
  (q !== was ? ' class="changed"' : '') +
  '><span class="cr-name">' +
  esc(l.name) +
  (q !== was ? '<small>Was ' + was + '</small>' : '') +
  '</span><span class="cr-qty"><button type="button" class="cr-step" data-cr-step="-1" data-p="' +
  esc(l.product) +
  '" aria-label="One less ' +
  esc(l.name) +
  '">−</button><input type="number" inputmode="numeric" min="0" step="1" data-cr-q="' +
  esc(l.product) +
  '" value="' +
  q +
  '" aria-label="How many ' +
  esc(l.name) +
  '"><button type="button" class="cr-step" data-cr-step="1" data-p="' +
  esc(l.product) +
  '" aria-label="One more ' +
  esc(l.name) +
  '">+</button></span></li>';
/** A list to pack (the yard hand): the lines, and Packed with counts. @param {any} trip @param {any} v */
export function packCard(trip, v) {
  const w = waitingFor(v.pending, 'packConfirmed', trip.id),
    open = v.open?.pack === trip.id,
    packed = trip.state === 'PACKED' || !!w;
  let body;
  if (open)
    body =
      '<form class="cr-confirm" data-cr-pack-form="' +
      esc(trip.id) +
      '"><p class="cr-ask">' +
      CREW_ACTIONS.packConfirmed.ask +
      '</p><ul class="cr-lines cr-edit">' +
      (trip.lines ?? []).map((l) => lineEdit(l, v.draft?.[l.product] ?? l.asked, l.asked)).join('') +
      '</ul>' +
      (v.formError ? '<p class="cr-err" role="alert">' + esc(v.formError) + '</p>' : '') +
      '<button type="submit" class="cr-big">Packed</button><button type="button" class="cr-link" data-cr-cancel>Not yet</button></form>';
  else
    body =
      '<ul class="cr-lines">' +
      (trip.lines ?? [])
        .map(
          (l) =>
            '<li><span class="cr-name">' +
            esc(l.name) +
            (!packed && l.held < l.asked ? '<small>' + l.held + ' held in the yard</small>' : '') +
            (packed && l.packed != null && l.packed !== l.asked ? '<small>Asked ' + l.asked + '</small>' : '') +
            '</span><b class="cr-n">' +
            (packed ? (w?.lines?.find((x) => x.product === l.product)?.quantity ?? l.packed ?? l.asked) : l.asked) +
            '</b></li>',
        )
        .join('') +
      '</ul>' +
      (packed
        ? '<p class="cr-state st-yes">Packed' + (w ? ' · ' + sending(v) : '') + '</p>'
        : '<button type="button" class="cr-big" data-cr-pack="' + esc(trip.id) + '">Packed</button>');
  return (
    '<article class="cr-card' +
    (packed ? ' is-done' : '') +
    (open ? ' is-open' : '') +
    '" id="pack-' +
    esc(trip.id) +
    '"><div class="cr-card-head"><span class="cr-time">' +
    esc(trip.time ?? '') +
    '</span><span class="cr-where"><b>' +
    esc(trip.label + ' for ' + trip.siteName) +
    '</b><small>' +
    esc((trip.day === v.me?.today ? 'Today' : 'Tomorrow') + (trip.truckName ? ' · ' + trip.truckName : '')) +
    (trip.driverName ? ' with ' + esc(trip.driverName) : '') +
    '</small></span></div>' +
    body +
    '</article>'
  );
}
/** A return back at the yard, not counted yet (the yard hand): Count it, per material. @param {any} trip @param {any} v */
export function returnCard(trip, v) {
  const w = waitingFor(v.pending, 'returnCount', trip.id),
    open = v.open?.count === trip.id;
  const body = open
    ? '<form class="cr-confirm" data-cr-count-form="' +
      esc(trip.id) +
      '"><p class="cr-ask">' +
      CREW_ACTIONS.returnCount.ask +
      '</p><ul class="cr-lines cr-edit">' +
      (trip.lines ?? [])
        .filter((l) => l.onTruck > 0 || l.collected > 0)
        .map((l) => lineEdit(l, v.draft?.[l.product] ?? l.onTruck, l.onTruck))
        .join('') +
      '</ul>' +
      (v.formError ? '<p class="cr-err" role="alert">' + esc(v.formError) + '</p>' : '') +
      '<button type="submit" class="cr-big">Counted</button><button type="button" class="cr-link" data-cr-cancel>Not yet</button></form>'
    : w
      ? '<p class="cr-state st-wait">Counted · ' + sending(v) + '</p>'
      : '<ul class="cr-lines">' +
        (trip.lines ?? [])
          .map(
            (l) =>
              '<li><span class="cr-name">' +
              esc(l.name) +
              '</span><b class="cr-n">' +
              (l.onTruck || l.collected || 0) +
              '</b></li>',
          )
          .join('') +
        '</ul><button type="button" class="cr-big" data-cr-count="' +
        esc(trip.id) +
        '">Count it</button>';
  return (
    '<article class="cr-card' +
    (open ? ' is-open' : '') +
    '" id="count-' +
    esc(trip.id) +
    '"><div class="cr-card-head"><span class="cr-time">' +
    esc(trip.time ?? '') +
    '</span><span class="cr-where"><b>' +
    esc(trip.label + ' back from ' + trip.siteName) +
    '</b><small>Back at the yard, not counted yet' +
    (trip.driverName ? ' · ' + esc(trip.driverName) : '') +
    '</small></span></div>' +
    body +
    '</article>'
  );
}
/** The leading hand's gang for a booking: who said yes, who is on site; On site and Day done. @param {any} g @param {any} v */
export function gangCard(g, v) {
  const on = waitingFor(v.pending, 'crewSignOn', g.item),
    done = waitingFor(v.pending, 'planDone', g.item),
    open = v.open?.gang === g.item;
  const people = (g.people ?? [])
    .map(
      (p) =>
        '<li><span class="cr-name">' +
        esc(p.name) +
        '</span><span class="cr-pill ' +
        (p.onSite || p.answer === 'YES' ? 'yes' : p.answer === 'NO' ? 'no' : 'wait') +
        '">' +
        esc(
          p.onSite
            ? 'On site'
            : p.answer === 'YES'
              ? 'Said yes'
              : p.answer === 'NO'
                ? 'Can’t make it'
                : 'No answer yet',
        ) +
        '</span></li>',
    )
    .join('');
  const here = (g.people ?? []).filter((p) => p.onSite).length;
  let body = '<ul class="cr-lines cr-people">' + people + '</ul>';
  if (open) {
    const chosen = v.who ?? (g.people ?? []).filter((p) => p.answer === 'YES' && !p.onSite).map((p) => p.person);
    body +=
      '<form class="cr-confirm" data-cr-on-form="' +
      esc(g.item) +
      '"><p class="cr-ask">Who is here?</p><ul class="cr-who">' +
      (g.people ?? [])
        .filter((p) => !p.onSite)
        .map(
          (p) =>
            '<li><label><input type="checkbox" data-cr-who="' +
            esc(p.person) +
            '"' +
            (chosen.includes(p.person) ? ' checked' : '') +
            '><span>' +
            esc(p.name) +
            '</span></label></li>',
        )
        .join('') +
      '</ul>' +
      (v.formError ? '<p class="cr-err" role="alert">' + esc(v.formError) + '</p>' : '') +
      '<button type="submit" class="cr-big">On site</button><button type="button" class="cr-link" data-cr-cancel>Not yet</button></form>';
  } else if (done) body += '<p class="cr-state st-yes">Day done · ' + sending(v) + '</p>';
  else if (on) body += '<p class="cr-state st-wait">On site · ' + sending(v) + '</p>';
  else if (g.canSignOn || (g.canDone && here))
    body +=
      '<div class="cr-two">' +
      (g.canSignOn ? '<button type="button" class="cr-big" data-cr-on="' + esc(g.item) + '">On site</button>' : '') +
      (g.canDone && here
        ? '<button type="button" class="cr-big cr-soft" data-cr-done="' + esc(g.item) + '">Day done</button>'
        : '') +
      '</div>';
  else if (g.dayWords === 'Tomorrow') body += '<p class="cr-state st-off">On site is a tap on the day.</p>';
  return (
    '<article class="cr-card' +
    (open ? ' is-open' : '') +
    '" id="gang-' +
    esc(g.item) +
    '"><div class="cr-card-head"><span class="cr-time">' +
    esc(g.time ?? '') +
    '</span><span class="cr-where"><b>' +
    esc('Your gang at ' + g.siteName) +
    '</b><small>' +
    esc(
      (g.dayWords ? g.dayWords + ' · ' : '') +
        (g.dayWords === 'Tomorrow'
          ? (g.people ?? []).filter((p) => p.answer === 'YES').length + ' of ' + (g.people ?? []).length + ' said yes'
          : here + ' of ' + (g.people ?? []).length + ' on site'),
    ) +
    '</small></span></div>' +
    body +
    '</article>'
  );
}
/** A yard task (the re-stack): one Done tap. @param {any} x @param {any} v */
export function taskCard(x, v) {
  const w = waitingFor(v.pending, 'planDone', x.id);
  return (
    '<article class="cr-card' +
    (w ? ' is-done' : '') +
    '" id="task-' +
    esc(x.id) +
    '"><div class="cr-card-head"><span class="cr-time">' +
    esc(x.time ?? '') +
    '</span><span class="cr-where"><b>' +
    esc(x.words) +
    '</b><small>' +
    (x.dayWords ? esc(x.dayWords) + ' · ' : '') +
    'Top up the part-full stillages, stack the empties. Nothing leaves the yard.</small></span></div>' +
    (w
      ? '<p class="cr-state st-yes">Done · ' + sending(v) + '</p>'
      : x.canDone === false
        ? '<p class="cr-state st-off">Done is a tap on the day.</p>'
        : '<button type="button" class="cr-big" data-cr-done="' + esc(x.id) + '">Done</button>') +
    '</article>'
  );
}
/** "My trips" for a driver, "My day" for anyone else. @param {any} me */
export const crewTitle = (me) =>
  (me?.person?.kind === 'worker' ? 'My day, ' : 'My trips, ') + (me?.person?.name ?? me?.driver?.name ?? '');
/** The whole page. @param {any} v */
export function crewPage(v) {
  if (v.notSigned) {
    const why = String(v.notSigned)
        .replace(/^This phone is not signed in\.?\s*/, '')
        .replace(/Ask the office for a (new )?link\.?/, '')
        .trim(),
      waiting = (v.pending ?? []).length;
    return (
      '<section class="cr-gate">' +
      TRUCK +
      '<h1>This phone is not signed in</h1>' +
      (why ? '<p>' + esc(why) + '</p>' : '') +
      (waiting
        ? '<p class="cr-bar off">' +
          esc(
            plural(waiting, 'tap') +
              ' on this phone ' +
              (waiting === 1 ? 'is' : 'are') +
              ' waiting. They send once you sign in again.',
          ) +
          '</p>'
        : '') +
      '<p class="cr-small">Ask the office for a new link, then open it on this phone.</p></section>'
    );
  }
  if (!v.me)
    return '<p class="cr-loading">' + esc(v.offline ? 'No signal yet. Trying again…' : 'Loading your trips…') + '</p>';
  const me = v.me,
    trips = (me.trips ?? []).map((t) => crewTrip(t, v.pending ?? []));
  const groups = new Map();
  for (const t of trips) {
    const day = crewDay(t),
      k = !crewButtons(t).main ? 'done' : day < me.today ? 'open' : day;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const rank = (k) => (k === 'open' ? '0' : k === 'done' ? '9' : '1' + k);
  const order = [...groups.keys()].sort((a, b) => rank(a).localeCompare(rank(b)));
  const waiting = (v.pending ?? []).length;
  const bar =
    (v.offline
      ? '<p class="cr-bar off" role="status"><span class="cr-dot" aria-hidden="true"></span>No signal. Your taps are saved on this phone and send by themselves.' +
        (v.cachedAt ? ' Trips as at ' + esc(hm(v.cachedAt)) + '.' : '') +
        '</p>'
      : waiting
        ? '<p class="cr-bar" role="status"><span class="cr-dot" aria-hidden="true"></span>' +
          plural(waiting, 'tap') +
          ' waiting to send</p>'
        : '') +
    (v.problems ?? [])
      .map(
        (p, i) =>
          '<div class="cr-problem" role="alert"><p>' +
          (p.conflict
            ? conflictWords(p, me)
            : '<b>Not recorded: ' + esc(CREW_ACTIONS[p.action]?.label ?? 'a tap') + '</b> ' + esc(p.error)) +
          '</p><button type="button" class="cr-link" data-cr-ok="' +
          i +
          '">OK</button></div>',
      )
      .join('');
  const driver = me.person ? me.person.kind === 'driver' : true;
  const list = order.length
    ? order
        .map(
          (k) =>
            '<h2 class="cr-day">' +
            esc(k === 'open' ? 'Still open' : k === 'done' ? 'Done' : dayWords(k, me.today)) +
            '</h2>' +
            groups
              .get(k)
              .map((t) => tripCard(t, v))
              .join(''),
        )
        .join('')
    : driver
      ? '<section class="cr-none">' +
        TRUCK +
        '<h2>No trips for you today</h2><p>New trips show here when the office books them.</p></section>'
      : '';
  // everyone's own asks first (an unanswered one is the thing to do), then the yard hand's and leading hand's work, then a driver's trips
  const asks = (me.asks ?? [])
    .slice()
    .sort((a, b) => Number(!a.canAnswer && !a.canSee) - Number(!b.canAnswer && !b.canSee));
  const section = (title, cards) => (cards.length ? '<h2 class="cr-day">' + title + '</h2>' + cards.join('') : '');
  const other =
    section(
      'Can you make it?',
      asks.map((a) => askCard(a, v)),
    ) +
    section(
      'Your gang',
      (me.gang ?? []).map((g) => gangCard(g, v)),
    ) +
    section(
      'Lists to pack',
      (me.packs ?? []).map((t) => packCard(t, v)),
    ) +
    section(
      'Count what came back',
      (me.returns ?? []).map((t) => returnCard(t, v)),
    ) +
    section(
      'Yard jobs',
      (me.tasks ?? []).map((x) => taskCard(x, v)),
    );
  const quiet =
    !driver && !other && !order.length
      ? '<section class="cr-none">' +
        TRUCK +
        '<h2>Nothing for you right now</h2><p>Asks from the office show here. Answer them with one tap.</p></section>'
      : '';
  return (
    '<header class="cr-top">' +
    TRUCK +
    '<div><b>' +
    esc(typeof me.company === 'string' ? me.company : (me.company?.name ?? 'Scaffold Yard')) +
    '</b><h1>' +
    esc(crewTitle(me)) +
    '</h1></div></header>' +
    bar +
    other +
    list +
    quiet +
    '<footer class="cr-foot"><button type="button" class="cr-link" data-cr-refresh>' +
    (driver ? 'Check for new trips' : 'Check for new asks') +
    '</button><button type="button" class="cr-link cr-out" data-cr-signout>Sign out this phone</button></footer>'
  );
}

// ---------------------------------------------------------------- the page (a browser only)
const CACHE = 'sy-crew-me',
  RCV = 'sy-crew-rcv:';
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, val) {
    try {
      localStorage.setItem(k, val);
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
function boot() {
  const root = document.getElementById('crew');
  if (!root) return;
  /** @type {any} */
  const V = {
    me: null,
    open: null,
    draft: {},
    rcv: '',
    reason: '',
    who: null,
    offline: false,
    cachedAt: null,
    notSigned: null,
    formError: null,
  };
  const queue = createCrewQueue(store, sendTap, {
    onDone: (t, answer) => {
      if (answer.status < 300 && answer.body?.trip) patchTrip(answer.body.trip);
    },
  });
  try {
    const c = JSON.parse(store.get(CACHE) ?? 'null');
    if (c?.me) Object.assign(V, { me: c.me, cachedAt: c.at });
  } catch {}
  const draw = () => {
    if (root.querySelector('.cr-confirm')?.contains(document.activeElement) && V.open?.hold) return;
    V.pending = queue.pending();
    V.problems = queue.problems();
    root.innerHTML = crewPage(V);
  };
  const patchTrip = (t) => {
    if (!V.me) return;
    V.me = { ...V.me, trips: V.me.trips.map((x) => (x.id === t.id ? { ...x, ...t } : x)) };
  };
  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const r = await fetch('/api/crew/me', { credentials: 'same-origin' });
      const body = await r.json().catch(() => null);
      if (r.status === 401) {
        V.notSigned = body?.error ?? 'This phone is not signed in.';
        store.del(CACHE);
      } else if (r.ok) {
        V.notSigned = null;
        queue.signedIn();
        V.me = body;
        V.offline = false;
        V.cachedAt = new Date().toISOString();
        store.set(CACHE, JSON.stringify({ me: body, at: V.cachedAt }));
      } else V.offline = true;
    } catch {
      V.offline = true;
    } finally {
      loading = false;
    }
    if (!V.open) draw();
  }
  async function flush() {
    if (!queue.pending().length) return;
    try {
      await queue.flush();
    } finally {
      // something could not be sent: no signal (or the office computer is off), or this phone was signed out (its taps wait for a new link)
      if (queue.signedOut()) V.notSigned = V.notSigned ?? 'This phone is not signed in.';
      V.offline = queue.pending().length > 0 && !queue.signedOut();
      if (!queue.pending().length) await load();
      else draw();
    }
  }
  // the link: claim it once, then take it out of the address bar (and the phone's history)
  async function claim(token) {
    history.replaceState(null, '', location.pathname);
    const ua = navigator.userAgent || '',
      label = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
    try {
      const r = await fetch('/api/crew/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, label }),
        credentials: 'same-origin',
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) queue.signedIn(); // taps kept while signed out go now
      if (!r.ok) {
        // a phone already signed in keeps working even if it opens an old link again
        const me = await fetch('/api/crew/me', { credentials: 'same-origin' }).catch(() => null);
        if (!me?.ok) V.notSigned = body.error ?? 'This link has expired or was already used.';
      }
    } catch {
      V.offline = true;
    }
  }
  // one of the new taps (an answer, a pack, a count, On site, Done): kept on the phone first, then sent
  const tapNow = (action, input) => {
    queue.tap(action, input);
    V.open = null;
    V.draft = {};
    V.reason = '';
    V.who = null;
    V.formError = null;
    draw();
    flush();
  };
  const openFor = (tripId, action) => {
    V.open = { trip: tripId, action };
    V.draft = {};
    V.formError = null;
    const t = V.me?.trips.find((x) => x.id === tripId);
    // never filled in for the driver: the name used last time at this site is offered as a chip to tap
    V.rcv = '';
    V.lastRcv = action === 'tripDelivered' && t ? (store.get(RCV + t.site) ?? '') : '';
    draw();
    const card = document.getElementById('trip-' + tripId);
    card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (action === 'tripDelivered') card?.querySelector('input[name=receivedBy]')?.focus({ preventScroll: true });
  };
  root.addEventListener('click', async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    if (b.dataset.crGo) return openFor(b.dataset.trip, b.dataset.crGo);
    if (b.dataset.crYes) return tapNow('messageAnswer', { id: b.dataset.crYes, yes: true });
    if (b.dataset.crSeen) return tapNow('messageSeen', { id: b.dataset.crSeen });
    if (b.dataset.crNo) {
      V.open = { ask: b.dataset.crNo };
      V.reason = '';
      V.formError = null;
      draw();
      document.getElementById('ask-' + b.dataset.crNo)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (b.dataset.crReason) {
      V.reason = V.reason === b.dataset.crReason ? '' : b.dataset.crReason;
      V.formError = null;
      draw();
      return;
    }
    if (b.dataset.crPack || b.dataset.crCount || b.dataset.crOn) {
      V.open = b.dataset.crPack
        ? { pack: b.dataset.crPack }
        : b.dataset.crCount
          ? { count: b.dataset.crCount }
          : { gang: b.dataset.crOn };
      V.draft = {};
      V.who = null;
      V.formError = null;
      draw();
      const id =
        (b.dataset.crPack ? 'pack-' : b.dataset.crCount ? 'count-' : 'gang-') +
        (b.dataset.crPack ?? b.dataset.crCount ?? b.dataset.crOn);
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (b.dataset.crDone) return tapNow('planDone', { id: b.dataset.crDone });
    if (b.dataset.crRcv) {
      V.rcv = b.dataset.crRcv;
      V.formError = null;
      draw();
      return;
    }
    if (b.hasAttribute('data-cr-cancel')) {
      V.open = null;
      V.reason = '';
      V.who = null;
      V.formError = null;
      draw();
      return;
    }
    if (b.dataset.crStep) {
      const p = b.dataset.p,
        input = root.querySelector('[data-cr-q="' + CSS.escape(p) + '"]');
      const q = Math.max(0, (Number(/** @type {HTMLInputElement} */ (input)?.value) || 0) + Number(b.dataset.crStep));
      V.draft[p] = q;
      V.rcv = /** @type {HTMLInputElement} */ (root.querySelector('input[name=receivedBy]'))?.value ?? V.rcv;
      draw();
      return;
    }
    if (b.dataset.crOk) {
      const list = queue.problems();
      list.splice(Number(b.dataset.crOk), 1);
      store.set('sy-crew-problems', JSON.stringify(list));
      draw();
      return;
    }
    if (b.hasAttribute('data-cr-refresh')) {
      await flush();
      await load();
      return;
    }
    if (b.hasAttribute('data-cr-signout')) {
      const n = queue.pending().length;
      if (
        !confirm(
          (n ? plural(n, 'tap') + ' on this phone ' + (n === 1 ? 'has' : 'have') + ' not been sent yet. ' : '') +
            'Sign out this phone? You will need a new link from the office to sign in again.',
        )
      )
        return;
      try {
        await fetch('/api/crew/signout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        });
      } catch {}
      store.del(CACHE);
      V.me = null;
      V.notSigned = 'You signed out this phone.';
      draw();
    }
  });
  root.addEventListener('input', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.dataset.crQ) {
      V.draft[t.dataset.crQ] = Math.max(0, Math.floor(Number(t.value) || 0));
      t.closest('li')?.classList.toggle('changed', true);
    }
    if (t.name === 'receivedBy') V.rcv = t.value;
    if (t.name === 'reason') V.reason = t.value;
    if (t.dataset.crWho) {
      const list = [...root.querySelectorAll('[data-cr-who]')]
        .filter((i) => /** @type {HTMLInputElement} */ (i).checked)
        .map((i) => /** @type {HTMLElement} */ (i).dataset.crWho);
      V.who = list;
    }
  });
  // the counts typed into a pack or a count form, per material
  const typed = (f, key) => {
    const lines = [];
    for (const i of f.querySelectorAll('[data-cr-q]')) {
      const el = /** @type {HTMLInputElement} */ (i);
      lines.push({ product: el.dataset.crQ ?? '', quantity: Math.max(0, Math.floor(Number(el.value) || 0)) });
    }
    return lines;
  };
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = /** @type {HTMLFormElement} */ (e.target);
    if (!V.open) return;
    if (f.dataset.crAskForm) {
      const reason = String(V.reason ?? new FormData(f).get('reason') ?? '').trim();
      tapNow('messageAnswer', { id: f.dataset.crAskForm, yes: false, ...(reason ? { reason } : {}) });
      return;
    }
    if (f.dataset.crPackForm) {
      const trip = V.me?.packs?.find((t) => t.id === f.dataset.crPackForm),
        lines = typed(f);
      if (!trip) return;
      const changed = lines.some((l) => l.quantity !== (trip.lines.find((x) => x.product === l.product)?.asked ?? 0));
      tapNow('packConfirmed', changed ? { trip: trip.id, lines } : { trip: trip.id });
      return;
    }
    if (f.dataset.crCountForm) {
      const trip = V.me?.returns?.find((t) => t.id === f.dataset.crCountForm),
        lines = typed(f);
      if (!trip) return;
      tapNow('returnCount', { trip: trip.id, lines });
      return;
    }
    if (f.dataset.crOnForm) {
      const g = V.me?.gang?.find((x) => x.item === f.dataset.crOnForm);
      if (!g) return;
      const people =
        V.who ??
        [...f.querySelectorAll('[data-cr-who]')]
          .filter((i) => /** @type {HTMLInputElement} */ (i).checked)
          .map((i) => /** @type {HTMLElement} */ (i).dataset.crWho);
      if (!people.length) {
        V.formError = 'Tick who is here.';
        draw();
        return;
      }
      tapNow('crewSignOn', { item: g.item, people });
      return;
    }
    const trip = V.me?.trips.map((t) => crewTrip(t, queue.pending())).find((t) => t.id === V.open.trip);
    if (!trip) return;
    const action = V.open.action,
      exp = expected(trip, action);
    for (const i of f.querySelectorAll('[data-cr-q]'))
      V.draft[/** @type {HTMLInputElement} */ (i).dataset.crQ] = Math.max(
        0,
        Math.floor(Number(/** @type {HTMLInputElement} */ (i).value) || 0),
      );
    const lines = [...exp].map(([product, q]) => ({ product, quantity: V.draft[product] ?? q }));
    const changed = lines.some((l) => l.quantity !== exp.get(l.product));
    /** @type {any} */
    const input = { trip: trip.id };
    if (changed) input.lines = lines;
    if (action === 'tripDelivered') {
      const name = String(new FormData(f).get('receivedBy') ?? '').trim();
      if (!name) {
        V.formError = 'Type the name of the person who took it.';
        V.rcv = '';
        draw();
        root.querySelector('input[name=receivedBy]')?.focus();
        return;
      }
      input.receivedBy = name;
      store.set(RCV + trip.site, name);
    }
    if (!lines.some((l) => l.quantity > 0) && action !== 'tripReturned') {
      V.formError = 'Nothing on the list. If nothing went, call the office.';
      draw();
      return;
    }
    queue.tap(action, input); // kept on the phone first, with its own key, then sent
    V.open = null;
    V.draft = {};
    draw();
    flush();
  });
  addEventListener('online', () => {
    V.offline = false;
    flush();
  });
  addEventListener('offline', () => {
    V.offline = true;
    draw();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush().then(load);
  });
  // the page itself opens with no signal (a secure address only: https, or this computer)
  if ('serviceWorker' in navigator && window.isSecureContext)
    navigator.serviceWorker.register('/crew-sw.js', { scope: '/crew' }).catch(() => {});
  setInterval(() => flush(), 15000);
  setInterval(() => {
    if (!V.open && document.visibilityState !== 'hidden') load();
  }, 45000);
  (async () => {
    const t = /^#t=([0-9a-f]{64})$/.exec(location.hash);
    if (t) await claim(t[1]);
    draw();
    await load();
    await flush();
  })();
}
if (typeof document !== 'undefined' && typeof window !== 'undefined') boot();
