// Shape editor for a yard or site boundary: a flat, top-down plan with draggable corners, sides, zones and fixtures.
// Pure parts (draft model, reducer, checks, markup) are exported for node tests; the controller touches the DOM only inside mount().
// Units: millimetres in the draft and on the wire, metres in the fields. y grows downward.
import {normalise,detectPreset,rectangle,lShape,setSideLength,pushSide,moveCorner,splitSide,removeCorner,sides,slantedSides,ringProblems,fitsPolygon,overlap,affected,freeZone,freeSpot,bbox,axisAligned,ringArea,footprint,sameGround} from './shape.js';
import {esc} from './visual.js';

export const FIXTURE_TYPES=[['ENTRY','Truck entry',4000,3000],['EXIT','Truck exit',4000,3000],['TOILET','Toilet',1500,1500],['OFFICE','Yard office',6000,3000],['CUSTOM','Custom fixture',2000,2000]];
const R=Math.round,ZW=2000,ZH=1500,zb=p=>({x:p.x,y:p.y,w:ZW,h:ZH}),solid=f=>f.kind!=='ENTRY'&&f.kind!=='EXIT',lane=f=>!solid(f);
const sq=v=>JSON.stringify(v),samePt=(a,b)=>!!a&&!!b&&a.x===b.x&&a.y===b.y;
const m=v=>Number.isInteger(v)?String(v/1000):(v/1000).toFixed(3);// metre field values: '20', '3.5', legacy floats '16.763'
const m1=v=>(v/1000).toFixed(1),at=p=>m1(p.x)+', '+m1(p.y)+' m',f2=v=>+(+v).toFixed(2),sqm=v=>String(+(v/1e6).toFixed(1));
const whereOf=d=>d.target.kind==='site'?'site':'yard';
const plural=(n,one,many)=>n+' '+(n===1?one:many);
const HINTS={TL:'Grows to the right and downward.',TR:'Grows to the left and downward.',BL:'Grows to the right and upward.',BR:'Grows to the left and upward.'};
const CORNER_NAMES=[['TL','Top-left'],['TR','Top-right'],['BL','Bottom-left'],['BR','Bottom-right']];
const GEOMETRY=new Set(['rect','l','preset','side','push','corner','cornerXY','split','remove']);

// ---------- draft ----------
export const snap=d=>structuredClone({preset:d.preset,anchor:d.anchor,corners:d.corners,name:d.name,height:d.height,loading:d.loading,gate:d.gate,fixtures:d.fixtures});
export const fromSnap=(d,s)=>({...d,...structuredClone(s)});
const core=d=>{const {id,shapeRev,...p}=payloadOf(d);return p;};
export function draftFrom(loc,kind){
  kind??=loc?.kind==='site'?'site':'yard';let d;
  if(kind==='new'||!loc||!(loc.points?.length>=3))d={target:{kind,id:kind==='new'?undefined:loc?.id,shapeRev:kind==='new'?undefined:loc?.shapeRev??0,name:loc?.name??'Main yard'},preset:'RECT',anchor:'TL',corners:[{x:0,y:0},{x:20000,y:0},{x:20000,y:16000},{x:0,y:16000}],name:loc?.name??'Main yard',height:loc?.height??10000,loading:{x:1000,y:1000},gate:{x:3500,y:1000},fixtures:[]};
  else{const corners=normalise(loc.points),ld=loc.loading??{x:1000,y:1000},gt=loc.gate??{x:3500,y:1000};
    d={target:{kind,id:loc.id,shapeRev:loc.shapeRev??0,name:loc.name},preset:detectPreset(corners).preset,anchor:'TL',corners,name:loc.name,height:loc.height??10000,loading:{x:ld.x,y:ld.y},gate:{x:gt.x,y:gt.y},fixtures:kind==='site'?[]:structuredClone(loc.fixtures??[])};}
  d.maxCorners=Math.max(100,d.corners.length);d.history=[];d.future=[];d.notice=null;d.base=sq(core(d));return d;
}
// What a save sends: never version, segments or closed. shapeRev guards against someone else's shape save.
export function payloadOf(d){const p={name:d.name,height:d.height,points:d.corners,loading:d.loading,gate:d.gate};
  if(d.target.kind!=='site')p.fixtures=d.fixtures.map(f=>({...(f.id?{id:f.id}:{}),kind:f.kind,name:f.name,x:f.x,y:f.y,w:f.w,h:f.h}));
  if(d.target.id){p.id=d.target.id;p.shapeRev=d.target.shapeRev;}return p;}
export const isDirty=d=>sq(core(d))!==d.base;
const original=d=>{const o=JSON.parse(d.base);return {points:o.points,loading:o.loading,gate:o.gate,fixtures:o.fixtures??[],height:o.height};};

// ---------- reducer (never mutates; records no history except the explicit 'record' edit) ----------
function lParams(d){const p=detectPreset(d.corners);if(p.preset==='L')return p;const b=bbox(d.corners),w=b.x1-b.x0,dd=b.y1-b.y0;return {preset:'L',w,d:dd,cutW:R(w/3),cutD:R(dd/3),cutCorner:'TR'};}
// Corners an edit creates are whole mm; a corner identical to one already in the draft is kept bit-for-bit (legacy floats round-trip).
const keepOrRound=(next,prev)=>next.map(p=>prev.some(q=>q.x===p.x&&q.y===p.y)?{x:p.x,y:p.y}:{x:R(p.x),y:R(p.y)});
export function reduce(d,e){
  const c=d.corners,b=bbox(c),x={...d,notice:null};
  switch(e.t){
    case 'record':return {...d,history:[...d.history,e.before].slice(-100),future:[]};
    case 'undo':{if(!d.history.length)return d;return {...d,...structuredClone(d.history.at(-1)),history:d.history.slice(0,-1),future:[...d.future,snap(d)],notice:null};}
    case 'redo':{if(!d.future.length)return d;return {...d,...structuredClone(d.future.at(-1)),future:d.future.slice(0,-1),history:[...d.history,snap(d)].slice(-100),notice:null};}
    case 'rect':x.anchor=e.anchor??d.anchor;x.corners=rectangle(R(e.w),R(e.d),x.anchor,b);break;
    case 'l':x.corners=normalise(lShape(R(e.w),R(e.d),R(e.cutW),R(e.cutD),e.cutCorner,b));break;
    case 'preset':{if(e.p===d.preset)return d;x.preset=e.p;const w=b.x1-b.x0,dd=b.y1-b.y0,now=detectPreset(c).preset;
      if(e.p==='RECT'&&now!=='RECT'){x.corners=keepOrRound(rectangle(w,dd,'TL',b),c);x.anchor='TL';x.notice='Switched to a rectangle around the old shape. Undo brings it back.';}
      else if(e.p==='L'&&now!=='L')x.corners=keepOrRound(normalise(lShape(w,dd,R(w/3),R(dd/3),'TR',b)),c);
      return x;}
    case 'side':x.corners=setSideLength(c,e.i,R(e.mm));break;
    case 'push':x.corners=pushSide(c,e.i,R(e.d));break;
    case 'corner':x.corners=moveCorner(c,e.i,{x:R(e.x),y:R(e.y)},e.square!==false);break;
    case 'cornerXY':x.corners=c.map((p,k)=>k===e.i?{...p,[e.axis]:R(e.mm)}:p);break;
    case 'split':if(c.length>=d.maxCorners)return d;x.corners=splitSide(c,e.i);break;
    case 'remove':if(c.length<=3)return d;x.corners=removeCorner(c,e.i);break;
    case 'zone':x[e.which]={x:R(e.x),y:R(e.y)};return x;
    case 'fixture':{const p={...e.patch};for(const k of ['x','y','w','h'])if(p[k]!==undefined)p[k]=R(p[k]);x.fixtures=d.fixtures.map((f,k)=>k===e.i?{...f,...p}:f);return x;}
    case 'addFixture':{const t=FIXTURE_TYPES.find(t=>t[0]===e.kind);if(!t)return d;x.fixtures=[...d.fixtures,{kind:t[0],name:t[1],x:R(e.at.x),y:R(e.at.y),w:t[2],h:t[3]}];return x;}
    case 'removeFixture':x.fixtures=d.fixtures.filter((_,k)=>k!==e.i);return x;
    case 'turnFixture':x.fixtures=d.fixtures.map((f,k)=>k===e.i?{...f,w:f.h,h:f.w}:f);return x;
    case 'name':x.name=e.value;return x;
    case 'height':x.height=R(e.mm);return x;
    default:return d;
  }
  if(GEOMETRY.has(e.t)){x.corners=keepOrRound(x.corners,c);if(detectPreset(x.corners).preset!==x.preset)x.preset='CUSTOM';}
  return x;
}

// ---------- instant checks (mirror inventory.js reshape and yard create) ----------
let zoneMemo={key:'',value:null};
// Where the save will put the loading zone and gate: kept when they fit, otherwise the server's own freeZone call.
export function zonePlan(d){
  const key=d.base+sq([d.corners,d.loading,d.gate,d.fixtures,d.target.kind]);if(zoneMemo.key===key)return zoneMemo.value;
  const o=original(d),solids=d.fixtures.filter(solid),pts=d.corners;let v;
  const changed=d.target.kind==='new'||!sameGround(pts,o.points)||!samePt(d.loading,o.loading)||!samePt(d.gate,o.gate)||d.fixtures.length!==o.fixtures.length||d.fixtures.some((f,i)=>{const g=o.fixtures[i];return !g||f.x!==g.x||f.y!==g.y||f.w!==g.w||f.h!==g.h;});
  if(d.target.kind==='new'||!changed||ringProblems(pts).length)v={changed,loading:d.loading,gate:d.gate,loadingMoved:false,gateMoved:false};
  else{const fit=(p,avoid,prefer)=>fitsPolygon(zb(p),pts)&&!avoid.some(q=>overlap(zb(p),q))?p:freeZone(pts,avoid,prefer,p);
    const loading=fit(d.loading,solids,[]),gate=loading&&fit(d.gate,[zb(loading),...solids],overlap(zb(d.gate),zb(loading))?[{x:loading.x+2500,y:loading.y}]:[]);
    v={changed,loading,gate,loadingMoved:!!loading&&!samePt(loading,d.loading),gateMoved:!!gate&&!samePt(gate,d.gate)};}
  zoneMemo={key,value:v};return v;
}
// Every problem with the draft: {message, sides, corners, zone, fixture, blocking}. Blocking ones disable Save.
export function problems(d,ctx={}){
  const out=[],w=whereOf(d),pts=d.corners,stock=ctx.stock??[],add=(message,o={})=>out.push({message,sides:[],corners:[],zone:null,fixture:null,blocking:true,...o});
  for(const p of ringProblems(pts))add(p.message,{sides:p.sides,corners:p.corners});
  if(pts.length>d.maxCorners)add('The '+w+' can have at most '+d.maxCorners+' corners.');
  if(out.length)return out;
  d.fixtures.forEach((f,i)=>{if(!fitsPolygon(f,pts))add(f.name+' is outside the '+w+'.',{fixture:i});});
  for(let i=0;i<d.fixtures.length;i++)for(let j=i+1;j<d.fixtures.length;j++)if(overlap(d.fixtures[i],d.fixtures[j]))add(d.fixtures[i].name+' overlaps '+d.fixtures[j].name+'.',{fixture:j});
  d.fixtures.forEach((f,i)=>{if(solid(f)&&overlap(f,zb(d.loading)))add(f.name+' overlaps the loading zone.',{fixture:i,zone:'loading'});});
  const tall=stock.find(s=>s.height>d.height);if(tall)add('Height is lower than stillage '+tall.name+' ('+m1(tall.height)+' m).');
  if(d.target.kind==='new'){if(!fitsPolygon(zb(d.loading),pts))add('The loading zone must be inside the yard.',{zone:'loading'});if(!fitsPolygon(zb(d.gate),pts))add('The gate must be inside the yard.',{zone:'gate'});return out;}
  const z=zonePlan(d);
  if(!z.loading||!z.gate)add('Too small: the '+w+' must fit the 2 × 1.5 m loading zone and a separate 2 × 1.5 m gate.',{zone:!z.loading?'loading':'gate'});
  else{if(z.loadingMoved)add('The loading zone is not clear in the new shape; it moves to '+at(z.loading)+' when you save.',{zone:'loading',blocking:false});
    if(z.gateMoved){const g=zb(d.gate),on=fitsPolygon(g,pts)?d.fixtures.find(f=>solid(f)&&overlap(g,f)):null;
      add((overlap(g,zb(d.loading))?'The gate shares the loading spot':on?'The gate is on '+on.name:'The gate is not clear in the new shape')+'; it moves to '+at(z.gate)+' when you save.',{zone:'gate',blocking:false});}}
  return out;
}
// Where a drag or an arrow key may put the loading zone, the gate or fixture i ('fixture:i'): inside the ground and clear of what the save would move it off.
export function canPlace(d,which,p){
  const pts=d.corners;if(which==='loading'||which==='gate'){const box=zb(p);if(!fitsPolygon(box,pts)||d.fixtures.some(f=>solid(f)&&overlap(box,f)))return false;
    return !overlap(box,zb(which==='gate'?d.loading:d.gate));}
  const i=+which.slice(8),f=d.fixtures[i],box={x:p.x,y:p.y,w:f.w,h:f.h};
  return fitsPolygon(box,pts)&&!d.fixtures.some((g,j)=>j!==i&&overlap(box,g))&&(!solid(f)||!overlap(box,zb(d.loading))&&!overlap(box,zb(d.gate)));}
// Stillages the save would move, as the server's quick check lists them (Map id -> outside|loading|fixture|height|pile).
const MOVE_WHY={outside:' be moved inside the new shape',loading:' be moved off the loading zone',fixture:' be moved clear of the fixtures',height:' be set down to fit the new height'};
export function localAffected(d,stock=[]){
  if(d.target.kind==='new'||!stock.length||!isDirty(d)||ringProblems(d.corners).length)return new Map();
  const z=zonePlan(d),o=original(d);if(!z.changed&&d.height===o.height)return new Map();
  if(!z.changed){const why=new Map(),byId=new Map(stock.map(s=>[s.id,s])),stack=s=>{let h=s.height,cur=s,n=0;while(cur?.support&&n++<9){cur=byId.get(cur.support);h+=cur?.height??0;}return h;};
    for(const s of stock)if(s.support&&stack(s)>d.height)why.set(s.id,'height');let grew=true;while(grew){grew=false;for(const s of stock)if(s.support&&why.has(s.support)&&!why.has(s.id)){why.set(s.id,'pile');grew=true;}}return why;}
  return affected(d.corners,stock,z.loading??d.loading,d.fixtures,d.height);
}

// ---------- status sentence and Save label ----------
const UI=()=>({view:null,snap:500,drag:null,pendingState:null,selected:null,seq:0,gen:0,locked:false,quick:null,full:null,inflight:{quick:null,full:null},want:{quick:false,full:false},saving:false,error:null,conflict:null,fieldBefore:null,lastTap:{key:null,time:0},stock:null,stockSig:'',timers:{},mounted:false,statusOpen:false,k:null,activeSide:null,pin:false,dragBad:null,note:null,checkError:null,lError:false,open:new Set()});
const listNames=names=>names.length>5?names.slice(0,5).join(', ')+' and '+(names.length-5)+' more':names.join(', ');
export function statusOf(d,ui={},ctx={}){
  const u={...UI(),...ui},w=whereOf(d),kind=d.target.kind,stock=u.stock??ctx.stock??[];
  const base=kind==='new'?'Create yard':w==='site'?'Save site':'Save yard';
  const block=(ctx.problems??problems(d,{stock})).filter(p=>p.blocking);
  const q=u.quick&&u.quick.seq===u.seq?u.quick:null,fu=u.full&&u.full.seq===u.seq?u.full:null,aff=localAffected(d,stock);
  const n=Math.max(aff.size,q?.ok?q.affected?.length??0:0),label=n>0?base+' · moves '+plural(n,'stillage','stillages'):base;
  const busy=u.saving==='checking'?'Checking…':u.saving?'Saving…':null;
  const out=(text,tone,canSave,lab=label,title)=>({text,tone,canSave:canSave&&!busy&&!u.conflict,label:busy??lab,title:canSave&&!busy?'':(title??text),moves:n});
  if(u.conflict)return out('Someone else saved this '+w+' while you were editing. Load their version, or save yours anyway.','bad',false);
  if(block.length)return out("Can't save yet: "+block[0].message,'bad',false,label,block[0].message);
  if(u.error)return out(u.error,'bad',true);
  const changed=isDirty(d),checking=u.inflight?.quick||u.inflight?.full?' Checking…':'';
  if(!changed&&kind!=='new')return out((u.note?u.note+' ':'')+'No changes yet.','ok',false,'No changes yet','No changes yet');
  if(q&&q.ok===false)return out(q.message,'bad',false);
  if(fu&&fu.ok===false)return out(fu.message,'bad',false);
  const b=bbox(d.corners),W=m1(b.x1-b.x0),D=m1(b.y1-b.y0);
  if(kind==='new')return out('A '+W+' × '+D+' m yard with the loading zone at '+at(d.loading)+' and the gate at '+at(d.gate)+'. '+(changed?'Press Create yard when it looks right.':'Change anything, then press Create yard.')+(u.checkError?' '+u.checkError:'')+checking,'ok',true);
  const A=ringArea(d.corners),dA=A-ringArea(original(d).points);
  let s=W+' × '+D+' m · '+sqm(A)+' m² ('+(dA>0?'+':dA<0?'−':'±')+sqm(Math.abs(dA))+' m²). ';
  const names=q?.ok&&q.affected?q.affected.map(a=>a.name):[...aff.keys()].map(id=>stock.find(x=>x.id===id)?.name??id);
  const whys=new Set((q?.ok&&q.affected?q.affected.map(a=>a.why):[...aff.values()]).filter(w=>w&&w!=='pile')),doing=whys.size===1?MOVE_WHY[[...whys][0]]??' be moved to new spots':whys.size?' be moved to new spots':' be moved inside the new shape';
  s+=n?plural(n,'stillage will','stillages will')+doing+': '+listNames(names)+' (red on the plan).':'Nothing needs to move.';
  const z=q?.ok&&!q.unchanged&&q.loading?{loading:q.loading,gate:q.gate,loadingMoved:q.loadingMoved,gateMoved:q.gateMoved}:zonePlan(d);
  if(z.loadingMoved&&z.loading)s+=' The loading zone moves to '+at(z.loading)+'.';
  if(z.gateMoved&&z.gate)s+=' The gate moves to '+at(z.gate)+'.';
  const stops=q?.ok?q.stops??0:0,jobs=q?.ok?q.jobs??0:0,incoming=q?.ok?q.incoming??0:0,halted=q?.ok?q.halted??[]:[];
  if(stops)s+=' '+plural(stops,'manual worker/forklift order','manual worker/forklift orders')+' will be stopped.';
  if(jobs)s+=' '+plural(jobs,'yard job','yard jobs')+' will be handed back and re-assigned.';
  if(incoming)s+=' '+plural(incoming,'incoming movement','incoming movements')+' will be re-planned.';
  for(const h of halted)s+=h.turn?' The waiting turn of '+h.name+' will be stopped; turn it again after saving.':' The waiting layout step for '+h.name+' will be stopped.';
  if(n&&fu?.ok&&fu.moved?.length)s+=' New spots are shown dashed green.';
  else if(n&&(fu?.slow||fu?.tooMany||q?.tooMany||q?.affected?.length>60))s+=' Their new spots are chosen when you save.';
  if(u.checkError)s+=' '+u.checkError;
  const warn=n||stops||jobs||incoming||halted.length||z.loadingMoved||z.gateMoved;
  return out(s+checking,warn?'warn':'ok',true);
}
const sizeText=d=>{const b=bbox(d.corners);return m1(b.x1-b.x0)+' × '+m1(b.y1-b.y0)+' m · '+sqm(ringArea(d.corners))+' m² · '+d.corners.length+' corners';};

// ---------- plan ----------
// The view box that shows the whole shape, zones, fixtures and stock, padded, with the svg's aspect.
export function fitBox(d,stock=[],pxW=800,pxH=560){
  const pts=[...d.corners,...[d.loading,d.gate].flatMap(p=>[p,{x:p.x+ZW,y:p.y+ZH}]),...d.fixtures.flatMap(f=>[f,{x:f.x+f.w,y:f.y+f.h}]),...stock.flatMap(s=>[s,{x:s.x+s.w,y:s.y+s.h}])];
  const b=bbox(pts),w=b.x1-b.x0,h=b.y1-b.y0,k=(Math.max(w,h*pxW/pxH)+3000)/Math.max(200,pxW-104),pad=1500+4*13*k;
  let W=w+2*pad,H=h+2*pad;const a=pxW/pxH;if(W/H<a)W=H*a;else H=W/a;
  return {x:R((b.x0+b.x1)/2-W/2),y:R((b.y0+b.y1)/2-H/2),w:R(W),h:R(H)};
}
// Box labels (zones, fixtures) fit their box on screen: at most 13 px, shrunk to the box width, and left out below 7 px (the name stays in the tooltip).
const ems=t=>[...t].reduce((s,ch)=>s+(ch===' '?0.28:/[WM]/.test(ch)?1:/[A-Z0-9]/.test(ch)?0.68:/[iljtf]/.test(ch)?0.32:/[mw]/.test(ch)?0.82:/[a-z]/.test(ch)?0.55:0.6),0);// width in ems at font-weight 650, a little over Segoe UI's
export function labelPx(txt,w,h,k,max=13,min=7){const px=Math.min(max,(w/k-4)/ems(txt),(h/k-2)*0.8);return px>=min?px:null;}
const dimText=len=>Math.abs(len/100-R(len/100))>1e-6?(len/1000).toFixed(2)+' m':(len/1000).toFixed(1)+' m';
export function planSVG(d,ui={},ctx={}){
  const u={...UI(),...ui},stock=u.stock??ctx.stock??[],view=u.view??fitBox(d,stock),k=ctx.k??u.k??view.w/800,fs=13*k,c=d.corners,n=c.length,w=whereOf(d);
  const probs=(ctx.problems??problems(d,{stock})).filter(p=>p.blocking),badSides=new Set(probs.flatMap(p=>p.sides)),badCorners=new Set(probs.flatMap(p=>p.corners)),badZones=new Set(probs.map(p=>p.zone).filter(Boolean)),badFix=new Set(probs.map(p=>p.fixture).filter(v=>v!=null));
  if(u.dragBad){if(u.dragBad.startsWith('fixture:'))badFix.add(+u.dragBad.slice(8));else badZones.add(u.dragBad);}
  const drag=u.drag?.moved?u.drag.key:null,active=u.activeSide??(drag?.startsWith('side:')?+drag.slice(5):null);
  const movingSides=new Set(active!=null?[active]:[]),movingCorners=new Set(active!=null?[(active+1)%n,(active+2)%n]:[]);
  const aff=localAffected(d,stock),q=u.quick&&u.quick.seq===u.seq?u.quick:null,fu=u.full&&u.full.seq===u.seq?u.full:null;
  const T=(x,y,size,txt,extra='')=>'<text x="'+f2(x)+'" y="'+f2(y)+'" font-size="'+f2(size)+'" text-anchor="middle" dominant-baseline="middle"'+extra+'>'+txt+'</text>';
  let s='<defs><marker id="shape-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#36852e"/></marker></defs>';
  s+='<rect class="shape-ground" x="'+f2(view.x-view.w)+'" y="'+f2(view.y-view.h)+'" width="'+f2(view.w*3)+'" height="'+f2(view.h*3)+'" fill="transparent"/>';
  const G=[1000,5000,10000,50000].find(g=>g/k>=6)??50000;let grid='';
  for(let x=Math.floor(view.x/G)*G,i=0;x<=view.x+view.w&&i<400;x+=G,i++){const major=x%(5*G)===0;grid+='<line class="grid-'+(major?'major':'minor')+'" x1="'+x+'" y1="'+f2(view.y)+'" x2="'+x+'" y2="'+f2(view.y+view.h)+'"/>'+(major?'<text class="grid-number" x="'+f2(x+3*k)+'" y="'+f2(view.y+12*k)+'" font-size="'+f2(11*k)+'">'+x/1000+'</text>':'');}
  for(let y=Math.floor(view.y/G)*G,i=0;y<=view.y+view.h&&i<400;y+=G,i++){const major=y%(5*G)===0;grid+='<line class="grid-'+(major?'major':'minor')+'" x1="'+f2(view.x)+'" y1="'+y+'" x2="'+f2(view.x+view.w)+'" y2="'+y+'"/>'+(major?'<text class="grid-number" x="'+f2(view.x+3*k)+'" y="'+f2(y-3*k)+'" font-size="'+f2(11*k)+'">'+y/1000+'</text>':'');}
  s+='<g class="grid">'+grid+'</g><polygon class="yard-fill" points="'+c.map(p=>p.x+','+p.y).join(' ')+'"/>';
  s+='<g class="stock">'+[...stock].sort((a,b)=>(a.support?1:0)-(b.support?1:0)).map(t=>'<rect class="stock'+(aff.has(t.id)||q?.ok&&q.affected?.some(a=>a.id===t.id)?' affected':'')+'" data-stock="'+esc(t.id)+'" x="'+t.x+'" y="'+t.y+'" width="'+t.w+'" height="'+t.h+'"><title>'+esc(t.name)+'</title></rect>'+(t.w/k>=40?T(t.x+t.w/2,t.y+t.h/2,10*k,esc(t.name),' class="stock-name"'):'')).join('')+'</g>';
  s+='<g class="ghosts">'+(fu?.ok&&Array.isArray(fu.moved)?fu.moved.map(mv=>{const t=stock.find(x=>x.id===mv.id);if(!t)return '';const turned=(mv.to.rotation??0)!==(mv.from.rotation??0),gw=turned?t.h:t.w,gh=turned?t.w:t.h,a={x:mv.from.x+t.w/2,y:mv.from.y+t.h/2},b={x:mv.to.x+gw/2,y:mv.to.y+gh/2};
    return '<rect class="stock-ghost" x="'+mv.to.x+'" y="'+mv.to.y+'" width="'+gw+'" height="'+gh+'"/><line class="move-arrow" x1="'+f2(a.x)+'" y1="'+f2(a.y)+'" x2="'+f2(b.x)+'" y2="'+f2(b.y)+'" marker-end="url(#shape-arrow)"/>'+(gw/k>=40?T(b.x,b.y,10*k,esc(mv.name)+(mv.from.support&&!mv.to.support?' (set down)':''),' class="stock-name"'):'');}).join(''):'')+'</g>';
  const z=q?.ok&&!q.unchanged&&q.loading?{loading:q.loading,gate:q.gate,loadingMoved:q.loadingMoved,gateMoved:q.gateMoved}:zonePlan(d);
  const boxLabel=(b,texts)=>{for(const t of texts){const px=labelPx(t,b.w,b.h,k);if(px)return T(b.x+b.w/2,b.y+b.h/2,px*k,esc(t));}return '<title>'+esc(texts[0])+'</title>';};
  const ghost=(p,...texts)=>'<g class="zone-ghost"><rect x="'+p.x+'" y="'+p.y+'" width="'+ZW+'" height="'+ZH+'"/>'+boxLabel(zb(p),texts)+'</g>';
  s+='<g class="zone-ghosts">'+(z.loadingMoved&&z.loading?ghost(z.loading,'LOADING moves here','LOADING','LOAD'):'')+(z.gateMoved&&z.gate?ghost(z.gate,'GATE moves here','GATE'):'')+'</g>';
  const zone=(which,p,txt,title)=>'<g class="zone zone-'+which+(badZones.has(which)?' bad':'')+'" data-handle="'+which+'" tabindex="0" role="button" aria-label="'+title+' at '+at(p)+'. Drag or use arrow keys to move it."><rect x="'+p.x+'" y="'+p.y+'" width="'+ZW+'" height="'+ZH+'"/>'+boxLabel(zb(p),txt==='LOADING'?[txt,'LOAD']:[txt])+'</g>';
  s+='<g class="zones">'+zone('loading',d.loading,'LOADING','Loading zone')+zone('gate',d.gate,'GATE','Gate')+d.fixtures.map((f,i)=>'<g class="fixture'+(lane(f)?' lane':'')+(badFix.has(i)?' bad':'')+'" data-handle="fixture:'+i+'" tabindex="0" role="button" aria-label="'+esc(f.name)+' at '+at(f)+'"><rect x="'+f.x+'" y="'+f.y+'" width="'+f.w+'" height="'+f.h+'"/>'+boxLabel(f,[f.name])+'</g>').join('')+'</g>';
  s+='<g class="edges">'+sides(c).map(sd=>{const i=sd.i,a=c[sd.from],b=c[sd.to],len=sd.length,mx=(a.x+b.x)/2,my=(a.y+b.y)/2,nx=len?(b.y-a.y)/len:0,ny=len?-(b.x-a.x)/len:0,deg=f2(Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI),xy='x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'"';
    return '<line class="edge'+(badSides.has(i)?' bad':'')+(movingSides.has(i)?' moving':'')+(sd.slanted?' slanted':'')+'" '+xy+'/><line class="edge-hit" data-handle="side:'+i+'" '+xy+'/>'+(len/k>=30?T(mx+nx*(1.4+1.9*Math.abs(nx))*fs,my+ny*(1.4+1.9*Math.abs(nx))*fs,fs,dimText(len),' class="dim-label" stroke-width="'+f2(3*k)+'"'):'')
      +'<g class="side-handle" data-handle="side:'+i+'" tabindex="0" role="button" aria-label="Side '+(i+1)+', '+m1(len)+' m. Drag or use arrow keys to move it; Enter adds a corner." transform="translate('+f2(mx)+' '+f2(my)+') rotate('+deg+')"><circle class="handle-hit" r="'+f2(22*k)+'"/><rect class="side-pill" x="'+f2(-9*k)+'" y="'+f2(-3.5*k)+'" width="'+f2(18*k)+'" height="'+f2(7*k)+'" rx="'+f2(3.5*k)+'"/></g>';}).join('')+'</g>';
  const bb=bbox(c),dy=bb.y0-3*fs,dx=bb.x0-3*fs;
  s+='<g class="dims"><line x1="'+bb.x0+'" y1="'+f2(dy)+'" x2="'+bb.x1+'" y2="'+f2(dy)+'"/>'+T((bb.x0+bb.x1)/2,dy-0.7*fs,fs,m1(bb.x1-bb.x0)+' m')+'<line x1="'+f2(dx)+'" y1="'+bb.y0+'" x2="'+f2(dx)+'" y2="'+bb.y1+'"/><text transform="translate('+f2(dx-0.7*fs)+' '+f2((bb.y0+bb.y1)/2)+') rotate(-90)" font-size="'+f2(fs)+'" text-anchor="middle" dominant-baseline="middle">'+m1(bb.y1-bb.y0)+' m</text></g>';
  if(u.pin){const top=d.anchor[0]==='T',px=d.anchor[1]==='L'?bb.x0:bb.x1,py=top?bb.y0:bb.y1;s+='<g class="anchor-pin"><circle cx="'+px+'" cy="'+py+'" r="'+f2(9*k)+'"/>'+T(px,py+(top?-18:20)*k,10*k,'stays')+'</g>';}
  s+='<g class="corners">'+c.map((p,i)=>'<g class="corner-handle'+(badCorners.has(i)?' bad':'')+(u.selected==='corner:'+i?' selected':'')+(movingCorners.has(i)?' moving':'')+'" data-handle="corner:'+i+'" tabindex="0" role="button" aria-label="Corner '+(i+1)+' at '+at(p)+'. Arrow keys move it, Delete removes it." transform="translate('+p.x+' '+p.y+')"><circle class="handle-hit" r="'+f2(22*k)+'"/><circle class="handle-dot" r="'+f2(7*k)+'"/><text font-size="'+f2(10*k)+'" text-anchor="middle" dominant-baseline="central">'+(i+1)+'</text></g>').join('')+'</g>';
  return s;
}

// ---------- editor markup ----------
const num=(label,field,v,min,max,step='0.1',extra='')=>'<label>'+label+'<input type="number" inputmode="decimal" data-field="'+field+'" min="'+min+'" max="'+max+'" step="'+step+'" value="'+v+'"'+extra+'></label>';
const picker=(attr,cur,label)=>'<div class="corner-picker" role="radiogroup" aria-label="'+label+'">'+CORNER_NAMES.map(([k,l])=>'<button type="button" class="secondary corner-cell" role="radio" aria-checked="'+(k===cur)+'" data-'+attr+'="'+k+'" aria-label="'+l+'"><i></i></button>').join('')+'</div>';
const lBad=p=>p.cutW>=p.w||p.cutD>=p.d||p.cutW<100||p.cutD<100;
const zonesText=d=>'Drag the yellow LOADING box and the green GATE box on the plan. Loading at '+at(d.loading)+' · gate at '+at(d.gate)+'.';
function gateNotice(d){if(!overlap(zb(d.gate),zb(d.loading)))return '';const spot=freeZone(d.corners,[zb(d.loading),...d.fixtures.filter(solid)],[{x:d.loading.x+2500,y:d.loading.y}],d.gate);return 'The gate shares the loading spot. Drag GATE to where trucks come in'+(spot?', or it moves to '+at(spot)+' when you save a shape change.':'.');}
function shapePanel(d,u,probs){
  const w=whereOf(d),c=d.corners,b=bbox(c),W=b.x1-b.x0,D=b.y1-b.y0,sl=slantedSides(c);let s='<fieldset class="shape-shape"><legend>Shape</legend>';
  if(detectPreset(c).preset==='CUSTOM'&&sl.length){const nums=sl.map(x=>x.i+1),list=nums.length>1?nums.slice(0,-1).join(', ')+' and '+nums.at(-1):'';
    s+='<div class="notice shape-squareup" id="shape-squareup"><p>This '+w+' is not a rectangle: '+(sl.length===1?'side '+nums[0]+' ('+m1(sl[0].length)+' m) runs at an angle.':'sides '+list+' run at an angle.')+'</p><button type="button" class="secondary square-up" data-preset="RECT">Make it a '+m1(W)+' × '+m1(D)+' m rectangle</button></div>';}
  s+='<div class="shape-presets" role="group" aria-label="Shape">'+[['RECT','Rectangle'],['L','L-shape'],['CUSTOM','Custom']].map(([k,l])=>'<button type="button" class="secondary" data-preset="'+k+'" aria-pressed="'+(d.preset===k)+'">'+l+'</button>').join('')+'</div>';
  if(d.preset==='RECT')s+='<div class="shape-dims">'+num('Width (m)','rect.w',m(W),2,1000)+num('Depth (m)','rect.d',m(D),2,1000)+'</div><div class="corner-pick"><span>Keep this corner where it is</span>'+picker('anchor',d.anchor,'Corner kept fixed')+'<small id="anchor-hint">'+HINTS[d.anchor]+'</small></div>';
  else if(d.preset==='L'){const p=lParams(d);s+='<div class="shape-dims">'+num('Width (m)','l.w',m(p.w),2,1000)+num('Depth (m)','l.d',m(p.d),2,1000)+num('Cut-out width (m)','l.cutW',m(p.cutW),0.1,1000)+num('Cut-out depth (m)','l.cutD',m(p.cutD),0.1,1000)+'</div><div class="corner-pick"><span>Cut-out corner</span>'+picker('cut',p.cutCorner,'Cut-out corner')+'</div><p class="error-text" id="l-error"'+(u.lError?'':' hidden')+'>The cut-out must be smaller than the yard.</p>';}
  else{const bad=new Set(probs.filter(p=>p.blocking).flatMap(p=>p.sides)),n=c.length;
    s+='<ol class="shape-sides">'+sides(c).map(sd=>{const i=sd.i,cls=[bad.has(i)?'bad':'',u.activeSide===i?'active':'',sd.slanted?'slanted':''].filter(Boolean).join(' ');
      return '<li data-side-row="'+i+'"'+(cls?' class="'+cls+'"':'')+'><span class="side-name">Side '+(i+1)+' '+(sd.slanted?'<span class="slanted-tag">slanted</span>':sd.arrow)+'</span><span class="side-len"><input id="side-len-'+i+'" type="number" inputmode="decimal" min="0.1" max="1000" step="0.1" data-field="side:'+i+'" aria-label="Side '+(i+1)+' length in metres" value="'+m(R(sd.length))+'"> m</span><span class="side-actions"><button type="button" class="text-button" data-split="'+i+'"'+(n>=d.maxCorners?' disabled':'')+'>Add corner</button> <button type="button" class="text-button" data-remove-corner="'+(i+1)%n+'"'+(n===3?' disabled':'')+'>Remove corner '+((i+1)%n+1)+'</button></span></li>';}).join('')+'</ol>';
    s+='<details class="shape-more" data-more="corners"'+(u.open?.has('corners')?' open':'')+'><summary>Corner coordinates (advanced)</summary><table class="shape-corners">'+c.map((p,i)=>'<tr data-corner-row="'+i+'"><th>'+(i+1)+'</th><td><input type="number" step="0.001" min="-1000" max="1000" data-field="cx:'+i+'" aria-label="Corner '+(i+1)+' X in metres" value="'+m(p.x)+'"></td><td><input type="number" step="0.001" min="-1000" max="1000" data-field="cy:'+i+'" aria-label="Corner '+(i+1)+' Y in metres" value="'+m(p.y)+'"></td></tr>').join('')+'</table></details>';}
  if(d.notice)s+='<p class="notice" id="shape-notice">'+esc(d.notice)+'</p>';
  return s+'</fieldset>';
}
function fixturesPanel(d,u){const full=d.fixtures.length>=20;
  return '<details class="shape-more" id="shape-fixtures" data-more="fixtures"'+(u.open?.has('fixtures')?' open':'')+'><summary>Fixtures (office, toilet, truck lanes) · '+d.fixtures.length+'</summary>'+d.fixtures.map((f,i)=>'<div class="shape-fixture" data-fixture-row="'+i+'"><select data-field="fx:'+i+':kind" aria-label="Fixture type">'+FIXTURE_TYPES.map(([k,l])=>'<option value="'+k+'"'+(f.kind===k?' selected':'')+'>'+l+'</option>').join('')+'</select><input type="text" data-field="fx:'+i+':name" maxlength="60" aria-label="Fixture name" value="'+esc(f.name)+'"><input type="number" inputmode="decimal" step="0.1" min="0.3" max="100" data-field="fx:'+i+':w" aria-label="Width in metres" value="'+m(f.w)+'"><input type="number" inputmode="decimal" step="0.1" min="0.3" max="100" data-field="fx:'+i+':h" aria-label="Depth in metres" value="'+m(f.h)+'"><button type="button" class="secondary" data-fixture-turn="'+i+'">Turn</button><button type="button" class="secondary" data-fixture-remove="'+i+'">Remove</button></div>').join('')
    +'<p class="muted">Drag a fixture on the plan to move it.</p><div class="actions">'+FIXTURE_TYPES.map(([k,l])=>'<button type="button" class="secondary" data-fixture-add="'+k+'"'+(full?' disabled':'')+'>+ '+l+'</button>').join('')+'</div></details>';}
export function editorMarkup(d,ui={},ctx={}){
  const u={...UI(),...ui},w=whereOf(d),kind=d.target.kind,stock=u.stock??ctx.stock??[],probs=ctx.problems??problems(d,{stock}),cx={...ctx,stock,problems:probs};
  const [eyebrow,title]=kind==='new'?['SET UP YOUR YARD','Draw your yard']:kind==='site'?['CHANGE SITE SHAPE &amp; SIZE',esc(d.target.name??d.name)]:['CHANGE YARD SHAPE &amp; SIZE',esc(d.target.name??d.name)];
  const st=statusOf(d,u,cx),view=u.view??fitBox(d,stock),gn=gateNotice(d);
  return '<section class="shape-editor" id="shape-editor" aria-labelledby="shape-title"><header class="shape-head"><div><div class="eyebrow">'+eyebrow+'</div><h2 id="shape-title">'+title+'</h2></div><p class="shape-size" id="shape-size">'+sizeText(d)+'</p></header>'
    +(u.conflict?'<div class="shape-conflict notice" role="alert">Someone else saved this '+w+' while you were editing. <button type="button" class="secondary" id="shape-load-theirs">Load their version</button> <button type="button" class="secondary" id="shape-save-anyway">Save mine anyway</button></div>':'')
    +'<div class="shape-body"><div class="shape-top"><label>'+(w==='site'?'Site name':'Yard name')+'<input type="text" id="shape-name" data-field="name" maxlength="250" value="'+esc(d.name)+'"></label>'+shapePanel(d,u,probs)+'</div>'
    +'<div class="shape-plan"><div class="shape-tools" role="toolbar" aria-label="Plan view"><button type="button" class="secondary" data-shape-zoom="in" aria-label="Zoom in">+</button><button type="button" class="secondary" data-shape-zoom="out" aria-label="Zoom out">−</button><button type="button" class="secondary" data-shape-zoom="fit">Fit</button><label class="shape-snap">Snap <select id="shape-snap">'+[['100','0.1 m'],['500','0.5 m'],['1000','1 m']].map(([v,l])=>'<option value="'+v+'"'+(+v===u.snap?' selected':'')+'>'+l+'</option>').join('')+'</select></label><span id="shape-readout" class="muted"></span></div>'
    +'<svg id="shape-svg" class="shape-svg" viewBox="'+[view.x,view.y,view.w,view.h].map(f2).join(' ')+'" preserveAspectRatio="xMidYMid meet" role="group" aria-label="'+(w==='site'?'Site':'Yard')+' shape plan. Drag corners and sides to change the shape.">'+planSVG(d,{...u,view},cx)+'</svg>'
    +'<p class="muted shape-hint">Drag a corner or a side. Double-tap a side, or select it and press Enter, to add a corner. Hold Shift to move one corner freely. Corner numbers match the numbers on the yard plan.</p></div>'
    +'<div class="shape-rest">'+num('Storage height limit (m)','height',m(d.height),0.1,100)
    +'<fieldset><legend>Loading zone &amp; gate</legend><p class="muted" id="zones-text">'+zonesText(d)+'</p>'+(gn?'<p class="notice" id="gate-notice">'+gn+'</p>':'')+'<details class="shape-more" data-more="zones"'+(u.open?.has('zones')?' open':'')+'><summary>Exact positions</summary><div class="form-grid">'+num('Loading zone X (m)','loading.x',m(d.loading.x),-1000,1000)+num('Loading zone Y (m)','loading.y',m(d.loading.y),-1000,1000)+num('Gate X (m)','gate.x',m(d.gate.x),-1000,1000)+num('Gate Y (m)','gate.y',m(d.gate.y),-1000,1000)+'</div></details></fieldset>'
    +(w==='yard'?fixturesPanel(d,u):'')+'</div></div>'
    +'<footer class="shape-savebar" id="shape-savebar"><div class="shape-status-wrap"><p id="shape-status" role="status" aria-live="polite" class="'+st.tone+(u.statusOpen?' expanded':'')+'">'+esc(st.text)+'</p><button type="button" class="text-button" id="shape-status-more" aria-expanded="'+!!u.statusOpen+'" hidden>'+(u.statusOpen?'Less':'More')+'</button></div>'
    +'<div class="shape-actions"><button type="button" class="secondary" id="shape-undo" aria-label="Undo" aria-keyshortcuts="Control+Z"'+(!d.history.length||u.saving?' disabled':'')+'><span aria-hidden="true">↶</span><span class="label"> Undo</span></button><button type="button" class="secondary" id="shape-redo" aria-label="Redo" aria-keyshortcuts="Control+Y"'+(!d.future.length||u.saving?' disabled':'')+'><span aria-hidden="true">↷</span><span class="label"> Redo</span></button>'
    +(kind==='new'?'':'<button type="button" class="secondary" id="shape-cancel"'+(u.saving?' disabled':'')+'>Cancel</button>')
    +'<button type="button" id="shape-save" title="'+esc(st.title)+'"'+(st.canSave?'':' disabled')+'>'+esc(st.label)+'</button></div></footer></section>';
}

// ---------- controller ----------
const stockFrom=(state,id)=>id?(state?.containers??[]).filter(c=>c.location===id&&!c.retired&&Number.isFinite(c.x)).map(c=>({id:c.id,name:c.name,...footprint(c),rotation:c.rotation??0,support:c.support??null,height:c.height})):[];
const attrSel=(name,v)=>'['+name+'="'+String(v).replace(/["\\]/g,'\\$&')+'"]';
const TERMINAL=['BLOCKED','DONE','COMPLETED','CANCELLED'];
export function createShapeEditor({target,state,account,api,command,notify,onClose}){
  const kind=target.kind,where=kind==='site'?'site':'yard';
  const locOf=s=>kind==='site'?s?.sites?.find(x=>x.id===target.id):kind==='yard'?s?.yards?.find(x=>x.id===target.id):null;
  let draft=draftFrom(kind==='new'?null:locOf(state),kind),host=null,boundHost=null,svg=null,svgRO=null,barRO=null,raf=0,frameFn=null,closed=false,keyBound=false,activitySig=null;
  const ui=UI();
  const stockList=()=>ui.stock??stockFrom(state,draft.target.id);
  const ctx=()=>{const stock=stockList();return {stock,k:ui.k,problems:problems(draft,{stock})};};
  const blocking=()=>problems(draft,{stock:stockList()}).filter(p=>p.blocking);
  const dirty=()=>isDirty(draft);
  function setDraft(next){if(next===draft)return false;const changed=sq(snap(next))!==sq(snap(draft));draft=next;if(changed){ui.seq++;ui.error=null;ui.note=null;ui.checkError=null;}return changed;}
  function record(before){if(sq(before)===sq(snap(draft)))return;draft=reduce(draft,{t:'record',before});ui.seq++;}
  const readout=t=>{const r=host?.querySelector('#shape-readout');if(r)r.textContent=t;};
  function frame(fn){frameFn=fn;if(!raf)raf=requestAnimationFrame(()=>{raf=0;const f=frameFn;frameFn=null;f?.();});}

  // ---- painting: only mount() rebuilds; typing never replaces an input ----
  function computeK(){const r=svg.getBoundingClientRect();ui.k=r.width&&r.height?Math.max(ui.view.w/r.width,ui.view.h/r.height):ui.view.w/800;}
  function fitView(){const r=svg?.getBoundingClientRect(),w=r?.width||800,h=r?.height||560;return fitBox(draft,stockList(),w,h);}
  function ensureView(){const b=bbox(draft.corners),v=ui.view;if(!v||b.x0<v.x||b.y0<v.y||b.x1>v.x+v.w||b.y1>v.y+v.h)ui.view=fitView();}
  function paintPlan(){if(!svg)return;const a=document.activeElement,had=a&&svg.contains(a)?a.closest('[data-handle]')?.dataset.handle:null;if(!ui.view)ui.view=fitView();computeK();
    svg.setAttribute('viewBox',[ui.view.x,ui.view.y,ui.view.w,ui.view.h].map(f2).join(' '));svg.innerHTML=planSVG(draft,ui,ctx());
    if(had)svg.querySelector(attrSel('data-handle',had)+'[tabindex]')?.focus({preventScroll:true});}
  function fieldValue(key){const d=draft,[a,b,c]=key.split(':');
    if(key==='name')return d.name;if(key==='height')return m(d.height);
    if(key==='rect.w'||key==='rect.d'){const bb=bbox(d.corners);return m(key==='rect.w'?bb.x1-bb.x0:bb.y1-bb.y0);}
    if(key.startsWith('l.'))return m(lParams(d)[key.slice(2)]);
    if(a==='side'){const s=sides(d.corners)[+b];return s?m(R(s.length)):null;}
    if(a==='cx'||a==='cy'){const p=d.corners[+b];return p?m(a==='cx'?p.x:p.y):null;}
    if(key.startsWith('loading.')||key.startsWith('gate.')){const [z,ax]=key.split('.');return m(d[z][ax]);}
    if(a==='fx'){const f=d.fixtures[+b];if(!f)return null;return c==='kind'?f.kind:c==='name'?f.name:m(f[c]);}
    return null;}
  function syncFields(){if(!host)return;const act=document.activeElement;
    for(const el of host.querySelectorAll('[data-field]')){if(el===act)continue;const v=fieldValue(el.dataset.field);if(v==null)continue;if(el.value!==v)el.value=v;el.removeAttribute('aria-invalid');}
    const zt=host.querySelector('#zones-text');if(zt)zt.textContent=zonesText(draft);
    const le=host.querySelector('#l-error');if(le)le.hidden=!ui.lError;
    const bad=new Set(blocking().flatMap(p=>p.sides)),sl=sides(draft.corners);
    for(const li of host.querySelectorAll('[data-side-row]')){const i=+li.dataset.sideRow;li.classList.toggle('bad',bad.has(i));li.classList.toggle('active',ui.activeSide===i);li.classList.toggle('slanted',!!sl[i]?.slanted);}}
  function paintBar(){if(!host)return;const st=statusOf(draft,ui,ctx()),p=host.querySelector('#shape-status'),save=host.querySelector('#shape-save');if(!p||!save)return;
    p.textContent=st.text;p.className=st.tone+(ui.statusOpen?' expanded':'');
    save.textContent=st.label;save.disabled=!st.canSave;save.title=st.title;
    const set=(id,off)=>{const b=host.querySelector(id);if(b)b.disabled=off;};set('#shape-undo',!draft.history.length||!!ui.saving);set('#shape-redo',!draft.future.length||!!ui.saving);set('#shape-cancel',!!ui.saving);
    if(ui.locked!==!!ui.saving){ui.locked=!!ui.saving;for(const el of host.querySelectorAll('.shape-body [data-field]'))if(el.tagName==='SELECT')el.disabled=ui.locked;else el.readOnly=ui.locked;}
    const size=host.querySelector('#shape-size');if(size)size.textContent=sizeText(draft);
    const more=host.querySelector('#shape-status-more');if(more){more.hidden=!(ui.statusOpen||p.scrollHeight>p.clientHeight+1);more.setAttribute('aria-expanded',String(!!ui.statusOpen));more.textContent=ui.statusOpen?'Less':'More';}}
  function paint(){paintPlan();syncFields();paintBar();}

  // ---- focus capture for remounts ----
  function captureFocus(){const a=document.activeElement;if(!host||!a||!host.contains(a))return null;
    let sel=null;if(a.dataset.field)sel=attrSel('data-field',a.dataset.field);else if(a.dataset.handle)sel=attrSel('data-handle',a.dataset.handle)+'[tabindex]';else if(a.id)sel='#'+a.id;else{const [k,v]=Object.entries(a.dataset)[0]??[];if(k)sel=attrSel('data-'+k.replace(/[A-Z]/g,x=>'-'+x.toLowerCase()),v);}
    if(!sel)return null;let start=null,end=null;try{start=a.selectionStart;end=a.selectionEnd;}catch{}return {sel,start,end};}
  function restoreFocus(f){if(!f||!host)return;const el=host.querySelector(f.sel);if(!el)return;el.focus({preventScroll:true});if(f.start!=null)try{el.setSelectionRange(f.start,f.end);}catch{}}

  function mount(h){
    if(closed)return;if(ui.drag)endDrag(null,false,true);// the svg holding pointer capture is replaced: finish the drag as dropped, never leave it stuck
    const same=host===h,f=same?captureFocus():null;
    if(same)for(const x of h.querySelectorAll('details[data-more]'))x.open?ui.open.add(x.dataset.more):ui.open.delete(x.dataset.more);
    host=h;const first=!ui.mounted;ui.locked=false;
    host.innerHTML=editorMarkup(draft,ui,ctx());svg=host.querySelector('#shape-svg');
    if(first){ui.mounted=true;ui.view=fitView();try{host.scrollIntoView({block:'start'});}catch{}}
    if(!keyBound){document.addEventListener('keydown',onKey);keyBound=true;}
    if(typeof ResizeObserver!=='undefined'){barRO?.disconnect();const bar=host.querySelector('#shape-savebar');barRO=new ResizeObserver(()=>document.documentElement.style.setProperty('--savebar-h',bar.offsetHeight+'px'));barRO.observe(bar);
      svgRO?.disconnect();svgRO=new ResizeObserver(()=>paintPlan());svgRO.observe(svg);}
    if(boundHost!==host)bindHost(host);bindSvg(svg);
    paint();restoreFocus(f);
    if(first){activitySig=sigOf(state);if(kind!=='new')runQuick(true);}
    flushPending();
  }
  function flushPending(){if(!ui.pendingState||ui.drag)return;const s=ui.pendingState;ui.pendingState=null;queueMicrotask(()=>update(s));}

  // ---- previews: single-flight quick and full checks, stale seq dropped ----
  function schedulePreviews(){clearTimeout(ui.timers.quick);clearTimeout(ui.timers.recheck);
    if(blocking().length||!dirty()&&kind!=='new'){ui.quick=ui.full=null;paintBar();return;}
    ui.timers.quick=setTimeout(()=>runQuick(),300);}
  async function runQuick(force=false){
    while(ui.inflight.quick){ui.want.quick=true;await ui.inflight.quick.catch(()=>{});if(closed)return null;}
    ui.want.quick=false;if(!force&&ui.quick?.seq===ui.seq&&ui.quick.gen===ui.gen)return ui.quick;
    if(blocking().length)return null;
    const seq=ui.seq,gen=ui.gen,body={...payloadOf(draft),detail:'quick'},p=api('boundary-preview',body);ui.inflight.quick=p;paintBar();let r;
    try{r=await p;}catch(e){ui.inflight.quick=null;if(closed)return null;if(seq===ui.seq&&dirty()){ui.quick=null;ui.checkError='Could not check the change; the server will check it when you save.';}paintBar();return null;}
    ui.inflight.quick=null;if(closed)return null;
    if(Array.isArray(r?.stock)&&!r.created)ui.stock=r.stock;
    if(seq!==ui.seq){paint();return null;}
    ui.quick={...r,seq,gen};ui.checkError=null;let remount=false;if(ui.full&&(ui.full.seq!==seq||ui.full.gen!==gen))ui.full=null;// a full check made against older stock is dropped
    if(r.ok===false&&/while you were editing/.test(r.message)){if(!ui.conflict){ui.conflict={};remount=true;}}
    else if(r.ok===false&&/Wait until it has been set down/.test(r.message)){clearTimeout(ui.timers.recheck);ui.timers.recheck=setTimeout(()=>{if(ui.seq===seq)runQuick(true);},2000);}
    if(r.ok&&dirty()&&r.affected?.length>=1&&r.affected.length<=60)runFull();
    if(remount&&host)mount(host);else paint();
    return ui.quick;
  }
  async function runFull(){
    while(ui.inflight.full){ui.want.full=true;await ui.inflight.full.catch(()=>{});if(closed)return null;}
    ui.want.full=false;if(ui.full?.seq===ui.seq&&ui.full.gen===ui.gen)return ui.full;
    const seq=ui.seq,gen=ui.gen,p=api('boundary-preview',{...payloadOf(draft),detail:'full'});ui.inflight.full=p;paintBar();let r;
    try{r=await p;}catch{ui.inflight.full=null;if(!closed)paintBar();return null;}
    ui.inflight.full=null;if(closed)return null;
    if(seq===ui.seq&&gen===ui.gen)ui.full={...r,seq,gen};paint();return ui.full;
  }

  // ---- edits ----
  function applyEdit(edit,{structural=false}={}){const before=snap(draft);const changed=setDraft(reduce(draft,edit));if(!changed)return false;record(before);ensureView();schedulePreviews();if(structural&&host)mount(host);else paint();return true;}
  function undoRedo(t){if(ui.saving)return;if(setDraft(reduce(draft,{t}))){ensureView();schedulePreviews();}if(host)mount(host);}
  const whyNot=which=>which==='gate'?'The gate must be inside the '+where+' and clear of the loading zone and solid fixtures':which==='loading'?'The loading zone must be inside the '+where+' and clear of the gate and solid fixtures':'Fixtures cannot overlap each other, and solid ones must stay clear of the loading zone and gate';
  const posOf=(which,d=draft)=>which==='loading'||which==='gate'?d[which]:d.fixtures[+which.slice(8)];
  const moveEdit=(which,p)=>which==='loading'||which==='gate'?{t:'zone',which,x:p.x,y:p.y}:{t:'fixture',i:+which.slice(8),patch:{x:p.x,y:p.y}};
  const zoneLabel=(which,p)=>(which==='loading'?'Loading zone':which==='gate'?'Gate':posOf(which).name)+' '+at(p);
  function addFixture(kindName){const t=FIXTURE_TYPES.find(x=>x[0]===kindName);if(!t)return;const [,,w,h]=t,d=draft,b=bbox(d.corners);
    const taken=[zb(d.loading),zb(d.gate),...d.fixtures,...stockList().map(s=>({x:s.x,y:s.y,w:s.w,h:s.h}))];
    const at_=freeSpot(d.corners,w,h,taken)??{x:Math.ceil(b.x0),y:Math.ceil(b.y0)};ui.open.add('fixtures');const det=host?.querySelector('#shape-fixtures');if(det)det.open=true;applyEdit({t:'addFixture',kind:kindName,at:at_},{structural:true});}
  function focusFirstBad(p){if(!p||!host)return;let el=null;
    if(p.corners?.length)el=svg?.querySelector(attrSel('data-handle','corner:'+p.corners[0])+'[tabindex]');
    else if(p.sides?.length)el=host.querySelector('#side-len-'+p.sides[0])??svg?.querySelector(attrSel('data-handle','side:'+p.sides[0])+'[tabindex]');
    else if(p.fixture!=null)el=host.querySelector(attrSel('data-field','fx:'+p.fixture+':name'))??svg?.querySelector(attrSel('data-handle','fixture:'+p.fixture)+'[tabindex]');
    else if(p.zone)el=svg?.querySelector(attrSel('data-handle',p.zone)+'[tabindex]');
    else if(/Height/.test(p.message))el=host.querySelector('[data-field="height"]');
    el?.focus({preventScroll:false});}

  // ---- save, cancel, conflict ----
  async function save(){
    if(ui.saving||closed)return;const block=blocking();if(block.length){paintBar();focusFirstBad(block[0]);return;}
    ui.saving='checking';ui.error=null;paintBar();clearTimeout(ui.timers.quick);
    clearTimeout(ui.timers.stock);const q=await runQuick();if(closed)return;
    if(q&&q.ok===false){ui.saving=false;if(/while you were editing/.test(q.message))ui.conflict={};if(host)mount(host);return;}
    if(ui.full?.seq===ui.seq&&ui.full.gen===ui.gen&&ui.full.ok===false){ui.saving=false;if(host)mount(host);return;}
    const n=Math.max(localAffected(draft,stockList()).size,q?.affected?.length??0);
    if(n>20&&!confirm('Saving moves '+n+' stillages to new spots. Continue?')){ui.saving=false;paintBar();return;}
    ui.saving='saving';paintBar();
    try{const r=await command(kind==='site'?'siteBoundary':'yard',payloadOf(draft));if(closed)return;ui.saving=false;onClose(r);}
    catch(e){if(closed)return;ui.saving=false;if(/while you were editing/.test(e.message))ui.conflict={};else ui.error=e.message;if(host)mount(host);}
  }
  function cancel(){if(!confirmLeave())return;onClose(null);}
  async function latestLoc(){if(ui.saving)return undefined;ui.saving='checking';paintBar();let s=null;try{s=await api('state');}catch{}ui.saving=false;if(closed)return undefined;return s?locOf(s):locOf(state);}
  async function loadTheirs(){const l=await latestLoc();if(!l){if(!closed)paintBar();return;}draft=draftFrom(l,kind);ui.conflict=null;ui.quick=ui.full=null;ui.error=null;ui.seq++;ui.note='Loaded their version.';ensureView();if(host)mount(host);runQuick(true);}
  async function saveAnyway(){if(ui.saving||!confirm('Replace their changes with yours?'))return;const l=await latestLoc();if(!l){if(!closed)paintBar();return;}draft={...draft,target:{...draft.target,shapeRev:l.shapeRev??0}};ui.conflict=null;ui.quick=ui.full=null;ui.seq++;if(host)mount(host);save();}
  function confirmLeave(){return !dirty()||confirm('Discard your changes to the '+where+' shape?');}

  // ---- field, click and focus delegation on the host ----
  function fieldEdit(key,el){
    let v,mm;if(el.type==='number'){v=el.valueAsNumber;const min=el.min!==''?+el.min:-1e6,max=el.max!==''?+el.max:1e6;if(!Number.isFinite(v)||v<min||v>max)return 'invalid';mm=R(v*1000);}else v=el.value;
    const d=draft,[a,b,c]=key.split(':');
    if(key==='name'){const t=v.trim();return t&&t.length<=250?{t:'name',value:t}:'invalid';}
    if(key==='height')return {t:'height',mm};
    if(key==='rect.w'||key==='rect.d'){const bb=bbox(d.corners);return {t:'rect',w:key==='rect.w'?mm:bb.x1-bb.x0,d:key==='rect.d'?mm:bb.y1-bb.y0,anchor:d.anchor};}
    if(key.startsWith('l.')){const p={...lParams(d),[key.slice(2)]:mm};ui.lError=lBad(p);return ui.lError?'invalid':{t:'l',w:p.w,d:p.d,cutW:p.cutW,cutD:p.cutD,cutCorner:p.cutCorner};}
    if(a==='side')return mm>0?{t:'side',i:+b,mm}:'invalid';
    if(a==='cx'||a==='cy')return {t:'cornerXY',i:+b,axis:a==='cx'?'x':'y',mm};
    if(key.startsWith('loading.')||key.startsWith('gate.')){const [z,ax]=key.split('.');return {t:'zone',which:z,x:ax==='x'?mm:d[z].x,y:ax==='y'?mm:d[z].y};}
    if(a==='fx'){const i=+b,f=d.fixtures[i];if(!f)return null;
      if(c==='name'){const t=v.trim();return t&&t.length<=60?{t:'fixture',i,patch:{name:t}}:'invalid';}
      if(c==='kind'){const t=FIXTURE_TYPES.find(x=>x[0]===v);if(!t)return 'invalid';const patch={kind:t[0],w:t[2],h:t[3]};if(FIXTURE_TYPES.some(x=>x[1]===f.name))patch.name=t[1];return {t:'fixture',i,patch};}
      return {t:'fixture',i,patch:{[c]:mm}};}
    return null;}
  function keepField(el){const v=fieldValue(el.dataset.field);if(v!=null&&el.value!==v)el.value=v;}
  function onInput(e){const el=e.target.closest?.('[data-field]');if(!el||!host.contains(el))return;if(ui.saving)return keepField(el);const edit=fieldEdit(el.dataset.field,el);
    if(edit==='invalid'){el.setAttribute('aria-invalid','true');const le=host.querySelector('#l-error');if(le)le.hidden=!ui.lError;return;}
    el.removeAttribute('aria-invalid');if(!edit)return;const le=host.querySelector('#l-error');if(le)le.hidden=!ui.lError;
    setDraft(reduce(draft,edit));paintPlan();syncFields();paintBar();}
  function onChange(e){const el=e.target;if(el.id==='shape-snap'){ui.snap=+el.value||500;return;}if(!el.dataset?.field)return;if(ui.saving)return keepField(el);
    if(ui.fieldBefore&&sq(ui.fieldBefore)!==sq(snap(draft)))record(ui.fieldBefore);ui.fieldBefore=snap(draft);ensureView();schedulePreviews();paint();}
  function onFocusIn(e){const el=e.target;if(el.dataset?.field){ui.fieldBefore=snap(draft);const k=el.dataset.field;const side=k.startsWith('side:')?+k.slice(5):null,pin=k.startsWith('rect.');if(side!==ui.activeSide||pin!==ui.pin){ui.activeSide=side;ui.pin=pin;paintPlan();syncFields();}}
    else if(el.dataset?.anchor&&!ui.pin){ui.pin=true;paintPlan();}}
  function onFocusOut(e){const el=e.target;if(!el.dataset?.field&&!el.dataset?.anchor)return;const next=e.relatedTarget;
    if(next&&(next.dataset?.field?.startsWith('rect.')||next.dataset?.anchor))return;
    if(next?.dataset?.field?.startsWith('side:'))return;
    const had=ui.pin||ui.activeSide!=null||ui.lError;ui.pin=false;ui.activeSide=null;ui.lError=false;if(el.dataset?.field)ui.fieldBefore=null;
    if(had){paintPlan();}queueMicrotask(()=>{if(host&&!closed)syncFields();});}
  function onClick(e){const b=e.target.closest?.('button');if(!b||!host.contains(b)||b.disabled)return;const ds=b.dataset;if(ui.drag)endDrag(null,false);
    if(ds.shapeZoom)return zoom(ds.shapeZoom);
    if(b.id==='shape-undo')return undoRedo('undo');if(b.id==='shape-redo')return undoRedo('redo');
    if(b.id==='shape-status-more'){ui.statusOpen=!ui.statusOpen;return paintBar();}
    if(b.id==='shape-cancel')return cancel();if(b.id==='shape-save')return save();
    if(b.id==='shape-load-theirs')return loadTheirs();if(b.id==='shape-save-anyway')return saveAnyway();
    if(ui.saving)return;
    if(ds.preset)return void applyEdit({t:'preset',p:ds.preset},{structural:true});
    if(ds.anchor){const bb=bbox(draft.corners);return void applyEdit({t:'rect',w:bb.x1-bb.x0,d:bb.y1-bb.y0,anchor:ds.anchor},{structural:true});}
    if(ds.cut){const p=lParams(draft);return void applyEdit({t:'l',w:p.w,d:p.d,cutW:p.cutW,cutD:p.cutD,cutCorner:ds.cut},{structural:true});}
    if(ds.split!==undefined)return void applyEdit({t:'split',i:+ds.split},{structural:true});
    if(ds.removeCorner!==undefined)return void applyEdit({t:'remove',i:+ds.removeCorner},{structural:true});
    if(ds.fixtureAdd)return addFixture(ds.fixtureAdd);
    if(ds.fixtureRemove!==undefined)return void applyEdit({t:'removeFixture',i:+ds.fixtureRemove},{structural:true});
    if(ds.fixtureTurn!==undefined)return void applyEdit({t:'turnFixture',i:+ds.fixtureTurn},{structural:true});}
  function bindHost(h){boundHost=h;h.addEventListener('input',onInput);h.addEventListener('change',onChange);h.addEventListener('focusin',onFocusIn);h.addEventListener('focusout',onFocusOut);h.addEventListener('click',onClick);}

  // ---- plan: pointer, wheel, keyboard ----
  function toMM(e){const pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;return pt.matrixTransform(svg.getScreenCTM().inverse());}
  const snapV=v=>R(v/ui.snap)*ui.snap;
  const normalOf=(pts,i)=>{const a=pts[i],b=pts[(i+1)%pts.length],len=Math.hypot(b.x-a.x,b.y-a.y)||1;return {x:(b.y-a.y)/len,y:-(b.x-a.x)/len};};
  function setView(v){ui.view=v;svg.setAttribute('viewBox',[v.x,v.y,v.w,v.h].map(f2).join(' '));computeK();}
  function zoomAbout(p,factor){const v=ui.view,fit=fitView(),w=Math.min(Math.max(v.w*factor,2000),fit.w*6),f=w/v.w;setView({x:p.x-(p.x-v.x)*f,y:p.y-(p.y-v.y)*f,w,h:v.h*f});paintPlan();}
  function zoom(which){if(!svg)return;if(which==='fit'){ui.view=fitView();return paintPlan();}const v=ui.view;zoomAbout({x:v.x+v.w/2,y:v.y+v.h/2},which==='in'?1/1.25:1.25);}
  function onPointerDown(e){if(ui.drag&&e.pointerId===ui.drag.pointerId)endDrag(null,false);// a lost pointerup never leaves a drag stuck
    if(e.button!==0||ui.drag||ui.saving)return;const h=e.target.closest('[data-handle]');e.preventDefault();
    const a=document.activeElement;if(a&&host.contains(a)&&!svg.contains(a))a.blur();// the field's change/focusout run now, before the drag starts
    try{svg.setPointerCapture(e.pointerId);}catch{}
    const key=h?h.dataset.handle:'pan';ui.drag={key,pointerId:e.pointerId,start:toMM(e),client:{x:e.clientX,y:e.clientY},view:{...ui.view},before:snap(draft),preset:draft.preset,moved:false,lastValid:null,seq0:ui.seq,quick0:ui.quick,full0:ui.full,meta0:{error:ui.error,note:ui.note,checkError:ui.checkError}};
    if(h){ui.selected=key;const f=svg.querySelector(attrSel('data-handle',key)+'[tabindex]');f?.focus({preventScroll:true});}}
  function onPointerMove(e){const d=ui.drag;if(!d||e.pointerId!==d.pointerId)return;
    if(!d.moved){if(Math.hypot(e.clientX-d.client.x,e.clientY-d.client.y)<4)return;d.moved=true;if(d.key==='pan')svg.classList.add('panning');}
    if(d.key==='pan'){const k=ui.k??d.view.w/800;setView({...d.view,x:d.view.x-(e.clientX-d.client.x)*k,y:d.view.y-(e.clientY-d.client.y)*k});return frame(paintPlan);}
    const pt=toMM(e),dx=pt.x-d.start.x,dy=pt.y-d.start.y,b=d.before,base=fromSnap(draft,b),[kind_,idx]=d.key.split(':'),i=+idx;
    if(kind_==='corner'){const p=b.corners[i];setDraft(reduce(base,{t:'corner',i,x:snapV(p.x+dx),y:snapV(p.y+dy),square:!e.shiftKey&&axisAligned(b.corners)}));const c=draft.corners,n=c.length,sd=sides(c);readout('Corner '+(i+1)+' · '+at(c[i])+' · side '+((i+n-1)%n+1)+' '+m1(sd[(i+n-1)%n].length)+' m · side '+(i+1)+' '+m1(sd[i].length)+' m');}
    else if(kind_==='side'){const nv=normalOf(b.corners,i),dist=R((dx*nv.x+dy*nv.y)/ui.snap)*ui.snap;setDraft(dist?reduce(base,{t:'push',i,d:dist}):base);readout('Side '+(i+1)+(dist?' moved '+m1(Math.abs(dist))+' m '+(dist>0?'out':'in'):' · '+m1(sides(draft.corners)[i].length)+' m'));}
    else{const old=posOf(d.key,b),cand={x:snapV(old.x+dx),y:snapV(old.y+dy)};
      if(canPlace(base,d.key,cand)){d.lastValid=cand;ui.dragBad=null;setDraft(reduce(base,moveEdit(d.key,cand)));readout(zoneLabel(d.key,cand));}
      else{ui.dragBad=d.key;setDraft(d.lastValid?reduce(base,moveEdit(d.key,d.lastValid)):base);readout(whyNot(d.key));}}
    frame(()=>{paintPlan();syncFields();paintBar();});}
  function endDrag(e,cancelled,quiet=false){const d=ui.drag;if(!d)return;if(e&&e.pointerId!==d.pointerId)return;try{svg.releasePointerCapture(d.pointerId);}catch{}svg.classList.remove('panning');ui.drag=null;ui.dragBad=null;
    if(raf){cancelAnimationFrame(raf);raf=0;frameFn=null;}
    if(cancelled&&d.key!=='pan'){setDraft(fromSnap(draft,d.before));d.moved=false;}
    if(d.key!=='pan'&&ui.seq!==d.seq0&&sq(snap(draft))===sq(d.before)){// back where it started: the checks made before the drag still hold
      const back=r=>r&&r.seq===d.seq0?{...r,seq:ui.seq}:null,q=back(d.quick0);if(q){ui.quick=q;ui.full=back(d.full0);Object.assign(ui,d.meta0);}else if(!d.moved)schedulePreviews();}
    let remount=false;
    if(d.key!=='pan'){
      if(d.moved){record(d.before);ensureView();schedulePreviews();}
      else if(e&&!cancelled&&d.key.startsWith('side:')){/* a real tap only, never a drag finished by a remount or a click */const now=Date.now();if(ui.lastTap.key===d.key&&now-ui.lastTap.time<350){const before=snap(draft);if(setDraft(reduce(draft,{t:'split',i:+d.key.slice(5)}))){record(before);schedulePreviews();remount=true;}ui.lastTap={key:null,time:0};}else ui.lastTap={key:d.key,time:now};}
      if(draft.preset!==d.preset)remount=true;}
    if(quiet)return;
    if(remount&&host)mount(host);else paint();
    if(ui.pendingState){const s=ui.pendingState;ui.pendingState=null;update(s);}}
  function onWheel(e){if(!ui.view)return;e.preventDefault();zoomAbout(toMM(e),e.deltaY>0?1.15:1/1.15);}
  function onSvgKey(e){const h=e.target.closest?.('[data-handle]');if(!h||ui.saving||ui.drag)return;const key=h.dataset.handle,[k_,idx]=key.split(':'),i=+idx;
    const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]},dir=arrows[e.key],step=e.shiftKey?1000:100;
    if(dir){e.preventDefault();const pre=draft.preset,dx=dir[0]*step,dy=dir[1]*step;
      if(k_==='corner'){const p=draft.corners[i];applyEdit({t:'corner',i,x:p.x+dx,y:p.y+dy,square:true},{structural:false});}
      else if(k_==='side'){const nv=normalOf(draft.corners,i),dot=dir[0]*nv.x+dir[1]*nv.y;if(Math.abs(dot)>=Math.SQRT1_2-1e-9)applyEdit({t:'push',i,d:Math.sign(dot)*step});}
      else{const old=posOf(key),cand={x:old.x+dx,y:old.y+dy};if(canPlace(draft,key,cand))applyEdit(moveEdit(key,cand));else readout(whyNot(key));}
      if(host&&draft.preset!==pre)mount(host);return;}
    if((e.key==='Delete'||e.key==='Backspace')&&k_==='corner'){e.preventDefault();applyEdit({t:'remove',i},{structural:true});return;}
    if(e.key==='Enter'&&k_==='side'){e.preventDefault();applyEdit({t:'split',i},{structural:true});}}
  function bindSvg(s){s.addEventListener('pointerdown',onPointerDown);s.addEventListener('pointermove',onPointerMove);s.addEventListener('pointerup',e=>endDrag(e,false));s.addEventListener('pointercancel',e=>endDrag(e,true));s.addEventListener('lostpointercapture',e=>{if(ui.drag&&e.pointerId===ui.drag.pointerId)endDrag(e,false);});s.addEventListener('wheel',onWheel,{passive:false});s.addEventListener('keydown',onSvgKey);}
  function onKey(e){if(closed)return;if(e.key==='Escape'&&ui.drag){e.preventDefault();endDrag(null,true);return;}
    if(ui.drag)return;const t=e.target,tag=t?.tagName;if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'||!(e.ctrlKey||e.metaKey))return;const k=e.key.toLowerCase();
    if(k==='z'&&!e.shiftKey){e.preventDefault();undoRedo('undo');}else if(k==='z'&&e.shiftKey||k==='y'){e.preventDefault();undoRedo('redo');}}

  // ---- poll integration ----
  function sigOf(s){const id=draft.target.id;if(!id)return '';
    const tasks=(s?.tasks??[]).filter(t=>(t.to===id||t.from===id||t.handling===id)&&!TERMINAL.slice(1).includes(t.state)).map(t=>t.id+':'+t.state);
    const res=(s?.resources??[]).filter(r=>r.location===id).map(r=>r.id+':'+(r.cargo??'')+':'+(r.drive?1:0));
    const cs=(s?.containers??[]).filter(c=>c.location===id).map(c=>c.id+':'+c.x+':'+c.y);return tasks.join(',')+'|'+res.join(',')+'|'+cs.join(',');}
  function update(s){
    if(closed)return;if(ui.drag){ui.pendingState=s;return;}state=s;if(ui.saving||kind==='new')return;
    const l=locOf(s);if(!l||kind==='site'&&l.status&&l.status!=='ACTIVE'){closed=true;notify(kind==='site'?'This site is no longer active. The editor was closed.':'This yard is no longer available. The editor was closed.');onClose(null);return;}
    const rev=l.shapeRev??0;if(rev<draft.target.shapeRev)return;// an older snapshot than the shape already loaded
    if(rev!==draft.target.shapeRev){
      if(!dirty()){draft=draftFrom(l,kind);ui.conflict=null;ui.quick=ui.full=null;ui.seq++;ui.note='Updated to the latest saved shape.';ensureView();if(host)mount(host);runQuick(true);}
      else if(ui.conflict?.shapeRev!==rev){ui.conflict={shapeRev:rev};if(host)mount(host);}
      return;}
    const sig=sigOf(s);if(sig!==activitySig){activitySig=sig;ui.gen++;clearTimeout(ui.timers.stock);ui.timers.stock=setTimeout(()=>{if(!closed&&!ui.saving)runQuick();},300);}
  }
  function destroy(){closed=true;for(const t of Object.values(ui.timers))clearTimeout(t);if(raf&&typeof cancelAnimationFrame!=='undefined')cancelAnimationFrame(raf);raf=0;
    barRO?.disconnect();svgRO?.disconnect();barRO=svgRO=null;
    if(keyBound){document.removeEventListener('keydown',onKey);keyBound=false;document.documentElement.style.removeProperty('--savebar-h');}}
  return {get target(){return target;},dirty,confirmLeave,mount,update,destroy,get draft(){return draft;}};
}
