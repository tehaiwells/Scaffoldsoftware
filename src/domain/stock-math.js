// @ts-check
// The one definition of "available" (ADR 0010, audit #4: the register said 416 where the Overview said 415). Pieces that can be sent:
// what is physically there, less what is held for something, less what is damaged or quarantined; never below zero. The Materials
// register, the stock-by-location blocks, the minimum-stock rule and every page that says "free" use this and nothing else.
/** @param {{quantity:number,reserved?:number|null,unserviceable?:number|null}} r */
export const availableOf = (r) => Math.max(0, r.quantity - (r.reserved ?? 0) - (r.unserviceable ?? 0));
/** Pieces in a balance line that cannot be sent (its container is not serviceable). @param {{quantity:number,condition?:string|null}} l */
export const unserviceableOf = (l) => (l.condition && l.condition !== 'SERVICEABLE' ? l.quantity : 0);
