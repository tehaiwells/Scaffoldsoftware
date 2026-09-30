process.env.TZ = 'Australia/Sydney'; // the planner's days and times are Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planFixture, D0, L } from './helpers/plan-fixture.js';
import { addDays } from '../src/domain/schedule.js';
import { squash } from './helpers/source.js';
// Phase 0 review fixes (the owner-day and security reviews of the merged Phase 0): the Today parts picker never inflates a list to stock the yard
// does not have, a late day does not say "done" over bookings that didn't go, and the Account page stays calm (checked in the page source here;
// the page itself is checked in Edge by the browser suite).
const D1 = addDays(D0, 1);
const OWNER = [
  'company.manage',
  'users.manage',
  'operations.manage',
  'sites.assigned',
  'requests.create',
  'finance.view',
  'stock.adjust',
];
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'),
  appCode = squash(app);
// A piece of code in public/app.js, whatever its layout.
const hasCode = (snippet) => appCode.includes(squash(snippet));

test('the planning picker in an empty yard: 30 stays 30 and the words never say "will go" next to "0 free" (owner-day: 30 became 414)', async (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const { p } = f.stock(0);
  const { gmTest } = await import('../public/game.js');
  const pk = gmTest.planPick({ state: f.sim.snapshot(), lift: 1500000 });
  const h = pk.type(p.id, 30);
  assert.ok(h.includes('value="30"'), 'the typed number is kept');
  assert.ok(!h.includes('will go'), h.match(/data-pp-words>[^<]*/)?.[0]);
  assert.match(
    h,
    /data-pp-words>30 pieces\. They come in stillages of \d+; the crew sends whole stillages when it is packed\. &middot; <span class="pp-over">more than you have: 0 free in the yard now/,
  );
  assert.deepEqual(pk.done(), [{ product: p.id, quantity: 30 }]);
  // the booking says nothing about what "will go" either (the server's planSnapWords uses the real stillages: there are none)
  const site = f.site();
  const r = f.cmd('planMaterials', { day: addDays(D0, 2), site: site.id, lines: [{ product: p.id, quantity: 30 }] });
  assert.ok(!/will go/.test(r.message), r.message);
  assert.equal(r.item.lines[0].quantity, 30);
});

test('the planning picker with stock that is short of a whole stillage keeps the typed number; with the stillages free it still goes up to them', async (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const { p, per } = f.stock(1);
  const { gmTest } = await import('../public/game.js');
  const pk = gmTest.planPick({ state: f.sim.snapshot(), lift: 1500000 });
  const one = pk.type(p.id, Math.floor(per / 2));
  assert.ok(one.includes('value="' + per + '"'), 'one stillage is free: it goes up to it');
  assert.ok(one.includes('so ' + per + ' will go.'));
  const two = pk.type(p.id, per + 1);
  assert.ok(two.includes('value="' + (per + 1) + '"'), 'two stillages are not free: the number stays');
  assert.ok(!two.includes('will go'));
});

test('a late day: "Today\'s work is done" is not said over bookings that didn\'t go; the header counts them once; nobody is listed as driving or chased for them', async (t) => {
  const f = planFixture(t, { now: L(D0, '16:00') });
  f.cmd('teamStart');
  f.cmd('planReplies', { on: false });
  const a = f.site('Bondi');
  const { p, per } = f.stock(3);
  const tr = f.cmd('planTruck', { day: D1, truck: f.truck('T-01').id, driver: f.driver('Dave').id, time: '06:30' });
  f.cmd('planMaterials', {
    day: D1,
    site: a.id,
    lines: [{ product: p.id, quantity: per }],
    truckPlan: tr.item.id,
    time: '09:00',
  });
  const liam = f.cmd('teamAdd', { name: 'Liam', role: 'SCAFFOLDER' }).person.id;
  f.cmd('planWorkers', { day: D1, site: a.id, count: 2, people: [liam], time: '07:00' });
  f.clock(D1, '17:00');
  f.pass();
  const tv = f.sim.todayView();
  assert.equal(
    tv.summary.sentence,
    'Nothing planned today. · 3 bookings need sorting',
    'once (was "3 people haven\'t answered · 3 bookings didn\'t go")',
  );
  assert.deepEqual(tv.roster.driving, [], "Dave is not DRIVING T-01 on a booking that didn't go");
  assert.deepEqual(tv.roster.waiting, [], 'and nobody gets a "Sort it" for it');
  const { __test: T, tdTest: td } = await import('../public/operations.js');
  td.reset();
  T.setState(f.sim.snapshot(), {
    permissions: OWNER,
    systems: [],
    users: [],
    company: { id: 'c', name: 'Tee' },
    user: { id: f.user.id, name: 'Owner' },
  });
  T.setView('TODAY');
  td.setData(f.sim.planMonth(D1.slice(0, 7)), tv);
  td.select(D1);
  const html = td.view(),
    day = html.slice(html.indexOf('id="tdh-day"'));
  assert.ok(day.includes('Didn&#39;t go') || day.includes("Didn't go"), "the day shows what didn't go");
  assert.ok(!html.includes('Today’s work is done'), 'not "done" under three red bookings');
  // an ordinary finished day still says it
  const g = planFixture(t, { now: L(D0, '16:00') });
  g.clock(D0, '18:00');
  const { __test: T2, tdTest: td2 } = await import('../public/operations.js');
  td2.reset();
  T2.setState(g.sim.snapshot(), {
    permissions: OWNER,
    systems: [],
    users: [],
    company: { id: 'c', name: 'Tee' },
    user: { id: g.user.id, name: 'Owner' },
  });
  T2.setView('TODAY');
  td2.setData(g.sim.planMonth(D0.slice(0, 7)), g.sim.todayView());
  td2.select(D0);
  assert.ok(td2.view().includes('Today’s work is done'), 'a quiet day that is over');
});

test('Account stays calm: This computer sits in the left column, the sign-up switch is under More, the decrypt note lives with the encrypted copy', () => {
  assert.ok(
    hasCode('const left=owner?company+members+activity+server:'),
    'This computer under Recent activity (the right column was ~600 px taller)',
  );
  assert.ok(hasCode('right=owner?backups+catalogue+switcher:access+server'));
  const more = appCode.indexOf(squash('<details class="acct-fold server-more"'));
  assert.ok(more > 0);
  assert.ok(
    appCode
      .slice(more, more + 400)
      .includes(
        squash(
          `'+(c.openRegistration?' open':'')+'><summary><span class="fold-title">More</span></summary><label class="server-switch"><input type="checkbox" name="openRegistration"`,
        ),
      ),
  );
  assert.ok(
    app.includes(
      'While it is on, anyone who can open Scaffold Yard can make a company and find out whether an email already has a sign-in here.',
    ),
    'what switching sign-up on gives away, said plainly',
  );
  const off = appCode.indexOf(squash('const offsitePanel=')),
    restore = appCode.indexOf(squash('<div class="backup-restore">'));
  assert.ok(off > 0 && restore > 0);
  assert.ok(
    appCode.indexOf(squash('npm run decrypt-backup')) < off,
    'the decrypt note is built for the encrypted-copy fold',
  );
  assert.ok(
    !appCode.slice(restore, appCode.indexOf('</div>`;', restore)).includes('decrypt-backup'),
    'and is no longer in the always-open restore steps',
  );
});

test('Account: the one-time line about phones after the update, how to restart, and the Wi-Fi switch only at this PC', () => {
  assert.ok(
    app.includes(
      'Since the last update, phones on your Wi-Fi can’t open Scaffold Yard. If you or the crew use it on a phone, tick the first box, press Save, then restart Scaffold Yard.',
    ),
  );
  assert.ok(hasCode(`(c.lanNotice?'<p class="acct-note server-since">`));
  assert.ok(
    app.includes(
      'Changes when Scaffold Yard next starts: close the “Scaffold Yard server” window, then open Scaffold Yard from the desktop again.',
    ),
  );
  assert.ok(app.includes('Change these on the computer that runs Scaffold Yard.'));
  assert.ok(hasCode("const off=c.atThisPC===false?' disabled':''"));
});

test('invitation links that only open on this PC say so, and what to do for a phone', () => {
  assert.ok(
    app.includes(
      ' This link only opens on this computer. For a phone, tick “Let phones on this Wi-Fi open Scaffold Yard” under This computer, restart Scaffold Yard, then make a new link.',
    ),
  );
  assert.ok(
    app.includes(
      ' This link only opens on the computer that runs Scaffold Yard. For a phone, ask the person who runs it to let phones on the Wi-Fi open it.',
    ),
    'a manager, who cannot tick it',
  );
  assert.ok(!app.includes('It opens on this computer.'));
});

test('the encrypted-copy folder box takes a long path (a 128 cut sent copies to a parent folder) and the confirmation names the folder', () => {
  assert.ok(hasCode("const field=(name,label,type='text',value='',max=type==='email'?254:128)=>"));
  assert.ok(hasCode("field('folder','Folder (for example E:\\\\Scaffold Yard backups)','text','',400)"));
  assert.ok(hasCode("notify('Encrypted copy is on. Copies go to: '+(on.offsite?.folder??data.folder))"));
});

test('npm run decrypt-backup no longer shows the passphrase as it is typed (it uses the same hidden input as the restore drill)', () => {
  const d = readFileSync(new URL('../scripts/decrypt-backup.js', import.meta.url), 'utf8'),
    r = readFileSync(new URL('../scripts/restore-drill.js', import.meta.url), 'utf8'),
    ask = readFileSync(new URL('../scripts/ask-passphrase.js', import.meta.url), 'utf8');
  assert.ok(!/readline/.test(d), 'readline question() echoes what is typed');
  for (const s of [d, r]) assert.match(s, /import \{ askPassphrase \} from '\.\/ask-passphrase\.js';/);
  assert.match(ask, /setRawMode\(true\)/);
});
