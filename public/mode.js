// The real yard (LIVE) or the Practice yard (DEMO) on screen (ADR 0001): the chip in the top bar, what the Office offers, the honest "comes
// next" words, and the two big choices of the company switcher. The mode comes from /api/me (account.company.mode) and never changes for a
// company. Pure: no DOM at import (the board's tests import it in Node).
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** Is the signed-in company the real yard? @param {any} account */
export const isLive = (account) => account?.company?.mode === 'LIVE';
// Office places that only the simulation has (hand driving, the simulated schedule of loads and collections). The Workers page stays: in a
// real yard it is "Your team" only.
export const LIVE_HIDDEN_TILES = ['CONTROL', 'SCHEDULE'];
export const LIVE_CHIP =
  '<span class="gm-practice gm-live" title="Your real yard: it shows only what people record. Nothing moves or answers by itself.">Live<span class="gm-practice-yard"> &middot; your real yard</span></span>';
export const LIVE_NEXT =
  'Sending to a site and bringing back come next in your real yard. For now, add the stock you have and count it.';
export const LIVE_SITE_NEXT = 'Recording a delivery to this site comes next. It shows here once someone confirms it.';
// The Office pages of a real yard: what is not there yet, said once, calmly, where the simulation's controls are in the Practice yard.
export const LIVE_TRUCK_NEXT =
  'Loading a truck and sending it out come next in your real yard. For now it shows where it was last parked.';
export const LIVE_SITES_NEXT =
  'Site requests and yard lists come next in your real yard. To plan a delivery now, book Materials on Today.';
export const LIVE_CREW_NEXT =
  'Nobody signs on in the app yet, so nobody shows as at the yard or working. That comes next. Your people are on Workers, Your team.';
// The Office pages' strip under the title: the Practice yard keeps its simulation strip; the real yard says, calmly, what it is.
export const LIVE_STRIP =
  '<div class="simulation-banner live-banner"><span class="status-dot"></span> Live &middot; your real yard <span>Only what your team records. Nothing moves or answers by itself.</span></div>';
/** The words for one company in the switcher. @param {{id:string,name:string,mode?:string}} c */
export const companyWords = (c) =>
  c.mode === 'LIVE'
    ? { title: c.name, sub: 'Your real yard. Only what people record.' }
    : { title: 'Practice yard', sub: c.name + ' · simulated, to try things out' };
/** Two (or more) big choices, the Practice yard first, then the real yard. @param {any[]} memberships @param {string} current */
export function switchChoices(memberships, current) {
  const list = [...(memberships ?? [])].sort((a, b) => Number(a.mode === 'LIVE') - Number(b.mode === 'LIVE'));
  return (
    '<div class="sy-switch" role="group" aria-label="Choose a yard">' +
    list
      .map((c) => {
        const w = companyWords(c),
          here = c.id === current;
        return (
          '<button type="button" class="sy-choice' +
          (c.mode === 'LIVE' ? ' is-live' : ' is-practice') +
          (here ? ' current' : '') +
          '" data-sy-switch="' +
          esc(c.id) +
          '" data-sy-name="' +
          esc(w.title) +
          '"' +
          (here ? ' aria-current="true" disabled' : '') +
          '><span class="sy-dot" aria-hidden="true"></span><b>' +
          esc(w.title) +
          '</b><small>' +
          esc(here ? 'You are here' : w.sub) +
          '</small></button>'
        );
      })
      .join('') +
    '</div>'
  );
}
