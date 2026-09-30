import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OFFICE_TILES } from '../public/game.js';
import { squash } from './helpers/source.js';
// Part 5 (owner brief 30 September 2026): the Office drawer in the owner's order and words. The Schedule tile went (Daily activities'
// calendar does that; ?view=SCHEDULE opens Daily activities in both yards); Today is Daily activities; the Materials catalogue is the
// Gear list; Workers sits in Every day after it, with Task progress and Pre-start beside it; the Stock ledger sits in Yard and fleet after
// the small trucks and before the Control room.
const ops = squash(readFileSync(new URL('../public/operations.js', import.meta.url), 'utf8'));

test('the drawer reads as the owner drew it: Every day, Yard and fleet, Business', () => {
  const group = (g) => OFFICE_TILES.filter((x) => x[4] === g).map((x) => x[1]);
  assert.deepEqual(group('day'), [
    'Yard & sites',
    'Daily activities',
    'Gear list',
    'Workers',
    'Task progress',
    'Pre-start',
  ]);
  assert.deepEqual(group('yard'), [
    'Client sites',
    'Yard layout',
    'Equipment',
    'Big trucks',
    'Small trucks',
    'Stock ledger',
    'Control room',
  ]);
  assert.deepEqual(group('biz'), ['Hire', 'Reports', 'Overview']);
  assert.ok(!OFFICE_TILES.some((x) => x[0] === 'SCHEDULE'), 'no Schedule tile');
  const ids = Object.fromEntries(OFFICE_TILES.map((x) => [x[0], x[1]]));
  assert.deepEqual(
    [ids.TODAY, ids.MATERIALS, ids.PROGRESS, ids.PRESTART],
    ['Daily activities', 'Gear list', 'Task progress', 'Pre-start'],
    'the view ids stay (deep links)',
  );
  assert.deepEqual(
    OFFICE_TILES.filter((x) => ['PROGRESS', 'PRESTART'].includes(x[0])).map((x) => x[3]),
    ['hc-board', 'si-docket'],
    'existing art, no new sprites',
  );
});

test('the pages by name: NAV, the Office bar, the routing and the Schedule redirect', () => {
  assert.ok(ops.includes(squash("['TODAY', 'Daily activities']")));
  assert.ok(ops.includes(squash("['MATERIALS', 'Gear list']")));
  assert.ok(ops.includes(squash("['PROGRESS', 'Task progress']")) && ops.includes(squash("['PRESTART', 'Pre-start']")));
  assert.ok(!ops.includes(squash("['SCHEDULE', 'Schedule']")), 'Schedule is off the page list');
  assert.ok(
    !ops.includes(squash("'Materials list': 'Materials catalogue'")),
    'the Office bar no longer renames the Gear list',
  );
  assert.ok(
    ops.includes(squash("if (view === 'SCHEDULE') view = 'TODAY';")),
    'a Schedule link opens Daily activities in both yards',
  );
  assert.ok(
    ops.includes(squash("view === 'PROGRESS' ? tpView() : view === 'PRESTART' ? psView()")),
    'the two new pages render',
  );
  assert.ok(
    ops.includes(squash('<h1>Daily activities</h1>')) && ops.includes(squash('<h1>Gear list</h1>')),
    'the page titles',
  );
});
