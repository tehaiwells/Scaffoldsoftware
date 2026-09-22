import {integer,requireRule,route,rect,overlap,fitsPolygon} from './geometry.js';
const size=500;
export const workerMethods={
  forkliftPosition(machine){
    if(Number.isFinite(machine.x)&&Number.isFinite(machine.y))return {x:machine.x,y:machine.y};
    const loc=this.repo.get(machine.location),obstacles=[...this.occupied(loc.id).map(c=>rect(c)),{...loc.loading,w:2000,h:1500},...this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id&&r.id!==machine.id&&Number.isFinite(r.x)&&Number.isFinite(r.y)).map(r=>r.type==='FORKLIFT'?{x:r.x,y:r.y,...this.forkliftShape(r)}:{x:r.x,y:r.y,w:500,h:500})];
    const index=this.repo.all('resource').filter(r=>r.enabled&&r.type==='FORKLIFT'&&r.location===loc.id).findIndex(r=>r.id===machine.id);let slot=0;
    for(let y=Math.max(...loc.points.map(p=>p.y))-3000;y>=Math.min(...loc.points.map(p=>p.y));y-=2500)for(let x=Math.min(...loc.points.map(p=>p.x))+1000;x<Math.max(...loc.points.map(p=>p.x));x+=3000){const footprint={x,y,w:2400,h:2000};if(fitsPolygon(footprint,loc.points)&&!obstacles.some(o=>overlap(footprint,o))&&slot++===index)return {x,y};}
    return null;
  },
  workerObstacles(location){return [...this.occupied(location).map(c=>rect(c)),...this.repo.all('resource').filter(r=>r.enabled&&r.type==='FORKLIFT'&&r.location===location&&!r.task).flatMap(r=>{const p=this.forkliftPosition(r);return p?[{...p,...this.forkliftShape(r)}]:[];})];},
  releaseMount(worker){if(worker.mountTarget){const machine=this.repo.get(worker.mountTarget,'resource');if(machine.claimedBy===worker.id){machine.claimedBy=null;this.repo.save(machine);}worker.mountTarget=null;}},
  workerPosition(worker){
    if(Number.isFinite(worker.x)&&Number.isFinite(worker.y))return {x:worker.x,y:worker.y};
    const loc=this.repo.get(worker.location),obstacles=[...this.occupied(loc.id).map(c=>rect(c)),...(loc.loading?[{...loc.loading,w:2000,h:1500}]:[]),...this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id&&r.id!==worker.id&&Number.isFinite(r.x)&&Number.isFinite(r.y)).map(r=>r.type==='FORKLIFT'?{x:r.x,y:r.y,...this.forkliftShape(r)}:{x:r.x,y:r.y,w:500,h:500})];
    const peers=this.repo.all('resource').filter(r=>r.enabled&&r.type==='WORKER'&&r.location===loc.id),index=Math.max(0,peers.findIndex(r=>r.id===worker.id));let slot=0;
    for(let y=Math.min(...loc.points.map(p=>p.y))+750;y<Math.max(...loc.points.map(p=>p.y));y+=1300)for(let x=Math.min(...loc.points.map(p=>p.x))+750;x<Math.max(...loc.points.map(p=>p.x));x+=1300){const footprint={x,y,w:size,h:size};if(fitsPolygon(footprint,loc.points)&&!obstacles.some(o=>overlap(footprint,o))){if(slot++===index)return {x,y};}}
    return null;
  },
  workerCommand(input){
    const worker=this.repo.get(input.id,'resource');requireRule(worker.enabled&&worker.type==='WORKER','Choose an enabled worker.');requireRule(!worker.task,'This worker is assigned to a material movement. Finish that task first.');
    requireRule(['MOVE','STOP','HOLD','AUTO','MOUNT','DISMOUNT','PICKUP','PLACE'].includes(input.order),'Choose a worker command.');
    if(input.order==='DISMOUNT'){
      requireRule(worker.mountedOn,'This worker is not mounted.');const machine=this.repo.get(worker.mountedOn,'resource');requireRule(machine.driver===worker.id&&!machine.task,'The forklift is busy or its driver changed.');
      requireRule(!machine.drive&&!machine.cargo,'Stop and place the load before dismounting.');const target={x:machine.x+700,y:machine.y+1400},loc=this.repo.get(worker.location),footprint={...target,w:size,h:size};requireRule(fitsPolygon(footprint,loc.points)&&!this.workerObstacles(loc.id).some(o=>overlap(footprint,o)),'The exit is blocked. Clear the space beside the forklift.');
      machine.driver=null;machine.claimedBy=null;this.repo.save(machine);worker.mountedOn=null;worker.workerMode='HOLD';Object.assign(worker,target);return this.repo.save(worker);
    }
    if(worker.mountedOn)return this.forkliftCommand(worker,input);
    requireRule(!['PICKUP','PLACE'].includes(input.order),'Mount a forklift first.');this.releaseMount(worker);
    const pos=this.workerPosition(worker);requireRule(pos,'There is no clear space for this worker.');Object.assign(worker,pos);worker.walk=null;worker.workerReason=null;
    if(input.order==='MOUNT'){
      const machine=this.repo.get(input.forklift,'resource');requireRule(machine.enabled&&machine.type==='FORKLIFT'&&machine.location===worker.location,'Choose a forklift in this yard.');requireRule(!machine.task&&!machine.driver&&!machine.claimedBy,'This forklift is busy or reserved by another worker.');
      const parking=this.forkliftPosition(machine);requireRule(parking,'There is no clear space for this forklift.');Object.assign(machine,parking);
      const target={x:machine.x+700,y:machine.y+1400},loc=this.repo.get(worker.location),path=route(pos,target,{w:size,h:size},loc.points,this.workerObstacles(loc.id),500);requireRule(path,'No clear walking route to the forklift.');
      machine.claimedBy=worker.id;this.repo.save(machine);worker.mountTarget=machine.id;worker.walk={path,next:1};worker.workerMode='MOVING';
    }else if(input.order==='MOVE'){
      const location=this.repo.get(worker.location),target={x:integer(input.x,'Worker X',-1000000),y:integer(input.y,'Worker Y',-1000000)};
      const path=route(pos,target,{w:size,h:size},location.points,this.workerObstacles(location.id),500);
      requireRule(path,'No clear walking route. Choose open ground inside the yard.');worker.walk={path,next:1};worker.workerMode='MOVING';
    }else worker.workerMode=input.order==='AUTO'?'AUTO':'HOLD';
    return this.repo.save(worker);
  },
  advanceWorkers(elapsed){
    for(const machine of this.repo.all('resource').filter(r=>r.enabled&&r.type==='FORKLIFT'&&!Number.isFinite(r.x))){const p=this.forkliftPosition(machine);if(p){Object.assign(machine,p);this.repo.save(machine);}}
    for(const worker of this.repo.all('resource').filter(r=>r.enabled&&r.type==='WORKER')){
      if(!Number.isFinite(worker.x)){const pos=this.workerPosition(worker);if(pos){Object.assign(worker,pos);this.repo.save(worker);}}
      if(!worker.walk||worker.task)continue;
      const loc=this.repo.get(worker.location),obstacles=this.workerObstacles(loc.id);let remaining=1400*elapsed/1000;
      while(worker.walk&&remaining>0){const target=worker.walk.path[worker.walk.next];if(!target){worker.walk=null;worker.workerMode='HOLD';if(worker.mountTarget){const machine=this.repo.get(worker.mountTarget,'resource');if(machine.enabled&&!machine.task&&machine.claimedBy===worker.id&&!machine.driver){machine.driver=worker.id;machine.claimedBy=null;this.repo.save(machine);worker.mountedOn=machine.id;worker.mountTarget=null;worker.workerMode='MOUNTED';worker.x=machine.x+600;worker.y=machine.y+350;}else{this.releaseMount(worker);worker.workerReason='Forklift no longer available.';}}break;}
        const dx=target.x-worker.x,dy=target.y-worker.y,distance=Math.hypot(dx,dy),step=Math.min(remaining,distance,100),next=distance?{x:worker.x+dx*step/distance,y:worker.y+dy*step/distance}:{...target};
        const footprint={...next,w:size,h:size};if(!fitsPolygon(footprint,loc.points)||obstacles.some(o=>overlap(footprint,o))){worker.walk=null;worker.workerMode='HOLD';this.releaseMount(worker);worker.workerReason='Walking route is blocked. Give a new move order.';break;}
        Object.assign(worker,next);remaining-=step;if(distance<=step+.001)worker.walk.next++;
      }
      this.repo.save(worker);
    }
  }
};
