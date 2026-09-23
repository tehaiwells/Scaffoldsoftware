import { integer,requireRule,polygon,rect,overlap,contains,fitsPolygon } from './geometry.js';
import { label,nullable } from './catalogue.js';
import { fixtureList,solidFixture } from './fixtures.js';
export const active=t=>!['COMPLETE','CANCELLED','FAILED'].includes(t.state);
export const inventoryMethods={
  parking(input){
    const yard=this.repo.get(input.id,'yard');
    requireRule(['LEFT','RIGHT'].includes(input.side),'Choose the left or right side of the yard.');
    const vehicleLength=integer(input.vehicleLength,'Overall truck length',1000,30000),vehicleWidth=integer(input.vehicleWidth,'Overall truck width',1000,5000),clearance=integer(input.clearance,'Clearance on each side',0,10000);
    yard.parking={side:input.side,vehicleLength,vehicleWidth,clearance,length:vehicleLength+2*clearance,width:vehicleWidth+2*clearance};
    return this.repo.save(yard);
  },
  containerSettings(input){const c=this.repo.get(input.id,'container');this.assertFree(c);c.tare=nullable(input.tare,'Tare (g)');c.capacity=input.capacity===undefined?c.capacity:nullable(input.capacity,'Loaded capacity (g)');c.envelopeLength=integer(input.envelopeLength,'Loaded length',c.length);c.envelopeWidth=integer(input.envelopeWidth,'Loaded width',c.width);this.validatePlacement(c,c.location,c);this.repo.save(c);this.repo.event(this.user.id,'CONTAINER_SETTINGS',{container:c.id,reason:label(input.reason,'Reason'),key:this.key});return c;},
  yard(input){
    const old=input.id?this.repo.get(input.id,'yard'):null;
    if(old)return this.reshape(old,input);
    const geometry=polygon(input.segments,input.closed);const height=integer(input.height??10000,'Yard height',1,100000);
    const fit=p=>{integer(p.x,'Position x',-1000000);integer(p.y,'Position y',-1000000);requireRule(fitsPolygon({x:p.x,y:p.y,w:2000,h:1500},geometry.points),'Gate and loading position need a clear 2 m × 1.5 m footprint inside the yard.');return p;};
    const fixtures=fixtureList(input.fixtures??[],geometry.points),loading=fit(input.loading??{x:1000,y:1000});for(const f of fixtures)if(solidFixture(f))requireRule(!overlap(f,{...loading,w:2000,h:1500}),f.name+' overlaps the loading zone.');
    return this.repo.add('yard',{name:label(input.name),segments:input.segments,closed:true,...geometry,height,gate:fit(input.gate??{x:1000,y:1000}),loading,fixtures,mode:'DEMO ONLY'});
  },
  siteBoundary(input){const site=this.repo.get(input.id,'site');this.assertSite(site.id);requireRule(site.status==='ACTIVE','Choose an active site.');return this.reshape(site,input);},
  reshape(old,input){
    const geometry=polygon(input.segments,input.closed);const height=integer(input.height??old.height??10000,'Storage height',1,100000);const notes=[];
    const xs=geometry.points.map(q=>q.x),ys=geometry.points.map(q=>q.y),x0=Math.ceil(Math.min(...xs)),y0=Math.ceil(Math.min(...ys)),x1=Math.max(...xs),y1=Math.max(...ys);
    const fitPoint=(p,what,avoid)=>{integer(p.x,'Position x',-1000000);integer(p.y,'Position y',-1000000);const box=q=>({x:q.x,y:q.y,w:2000,h:1500});if(fitsPolygon(box(p),geometry.points)&&!avoid.some(o=>overlap(box(p),o)))return p;for(let y=y0+500;y<y1;y+=500)for(let x=x0+500;x<x1;x+=500){const q={x,y};if(fitsPolygon(box(q),geometry.points)&&!avoid.some(o=>overlap(box(q),o))){notes.push(what+' moved to '+(x/1000).toFixed(1)+' m, '+(y/1000).toFixed(1)+' m to stay inside the boundary');return q;}}requireRule(false,what+' needs a 2 m × 1.5 m footprint inside the boundary.');};
    const fixtures=fixtureList(input.fixtures??old.fixtures??[],geometry.points),solids=fixtures.filter(solidFixture);const loading=fitPoint(input.loading??old.loading??{x:1000,y:1000},'Loading zone',solids),gate=fitPoint(input.gate??old.gate??{x:1000,y:1000},'Gate',[{...loading,w:2000,h:1500},...solids]);for(const f of solids)requireRule(!overlap(f,{...loading,w:2000,h:1500}),f.name+' overlaps the loading zone. Move it first.');
    const value={name:label(input.name??old.name),segments:input.segments,closed:true,...geometry,height,gate,loading,fixtures};
    const loc=this.repo.save({...old,...value});
    const stored=this.containers().filter(c=>c.location===loc.id),zone={...loading,w:2000,h:1500};
    requireRule(stored.every(c=>c.height<=height),'Storage height is lower than a stored stillage. Raise the height or move stock first.');
    const stackHeight=c=>{let h=c.height,cur=c;while(cur?.support){cur=stored.find(o=>o.id===cur.support);h+=cur?.height??0;}return h;};
    const affected=new Set(stored.filter(c=>!fitsPolygon(rect(c),geometry.points)||overlap(rect(c),zone)||fixtures.some(f=>overlap(rect(c),f))||(c.support&&stackHeight(c)>height)).map(c=>c.id));
    let grew=true;while(grew){grew=false;for(const c of stored)if(c.support&&affected.has(c.support)&&!affected.has(c.id)){affected.add(c.id);grew=true;}}
    const level=c=>{let n=0,cur=c;while(cur?.support){n++;cur=stored.find(o=>o.id===cur.support);}return n;};const moved=[];
    const queue=stored.filter(c=>affected.has(c.id)).sort((a,b)=>level(b)-level(a));
    // Crew: stop manual jobs (cargo stays on the forks), release mount claims, keep everyone as an obstacle for relocation
    const resources=this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id);let stopped=0;
    for(const r of resources){let changed=false;if(r.walk||r.mountTarget){r.walk=null;this.releaseMount(r);r.workerMode='HOLD';r.workerReason='Boundary changed; give a new move order.';changed=true;stopped++;}if(r.drive){r.drive=null;r.manualReason='Boundary changed; give a new order.';changed=true;stopped++;}if(changed)this.repo.save(r);}
    const crew=resources.filter(r=>Number.isFinite(r.x)&&Number.isFinite(r.y)&&!r.mountedOn).map(r=>r.type==='FORKLIFT'?{x:r.x,y:r.y,...this.forkliftShape(r)}:{x:r.x,y:r.y,w:500,h:500});
    this.relocating=new Set(affected);
    try{
      for(const c of queue){requireRule(!this.tasks().some(t=>active(t)&&(t.container===c.id||t.sourceContainer===c.id)&&t.picked),c.name+' is on handling equipment. Let it be placed first.');this.assertCountFree(c);requireRule(!resources.some(m=>m.cargo===c.id),c.name+' is on a forklift. Place it first.');
        const was={x:c.x,y:c.y,rotation:c.rotation,support:c.support};const clear=p=>!crew.some(o=>overlap(rect(c,p),o));let position=null;try{const p=this.positionFor(c,loc.id);if(clear(p))position=p;}catch(error){if(/payload|unknown|stocktake/.test(error.message))throw error;}
        if(!position){scan:for(const rotation of [0,90])for(let y=y0;y<y1;y+=500)for(let x=x0;x<x1;x+=500){const candidate={x,y,rotation,support:null};if(!clear(candidate))continue;try{this.validatePlacement(c,loc.id,candidate);position=candidate;break scan;}catch(error){if(/payload|unknown|stocktake/.test(error.message))throw error;}}}
        requireRule(position,'The new boundary is too small for the stored stillages ('+c.name+' has no clear space). Enlarge it or move stock first.');
        c.x=position.x;c.y=position.y;c.rotation=position.rotation;c.support=null;c.placedAt=new Date().toISOString();this.repo.save(c);this.relocating.delete(c.id);
        this.repo.event(this.user.id,'RELOCATED',{container:c.id,source:loc.id,destination:loc.id,reason:'Boundary changed: moved from '+was.x+','+was.y+' r'+was.rotation+(was.support?' (unstacked)':'')+' to '+position.x+','+position.y+' r'+position.rotation,key:this.key});moved.push(c.name);}
    }finally{this.relocating=null;}
    // In-flight automatic movements: re-fit destinations and let unpicked tasks re-plan against the new geometry
    let replanned=0;for(const t of this.tasks().filter(t=>active(t)&&t.state!=='BLOCKED'&&(t.to===loc.id||t.from===loc.id||t.handling===loc.id))){const c=this.repo.get(t.container,'container');let changed=false;
      if(t.to===loc.id&&t.position&&!fitsPolygon(rect(c,t.position),geometry.points)){let position=null;try{position=this.positionFor(c,loc.id);}catch{}if(position){t.position={...position};changed=true;}else{t.resumeState=t.state;t.state='BLOCKED';t.reason='Boundary changed: no clear destination. Enlarge the area or move stock, then retry.';for(const r of this.repo.all('resource').filter(r=>r.task===t.id)){r.task=null;this.repo.save(r);}this.repo.save(t);replanned++;continue;}}
      if(!t.picked&&['ASSIGNED','TRAVELLING_TO_PICKUP'].includes(t.state)){for(const r of this.repo.all('resource').filter(r=>r.task===t.id)){r.task=null;this.repo.save(r);}t.state='RESERVED';t.resources=[];t.machine=null;t.path=null;t.due=0;changed=true;}
      if(changed){this.repo.save(t);replanned++;}}
    // Re-seat crew left outside or under relocated stock; a forklift's driver follows it
    const blocked=[...this.containers().filter(c=>c.location===loc.id).map(c=>rect(c)),...solids];
    for(const r of this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id&&['WORKER','FORKLIFT'].includes(r.type))){const footprint=r.type==='FORKLIFT'?{x:r.x,y:r.y,...this.forkliftShape(r)}:{x:r.x,y:r.y,w:500,h:500};
      if(Number.isFinite(r.x)&&(!fitsPolygon(footprint,geometry.points)||blocked.some(o=>overlap(footprint,o)))){r.x=null;r.y=null;if(r.type==='FORKLIFT'){const p=this.forkliftPosition(r);if(p){Object.assign(r,p);if(r.driver){const d=this.repo.get(r.driver,'resource');d.x=r.x+600;d.y=r.y+350;this.repo.save(d);}}}this.repo.save(r);}}
    if(moved.length)notes.unshift('Moved '+moved.length+' stillage(s) inside the new boundary: '+moved.join(', '));if(stopped)notes.push(stopped+' manual worker/forklift order(s) stopped');if(replanned)notes.push(replanned+' movement(s) re-planned');
    return {...loc,relocated:moved,message:notes.length?'Saved. '+notes.join('. ')+'.':'Saved.'};
  },
  containers(){return this.repo.all('container').filter(c=>!c.retired);},tasks(){return this.repo.all('task');},
  container(input){
    const location=this.repo.get(input.location);requireRule(['yard','site'].includes(location.kind),'Register containers at a yard or site.');this.assertSite(location.id);
    requireRule(['STILLAGE','RACK','CAGE','BUNDLE'].includes(input.type),'Choose a container type.');
    const data={name:label(input.name),type:input.type,model:input.model??'Company configured DEMO frame',length:integer(input.length,'Frame length',1),width:integer(input.width,'Frame width',1),height:integer(input.height,'Height',1),envelopeLength:integer(input.envelopeLength??input.length,'Loaded length',1),envelopeWidth:integer(input.envelopeWidth??input.width,'Loaded width',1),tare:nullable(input.tare,'Tare (g)'),capacity:nullable(input.capacity,'Capacity (g)'),location:location.id,x:integer(input.x,'X',-1000000),y:integer(input.y,'Y',-1000000),rotation:input.rotation??0,support:input.support??null,condition:'SERVICEABLE',mode:'DEMO ONLY'};
    requireRule(data.envelopeLength>=data.length&&data.envelopeWidth>=data.width,'Loaded envelope cannot be smaller than its frame.');
    this.validatePlacement(data,location.id,data);return this.repo.add('container',data);
  },
  weight(c,extra=[]){let total=c.tare;requireRule(total!==null,'Container tare weight is unknown. Configure it before moving.');for(const line of [...(c.id?this.repo.lines(c.id):[]),...extra]){const p=this.effective(line.product_id);requireRule(p.unitWeight!==null,`${p.name}: unit weight is unknown. Configure it before moving.`);total+=line.quantity*p.unitWeight;requireRule(Number.isSafeInteger(total),'Weight exceeds the supported exact range.');}return total;},
  occupied(location,exclude){const current=this.containers().filter(c=>c.location===location&&c.id!==exclude&&!this.relocating?.has(c.id));const ids=new Set(current.map(c=>c.id));for(const t of this.tasks().filter(t=>active(t)&&t.to===location&&t.container!==exclude)){if(!ids.has(t.container)){current.push({...this.repo.get(t.container,'container'),...t.position,id:t.container});ids.add(t.container);}}return current;},
  validatePlacement(c,destination,position,extra=[]){
    const loc=this.repo.get(destination);requireRule(['yard','site','truck'].includes(loc.kind),'Choose a storage destination.');this.assertSite(destination);
    requireRule(!this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===destination||n.scope===c.id)),'An active stocktake locks this destination.');
    integer(position.x,'Position x',-1000000);integer(position.y,'Position y',-1000000);const r=rect(c,position),others=this.occupied(destination,c.id);const support=position.support?others.find(o=>o.id===position.support):null;
    requireRule(!position.support||support,'The supporting container is not at this destination.');
    let level=1,height=c.height,ancestor=support;const seen=new Set([c.id]);while(ancestor){requireRule(!seen.has(ancestor.id),'Invalid support cycle.');seen.add(ancestor.id);level++;height+=ancestor.height;ancestor=ancestor.support?others.find(o=>o.id===ancestor.support):null;}
    if(support){requireRule(support.type===c.type,'Use compatible container supports.');requireRule(contains(rect(support),r),'An upper container must be fully supported.');requireRule(!this.tasks().some(t=>active(t)&&t.container===support.id),'Wait until the supporting container has been placed.');}
    const max=loc.kind==='truck'?loc.stackLimit:7;requireRule(level<=max,`Maximum ${max} containers high at this destination.`);requireRule(height<=(loc.height??10000),'The stack exceeds the configured height.');
    for(const other of others){const sameBase=(other.support??null)===(position.support??null);requireRule(!sameBase||!overlap(r,rect(other)),'The destination footprint overlaps another container or reservation.');}
    if(loc.kind==='truck'){
      requireRule(['AT_YARD','AT_SITE'].includes(loc.status),'Truck has departed or is not available for loading.');requireRule(contains({x:0,y:0,w:loc.length,h:loc.width},r),'The full loaded envelope does not fit on the truck deck.');
      const total=others.reduce((sum,o)=>sum+this.projectedWeight(o),0)+this.weight(c,extra);requireRule(total<=loc.payload,'Truck would exceed its configured payload.');
    }else{requireRule(loc.status!=='ARCHIVED','This site is archived.');requireRule(fitsPolygon(r,loc.points),'The entire footprint must fit inside the storage polygon.');requireRule(!overlap(r,{...loc.loading,w:2000,h:1500}),'Keep the loading position clear.');for(const f of loc.fixtures??[])requireRule(!overlap(r,f),'Keep the '+f.name.toLowerCase()+' clear.');}
    return {level,height};
  },
  projectedWeight(c){const repack=this.tasks().find(t=>active(t)&&t.type==='REPACK'&&t.container===c.id&&!t.picked);return this.weight(c,repack?[{product_id:repack.product,quantity:repack.quantity}]:[]);},
  assertFree(container,manualMachine=null){requireRule(!this.repo.all('resource').some(m=>m.id!==manualMachine&&(m.cargo===container.id||m.drive?.container===container.id)),'This stillage is assigned to a manual forklift.');requireRule(!this.containers().some(c=>c.support===container.id)&&!this.tasks().some(t=>active(t)&&t.position?.support===container.id),'Move the top stillage first.');requireRule(!this.tasks().some(t=>active(t)&&(t.container===container.id||t.sourceContainer===container.id)),'This container already has an active movement.');this.assertCountFree(container);},
  assertCountFree(c){requireRule(!this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===c.id||n.scope===c.location)),'An active stocktake locks this stock. Complete or cancel the count first.');},
  opening(input){return this.receiveStock(input,'OPENING_BALANCE');},
  count(input){const scope=this.repo.get(input.scope);requireRule(['container','yard','site'].includes(scope.kind),'Count a container, yard or site.');this.assertSite(scope.id);requireRule(!this.repo.all('resource').some(m=>m.cargo&&(m.location===scope.id||m.cargo===scope.id)||m.drive&&(m.location===scope.id||m.drive.container===scope.id)),'Finish manual forklift handling before starting this count.');const containers=this.containers().filter(c=>scope.kind==='container'?c.id===scope.id:c.location===scope.id);requireRule(containers.length,'There are no containers in this count scope.');for(const c of containers)this.assertFree(c);requireRule(!this.tasks().some(t=>active(t)&&t.to===scope.id),'An incoming task must finish before counting.');const lines=containers.flatMap(c=>this.repo.lines(c.id).map(l=>({...l,container:c.id,expected:l.quantity,observed:null})));return this.repo.add('count',{scope:scope.id,name:scope.name,state:'OPEN',lines,counter:this.user.id,createdAt:new Date().toISOString()});},
  observe(input){const count=this.repo.get(input.id,'count');requireRule(count.state==='OPEN','This count is closed.');this.assertSite(count.scope);requireRule(Array.isArray(input.observed)&&input.observed.length===count.lines.length,'Enter a count for every line.');count.lines=count.lines.map((l,i)=>({...l,observed:integer(input.observed[i],'Observed quantity',0,1000000)}));count.reason=label(input.reason,'Variance reason');count.counter=this.user.id;return this.repo.save(count);},
  approveCount(input){this.auth.require(this.user,'stock.adjust');const count=this.repo.get(input.id,'count');requireRule(count.state==='OPEN'&&count.lines.every(l=>l.observed!==null)&&count.reason,'Enter all counts and a reason first.');for(const l of count.lines){requireRule(this.repo.quantity(l.container,l.product_id)===l.expected,'Expected stock changed; cancel and restart the count.');const variance=l.observed-l.expected;this.repo.balance(l.container,l.product_id,variance);this.repo.event(this.user.id,'STOCKTAKE_ADJUSTMENT',{product:l.product_id,container:l.container,quantity:variance,source:count.scope,destination:count.scope,reason:count.reason,key:this.key});}count.state='APPROVED';count.approver=this.user.id;count.approvedAt=new Date().toISOString();return this.repo.save(count);},
  cancelCount(input){const count=this.repo.get(input.id,'count');requireRule(count.state==='OPEN','This count is closed.');this.assertSite(count.scope);count.state='CANCELLED';return this.repo.save(count);},
  condition(input){const c=this.repo.get(input.id,'container');this.assertFree(c);requireRule(['SERVICEABLE','DAMAGED','QUARANTINED'].includes(input.condition),'Choose a condition.');c.condition=input.condition;this.repo.save(c);this.repo.event(this.user.id,'CONDITION',{container:c.id,reason:label(input.reason,'Reason'),key:this.key});return c;}
};
