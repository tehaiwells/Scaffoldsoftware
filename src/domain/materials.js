import { integer,requireRule } from './geometry.js';
import { label } from './catalogue.js';
import { active } from './inventory.js';
import { cached } from '../database.js';
const LIST_EVENTS={additions:['OPENING_BALANCE','PURCHASE'],removals:['STOCK_REMOVED']};
export const materialsMethods={
  purgeDemo(){
    const demo=this.repo.all('product').filter(p=>p.verification==='DEMO ONLY'&&!p.retired);requireRule(demo.length,'There is no demonstration data left in this company.');const ids=new Set(demo.map(p=>p.id));
    requireRule(!this.repo.all('request').some(r=>ids.has(r.product)&&!['CANCELLED','DELIVERED','RETURNED'].includes(r.status)),'Cancel the open requests and yard lists for demonstration products first.');
    let pieces=0;for(const c of this.containers()){for(const line of this.repo.lines(c.id).filter(l=>ids.has(l.product_id))){this.assertFree(c);requireRule(!this.repo.all('reservation').some(r=>r.active&&r.container===c.id&&r.product===line.product_id),'Demonstration stock is reserved for a movement. Cancel it first.');this.repo.balance(c.id,line.product_id,-line.quantity);pieces+=line.quantity;this.repo.event(this.user.id,'DEMO_PURGED',{container:c.id,product:line.product_id,quantity:line.quantity,source:c.location,reason:'Demonstration stock removed',key:this.key});}}
    for(const p of demo){p.retired=true;p.retiredAt=new Date().toISOString();this.repo.save(p);}
    return {products:demo.length,pieces};
  },
  assertTruckTrip(truck,siteId){const open=this.repo.all('request').filter(r=>r.truck===truck.id&&['ALLOCATED','PARTIALLY ALLOCATED'].includes(r.status));requireRule(!open.some(r=>r.site!==siteId),'One destination per truck trip.');const tripTasks=this.tasks().filter(t=>t.type==='MOVE'&&t.state!=='CANCELLED'&&open.some(r=>r.id===t.request));requireRule(!this.containers().some(c=>c.location===truck.id&&!tripTasks.some(t=>t.container===c.id)),'Unload the truck before planning a new trip.');},
  receiveStock(input,event){const c=this.repo.get(input.container,'container');this.assertFree(c);const p=this.effective(input.product);requireRule(cached(this.db,'SELECT enabled FROM company_systems WHERE company_id=? AND system_id=?').get(this.user.company_id,p.system)?.enabled,'Enable this system before adding new stock.');const quantity=integer(input.quantity,'Quantity',1,1000000),reason=label(input.reason,'Reason');requireRule(c.location&&this.repo.get(c.location).kind!=='truck','Stock must be received into storage, not onto a truck.');this.repo.balance(c.id,p.id,quantity);if(c.capacity!==null&&p.unitWeight!==null)requireRule(this.weight(c)<=c.capacity,'Container exceeds its configured loaded capacity.');this.repo.event(this.user.id,event,{container:c.id,product:p.id,quantity,destination:c.location,reason:input.supplier?`${reason} · ${label(input.supplier,'Supplier')}`:reason,key:this.key});return c;},
  purchase(input){return this.receiveStock(input,'PURCHASE');},
  stockIntake(input){
    const yard=this.repo.get(input.location,'yard');const p=this.effective(input.product);requireRule(cached(this.db,'SELECT enabled FROM company_systems WHERE company_id=? AND system_id=?').get(this.user.company_id,p.system)?.enabled,'Enable this system before adding new stock.');requireRule(!p.retired,'This product has been removed from the catalogue.');
    const event=input.kind==='ORIGINAL'?'OPENING_BALANCE':'PURCHASE';const reason=label(input.reason??(event==='PURCHASE'?'Purchased stock':'Original stock on hand'),'Reason');
    let left=integer(input.quantity,'Quantity',1,1000000);const pack=p.packQuantity??null;
    const room=c=>{const held=this.repo.quantity(c.id,p.id);let r=Infinity;if(pack!==null)r=Math.min(r,pack-held);if(c.capacity!==null&&p.unitWeight!==null){let w=null;try{w=this.weight(c);}catch{return 0;}r=Math.min(r,Math.floor((c.capacity-w)/p.unitWeight));}return Math.max(0,r);};
    const usable=c=>{if(c.type!=='STILLAGE'||c.condition!=='SERVICEABLE')return false;const lines=this.repo.lines(c.id);if(lines.length&&(lines.length>1||lines[0].product_id!==p.id))return false;try{this.assertFree(c);}catch{return false;}return room(c)>0;};
    const put=(c,quantity)=>{this.repo.balance(c.id,p.id,quantity);this.repo.event(this.user.id,event,{container:c.id,product:p.id,quantity,destination:yard.id,reason,key:this.key});};
    const filled=[];
    for(const c of this.containers().filter(c=>c.location===yard.id).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))){if(!left)break;if(!usable(c))continue;const quantity=Math.min(left,room(c));if(!quantity)continue;put(c,quantity);filled.push({container:c.id,name:c.name,quantity,created:false,stackedOn:null});left-=quantity;}
    let created=0;
    while(left>0){requireRule(created<50,'Too many stillages needed for one intake. Add the material in smaller batches.');const c=this.stackStillage(yard);const quantity=Math.min(left,room(c));requireRule(quantity>0,'A new stillage cannot hold this product. Check its pack size and weight.');put(c,quantity);filled.push({container:c.id,name:c.name,quantity,created:true,stackedOn:c.support?this.repo.get(c.support,'container').name:null});left-=quantity;created++;}
    const parts=filled.map(f=>f.name+' ('+f.quantity+(f.created?(f.stackedOn?', new · stacked on '+f.stackedOn:', new'):'')+')');
    return {product:p.id,filled,message:input.quantity+' × '+p.name+' → '+parts.join(', ')};
  },
  stackStillage(yard){
    const stored=this.containers().filter(c=>c.location===yard.id),name=(()=>{const names=new Set(this.repo.all('container').map(c=>c.name));let n=1;while(names.has('S-'+String(n).padStart(3,'0')))n++;return 'S-'+String(n).padStart(3,'0');})();
    const draft={type:'STILLAGE',length:2000,width:1000,height:1000,envelopeLength:2000,envelopeWidth:1000,tare:50000};
    const tops=stored.filter(c=>c.type==='STILLAGE'&&!stored.some(o=>o.support===c.id)).map(top=>{let level=1,h=top.height,cur=top;while(cur.support){cur=stored.find(o=>o.id===cur.support);if(!cur)break;level++;h+=cur.height;}return {top,level,h};}).filter(s=>s.level<7&&s.h+draft.height<=(yard.height??10000)).sort((a,b)=>a.level-b.level||a.top.name.localeCompare(b.top.name,undefined,{numeric:true}));
    for(const s of tops){const position={x:s.top.x,y:s.top.y,rotation:s.top.rotation,support:s.top.id};try{this.validatePlacement({...draft,rotation:position.rotation,support:position.support},yard.id,position);return this.container({name,location:yard.id,...draft,x:position.x,y:position.y,rotation:position.rotation,support:position.support});}catch(error){if(/payload|unknown|stocktake/.test(error.message))throw error;}}
    let position=null;try{position=this.positionFor({...draft,rotation:0,support:null},yard.id);}catch(error){if(/payload|unknown|stocktake/.test(error.message))throw error;}
    requireRule(position,'No clear space in the yard for another stillage. Enlarge the yard or move stock first.');
    return this.container({name,location:yard.id,...draft,x:position.x,y:position.y,rotation:position.rotation});
  },
  removeStock(input){
    const c=this.repo.get(input.container,'container');this.assertSite(c.location);const location=this.repo.get(c.location);
    requireRule(['yard','site'].includes(location.kind),'Stock can only be removed from a yard or site, not from a truck or handling equipment.');
    this.assertFree(c);const p=this.repo.get(input.product,'product');
    const quantity=integer(input.quantity,'Quantity',1,1000000),reason=label(input.reason,'Removal reason');
    const held=this.repo.quantity(c.id,p.id),reserved=this.repo.all('reservation').filter(r=>r.active&&r.container===c.id&&r.product===p.id).reduce((s,r)=>s+r.quantity,0);
    requireRule(held>0,'This container does not hold that product.');requireRule(quantity<=held-reserved,`Only ${held-reserved} unreserved pieces are available to remove.`);
    this.repo.balance(c.id,p.id,-quantity);this.repo.event(this.user.id,'STOCK_REMOVED',{container:c.id,product:p.id,quantity,source:c.location,reason,key:this.key});return c;
  },
  // Stockpile-style removal from the yard: takes from the highest, most recently added stillages that can be reached; reserved, counted, buried and in-transit stock stays.
  stockRemoval(input){
    const yard=this.repo.get(input.location,'yard');const p=this.repo.get(input.product,'product');let left=integer(input.quantity,'Quantity',1,1000000);const reason=label(input.reason??'Removed from the yard','Removal reason');
    const stored=this.containers().filter(c=>c.location===yard.id),reservations=this.repo.all('reservation').filter(r=>r.active);
    const level=c=>{let n=0,cur=c;while(cur?.support&&n<9){n++;cur=stored.find(o=>o.id===cur.support);}return n;};
    const holders=stored.filter(c=>this.repo.quantity(c.id,p.id)>0).map(c=>{let free=true;try{this.assertFree(c);}catch{free=false;}const held=this.repo.quantity(c.id,p.id),reserved=reservations.filter(r=>r.container===c.id&&r.product===p.id).reduce((s,r)=>s+r.quantity,0);return {c,held,available:free?Math.max(0,held-reserved):0};});
    const held=holders.reduce((s,x)=>s+x.held,0),total=holders.reduce((s,x)=>s+x.available,0);
    requireRule(held>0,'There is no '+p.name+' in the yard.');
    requireRule(total>=left,total?'Only '+total+' × '+p.name+' can be taken out right now; the other '+(held-total)+' are reserved, under a stocktake, on a forklift or buried in a pile.':'None of the '+held+' × '+p.name+' in the yard can be taken out right now: they are reserved, under a stocktake, on a forklift or buried in a pile.');
    const taken=[];for(const x of holders.filter(x=>x.available>0).sort((a,b)=>level(b.c)-level(a.c)||b.c.name.localeCompare(a.c.name,undefined,{numeric:true}))){if(!left)break;const quantity=Math.min(left,x.available);this.repo.balance(x.c.id,p.id,-quantity);this.repo.event(this.user.id,'STOCK_REMOVED',{container:x.c.id,product:p.id,quantity,source:yard.id,reason,key:this.key});taken.push({container:x.c.id,name:x.c.name,quantity,emptied:!this.repo.lines(x.c.id).length});left-=quantity;}
    return {product:p.id,taken,message:input.quantity+' × '+p.name+' taken out of '+taken.map(t=>t.name+' ('+t.quantity+(t.emptied?', now empty':'')+')').join(', ')};
  },
  // Stock per yard / site / truck for the Overview page, from every container (not the paged 100); stock on a forklift or crane counts at that machine's yard or site.
  stockByLocation(balances,containers,products){
    const byProduct=new Map(products.map(p=>[p.id,p])),place=new Map();
    const placeOf=id=>{if(!place.has(id)){let p=id;try{const o=this.repo.get(id);if(o.kind==='resource')p=o.location;}catch{}place.set(id,p);}return place.get(id);};
    const blocks=new Map();const block=id=>{let b=blocks.get(id);if(!b){b={pieces:0,reserved:0,unserviceable:0,containers:new Set(),rows:new Map()};blocks.set(id,b);}return b;};
    for(const c of containers)block(placeOf(c.location)).containers.add(c.id);
    for(const l of balances){const b=block(placeOf(l.location));const row=b.rows.get(l.product_id)??{product:l.product_id,quantity:0,reserved:0,unserviceable:0,containers:new Set()};const bad=l.condition==='SERVICEABLE'?0:l.quantity;row.quantity+=l.quantity;row.reserved+=l.reserved;row.unserviceable+=bad;row.containers.add(l.container);b.rows.set(l.product_id,row);b.pieces+=l.quantity;b.reserved+=l.reserved;b.unserviceable+=bad;}
    const out={};for(const [id,b] of blocks)out[id]={pieces:b.pieces,reserved:b.reserved,unserviceable:b.unserviceable,containers:b.containers.size,rows:[...b.rows.values()].map(r=>{const p=byProduct.get(r.product);return {product:r.product,name:p?.name??'Unknown product',category:p?.category??null,unitWeight:p?.unitWeight??null,quantity:r.quantity,reserved:r.reserved,unserviceable:r.unserviceable,free:Math.max(0,r.quantity-r.reserved-r.unserviceable),containers:r.containers.size};}).sort((a,b)=>a.name.localeCompare(b.name))};
    return out;
  },
  register(balances,products){
    const rows=new Map(),kinds=new Map();
    const kindOf=id=>{if(kinds.has(id))return kinds.get(id);let kind='other';try{const o=this.repo.get(id);kind=o.kind==='resource'?kindOf(o.location):o.kind;}catch{}kinds.set(id,kind);return kind;};
    for(const l of balances){const kind=kindOf(l.location);const row=rows.get(l.product_id)??{product:l.product_id,quantity:0,reserved:0,yard:0,site:0,truck:0,containers:0};row.quantity+=l.quantity;row.reserved+=l.reserved;row[kind]=(row[kind]??0)+l.quantity;row.containers++;rows.set(l.product_id,row);}
    const byId=new Map();for(const p of products)if(!byId.has(p.id))byId.set(p.id,p);return [...rows.values()].map(r=>{const p=byId.get(r.product);return {...r,name:p?.name??'Unknown product',system:p?.system??null,category:p?.category??null,unitWeight:p?.unitWeight??null,available:r.quantity-r.reserved};}).sort((a,b)=>a.name.localeCompare(b.name));
  },
  stockLog(kind,limit=100,products=null){integer(limit,'Page size',1,1000);const events=LIST_EVENTS[kind];requireRule(events,'Choose additions or removals.');const scoped=this.auth.permissions(this.user).includes('operations.manage');const retired=new Set((products??this.repo.all('product')).filter(p=>p.retired).map(p=>p.id));const rows=cached(this.db,`SELECT * FROM ledger WHERE company_id=? AND event IN (${events.map(()=>'?').join(',')}) ORDER BY sequence DESC LIMIT ?`).all(this.user.company_id,...events,limit).filter(l=>!retired.has(l.product_id));return scoped?rows:rows.filter(l=>this.siteVisible(l.source??l.destination));},
  // assertSite(id) as a yes/no for a user without operations.manage, without building an error per refused row.
  siteVisible(id){const find=x=>{if(typeof x!=='string')return null;try{return this.repo.get(x);}catch{return null;}};const object=find(id);if(!object)return false;const site=object.kind==='container'?find(object.location):object.kind==='truck'?find(object.at):object;return !!site&&site.kind==='site'&&site.supervisor===this.user.id;},
  createLoadList(input){
    const site=this.repo.get(input.site,'site');this.assertSite(site.id);requireRule(site.status==='ACTIVE','Choose an active site.');
    requireRule(Array.isArray(input.lines)&&input.lines.length>0&&input.lines.length<=50,'Add between 1 and 50 lines to the yard list.');
    const seen=new Set();for(const line of input.lines){requireRule(typeof line?.product==='string'&&!seen.has(line.product),'Each product may appear once per yard list; combine the quantities.');seen.add(line.product);}
    const requests=input.lines.map(line=>this.request({site:site.id,product:line.product,quantity:line.quantity,notes:input.notes??''}));
    const list=this.repo.add('loadList',{name:label(input.name??`Yard list ${new Date().toISOString().slice(0,10)}`,'Yard list name'),site:site.id,truck:null,notes:input.notes??'',lines:requests.map(r=>({product:r.product,quantity:r.quantity,request:r.id})),actor:this.user.id,createdAt:new Date().toISOString(),cancelled:false});
    for(const r of requests){r.loadList=list.id;this.repo.save(r);}
    return list;
  },
  allocateLoadList(input){
    const list=this.repo.get(input.id,'loadList');requireRule(!list.cancelled,'This yard list is cancelled.');const truck=this.repo.get(input.truck,'truck');requireRule(truck.status==='AT_YARD','Truck must be at the yard.');requireRule(!list.truck||list.truck===truck.id,'This yard list is already loading on another truck.');requireRule(list.lines.some(l=>this.repo.get(l.request,'request').status==='REQUESTED'),'Every line on this yard list is already planned or closed.');this.assertTruckTrip(truck,list.site);
    const outcome=[];
    for(const line of list.lines){const request=this.repo.get(line.request,'request');if(request.status!=='REQUESTED'){outcome.push({product:line.product,status:request.status,reason:null,unchanged:true});continue;}
      this.db.exec('SAVEPOINT yard_list_line');
      try{this.allocate({id:request.id,truck:truck.id});this.db.exec('RELEASE yard_list_line');outcome.push({product:line.product,status:'ALLOCATED',reason:null});}
      catch(error){this.db.exec('ROLLBACK TO yard_list_line');this.db.exec('RELEASE yard_list_line');if(!error.status)throw error;outcome.push({product:line.product,status:'SHORT',reason:error.message});}
    }
    requireRule(outcome.some(o=>o.status==='ALLOCATED'),outcome.find(o=>o.reason)?.reason??'Nothing on this yard list could be reserved.');
    const fresh=this.repo.get(list.id,'loadList');fresh.truck=truck.id;fresh.lines=fresh.lines.map(l=>({...l,lastReason:outcome.find(o=>o.product===l.product)?.reason??null}));this.repo.save(fresh);
    return {list:fresh,outcome};
  },
  cancelLoadList(input){
    const list=this.repo.get(input.id,'loadList');this.assertSite(list.site);requireRule(!list.cancelled,'This yard list is already cancelled.');const reason=label(input.reason,'Cancellation reason');
    for(const line of list.lines){const request=this.repo.get(line.request,'request');if(!['CANCELLED','DELIVERED','RETURNED'].includes(request.status))this.cancelRequest({id:request.id,reason,fromList:true});}
    list.cancelled=true;list.cancelReason=reason;const saved=this.repo.save(list);this.releaseTruck(list.truck);return saved;
  },
  loadListView(list){
    const truck=list.truck?this.repo.get(list.truck,'truck'):null;
    const lines=list.lines.map(line=>{const request=this.repo.get(line.request,'request');const moves=this.tasks().filter(t=>t.request===request.id&&t.type==='MOVE');const onTruck=truck?moves.reduce((s,t)=>{const c=this.repo.get(t.container,'container');return s+(c.location===truck.id?this.repo.quantity(c.id,line.product):0);},0):0;const product=this.repo.get(line.product,'product');return {...line,name:product.name,status:request.status,reserved:request.allocated,loaded:onTruck,sent:line.sent??(list.delivery?Math.max(onTruck,request.delivered):null),delivered:request.delivered};});
    const statuses=lines.map(l=>l.status);const every=s=>statuses.every(x=>x===s),some=s=>statuses.some(x=>x===s);
    const delivery=list.delivery?this.repo.get(list.delivery,'delivery'):null;
    const status=list.cancelled?'CANCELLED':every('DELIVERED')?'DELIVERED':delivery&&delivery.status==='IN_TRANSIT'?'IN_TRANSIT':delivery?(delivery.status==='DELIVERED'&&statuses.every(s=>['DELIVERED','REQUESTED','CANCELLED'].includes(s))?'DELIVERED':'AT_SITE'):lines.every(l=>l.status==='REQUESTED')?'OPEN':lines.every(l=>['ALLOCATED','DELIVERED'].includes(l.status))?(lines.every(l=>l.loaded>=l.quantity||l.status==='DELIVERED')?'LOADED':'RESERVED'):some('ALLOCATED')||some('PARTIALLY ALLOCATED')?'PARTIAL':every('CANCELLED')?'CANCELLED':'OPEN';
    return {...list,lines,status,truckName:truck?.name??null,deliveryStatus:delivery?.status??null,short:lines.filter(l=>l.status==='REQUESTED').length,requested:lines.reduce((s,l)=>s+l.quantity,0),loaded:lines.reduce((s,l)=>s+l.loaded,0),delivered:lines.reduce((s,l)=>s+l.delivered,0)};
  },
  loadLists(){const operations=this.auth.permissions(this.user).includes('operations.manage');return this.repo.all('loadList').filter(l=>operations||this.siteVisible(l.site)).map(l=>this.loadListView(l));},
  manifest(deliveryId){return this.loadLists().filter(l=>l.delivery===deliveryId);}
};
