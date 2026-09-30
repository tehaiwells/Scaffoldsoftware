// The game board's one-tap commands and its autopilot (public/game.js is the board). Everything here is built from the existing commands:
//   gameStart     a yard of a chosen size with a starter kit (crew, forklifts, two 12.5 t trucks)            -> yard, resources, quickAdjust
//   gameSite      a client site by name, with a site crane and crew so trucks can be unloaded                -> site
//   gameCatalogue the reviewed supplier lists in catalogues/verified for the company's systems (no invented figures) -> importCatalogue
//   gameAddStock  stock arriving at the yard, in stillages a forklift can lift                                -> stockIntake / purchase
//   gameSend      materials to a site: whole stillages onto the next free truck(s)                            -> loadTruck
//   gameCollect   stuff back from a site: a collection for today on the next free truck, sent there empty    -> requestCollection, dispatch
//   gameCancel    a Send or Bring back still waiting for a truck (gameOrder), taken off the waiting list
//   gameRemoveSite, gameKeepOpen, gameReopen: remove a site (bringing everything home first), change your mind (src/domain/sitefinish.js)
// When every truck is out, Send and Bring back wait as a gameOrder (oldest first) and go on the next truck that is back at the yard (gameTick).
// A truck given a trip by gameSend / gameCollect carries truck.game = {kind, site, stage, ...}; after every engine tick the autopilot (gameTick)
// takes the next step when the last one is finished: dispatch when loaded, unload at the site with its crane, drive home, load a collection,
// bring it back and unload it at the yard. The people only watch. A step that fails leaves the truck where it is with game.problem set, and
// is tried again a few seconds later; nothing is ever forced.
import { readFileSync, readdirSync } from 'node:fs';
import { requireRule, integer } from './geometry.js';
import { AppError } from '../service.js';
import { active } from './inventory.js';
import { cached, savepoint } from '../database.js';
import { RT_EDITABLE } from './collections.js';
import { gpChoose, gpPerStillage } from '../../public/game-pick.js';
import { siteFinishMethods, SF_OPS, SF_FINISH_PROBE, sfGuard } from './sitefinish.js';
export const GAME_OPS = [
  'gameStart',
  'gameSite',
  'gameCatalogue',
  'gameAddStock',
  'gameSend',
  'gameCollect',
  'gameStop',
  'gameCancel',
  ...SF_OPS,
];
export const GAME_SIZES = {
  S: { w: 20000, d: 16000, name: 'Small yard' },
  M: { w: 30000, d: 20000, name: 'Medium yard' },
  L: { w: 40000, d: 25000, name: 'Large yard' },
};
const TRUCK_PROBE =
    "SELECT 1 FROM objects WHERE company_id=? AND kind='truck' AND json_type(data,'$.game')='object' LIMIT 1",
  ORDER_PROBE = "SELECT 1 FROM objects WHERE company_id=? AND kind='gameOrder' LIMIT 1";
const HEAVY = 10000000,
  RETRY_MS = 4000,
  STILLAGE = {
    type: 'STILLAGE',
    length: 2000,
    width: 1000,
    height: 1000,
    envelopeLength: 2000,
    envelopeWidth: 1000,
    tare: 50000,
  };
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
// While the yard is paused nothing moves, so a Send or Bring back from the board is refused at once with these words (the board offers Resume)
// instead of loading a truck that then sits still with no sign. Add stock is not refused: it lands in the yard straight away.
export const GAME_PAUSED = "The yard is paused, so the trucks can't go.";
const OPEN_RT = ['REQUESTED', 'BOOKED', 'LOADING'];
// Not free right now (being moved, loaded, or on its way back): a waiting order keeps waiting for it instead of being dropped.
const notYet = (ok, message) => {
  if (!ok) throw Object.assign(new AppError(409, message), { wait: true });
};
export const lineList = (lines) => {
  requireRule(Array.isArray(lines) && lines.length > 0 && lines.length <= 60, 'Pick at least one material.');
  const seen = new Map();
  for (const l of lines) {
    requireRule(l && typeof l.product === 'string' && l.product.length > 0, 'Pick a material.');
    seen.set(l.product, (seen.get(l.product) ?? 0) + integer(l.quantity, 'Amount', 1, 1000000));
  }
  return [...seen].map(([product, quantity]) => ({ product, quantity }));
};
const logError = (event, fields) => {
  try {
    console.error(JSON.stringify({ event, ...fields }));
  } catch {}
};
export const gameMethods = {
  gameYard() {
    const yard = this.repo.all('yard')[0];
    requireRule(yard, 'Choose your yard size first.');
    return yard;
  },
  // The stillages and cages at one place, as game-pick.js wants them: busy = cannot be lifted now (moving, reserved, damaged, on a manual forklift,
  // something being set down on it, or under a stocktake).
  gameItems(locIds) {
    const want = new Set(locIds),
      all = this.containers().filter((c) => want.has(c.location) && !c.retired),
      busy = new Set(),
      allAt = new Set();
    for (const t of this.tasks())
      if (active(t)) {
        if (t.container) busy.add(t.container);
        if (t.sourceContainer) busy.add(t.sourceContainer);
        if (t.position?.support) busy.add(t.position.support);
      }
    for (const m of this.repo.all('resource'))
      if (m.enabled !== false) {
        if (m.cargo) busy.add(m.cargo);
        if (m.drive?.container) busy.add(m.drive.container);
      }
    for (const r of this.repo.all('reservation')) if (r.active) busy.add(r.container);
    // already on a Bring back (booked or loading): not offered twice; a Bring everything back takes the whole site
    for (const o of this.repo.all('collection'))
      if (OPEN_RT.includes(o.status)) {
        if (o.scope === 'ALL') allAt.add(o.site);
        else for (const id of o.containers ?? []) busy.add(id);
      }
    // too heavy for the yard forklift or the site crane, or a part with no weight: the crew could never lift it, so it is never offered
    const yard = this.repo.all('yard')[0],
      lift = yard ? this.gameLift(yard) : 1500000,
      heavy = (c) => {
        try {
          return this.weight(c) > lift;
        } catch {
          return true;
        }
      };
    const counts = this.repo
      .all('count')
      .filter((n) => n.state === 'OPEN')
      .map((n) => n.scope);
    const out = new Map([...want].map((id) => [id, []]));
    for (const c of all)
      out.get(c.location).push({
        id: c.id,
        name: c.name,
        support: c.support ?? null,
        lines: this.repo.lines(c.id).map((l) => [l.product_id, l.quantity]),
        busy:
          busy.has(c.id) ||
          allAt.has(c.location) ||
          c.condition !== 'SERVICEABLE' ||
          counts.includes(c.id) ||
          counts.includes(c.location) ||
          heavy(c),
      });
    return out;
  },
  // Trucks at the yard with nothing on board, nothing loading and no trip or booking: the heavy ones first, then by name.
  gameFreeTrucks(yard) {
    return this.repo
      .all('truck')
      .filter((t) => !t.retired && !t.game && t.status === 'AT_YARD' && t.at === yard.id && this.idleTruck(t))
      .sort(
        (a, b) =>
          Number(b.payload >= HEAVY) - Number(a.payload >= HEAVY) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
  },
  // What one stillage may weigh: the lightest yard forklift, and never more than the 1.5 t site crane the board gives a site.
  gameLift(yard) {
    return Math.min(
      1500000,
      ...this.repo
        .all('resource')
        .filter((r) => r.location === yard.id && r.enabled && r.type === 'FORKLIFT')
        .map((r) => r.capacity ?? 1500000),
    );
  },
  // A site crane and two workers, so a truck can be unloaded or loaded there. Only when the site has no crane at all yet (one the Office switched
  // off counts: the board never adds a second).
  gameCrew(site) {
    if (this.live()) return false; // a real yard's cranes and crew are records people add, never invented (ADR 0001)
    const all = this.repo.all('resource').filter((r) => r.location === site.id),
      here = all.filter((r) => r.enabled);
    if (all.some((r) => r.type === 'CRANE')) return false;
    this.ensureConfig();
    this.repo.add('resource', {
      name: 'Crane 1',
      type: 'CRANE',
      location: site.id,
      enabled: true,
      task: null,
      capacity: 1500000,
      reach: 10000,
    });
    for (let i = here.filter((r) => r.type === 'WORKER').length; i < 2; i++)
      this.repo.add('resource', {
        name: 'Worker ' + (i + 1),
        type: 'WORKER',
        location: site.id,
        enabled: true,
        task: null,
      });
    return true;
  },
  gameStart(input) {
    requireRule(!this.repo.all('yard').length, 'Your yard is already set up.');
    const size = GAME_SIZES[input?.size];
    requireRule(size, 'Choose a small, medium or large yard.');
    const { w, d } = size;
    const yard = this.yard({
      name: label(input.name) ?? 'Main yard',
      points: [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: d },
        { x: 0, y: d },
      ],
      height: 10000,
      loading: { x: w - 5500, y: d - 5500 },
      gate: { x: w - 5500, y: d - 3000 },
      fixtures: [{ kind: 'OFFICE', name: 'Yard office', x: w - 6500, y: 500, w: 6000, h: 3000 }],
    });
    // A real yard starts with its yard only: its trucks, forklifts and people are added by the owner (Office), never invented.
    if (this.live()) {
      this.ensureConfig();
      return { yard, message: 'Your yard is ready. Add your trucks and your team in the Office.' };
    }
    this.resources({ location: yard.id, workers: 4, machines: 2 });
    for (let i = 0; i < 2; i++) this.quickAdjust({ kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
    return { yard, message: 'Your yard is ready. The crew is waiting for work.' };
  },
  gameSite(input) {
    const site = this.site({
      name: input?.name,
      address: typeof input?.address === 'string' && input.address.trim() ? input.address : undefined,
      // a real yard: the customer it bills to and its PO (ADR 0011)
      ...(input?.customer !== undefined ? { customer: input.customer } : {}),
      ...(input?.po !== undefined ? { po: input.po } : {}),
    });
    // tapped on an empty block of the map: the site goes there (the map's own rule for moving a site; a refused block keeps the automatic one)
    if (Number.isInteger(input?.col) && Number.isInteger(input?.row) && typeof this.worldPlace === 'function') {
      try {
        savepoint(this.db, 'game_place', () => this.worldPlace({ id: site.id, col: input.col, row: input.row }));
      } catch (e) {
        if (!e.status) throw e;
      }
    }
    if (this.live()) return { site, message: site.name + ' is on the map.' };
    this.gameCrew(site);
    return { site, message: site.name + ' is on the map. Its crane and crew are ready.' };
  },
  // The reviewed supplier lists (catalogues/verified, owner supplied, every figure cited) for the scaffold systems the company uses. Rows already
  // in the catalogue are left alone, so a second tap only adds what is missing.
  gameCatalogue(input) {
    // the scaffold systems the owner ticked on the board ("Which scaffold do you use?"): saved as the company's systems first
    if (Array.isArray(input?.systems) && input.systems.length) {
      this.auth.require(this.user, 'company.manage');
      const all = new Set(
          cached(this.db, 'SELECT id FROM scaffold_systems')
            .all()
            .map((r) => r.id),
        ),
        want = [...new Set(input.systems)];
      requireRule(
        want.every((id) => typeof id === 'string' && all.has(id)),
        'Choose a valid scaffold system.',
      );
      this.auth.saveSystems(this.user, want);
      this.auth.audit(this.user, 'company.updated', { systems: want });
    }
    const on = new Set(
      cached(this.db, 'SELECT system_id FROM company_systems WHERE company_id=? AND enabled=1')
        .all(this.user.company_id)
        .map((r) => r.system_id),
    );
    requireRule(on.size, 'Switch on a scaffold system on the Account page first.');
    const dir = new URL('../../catalogues/verified/', import.meta.url);
    let files = [];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {}
    requireRule(files.length, 'No supplier lists are installed on this computer.');
    const have = new Set(this.repo.all('product').map((p) => p.manufacturer + '|' + p.region + '|' + p.reference));
    let added = 0;
    for (const f of files) {
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8')),
        rows = (j.products ?? []).filter(
          (p) => on.has(p.system) && !have.has(p.manufacturer + '|' + p.region + '|' + p.reference),
        );
      for (let i = 0; i < rows.length; i += 100) {
        this.importCatalogue({
          name: (j.name ?? f) + (i ? ' part ' + (i / 100 + 1) : ''),
          products: rows.slice(i, i + 100),
        });
        for (const p of rows.slice(i, i + 100)) have.add(p.manufacturer + '|' + p.region + '|' + p.reference);
        added += Math.min(100, rows.length - i);
      }
    }
    requireRule(added, 'Your parts list is already loaded.');
    return { added, message: 'The starter parts list is loaded. Check the weights against your own supplier.' };
  },
  // Stock arriving at the yard, one product at a time: its own stillages are topped up first, then new ones are set down (gamePlace). A stillage
  // holds one pack, or as much as the yard forklift and the site crane can lift when a pack is heavier than that (the pack is split), so every
  // stillage can be moved and sent (game-pick.js gpPerStillage). A part with no weight in the parts list is refused: nobody could lift it.
  gameAddStock(input) {
    this.auth.require(this.user, 'stock.adjust');
    const yard = this.gameYard(),
      lines = lineList(input?.lines),
      done = [];
    const lift = this.gameLift(yard);
    // a real yard may give a cost per line (a mixed delivery); lineList merges lines by product, so the costs are read off the input first
    const costs = new Map(
      (Array.isArray(input?.lines) ? input.lines : [])
        .filter(
          (l) =>
            l && typeof l.product === 'string' && l.unitCost !== undefined && l.unitCost !== null && l.unitCost !== '',
        )
        .map((l) => [l.product, l.unitCost]),
    );
    for (const line of lines) {
      const p = this.effective(line.product);
      if (costs.has(p.id)) line.unitCost = costs.get(p.id);
      requireRule(!p.retired, p.name + ' has been removed from the catalogue.');
      // a real yard: any system name, and a part without a weight goes in as it is (the weight is needed only for the truck-mass check,
      // ADR 0011); the Practice yard keeps its ticked systems and its lifting rule
      if (!this.live()) {
        requireRule(
          cached(this.db, 'SELECT enabled FROM company_systems WHERE company_id=? AND system_id=?').get(
            this.user.company_id,
            p.system,
          )?.enabled,
          'Switch on this scaffold system on the Account page first.',
        );
        requireRule(
          p.unitWeight > 0,
          p.name +
            ' has no weight in your parts list, so the crew cannot lift it. Add its weight in the Office, Materials catalogue.',
        );
      }
      const per = p.unitWeight > 0 ? gpPerStillage(p, lift) : p.packQuantity > 0 ? p.packQuantity : line.quantity;
      requireRule(per > 0, p.name + ' is too heavy for the forklift, even one at a time.');
      let left = line.quantity,
        used = 0;
      const intake = this.live() ? this.intakeWords(line, input) : '';
      const put = (c, q) => {
        this.purchase({ container: c.id, product: p.id, quantity: q, reason: 'Stock added to the yard' + intake });
        left -= q;
        used++;
      };
      for (const c of this.containers()
        .filter((c) => c.location === yard.id && c.type === 'STILLAGE' && c.condition === 'SERVICEABLE')
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        if (!left) break;
        const l = this.repo.lines(c.id);
        if (l.length !== 1 || l[0].product_id !== p.id) continue;
        const room = per - l[0].quantity;
        if (room <= 0) continue;
        try {
          savepoint(this.db, 'game_topup', () => put(c, Math.min(left, room)));
        } catch (e) {
          if (!e.status) throw e;
        }
      }
      for (let n = 0; left > 0; n++) {
        requireRule(n < 60, 'That is a lot for one go. Add it in smaller batches.');
        put(this.gamePlace(yard, p.id), Math.min(left, per));
      }
      done.push({ product: p.id, name: p.name, quantity: line.quantity, stillages: used });
      // a real yard keeps what it paid and where it came from (ADR 0010, audit H3): unit cost (cents), supplier, reference, received on
      if (this.live())
        this.intakeRecord(p.id, line.quantity, {
          ...input,
          ...(line.unitCost !== undefined ? { unitCost: line.unitCost } : {}),
        });
    }
    return { added: done, message: done.map((x) => x.quantity + ' × ' + x.name).join(', ') + ' added to the yard.' };
  },
  // What the Stock ledger's Added stock row says beside the add: the supplier, the invoice and the cost each (a cost per line wins over the
  // add's one cost, so a mixed delivery can be recorded right).
  intakeWords(line, input) {
    const has = (v) => v !== undefined && v !== null && v !== '';
    const cost = has(line?.unitCost) ? line.unitCost : input?.unitCost;
    const parts = [];
    if (has(input?.supplier) && typeof input.supplier === 'string') parts.push(input.supplier.trim());
    if (has(input?.reference) && typeof input.reference === 'string') parts.push(input.reference.trim());
    if (has(cost) && Number.isFinite(Number(cost))) parts.push('$' + (Number(cost) / 100).toFixed(2) + ' each');
    return parts.length ? ' · ' + parts.join(' · ') : '';
  },
  // One intake record per product added in a real yard (kind 'intake'): the cost side of stock, read by nothing yet but kept from day one.
  intakeRecord(product, quantity, input) {
    const has = (v) => v !== undefined && v !== null && v !== '';
    if (!has(input?.unitCost) && !has(input?.supplier) && !has(input?.reference) && !has(input?.receivedOn))
      return null;
    const text = (v, name) => {
      if (!has(v)) return null;
      requireRule(typeof v === 'string' && v.trim().length <= 120, name + ' can be at most 120 characters.');
      return v.trim();
    };
    const receivedOn = text(input.receivedOn, 'Received on');
    if (receivedOn) requireRule(/^\d{4}-\d{2}-\d{2}$/.test(receivedOn), 'Received on must be a day (YYYY-MM-DD).');
    return this.repo.add('intake', {
      product,
      quantity,
      unitCost: has(input.unitCost) ? integer(input.unitCost, 'Unit cost (cents)', 0, 100000000) : null,
      supplier: text(input.supplier, 'Supplier'),
      reference: text(input.reference, 'Reference'),
      receivedOn: receivedOn ?? this.planToday(),
      by: this.user.id,
      at: new Date(this.planNow()).toISOString(),
      key: this.key ?? null,
    });
  },
  // Where a new stillage goes: on a pile of the same product while it is under three high, else on the ground with a forklift aisle (1.2 m) all
  // round it so every stillage can still be driven out, else higher on its own piles, else wherever the yard's stockpile rule stacks it.
  gamePlace(yard, product) {
    const stored = this.containers().filter((c) => c.location === yard.id && !c.retired),
      byId = new Map(stored.map((c) => [c.id, c])),
      onTop = new Set(stored.map((c) => c.support).filter(Boolean));
    const names = new Set(this.repo.all('container').map((c) => c.name));
    let k = 1;
    while (names.has('S-' + String(k).padStart(3, '0'))) k++;
    const name = 'S-' + String(k).padStart(3, '0');
    const level = (c) => {
        let n = 1;
        for (let cur = c; cur.support && byId.has(cur.support) && n < 20; cur = byId.get(cur.support)) n++;
        return n;
      },
      mine = (c) => {
        const l = this.repo.lines(c.id);
        return l.length === 1 && l[0].product_id === product;
      };
    // never on a stillage set aside for a list on the Today calendar (plan.js): it would ride along to that site
    const held = new Set(
      this.repo
        .all('reservation')
        .filter((r) => r.active && r.plan)
        .map((r) => r.container),
    );
    const piles = stored
      .filter(
        (c) => c.type === 'STILLAGE' && c.condition === 'SERVICEABLE' && !onTop.has(c.id) && !held.has(c.id) && mine(c),
      )
      .map((c) => ({ c, n: level(c) }))
      .sort((a, b) => a.n - b.n || a.c.name.localeCompare(b.c.name, undefined, { numeric: true }));
    const stack = (max) => {
      for (const { c, n } of piles) {
        if (n >= max) continue;
        const position = { x: c.x, y: c.y, rotation: c.rotation ?? 0, support: c.id };
        try {
          return savepoint(this.db, 'game_stack', () => {
            this.validatePlacement({ ...STILLAGE, rotation: position.rotation, support: c.id }, yard.id, position);
            return this.container({ name, location: yard.id, ...STILLAGE, ...position });
          });
        } catch (e) {
          if (!e.status || /payload|unknown|stocktake/.test(e.message)) throw e;
        }
      }
      return null;
    };
    const low = stack(3);
    if (low) return low;
    const A = 1200,
      wide = {
        ...STILLAGE,
        envelopeLength: STILLAGE.envelopeLength + 2 * A,
        envelopeWidth: STILLAGE.envelopeWidth + 2 * A,
        length: STILLAGE.length + 2 * A,
        width: STILLAGE.width + 2 * A,
        rotation: 0,
        support: null,
      };
    try {
      const spot = this.positionFor(wide, yard.id);
      return savepoint(this.db, 'game_ground', () =>
        this.container({
          name,
          location: yard.id,
          ...STILLAGE,
          x: spot.x + A,
          y: spot.y + A,
          rotation: spot.rotation ?? 0,
        }),
      );
    } catch (e) {
      if (!e.status || /payload|unknown|stocktake/.test(e.message)) throw e;
    }
    return stack(7) ?? this.stackStillage(yard);
  },
  // Materials to a site: the stillages holding them (game-pick.js, tops of piles first), loaded onto the next free truck; what does not fit goes
  // on the next one. Each truck then drives, unloads and comes home by itself (gameTick).
  gamePaused(input) {
    requireRule(input?.fromQueue || input?.byRemove || !this.repo.all('config')[0]?.paused, GAME_PAUSED);
  },
  gameSend(input) {
    this.gamePaused(input);
    const yard = this.gameYard(),
      site = this.repo.get(input?.site, 'site');
    requireRule(site.status === 'ACTIVE', 'Choose an active site.');
    requireRule(!site.finishing, site.name + ' is being removed. Tap Keep it first.');
    const lines = lineList(input.lines);
    let trucks = this.gameFreeTrucks(yard);
    if (input.truck) {
      const t = trucks.find((x) => x.id === input.truck);
      requireRule(t, 'That truck is busy. Pick another one.');
      trucks = [t, ...trucks.filter((x) => x !== t)];
    }
    if (!trucks.length) {
      requireRule(!input.fromQueue, 'Every truck is busy.');
      const here = this.containers().filter((c) => c.location === yard.id);
      requireRule(
        lines.some((l) => here.some((c) => this.repo.quantity(c.id, l.product) > 0)),
        'None of that is in the yard.',
      );
      return this.gameWait('SEND', site, { lines });
    }
    const items = this.gameItems([yard.id]).get(yard.id),
      pick = gpChoose(items, lines);
    notYet(pick.ids.length, 'None of that is free in the yard right now.');
    const onto = new Map(),
      left = [];
    let ti = 0;
    for (const id of pick.ids) {
      let placed = false;
      for (let k = ti; k < trucks.length && !placed; k++) {
        try {
          savepoint(this.db, 'game_load', () => this.loadTruck({ truck: trucks[k].id, containers: [id] }));
          placed = true;
          ti = k;
          let l = onto.get(trucks[k].id);
          if (!l) onto.set(trucks[k].id, (l = []));
          l.push(id);
        } catch (e) {
          if (!e.status) throw e;
          if (k === trucks.length - 1) left.push({ id, reason: e.message });
        }
      }
    }
    requireRule(onto.size, left[0]?.reason ?? 'Nothing could be loaded.');
    // what did not fit on the free trucks waits for the next one back (the waiting list), as a Send with no free truck does
    // (the order picks again when it goes: a stillage under one that went on the other truck is on top by then)
    // and so does what is in the yard but not free yet (still being lifted onto the first truck, under a stillage that went on it)
    const later = [];
    for (const s of pick.short) {
      const have =
        this.containers()
          .filter((c) => c.location === yard.id)
          .reduce((n, c) => n + this.repo.quantity(c.id, s.product), 0) - s.got;
      const q = Math.min(s.want - s.got, have);
      if (q > 0) later.push({ product: s.product, quantity: q });
    }
    const rest = left.length || later.length;
    if (rest)
      this.gameQueue(
        'SEND',
        site,
        left.map((x) => x.id),
        later,
      );
    this.gameCrew(site);
    const now = new Date().toISOString(),
      used = [];
    for (const [tid, ids] of onto) {
      const t = this.repo.get(tid, 'truck');
      t.destination = site.id;
      t.game = {
        kind: 'SEND',
        site: site.id,
        stage: 'LOADING',
        since: now,
        stillages: ids.length,
        problem: null,
        retryAt: null,
      };
      this.repo.save(t);
      used.push({ id: t.id, name: t.name, stillages: ids.length });
    }
    const names = used.map((t) => t.name).join(' and ');
    return {
      trucks: used,
      left,
      short: pick.short,
      message:
        names +
        (used.length > 1 ? ' are' : ' is') +
        ' loading for ' +
        site.name +
        '. The crew does the rest.' +
        (rest ? ' The rest goes on the next truck back.' : ''),
    };
  },
  // Stuff back from a site: everything there, or the stillages holding the picked materials. A collection for today on the next free truck (it
  // shows on the Schedule), and the truck drives there empty; the site crane loads it and it comes home by itself (gameTick).
  gameCollect(input) {
    this.gamePaused(input);
    const yard = this.gameYard(),
      site = this.repo.get(input?.site, 'site');
    requireRule(site.status === 'ACTIVE', 'Choose an active site.');
    // a board truck already on its way to bring things back from this site: everything is being fetched already, or the rest waits for it
    const going = this.repo
      .all('truck')
      .filter((t) => t.game?.kind === 'COLLECT' && t.game.site === site.id)
      .map((t) => {
        try {
          return this.repo.get(t.game.collection, 'collection');
        } catch {
          return null;
        }
      })
      .filter((o) => o && OPEN_RT.includes(o.status));
    requireRule(
      !going.some((o) => o.scope === 'ALL'),
      'A truck is already on its way to bring everything back from ' + site.name + '.',
    );
    if (going.length && input.all && !input.fromQueue)
      return this.gameWait(
        'COLLECT',
        site,
        { all: true, ...(input.byRemove ? { byRemove: true } : {}) },
        'A truck is already on its way to ' + site.name + '. Another goes back for the rest once it has loaded.',
      );
    let scope = 'ALL',
      containers;
    if (!input.all) {
      const lines = lineList(input.lines),
        items = this.gameItems([site.id]).get(site.id),
        pick = gpChoose(items, lines);
      notYet(pick.ids.length, 'None of that can be lifted at ' + site.name + ' right now.');
      scope = 'SELECTED';
      containers = pick.ids;
    }
    if (scope === 'ALL')
      requireRule(
        this.containers().some((c) => c.location === site.id),
        'Nothing is on ' + site.name + ' to bring back.',
      );
    const trucks = this.gameFreeTrucks(yard);
    if (!trucks.length) {
      requireRule(!input.fromQueue, 'Every truck is busy.');
      return this.gameWait('COLLECT', site, {
        ...(scope === 'ALL' ? { all: true } : { lines: lineList(input.lines) }),
        ...(input.byRemove ? { byRemove: true } : {}),
      });
    }
    const t = trucks.find((x) => x.id === input.truck) ?? trucks[0];
    let o = this.requestCollection({
      site: site.id,
      scope,
      containers,
      neededOn: this.calendar().today,
      truck: t.id,
      notes: 'Bring back from the yard board',
    });
    // one the Remove site button asked for (sitefinish.js): Keep it calls off only these
    if (input.byRemove) {
      o = this.repo.get(o.id, 'collection');
      o.byRemove = true;
      this.repo.save(o);
    }
    this.gameCrew(site);
    this.dispatch({ id: t.id, destination: site.id });
    const f = this.repo.get(t.id, 'truck');
    f.game = {
      kind: 'COLLECT',
      site: site.id,
      collection: o.id,
      stage: 'OUTBOUND',
      since: new Date().toISOString(),
      problem: null,
      retryAt: null,
    };
    this.repo.save(f);
    return {
      truck: { id: t.id, name: t.name },
      collection: o.id,
      message:
        t.name + ' is on its way to ' + site.name + ' to bring ' + (scope === 'ALL' ? 'everything' : 'it') + ' back.',
    };
  },
  // Every truck is out: the order waits (oldest first) and goes on the next truck back at the yard (gameTick). The picked amounts are chosen again
  // then, from what is there at that moment.
  // The stillages that did not fit (a full truck), and any other amounts: what is in them waits as an order for the next truck back.
  gameQueue(type, site, ids, more = []) {
    const m = new Map();
    for (const id of ids)
      for (const l of this.repo.lines(id)) m.set(l.product_id, (m.get(l.product_id) ?? 0) + l.quantity);
    for (const l of more) m.set(l.product, (m.get(l.product) ?? 0) + l.quantity);
    if (m.size)
      this.repo.add('gameOrder', {
        type,
        site: site.id,
        lines: [...m].map(([product, quantity]) => ({ product, quantity })),
        createdAt: new Date().toISOString(),
        by: this.user.id,
      });
  },
  gameWait(type, site, what, message) {
    const o = this.repo.add('gameOrder', {
      type,
      site: site.id,
      ...what,
      createdAt: new Date().toISOString(),
      by: this.user.id,
    });
    return {
      queued: o.id,
      trucks: [],
      left: [],
      message:
        message ??
        'Every truck is out. ' +
          (type === 'SEND'
            ? 'This goes to ' + site.name + ' on the next truck back at the yard.'
            : 'The next truck back goes to ' + site.name + ' to bring it back.'),
    };
  },
  gameCancel(input) {
    const o = this.repo.get(input?.id, 'gameOrder');
    this.repo.remove(o.id, 'gameOrder');
    return { ok: true, message: 'Taken off the waiting list.' };
  },
  // A waiting order onto a truck that is free again; one that can no longer go (the site closed, the stock gone) is dropped with a note.
  gameOrders() {
    const yard = this.repo.all('yard')[0];
    if (!yard) return;
    // a Bring back waits while a board truck is still on its way to that site or loading there (the site crane is busy with it)
    const atSite = new Set(
      this.repo
        .all('truck')
        .filter((t) => t.game?.kind === 'COLLECT' && ['OUTBOUND', 'LOADING'].includes(t.game.stage))
        .map((t) => t.game.site),
    );
    for (const o of this.repo.all('gameOrder').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      if (!this.gameFreeTrucks(yard).length) return;
      if (o.type === 'COLLECT' && atSite.has(o.site)) continue;
      if (o.byRemove && this.sfHeld(o.site)) continue;
      try {
        savepoint(this.db, 'game_order', () => {
          if (o.type === 'SEND') this.gameSend({ site: o.site, lines: o.lines, fromQueue: true });
          else this.gameCollect({ site: o.site, all: o.all, lines: o.lines, fromQueue: true, byRemove: !!o.byRemove });
          this.repo.remove(o.id, 'gameOrder');
          this.rtSync();
        });
      } catch (error) {
        if (!error.status) {
          logError('game_order_error', { order: o.id, message: error.message });
          return;
        }
        if (error.wait) continue;
        this.repo.remove(o.id, 'gameOrder');
        let name = 'the site';
        try {
          name = this.repo.get(o.site, 'site').name;
        } catch {}
        this.notify(
          'Not sent',
          (o.type === 'SEND'
            ? 'Sending to ' + name + ' was dropped: '
            : 'Bringing back from ' + name + ' was dropped: ') + error.message,
          o.site,
        );
      }
    }
  },
  // Stop the autopilot for one truck (the Office pages then run it by hand, as before).
  gameStop(input) {
    const t = this.repo.get(input?.id, 'truck');
    requireRule(t.game, t.name + ' is not on an automatic trip.');
    t.game = null;
    this.repo.save(t);
    return { ok: true, message: t.name + ' is now run by hand from its truck page.' };
  },
  // ---------- the autopilot, after every engine tick ----------
  gameTick() {
    const trips = !!cached(this.db, TRUCK_PROBE).get(this.repo.company),
      orders = !!cached(this.db, ORDER_PROBE).get(this.repo.company),
      finishing = !!cached(this.db, SF_FINISH_PROBE).get(this.repo.company);
    if (!trips && !orders && !finishing) return;
    const now = Date.now();
    if (trips)
      for (const t of this.repo.all('truck')) {
        if (!t.game || t.retired || t.status === 'IN_TRANSIT') continue;
        if (t.game.retryAt && now < t.game.retryAt) continue;
        // rtSync as after every command (execute): a collection follows the trip the autopilot just started
        try {
          savepoint(this.db, 'game_auto', () => {
            this.gameStep(t);
            this.rtSync();
          });
        } catch (error) {
          if (!error.status) logError('game_autopilot_error', { truck: t.id, message: error.message });
          const f = this.repo.get(t.id, 'truck');
          if (f.game) {
            f.game = {
              ...f.game,
              problem: error.status ? error.message : 'Something went wrong. The truck waits here; see its truck page.',
              retryAt: now + RETRY_MS,
            };
            this.repo.save(f);
          }
        }
      }
    if (orders) this.gameOrders();
    if (finishing) this.sfTick();
  },
  gameStep(t) {
    const g = t.game,
      tasks = this.tasks().filter(active),
      loading = tasks.some((x) => x.to === t.id),
      unloading = tasks.some((x) => x.from === t.id),
      cargo = this.containers().some((c) => c.location === t.id);
    const set = (patch) => {
      const f = this.repo.get(t.id, 'truck');
      f.game = patch === null ? null : { ...f.game, ...patch, problem: null, retryAt: null };
      this.repo.save(f);
    };
    const siteName = () => {
      try {
        return this.repo.get(g.site, 'site').name;
      } catch {
        return 'the site';
      }
    };
    const home = () => this.dispatch({ id: t.id, destination: t.yard });
    // a Send turned back for a removal that was then called off (Keep it): the owner is told it was not made
    const end = () => {
      if (g.diverted) {
        let s = null;
        try {
          s = this.repo.get(g.site, 'site');
        } catch {}
        if (s?.status === 'ACTIVE' && !s.finishing)
          this.notify(
            'Not sent',
            'The load for ' + s.name + ' came back to the yard. Send it again if it is still needed.',
            s.id,
          );
      }
      return set(null);
    };
    if (loading || unloading) {
      if (g.problem) set({});
      return;
    } // the crew is on it
    if (g.kind === 'SEND') {
      if (g.stage === 'LOADING') {
        if (t.status !== 'AT_YARD') return set(null);
        if (!cargo) {
          this.notify('Nothing to send', t.name + ' had nothing loaded for ' + siteName() + '.', g.site);
          return set(null);
        }
        // the site is being removed: the load never leaves; it is unloaded back into the yard (below)
        if (this.sfFinishing(g.site)) {
          const f = this.repo.get(t.id, 'truck');
          f.destination = null;
          this.repo.save(f);
          return set({ stage: 'RETURNING', diverted: true });
        }
        this.dispatch({ id: t.id, destination: g.site });
        // the run is the day's record of a board Send (it has no yard list): marked, with its pieces, for Today and the Schedule
        const d = this.repo.get(this.repo.get(t.id, 'truck').delivery, 'delivery');
        d.game = 'SEND';
        d.pieces = d.containers.reduce((n, id) => n + this.repo.lines(id).reduce((k, l) => k + l.quantity, 0), 0);
        this.repo.save(d);
        return set({ stage: 'DRIVING' });
      }
      if (g.stage === 'DRIVING' || g.stage === 'UNLOADING') {
        if (t.status !== 'AT_SITE' || t.at !== g.site) {
          if (t.status === 'AT_YARD' && !cargo) end();
          return;
        }
        // arriving at a site that is being removed: the load comes straight home again
        if (cargo && g.stage === 'DRIVING' && this.sfFinishing(g.site)) {
          home();
          return set({ stage: 'RETURNING', diverted: true });
        }
        if (cargo) {
          this.gameCrew(this.repo.get(g.site, 'site'));
          this.unload({ id: t.id });
          return set({ stage: 'UNLOADING' });
        }
        this.notify(
          'Delivered',
          'Delivered to ' + siteName() + '! ' + t.name + ' is heading back to the yard.',
          g.site,
        );
        home();
        return set({ stage: 'RETURNING' });
      }
    } else if (g.kind === 'COLLECT') {
      if (g.stage === 'OUTBOUND') {
        if (t.status !== 'AT_SITE' || t.at !== g.site) {
          if (t.status === 'AT_YARD' && !cargo) set(null);
          return;
        }
        let o = null;
        try {
          o = this.repo.get(g.collection, 'collection');
        } catch {}
        if (o && RT_EDITABLE.includes(o.status)) {
          const site = this.repo.get(g.site, 'site');
          this.gameCrew(site);
          let r;
          // a site being removed where nothing can be loaded: the truck comes home empty and removing waits for Try again (sitefinish.js)
          try {
            r = savepoint(this.db, 'game_collect_load', () => this.loadCollection({ id: o.id, truck: t.id }));
          } catch (e) {
            if (!e.status || !site.finishing) throw e;
            this.cancelCollection({ id: o.id, reason: 'Nothing could be loaded' });
            this.sfStuck(site.id, e.message);
            home();
            return set({ stage: 'RETURNING' });
          }
          // the truck is full: the rest waits for the next truck (it goes as soon as this one has left the site), and the owner is told
          // (each trip takes at least one stillage, so this always ends)
          const left = r.left ?? [];
          let more = false;
          if (left.length) {
            if (o.scope === 'ALL')
              this.repo.add('gameOrder', {
                type: 'COLLECT',
                site: site.id,
                all: true,
                ...(o.byRemove ? { byRemove: true } : {}),
                createdAt: new Date().toISOString(),
                by: this.user.id,
              });
            else
              this.gameQueue(
                'COLLECT',
                site,
                left.map((x) => x.id),
              );
            more = true;
            this.notify(
              'More to bring back',
              'One truck is not enough for ' + site.name + '. Another truck goes back for the rest.',
              site.id,
            );
          }
          return set({ stage: 'LOADING', more });
        }
        home();
        return set({ stage: 'RETURNING' });
      }
      if (g.stage === 'LOADING') {
        if (t.status !== 'AT_SITE') return;
        home();
        return set({ stage: 'RETURNING', brought: cargo });
      }
    }
    // RETURNING / UNLOADING at the yard (both kinds): unload what came back, then the trip is over.
    if (t.status !== 'AT_YARD' || t.at !== t.yard) return;
    if (cargo) {
      this.unload({ id: t.id });
      return set({ stage: 'UNLOADING' });
    }
    if (g.kind === 'COLLECT' && (g.brought || g.stage === 'UNLOADING'))
      this.notify(
        'Back at the yard',
        t.name +
          ' is back from ' +
          siteName() +
          (g.more ? ' with a full load. Another truck brings the rest.' : ' and everything is unloaded.'),
        g.site,
      );
    end();
  },
  // result.gameOrders: Sends and Bring backs waiting for a truck (a few bytes; the poll carries nothing else for the board).
  gameSnapshot(result) {
    result.gameOrders = this.repo
      .all('gameOrder')
      .map((o) => ({
        id: o.id,
        type: o.type,
        site: o.site,
        all: !!o.all,
        lines: o.lines ?? null,
        createdAt: o.createdAt,
      }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },
  // GET /api/game-items?loc=: the stillages at the yard or one active site, with their contents and whether each can be lifted now (the amount
  // slider's stops, game-pick.js). Asked for only while Send or Bring back is open, so the 1 s poll never carries them.
  gameItemsFor(loc) {
    this.auth.require(this.user, 'operations.manage');
    const yard = this.gameYard();
    let id = yard.id;
    if (loc && loc !== yard.id) {
      const site = this.repo.get(loc, 'site');
      requireRule(site.status === 'ACTIVE', 'Choose an active site.');
      id = site.id;
    }
    return { loc: id, items: this.gameItems([id]).get(id) };
  },
};
function label(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null;
}
export function installGame(proto) {
  // tick() (movement.js) ends with tickJobs(), and a quiet tick runs tickJobs() alone (simulation.js tickCompany): wrapping tickJobs runs the
  // autopilot once after every engine tick either way.
  const tickJobs = proto.tickJobs,
    build = proto.buildSnapshot;
  if (typeof tickJobs !== 'function' || typeof build !== 'function')
    throw new AppError(500, 'The game board needs tickJobs and buildSnapshot.');
  Object.assign(proto, gameMethods, siteFinishMethods);
  sfGuard(proto);
  // then the Today planner (src/domain/plan.js planTick: at most one pass a second, never throws into the tick)
  proto.tickJobs = function (elapsed) {
    const r = tickJobs.call(this, elapsed);
    this.gameTick();
    if (typeof this.planTick === 'function') this.planTick(elapsed);
    return r;
  };
  proto.buildSnapshot = function (page, opts) {
    const result = build.call(this, page, opts);
    if (this.auth.permissions(this.user).includes('operations.manage')) this.gameSnapshot(result);
    return result;
  };
}
