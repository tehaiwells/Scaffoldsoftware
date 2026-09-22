import { requireRule } from './geometry.js';
import { active } from './inventory.js';
const states=['QUEUED','RESERVED','ASSIGNED','TRAVELLING_TO_PICKUP','PICKING','CARRYING','PLACING','COMPLETE'];
export const movementMethods={
  advance(task){
    if(!active(task)||task.state==='BLOCKED')return task;
    const c=this.repo.get(task.container,'container'),config=this.repo.all('config')[0]??{stepMs:700,speed:4000,craneWorkers:1};
    if(task.dependency){const dependency=this.repo.get(task.dependency,'task');requireRule(dependency.state!=='CANCELLED','The partial-pick task was cancelled.');if(dependency.state!=='COMPLETE')return task;}
    this.assertCountFree(c);
    if(task.state==='RESERVED'){
      // One machine route per handling area avoids intersecting moving loads in V1.
      if(this.tasks().some(other=>other.id!==task.id&&active(other)&&other.handling===task.handling&&other.resources.length))return task;
      const location=this.repo.get(task.handling),type=location.kind==='site'?'CRANE':'FORKLIFT';const resources=this.repo.all('resource').filter(r=>r.enabled&&!r.task&&!r.driver&&!r.claimedBy&&!r.mountedOn&&!r.walk&&(!r.workerMode||r.workerMode==='AUTO')&&r.location===location.id);const machine=resources.find(r=>r.type===type);requireRule(machine,`No ${type.toLowerCase()} is available.`);const workers=resources.filter(r=>r.type==='WORKER').slice(0,type==='CRANE'?config.craneWorkers:1);requireRule(workers.length===(type==='CRANE'?config.craneWorkers:1),'No operator / required workers are available.');
      const weight=this.projectedWeight(c);requireRule(weight<=machine.capacity,'Load exceeds the machine capacity.');requireRule(c.height<=machine.reach,'Load exceeds configured machine reach.');task.path=this.plannedPath(task,c);task.resources=[machine.id,...workers.map(r=>r.id)];task.machine=machine.id;for(const r of [machine,...workers]){r.task=task.id;this.repo.save(r);}
    }
    if(task.state==='PICKING'){
      requireRule(c.location===task.from,'Pickup location changed.');requireRule(!this.containers().some(o=>o.support===c.id),'Move the top stillage first.');
      if(task.type==='REPACK'){
        const source=this.repo.get(task.sourceContainer,'container');requireRule(source.location===task.from,'Partial-pick source moved.');this.assertCountFree(source);this.repo.balance(source.id,task.product,-task.quantity);this.repo.balance(c.id,task.product,task.quantity);for(const r of this.repo.all('reservation').filter(r=>r.task===task.id&&r.active)){r.active=false;this.repo.save(r);}const dependent=this.tasks().find(t=>active(t)&&t.dependency===task.id);if(dependent)this.repo.add('reservation',{container:c.id,product:task.product,quantity:task.quantity,task:dependent.id,active:true});this.repo.event(task.actor,'REPACK_PICKUP',{container:c.id,product:task.product,quantity:task.quantity,source:source.id,destination:task.machine,task:task.id,request:task.request,key:task.id+':pickup'});
      }else for(const l of this.repo.lines(c.id))this.repo.event(task.actor,'PICKUP',{container:c.id,product:l.product_id,quantity:l.quantity,source:c.location,destination:task.machine,task:task.id,request:task.request,key:task.id+':pickup'});
      c.location=task.machine;c.support=null;this.repo.save(c);task.picked=true;
    }
    if(task.state==='PLACING'){
      requireRule(c.location===task.machine,'Cargo is not on the assigned machine.');requireRule(task.resources.every(id=>this.repo.get(id,'resource').task===task.id),'The assigned resources changed.');this.validatePlacement(c,task.to,task.position);if(c.capacity!==null)requireRule(this.weight(c)<=c.capacity,'Container exceeds configured loaded capacity.');
      const source=c.location;c.location=task.to;Object.assign(c,task.position);c.sourceYard=c.sourceYard??(this.repo.get(task.from).kind==='yard'?task.from:null);c.placedAt=new Date().toISOString();const from=this.repo.get(task.from);c.delivery=from.kind==='truck'?from.delivery:c.delivery??null;this.repo.save(c);
      for(const l of this.repo.lines(c.id))this.repo.event(task.actor,'PLACEMENT',{container:c.id,product:l.product_id,quantity:l.quantity,source,destination:c.location,task:task.id,request:task.request,key:task.id+':place'});
      this.release(task);this.reconcileDeliveries();
    }
    task.state=states[states.indexOf(task.state)+1];task.reason=null;task.due=config.stepMs;
    if(task.state==='CARRYING'&&task.path){const distance=task.path.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-task.path[i].x,p.y-task.path[i].y),0);task.due=Math.max(config.stepMs,Math.round(distance/config.speed*1000));}
    this.repo.save(task);return task;
  },
  reconcileDeliveries(){
    for(const delivery of this.repo.all('delivery').filter(d=>d.status==='ARRIVED')){
      if(delivery.containers.every(id=>this.repo.get(id,'container').location===delivery.to)){delivery.status='DELIVERED';delivery.completedAt=new Date().toISOString();this.repo.save(delivery);this.notify('Delivery complete','Every container has been placed at its destination.',this.repo.get(delivery.to).kind==='site'?delivery.to:null);}
    }
    for(const request of this.repo.all('request').filter(r=>['ALLOCATED','PARTIALLY ALLOCATED','DELIVERED'].includes(r.status))){
      const relevant=this.tasks().filter(t=>t.request===request.id&&t.type==='MOVE'&&t.state!=='CANCELLED');const quantity=relevant.reduce((sum,t)=>{const c=this.repo.get(t.container,'container');return sum+(c.location===request.site?this.repo.quantity(c.id,request.product):0);},0);request.delivered=quantity;if(quantity===request.quantity)request.status='DELIVERED';else if(request.status==='DELIVERED'&&quantity===0)request.status='RETURNED';this.repo.save(request);
    }
  },
  tick(elapsed=250){
    const config=this.repo.all('config')[0];if(!config||config.paused)return;
    this.advanceWorkers(elapsed);
    this.advanceForklifts(elapsed);
    for(const truck of this.repo.all('truck').filter(t=>t.status==='IN_TRANSIT')){truck.remainingMs=Math.max(0,truck.remainingMs-elapsed);if(truck.remainingMs===0){const destination=this.repo.get(truck.destination);truck.at=destination.id;truck.status=destination.kind==='site'?'AT_SITE':'AT_YARD';truck.destination=null;const delivery=this.repo.get(truck.delivery,'delivery');delivery.status=delivery.containers.length?'ARRIVED':'DELIVERED';this.repo.save(delivery);this.notify('Truck arrived',`${truck.name} has arrived. Cargo stays on the truck until unloading.`,destination.kind==='site'?destination.id:null);}this.repo.save(truck);}
    for(let task of this.tasks().filter(t=>active(t)&&t.state!=='BLOCKED')){
      if(task.due>0){task.due=Math.max(0,task.due-elapsed);this.repo.save(task);continue;}
      this.db.exec('SAVEPOINT movement_step');
      try{this.advance(task);this.db.exec('RELEASE movement_step');}
      catch(error){this.db.exec('ROLLBACK TO movement_step');this.db.exec('RELEASE movement_step');task=this.repo.get(task.id,'task');task.resumeState=task.state;task.state='BLOCKED';task.reason=error.status?error.message:'Movement failed safely. Review the server log before retrying.';if(!error.status)console.error(JSON.stringify({event:'movement_error',task:task.id,message:error.message}));this.repo.save(task);}
    }
  }
};
