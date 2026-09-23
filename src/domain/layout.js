import { integer,requireRule,rect,overlap,contains,fitsPolygon,route } from './geometry.js';
import { label } from './catalogue.js';
import { active } from './inventory.js';
import { solidFixture } from './fixtures.js';
const same=(p,q)=>p.x===q.x&&p.y===q.y&&p.rotation===q.rotation&&(p.support??null)===(q.support??null);
const metres=p=>(p.x/1000).toFixed(1)+', '+(p.y/1000).toFixed(1)+' m';
export const layoutMethods={
  keepClear(loc){return [{...(loc.loading??{x:0,y:0}),w:2000,h:1500,name:'loading zone'},...(loc.fixtures??[])];},
  fixtureObstacles(loc){const location=typeof loc==='string'?this.repo.get(loc):loc;return (location.fixtures??[]).filter(solidFixture).map(f=>({x:f.x,y:f.y,w:f.w,h:f.h}));},
  fixtures(input){const yard=this.repo.get(input.id,'yard');return this.reshape(yard,{segments:yard.segments,closed:true,fixtures:input.fixtures});},
  // A layout plan lists new positions for stillages already in the yard. Everything not listed stays where it is.
  layoutMoves(yard,input){
    requireRule(Array.isArray(input.moves)&&input.moves.length>0&&input.moves.length<=100,'Plan between 1 and 100 stillage moves.');
    const arriving=this.tasks().filter(t=>active(t)&&t.to===yard.id&&t.position).map(t=>({...this.repo.get(t.container,'container'),...t.position,id:t.container,arriving:true})).filter(c=>c.location!==yard.id);
    const stored=[...this.containers().filter(c=>c.location===yard.id),...arriving],byId=new Map(stored.map(c=>[c.id,c]));
    const resources=this.repo.all('resource');const seen=new Set();const moves=[];
    for(const m of input.moves){
      const c=byId.get(m?.container);requireRule(c,'Every planned stillage must be in this yard.');requireRule(!c.arriving,c.name+' is still arriving. Let it be placed first.');requireRule(!seen.has(c.id),c.name+' appears twice in the plan.');seen.add(c.id);
      const rotation=m.rotation??c.rotation;requireRule(rotation===0||rotation===90,'Rotation must be 0 or 90 degrees.');
      const support=m.support??null;requireRule(support===null||(byId.has(support)&&support!==c.id&&!byId.get(support).arriving),'The supporting stillage for '+c.name+' must be in this yard.');
      const to={x:integer(m.x,'Position x',-1000000),y:integer(m.y,'Position y',-1000000),rotation,support};
      if(to.x===c.x&&to.y===c.y&&to.rotation===c.rotation&&to.support===(c.support??null))continue;
      requireRule(c.condition==='SERVICEABLE',c.name+' is '+c.condition.toLowerCase()+'; only serviceable stillages can be moved.');
      requireRule(!this.tasks().some(t=>active(t)&&(t.container===c.id||t.sourceContainer===c.id||t.position?.support===c.id)),c.name+' already has a movement in progress.');
      requireRule(!resources.some(r=>r.cargo===c.id||r.drive?.container===c.id),c.name+' is on a forklift. Place it first.');
      this.assertCountFree(c);
      moves.push({container:c.id,name:c.name,from:{x:c.x,y:c.y,rotation:c.rotation,support:c.support??null},to});
    }
    requireRule(moves.length,'Nothing in this plan moves. Drag a stillage to a new spot first.');
    return {stored,byId,moves};
  },
  // Turns a plan into an ordered list of single forklift moves: pick only what is on top, place only where the spot (and the supporting stillage) is ready; deadlocked swaps and pile moves set one stillage down on clear ground first.
  sequenceLayout(yard,input){
    const {stored,byId,moves}=this.layoutMoves(yard,input);const moving=new Map(moves.map(m=>[m.container,m]));
    const at=c=>({x:c.x,y:c.y,rotation:c.rotation,support:c.support??null});const foot=(id,p)=>rect(byId.get(id),p);const zones=this.keepClear(yard),solids=this.fixtureObstacles(yard);
    const final=new Map(stored.map(c=>[c.id,moving.get(c.id)?.to??at(c)]));
    for(const c of stored)if(!moving.has(c.id)&&c.support&&moving.has(c.support))requireRule(false,c.name+' is stacked on '+byId.get(c.support).name+'. Move it with its pile or set it down first.');
    const level=(map,id)=>{let n=1,cur=map.get(id);const seen=new Set([id]);while(cur?.support){requireRule(!seen.has(cur.support),'The plan stacks stillages in a loop.');seen.add(cur.support);n++;cur=map.get(cur.support);}return n;};
    const height=(map,id)=>{let h=byId.get(id).height,cur=map.get(id);let n=0;while(cur?.support&&n++<9){h+=byId.get(cur.support).height;cur=map.get(cur.support);}return h;};
    for(const m of moves){const c=byId.get(m.container),r=foot(c.id,m.to);
      requireRule(fitsPolygon(r,yard.points),c.name+' would sit outside the yard boundary.');for(const z of zones)requireRule(!overlap(r,z),c.name+' would sit on the '+z.name.toLowerCase()+'.');
      if(m.to.support){const s=byId.get(m.to.support);requireRule(s.type===c.type,c.name+' can only stack on another '+c.type.toLowerCase()+'.');requireRule(contains(foot(s.id,final.get(s.id)),r),c.name+' must sit fully on '+s.name+'.');}
      requireRule(level(final,c.id)<=7,c.name+' would be more than 7 high.');requireRule(height(final,c.id)<=(yard.height??10000),c.name+' would exceed the yard storage height.');}
    for(const c of stored)if(c.support&&level(final,c.id)>7)requireRule(false,c.name+' would end up more than 7 high.');
    for(let i=0;i<stored.length;i++)for(let j=i+1;j<stored.length;j++){const a=stored[i],b=stored[j],pa=final.get(a.id),pb=final.get(b.id);if((pa.support??null)!==(pb.support??null))continue;requireRule(!overlap(foot(a.id,pa),foot(b.id,pb)),a.name+' and '+b.name+' would overlap.');}
    const work=new Map(stored.map(c=>[c.id,at(c)]));const pending=[...moves];const steps=[];
    const buried=id=>[...work].some(([,p])=>p.support===id);
    const blockers=(id,to)=>{const r=foot(id,to);return [...work].filter(([o,p])=>o!==id&&(p.support??null)===(to.support??null)&&overlap(foot(o,p),r)).map(([o])=>o);};
    const path=(id,from,to)=>{const c=byId.get(id),shape=rect(c,{x:0,y:0,rotation:from.rotation});shape.w=Math.max(1500,shape.w);shape.h=Math.max(1000,shape.h);const obstacles=[...[...work].filter(([o])=>o!==id&&o!==from.support&&o!==to.support).map(([o,p])=>foot(o,p)),...solids];return route({x:from.x,y:from.y},{x:to.x,y:to.y},shape,yard.points,obstacles);};
    let parks=0;
    while(pending.length){
      let progress=false;
      for(let i=0;i<pending.length;i++){const m=pending[i],cur=work.get(m.container);m.reason=null;
        if(buried(m.container)){m.reason='buried';continue;}
        if(m.to.support&&!same(work.get(m.to.support),final.get(m.to.support))){m.reason='support';continue;}
        if(blockers(m.container,m.to).length){m.reason='blocked';continue;}
        if(!path(m.container,cur,m.to)){m.reason='path';continue;}
        steps.push({container:m.container,name:m.name,from:cur,to:m.to,park:false});work.set(m.container,m.to);pending.splice(i,1);progress=true;break;}
      if(progress)continue;
      const candidates=pending.filter(m=>['support','blocked'].includes(m.reason));
      const inTheWay=m=>pending.some(o=>o!==m&&(work.get(m.container).support===o.container||blockers(o.container,o.to).includes(m.container)));
      const pick=candidates.find(inTheWay)??candidates[0];
      if(!pick||parks>=moves.length*2){const stuck=pending.find(m=>m.reason==='path')??pending[0];requireRule(false,stuck.reason==='path'?stuck.name+' has no clear forklift path to its new position. Leave a lane for the forklift and its load, or move fewer stillages at once.':stuck.name+' cannot be moved in this order. Simplify the plan and try again.');}
      const cur=work.get(pick.container),spot=this.parkingSpot(yard,byId.get(pick.container),cur,work,pending,foot,zones,path);
      requireRule(spot,'No clear ground to set '+pick.name+' down temporarily. Clear some space or plan fewer moves at once.');
      steps.push({container:pick.container,name:pick.name,from:cur,to:spot,park:true});work.set(pick.container,spot);parks++;}
    return steps;
  },
  parkingSpot(yard,c,cur,work,pending,foot,zones,path){
    const xs=yard.points.map(p=>p.x),ys=yard.points.map(p=>p.y),x0=Math.ceil(Math.min(...xs)/500)*500,y0=Math.ceil(Math.min(...ys)/500)*500,x1=Math.max(...xs),y1=Math.max(...ys);
    const finals=pending.map(m=>foot(m.container,m.to)),ground=[...work].filter(([o,p])=>o!==c.id&&(p.support??null)===null).map(([o,p])=>foot(o,p));
    const candidates=[];for(const rotation of [0,90])for(let y=y0;y<y1;y+=500)for(let x=x0;x<x1;x+=500){const p={x,y,rotation,support:null},r=foot(c.id,p);if(!fitsPolygon(r,yard.points)||zones.some(z=>overlap(r,z))||ground.some(o=>overlap(r,o))||finals.some(f=>overlap(r,f)))continue;candidates.push({p,d:Math.hypot(x-cur.x,y-cur.y)+(rotation===cur.rotation?0:1)});}
    candidates.sort((a,b)=>a.d-b.d);
    for(const {p} of candidates.slice(0,60))if(path(c.id,cur,p))return p;
    return null;
  },
  layoutPreview(input){
    this.auth.require(this.user,'operations.manage');const yard=this.repo.get(input.yard,'yard');
    try{const steps=this.sequenceLayout(yard,input);return {ok:true,steps,warnings:this.layoutWarnings(yard)};}
    catch(error){if(!error.status)throw error;return {ok:false,message:error.message,steps:[]};}
  },
  layoutWarnings(yard){const crew=this.repo.all('resource').filter(r=>r.enabled&&r.location===yard.id);const warnings=[];if(!crew.some(r=>r.type==='FORKLIFT'&&!r.driver&&!r.claimedBy))warnings.push('No free forklift at the yard: the instructions will wait until one is available.');if(!crew.some(r=>r.type==='WORKER'&&!r.mountedOn&&(!r.workerMode||r.workerMode==='AUTO')))warnings.push('No worker is on automatic work: return a worker to work so the instructions can start.');if(this.repo.all('config')[0]?.paused)warnings.push('The simulation is paused.');return warnings;},
  commitLayout(input){
    const yard=this.repo.get(input.yard,'yard');
    requireRule(!this.layouts().some(l=>l.status==='ACTIVE'&&l.yard===yard.id),'Finish or cancel the current layout plan before committing another.');
    const steps=this.sequenceLayout(yard,input);
    const layout=this.repo.add('layout',{name:label(input.name??'Layout plan '+new Date().toISOString().slice(0,16).replace('T',' '),'Plan name'),yard:yard.id,actor:this.user.id,createdAt:new Date().toISOString(),steps:[],status:'ACTIVE'});
    let previous=null;const tasks=[];
    steps.forEach((s,i)=>{const task=this.makeTask({type:'MOVE',container:s.container,from:yard.id,to:yard.id,handling:yard.id,position:{x:s.to.x,y:s.to.y,rotation:s.to.rotation,support:s.to.support},request:null,actor:this.user.id,state:'QUEUED',dependency:previous,layout:layout.id,step:i+1,park:s.park});previous=task.id;tasks.push(task);});
    layout.steps=steps.map((s,i)=>({...s,task:tasks[i].id}));this.repo.save(layout);
    this.repo.event(this.user.id,'LAYOUT_PLANNED',{destination:yard.id,quantity:steps.length,reason:layout.name+': '+steps.length+' step(s)',key:this.key});
    const message=steps.length+' instruction'+(steps.length===1?'':'s')+' sent to the yard crew.';this.notify('Layout plan committed',layout.name+': '+message,null);
    return {layout,tasks,warnings:this.layoutWarnings(yard),message};
  },
  cancelLayout(input){
    const layout=this.repo.get(input.id,'layout');requireRule(layout.status==='ACTIVE','This layout plan is already closed.');
    const tasks=layout.steps.map(s=>this.repo.get(s.task,'task'));let cancelled=0,kept=0;
    for(const t of [...tasks].reverse()){if(!active(t))continue;if(t.picked){kept++;continue;}this.cancel({id:t.id});cancelled++;}
    layout.status='CANCELLED';layout.cancelledAt=new Date().toISOString();this.repo.save(layout);
    return {layout,cancelled,kept,message:cancelled+' step(s) cancelled'+(kept?'; '+kept+' already on the forklift will be placed first':'')+'.'};
  },
  layouts(){
    return this.repo.all('layout').slice(-10).map(l=>{const steps=l.steps.map(s=>{let task=null;try{task=this.repo.get(s.task,'task');}catch{}return {...s,state:task?.state??'UNKNOWN',reason:task?.reason??null};});
      const status=l.status==='CANCELLED'?'CANCELLED':steps.every(s=>s.state==='COMPLETE')?'COMPLETE':steps.some(s=>s.state==='CANCELLED')&&!steps.some(s=>active({state:s.state}))?'STOPPED':'ACTIVE';
      return {...l,steps,status,done:steps.filter(s=>s.state==='COMPLETE').length};});
  }
};
