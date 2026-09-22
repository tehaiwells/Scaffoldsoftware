import {integer,requireRule,route,rect,overlap,fitsPolygon} from './geometry.js';

export const forkliftMethods={
  placementPlan(machine,input){
    requireRule(machine.cargo,'The forklift is not carrying a stillage.');requireRule(input.container===undefined||input.container===machine.cargo,'The carried stillage changed. Reopen placement.');requireRule(!machine.drive,'Stop the forklift before planning placement.');
    const c=this.repo.get(machine.cargo,'container'),rotation=input.rotation??c.rotation;requireRule(rotation===0||rotation===90,'Choose 0 or 90 degrees.');
    const position={x:integer(input.x,'Placement X',-1000000),y:integer(input.y,'Placement Y',-1000000),rotation,support:null};
    this.validatePlacement(c,machine.location,position);const loc=this.repo.get(machine.location),footprint=rect(c,position),current=this.forkliftShape(machine),turned=this.forkliftShape(machine,{...c,rotation});
    const shape={w:Math.max(current.w,turned.w),h:Math.max(current.h,turned.h)},target={x:position.x-2200,y:position.y};
    const obstacles=this.forkliftObstacles(machine);let rotationClearance=null;
    if(rotation!==c.rotation){const span=Math.max(c.envelopeLength,c.envelopeWidth),side=Math.ceil(span*Math.SQRT2),margin=(side-span)/2;rotationClearance={x:position.x-margin,y:position.y-margin,w:side,h:side};requireRule(fitsPolygon(rotationClearance,loc.points)&&!obstacles.some(o=>overlap(rotationClearance,o)),'Not enough clear space to rotate the stillage at this position.');}
    const path=route({x:machine.x,y:machine.y},target,shape,loc.points,obstacles,500);requireRule(path,'No clear forklift route. Allow space for the forklift and its load.');
    return {position,footprint,rotationClearance,shape,path,forklift:{...target,w:2200,h:1200}};
  },
  placementPreview(input){this.auth.require(this.user,'operations.manage');const worker=this.repo.get(input.id,'resource');requireRule(worker.enabled&&worker.mountedOn&&!worker.task,'Select a mounted worker.');const machine=this.repo.get(worker.mountedOn,'resource');requireRule(machine.enabled&&machine.driver===worker.id&&!machine.task,'Forklift is unavailable.');return this.placementPlan(machine,input);},
  forkliftShape(machine,load=null){const c=load??(machine.cargo?this.repo.get(machine.cargo,'container'):null),r=c?rect(c):null;return {w:2200+(r?.w??0),h:Math.max(1200,r?.h??0)};},
  forkliftObstacles(machine,exclude=null){return [...this.occupied(machine.location).filter(c=>c.id!==exclude).map(c=>rect(c)),...this.repo.all('resource').filter(r=>r.enabled&&r.type==='FORKLIFT'&&r.location===machine.location&&r.id!==machine.id&&!r.task).flatMap(r=>{const p=this.forkliftPosition(r);return p?[{...p,...this.forkliftShape(r)}]:[];})];},
  checkManualLoad(machine,c){
    requireRule(c.location===machine.location,'Select a stillage on the ground in this yard.');this.assertFree(c,machine.id);
    requireRule(c.condition==='SERVICEABLE','Only serviceable stillages can be picked up.');requireRule(!c.support,'Manual pickup currently supports ground-level stillages.');
    requireRule(this.weight(c)<=machine.capacity,'Load exceeds forklift capacity.');requireRule(c.height<=machine.reach,'Load exceeds forklift reach.');
    if(c.capacity!==null)requireRule(this.weight(c)<=c.capacity,'Stillage exceeds its configured capacity.');
  },
  forkliftCommand(worker,input){
    const machine=this.repo.get(worker.mountedOn,'resource');requireRule(machine.enabled&&machine.driver===worker.id&&!machine.task,'This worker is not the available forklift driver.');
    if(['STOP','HOLD'].includes(input.order)){machine.drive=null;machine.manualReason=null;this.repo.save(machine);return machine;}
    requireRule(['MOVE','PICKUP','PLACE'].includes(input.order),'Dismount before returning to automatic work.');
    const loc=this.repo.get(machine.location);requireRule(loc.kind==='yard','Manual forklift handling is available in the yard.');
    let target,c=null,shape=this.forkliftShape(machine),placement=null;
    if(input.order==='PICKUP'){
      requireRule(!machine.cargo,'Place the current load first.');c=this.repo.get(input.container,'container');this.checkManualLoad(machine,c);
      target={x:c.x-2200,y:c.y};const lifted={...target,...this.forkliftShape(machine,c)};
      requireRule(fitsPolygon(lifted,loc.points)&&!this.forkliftObstacles(machine,c.id).some(o=>overlap(lifted,o)),'There is not enough clear space on the left side to pick up this stillage.');
    }else if(input.order==='PLACE'){
      requireRule(machine.cargo,'The forklift is not carrying a stillage.');c=this.repo.get(machine.cargo,'container');
      placement=this.placementPlan(machine,input);shape=placement.shape;target={x:placement.position.x-2200,y:placement.position.y};
    }else target={x:integer(input.x,'Forklift X',-1000000),y:integer(input.y,'Forklift Y',-1000000)};
    if(machine.cargo)this.assertCountFree(this.repo.get(machine.cargo,'container'));
    const path=route({x:machine.x,y:machine.y},target,shape,loc.points,this.forkliftObstacles(machine),500);requireRule(path,'No clear forklift route. Allow space for the forklift and its load.');
    machine.drive={order:input.order,path,next:1,container:c?.id??null,actor:this.user.id,key:this.key,shape,rotationClearance:placement?.rotationClearance??null,position:placement?.position??null};machine.manualReason=null;this.repo.save(machine);return machine;
  },
  finishForklift(machine){
    const job=machine.drive;
    if(job.order==='PICKUP'){
      const c=this.repo.get(job.container,'container');this.checkManualLoad(machine,c);requireRule(c.x===machine.x+2200&&c.y===machine.y,'The pickup position changed.');
      const footprint={x:machine.x,y:machine.y,...this.forkliftShape(machine,c)};requireRule(fitsPolygon(footprint,this.repo.get(machine.location).points)&&!this.forkliftObstacles(machine,c.id).some(o=>overlap(footprint,o)),'The load footprint is blocked.');
      const from=c.location;c.location=machine.id;c.x=2200;c.y=0;c.support=null;c.sourceYard??=from;this.repo.save(c);machine.cargo=c.id;
      for(const line of (this.repo.lines(c.id).length?this.repo.lines(c.id):[{product_id:null,quantity:0}]))this.repo.event(job.actor,'PICKUP',{container:c.id,product:line.product_id,quantity:line.quantity,source:from,destination:machine.id,reason:'Manual forklift pickup',key:job.key+':pickup'});
    }else if(job.order==='PLACE'){
      requireRule(machine.cargo===job.container,'The forklift load changed.');const c=this.repo.get(machine.cargo,'container');this.validatePlacement(c,machine.location,job.position);
      if(job.rotationClearance)requireRule(!this.forkliftObstacles(machine).some(o=>overlap(job.rotationClearance,o)),'The rotation space is now blocked.');
      c.location=machine.location;Object.assign(c,job.position);c.placedAt=new Date().toISOString();this.repo.save(c);machine.cargo=null;
      for(const line of (this.repo.lines(c.id).length?this.repo.lines(c.id):[{product_id:null,quantity:0}]))this.repo.event(job.actor,'PLACEMENT',{container:c.id,product:line.product_id,quantity:line.quantity,source:machine.id,destination:machine.location,reason:'Manual forklift placement',key:job.key+':place'});
    }
    machine.drive=null;this.repo.save(machine);
  },
  advanceForklifts(elapsed){
    for(let machine of this.repo.all('resource').filter(r=>r.enabled&&r.drive)){
      this.db.exec('SAVEPOINT manual_forklift_step');
      try{
        const driver=this.repo.get(machine.driver,'resource');requireRule(driver.mountedOn===machine.id&&!driver.task&&!machine.task,'The assigned driver changed.');
        const loc=this.repo.get(machine.location),shape=machine.drive.shape??this.forkliftShape(machine),obstacles=this.forkliftObstacles(machine);let remaining=2000*elapsed/1000;
        if(machine.cargo)this.assertCountFree(this.repo.get(machine.cargo,'container'));
        while(machine.drive&&remaining>0){const target=machine.drive.path[machine.drive.next];if(!target){this.finishForklift(machine);break;}
          const dx=target.x-machine.x,dy=target.y-machine.y,distance=Math.hypot(dx,dy),step=Math.min(remaining,distance,100),next=distance?{x:machine.x+dx*step/distance,y:machine.y+dy*step/distance}:{...target};
          requireRule(fitsPolygon({...next,...shape},loc.points)&&!obstacles.some(o=>overlap({...next,...shape},o)),'Forklift route blocked. Stop or choose another destination.');Object.assign(machine,next);remaining-=step;if(distance<=step+.001){Object.assign(machine,target);machine.drive.next++;}
        }
        driver.x=machine.x+600;driver.y=machine.y+350;this.repo.save(driver);this.repo.save(machine);this.db.exec('RELEASE manual_forklift_step');
      }catch(error){this.db.exec('ROLLBACK TO manual_forklift_step');this.db.exec('RELEASE manual_forklift_step');machine=this.repo.get(machine.id,'resource');machine.drive=null;machine.manualReason=error.status?error.message:'Forklift stopped. Retry the command.';this.repo.save(machine);if(!error.status)console.error(error);}
    }
  }
};
