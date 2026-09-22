import { requireRule } from './geometry.js';
import { active } from './inventory.js';
const nextName=(names,prefix,pad=0)=>{let n=1;while(names.has(`${prefix}${String(n).padStart(pad,'0')}`))n++;return `${prefix}${String(n).padStart(pad,'0')}`;};
const idleWorker=r=>!r.task&&!r.walk&&!r.mountedOn&&!r.mountTarget&&r.workerMode!=='MOVING';
const idleForklift=r=>!r.task&&!r.driver&&!r.claimedBy&&!r.cargo&&!r.drive;
export const fleetMethods={
  quickAdjust(input){
    const yard=this.repo.get(input.location,'yard');requireRule([1,-1].includes(input.delta),'Choose +1 or -1.');
    const kind=input.kind;requireRule(['WORKER','FORKLIFT','TRUCK','STILLAGE'].includes(kind),'Choose workers, forklifts, trucks or stillages.');
    if(kind==='WORKER'||kind==='FORKLIFT'){
      const all=this.repo.all('resource').filter(r=>r.type===kind&&r.location===yard.id),live=all.filter(r=>r.enabled);
      if(input.delta===1){const name=nextName(new Set(live.map(r=>r.name)),kind==='WORKER'?'Worker ':'Forklift ');const template=live.find(r=>r.type==='FORKLIFT');return this.repo.add('resource',kind==='WORKER'?{name,type:'WORKER',location:yard.id,enabled:true,task:null}:{name,type:'FORKLIFT',location:yard.id,enabled:true,task:null,capacity:template?.capacity??1500000,reach:template?.reach??10000});}
      requireRule(live.length,`There are no ${kind==='WORKER'?'workers':'forklifts'} in this yard.`);const idle=live.filter(kind==='WORKER'?idleWorker:idleForklift);requireRule(idle.length,`Every ${kind==='WORKER'?'worker':'forklift'} is busy; wait for one to finish or stop it first.`);
      const r=idle.at(-1);r.enabled=false;r.retiredAt=new Date().toISOString();return this.repo.save(r);
    }
    if(kind==='TRUCK'){
      const trucks=this.repo.all('truck').filter(t=>t.yard===yard.id&&!t.retired);
      if(input.delta===1)return this.truck({name:nextName(new Set(this.repo.all('truck').map(t=>t.name)),'T-',2),yard:yard.id});
      requireRule(trucks.length,'There are no trucks for this yard.');
      const idle=trucks.filter(t=>t.status==='AT_YARD'&&t.at===yard.id&&!this.containers().some(c=>c.location===t.id)&&!this.tasks().some(x=>active(x)&&(x.to===t.id||x.from===t.id))&&!this.repo.all('request').some(r=>r.truck===t.id&&['ALLOCATED','PARTIALLY ALLOCATED'].includes(r.status))&&!this.repo.all('loadList').some(l=>l.truck===t.id&&!l.cancelled&&!l.delivery));
      requireRule(idle.length,'Every truck is loaded, away or planned for a trip; unload and finish its trip first.');const t=idle.at(-1);t.retired=true;t.status='RETIRED';t.retiredAt=new Date().toISOString();return this.repo.save(t);
    }
    const stillages=this.containers().filter(c=>c.location===yard.id&&c.type==='STILLAGE');
    if(input.delta===1){
      const name=nextName(new Set(this.repo.all('container').map(c=>c.name)),'S-',3),draft={type:'STILLAGE',length:2000,width:1000,height:1000,envelopeLength:2000,envelopeWidth:1000,rotation:0,support:null,tare:50000};
      let position;try{position=this.positionFor(draft,yard.id);}catch(error){requireRule(false,'No clear space in the yard for another stillage. Move or remove something first.');}
      return this.container({name,location:yard.id,...draft,x:position.x,y:position.y,rotation:position.rotation});
    }
    requireRule(stillages.length,'There are no stillages in this yard.');
    const empty=stillages.filter(c=>!this.repo.lines(c.id).length&&!this.containers().some(o=>o.support===c.id)&&!this.repo.all('resource').some(m=>m.cargo===c.id||m.drive?.container===c.id)&&!this.tasks().some(t=>active(t)&&(t.container===c.id||t.sourceContainer===c.id||t.position?.support===c.id))&&!this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===c.id||n.scope===c.location)));
    requireRule(empty.length,'Every stillage holds stock or is in use; empty one first.');const c=empty.at(-1);c.retired=true;c.retiredAt=new Date().toISOString();this.repo.save(c);this.repo.event(this.user.id,'CONTAINER_RETIRED',{container:c.id,source:c.location,reason:'Removed from the yard',key:this.key});return c;
  }
};
