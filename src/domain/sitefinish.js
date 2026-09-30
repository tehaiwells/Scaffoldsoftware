// Remove a site, and change your mind: the server side of the board's one "Remove site" button (public/game-finish.js). Installed with the game
// board (game.js installGame); every command needs operations.manage (GAME_OPS), so a supervisor can never remove, keep or re-open a site.
//   gameRemoveSite  one button for every case:
//                   - never used (nothing ever referred to it, no stock history): it goes completely, as if it was never made; its board-made
//                     crane and crew go and its map block is freed. A copy of it (every detail, its shape, its crew) is kept for a short while
//                     so Undo (gameRestoreSite) puts back the very same site.
//                   - used, but nothing there and nothing on its way: archived at once (off the map and the lists; kept as history under
//                     Removed sites in the Office, with Open again).
//                   - only the last load still driving home: nothing to ask; it goes when that truck is back.
//                   - scaffold still there or a truck going out: only with bringBack:true (the board asks first, in the words of sfAsk). The
//                     site is marked finishing and everything is brought back with the board's own multi-truck Bring back; the autopilot
//                     (sfTick, after every engine tick) archives it when the last stillage is home and no truck, task, request, collection or
//                     waiting order is left for it. Stock never teleports; hire stops as stock comes back (hire.js, from the ledger).
//                   Sends still waiting for a truck are dropped. Something that blocks it is refused in the plain words of sfBlock (shared
//                   with the board, which shows them with the one button that fixes it). Pressed again while removing: Try again.
//   gameKeepOpen    stop removing: what already came back stays back; only the Bring backs the removal made are called off.
//   gameReopen      a removed (archived) site back on the map in a free block, with its crane and crew (the Office's Open again, and Undo).
//   gameRestoreSite Undo for a never-used site: the same site (same id, details, shape, crane and crew) back in its block, or a free one.
// While a site is being removed nothing new can be booked for it or sent to it by hand (sfGuard, around execute).
import { requireRule } from './geometry.js';
import { AppError } from '../service.js';
import { active } from './inventory.js';
import { cached, savepoint } from '../database.js';
import { RT_EDITABLE } from './collections.js';
import { sfBlock, sfAsk, sfTies } from '../../public/game-finish.js';
export const SF_OPS = ['gameRemoveSite', 'gameKeepOpen', 'gameReopen', 'gameRestoreSite'];
const RETRY_MS = 4000,
  UNDO_KEEP_MS = 30 * 60 * 1000;
// A resource doing something (a task, a job, a load on its forks, a walk): its site is in use.
const BUSY = ['task', 'job', 'cargo', 'drive', 'walk', 'driver', 'claimedBy', 'mountedOn'];
export const SF_FINISH_PROBE =
  "SELECT 1 FROM objects WHERE company_id=? AND kind='site' AND json_type(data,'$.finishing')='object' LIMIT 1";
// Anything that names the site (a truck, a trip, a stillage, a movement, a request, a collection, a yard list, a waiting order, a stocktake, a hire
// rate, a layout ...), other than its own crew standing there, another site, a notification or a kept Undo copy.
const USED =
  "SELECT kind FROM objects WHERE company_id=?1 AND id<>?2 AND kind NOT IN ('site','notification','siteUndo','planItem','message','paperwork') AND instr(data,?2)>0 AND NOT (kind='resource' AND json_extract(data,'$.location')=?2) LIMIT 1";
// Stock history at the site in the ledger (the site's own admin events do not count).
const HISTORY =
  "SELECT event FROM ledger WHERE company_id=?1 AND (source=?2 OR destination=?2) AND (quantity<>0 OR event NOT IN ('COMMAND','SITE_MAP','SITE_DETAILS','SITE_ARCHIVED','SITE_FINISHING','SITE_KEPT_OPEN','SITE_REOPENED','SITE_RESTORED')) LIMIT 1";
const INSERT = 'INSERT INTO objects(id,company_id,kind,data) VALUES(?,?,?,?)';
const logError = (event, fields) => {
  try {
    console.error(JSON.stringify({ event, ...fields }));
  } catch {}
};
const brief = (s) => ({ id: s.id, name: s.name });
// Commands that book something for a site or send a truck there by hand (execute's action -> the site it is for).
const GUARD = {
  request: (sim, i) => i?.site,
  createLoadList: (sim, i) => i?.site,
  requestCollection: (sim, i) => i?.site,
  dispatch: (sim, i) => i?.destination,
  allocate: (sim, i) => sim.repo.get(i?.id, 'request').site,
  allocateLoadList: (sim, i) => sim.repo.get(i?.id, 'loadList').site,
};
export const siteFinishMethods = {
  // What refers to the site (its stock history in the ledger included), or null when it was never used.
  sfUsed(site) {
    const hit = cached(this.db, USED).get(this.repo.company, site.id);
    if (hit) return hit.kind;
    if (this.repo.all('resource').some((r) => r.location === site.id && BUSY.some((k) => r[k]))) return 'resource';
    if (cached(this.db, HISTORY).get(this.repo.company, site.id)) return 'ledger';
    return null;
  },
  // What still ties the site to the yard (public/game-finish.js sfTies): 'stock', 'task', 'loading' / 'sending' (a Send going out), 'truck',
  // 'order', 'collection', 'request', 'count', 'home' (only the last load driving home), or null (nothing: it can be archived).
  sfBusy(site) {
    const id = site.id;
    return sfTies(id, {
      stock: this.containers().some((c) => c.location === id),
      tasks: this.tasks().filter(active),
      trucks: this.repo.all('truck').filter((t) => !t.retired),
      orders: this.repo.all('gameOrder'),
      collections: this.repo.all('collection'),
      requests: this.repo.all('request'),
      counts: this.repo.all('count'),
    });
  },
  // The plain-words reason removing cannot go on (public/game-finish.js sfBlock, which the board shows with the one button that fixes it), plus
  // one the board cannot see: a stillage too heavy for the crew to lift.
  sfBlockFor(site) {
    const all = this.containers().filter((c) => c.location === site.id),
      here = new Set(all.map((c) => c.id));
    const b = sfBlock(site, {
      counts: this.repo.all('count'),
      here,
      containers: all,
      requests: this.repo.all('request'),
      collections: this.repo.all('collection'),
      trucks: this.repo.all('truck').filter((t) => !t.retired),
      tasks: this.tasks().filter(active),
    });
    if (b) return b;
    const yard = this.repo.all('yard')[0];
    if (!yard) return null;
    const lift = this.gameLift(yard);
    const heavy = all.find((c) => {
      try {
        return this.weight(c) > lift;
      } catch {
        return false;
      }
    });
    return heavy
      ? {
          why: heavy.name + ' at ' + site.name + ' is too heavy for the crew to lift. Ask the office to bring it back.',
          fix: { view: 'STOCK', tab: 'CONTAINERS', label: 'Open the stock' },
        }
      : null;
  },
  sfFinishing(id) {
    try {
      return !!this.repo.get(id, 'site').finishing;
    } catch {
      return false;
    }
  },
  // A removal's waiting Bring back does not go while something is in the way there (or a truck could load nothing): no truck drives out for nothing.
  sfHeld(id) {
    let s = null;
    try {
      s = this.repo.get(id, 'site');
    } catch {
      return false;
    }
    return !!s.finishing && (!!s.finishing.stuck || !!this.sfBlockFor(s));
  },
  // Archive (the logistics rule), note when, and send its crew home (switched off, so the crane leaves the map; gameReopen switches them back on).
  sfArchive(site) {
    this.archive({ id: site.id });
    const s = this.repo.get(site.id, 'site');
    s.finishing = null;
    s.finishedAt = new Date().toISOString();
    this.repo.save(s);
    for (const r of this.repo.all('resource'))
      if (r.location === site.id && r.enabled && !BUSY.some((k) => r[k])) {
        r.enabled = false;
        r.finishedOff = true;
        this.repo.save(r);
      }
    return s;
  },
  // Note on the site being removed why it waits (null: it does not); saved only when it changes.
  sfNote(id, patch) {
    const f = this.repo.get(id, 'site');
    if (!f.finishing) return;
    const next = { ...f.finishing, ...patch };
    if (Object.keys(patch).every((k) => (f.finishing[k] ?? null) === (patch[k] ?? null))) return;
    f.finishing = next;
    this.repo.save(f);
  },
  // While removing: bring everything back when nothing is on its way for it yet (the board's Bring back; a full truck queues the next one itself).
  sfCollect(site) {
    const s = this.repo.get(site.id, 'site');
    if (!s.finishing || s.finishing.stuck || !this.containers().some((c) => c.location === s.id)) return;
    const going =
      this.repo.all('truck').some((t) => t.game?.kind === 'COLLECT' && t.game.site === s.id) ||
      this.repo.all('gameOrder').some((o) => o.type === 'COLLECT' && o.site === s.id) ||
      this.repo.all('collection').some((o) => o.site === s.id && ['REQUESTED', 'BOOKED', 'LOADING'].includes(o.status));
    if (going) return;
    try {
      savepoint(this.db, 'sf_collect', () => this.gameCollect({ site: s.id, all: true, byRemove: true }));
      this.sfNote(s.id, { problem: null, retryAt: null });
    } catch (e) {
      if (!e.status) throw e;
      this.sfNote(s.id, { problem: e.message, retryAt: Date.now() + RETRY_MS });
    }
  },
  // A board truck could load nothing at a site being removed (gameStep): the truck comes home empty and removing waits for Try again.
  sfStuck(siteId, message) {
    this.sfNote(siteId, { stuck: message, problem: null, retryAt: null });
  },
  // Undo copies older than half an hour are dropped (Undo shows for seconds).
  sfPrune() {
    const old = Date.now() - UNDO_KEEP_MS;
    for (const u of this.repo.all('siteUndo')) if (!(Date.parse(u.removedAt) > old)) this.repo.remove(u.id, 'siteUndo');
  },
  // A site coming back on the map: every other site keeps its block, and it gets its own block again when that is still free (else null: the
  // first free one, fixed by sfSettle once the site is back).
  sfLot(id, lot) {
    const l = this.worldLayoutNow();
    this.worldPin(l, id);
    const taken = new Set(l.places.filter((p) => p.id !== id).map((p) => p.col + ',' + p.row));
    return lot && Number.isInteger(lot.col) && Number.isInteger(lot.row) && !taken.has(lot.col + ',' + lot.row)
      ? { col: lot.col, row: lot.row }
      : null;
  },
  sfSettle(id) {
    const p = this.worldLayoutNow().byId.get(id);
    if (p && p.auto) {
      const f = this.repo.get(id, 'site');
      f.map = { col: p.col, row: p.row };
      this.repo.save(f);
    }
  },
  // ---------- commands ----------
  gameRemoveSite(input) {
    const site = this.repo.get(input?.site, 'site');
    requireRule(site.status === 'ACTIVE', site.name + ' is already removed.');
    // pressed again while removing: try again after a truck could load nothing
    if (site.finishing) {
      if (site.finishing.stuck) {
        this.sfNote(site.id, { stuck: null, problem: null, retryAt: null });
        this.sfCollect(site);
      }
      return { removing: true, site: brief(site), message: 'Bringing everything back from ' + site.name + '.' };
    }
    const block = this.sfBlockFor(site);
    if (block) throw new AppError(409, block.why);
    // plans for it on the Today calendar are called off and people borrowed there go home first (so its crew below is only its own)
    this.planSiteGone?.(site.id, 'removed');
    // Sends still waiting for a truck no longer go there (inside the command: a refusal below puts them back)
    for (const o of this.repo.all('gameOrder'))
      if (o.site === site.id && o.type === 'SEND') this.repo.remove(o.id, 'gameOrder');
    if (!this.sfUsed(site)) {
      // where it was, so Undo can put it back just the same
      let lot = null;
      try {
        const p = this.worldLayoutNow().byId.get(site.id);
        if (p) lot = { col: p.col, row: p.row };
      } catch (e) {
        logError('sf_lot_error', { message: e?.message });
      }
      // every other site keeps its block (as archive does), then the site, its crew and its notes go; a copy is kept for Undo
      try {
        this.worldPin(this.worldLayoutNow(), site.id);
      } catch (e) {
        if (e instanceof AppError) throw e;
        logError('sf_pin_error', { message: e?.message });
      }
      this.sfPrune();
      const crew = this.repo.all('resource').filter((r) => r.location === site.id);
      const copy = this.repo.add('siteUndo', {
        site: { ...this.repo.get(site.id, 'site') },
        crew,
        lot,
        removedAt: new Date().toISOString(),
        by: this.user.id,
      });
      for (const r of crew) this.repo.remove(r.id, 'resource');
      for (const n of this.repo.all('notification')) if (n.site === site.id) this.repo.remove(n.id, 'notification');
      this.repo.remove(site.id, 'site');
      this.repo.event(this.user.id, 'SITE_REMOVED', {
        reason: 'Removed before it was used: ' + site.name,
        key: this.key,
      });
      return { removed: true, site: brief(site), undo: copy.id, message: site.name + ' removed' };
    }
    const why = this.sfBusy(site);
    if (!why) {
      this.sfArchive(site);
      return { archived: true, site: brief(site), message: site.name + ' removed' };
    }
    // a real yard: removing a site that still has scaffolding recorded there would need the simulated crew to bring it all back
    if (this.live())
      throw new AppError(
        409,
        'There is still scaffolding recorded at ' + site.name + '. Bringing it back comes next in your real yard.',
      );
    // scaffold still there or a truck going out: the board asks first (only the last load driving home: nothing to ask)
    if (why !== 'home') requireRule(input.bringBack === true, sfAsk(site, why));
    site.finishing = { since: new Date().toISOString(), by: this.user.id, problem: null, retryAt: null, stuck: null };
    this.repo.save(site);
    this.repo.event(this.user.id, 'SITE_FINISHING', {
      destination: site.id,
      reason: 'Removing ' + site.name + ': bringing everything back',
      key: this.key,
    });
    this.sfCollect(site);
    return {
      removing: true,
      site: brief(site),
      message:
        why === 'home'
          ? 'The last load from ' + site.name + ' is on its way home. ' + site.name + ' goes when it is back.'
          : 'Bringing everything back from ' + site.name + '.',
    };
  },
  gameKeepOpen(input) {
    const site = this.repo.get(input?.site, 'site');
    requireRule(site.status === 'ACTIVE' && site.finishing, site.name + ' is not being removed.');
    site.finishing = null;
    this.repo.save(site);
    // only what the removal asked for is called off: a Bring back the owner asked for himself still goes
    for (const o of this.repo.all('gameOrder'))
      if (o.site === site.id && o.type === 'COLLECT' && o.byRemove) this.repo.remove(o.id, 'gameOrder');
    // a truck still driving out empty to fetch everything for the removal: its collection is cancelled, so it turns round when it gets there
    for (const t of this.repo.all('truck'))
      if (t.game?.kind === 'COLLECT' && t.game.site === site.id && t.game.stage === 'OUTBOUND') {
        let o = null;
        try {
          o = this.repo.get(t.game.collection, 'collection');
        } catch {}
        if (o?.byRemove && RT_EDITABLE.includes(o.status))
          this.cancelCollection({ id: o.id, reason: 'The site is kept' });
      }
    this.repo.event(this.user.id, 'SITE_KEPT_OPEN', {
      destination: site.id,
      reason: site.name + ' kept',
      key: this.key,
    });
    return { ok: true, site: brief(site), message: site.name + ' stays.' };
  },
  gameReopen(input) {
    const site = this.repo.get(input?.site, 'site');
    requireRule(site.status === 'ARCHIVED', site.name + ' is already open.');
    const map = this.sfLot(site.id, site.map),
      s = this.repo.get(site.id, 'site');
    Object.assign(s, { status: 'ACTIVE', finishing: null, finishedAt: null, map });
    this.repo.save(s);
    this.sfSettle(s.id);
    for (const r of this.repo.all('resource'))
      if (r.location === s.id && r.finishedOff) {
        r.enabled = true;
        delete r.finishedOff;
        this.repo.save(r);
      }
    this.gameCrew(this.repo.get(s.id, 'site'));
    this.repo.event(this.user.id, 'SITE_REOPENED', {
      destination: s.id,
      reason: s.name + ' opened again',
      key: this.key,
    });
    return { ok: true, site: brief(s), message: s.name + ' is back on the map.' };
  },
  // Undo for a never-used site: the very same record (id, client, contact, shape ...) and its crane and crew, in its own block when still free.
  gameRestoreSite(input) {
    let u = null;
    try {
      u = this.repo.get(input?.undo, 'siteUndo');
    } catch {}
    requireRule(u, 'That site can no longer be put back.');
    requireRule(Date.parse(u.removedAt) > Date.now() - UNDO_KEEP_MS, 'That site can no longer be put back.');
    const { id, kind, version, ...data } = u.site;
    requireRule(!cached(this.db, 'SELECT 1 FROM objects WHERE id=?').get(id), 'That site is already back.');
    const map = this.sfLot(id, u.lot ?? data.map);
    cached(this.db, INSERT).run(
      id,
      this.repo.company,
      'site',
      JSON.stringify({ ...data, status: 'ACTIVE', finishing: null, map }),
    );
    this.repo.cache = null;
    for (const r of u.crew ?? []) {
      const { id: rid, kind: rk, version: rv, ...rd } = r;
      if (!cached(this.db, 'SELECT 1 FROM objects WHERE id=?').get(rid))
        cached(this.db, INSERT).run(rid, this.repo.company, 'resource', JSON.stringify({ ...rd, task: null }));
    }
    this.repo.cache = null;
    this.repo.remove(u.id, 'siteUndo');
    this.sfSettle(id);
    if (
      this.repo
        .all('planItem')
        .some((i) => i.site === id && i.status === 'CANCELLED' && /^Site removed/.test(i.cancelReason ?? ''))
    )
      this.notify(
        'Plans cancelled',
        'Plans for ' + data.name + ' were cancelled when it was removed. Plan them again if needed.',
        id,
      );
    this.repo.event(this.user.id, 'SITE_RESTORED', {
      destination: id,
      reason: data.name + ' put back (Undo)',
      key: this.key,
    });
    const s = this.repo.get(id, 'site');
    return { ok: true, site: { ...s }, message: s.name + ' is back on the map.' };
  },
  // ---------- after every engine tick ----------
  // Sites being removed: archived (with a calm note) when nothing is left; otherwise why it waits is noted, or everything is fetched (again)
  // when nothing is on its way.
  sfTick() {
    if (!cached(this.db, SF_FINISH_PROBE).get(this.repo.company)) return;
    const now = Date.now();
    for (const s of this.repo.all('site')) {
      if (!s.finishing || s.status !== 'ACTIVE') continue;
      try {
        savepoint(this.db, 'sf_tick', () => {
          const why = this.sfBusy(s);
          if (!why) {
            const done = this.sfArchive(s);
            this.notify('Site removed', done.name + ' is finished and removed.', done.id);
            return;
          }
          if (why === 'home') return;
          // in the way: said on the site; once it is fixed, a truck that could load nothing because of it no longer holds it up
          const block = this.sfBlockFor(s);
          if (block) {
            this.sfNote(s.id, { blocked: block.why });
            return;
          }
          if (s.finishing.blocked) {
            this.sfNote(s.id, { blocked: null, stuck: null, problem: null, retryAt: null });
            this.sfCollect(s);
            return;
          }
          if (s.finishing.retryAt && now < s.finishing.retryAt) return;
          this.sfCollect(s);
        });
      } catch (error) {
        if (!error.status) logError('sf_tick_error', { site: s.id, message: error.message });
      }
    }
  },
};
// While a site is being removed, nothing new is booked for it or sent there by hand ("Tap Keep it first"). A replayed command (its idempotency
// key already answered) is left to execute, which returns the first answer.
export function sfGuard(proto) {
  const execute = proto.execute;
  if (typeof execute !== 'function') throw new AppError(500, 'Remove site needs execute.');
  proto.execute = function (action, input, key) {
    const of = GUARD[action];
    if (
      of &&
      typeof key === 'string' &&
      !cached(this.db, 'SELECT 1 FROM commands WHERE company_id=? AND key=?').get(this.user.company_id, key)
    ) {
      let site = null;
      try {
        const id = of(this, input);
        const o = typeof id === 'string' ? this.repo.get(id) : null;
        if (o?.kind === 'site') site = o;
      } catch {}
      if (site?.finishing && site.status === 'ACTIVE')
        throw new AppError(409, site.name + ' is being removed. Tap Keep it first.');
    }
    return execute.call(this, action, input, key);
  };
}
