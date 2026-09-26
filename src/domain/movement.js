import { requireRule } from './geometry.js';
import { active,spotProblem } from './inventory.js';
import { rect,contains } from './geometry.js';
import { skillOn } from './jobs.js';
const states=['QUEUED','RESERVED','ASSIGNED','TRAVELLING_TO_PICKUP','PICKING','CARRYING','PLACING','COMPLETE'];
export const movementMethods={
  advance(task){
    if(!active(task)||task.state==='BLOCKED')return task;
    const c=this.repo.get(task.container,'container'),config=this.repo.all('config')[0]??{stepMs:700,speed:4000,craneWorkers:1};
    if(task.dependency){const dependency=this.repo.get(task.dependency,'task');requireRule(dependency.state!=='CANCELLED','The step this movement depends on was cancelled.');if(dependency.state!=='COMPLETE')return task;}
    this.assertCountFree(c);
    // Before anything is lifted: the destination must still fit the location's current shape (a boundary, loading zone or fixture change may cover it).
    // A stack destination: the stillage it goes on must still stand there under it (a boundary save may have moved it) and the stack must fit the height.
    if(['RESERVED','PICKING'].includes(task.state)&&!task.picked&&task.position){const to=this.repo.get(task.to);if(to.kind!=='truck'){const problem=spotProblem(rect(c,task.position),to);requireRule(!problem,problem);}
      const s=task.position.support?this.repo.get(task.position.support,'container'):null;if(s&&!this.tasks().some(t=>active(t)&&t.container===s.id)){requireRule(s.location===task.to&&!s.retired&&contains(rect(s),rect(c,task.position)),'The stillage '+c.name+' was to go on ('+s.name+') is no longer under that spot. Cancel this movement and plan again.');let h=c.height,cur=s,n=0;while(cur&&n++<9){h+=cur.height;cur=cur.support?this.repo.get(cur.support,'container'):null;}requireRule(h<=(to.height??10000),'The stack exceeds the configured height.');}}
    if(task.state==='RESERVED'){
      // One machine route per handling area avoids intersecting moving loads in V1.
      if(this.tasks().some(other=>other.id!==task.id&&active(other)&&other.handling===task.handling&&other.resources.length))return task;
      const location=this.repo.get(task.handling),type=location.kind==='site'?'CRANE':'FORKLIFT';const info=this.taskInfo(task),needed=type==='CRANE'?config.craneWorkers:1;const pool=this.repo.all('resource').filter(r=>r.enabled&&!r.task&&!r.driver&&!r.claimedBy&&!r.mountedOn&&r.location===location.id);const machine=pool.find(r=>r.type===type&&!r.walk);requireRule(machine,`No ${type.toLowerCase()} is available.`);const cand=pool.filter(r=>r.type==='WORKER'&&!r.mountTarget&&(!r.workerMode||r.workerMode==='AUTO')&&(!r.walk||r.walk.job)&&skillOn(r,info.skill));const jobOf=r=>{if(!r.job)return null;try{return this.repo.get(r.job,'job');}catch{return null;}};const rank=j=>!j||j.origin==='ROUTINE'?9:j.priority;const free=cand.filter(r=>!r.job&&!r.walk),onJobs=cand.filter(r=>r.job||r.walk).map(r=>({r,j:jobOf(r)})).filter(x=>rank(x.j)>=info.priority).sort((a,b)=>rank(b.j)-rank(a.j)).map(x=>x.r);const workers=[...free,...onJobs].slice(0,needed);if(workers.length<needed){if(cand.length>=needed){task.reason='Waiting for a worker – the '+info.skill.toLowerCase()+'-skilled workers are on higher-priority jobs';this.repo.save(task);return task;}const freeAuto=this.repo.all('resource').filter(r=>r.enabled&&r.type==='WORKER'&&r.location===location.id&&!r.task&&!r.mountedOn&&!r.mountTarget&&(!r.walk||r.walk.job)&&(!r.workerMode||r.workerMode==='AUTO'));requireRule(false,freeAuto.length&&!freeAuto.some(r=>skillOn(r,info.skill))?'No worker with the '+({TRUCK:'truck operations',YARD:'yard organisation',HANDLING:'material handling'}[info.skill])+' skill is available.':'No operator / required workers are available.');}for(const r of workers)if(r.job||r.walk)this.releaseJob(r,'Needed for '+info.title);
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
      const source=c.location,was={x:c.x,y:c.y,rotation:c.rotation??0};c.location=task.to;Object.assign(c,task.position);c.turnedFrom=task.turn&&!task.layout?{...was,after:{x:c.x,y:c.y,rotation:c.rotation}}:null;if(task.turn&&was.rotation!==(c.rotation??0))this.repo.event(task.actor,'TURNED',{container:c.id,source:task.to,destination:task.to,task:task.id,reason:'Turned 90°: '+was.x+','+was.y+' r'+was.rotation+' to '+c.x+','+c.y+' r'+c.rotation,key:task.id+':turned'});c.sourceYard=c.sourceYard??(this.repo.get(task.from).kind==='yard'?task.from:null);c.placedAt=new Date().toISOString();const from=this.repo.get(task.from);c.delivery=from.kind==='truck'?from.delivery:c.delivery??null;this.repo.save(c);
      for(const l of this.repo.lines(c.id))this.repo.event(task.actor,'PLACEMENT',{container:c.id,product:l.product_id,quantity:l.quantity,source,destination:c.location,task:task.id,request:task.request,key:task.id+':place'});
      this.release(task);this.reconcileDeliveries();if(from.kind==='truck')this.releaseTruck(from.id);
    }
    task.state=states[states.indexOf(task.state)+1];task.reason=null;task.due=config.stepMs;
    if(task.state==='CARRYING'&&task.path){const distance=task.path.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-task.path[i].x,p.y-task.path[i].y),0);task.due=Math.max(config.stepMs,Math.round(distance/config.speed*1000));}
    this.repo.save(task);return task;
  },
  reconcileDeliveries(){
    for(const delivery of this.repo.all('delivery').filter(d=>d.status==='ARRIVED')){
      if(delivery.containers.every(id=>{const c=this.repo.get(id,'container');return c.location===delivery.to||c.delivery===delivery.id;})){delivery.status='DELIVERED';delivery.completedAt=new Date().toISOString();this.repo.save(delivery);this.notify('Delivery complete','Every container has been placed at its destination.',this.repo.get(delivery.to).kind==='site'?delivery.to:null);}
    }
    for(const request of this.repo.all('request').filter(r=>['ALLOCATED','PARTIALLY ALLOCATED','DELIVERED'].includes(r.status))){
      const relevant=this.tasks().filter(t=>t.request===request.id&&t.type==='MOVE'&&t.state!=='CANCELLED');const quantity=relevant.reduce((sum,t)=>{const c=this.repo.get(t.container,'container');return sum+(c.location===request.site?this.repo.quantity(c.id,request.product):0);},0);request.delivered=quantity;const onTheWay=relevant.some(t=>{if(active(t))return true;const loc=this.repo.get(this.repo.get(t.container,'container').location);return loc.kind==='truck'||loc.kind==='resource';});if(quantity===request.quantity)request.status='DELIVERED';else if(request.status==='PARTIALLY ALLOCATED'&&quantity>0&&!onTheWay)request.status='DELIVERED';else if(request.status==='DELIVERED'&&quantity===0)request.status='RETURNED';this.repo.save(request);
    }
  },
  tick(elapsed=250){
    const config=this.repo.all('config')[0];if(!config||config.paused)return;
    this.advanceWorkers(elapsed);
    this.advanceForklifts(elapsed);
    for(const truck of this.repo.all('truck').filter(t=>t.status==='IN_TRANSIT')){truck.remainingMs=Math.max(0,truck.remainingMs-elapsed);if(truck.remainingMs===0){const destination=this.repo.get(truck.destination);truck.at=destination.id;truck.status=destination.kind==='site'?'AT_SITE':'AT_YARD';truck.destination=null;const delivery=this.repo.get(truck.delivery,'delivery');delivery.status=delivery.containers.length?'ARRIVED':'DELIVERED';this.repo.save(delivery);this.notify('Truck arrived',`${truck.name} has arrived. Cargo stays on the truck until unloading.`,destination.kind==='site'?destination.id:null);}this.repo.save(truck);}
    // Priority order (the title-free part of taskInfo), with one id -> kind lookup per id for the sort.
    this.taskKinds=new Map();let order;try{order=this.tasks().filter(t=>active(t)&&t.state!=='BLOCKED').map((t,i)=>({t,i,p:this.taskPriority(t)})).sort((a,b)=>a.p-b.p||a.i-b.i).map(x=>x.t);}finally{this.taskKinds=null;}
    for(let task of order){
      if(task.due>0){task.due=Math.max(0,task.due-elapsed);this.repo.save(task);continue;}
      this.db.exec('SAVEPOINT movement_step');
      try{this.advance(task);this.db.exec('RELEASE movement_step');}
      catch(error){this.db.exec('ROLLBACK TO movement_step');this.db.exec('RELEASE movement_step');task=this.repo.get(task.id,'task');task.resumeState=task.state;task.state='BLOCKED';task.reason=error.status?error.message:'Movement failed safely. Review the server log before retrying.';if(!error.status)console.error(JSON.stringify({event:'movement_error',task:task.id,message:error.message}));this.repo.save(task);}
    }
    this.tickJobs(elapsed);
    this.alCheck({gate:true});// materials dropping below their minimum (only when the ledger or catalogue moved)
  }
};
