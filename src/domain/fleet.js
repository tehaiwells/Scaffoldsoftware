import { requireRule } from './geometry.js';
import { active } from './inventory.js';
const nextName=(names,prefix,pad=0)=>{let n=1;while(names.has(`${prefix}${String(n).padStart(pad,'0')}`))n++;return `${prefix}${String(n).padStart(pad,'0')}`;};
export const idleWorker=r=>!r.task&&!r.walk&&!r.mountedOn&&!r.mountTarget&&r.workerMode!=='MOVING';
export const idleForklift=r=>!r.task&&!r.driver&&!r.claimedBy&&!r.cargo&&!r.drive;
export const fleetMethods={
  idleTruck(t){return t.status==='AT_YARD'&&!this.containers().some(c=>c.location===t.id)&&!this.tasks().some(x=>active(x)&&(x.to===t.id||x.from===t.id))&&!this.repo.all('request').some(r=>r.truck===t.id&&['ALLOCATED','PARTIALLY ALLOCATED'].includes(r.status))&&!this.repo.all('loadList').some(l=>l.truck===t.id&&!l.cancelled&&!l.delivery);},
  emptyContainer(c){return !this.repo.lines(c.id).length&&!this.containers().some(o=>o.support===c.id)&&!this.repo.all('resource').some(m=>m.cargo===c.id||m.drive?.container===c.id)&&!this.tasks().some(t=>active(t)&&(t.container===c.id||t.sourceContainer===c.id||t.position?.support===c.id))&&!this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===c.id||n.scope===c.location));},
  retireResource(r){requireRule(r.enabled&&['WORKER','FORKLIFT'].includes(r.type),'Choose a worker or forklift to remove.');requireRule(r.type==='WORKER'?idleWorker(r):idleForklift(r),r.type==='WORKER'?'This worker is busy. Stop them or wait for the task to finish first.':'This forklift is in use. Dismount and finish its job first.');r.enabled=false;r.retiredAt=new Date().toISOString();return this.repo.save(r);},
  retireTruck(t){requireRule(!t.retired,'This truck is already removed.');requireRule(this.idleTruck(t),'Unload the truck and finish or cancel its trip first.');t.retired=true;t.status='RETIRED';t.retiredAt=new Date().toISOString();return this.repo.save(t);},
  retireContainer(c){requireRule(!c.retired,'This stillage is already removed.');requireRule(['yard','site'].includes(this.repo.get(c.location).kind),'Unload it from the truck or forklift first.');requireRule(this.emptyContainer(c),'This stillage holds stock or is in use. Empty it first.');c.retired=true;c.retiredAt=new Date().toISOString();this.repo.save(c);this.repo.event(this.user.id,'CONTAINER_RETIRED',{container:c.id,source:c.location,reason:'Removed from storage',key:this.key});return c;},
  retire(input){const item=this.repo.get(input.id);if(item.kind==='resource')return this.retireResource(item);if(item.kind==='truck')return this.retireTruck(item);if(item.kind==='container')return this.retireContainer(item);requireRule(false,'Choose a worker, forklift, truck or stillage to remove.');},
  quickAdjust(input){
    const yard=this.repo.get(input.location,'yard');requireRule([1,-1].includes(input.delta),'Choose +1 or -1.');
    const kind=input.kind;requireRule(['WORKER','FORKLIFT','TRUCK','STILLAGE'].includes(kind),'Choose workers, forklifts, trucks or stillages.');
    if(kind==='WORKER'||kind==='FORKLIFT'){
      const live=this.repo.all('resource').filter(r=>r.type===kind&&r.location===yard.id&&r.enabled);
      if(input.delta===1){const name=nextName(new Set(live.map(r=>r.name)),kind==='WORKER'?'Worker ':'Forklift ');const template=live.find(r=>r.type==='FORKLIFT');return this.repo.add('resource',kind==='WORKER'?{name,type:'WORKER',location:yard.id,enabled:true,task:null}:{name,type:'FORKLIFT',location:yard.id,enabled:true,task:null,capacity:template?.capacity??1500000,reach:template?.reach??10000});}
      requireRule(live.length,`There are no ${kind==='WORKER'?'workers':'forklifts'} in this yard.`);const idle=live.filter(kind==='WORKER'?idleWorker:idleForklift);requireRule(idle.length,`Every ${kind==='WORKER'?'worker':'forklift'} is busy; wait for one to finish or stop it first.`);
      return this.retireResource(idle.at(-1));
    }
    if(kind==='TRUCK'){
      const trucks=this.repo.all('truck').filter(t=>t.yard===yard.id&&!t.retired);
      if(input.delta===1)return this.truck({name:nextName(new Set(this.repo.all('truck').map(t=>t.name)),'T-',2),yard:yard.id});
      requireRule(trucks.length,'There are no trucks for this yard.');const idle=trucks.filter(t=>t.at===yard.id&&this.idleTruck(t));
      requireRule(idle.length,'Every truck is loaded, away or planned for a trip; unload and finish its trip first.');return this.retireTruck(idle.at(-1));
    }
    const stillages=this.containers().filter(c=>c.location===yard.id&&c.type==='STILLAGE');
    if(input.delta===1){
      const name=nextName(new Set(this.repo.all('container').map(c=>c.name)),'S-',3),draft={type:'STILLAGE',length:2000,width:1000,height:1000,envelopeLength:2000,envelopeWidth:1000,rotation:0,support:null,tare:50000};
      let position;try{position=this.positionFor(draft,yard.id);}catch(error){requireRule(false,'No clear space in the yard for another stillage. Move or remove something first.');}
      return this.container({name,location:yard.id,...draft,x:position.x,y:position.y,rotation:position.rotation});
    }
    requireRule(stillages.length,'There are no stillages in this yard.');const empty=stillages.filter(c=>this.emptyContainer(c));
    requireRule(empty.length,'Every stillage holds stock or is in use; empty one first.');return this.retireContainer(empty.at(-1));
  }
};
