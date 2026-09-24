import { requireRule,rect,overlap,contains,fitsPolygon,turnSpot,turnPath,pileTurn,TURN_ANCHORS } from './geometry.js';
import { active } from './inventory.js';
import { solidFixture } from './fixtures.js';
const m1=v=>(v/1000).toFixed(1);
const size=r=>m1(r.w)+' × '+m1(r.h)+' m';
const list=names=>{const u=[...new Set(names)];return u.length<2?u.join(''):u.slice(0,-1).join(', ')+' and '+u.at(-1);};
const ANCHOR_WORDS={BACK:'back to exactly where it was before its last turn',CENTRE:'about its middle',TL:'keeping its top-left corner where it is',TR:'keeping its top-right corner where it is',BL:'keeping its bottom-left corner where it is',BR:'keeping its bottom-right corner where it is'};
const ANCHOR_SET={BACK:'exactly where it was before its last turn',CENTRE:'centred on the same spot',TL:'with its top-left corner on the same spot',TR:'with its top-right corner on the same spot',BL:'with its bottom-left corner on the same spot',BR:'with its bottom-right corner on the same spot'};
export const turningMethods={
  // Read-only. Works out exactly how the crew would give this stillage (and anything stacked on it) a quarter turn, or says why not.
  turnPlan(input){
    const c=this.repo.get(input.container,'container');this.assertSite(c.location);
    const refuse=(message,extra={})=>({ok:false,container:c.id,name:c.name,message,...extra});
    if(c.retired)return refuse(c.name+' has been removed from storage.');
    const loc=this.repo.get(c.location);
    if(loc.kind==='truck')return refuse(c.name+' is on '+loc.name+'. Turn it after it has been unloaded.');
    if(loc.kind==='resource'){const task=this.tasks().find(t=>active(t)&&t.container===c.id);return refuse(task?c.name+' is being moved by the crew right now. Turn it after it has been set down.':c.name+' is on '+loc.name+'. Use Place load and Rotate 90° when the driver sets it down.');}
    requireRule(['yard','site'].includes(loc.kind),'Turn stillages in a yard or at a site.');if(loc.status==='ARCHIVED')return refuse('This site is archived.');
    const want=90-(c.rotation??0);if(input.rotation!==undefined&&input.rotation!==want)return refuse(c.name+' has already been turned. Nothing to do.');
    if(this.repo.all('resource').some(m=>m.cargo===c.id||m.drive?.container===c.id))return refuse(c.name+' is on a manual forklift. Use Place load and Rotate 90° when the driver sets it down.');
    const stored=this.containers().filter(o=>o.location===loc.id),byId=new Map(stored.map(o=>[o.id,o]));
    const above=id=>{const out=[id];for(let i=0;i<out.length;i++)for(const o of stored)if(o.support===out[i]&&!out.includes(o.id))out.push(o.id);return out;};
    const baseOf=o=>{let cur=o,n=0;while(cur.support&&byId.has(cur.support)&&n++<9)cur=byId.get(cur.support);return cur;};
    // An upper that still fits on its support once turned turns on its own; otherwise the whole pile turns from its base.
    let root=c,why=null;if(c.support&&byId.has(c.support)&&above(c.id).length===1){const s=byId.get(c.support);if(!TURN_ANCHORS.some(a=>contains(rect(s),rect(c,turnSpot(c,c,a))))){root=baseOf(c);why=c.name+' would hang over the edge of '+s.name+' if it turned on its own, so the whole pile turns.';}}else if(c.support&&byId.has(c.support)){root=baseOf(c);why=c.name+' is part of a pile, so the whole pile turns.';}
    const members=above(root.id).map(id=>byId.get(id));
    for(const m of members){if(m.condition!=='SERVICEABLE')return refuse(m.name+' is marked '+m.condition.toLowerCase()+'. The crew only handles serviceable stillages; change its condition first.');
      if(this.tasks().some(t=>active(t)&&(t.container===m.id||t.sourceContainer===m.id||t.position?.support===m.id)))return refuse(m.name+' already has a movement waiting or in progress. Turn it when that is done, or cancel it in Movement activity.');
      if(this.repo.all('count').some(n=>n.state==='OPEN'&&(n.scope===m.id||n.scope===loc.id)))return refuse('A stocktake is open here. Finish or cancel the count first.');
      if(this.repo.all('resource').some(r=>r.cargo===m.id||r.drive?.container===m.id))return refuse(m.name+' is on a manual forklift.');}
    if(members.length>1){const running=this.layouts().find(l=>l.status==='ACTIVE'&&l.yard===loc.id);if(running)return refuse('Finish or cancel the current layout plan before turning this pile ('+running.name+', '+running.done+' of '+running.steps.length+' done).');}
    const machine=loc.kind==='site'?'crane':'forklift';
    const machines=this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id&&r.type===machine.toUpperCase());if(!machines.length)return refuse('There is no '+machine+' at '+loc.name+'. Add one first.');
    for(const m of members){let weight;try{weight=this.projectedWeight(m);}catch(error){if(!error.status)throw error;return refuse(error.message);}if(!machines.some(k=>weight<=k.capacity))return refuse(m.name+' is heavier than any '+machine+' here can lift.');if(!machines.some(k=>m.height<=k.reach))return refuse(m.name+' is taller than any '+machine+' here can reach.');}
    const solids=(loc.fixtures??[]).filter(solidFixture),chain=id=>{const out=[];let cur=id,n=0;while(cur&&n++<9){out.push(cur);cur=byId.get(cur)?.support;}return out;};
    const skip=new Set([...members.map(m=>m.id),...chain(root.support)]);
    const others=this.occupied(loc.id,root.id).filter(o=>!skip.has(o.id)&&!skip.has(o.of));
    const obstacles=[...others.map(o=>rect(o)),...solids.map(f=>({x:f.x,y:f.y,w:f.w,h:f.h}))];
    // Names what sits where the turned footprint would go.
    const blockers=to=>{const r=rect(root,to),level=root.support??null,out=[];if(!fitsPolygon(r,loc.points))out.push('the '+(loc.kind==='site'?'site':'yard')+' boundary');for(const o of others)if((o.support??null)===level&&overlap(r,rect(o)))out.push(o.ghost?'the spot reserved for '+o.name:o.name);if(!level){if(overlap(r,{...loc.loading,w:2000,h:1500}))out.push('the loading zone');for(const f of loc.fixtures??[])if(overlap(r,f))out.push('the '+f.name.toLowerCase());}return out;};
    const anchors=[...(members.length===1&&root.turnedFrom&&root.turnedFrom.rotation===want&&root.turnedFrom.after?.x===root.x&&root.turnedFrom.after?.y===root.y&&root.turnedFrom.after?.rotation===(root.rotation??0)?['BACK']:[]),...TURN_ANCHORS];
    const attempts=[];
    for(const anchor of anchors){const to=anchor==='BACK'?{x:root.turnedFrom.x,y:root.turnedFrom.y,rotation:want}:turnSpot(root,root,anchor);const moves=pileTurn(root,members,to);
      try{
        const names=blockers(to);requireRule(!names.length,list(names)+(names.length>1?' are':' is')+' in the way');
        if(members.length===1){
          const position={x:to.x,y:to.y,rotation:to.rotation,support:root.support??null};this.validatePlacement(root,loc.id,position);
          const turn=turnPath(loc.points,root,root,position,obstacles);requireRule(turn,'there is no clear '+m1(2*turn?.turnAt?.r||Math.hypot(root.envelopeLength,root.envelopeWidth))+' m circle nearby for the '+machine+' to turn it in');
          return {ok:true,container:c.id,name:c.name,root:root.id,rootName:root.name,anchor,moves,steps:[{container:root.id,name:root.name,from:{x:root.x,y:root.y,rotation:root.rotation??0,support:root.support??null},to:position,park:false}],turnAt:turn.turnAt,inPlace:turn.inPlace,from:rect(root),footprint:rect(root,to),why,
            message:'The '+machine+' will lift '+root.name+', '+(turn.inPlace?'turn it a quarter turn '+ANCHOR_WORDS[anchor]:'carry it to open ground, turn it a quarter turn and set it down '+ANCHOR_SET[anchor])+(root.support?' on '+byId.get(root.support).name:'')+' ('+size(rect(root))+' becomes '+size(rect(root,to))+').',warnings:this.turnWarnings(loc)};
        }
        const steps=this.sequenceLayout(loc,{moves});const parked=steps.filter(s=>s.park).map(s=>s.name);
        return {ok:true,container:c.id,name:c.name,root:root.id,rootName:root.name,anchor,moves,steps,from:rect(root),footprint:rect(root,to),why,
          message:(why?why+' ':'')+root.name+' has '+(members.length-1)+' stillage'+(members.length===2?'':'s')+' on top. The crew turns the whole pile in '+steps.length+' '+machine+' moves: '+(parked.length?'set '+list(parked)+' down nearby, ':'')+'turn '+root.name+' '+ANCHOR_WORDS[anchor]+', then put '+(members.length===2?'it':'them')+' back on top.',warnings:this.turnWarnings(loc)};
      }catch(error){if(!error.status)throw error;attempts.push({anchor,reason:error.message});}
    }
    const first=(attempts.find(a=>a.anchor==='CENTRE')??attempts[0])?.reason??'there is no room';
    return refuse(root.name+' cannot be turned where it stands: '+first.replace(/\.$/,'')+'. Clear the space around it, or use Plan a new layout to move it somewhere with more room.',{attempts});
  },
  turnWarnings(loc){const crew=this.repo.all('resource').filter(r=>r.enabled&&r.location===loc.id),type=loc.kind==='site'?'CRANE':'FORKLIFT',w=[];const free=crew.filter(r=>r.type===type&&!r.driver&&!r.claimedBy);if(!free.length){const driven=crew.find(r=>r.type===type&&r.driver);w.push(driven?driven.name+' is being driven by '+(crew.find(x=>x.id===driven.driver)?.name??'a worker')+'; the turn will be blocked until the driver gets off, then press Retry.':'No free '+type.toLowerCase()+' here right now: the turn will wait until one is free.');}if(!crew.some(r=>r.type==='WORKER'&&!r.mountedOn&&(!r.workerMode||r.workerMode==='AUTO')))w.push('No worker is on automatic work: return a worker to work so the turn can start.');if(this.repo.all('config')[0]?.paused)w.push('The simulation is paused.');return w;},
  turnPreview(input){this.auth.require(this.user,'operations.manage');try{return this.turnPlan(input);}catch(error){if(!error.status)throw error;return {ok:false,message:error.message};}},
  rotate(input){
    const plan=this.turnPlan(input);requireRule(plan.ok,plan.message);const loc=this.repo.get(this.repo.get(plan.root,'container').location);
    this.repo.event(this.user.id,'TURN_PLANNED',{container:plan.root,source:loc.id,destination:loc.id,quantity:plan.steps.length,reason:'Turn '+plan.rootName+' a quarter turn ('+plan.anchor+'): '+plan.steps.length+' move(s)',key:this.key});
    if(plan.moves.length===1){const m=plan.moves[0];const task=this.queue({container:m.container,destination:loc.id,position:{x:m.x,y:m.y,rotation:m.rotation,support:m.support}});task.turn=true;this.repo.save(task);return {ok:true,task,tasks:[task],plan,message:plan.message};}
    const {layout,tasks}=this.commitSteps(loc,plan.steps,'Turn '+plan.rootName,'TURN');
    return {ok:true,layout,tasks,plan,message:plan.message};
  },
  // Read-only dry run of a yard or site boundary save inside a savepoint that is always rolled back.
  // detail 'quick': validation, affected stillages, where loading and gate end up. detail 'full': the whole save incl. relocation, diffed.
  boundaryPreview(input){
    this.auth.require(this.user,'operations.manage');const detail=input.detail==='full'?'full':'quick';const {detail:_,budgetMs:__,...save}=input;
    this.db.exec('SAVEPOINT boundary_preview');
    try{
      const target=save.id?this.repo.get(save.id):null;requireRule(!target||['yard','site'].includes(target.kind),'Choose a yard or site.');
      const run=opts=>target?.kind==='site'?this.siteBoundary(save,opts):this.yard(save,opts);
      if(!target){const made=run({});return {ok:true,detail,created:true,affected:[],moved:[],points:made.points,area:made.area,loading:made.loading,gate:made.gate,stops:0,jobs:0,incoming:0,halted:[],stock:[],message:'Ready to create.'};}
      const quick=run({dryRun:'quick'});
      if(detail==='quick')return {ok:true,detail,...quick,message:quick.unchanged?'Nothing physical changes.':quick.notes.join('. ')};
      if(quick.affected.length>60)return {ok:true,detail,...quick,moved:null,tooMany:quick.affected.length,message:quick.affected.length+' stillages must be moved; their new spots are chosen when you save.'};
      const snap=()=>new Map(this.containers().filter(c=>c.location===target.id).map(c=>[c.id,{name:c.name,x:c.x,y:c.y,rotation:c.rotation??0,support:c.support??null}]));
      const before=snap();this.db.exec('SAVEPOINT boundary_full');let saved,after;try{saved=run({deadline:performance.now()+Math.max(0,Math.min(400,+(input.budgetMs??400)||0))});after=snap();}catch(error){if(error.slow)return {ok:true,detail,...quick,moved:null,slow:true,message:'New spots are chosen when you save.'};throw error;}finally{this.db.exec('ROLLBACK TO boundary_full');this.db.exec('RELEASE boundary_full');}
      const moved=[...after].filter(([id,a])=>{const b=before.get(id);return b&&(b.x!==a.x||b.y!==a.y||b.rotation!==a.rotation||b.support!==a.support);}).map(([id,a])=>{const b=before.get(id);return {id,name:a.name,from:{x:b.x,y:b.y,rotation:b.rotation,support:b.support},to:{x:a.x,y:a.y,rotation:a.rotation,support:a.support}};});
      return {ok:true,detail,...quick,moved,message:saved.message};
    }catch(error){if(!error.status)throw error;return {ok:false,message:error.message};}
    finally{this.db.exec('ROLLBACK TO boundary_preview');this.db.exec('RELEASE boundary_preview');}
  }
};
