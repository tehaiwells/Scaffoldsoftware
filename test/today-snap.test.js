process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/domain/schedule.js';
import { planFixture, D0, L } from './helpers/plan-fixture.js';

// Phase 0, D10: a Today Materials list used to take any number and quietly send whole stillages on the day (50 became 114).
// Now the amount goes up to whole stillages when it is typed, as the board's amount box does, and the booking says what will go.
const D2 = addDays(D0, 2);

test('booking: a list for less than a stillage says at once what will really go', (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const { p, per } = f.stock(3);
  const site = f.site();
  const ask = Math.floor(per / 2);
  assert.ok(ask > 0 && ask < per);
  const r = f.cmd('planMaterials', { day: D2, site: site.id, lines: [{ product: p.id, quantity: ask }] });
  assert.ok(
    r.message.endsWith(
      ' You asked for ' + ask + ' ' + p.name + '. They come in stillages of ' + per + ', so ' + per + ' will go.',
    ),
    r.message,
  );
  // whole stillages: nothing more to say
  const exact = f.cmd('planMaterials', {
    day: addDays(D2, 1),
    site: site.id,
    lines: [{ product: p.id, quantity: per }],
  });
  assert.ok(!/You asked for/.test(exact.message), exact.message);
  // changing the list says it again
  const m = f.cmd('planMove', { id: exact.item.id, lines: [{ product: p.id, quantity: per + 1 }] });
  assert.match(m.message, new RegExp('You asked for ' + (per + 1) + ' .+ so ' + per * 2 + ' will go\\.'));
  // and on the day that is what goes
  f.clock(D2, '06:00');
  f.pass();
  assert.equal(f.item(r.item.id).got[p.id], per);
});

test('the planning picker: a typed amount goes up to whole stillages at once and the words say why; + and - still step one stillage', async (t) => {
  const f = planFixture(t, { now: L(D0, '09:00') });
  const { p, per } = f.stock(3);
  const { gmTest } = await import('../public/game.js');
  const pk = gmTest.planPick({ state: f.sim.snapshot(), lift: 1500000 });
  const ask = Math.floor(per / 2),
    h = pk.type(p.id, ask);
  assert.ok(
    h.includes('You asked for ' + ask + '. They come in stillages of ' + per + ', so ' + per + ' will go.'),
    'the snapped amount is said',
  );
  assert.ok(h.includes('value="' + per + '"'), 'the box shows what will go');
  assert.ok(h.includes('goes up to whole stillages'));
  assert.equal(pk.step(1), per * 2);
  assert.ok(!pk.html().includes('You asked for'), 'a step is already whole stillages');
  const h2 = pk.type(p.id, per * 2);
  assert.ok(!h2.includes('You asked for'));
  assert.deepEqual(pk.done(), [{ product: p.id, quantity: per * 2 }]);
});
