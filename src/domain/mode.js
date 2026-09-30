// @ts-check
// LIVE and DEMO (ADR 0001). Every company is one or the other from the day it is made, and never changes (a trigger in migration 007):
//   DEMO  the Practice yard: everything the simulation does, the engine ticks it, people answer by themselves.
//   LIVE  the real yard: nothing moves, completes or answers by itself. Only people's commands change it, and only the ones on LIVE_OPS (a
//         list of what is allowed, so a command added later is refused in LIVE until someone decides it records real work). The business
//         clock (clock.js) sends, reminds and flags; the ledger refuses engine rows for a LIVE company (migration 007 trigger).
import { AppError } from '../service.js';
import { cached } from '../database.js';
/** @typedef {'LIVE'|'DEMO'} CompanyMode */
/** @param {import('node:sqlite').DatabaseSync} db @param {string} company @returns {CompanyMode} */
export function companyMode(db, company) {
  return cached(db, 'SELECT mode FROM companies WHERE id=?').get(company)?.mode === 'LIVE' ? 'LIVE' : 'DEMO';
}
// What a real yard can do today: keep its records (catalogue, stock received, removed, opening stock and counts, stillages, sites, trucks and
// people as records, paperwork, hire rates, company details) and plan its days on Today, where the clock sends the asks. Everything that
// moves stock, drives a truck, runs the crew or answers for people is the simulation's, and stays in the Practice yard.
export const LIVE_OPS = new Set([
  // the yard, its layout records and the map
  'gameStart',
  'yard',
  'fixtures',
  'parking',
  'worldPlace',
  // the catalogue (never the synthetic demo list: 'seed')
  'product',
  'override',
  'importCatalogue',
  'gameCatalogue',
  'containerSettings',
  // stock, recorded by people
  'opening',
  'purchase',
  'stockIntake',
  'stockRemoval',
  'removeStock',
  'gameAddStock',
  'container',
  'condition',
  'scrapContainer',
  'quickAdjust',
  'retire',
  'count',
  'observe',
  'approveCount',
  'cancelCount',
  // sites and trucks as records
  'site',
  'gameSite',
  'siteDetails',
  'archive',
  'truck',
  // Today: bookings, asks and answers the office records; the team
  'planTruck',
  'planMaterials',
  'planWorkers',
  'planMove',
  'planCancel',
  'planAsk',
  'messageAnswer',
  'messageSeen',
  'teamAdd',
  'teamUpdate',
  'teamRemove',
  // paperwork, hire rates and company details
  'paperworkAdd',
  'paperworkUpdate',
  'paperworkRemove',
  'paperworkSettings',
  'hireRate',
  'hireSiteRate',
  'bdSaveDetails',
  'bdSaveLogo',
  'bdRemoveLogo',
]);
// Commands whose stock rows are brought in from before the app (opening balances): provenance IMPORT, still with the person who entered them.
export const IMPORT_OPS = new Set(['opening']);
export const COMING_NEXT =
  'Not in your real yard yet: this runs only in the Practice yard. Recording it for real comes next.';
/** Refused in a real yard (the simulation's own steps). @param {{live:()=>boolean}} sim @param {string} [message] */
export function requireDemo(sim, message = COMING_NEXT) {
  if (sim.live()) throw new AppError(409, message);
}
/** Only in a real yard. @param {{live:()=>boolean}} sim @param {string} [message] */
export function requireLive(sim, message = 'This is for your real yard only.') {
  if (!sim.live()) throw new AppError(409, message);
}
