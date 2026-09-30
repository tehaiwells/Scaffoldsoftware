// What a browser gets from the server: the page, every stylesheet it links, and every module it loads, followed through the imports the way
// the browser's module loader does. (Replaces source-text checks that the server's asset list named each file.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';

async function serve(t) {
  const db = openDatabase(':memory:'),
    server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}

test('the page, its stylesheets and every module it imports (static and dynamic, all the way down) are served with the right types', async (t) => {
  const { base } = await serve(t);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/g)].map((m) => m[1]);
  assert.deepEqual(sheets, ['/style.css', '/design.css', '/game.css']);
  for (const href of sheets) {
    const r = await fetch(base + href);
    assert.equal(r.status, 200, href);
    assert.equal(r.headers.get('content-type'), 'text/css', href);
  }
  const queue = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]),
    seen = new Set();
  assert.deepEqual(queue, ['/app.js']);
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path + ' is served');
    assert.equal(r.headers.get('content-type'), 'text/javascript', path);
    const code = await r.text();
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]\.\/([\w-]+\.js)['"]/g)) queue.push('/' + m[1]);
  }
  for (const f of [
    '/app.js',
    '/operations.js',
    '/game.js',
    '/game-art.js',
    '/game-pick.js',
    '/game-finish.js',
    '/world.js',
    '/plan-cal.js',
  ])
    assert.ok(seen.has(f), f + ' is reached from the page');
  assert.equal((await fetch(base + '/game-nothing.js')).status, 404, "only the app's files are served");
});

test('the board asks the server for its stillages itself (/api/game-items), which needs a signed-in person', async (t) => {
  const { db, base } = await serve(t);
  assert.equal((await fetch(base + '/api/game-items?loc=x')).status, 401);
  const token = new Service(db).register({
    companyName: 'Served DEMO',
    name: 'Owner',
    email: 'served@example.test',
    password: 'a-long-test-password',
    systems: ['quickstage'],
  });
  const r = await fetch(base + '/api/game-items?loc=nowhere', { headers: { cookie: 'session=' + token } }),
    body = await r.json();
  assert.notEqual(body.error, 'Not found.', 'the route exists');
});
