import { randomUUID } from 'node:crypto';
import { AppError } from './service.js';
export class Repository {
  constructor(db,company){this.db=db;this.company=company;}
  all(kind){return this.db.prepare('SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind=? ORDER BY rowid').all(this.company,kind).map(this.decode);}
  decode(row){return {...JSON.parse(row.data),id:row.id,kind:row.kind,version:row.version};}
  get(id,kind){if(typeof id!=='string')throw new AppError(400,'Choose a valid record.');const row=this.db.prepare('SELECT id,kind,data,version FROM objects WHERE company_id=? AND id=?').get(this.company,id);if(!row||kind&&row.kind!==kind)throw new AppError(404,'Record not found in your company.');return this.decode(row);}
  add(kind,data){const id=randomUUID();this.db.prepare('INSERT INTO objects(id,company_id,kind,data) VALUES(?,?,?,?)').run(id,this.company,kind,JSON.stringify(data));return this.get(id);}
  save(obj){const {id,kind,version,...data}=obj;const result=this.db.prepare('UPDATE objects SET data=?,version=version+1 WHERE company_id=? AND id=? AND version=?').run(JSON.stringify(data),this.company,id,version);if(result.changes!==1)throw new AppError(409,'This record changed. Refresh and try again.');obj.version++;return obj;}
  lines(container){return this.db.prepare('SELECT product_id,quantity FROM contents WHERE company_id=? AND container_id=? AND quantity>0 ORDER BY product_id').all(this.company,container);}
  quantity(container,product){return this.db.prepare('SELECT quantity FROM contents WHERE company_id=? AND container_id=? AND product_id=?').get(this.company,container,product)?.quantity??0;}
  balance(container,product,delta){this.get(container,'container');this.get(product,'product');const quantity=this.quantity(container,product)+delta;if(!Number.isSafeInteger(quantity)||quantity<0)throw new AppError(409,'Not enough material in this container.');this.db.prepare('INSERT INTO contents VALUES(?,?,?,?) ON CONFLICT(company_id,container_id,product_id) DO UPDATE SET quantity=excluded.quantity').run(this.company,container,product,quantity);}
  event(actor,event,details){this.db.prepare('INSERT INTO ledger(id,company_id,actor,event,product_id,container_id,quantity,source,destination,task_id,request_id,reason,command_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),this.company,actor,event,details.product??null,details.container??null,details.quantity??0,details.source??null,details.destination??null,details.task??null,details.request??null,details.reason??event,details.key??randomUUID(),new Date().toISOString());}
  remove(id,kind){return this.db.prepare('DELETE FROM objects WHERE company_id=? AND id=? AND kind=?').run(this.company,id,kind).changes;}
  history(limit=100,after=0){return this.db.prepare('SELECT * FROM ledger WHERE company_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(this.company,after,limit);}
}
