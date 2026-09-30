// @ts-check
import { randomUUID } from 'node:crypto';
import { AppError } from './service.js';
import { cached } from './database.js';
import { applyLive } from './domain/live.js';
/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** A stored record: its JSON fields plus id, kind and an optimistic-lock version (bumped on every save).
 * @typedef {{id:string,kind:string,version:number,[field:string]:any}} StoredObject */
/** One product's quantity in one container. @typedef {{product_id:string,quantity:number}} ContentLine */
/** Optional fields of a ledger row (Repository.event). Quantities are whole pieces; key is the command's idempotency key.
 * @typedef {{product?:string|null,container?:string|null,quantity?:number,source?:string|null,destination?:string|null,task?:string|null,request?:string|null,reason?:string,key?:string}} LedgerDetails */
/** A row of the append-only ledger. @typedef {{sequence:number,id:string,company_id:string,actor:string,event:string,product_id:string|null,container_id:string|null,quantity:number,source:string|null,destination:string|null,task_id:string|null,request_id:string|null,reason:string,command_key:string,created_at:string}} LedgerRow */
// Kinds effectiveProducts() reads: every add/save/remove of one bumps the company's catalogue revision in the same transaction.
/** @type {Set<string>} */
export const CATALOGUE_KINDS=new Set(['product','packaging','productSettings']);
/** @param {Db} db @param {string} company @returns {string} */
export function catalogueRevision(db,company){const row=cached(db,"SELECT n,token FROM revisions WHERE company_id=? AND name='catalogue'").get(company);return row?row.n+'-'+row.token:'0';}
// Kinds the Today planner reads (src/domain/plan.js): every add/save/remove bumps the company's 'plan' revision, so the Today page refetches.
/** @type {Set<string>} */
export const PLAN_KINDS=new Set(['planItem','message','driver','paperwork','planSettings']);
/** @param {Db} db @param {string} company @param {string} name */
export function bumpRevision(db,company,name){cached(db,"INSERT INTO revisions(company_id,name,n,token) VALUES(?,?,1,?) ON CONFLICT(company_id,name) DO UPDATE SET n=n+1,token=excluded.token").run(company,name,randomUUID().slice(0,8));}
/** @param {Db} db @param {string} company @returns {string} */
export function planRevision(db,company){const row=cached(db,"SELECT n,token FROM revisions WHERE company_id=? AND name='plan'").get(company);return row?row.n+'-'+row.token:'0';}
const bump=(db,company)=>bumpRevision(db,company,'catalogue'),bumpKind=(db,company,kind)=>{if(CATALOGUE_KINDS.has(kind))bump(db,company);else if(PLAN_KINDS.has(kind))bumpRevision(db,company,'plan');};
/** @type {(product_id:string,quantity:number)=>ContentLine} */
const line=(product_id,quantity)=>{const l=Object.create(null);l.product_id=product_id;l.quantity=quantity;return l;};
export class Repository {
  /** @param {Db} db @param {string} company */
  constructor(db,company){this.db=db;this.company=company;
    /** @type {null|{kinds:Map<string,StoredObject[]>,ids:Map<string,StoredObject>,contents?:Map<string,ContentLine[]>}} */
    this.cache=null;}
  // this.cache (set only while Simulation.snapshot runs): each kind parsed once, ids and contents indexed, callers get shallow copies; any write drops it.
  /** Every record of one kind in this company, oldest first. @param {string} kind @returns {StoredObject[]} */
  all(kind){const c=this.cache;if(!c)return this.fetch(kind);let list=c.kinds.get(kind);if(!list){list=this.fetch(kind);c.kinds.set(kind,list);for(const o of list)c.ids.set(o.id,o);}return list.map(o=>({...o}));}
  /** @param {string} kind @returns {StoredObject[]} */
  fetch(kind){return cached(this.db,'SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind=? ORDER BY rowid').all(this.company,kind).map(row=>this.decode(row));}
  // Live movement the engine holds in memory for this row's version (src/domain/live.js) is applied, so every reader sees current positions.
  /** @param {{id:string,kind:string,data:string,version:number}} row @returns {StoredObject} */
  decode(row){return applyLive(this.db,{...JSON.parse(row.data),id:row.id,kind:row.kind,version:row.version});}
  /** One record of this company (404 when it is missing, belongs to another company or is another kind). @param {string} id @param {string} [kind] @returns {StoredObject} */
  get(id,kind){if(typeof id!=='string')throw new AppError(400,'Choose a valid record.');const c=this.cache;let obj=c?.ids.get(id);if(!obj){const row=cached(this.db,'SELECT id,kind,data,version FROM objects WHERE company_id=? AND id=?').get(this.company,id);if(!row)throw new AppError(404,'Record not found in your company.');obj=this.decode(row);if(c)c.ids.set(id,obj);}if(kind&&obj.kind!==kind)throw new AppError(404,'Record not found in your company.');return c?{...obj}:obj;}
  /** @param {string} kind @param {Record<string,any>} data @returns {StoredObject} */
  add(kind,data){this.cache=null;const id=randomUUID();cached(this.db,'INSERT INTO objects(id,company_id,kind,data) VALUES(?,?,?,?)').run(id,this.company,kind,JSON.stringify(data));bumpKind(this.db,this.company,kind);return this.get(id);}
  /** Saves a record read earlier; 409 when someone saved it in between. @param {StoredObject} obj @returns {StoredObject} */
  save(obj){this.cache=null;const {id,kind,version,...data}=obj;const row=cached(this.db,'UPDATE objects SET data=?,version=version+1 WHERE company_id=? AND id=? AND version=? RETURNING kind').get(JSON.stringify(data),this.company,id,version);if(!row)throw new AppError(409,'This record changed. Refresh and try again.');bumpKind(this.db,this.company,row.kind);obj.version++;return obj;}
  /** @returns {Map<string,ContentLine[]>} */
  contents(){const c=this.cache;if(!c.contents){c.contents=new Map();for(const r of cached(this.db,'SELECT container_id,product_id,quantity FROM contents WHERE company_id=? AND quantity>0 ORDER BY container_id,product_id').all(this.company)){let l=c.contents.get(r.container_id);if(!l)c.contents.set(r.container_id,l=[]);l.push(line(r.product_id,r.quantity));}}return c.contents;}
  /** @param {string} container @returns {ContentLine[]} */
  lines(container){if(this.cache)return (this.contents().get(container)??[]).map(l=>line(l.product_id,l.quantity));return cached(this.db,'SELECT product_id,quantity FROM contents WHERE company_id=? AND container_id=? AND quantity>0 ORDER BY product_id').all(this.company,container);}
  /** @param {string} container @param {string} product @returns {number} */
  quantity(container,product){if(this.cache)return this.contents().get(container)?.find(l=>l.product_id===product)?.quantity??0;return cached(this.db,'SELECT quantity FROM contents WHERE company_id=? AND container_id=? AND product_id=?').get(this.company,container,product)?.quantity??0;}
  /** Adds delta pieces (negative takes away); never below zero. @param {string} container @param {string} product @param {number} delta */
  balance(container,product,delta){this.cache=null;this.get(container,'container');this.get(product,'product');const quantity=this.quantity(container,product)+delta;if(!Number.isSafeInteger(quantity)||quantity<0)throw new AppError(409,'Not enough material in this container.');cached(this.db,'INSERT INTO contents VALUES(?,?,?,?) ON CONFLICT(company_id,container_id,product_id) DO UPDATE SET quantity=excluded.quantity').run(this.company,container,product,quantity);}
  /** Appends one ledger row. @param {string} actor @param {string} event @param {LedgerDetails} details */
  event(actor,event,details){cached(this.db,'INSERT INTO ledger(id,company_id,actor,event,product_id,container_id,quantity,source,destination,task_id,request_id,reason,command_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),this.company,actor,event,details.product??null,details.container??null,details.quantity??0,details.source??null,details.destination??null,details.task??null,details.request??null,details.reason??event,details.key??randomUUID(),new Date().toISOString());}
  /** @param {string} id @param {string} kind @returns {number|bigint} rows removed */
  remove(id,kind){this.cache=null;const changes=cached(this.db,'DELETE FROM objects WHERE company_id=? AND id=? AND kind=?').run(this.company,id,kind).changes;if(changes)bumpKind(this.db,this.company,kind);return changes;}
  /** @param {number} [limit] @param {number} [after] @returns {LedgerRow[]} */
  history(limit=100,after=0){return cached(this.db,'SELECT * FROM ledger WHERE company_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(this.company,after,limit);}
}
