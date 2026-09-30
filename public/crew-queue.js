// A driver's taps, kept until the server has them (ADR 0009, audit #5: "one key minted per tap, stored and resent"). Pure: the page gives it
// a place to keep text (localStorage) and a way to send (fetch); the tests give it fakes. Used by the crew page (public/crew.js).
//   tap(action, input)  a tap is stored at once, with its own idempotency key and the time of the tap (atSource 'tap'), before anything is sent
//   flush()             sends the stored taps in order, each with its own key, until one cannot be sent (offline, or the server is busy)
// A tap is dropped from the queue only when the server answered it: done (2xx), already done by someone else (409 ALREADY_CONFIRMED or ALREADY_DONE: quietly
// when they recorded the same, else kept in problems() with what the office recorded, so the driver sees the difference), or refused for good
// (another 4xx: kept in problems() for the driver to see). A lost answer is resent with the SAME key and input, so the server replays its
// first answer and the step is recorded once. A phone that is not signed in any more (401) keeps its taps: they go once it signs in again.
const KEY = 'sy-crew-taps',
  PROBLEMS = 'sy-crew-problems',
  SIGNED_OUT = 'sy-crew-signed-out';
/**
 * @typedef {{key:string,action:string,input:Record<string,any>,tappedAt:string,tries:number}} Tap
 * @typedef {{status:number,body:any}} Answer
 * @param {{get:(k:string)=>string|null,set:(k:string,v:string)=>void}} store
 * @param {(tap:Tap)=>Promise<Answer>} send  rejects when the request could not be made or its answer was lost
 * @param {{mintKey?:()=>string,now?:()=>number,onDone?:(tap:Tap,answer:Answer)=>void}} [options]
 */
export function createCrewQueue(store, send, { mintKey, now = () => Date.now(), onDone = () => {} } = {}) {
  const read = (/** @type {string} */ k) => {
    try {
      const v = JSON.parse(store.get(k) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (/** @type {string} */ k, /** @type {any[]} */ v) => {
    try {
      store.set(k, JSON.stringify(v));
    } catch {}
  };
  const mint =
    mintKey ??
    (() =>
      globalThis.crypto?.randomUUID?.() ??
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  let running = null;
  const queue = {
    /** @returns {Tap[]} */
    pending: () => read(KEY),
    problems: () => read(PROBLEMS),
    clearProblems: () => write(PROBLEMS, []),
    // true after the server said this phone is not signed in (the taps wait for a new link)
    signedOut: () => read(SIGNED_OUT).length > 0,
    signedIn: () => write(SIGNED_OUT, []),
    /** @param {string} action @param {Record<string,any>} input @returns {Tap} */
    tap(action, input) {
      const at = new Date(now()).toISOString();
      /** @type {Tap} */
      const t = {
        key: 'tap-' + mint(),
        action,
        input: input.at ? { ...input } : { ...input, at, atSource: 'tap' },
        tappedAt: at,
        tries: 0,
      };
      write(KEY, [...read(KEY), t]);
      return t;
    },
    // Sends what is waiting, oldest first. Returns how many were answered. Never two flushes at once.
    flush() {
      if (running) return running;
      running = (async () => {
        let answered = 0;
        try {
          for (;;) {
            const [t] = read(KEY);
            if (!t) break;
            let answer;
            try {
              t.tries++;
              write(KEY, [t, ...read(KEY).slice(1)]);
              answer = await send(t);
            } catch {
              break; // offline, or the answer was lost: the same tap (same key) goes again next time
            }
            if (answer.status >= 500 || answer.status === 429) break; // busy: try again later, same key
            if (answer.status === 401) {
              write(SIGNED_OUT, [now()]); // not signed in any more: every tap stays, to go after a new link
              break;
            }
            if (answer.status < 300) write(SIGNED_OUT, []);
            const rest = read(KEY).filter((x) => x.key !== t.key);
            write(KEY, rest);
            answered++;
            // a step someone else (a mate on the task, the office) already recorded: ALREADY_CONFIRMED on a trip, ALREADY_DONE on a task
            const already = answer.status === 409 && ['ALREADY_CONFIRMED', 'ALREADY_DONE'].includes(answer.body?.code);
            if (already && answer.body?.detail?.same === false)
              write(PROBLEMS, [
                ...read(PROBLEMS),
                { ...t, error: answer.body?.error ?? 'Already recorded.', status: 409, conflict: answer.body.detail },
              ]);
            else if (answer.status >= 400 && !already)
              write(PROBLEMS, [
                ...read(PROBLEMS),
                { ...t, error: answer.body?.error ?? 'Not recorded.', status: answer.status },
              ]);
            onDone(t, answer);
          }
        } finally {
          running = null;
        }
        return answered;
      })();
      return running;
    },
  };
  return queue;
}
// The fetch the crew page uses: one tap, its own key, its own input. Resolves with the answer; rejects when there was none.
/** @param {Tap} t */
export async function sendTap(t) {
  const r = await fetch('/api/crew/commands/' + t.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': t.key },
    body: JSON.stringify(t.input),
    credentials: 'same-origin',
  });
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
}
