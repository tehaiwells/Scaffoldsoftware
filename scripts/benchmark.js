// Snapshot and history timings on a synthetic yard (in-memory database, DEMO data only).
//   node scripts/benchmark.js [--containers=500] [--ledger=10000] [--gate-ms=N]
// The yard, workers and site are made through the real commands (the old fixture put everything at a made-up
// location id, which the snapshot has refused since 06b45c7). --gate-ms turns it into a smoke check: it exits 1
// when the median snapshot takes longer than N ms, so CI notices when the page poll gets slow.
import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase, atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';
const arg = (name, d) => {
  const v = process.argv.find((a) => a.startsWith('--' + name + '='))?.split('=')[1];
  return v === undefined ? d : Number(v);
};
const CONTAINERS = arg('containers', 500),
  LEDGER = arg('ledger', 10000),
  WORKERS = 5,
  GATE = arg('gate-ms', null);
const db = openDatabase(':memory:'),
  auth = new Service(db),
  user = auth.authenticate(
    auth.register({
      name: 'Benchmark',
      email: randomUUID() + '@example.test',
      companyName: 'Synthetic benchmark',
      password: 'benchmark-password',
      systems: ['quickstage'],
    }),
  ),
  sim = new Simulation(db, user);
const cmd = (action, input = {}) => sim.execute(action, input, randomUUID());
const side = Math.max(40000, Math.ceil(Math.sqrt(CONTAINERS)) * 3000 + 8000);
const yard = cmd('yard', {
  name: 'Benchmark yard',
  segments: [
    { direction: 'RIGHT', length: side },
    { direction: 'DOWN', length: side },
    { direction: 'LEFT', length: side },
  ],
  closed: true,
});
cmd('resources', { location: yard.id, workers: WORKERS, machines: 1, stepMs: 100, speed: 100000, jobs: false });
atomic(db, () => {
  const product = sim.repo.add('product', { name: 'Benchmark only', system: 'quickstage', unitWeight: 5000 });
  sim.repo.add('packaging', { product: product.id, operatingQuantity: 100 });
  const per = Math.ceil(Math.sqrt(CONTAINERS));
  for (let i = 0; i < CONTAINERS; i++) {
    const c = sim.repo.add('container', {
      name: `Benchmark ${i}`,
      type: 'STILLAGE',
      location: yard.id,
      length: 2000,
      width: 1000,
      height: 1000,
      envelopeLength: 2000,
      envelopeWidth: 1000,
      tare: 50000,
      x: 4000 + (i % per) * 3000,
      y: 4000 + Math.floor(i / per) * 3000,
      condition: 'SERVICEABLE',
    });
    sim.repo.balance(c.id, product.id, 100);
  }
  for (let i = 0; i < LEDGER; i++)
    sim.repo.event(user.id, 'BENCHMARK', { quantity: 1, reason: 'Synthetic performance fixture' });
});
const sample = (fn) => {
  const values = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    fn();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { medianMs: Number(values[10].toFixed(2)), p95Ms: Number(values[19].toFixed(2)) };
};
const snapshot = sample(() => sim.snapshot());
const result = {
  machine: { os: platform() + ' ' + release(), cpu: cpus()[0]?.model, node: process.version },
  scenario: { containers: CONTAINERS, ledgerRecords: LEDGER, workers: WORKERS },
  snapshot,
  historyPage100: sample(() => sim.history()),
  snapshotBytes: Buffer.byteLength(JSON.stringify(sim.snapshot())),
  browserFPS: 'NOT MEASURED',
};
if (GATE !== null) result.gate = { medianSnapshotMs: GATE, passed: snapshot.medianMs <= GATE };
console.log(JSON.stringify(result, null, 2));
db.close();
if (GATE !== null && !result.gate.passed) {
  console.error(`Benchmark gate failed: median snapshot ${snapshot.medianMs} ms is over ${GATE} ms.`);
  process.exitCode = 1;
}
