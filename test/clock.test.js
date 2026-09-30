process.env.TZ = 'Australia/Sydney'; // the server's zone; the Perth company below keeps its own
// The business clock (ADR 0002): company time, catching up after the computer was off, never too late, never done by itself. LIVE only:
// nothing here calls tick().
import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneAt, zoneParts, validZone } from '../src/domain/zonetime.js';
import { atLocal } from '../src/domain/plantime.js';
import { addDays } from '../src/domain/schedule.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1),
  DM1 = addDays(D0, -1);

test('company time: days and times in the company zone, whatever zone the server runs in, across daylight saving', () => {
  assert.equal(zoneAt('2026-10-13', '15:00', 'Australia/Perth'), Date.parse('2026-10-13T07:00:00Z'), 'Perth is UTC+8');
  assert.equal(
    zoneAt('2026-10-13', '15:00', 'Australia/Sydney'),
    Date.parse('2026-10-13T04:00:00Z'),
    'Sydney in October: +11',
  );
  assert.equal(
    zoneAt('2026-06-10', '15:00', 'Australia/Sydney'),
    Date.parse('2026-06-10T05:00:00Z'),
    'Sydney in June: +10',
  );
  assert.equal(
    zoneAt('2026-10-04', '06:00', 'Australia/Sydney'),
    Date.parse('2026-10-03T19:00:00Z'),
    'the morning clocks go forward',
  );
  assert.equal(
    zoneAt('2026-04-05', '06:00', 'Australia/Sydney'),
    Date.parse('2026-04-04T20:00:00Z'),
    'the morning clocks go back',
  );
  assert.equal(
    zoneAt('2026-10-13', '15:00', 'Australia/Sydney'),
    atLocal('2026-10-13', '15:00'),
    'the same as the server here',
  );
  assert.deepEqual(
    { ...zoneParts(Date.parse('2026-10-13T17:30:00Z'), 'Australia/Perth') },
    { day: '2026-10-14', hm: '01:30', second: 0 },
  );
  assert.equal(zoneParts(Date.parse('2026-10-13T15:30:00Z'), 'Australia/Perth').day, '2026-10-13', '11:30 pm in Perth');
  assert.equal(
    zoneParts(Date.parse('2026-10-13T15:30:00Z'), 'Australia/Sydney').day,
    '2026-10-14',
    'already tomorrow in Sydney',
  );
  assert.ok(validZone('Australia/Brisbane'));
  assert.ok(!validZone('Nowhere/Else') && !validZone('') && !validZone(null));
});

test('the 3 pm ask goes out at 3 pm company time; the people are never answered for or moved; the day ends not confirmed', (t) => {
  const f = liveFixture(t);
  const w = f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 2 }).item;
  f.clock(D0, '14:59');
  f.pass();
  assert.equal(f.msgs(w.id).length, 0, 'not yet');
  f.clock(D0, '15:00');
  f.pass();
  const asks = f.msgs(w.id);
  assert.deepEqual(
    asks.map((m) => m.status),
    ['SENT', 'SENT'],
    'sent in the first pass at 3 pm',
  );
  assert.equal(asks[0].sentAt, new Date(f.at(D0, '15:00')).toISOString());
  f.clock(D0, '15:01');
  f.pass();
  f.pass();
  assert.equal(f.msgs(w.id).length, 2, 'a pass run again sends nothing twice');
  f.clock(D1, '07:00');
  f.pass();
  const on = f.item(w.id);
  assert.equal(on.status, 'ACTIVE');
  assert.match(on.problem, /^No answer yet from (Jo|Sam|Kev) and (Jo|Sam|Kev)\.$/);
  assert.ok(!f.sim.repo.all('resource').some((r) => r.away || r.location !== f.yard.id), 'nobody went anywhere');
  f.clock(D1, '17:00');
  f.pass();
  const end = f.item(w.id);
  assert.equal(end.stage, 'UNCONFIRMED');
  assert.notEqual(end.status, 'DONE');
  assert.match(end.problem, /^Not confirmed: nobody said they were coming\./);
  assert.ok(
    f.msgs(w.id).every((m) => m.closedAt),
    'too late to answer now',
  );
});

test('8-hour catch-up: the computer is off 10 am to 6 pm; one pass at 6 pm sends the 3 pm asks late, flags the day, reminds nobody late', (t) => {
  const f = liveFixture(t, { now: zoneAt(DM1, '09:00', 'Australia/Sydney') });
  f.clock(DM1, '09:00');
  const today = f.cmd('planWorkers', {
    day: D0,
    time: '13:00',
    site: f.site.id,
    count: 1,
    people: [f.team.Jo.id],
  }).item;
  const truck = f.cmd('planTruck', { day: D0, time: '09:30', truck: f.truck.id, driver: f.team.Dave.id }).item;
  f.clock(DM1, '15:00');
  f.pass();
  assert.equal(f.msgs(today.id)[0].status, 'SENT', 'asked the day before');
  f.clock(D0, '09:00');
  f.pass();
  const tomorrow = f.cmd('planWorkers', {
    day: D1,
    time: '07:00',
    site: f.site.id,
    count: 1,
    people: [f.team.Sam.id],
  }).item;
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    pack: 'DAY_BEFORE',
    lines: [{ product: f.product.id, quantity: 5 }],
  }).item;
  f.clock(D0, '10:00');
  f.pass();
  const before = records(f.db, f.company);
  // ... off for eight hours: no pass at all ...
  f.clock(D0, '18:00');
  f.pass();
  // the 3 pm ask for tomorrow went out now, said to be late
  const late = f.msgs(tomorrow.id)[0];
  assert.equal(late.status, 'SENT');
  assert.equal(late.sentAt, new Date(f.at(D0, '18:00')).toISOString());
  assert.ok(f.item(tomorrow.id).log.some((l) => l.text === 'Sent late: the computer was off at 3 pm.'));
  // the pack ask for tomorrow's list (packed the day before, from 6 am) had already gone at 10 am
  assert.equal(f.msgs(list.id)[0]?.subject, 'PACK');
  // today's bookings: their day ended at 5 pm with nothing confirmed, so they are flagged, not done
  for (const id of [today.id, truck.id]) {
    const it = f.item(id);
    assert.equal(it.stage, 'UNCONFIRMED', it.type);
    assert.notEqual(it.status, 'DONE');
    assert.ok(!it.log.some((l) => /done/i.test(l.text)));
  }
  assert.match(f.item(truck.id).problem, /^Not confirmed: Dave never said yes\./);
  // Jo's ask (sent yesterday, its time long gone) was not reminded late; nothing moved; a second pass changes nothing
  assert.ok(!f.sim.repo.all('message').some((m) => m.remindedAt && Date.parse(m.remindedAt) > f.at(D0, '13:00')));
  assert.deepEqual(records(f.db, f.company), before);
  const versions = () => JSON.stringify(f.sim.repo.all('planItem').map((i) => i.version));
  const v = versions();
  f.clock(D0, '18:00');
  f.pass();
  assert.equal(versions(), v, 'caught up: the next pass writes nothing');
});

test('an ask that is too late is not sent: "Not asked in time" instead (off overnight, back after the start time)', (t) => {
  const f = liveFixture(t, { now: zoneAt(DM1, '09:00', 'Australia/Sydney') });
  f.clock(DM1, '09:00');
  const w = f.cmd('planWorkers', { day: D0, time: '07:00', site: f.site.id, count: 1, people: [f.team.Jo.id] }).item;
  f.clock(DM1, '14:00');
  f.pass();
  // off from 2 pm yesterday until 8 am today: the 3 pm ask and the 7 am start both passed
  f.clock(D0, '08:00');
  f.pass();
  assert.equal(f.msgs(w.id).length, 0, 'nothing sent that late');
  const it = f.item(w.id);
  assert.equal(it.problem, "Not asked in time: Jo wasn't sent the ask. Call them.");
  assert.ok(it.log.some((l) => /^Not asked in time/.test(l.text)));
  assert.equal(it.people[0].notAsked, new Date(f.at(D0, '08:00')).toISOString());
});

test('Perth: a Perth company is asked at 3 pm Perth time and its day ends at 5 pm Perth time, on a Sydney server', (t) => {
  const f = liveFixture(t, { zone: 'Australia/Perth' });
  assert.equal(f.sim.clockZone(), 'Australia/Perth');
  const w = f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 1 }).item;
  // 3 pm in Sydney is noon in Perth (AEDT +11, AWST +8)
  f.setTime(atLocal(D0, '15:00'));
  f.pass();
  assert.equal(f.msgs(w.id).length, 0, 'not at 3 pm Sydney time');
  f.setTime(atLocal(D0, '17:59'));
  f.pass();
  assert.equal(f.msgs(w.id).length, 0, 'not at 2:59 pm Perth');
  f.setTime(atLocal(D0, '18:00'));
  f.pass();
  assert.equal(f.msgs(w.id)[0].status, 'SENT', '3 pm Perth = 6 pm Sydney');
  // the day: at 5 pm Sydney on D1 it is 2 pm in Perth, still on; at 8 pm Sydney it is 5 pm in Perth, over
  f.setTime(atLocal(D1, '17:00'));
  f.pass();
  assert.equal(f.item(w.id).stage, 'ASKING');
  f.setTime(atLocal(D1, '20:00'));
  f.pass();
  assert.equal(f.item(w.id).stage, 'UNCONFIRMED');
  // Today's calendar is Perth's: at 1 am Sydney it is still 10 pm the day before in Perth
  f.setTime(atLocal(addDays(D1, 1), '01:00'));
  assert.equal(f.sim.planNowCal().today, D1);
  assert.equal(f.sim.planNowCal().timeZone, 'Australia/Perth');
  assert.throws(
    () => f.cmd('planWorkers', { day: D1, time: '16:00', site: f.site.id, count: 1 }),
    /Today is nearly over/,
  );
  f.setTime(atLocal(addDays(D1, 1), '07:00')); // 4 am in Perth: before its 5 am planner day, bookable for 7 am
  f.cmd('planWorkers', { day: addDays(D1, 1), time: '07:00', site: f.site.id, count: 1 });
});
