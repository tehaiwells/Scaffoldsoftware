// Whole-stillage picking for the game board's Send and Bring back, shared by the browser (the amount slider's stops) and the server
// (src/domain/game.js chooses the same stillages). Pure: no DOM, no database.
// items: the stillages and cages at one place, [{id, name, support, lines: [[productId, quantity], ...], busy}]. A stillage can go when it is not busy
// and nothing stays stacked on it (loadTruck lifts the whole pile above a stillage, so a stillage is picked only once everything on it is picked).
// Order: tops first; single-product stillages before mixed ones; fuller ones first; then by name, so the browser and the server agree.
const byName = new Intl.Collator(undefined, { numeric: true }).compare;
export const gpQty = (c, product) => {
  let n = 0;
  for (const [p, q] of c.lines ?? []) if (p === product) n += q;
  return n;
};
function above(items) {
  const m = new Map();
  for (const c of items)
    if (c.support) {
      let l = m.get(c.support);
      if (!l) m.set(c.support, (l = []));
      l.push(c.id);
    }
  return m;
}
// Every stop of the slider for one product: after taking the 1st, 2nd, ... stillage, how many pieces of it are picked and which stillages go.
// taken: stillages already going for other lines (they free what is under them). Each stop lists only the stillages this product adds.
export function gpStops(items, product, taken = new Set(), max = 200) {
  const on = above(items),
    mine = new Set(),
    stops = [];
  let total = 0;
  const gone = (id) => taken.has(id) || mine.has(id);
  const clear = (c) => (on.get(c.id) ?? []).every(gone);
  for (let k = 0; k < max; k++) {
    let best = null,
      bq = 0;
    for (const c of items) {
      if (gone(c.id) || c.busy) continue;
      const q = gpQty(c, product);
      if (!q || !clear(c)) continue;
      if (
        !best ||
        (c.lines.length === 1) - (best.lines.length === 1) > 0 ||
        ((c.lines.length === 1) === (best.lines.length === 1) &&
          (q > bq || (q === bq && byName(c.name ?? c.id, best.name ?? best.id) < 0)))
      ) {
        best = c;
        bq = q;
      }
    }
    // nothing of it on top of a pile any more: take the one with the least stacked on it, and what is stacked on it rides along
    let ride = [];
    if (!best) {
      for (const c of items) {
        if (gone(c.id) || c.busy) continue;
        const q = gpQty(c, product);
        if (!q) continue;
        const up = [],
          todo = [...(on.get(c.id) ?? [])];
        let ok = true;
        while (todo.length) {
          const id = todo.shift();
          if (gone(id)) continue;
          const o = items.find((x) => x.id === id);
          if (!o || o.busy) {
            ok = false;
            break;
          }
          up.push(id);
          todo.push(...(on.get(id) ?? []));
        }
        if (ok && (!best || up.length < ride.length || (up.length === ride.length && q > bq))) {
          best = c;
          bq = q;
          ride = up;
        }
      }
    }
    if (!best) break;
    for (const id of ride) {
      mine.add(id);
      total += gpQty(
        items.find((x) => x.id === id),
        product,
      );
    }
    mine.add(best.id);
    total += bq;
    stops.push({ qty: total, ids: [...mine] });
  }
  return stops;
}
// The smallest stop that reaches the wanted amount (or everything there is); 0 = nothing.
export function gpSnap(stops, want) {
  if (!stops.length || !(want > 0)) return 0;
  for (const s of stops) if (s.qty >= want) return s.qty;
  return stops.at(-1).qty;
}
// The stillages for several lines [{product, quantity}] at one place: each line takes stops until it has its amount. Returns the stillages
// (top of each pile first, the order loadTruck wants them in), what each product got and the lines that came up short.
export function gpChoose(items, lines) {
  const taken = new Set(),
    got = new Map(),
    short = [];
  for (const line of lines ?? []) {
    const want = Math.max(0, Math.floor(Number(line.quantity) || 0));
    if (!want) continue;
    const stops = gpStops(items, line.product, taken);
    const stop = stops.find((s) => s.qty >= want) ?? stops.at(-1);
    if (stop) for (const id of stop.ids) taken.add(id);
    const have = stop?.qty ?? 0;
    got.set(line.product, (got.get(line.product) ?? 0) + have);
    if (have < want) short.push({ product: line.product, want, got: have });
  }
  const byId = new Map(items.map((c) => [c.id, c])),
    level = (c) => {
      let n = 0;
      for (let cur = c; cur?.support && byId.has(cur.support) && n < 20; cur = byId.get(cur.support)) n++;
      return n;
    };
  const ids = [...taken].sort(
    (a, b) => level(byId.get(b)) - level(byId.get(a)) || byName(byId.get(a).name ?? a, byId.get(b).name ?? b),
  );
  // what else rides along in mixed stillages
  const extra = new Map(),
    asked = new Set((lines ?? []).map((l) => l.product));
  for (const id of ids)
    for (const [p, q] of byId.get(id).lines ?? []) if (!asked.has(p)) extra.set(p, (extra.get(p) ?? 0) + q);
  return { ids, got, short, extra };
}
// Words for a load: a truck's weight against its payload (or its deck area) as Empty / A little / Half full / Nearly full / Full.
export function gpFill(frac) {
  if (!(frac > 0)) return 'Empty';
  if (frac < 0.3) return 'A little';
  if (frac < 0.65) return 'Half full';
  if (frac < 0.95) return 'Nearly full';
  return 'Full';
}
// Short counts for the inventory slots: 200, 1.2k, 12k, 1.2M.
export function gpCount(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n < 1000) return String(n);
  if (n < 1e4) return Math.floor(n / 100) / 10 + 'k';
  if (n < 1e6) return Math.floor(n / 1000) + 'k';
  return Math.floor(n / 1e5) / 10 + 'M';
}
// How many of a part go in one stillage (Add stock): one pack, or as many as the yard forklift and the site crane can lift when a pack is heavier
// than that (lift less the stillage's own 50 kg). 0 = the part cannot go in a stillage (no weight known, or one piece is already too heavy).
export function gpPerStillage(p, lift = 1500000, tare = 50000) {
  if (!(p?.unitWeight > 0)) return 0;
  const fit = Math.floor((lift - tare) / p.unitWeight);
  if (fit < 1) return 0;
  return p.packQuantity > 0 ? Math.min(p.packQuantity, fit) : fit;
}
