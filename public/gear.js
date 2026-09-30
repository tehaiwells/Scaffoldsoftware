// Gear lists on screen (ADR 0011): the "+ Gear list" form of Daily activities (From / To, the parts, date, time, truck, driver, workers),
// the chain of dots on a list's card (Arrived · Packed · Loaded · Arrived · Landed), the week's lists on the Gear list page. Pure HTML
// functions (the tests render them in Node); operations.js wires the events and sends the one command, gearListCreate. Same look as the
// rest of Today: the tdh-* fields and pills, the lt-dot dots. Nothing here changes a record by itself.
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** The tone of a chain dot: the lanes' dot classes (live-today.js / design.css). */
const DOT_TONE = {
  ARRIVED_PICKUP: 'arrived',
  PACKED: 'packed',
  LOADED: 'road',
  COLLECTED: 'road',
  ARRIVED_DROP: 'atsite',
  DELIVERED: 'done',
  RETURNED: 'back',
};
/** 'HH:MM' from an ISO time on this computer's clock. @param {string} iso */
const hm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
/** "→ Bondi", "Bondi → Manly", "← Bondi": the arrow the item view carries, else made from from/to. @param {any} v */
export const glArrow = (v) =>
  v.arrow ??
  (v.direction === 'MOVE'
    ? (v.from?.name ?? '?') + ' → ' + (v.to?.name ?? '?')
    : v.direction === 'BACK'
      ? '← ' + (v.from?.name ?? 'site')
      : '→ ' + (v.to?.name ?? v.siteName ?? 'site'));
/**
 * The chain as dots with the words under each: filled when done (with the time and who), hollow when not.
 * @param {any[]} chain the item's or trip's chain @param {{arrival?:{step:string,words:string,trip:string}|null,ops?:boolean,small?:boolean}} [opts]
 */
export function glChainHTML(chain, { arrival = null, ops = false, small = false } = {}) {
  if (!Array.isArray(chain) || !chain.length) return '';
  const dots = chain
    .map((c) => {
      const who = c.byName
        ? c.kind === 'ON_BEHALF'
          ? 'recorded by ' + c.byName
          : c.kind === 'ENGINE'
            ? 'the yard'
            : c.byName
        : '';
      return (
        '<li class="gl-step' +
        (c.done ? ' done' : '') +
        '" data-gl-step="' +
        esc(c.step) +
        '"><i class="lt-dot dot-' +
        esc(c.done ? (DOT_TONE[c.step] ?? 'done') : 'todo') +
        '" aria-hidden="true"></i><span class="gl-step-w">' +
        esc(c.words) +
        '</span>' +
        (c.done ? '<small>' + esc(hm(c.at) + (who ? ' · ' + who : '')) + '</small>' : '') +
        '</li>'
      );
    })
    .join('');
  const n = chain.filter((c) => c.done).length;
  return (
    '<div class="gl-chain-wrap' +
    (small ? ' is-small' : '') +
    '"><ol class="gl-chain" aria-label="' +
    esc(n + ' of ' + chain.length + ' steps confirmed') +
    '">' +
    dots +
    '</ol>' +
    (ops && arrival
      ? '<button type="button" class="secondary tdh-btn gl-arrive" data-tdh-arrive="' +
        esc(arrival.trip) +
        '">' +
        esc(arrival.words) +
        '</button>'
      : '') +
    '</div>'
  );
}
/**
 * The workers on a list's task, one line each with their three ticks (Received · Packed · Loaded), from the task view (CREW's part);
 * nothing when the list has no task.
 * @param {any} task
 */
export function glTaskHTML(task) {
  if (!task || !Array.isArray(task.workers) || !task.workers.length) return '';
  const box = (mark, words) =>
    '<span class="gl-tick' + (mark ? ' on' : '') + '" title="' + esc(words) + '">' + (mark ? '✓' : '') + '</span>';
  return (
    '<ul class="gl-task">' +
    task.workers
      .map(
        (w) =>
          '<li><b>' +
          esc(w.name ?? 'Worker') +
          (w.priority ? ' <small>P' + esc(w.priority) + '</small>' : '') +
          '</b><span class="gl-ticks">' +
          box(w.steps?.RECEIVED, 'Received the list') +
          box(w.steps?.PACKED ?? task.steps?.PACKED, 'Packed and ready') +
          box(w.steps?.LOADED ?? task.steps?.LOADED, 'Truck loaded') +
          '</span>' +
          (w.cantWork
            ? '<span class="tdh-pill no">Can’t work that day</span>'
            : w.answer === 'NO'
              ? '<span class="tdh-pill no">Can’t make it</span>'
              : '') +
          '</li>',
      )
      .join('') +
    '</ul>'
  );
}
/**
 * The gear block of a list's card on Daily activities: From → To, the truck and driver with the driver's answer, the chain, the task.
 * @param {any} v the item view @param {{ops?:boolean,live?:boolean,answerPill?:(a:string)=>string}} [opts]
 */
export function glItemHTML(v, { ops = false, live = false, answerPill = null, arrive = true } = {}) {
  const t = v.truckItem;
  const pill = (a) => (answerPill ? answerPill(a) : a ? '<span class="tdh-pill">' + esc(a) + '</span>' : '');
  const truck = t
    ? '<p class="tdh-meta gl-truck"><b>' +
      esc(t.truckName) +
      '</b>' +
      (t.driverName
        ? ' · ' + esc(t.driverName) + ' ' + pill(v.readyAsk?.answer === 'YES' ? 'YES' : t.driverAnswer)
        : ' · no driver named') +
      (v.readyAsk?.answer === 'YES'
        ? ' <small>ready for the day</small>'
        : v.readyAsk?.answer === 'WAITING'
          ? ' <small>asked to be ready</small>'
          : v.readyAsk?.answer === 'NO'
            ? ''
            : v.readyNotAsked
              ? ' <small>not asked in time</small>'
              : '') +
      '</p>'
    : '<p class="tdh-problem">No truck yet. Book one so the gear goes.</p>';
  return (
    '<p class="tdh-meta gl-route"><b>' +
    esc((v.from?.name ?? 'the yard') + ' → ' + (v.to?.name ?? 'the site')) +
    '</b>' +
    (v.order ? ' · ' + esc(v.order) : '') +
    '</p>' +
    truck +
    glChainHTML(v.chain, { arrival: live && ops && arrive ? v.arrival : null, ops }) +
    glTaskHTML(v.task)
  );
}
/** The three-way From / To picker: This yard or a site. @param {'from'|'to'} side @param {any} f @param {any[]} sites */
function placeHTML(side, f, sites) {
  const kind = f[side + 'Kind'] ?? (side === 'from' ? 'yard' : 'site'),
    siteId = f[side + 'Site'] ?? '',
    seg = (k, words) =>
      '<button type="button" class="lt-seg' +
      (kind === k ? ' on' : '') +
      '" data-gl-place="' +
      side +
      ':' +
      k +
      '" aria-pressed="' +
      (kind === k) +
      '">' +
      words +
      '</button>';
  return (
    '<div class="tdh-field gl-place"><span>' +
    (side === 'from' ? 'From' : 'To') +
    '</span><div class="lt-segs" role="group" aria-label="' +
    (side === 'from' ? 'From where' : 'To where') +
    '">' +
    seg('yard', 'This yard') +
    seg('site', 'A site') +
    '</div>' +
    (kind === 'site'
      ? '<select name="' +
        side +
        'Site" aria-label="' +
        (side === 'from' ? 'From which site' : 'To which site') +
        '">' +
        (sites.length
          ? sites
              .map(
                (s) =>
                  '<option value="' +
                  esc(s.id) +
                  '"' +
                  (s.id === siteId ? ' selected' : '') +
                  '>' +
                  esc(s.name) +
                  '</option>',
              )
              .join('')
          : '<option value="" disabled selected>No sites yet</option>') +
        '</select>'
      : '') +
    '</div>'
  );
}
/** Where a form's From / To point, as the command wants them. @param {any} f */
export const glPlaces = (f) => ({
  from: (f.fromKind ?? 'yard') === 'yard' ? { kind: 'yard' } : { kind: 'site', id: f.fromSite || '' },
  to: (f.toKind ?? 'site') === 'yard' ? { kind: 'yard' } : { kind: 'site', id: f.toSite || '' },
});
/** Can the form be sent? (the server checks everything again) @param {any} f */
export function glFormOk(f) {
  const p = glPlaces(f);
  if (p.from.kind === 'yard' && p.to.kind === 'yard') return false;
  if (p.from.kind === 'site' && !p.from.id) return false;
  if (p.to.kind === 'site' && !p.to.id) return false;
  if (p.from.kind === 'site' && p.to.kind === 'site' && p.from.id === p.to.id) return false;
  return Array.isArray(f.lines) && f.lines.length > 0;
}
/** The direction a form describes, for its words. @param {any} f */
export const glDirection = (f) => {
  const p = glPlaces(f);
  return p.from.kind === 'yard' ? 'OUT' : p.to.kind === 'yard' ? 'BACK' : 'MOVE';
};
/** The default name for a form: the destination's ('Bondi gear', 'Yard gear'). @param {any} f @param {any[]} sites */
export const glDefaultName = (f, sites) => {
  const p = glPlaces(f);
  if (p.to.kind === 'yard') return 'Yard gear';
  const s = sites.find((x) => x.id === p.to.id);
  return s ? s.name + ' gear' : '';
};
/**
 * The form's fields (inside Today's tdh-fields grid), the words under it and the button's words.
 * @param {any} f the draft @param {{sites:any[],trucks:any[],drivers:any[],taken:any,workers:any[],dayLabel:string,live:boolean,hire:boolean,
 *   timesHTML:string,pickHTML:string,opt:(v:string,l:string,sel:boolean,dis?:boolean)=>string,today:string|null,bookedDriver:(truckId:string)=>string|null}} ctx
 */
export function glFormHTML(f, ctx) {
  const field = (label, html, cls = '') =>
    '<label class="tdh-field' + cls + '"><span>' + label + '</span>' + html + '</label>';
  const places = glPlaces(f),
    name = f.name ?? '',
    nameHint = glDefaultName(f, ctx.sites);
  const tOpts =
    ctx.trucks
      .map((t) =>
        ctx.opt(
          t.id,
          t.name + (t.big ? ' (big truck)' : ' (small truck)') + (ctx.taken.trucks.includes(t.id) ? ' (booked)' : ''),
          f.truck === t.id,
        ),
      )
      .join('') +
    (ctx.hire
      ? ctx.opt('HIRE:BIG', 'Hire in a big truck', f.truck === 'HIRE:BIG') +
        ctx.opt('HIRE:SMALL', 'Hire in a small truck', f.truck === 'HIRE:SMALL')
      : '') +
    ctx.opt('', 'No truck yet', !f.truck);
  const booked = f.truck && !String(f.truck).startsWith('HIRE') ? ctx.bookedDriver(f.truck) : null;
  const dOpts = booked
    ? ctx.opt(booked, ctx.drivers.find((d) => d.id === booked)?.name ?? 'the booked driver', true)
    : ctx.drivers
        .map((d) =>
          ctx.opt(
            d.id,
            d.name + (ctx.taken.drivers.includes(d.id) ? ' (driving that day)' : ''),
            f.driver === d.id,
            ctx.taken.drivers.includes(d.id),
          ),
        )
        .join('') + ctx.opt('', 'No driver named', !f.driver);
  const rostered = ctx.rostered ?? new Map(),
    notRostered = (f.workers ?? []).filter((x) => !rostered.get(x.person) || rostered.get(x.person) === 'REMOVED'),
    denied = (f.workers ?? []).filter((x) => rostered.get(x.person) === 'DENIED');
  const workers = (ctx.workers ?? []).length
    ? '<div class="tdh-field tdh-wide gl-workers"><span>Workers on it (optional)</span><div class="gl-chips">' +
      ctx.workers
        .map((w) => {
          const on = (f.workers ?? []).find((x) => x.person === w.id),
            ros = rostered.get(w.id);
          return (
            '<span class="gl-chip' +
            (on ? ' on' : '') +
            '"><button type="button" class="gl-chip-name" data-gl-worker="' +
            esc(w.id) +
            '" aria-pressed="' +
            !!on +
            '">' +
            esc(w.name) +
            (ros === 'DENIED'
              ? '<small class="gl-chip-ros no">can’t work</small>'
              : !ros || ros === 'REMOVED'
                ? '<small class="gl-chip-ros">not rostered</small>'
                : '') +
            '</button>' +
            (on
              ? [1, 2, 3]
                  .map(
                    (p) =>
                      '<button type="button" class="gl-pri' +
                      (on.priority === p ? ' on' : '') +
                      '" data-gl-worker="' +
                      esc(w.id) +
                      '" data-gl-priority="' +
                      p +
                      '" aria-pressed="' +
                      (on.priority === p) +
                      '">P' +
                      p +
                      '</button>',
                  )
                  .join('')
              : '') +
            '</span>'
          );
        })
        .join('') +
      '</div>' +
      // someone on it who is not rostered that day: rostered in the same tap (ticked), unless the owner says not to
      (notRostered.length
        ? '<label class="gl-roster"><input type="checkbox" data-gl-roster' +
          (f.roster === false ? '' : ' checked') +
          '> Roster ' +
          esc(notRostered.map((x) => ctx.workers.find((w) => w.id === x.person)?.name ?? 'them').join(', ')) +
          ' for the day too</label>'
        : '') +
      (denied.length
        ? '<p class="tdh-problem">' +
          esc(denied.map((x) => ctx.workers.find((w) => w.id === x.person)?.name ?? 'Someone').join(', ')) +
          ' said they can’t work that day.</p>'
        : '') +
      '</div>'
    : '';
  const body =
    field(
      'Name',
      '<input name="name" maxlength="60" autocomplete="off" value="' +
        esc(name) +
        '" placeholder="' +
        esc(nameHint || 'Bondi gear') +
        '">',
      ' tdh-wide',
    ) +
    placeHTML('from', f, ctx.sites) +
    placeHTML('to', f, ctx.sites) +
    '<div class="tdh-field tdh-field-parts"><span>The gear</span>' +
    ctx.pickHTML +
    '</div>' +
    field(
      'Date',
      '<input type="date" name="day" value="' +
        esc(f.day ?? '') +
        '"' +
        (ctx.today ? ' min="' + esc(ctx.today) + '"' : '') +
        '>',
    ) +
    field('Time', '<select name="time">' + ctx.timesHTML + '</select>') +
    field('Truck', '<select name="truck">' + tOpts + '</select>') +
    field('Driver', '<select name="driver"' + (booked ? ' disabled' : '') + '>' + dOpts + '</select>') +
    workers +
    field(
      'Note (optional)',
      '<input name="note" maxlength="200" value="' + esc(f.note ?? '') + '" placeholder="Back gate, ask for Jim">',
      ' tdh-wide',
    );
  const dir = glDirection(f),
    toName =
      places.to.kind === 'yard' ? 'the yard' : (ctx.sites.find((s) => s.id === places.to.id)?.name ?? 'the site'),
    fromName =
      places.from.kind === 'yard' ? 'the yard' : (ctx.sites.find((s) => s.id === places.from.id)?.name ?? 'the site');
  const truckName = f.truck
    ? String(f.truck).startsWith('HIRE')
      ? 'a hire truck'
      : (ctx.trucks.find((t) => t.id === f.truck)?.name ?? 'the truck')
    : null;
  const note =
    (places.from.kind === 'yard' && places.to.kind === 'yard'
      ? 'Choose a site for one side.'
      : dir === 'OUT'
        ? 'The yard packs it; ' + (truckName ?? 'the truck') + ' takes it to ' + esc(toName) + '.'
        : dir === 'BACK'
          ? (truckName ?? 'The truck') + ' goes to ' + esc(fromName) + ' and brings it back to the yard.'
          : (truckName ?? 'The truck') + ' goes to ' + esc(fromName) + ', then on to ' + esc(toName) + '.') +
    (truckName
      ? ' The driver is asked the day before at 3 pm to be ready' +
        (ctx.live ? ' and taps each step on their phone.' : '.')
      : ' No truck yet: it shows in red until you book one.');
  return {
    body,
    note,
    ok: glFormOk(f),
    go: 'Confirm ' + (name.trim() || nameHint || 'the gear list') + ' for ' + esc(ctx.dayLabel),
    head: 'Send a gear list',
    icon: 'spr-stillage',
  };
}
/**
 * The week's lists on the Gear list page: name, From → To, day and time, truck, dots; tap opens Daily activities on that day.
 * @param {any[]} lists the item views @param {{today?:string|null,dayShort:(d:string)=>string}} ctx
 */
export function glWeekHTML(lists, { today = null, dayShort }) {
  if (!lists.length) return '<p class="tdh-quiet">No gear lists in the next 7 days. Add one on Daily activities.</p>';
  return (
    '<ul class="gl-week">' +
    lists
      .map(
        (v) =>
          '<li class="gl-week-row' +
          (v.status === 'DONE' ? ' done' : v.flags?.red ? ' red' : '') +
          '"><button type="button" class="gl-week-open" data-gl-open="' +
          esc(v.id) +
          '" data-day="' +
          esc(v.day) +
          '"><span class="gl-week-when"><b>' +
          esc(v.day === today ? 'Today' : dayShort(v.day)) +
          '</b><small>' +
          esc(v.timeWords ?? v.time ?? '') +
          '</small></span><span class="gl-week-t"><b>' +
          esc(v.name ?? 'Gear') +
          '</b><small>' +
          esc(
            glArrow(v) +
              (v.truckItem
                ? ' · ' + v.truckItem.truckName + (v.truckItem.driverName ? ' · ' + v.truckItem.driverName : '')
                : ' · no truck yet'),
          ) +
          '</small></span>' +
          glChainHTML(v.chain, { small: true }) +
          '</button></li>',
      )
      .join('') +
    '</ul>'
  );
}
/** The pieces of a list in one line: "22 × Standard 3.0 m, 10 × Ledger". @param {any[]} lines */
export const glLinesWords = (lines) =>
  (lines ?? []).map((l) => l.quantity + ' × ' + (l.name ?? 'part')).join(', ') || plural(0, 'part');
