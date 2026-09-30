// @ts-check
// The confirmation chain of a gear list (ADR 0012 §2.1): the steps in order for each direction, and the words the owner asked for. Pure:
// the real yard reads the marks from the trip's steps (trip_confirmation and trip_arrival), the Practice yard from the item's own chain
// (the engine's marks). Arrivals move nothing; the movement steps are the ones of ADR 0009.
//   OUT   yard -> site      Arrived at yard · Packed · Loaded · Arrived at site · Landed
//   MOVE  site A -> site B  Arrived at A · Loaded (collected at A) · Arrived at B · Landed
//   BACK  site -> yard      Arrived at site · Loaded (collected) · Arrived at yard · Back at yard
/** @typedef {'OUT'|'MOVE'|'BACK'} Direction */
/** @type {Record<Direction, string[]>} */
export const CHAIN_STEPS = {
  OUT: ['ARRIVED_PICKUP', 'PACKED', 'LOADED', 'ARRIVED_DROP', 'DELIVERED'],
  MOVE: ['ARRIVED_PICKUP', 'COLLECTED', 'ARRIVED_DROP', 'DELIVERED'],
  BACK: ['ARRIVED_PICKUP', 'COLLECTED', 'ARRIVED_DROP', 'RETURNED'],
};
/** The movement step that leaves the pickup place, and the one that sets down at the drop place. @type {Record<Direction,{out:string,in:string}>} */
export const CHAIN_MOVES = {
  OUT: { out: 'LOADED', in: 'DELIVERED' },
  MOVE: { out: 'COLLECTED', in: 'DELIVERED' },
  BACK: { out: 'COLLECTED', in: 'RETURNED' },
};
/**
 * The words of one step for one direction. from/to: the pickup and drop place names ('the yard', 'Bondi').
 * @param {Direction} direction @param {string} step @param {{from?:string,to?:string}} [names]
 */
export function chainWords(direction, step, { from = 'the yard', to = 'the site' } = {}) {
  const at = (place) => (place === 'the yard' ? 'Arrived at yard' : 'Arrived at ' + place);
  if (step === 'ARRIVED_PICKUP') return at(direction === 'OUT' ? 'the yard' : from);
  if (step === 'ARRIVED_DROP') return at(direction === 'BACK' ? 'the yard' : to);
  if (step === 'PACKED') return 'Packed';
  if (step === 'LOADED' || step === 'COLLECTED') return 'Loaded';
  if (step === 'DELIVERED') return 'Landed';
  if (step === 'RETURNED') return 'Back at yard';
  return step;
}
/**
 * The chain as a list of dots, in order: {step, words, done, at, byName, kind, onBehalfOf}.
 * @param {Direction} direction @param {Record<string,any>} marks the trip's steps or the item's chain @param {{from?:string,to?:string}} [names]
 */
export function chainOf(direction, marks, names) {
  const d = CHAIN_STEPS[direction] ? direction : 'OUT';
  return CHAIN_STEPS[d].map((step) => {
    const m = marks?.[step] ?? null;
    return {
      step,
      words: chainWords(d, step, names),
      done: !!m,
      at: m?.at ?? null,
      byName: m?.byName ?? null,
      kind: m?.kind ?? null,
      onBehalfOf: m?.onBehalfOf ?? null,
    };
  });
}
/** Which arrival is next on a trip, from its marks: 'ARRIVED_PICKUP' before it has left, 'ARRIVED_DROP' while the load is on the truck, else null. */
export function nextArrival(direction, marks) {
  const d = CHAIN_STEPS[direction] ? direction : 'OUT',
    mv = CHAIN_MOVES[d];
  if (marks?.RETURNED) return null; // back at the yard (delivered, or came back not delivered): no arrival is left
  if (!marks?.[mv.out]) return marks?.ARRIVED_PICKUP ? null : 'ARRIVED_PICKUP';
  if (!marks?.[mv.in]) return marks?.ARRIVED_DROP ? null : 'ARRIVED_DROP';
  return null;
}
