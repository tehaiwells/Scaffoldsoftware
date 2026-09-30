// The team (Office, Workers page, "Your team"): the people messages go to. Yard hands and site crew are the existing WORKER resources (a name,
// an optional role and mobile); drivers are 'driver' rows (not resources, so the yard never gives them jobs). Commands need operations.manage
// (simulation.js). Nothing renames anyone by itself: "Worker 1" stays until the owner renames it (the list says it is a demo name).
import { requireRule } from './geometry.js';
import { AppError } from '../service.js';
import { bumpRevision } from '../repository.js';
import { idleWorker } from './fleet.js';
import { crewEndAll, crewRolesFollow } from '../crew-auth.js';
export const WORKER_ROLES = ['YARDSMAN', 'SCAFFOLDER', 'LEADING_HAND'],
  TEAM_ROLES = [...WORKER_ROLES, 'DRIVER'];
export const ROLE_WORDS = {
  YARDSMAN: 'Yardsman',
  SCAFFOLDER: 'Scaffolder',
  LEADING_HAND: 'Leading hand',
  DRIVER: 'Driver',
};
export const DEMO_NAME = /^Worker \d+$/;
// First names for the demo team (teamStart gives each "Worker n" one of these, once; all editable). Never names the tests or the owner add.
export const DEMO_FIRST = [
  'Tom',
  'Sione',
  'Matt',
  'Josh',
  'Ben',
  'Kane',
  'Luke',
  'Brodie',
  'Nathan',
  'Ryan',
  'Dylan',
  'Hamish',
  'Tui',
  'Mitch',
  'Cooper',
  'Riley',
  'Jai',
  'Kurt',
  'Wade',
  'Bailey',
  'Corey',
  'Darcy',
  'Flynn',
  'Hudson',
  'Jarrah',
  'Kobe',
  'Lachie',
  'Nico',
  'Rhys',
];
const MOBILE_ERROR = 'Enter a mobile number like 0412 345 678.';
// Australian mobiles in E.164: 0412 345 678 -> +61412345678; +61 412 345 678 (or +61 0412 ...) kept; another country's +cc... kept when it has
// 8 to 15 digits. Empty -> null.
export function normMobile(v) {
  if (v === undefined || v === null) return null;
  requireRule(typeof v === 'string', MOBILE_ERROR);
  const s = v.trim();
  if (!s) return null;
  requireRule(
    s.length <= 30 && /^[0-9+()\-\s]+$/.test(s) && !/\+.*\+/.test(s) && (!s.includes('+') || s.startsWith('+')),
    MOBILE_ERROR,
  );
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) {
    if (digits.startsWith('61')) {
      const rest = digits.slice(2).replace(/^0/, '');
      requireRule(/^4\d{8}$/.test(rest), MOBILE_ERROR);
      return '+61' + rest;
    }
    requireRule(digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0'), MOBILE_ERROR);
    return '+' + digits;
  }
  requireRule(/^04\d{8}$/.test(digits), MOBILE_ERROR);
  return '+61' + digits.slice(1);
}
// +61412345678 -> 0412 345 678 (others as stored).
export const mobileWords = (e) => {
  if (!e) return null;
  const m = /^\+614(\d{2})(\d{3})(\d{3})$/.exec(e);
  return m ? '04' + m[1] + ' ' + m[2] + ' ' + m[3] : e;
};
const nameOf = (v) => {
  requireRule(
    typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 60,
    'Enter a name (up to 60 letters).',
  );
  return v.trim().replace(/\s+/g, ' ');
};
export const teamMethods = {
  // Where a worker belongs: the place they were borrowed from while away (plan.js), else where they are.
  teamHome(w) {
    return w.away?.from ?? w.location;
  },
  // A worker's role: the one the owner set, else yard crew are yardsmen and site crew scaffolders.
  roleOf(w, kinds) {
    if (w.role && WORKER_ROLES.includes(w.role)) return w.role;
    const home = this.teamHome(w);
    let kind = kinds?.get(home);
    if (kind === undefined) {
      try {
        kind = this.repo.get(home).kind;
      } catch {
        kind = null;
      }
    }
    return kind === 'yard' ? 'YARDSMAN' : 'SCAFFOLDER';
  },
  placeKinds() {
    return new Map([
      ...this.repo.all('yard').map((y) => [y.id, 'yard']),
      ...this.repo.all('site').map((s) => [s.id, s.status === 'ACTIVE' ? 'site' : 'gone']),
    ]);
  },
  // Enabled workers at a yard or an active site (a finished site's crew is switched off).
  teamWorkers(kinds = this.placeKinds()) {
    return this.repo
      .all('resource')
      .filter((r) => r.type === 'WORKER' && r.enabled && ['yard', 'site'].includes(kinds.get(r.location)));
  },
  teamDrivers() {
    return this.repo.all('driver').filter((d) => d.active);
  },
  // The person a message or plan names (a worker resource or a driver), or null when they are gone.
  teamPerson(id) {
    if (typeof id !== 'string') return null;
    try {
      const o = this.repo.get(id);
      if (o.kind === 'driver') return o.active ? o : null;
      if (o.kind === 'resource' && o.type === 'WORKER') return o.enabled ? o : null;
    } catch {}
    return null;
  },
  // A name people can tell apart: a demo "Worker n" also says where they belong ("Worker 1 (Bondi)").
  teamLabel(p) {
    if (!p) return 'Someone';
    if (p.kind === 'driver' || !DEMO_NAME.test(p.name ?? '')) return p.name;
    let at = null;
    try {
      at = this.repo.get(this.teamHome(p)).name;
    } catch {}
    return at ? p.name + ' (' + at + ')' : p.name;
  },
  teamNameTaken(name, except) {
    const n = name.toLowerCase();
    return [...this.teamWorkers(), ...this.teamDrivers()].some(
      (p) => p.id !== except && String(p.name).toLowerCase() === n,
    );
  },
  // ---------- commands ----------
  teamAdd(input) {
    const name = nameOf(input?.name),
      role = input?.role;
    requireRule(TEAM_ROLES.includes(role), 'Choose Yardsman, Scaffolder, Leading hand or Driver.');
    const mobile = normMobile(input.mobile);
    requireRule(!this.teamNameTaken(name), "There's already a " + name + ' in your team. Add a surname or an initial.');
    const now = new Date().toISOString();
    if (role === 'DRIVER') {
      const d = this.repo.add('driver', { name, mobile, active: true, demo: false, createdAt: now, removedAt: null });
      return { person: this.teamRow(d), message: name + ' is in your team as a driver.' };
    }
    const yard = this.repo.all('yard')[0];
    requireRule(yard, 'Set up your yard first.');
    this.ensureConfig();
    const w = this.repo.add('resource', {
      name,
      type: 'WORKER',
      location: yard.id,
      enabled: true,
      task: null,
      role,
      mobile,
    });
    bumpRevision(this.db, this.repo.company, 'plan');
    return { person: this.teamRow(w), message: name + ' is in your team as a ' + ROLE_WORDS[role].toLowerCase() + '.' };
  },
  teamUpdate(input) {
    const p = this.repo.get(input?.id);
    const worker = p.kind === 'resource' && p.type === 'WORKER';
    requireRule(worker || p.kind === 'driver', 'Choose someone in your team.');
    requireRule(worker ? p.enabled : p.active, 'That person has left the team.');
    const was = p.name;
    let changed = false;
    if (input.name !== undefined) {
      const name = nameOf(input.name);
      if (name !== p.name) {
        requireRule(
          !this.teamNameTaken(name, p.id),
          "There's already a " + name + ' in your team. Add a surname or an initial.',
        );
        p.name = name;
        changed = true;
      }
    }
    if (input.role !== undefined && input.role !== null) {
      requireRule(TEAM_ROLES.includes(input.role), 'Choose Yardsman, Scaffolder, Leading hand or Driver.');
      if (worker) {
        requireRule(input.role !== 'DRIVER', 'Add them again as a driver.');
        if (p.role !== input.role) {
          p.role = input.role;
          changed = true;
        }
      } else requireRule(input.role === 'DRIVER', 'Drivers stay drivers. Add them again as a yardsman or scaffolder.');
    }
    if (input.mobile !== undefined) {
      const mobile = normMobile(input.mobile);
      if ((p.mobile ?? null) !== mobile) {
        p.mobile = mobile;
        changed = true;
      }
    }
    if (!changed) return { person: this.teamRow(p), changed: false, message: 'Nothing changed.' };
    if (p.kind === 'driver' && p.name !== was) p.demo = false;
    if (worker && p.name !== was) p.demoName = false;
    this.repo.save(p);
    if (worker) bumpRevision(this.db, this.repo.company, 'plan');
    if (worker && this.live()) crewRolesFollow(this.db, this.repo.company, p.id); // their phone's YARD role follows their role
    return {
      person: this.teamRow(p),
      changed: true,
      message: was !== p.name ? was + ' is now ' + p.name + '.' : 'Saved for ' + p.name + '.',
    };
  },
  teamRemove(input) {
    const p = this.repo.get(input?.id);
    if (p.kind === 'driver') {
      requireRule(p.active, p.name + ' has already left the team.');
      p.active = false;
      p.removedAt = new Date().toISOString();
      this.repo.save(p);
      this.planPersonGone('driver', p.id);
      crewEndAll(this.db, this.repo.company, { driver: p.id }, this.user.id); // their phones are signed out at once
      return { ok: true, message: p.name + ' has left the team.' };
    }
    requireRule(p.kind === 'resource' && p.type === 'WORKER', 'Choose someone in your team.');
    requireRule(p.enabled, p.name + ' has already left the team.');
    if (p.away) {
      let site = 'a site';
      try {
        site = this.repo.get(p.location, 'site').name;
      } catch {}
      throw new AppError(409, p.name + ' is at ' + site + ' today. Remove them tomorrow.');
    }
    requireRule(idleWorker(p), p.name + ' is busy on a job, try again in a moment.');
    this.retireResource(p);
    bumpRevision(this.db, this.repo.company, 'plan');
    crewEndAll(this.db, this.repo.company, { driver: p.id }, this.user.id); // a worker's phone is signed out at once too (ADR 0010)
    return { ok: true, message: p.name + ' has left the team.' };
  },
  // Two demo drivers, once, so the owner can book a truck with a driver straight away (the Today page asks for this when there are none).
  teamStart() {
    const s = this.repo.all('planSettings')[0] ?? null;
    if (s?.demoDriversAdded || this.repo.all('driver').length) return { added: 0, message: 'Your team is ready.' };
    const now = new Date().toISOString();
    for (const name of ['Dave', 'Sam'])
      this.repo.add('driver', { name, mobile: null, active: true, demo: true, createdAt: now, removedAt: null });
    if (s) this.repo.save({ ...s, demoDriversAdded: true });
    else this.repo.add('planSettings', { demoDriversAdded: true });
    return { added: 2, message: 'Two demo drivers, Dave and Sam, are in your team. Rename them in the Office.' };
  },
  // Once: every demo "Worker n" gets a first name of its own (yard crew first), so booking rows, replies and rosters can be told apart. The
  // Today page asks for this with teamStart; each stays editable and is marked as a demo name until renamed.
  teamNames() {
    const s = this.repo.all('planSettings')[0] ?? null;
    if (s?.demoNamesGiven) return { named: 0, message: 'Your team already has names.' };
    const used = new Set([...this.teamWorkers(), ...this.teamDrivers()].map((p) => String(p.name).toLowerCase())),
      pool = DEMO_FIRST.filter((n) => !used.has(n.toLowerCase())),
      kinds = this.placeKinds();
    const demo = this.teamWorkers(kinds)
      .filter((w) => DEMO_NAME.test(w.name))
      .sort(
        (a, b) =>
          (kinds.get(this.teamHome(a)) === 'yard' ? 0 : 1) - (kinds.get(this.teamHome(b)) === 'yard' ? 0 : 1) ||
          String(this.teamHome(a)).localeCompare(String(this.teamHome(b))) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    let named = 0;
    for (const w of demo) {
      const name = pool.shift();
      if (!name) break;
      w.name = name;
      w.demoName = true;
      this.repo.save(w);
      named++;
    }
    if (s) this.repo.save({ ...s, demoNamesGiven: true });
    else this.repo.add('planSettings', { demoNamesGiven: true });
    if (named) bumpRevision(this.db, this.repo.company, 'plan');
    return {
      named,
      message: named
        ? 'Your crew have first names now. Rename anyone in the Office, Workers.'
        : 'Your team already has names.',
    };
  },
  // ---------- views ----------
  teamRow(p, kinds) {
    if (p.kind === 'driver')
      return {
        id: p.id,
        kind: 'driver',
        name: p.name,
        role: 'DRIVER',
        roleWords: 'Driver',
        mobile: p.mobile ?? null,
        mobileWords: mobileWords(p.mobile),
        demo: !!p.demo,
        demoName: false,
        where: null,
        away: null,
        active: !!p.active,
        phoneView: '?view=CREW&driver=' + encodeURIComponent(p.id),
      };
    const role = this.roleOf(p, kinds),
      at = (id) => {
        try {
          return this.repo.get(id).name;
        } catch {
          return null;
        }
      };
    return {
      id: p.id,
      kind: 'worker',
      name: p.name,
      role,
      roleWords: ROLE_WORDS[role],
      roleSet: !!p.role,
      mobile: p.mobile ?? null,
      mobileWords: mobileWords(p.mobile),
      demo: false,
      demoName: DEMO_NAME.test(p.name) || !!p.demoName,
      label: this.teamLabel(p),
      where: at(this.teamHome(p)),
      home: this.teamHome(p),
      away: p.away ? { item: p.away.item, site: p.location, siteName: at(p.location) } : null,
      busy: !idleWorker(p),
      active: !!p.enabled,
      phoneView: '?view=CREW&worker=' + encodeURIComponent(p.id),
    };
  },
  // GET /api/team: the Team list (operations only). Yard crew first, then site crew by site, then drivers; by name.
  teamView() {
    this.auth.require(this.user, 'operations.manage');
    const kinds = this.placeKinds(),
      order = { YARDSMAN: 0, LEADING_HAND: 1, SCAFFOLDER: 2, DRIVER: 4 };
    const rows = [
      ...this.teamWorkers(kinds).map((w) => this.teamRow(w, kinds)),
      ...this.teamDrivers().map((d) => this.teamRow(d)),
    ];
    rows.sort(
      (a, b) =>
        (a.kind === 'driver') - (b.kind === 'driver') ||
        (kinds.get(a.home) === 'yard' ? 0 : 1) - (kinds.get(b.home) === 'yard' ? 0 : 1) ||
        String(a.where ?? '').localeCompare(String(b.where ?? ''), undefined, { numeric: true }) ||
        order[a.role] - order[b.role] ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    const s = this.repo.all('planSettings')[0] ?? null;
    return {
      people: rows,
      roles: TEAM_ROLES.map((r) => ({ code: r, words: ROLE_WORDS[r] })),
      // the Practice yard's demo drivers and names (a real yard's people are only the ones the owner adds)
      needsStart: !this.live() && !s?.demoDriversAdded && !this.repo.all('driver').length,
      needsNames: !this.live() && !s?.demoNamesGiven && rows.some((r) => r.kind === 'worker' && DEMO_NAME.test(r.name)),
    };
  },
};
