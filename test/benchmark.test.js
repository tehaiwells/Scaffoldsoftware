// The benchmark scripts run (they crashed unnoticed from 06b45c7: the fixture put everything at a made-up location), and the gate fails loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const run=(script,args)=>spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',timeout:60000});

test('npm run benchmark: builds a real yard and reports snapshot and history times',()=>{
  const r=run('scripts/benchmark.js',['--containers=30','--ledger=100','--gate-ms=5000']);
  assert.equal(r.status,0,r.stderr);
  const out=JSON.parse(r.stdout);
  assert.deepEqual(out.scenario,{containers:30,ledgerRecords:100,workers:5});
  assert.ok(out.snapshot.medianMs>=0&&out.snapshot.p95Ms>=out.snapshot.medianMs);
  assert.ok(out.historyPage100.medianMs>=0);
  assert.ok(out.snapshotBytes>1000,'the snapshot holds the yard');
  assert.deepEqual(out.gate,{medianSnapshotMs:5000,passed:true});
});

test('npm run benchmark: a gate the snapshot cannot meet exits 1 with a plain reason',()=>{
  const r=run('scripts/benchmark.js',['--containers=5','--ledger=10','--gate-ms=0']);
  assert.equal(r.status,1);
  assert.match(r.stderr,/Benchmark gate failed: median snapshot [\d.]+ ms is over 0 ms\./);
});

test('npm run benchmark:movement: a short run finishes and counts the writes',()=>{
  const r=run('scripts/movement-writes.js',['--seconds=2','--warmup=1']);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/liveEntries/);
});
