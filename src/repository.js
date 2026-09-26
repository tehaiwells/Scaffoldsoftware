import { randomUUID } from 'node:crypto';
import { AppError } from './service.js';
import { cached } from './database.js';
import { applyLive } from './domain/live.js';
// Kinds effectiveProducts() reads: every add/save/remove of one bumps the company's catalogue revision in the same transaction.
export const CATALOGUE_KINDS=new Set(['product','packaging','productSettings']);
export function catalogueRevision(db,company){const row=cached(db,"SELECT n,token FROM revisions WHERE company_id=? AND name='catalogue'").get(company);return row?row.n+'-'+row.token:'0';}
const bump=(db,company)=>cached(db,"INSERT INTO revisions(company_id,name,n,token) VALUES(?,'catalogue',1,?) ON CONFLICT(company_id,name) DO UPDATE SET n=n+1,token=excluded.token").run(company,randomUUID().slice(0,8));
const line=(product_id,quantity)=>{const l=Object.create(null);l.product_id=product_id;l.quantity=quantity;return l;};
export class Repository {
  constructor(db,company){this.db=db;this.company=company;this.cache=null;}
  // this.cache (set only while Simulation.snapshot runs): each kind parsed once, ids and contents indexed, callers get shallow copies; any write drops it.
  all(kind){const c=this.cache;if(!c)return this.fetch(kind);let list=c.kinds.get(kind);if(!list){list=this.fetch(kind);c.kinds.set(kind,list);for(const o of list)c.ids.set(o.id,o);}return list.map(o=>({...o}));}
  fetch(kind){return cached(this.db,'SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind=? ORDER BY rowid').all(this.company,kind).map(row=>this.decode(row));}
  // Live movement the engine holds in memory for this row's version (src/domain/live.js) is applied, so every reader sees current positions.
  decode(row){return applyLive(this.db,{...JSON.parse(row.data),id:row.id,kind:row.kind,version:row.version});}
  get(id,kind){if(typeof id!=='string')throw new AppError(400,'Choose a valid record.');const c=this.cache;let obj=c?.ids.get(id);if(!obj){const row=cached(this.db,'SELECT id,kind,data,version FROM objects WHERE company_id=? AND id=?').get(this.company,id);if(!row)throw new AppError(404,'Record not found in your company.');obj=this.decode(row);if(c)c.ids.set(id,obj);}if(kind&&obj.kind!==kind)throw new AppError(404,'Record not found in your company.');return c?{...obj}:obj;}
  add(kind,data){this.cache=null;const id=randomUUID();cached(this.db,'INSERT INTO objects(id,company_id,kind,data) VALUES(?,?,?,?)').run(id,this.company,kind,JSON.stringify(data));if(CATALOGUE_KINDS.has(kind))bump(this.db,this.company);return this.get(id);}
  save(obj){this.cache=null;const {id,kind,version,...data}=obj;const row=cached(this.db,'UPDATE objects SET data=?,version=version+1 WHERE company_id=? AND id=? AND version=? RETURNING kind').get(JSON.stringify(data),this.company,id,version);if(!row)throw new AppError(409,'This record changed. Refresh and try again.');if(CATALOGUE_KINDS.has(row.kind))bump(this.db,this.company);obj.version++;return obj;}
  contents(){const c=this.cache;if(!c.contents){c.contents=new Map();for(const r of cached(this.db,'SELECT container_id,product_id,quantity FROM contents WHERE company_id=? AND quantity>0 ORDER BY container_id,product_id').all(this.company)){let l=c.contents.get(r.container_id);if(!l)c.contents.set(r.container_id,l=[]);l.push(line(r.product_id,r.quantity));}}return c.contents;}
  lines(container){if(this.cache)return (this.contents().get(container)??[]).map(l=>line(l.product_id,l.quantity));return cached(this.db,'SELECT product_id,quantity FROM contents WHERE company_id=? AND container_id=? AND quantity>0 ORDER BY product_id').all(this.company,container);}
  quantity(container,product){if(this.cache)return this.contents().get(container)?.find(l=>l.product_id===product)?.quantity??0;return cached(this.db,'SELECT quantity FROM contents WHERE company_id=? AND container_id=? AND product_id=?').get(this.company,container,product)?.quantity??0;}
  balance(container,product,delta){this.cache=null;this.get(container,'container');this.get(product,'product');const quantity=this.quantity(container,product)+delta;if(!Number.isSafeInteger(quantity)||quantity<0)throw new AppError(409,'Not enough material in this container.');cached(this.db,'INSERT INTO contents VALUES(?,?,?,?) ON CONFLICT(company_id,container_id,product_id) DO UPDATE SET quantity=excluded.quantity').run(this.company,container,product,quantity);}
  event(actor,event,details){cached(this.db,'INSERT INTO ledger(id,company_id,actor,event,product_id,container_id,quantity,source,destination,task_id,request_id,reason,command_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),this.company,actor,event,details.product??null,details.container??null,details.quantity??0,details.source??null,details.destination??null,details.task??null,details.request??null,details.reason??event,details.key??randomUUID(),new Date().toISOString());}
  remove(id,kind){this.cache=null;const changes=cached(this.db,'DELETE FROM objects WHERE company_id=? AND id=? AND kind=?').run(this.company,id,kind).changes;if(changes&&CATALOGUE_KINDS.has(kind))bump(this.db,this.company);return changes;}
  history(limit=100,after=0){return cached(this.db,'SELECT * FROM ledger WHERE company_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(this.company,after,limit);}
}
