import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// node --test runs every *.test.js file in its own process, so a test file that imports another one also runs all of that file's tests again
// (31 files once did this with simulation.test.js: 2589 test runs instead of 543). Shared helpers live in plain modules such as fixture.js.
// Helpers are scanned too: fixture.js importing a test file would re-run it in every file that uses the fixture.
test('no test file or test helper imports a test file',()=>{const dir=new URL('./',import.meta.url);
  const bad=readdirSync(dir).filter(f=>f.endsWith('.js')).flatMap(f=>[...readFileSync(new URL(f,dir),'utf8').matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"]([^'"]*\.test\.js)['"]/g)].map(m=>`${f} imports ${m[1]}`));
  assert.deepEqual(bad,[]);});
