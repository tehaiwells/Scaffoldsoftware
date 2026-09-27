// Home world map ("director cam district map"): the yard and every site the viewer may see on one isometric district of streets and houses, each place
// at the scale of its own plan. Trucks drive the road their trip was timed on (public/world-layout.js, shared with the server), smoothly between polls;
// the site crane lifts the load off; a director camera frames whatever is happening, or the owner pans and zooms freely.
// The map owns one persistent DOM tree (the stage). operations.js renders an empty host (wmShell), reports live changes through a tiny part (wmSignal)
// and calls wmAttach after every render or patch; wmAttach moves the stage into the host and patches only what changed. Static scenery (ground,
// streets, houses, trees) is built once per layout; the yard, each site and each truck are live layers; requestAnimationFrame runs only while
// something moves. No DOM access at module level: the string builders run in Node tests.
import {esc,num,DEFAULT_VIEW,planLinear,yardSVG,workerFigure,truckDims,STATUS_COLOURS,projection,block,poly,box4,shade,shadowOf,walls,quad,onWall,defsSVG,packSVG,truckSVG,textW,labelBand,labelRoom} from './visual.js';
import {WORLD,worldLayout,nodeAt,restPoses,routeGeom,poseAt,distanceAt,worldRoute,truckTotal,routeFits,placePoint,placeRect,bayPose} from './world-layout.js';

const SVGNS='http://www.w3.org/2000/svg',S=WORLD.street,G=-260,R=Math.round,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// The map's projection follows the yard plan's "Turn view" and "3D view" (operations.js planView): L plan -> screen, E the daylight kit for it.
// VK counts projection changes, so everything drawn for the old one is rebuilt.
let VIEW={rotate:0,tilt:true},L,E,LOW,VK=0;
function setProjection(v){const rotate=((Number(v?.rotate)||0)%360+360)%360,tilt=v?.tilt!==false;if(L&&rotate===VIEW.rotate&&tilt===VIEW.tilt)return false;VIEW={rotate,tilt};L=planLinear({...DEFAULT_VIEW,rotate,tilt});E=projection(L,tilt?0.9:0.22);LOW=E.up(G);VK++;return true;}
setProjection({rotate:0,tilt:true});
const P=p=>R(p.x)+' '+R(p.y),add=(p,v)=>({x:p.x+v.x,y:p.y+v.y}),lerp=(p,q,u)=>({x:p.x+(q.x-p.x)*u,y:p.y+(q.y-p.y)*u}),up=h=>E.up(h),at=(p,h)=>add(p,up(h));
const proj=p=>({x:L[0]*p.x+L[2]*p.y,y:L[1]*p.x+L[3]*p.y});
const hash=(...n)=>{let h=2166136261;for(const v of n){h^=(v|0)+0x9e3779b9;h=Math.imul(h,16777619);h^=h>>>13;}return ((h>>>0)%100003)/100003;};
const strHash=s=>{let h=0;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0;};
const isOps=a=>!!a?.permissions?.includes('operations.manage');
// User Timing marks (wm-build, wm-attach, wm-frame) for measuring the map in a browser's performance panel; cleared now and then so they never pile up.
let marks=0;const measure=(name,t0)=>{if(typeof performance==='undefined'||typeof performance.measure!=='function')return;try{performance.measure(name,{start:t0});if(++marks>600){marks=0;for(const n of ['wm-build','wm-attach','wm-frame','wm-pic','wm-commit'])performance.clearMeasures(n);}}catch{}};

// ---------------------------------------------------------------- the snapshot's world block
// Home polls /api/state?world=REVS (src/domain/world.js worldSnapshot): stillages in groups by location (a site, a truck, a crane hook), each a
// short array, and only the groups whose revision changed since the last poll. wmWorldMerge rebuilds the full list from the groups kept here.
// The merged block keeps the stillages out of JSON (a non-enumerable items), so the page's change check compares the revisions, not every stillage.
const wmExpand=(r,loc)=>({id:r[0],name:r[1],type:r[2],condition:r[3],location:loc,x:r[4],y:r[5],rotation:r[6],support:r[7],envelopeLength:r[8],envelopeWidth:r[9],height:r[10],pcs:r[11],lines:r[12]});
let wCache=null;
export function wmWorldQuery(who){return wCache&&wCache.who===who&&wCache.map.size?[...wCache.map.keys()].join('.'):'1';}
export function wmWorldMerge(w,who){if(!w||!Array.isArray(w.groups))return w;const prev=wCache?.who===who?wCache.map:new Map(),map=new Map(),items=[],revs={};
 for(const g of w.groups){const list=g.same?prev.get(g.rev):(g.items??[]).map(r=>wmExpand(r,g.loc));if(!list)continue;map.set(g.rev,list);revs[g.loc]=g.rev;for(const c of list)items.push(c);}
 const out={bw:w.bw,bh:w.bh,lots:w.lots,revs};Object.defineProperty(out,'items',{value:items,enumerable:false});wCache={who,map,world:out};return out;}
// The last world block this browser had (the Home map before its first poll after coming back from another page).
export const wmLastWorld=who=>wCache?.who===who?wCache.world:null;
const itemsOf=st=>st?.world?.items??[];
const pcsOf=c=>c.pcs??(c.lines??[]).reduce((m,x)=>m+x[1],0);
// Long names are shortened on the map (the card and the tooltip keep the full name).
const short=(t,n=22)=>t.length>n?t.slice(0,n-1).trimEnd()+'\u2026':t;

// ---------------------------------------------------------------- layout from the snapshot
// The server's lots and block size when the snapshot has them (a supervisor sees only some sites, but draws them where everybody does).
export function wmLayout(state){
 const w=state?.world,yard=state?.yards?.[0]??w?.yard??null,sites=(state?.sites??[]).filter(s=>s.status==='ACTIVE'||(w?.lots&&w.lots[s.id]));
 if(!yard&&!sites.length)return null;return worldLayout(yard,sites,w?.bw?{bw:w.bw,bh:w.bh,lots:w.lots}:null);}
const layoutSig=l=>l?l.bw+'|'+l.bh+'|'+l.places.map(p=>p.id+':'+p.col+':'+p.row+':'+p.ox+':'+p.oy+':'+(p.archived?'a':'')+strHash(JSON.stringify([p.src.points,p.src.fixtures??null,p.src.parking??null,p.src.gate??null,p.src.loading??null,p.src.name]))).join(','):'';
const lotOf=(l,x,y)=>({c:Math.floor(x/l.pw),r:Math.floor(y/l.ph)});

// ---------------------------------------------------------------- static scenery (built once per layout)
const PAL={walls:['#e2d3b1','#c98363','#ece7dc','#d1d5cf','#d9b98f','#b9a58a'],roofs:['#b85a3c','#4b5157','#d9d8cf','#3f5d4b','#8b4a36','#6d7479'],trim:'#f7f4ec'};
const DEFS_EXTRA='<pattern id="wm-paving" width="1500" height="1500" patternUnits="userSpaceOnUse"><rect width="1500" height="1500" fill="#d7d2c5"/><path d="M0 0H1500M0 0V1500" stroke="#c3bdaf" stroke-width="30"/></pattern>'
 +'<pattern id="wm-dirt" width="2400" height="2400" patternUnits="userSpaceOnUse"><rect width="2400" height="2400" fill="#c8b596"/><path d="M200 300h1M900 150h1M1600 600h1M2200 250h1M500 1100h1M1300 900h1M2000 1400h1M300 1900h1M1100 2100h1M1800 2000h1M700 1600h1" stroke="#a8946f" stroke-width="60" stroke-linecap="round"/><path d="M400 700h1M1500 1300h1M2100 900h1M900 1800h1" stroke="#e0d2b6" stroke-width="50" stroke-linecap="round"/><path d="M0 1200c500-120 900 100 1400-40s700 60 1000-20" stroke="#b9a582" stroke-opacity=".35" stroke-width="140" fill="none"/></pattern>'
 +'<pattern id="wm-shadecloth" width="220" height="220" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="220" height="220" fill="#2f5d45" fill-opacity=".78"/><path d="M0 0H220M0 0V220" stroke="#244a37" stroke-width="30"/></pattern>';
// One gum tree, a billboard like the yard plan's street trees.
function treeSVG(p,sz=1,v=0){const g=add(p,LOW),col=[['#557a35','#4a6c2e','#79a146'],['#6a8a45','#587a38','#8fae5a'],['#4f7a4a','#436a3f','#6f9a60']][v%3];return '<g transform="translate('+R(g.x)+' '+R(g.y)+') '+E.bb+' scale('+sz.toFixed(2)+')" pointer-events="none"><ellipse cx="650" cy="160" rx="1350" ry="480" fill="#2a1d08" fill-opacity=".2"/><path d="M0 60V-1400" stroke="#6b4a2b" stroke-width="230" stroke-linecap="round"/><circle cy="-2350" r="1250" fill="'+col[0]+'"/><circle cx="420" cy="-2000" r="820" fill="'+col[1]+'"/><circle cx="-380" cy="-2700" r="760" fill="'+col[2]+'"/></g>';}
// A brick-veneer house with a hip roof, windows on the sunny faces and a garage door facing the street (front: 1 = +y, -1 = -y).
function houseSVG(x,y,w,d,front,v){const H=2900,rh=1700+R(v*600),ov=450,wall=PAL.walls[R(v*97)%PAL.walls.length],roof=PAL.roofs[R(v*131)%PAL.roofs.length],cs=box4(x,y,w,d),base=G;
 let s=shadowOf(E,cs,H+rh,.22,LOW)+block(E,cs,base,base+H,wall,null,'#4a4136',18);
 for(const q of walls(E,cs)){const len=Math.hypot(q.q.x-q.p.x,q.q.y-q.p.y),n=Math.max(1,Math.floor(len/3200)),facing=(q.i===2&&front>0)||(q.i===0&&front<0);
  for(let k=0;k<n;k++){const u0=(k+.25)/n,u1=(k+.75)/n;if(facing&&k===0&&n>1){s+=quad(E,q,(k+.12)/n,(k+.88)/n,base+60,base+2200,'fill="#ece8df" stroke="#8a8375" stroke-width="30"')+'<path d="M'+P(onWall(E,q,(k+.12)/n,base+800))+'L'+P(onWall(E,q,(k+.88)/n,base+800))+'M'+P(onWall(E,q,(k+.12)/n,base+1500))+'L'+P(onWall(E,q,(k+.88)/n,base+1500))+'" stroke="#bdb6a8" stroke-width="30"/>';continue;}
   s+=quad(E,q,u0,u1,base+900,base+2200,'fill="#2e4a5a" stroke="'+PAL.trim+'" stroke-width="70"');}}
 const t=up(base+H),T=up(base+H+rh),A={x:x-ov,y:y-ov},B={x:x+w+ov,y:y-ov},C={x:x+w+ov,y:y+d+ov},D={x:x-ov,y:y+d+ov},long=w>=d,k=(long?d:w)/2+ov,r1=long?{x:x+k-ov,y:y+d/2}:{x:x+w/2,y:y+k-ov},r2=long?{x:x+w-k+ov,y:y+d/2}:{x:x+w/2,y:y+d-k+ov};
 const faces=long?[[A,B,r2,r1],[B,C,r2],[C,D,r1,r2],[D,A,r1]]:[[A,B,r1],[B,C,r2,r1],[C,D,r2],[D,A,r1,r2]],lift=p=>p===r1||p===r2?add(p,T):add(p,t);
 const lit=f=>{const c=f.reduce((a,p)=>({x:a.x+p.x/f.length,y:a.y+p.y/f.length}),{x:0,y:0}),n={x:c.x-(x+w/2),y:c.y-(y+d/2)},m=proj(n),l=Math.hypot(m.x,m.y)||1;return clamp(.86-.2*(m.x+m.y*.6)/l,.62,1.08);};
 for(const f of faces.map(f=>({f,dep:E.depth(f.reduce((a,p)=>({x:a.x+p.x,y:a.y+p.y}),{x:0,y:0}))})).sort((a,b)=>a.dep-b.dep).map(o=>o.f)){const pts=f.map(lift);s+=poly(pts,'fill="'+shade(roof,lit(f))+'" stroke="'+shade(roof,.55)+'" stroke-width="26" stroke-linejoin="round"');}
 return s;}
// Streets: footpaths, the carriageway with kerbs and a dashed centre line; one grid for the whole district.
// The ground of one lot (c,r): grass, the street below its block and the street to its right (footpaths, carriageway, kerbs, centre lines, a zebra
// crossing at the corner), inside the district's extent. One picture per lot keeps each picture small, so only what is in view is drawn.
function groundCell(l,ext,c,r,drive){const {X0,X1,Y0,Y1}=ext,{pw,ph,bw,bh}=l,o=WORLD.foot,cw=S-2*o,gx0=Math.max(X0,c*pw),gx1=Math.min(X1,(c+1)*pw),gy0=Math.max(Y0,r*ph),gy1=Math.min(Y1,(r+1)*ph);if(gx1<=gx0||gy1<=gy0)return null;
 const hy=r*ph+bh,vx=c*pw+bw;let s='<rect x="'+gx0+'" y="'+gy0+'" width="'+(gx1-gx0)+'" height="'+(gy1-gy0)+'" fill="url(#grass)"/>',foot='',road='',kerb='',dash='',zebra='';
 if(hy>=gy0&&hy<gy1){foot+='<rect x="'+gx0+'" y="'+hy+'" width="'+(gx1-gx0)+'" height="'+S+'"/>';road+='<rect x="'+gx0+'" y="'+(hy+o)+'" width="'+(gx1-gx0)+'" height="'+cw+'"/>';kerb+='M'+gx0+' '+(hy+o)+'H'+gx1+'M'+gx0+' '+(hy+o+cw)+'H'+gx1;const a=Math.max(gx0,c*pw+600),b=c*pw+bw-600;if(b>a)dash+='M'+a+' '+(hy+S/2)+'H'+b;}
 if(vx>=gx0&&vx<gx1){foot+='<rect x="'+vx+'" y="'+gy0+'" width="'+S+'" height="'+(gy1-gy0)+'"/>';road+='<rect x="'+(vx+o)+'" y="'+gy0+'" width="'+cw+'" height="'+(gy1-gy0)+'"/>';kerb+='M'+(vx+o)+' '+gy0+'V'+gy1+'M'+(vx+o+cw)+' '+gy0+'V'+gy1;const a=Math.max(gy0,r*ph+600),b=r*ph+bh-600;if(b>a)dash+='M'+(vx+S/2)+' '+a+'V'+b;}
 if(hy>=gy0&&hy<gy1&&vx>=gx0&&vx<gx1)if(hash(vx,hy,7)<.35){for(let k=0;k<7;k++){const yy=hy+o+400+k*1050;zebra+='M'+(vx-2200)+' '+yy+'h1700';}}
 s+='<g fill="url(#wm-paving)">'+foot+'</g><g fill="url(#asphalt)">'+road+'</g>'+(kerb?'<path d="'+kerb+'" stroke="#e4ded0" stroke-width="200" fill="none"/><path d="'+kerb+'" stroke="#8a8474" stroke-width="50" stroke-opacity=".7" fill="none"/>':'')+(dash?'<path d="'+dash+'" stroke="#f4f1e6" stroke-width="130" stroke-dasharray="1500 1100" fill="none"/>':'')+(zebra?'<path d="'+zebra+'" stroke="#f2efe4" stroke-width="600" fill="none" stroke-opacity=".9"/>':'')+(drive?'<g fill="#d3cdbf" stroke="#bdb6a6" stroke-width="40">'+drive+'</g>':'');
 const m=400;return {svg:'<g transform="translate('+R(LOW.x)+' '+R(LOW.y)+')">'+s+'</g>',box:[gx0+LOW.x-m,gy0+LOW.y-m,gx1-gx0+2*m,gy1-gy0+2*m].map(R)};}
// Everything static for one layout: {ground, blocks: Map diag -> svg}. Houses fill the empty blocks, trees the margins; the fronts of places stay clear.
export function wmStatic(l){
 const {c0,c1,r0,r1}=l.range,C0=c0-1,C1=c1+1,R0=r0-1,R1=r1+1,X0=C0*l.pw-S,X1=(C1+1)*l.pw,Y0=R0*l.ph-S,Y1=(R1+1)*l.ph,ext={X0,X1,Y0,Y1,C0,C1,R0,R1};
 const placeAt=new Map(l.places.map(p=>[p.col+','+p.row,p])),front=new Set(l.places.map(p=>p.col+','+p.streetRow));
 const drives=new Map(),cellOf=(x,y)=>Math.floor(x/l.pw)+','+Math.floor(y/l.ph);let drive='';const addDrive=(x,y,svg)=>{const k=cellOf(x,y);drives.set(k,(drives.get(k)??'')+svg);};
 const blocks=new Map(),cells=[],put=(k,b)=>blocks.set(k,b);
 for(let r=R0;r<=R1;r++)for(let c=C0;c<=C1;c++){const x0=c*l.pw,y0=r*l.ph,x1=x0+l.bw,y1=y0+l.bh,items=[],inner=c>=c0&&c<=c1&&r>=r0&&r<=r1,place=placeAt.get(c+','+r);
  const tree=(x,y,sz,v)=>items.push({dep:E.depth({x,y}),svg:treeSVG({x,y},sz,v)});
  // street trees on this block's footpaths (not along the front of a place, where the trucks stop, nor across the street from one)
  const across=front.has(c+','+(r-1)),mine=front.has(c+','+r);
  for(let x=x0+5000;x<x1-4000;x+=15000+R(hash(c,r,x)*3000)){if(!mine&&hash(c,r,x,1)<.85)tree(x,y1+900,.72+hash(c,r,x)*.2,R(hash(x,r)*3));if(!across&&hash(c,r,x,2)<.85)tree(x,y0-900,.72+hash(c,r,x,3)*.2,R(hash(x,c)*3));}
  if(!inner){for(let k=0;k<4;k++){if(hash(c,r,k,9)<.55)tree(x0+4000+hash(c,r,k)*(l.bw-8000),y0+4000+hash(r,c,k)*(l.bh-8000),.8+hash(k,c,r)*.35,k);}}
  else if(!place){// a suburban block: two rows of houses back to back, the front row facing the street below, the back row the street above
   const n=Math.max(2,Math.floor(l.bw/16000)),lw=l.bw/n;for(let row=0;row<2;row++)for(let i=0;i<n;i++){const v=hash(c,r,i,row),w=R(Math.min(lw-5000,10500+v*2500)),dd=R(10500+hash(c,r,i,row,5)*2500),x=R(x0+i*lw+(lw-w)/2+(hash(i,r,c)-.5)*1200),yf=row===0?y1-6000-dd:y0+6000,y=R(yf),fr=row===0?1:-1;
    items.push({dep:E.depth({x:x+w/2,y:y+dd/2}),svg:houseSVG(x,y,w,dd,fr,v)});
    const gx=x+(hash(c,i,row)<.5?600:w-3600);drive=row===0?'<rect x="'+R(gx)+'" y="'+(y+dd)+'" width="3000" height="'+(y1-(y+dd))+'"/>':'<rect x="'+R(gx)+'" y="'+y0+'" width="3000" height="'+(y-y0)+'"/>';addDrive(x0+1,y0+1,drive);
    if(hash(c,r,i,row,8)<.7)tree(x+w*.5+(hash(i,c)-.5)*w*.6,row===0?y-3500:y+dd+3500,.85+hash(r,i)*.3,i+row);}}
  else if(place.kind==='yard'){// trees in the side margins and behind the yard
   const e=place.ext;for(let y=e.y0;y<e.y1-2000;y+=9000){if(e.x0-x0>6500)tree(x0+2600+hash(c,y)*1500,y+2000,.85,R(y/9000));if(x1-e.x1>6500&&!(place.bay&&y<place.bay.y+place.bay.length+4000))tree(x1-2600-hash(y,c)*1500,y+2000,.85,R(y/7000));}
   for(let x=e.x0;x<e.x1;x+=11000)if(e.y0-y0>6000)tree(x+3000,y0+2500+hash(x)*1500,.9,R(x/11000));}
  else{// a site block: trees at the back corners; the building and the shed belong to the site layer
   const e=place.ext;if(e.x0-x0>6000)tree(x0+2500,y0+3000,.95,1);if(x1-e.x1>6000)tree(x1-2500,y0+3500,.9,2);}
  items.sort((a,b)=>a.dep-b.dep);if(items.length){const cs=[{x:x0-S,y:y0-S},{x:x1+S,y:y0-S},{x:x1+S,y:y1+S},{x:x0-S,y:y1+S}].map(proj),top=proj(up(12000));
   // bb: the block's screen box (plan units projected) for culling; box: the plan rectangle an image of the block needs (street trees on the
   // footpaths around it, everything lifted by up to 12 m and its shadow)
   put(c+','+r,{c,r,svg:items.map(o=>o.svg).join(''),bb:[Math.min(...cs.map(p=>p.x)),Math.min(...cs.map(p=>p.y))+top.y,Math.max(...cs.map(p=>p.x)),Math.max(...cs.map(p=>p.y))].map(R),box:planBox([{x:x0-S,y:y0-S},{x:x1+S,y:y1+S}],12000,3000)});}}
 // driveways and crossovers: the yard bay to the street (flared where the truck reverses in), each site's gate crossover, lanes out of the yard
 for(const p of l.places){const kerbY=p.streetY-S/2+WORLD.foot;if(p.kind==='yard'&&p.bay){const b=p.bay,x=b.x,w=b.width,y=b.y+b.length;addDrive(x+1,y+1,'<path d="M'+x+' '+y+'H'+(x+w)+'V'+(kerbY-3000)+'L'+(x+w+5000)+' '+kerbY+'H'+(x-5000)+'L'+x+' '+(kerbY-3000)+'Z" fill="url(#asphalt)"/>');
   for(const f of (p.src.fixtures??[]).filter(f=>f.kind==='ENTRY'||f.kind==='EXIT')){const e=p.ext;if(f.y+f.h+p.oy>=e.y1-2600)addDrive(f.x+p.ox+1,f.y+f.h+p.oy+1,'<rect x="'+(f.x+p.ox)+'" y="'+(f.y+f.h+p.oy-200)+'" width="'+f.w+'" height="'+(kerbY-(f.y+f.h+p.oy)+200)+'" fill="url(#asphalt)"/>');}}
  else if(p.kind==='site'){const y0=p.fs>0?p.block.y1-600:p.block.y0-WORLD.foot,h=p.fs>0?kerbY-p.block.y1+600:WORLD.foot+600;addDrive(p.attachX,y0+h/2,'<rect x="'+(p.attachX-3200)+'" y="'+y0+'" width="6400" height="'+h+'" fill="#cfc9bb" stroke="#b3ac9c" stroke-width="60"/>');}}
 const grounds=[];for(let r=R0-1;r<=R1;r++)for(let c=C0-1;c<=C1;c++){const g=groundCell(l,ext,c,r,drives.get(c+','+r)??'');if(g)grounds.push({c,r,...g});}
 return {grounds,blocks,ext,cells:cellOrder(l,C0,C1,R0,R1)};}
// Every block of the district, back to front for the view (the depth of its middle): the order the blocks, the places on them and the trucks beside
// them are drawn in.
function cellOrder(l,C0,C1,R0,R1){const out=[];for(let r=R0;r<=R1;r++)for(let c=C0;c<=C1;c++)out.push({c,r,dep:E.depth({x:c*l.pw+l.bw/2,y:r*l.ph+l.bh/2})});return out.sort((a,b)=>a.dep-b.dep||a.r-b.r||a.c-b.c);}
// The plan rectangle [x,y,w,h] around some points, each also lifted by h (and its shadow thrown toward the lower right), plus a margin.
function planBox(pts,h,m){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;const u=up(h),s=E.sun(h);for(const p of pts)for(const q of [p,add(p,u),add(p,s),add(p,LOW)]){x0=Math.min(x0,q.x);y0=Math.min(y0,q.y);x1=Math.max(x1,q.x);y1=Math.max(y1,q.y);}
 const r=[x0,y0,x1,y1];for(const p of pts)for(const q of pts){const c={x:p.x,y:q.y};for(const k of [c,add(c,u),add(c,s)]){r[0]=Math.min(r[0],k.x);r[1]=Math.min(r[1],k.y);r[2]=Math.max(r[2],k.x);r[3]=Math.max(r[3],k.y);}}return [R(r[0]-m),R(r[1]-m),R(r[2]-r[0]+2*m),R(r[3]-r[1]+2*m)];}
// An SVG document for an <image>: the art in plan millimetres over exactly that plan rectangle (drawn through the map camera like everything else).
// The browser lays out and paints it as one element, which keeps the thousands of scenery shapes out of every frame's work.
export function wmPicture(svg,box,defs=''){return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+box.join(' ')+'" width="'+Math.max(1,R(box[2]/50))+'" height="'+Math.max(1,R(box[3]/50))+'" preserveAspectRatio="none">'+defs+svg+'</svg>';}

// ---------------------------------------------------------------- sites
const SITE_H=2100;
// The tower crane stands behind the site's own ground, between it and the building; its jib reaches the kerb where trucks stop.
function craneOf(p,l){const e=p.ext,fs=p.fs??1,fy=fs>0?e.y1:e.y0,x=R((e.x0+e.x1)/2),y=R(fs>0?e.y0-2600:e.y1+2600),kerb=p.streetY-fs*WORLD.lane,reach=Math.max(Math.hypot(e.x0-x,fy-y),Math.hypot(e.x1-x,fy-y),Math.hypot(p.attachX-x,fy+fs*3000-y))+2500;return {x,y,H:24000,reach:clamp(reach,20000,48000)};}
function buildingOf(p,l){const e=p.ext,n0=(p.fs??1)>0,top=n0?p.block.y0+3500:e.y1+5500,bot=n0?e.y0-5500:p.block.y1-3500,d=Math.min(15000,bot-top);if(d<8000)return null;const w=Math.min(e.x1-e.x0+6000,l.bw-16000,32000),x=R((e.x0+e.x1)/2-w/2),n=3+(strHash(p.id)%2);return {x,y:R(n0?bot-d:top),w,d,n,H:n*3200};}
// A concrete-frame building going up: finished floors with glazing and slab edges, the top floor an open frame of columns with the formwork deck
// for the next slab over the back of it and edge screens, and the scaffold on the two faces toward the street.
function buildingSVG(b){const {x,y,w,d,n,H}=b,cs=box4(x,y,w,d),base=G,done=base+H-3200,top=done+3000;let s=shadowOf(E,cs,H+800,.25,LOW)+block(E,cs,base,done,'#d8d3c8',null,'#6d6a62',20);
 for(const q of walls(E,cs)){const len=Math.hypot(q.q.x-q.p.x,q.q.y-q.p.y),bays=Math.max(2,Math.round(len/4200));for(let f=0;f<n-1;f++){const z=base+f*3200;s+=quad(E,q,0,1,z+2850,z+3200,'fill="'+shade('#b5afa2',q.f)+'"');for(let k=0;k<bays;k++)s+=quad(E,q,(k+.1)/bays,(k+.9)/bays,z+650,z+2650,'fill="'+(f===0?'#3a5566':'#46677a')+'" stroke="#e9e5dc" stroke-width="45"')+'<path d="M'+P(onWall(E,q,(k+.3)/bays,z+800))+'L'+P(onWall(E,q,(k+.45)/bays,z+2500))+'" stroke="#9fc3d6" stroke-opacity=".35" stroke-width="70"/>';}}
 s+=poly(cs.map(p=>at(p,done)),'fill="#bcb6a9" stroke="#6d6a62" stroke-width="20"');
 const gx=Math.max(2,Math.round(w/5000)),gy=Math.max(2,Math.round(d/5000)),deckY=y+d*.55,col=(px,py)=>block(E,box4(px-220,py-220,440,440),done,top,'#a7a194','#bdb7aa','#5f5b54',12);let back='',front='';
 for(let i=0;i<=gx;i++)for(let j=0;j<=gy;j++){const px=x+i*w/gx,py=y+j*d/gy;if(py<=deckY)back+=col(px,py);else front+=col(px,py);}
 const deck=[{x,y},{x:x+w,y},{x:x+w,y:deckY},{x,y:deckY}];let joints='';for(let k=1;k<Math.round(w/2400);k++){const px=x+k*w/Math.round(w/2400);joints+='M'+P(at({x:px,y},top))+'L'+P(at({x:px,y:deckY},top));}
 s+=back+block(E,deck,top-200,top,'#9c7443','#cfa46a','#6e5230',16)+'<path d="'+joints+'" stroke="#a98150" stroke-width="40"/>';
 const screen=[{a:{x,y:deckY},b:{x:x+w,y:deckY}},{a:{x:x+w,y:deckY},b:{x:x+w,y}}];for(const e of screen)s+=poly([at(e.a,top),at(e.b,top),at(e.b,top+1900),at(e.a,top+1900)],'fill="#2f6aa6" fill-opacity=".55" stroke="#1f4a78" stroke-width="30"');
 s+=front;
 return s+scaffoldSVG(b);}
// Tube-and-fitting scaffold on the two faces toward the street: standards every 2.4 m, a lift every 2 m with timber decks, ledgers, guardrails and bracing.
function scaffoldSVG(b){const {x,y,w,d,H}=b,top=H+1000;let std='',led='',brace='',guard='',decks='';
 const faces=[{a:{x,y:y+d},b:{x:x+w,y:y+d},n:{x:0,y:1}},{a:{x:x+w,y:y+d},b:{x:x+w,y},n:{x:1,y:0}}];
 for(const f of faces){const len=Math.hypot(f.b.x-f.a.x,f.b.y-f.a.y),bays=Math.max(1,Math.round(len/2400)),o=(p,k)=>({x:p.x+f.n.x*k,y:p.y+f.n.y*k}),ins=u=>o(lerp(f.a,f.b,u),300),out=u=>o(lerp(f.a,f.b,u),1500),lifts=Math.floor(top/2000);
  for(let i=0;i<=bays;i++){const u=i/bays;for(const pt of [ins(u),out(u)])std+='M'+P(at(pt,G))+'L'+P(at(pt,G+top));}
  for(let k=1;k<=lifts;k++){const z=G+k*2000;decks+=poly([at(ins(0),z),at(ins(1),z),at(out(1),z),at(out(0),z)],'fill="#c9975a" stroke="#8a6a3e" stroke-width="24"');for(const pt of [ins,out])led+='M'+P(at(pt(0),z))+'L'+P(at(pt(1),z));guard+='M'+P(at(out(0),z+1000))+'L'+P(at(out(1),z+1000))+'M'+P(at(out(0),z+180))+'L'+P(at(out(1),z+180));}
  for(let i=0;i<bays;i+=2){const u0=i/bays,u1=Math.min(1,(i+2)/bays);brace+='M'+P(at(out(u0),G+200))+'L'+P(at(out(u1),G+Math.min(top,4200)));}
  guard+='M'+P(at(out(0),G+top))+'L'+P(at(out(1),G+top));}
 return decks+'<path d="'+led+'" stroke="#7f898c" stroke-width="44"/><path d="'+std+'" stroke="#aab3b6" stroke-width="58" stroke-linecap="round"/><path d="'+guard+'" stroke="#c3cbcd" stroke-width="40"/><path d="'+brace+'" stroke="#8e989b" stroke-width="40"/>';}
function shedSVG(x,y,w,d){const cs=box4(x,y,w,d),H=2600,base=G+120;let s=shadowOf(E,cs,H,.24,LOW)+block(E,cs,base,base+H,'#ebe5d5',null,'#4b534f',22);for(const q of walls(E,cs)){const len=Math.hypot(q.q.x-q.p.x,q.q.y-q.p.y),n=Math.max(1,Math.floor(len/1900));for(let j=0;j<n;j++)s+=quad(E,q,(j+.22)/n,(j+.78)/n,base+1000,base+1950,'fill="#2c4b5d" stroke="#f7f4ec" stroke-width="60"');}
 const t=up(base+H+100);return s+poly(box4(x-120,y-120,w+240,d+240).map(p=>add(p,t)),'fill="#8f9a9e" stroke="#3a4240" stroke-width="40"')+'<path d="M'+P(at({x:x+w*.08,y:y+d/2},base+H+110))+'L'+P(at({x:x+w*.92,y:y+d/2},base+H+110))+'" stroke="#a9b3b7" stroke-width="60"/>';}
// The tower crane's mast: a lattice on a concrete base. Lattice lines keep a fixed width on screen (non-scaling stroke), so a crane still reads as a
// crane with the whole district in view. Drawn live over the map with the jib (craneSVG), not baked into the site's picture.
const NSK=' vector-effect="non-scaling-stroke"';
function mastSVG(c){const r=800,cs=box4(c.x-r,c.y-r,2*r,2*r);let posts='',zig='';for(const q of cs)posts+='M'+P(at(q,G+300))+'L'+P(at(q,G+c.H));
 for(const w of walls(E,cs))for(let z=G+300;z<G+c.H-1600;z+=1600)zig+='M'+P(at(w.p,z))+'L'+P(at(w.q,z+800))+'L'+P(at(w.p,z+1600));
 return shadowOf(E,box4(c.x-1400,c.y-1400,2800,2800),c.H*.25,.18,LOW)+block(E,box4(c.x-1600,c.y-1600,3200,3200),G,G+300,'#a39d90','#bdb7aa','#6d6a62',20)+'<path d="'+zig+'" stroke="#c8901a" stroke-width="1.1"'+NSK+' fill="none"/><path d="'+posts+'" stroke="#e5ad1f" stroke-width="2"'+NSK+'/>';}
// Temporary fence panels on feet along the site boundary (see-through mesh on the street side, shade cloth behind), open where the gate is.
function hoardingItems(p,gateU){const pts=p.pts??[],items=[],FH=SITE_H,e=p.ext;const area=pts.reduce((s,q,i)=>{const r=pts[(i+1)%pts.length];return s+q.x*r.y-r.x*q.y;},0);
 pts.forEach((a,i)=>{const b=pts[(i+1)%pts.length],len=Math.hypot(b.x-a.x,b.y-a.y);if(len<1)return;const dx=(b.x-a.x)/len,dy=(b.y-a.y)/len,nrm=area>0?{x:dy,y:-dx}:{x:-dy,y:dx},facing=proj(nrm).y>0.02;
  let gaps=[];if(gateU&&Math.abs(dy)<1e-6&&Math.abs(a.y-(p.gateY??e.y1))<5){const g0=Math.min(a.x,b.x),g1=Math.max(a.x,b.x);if(gateU>g0+2600&&gateU<g1-2600){const t0=Math.abs(gateU-2400-a.x),t1=Math.abs(gateU+2400-a.x);gaps=[[Math.min(t0,t1),Math.max(t0,t1)]];}}
  const segs=[];let s0=0;for(const [g0,g1] of gaps){if(g0>s0+100)segs.push([s0,g0]);s0=g1;}if(s0<len-100)segs.push([s0,len]);
  for(const [s1,s2] of segs){const k=Math.max(1,Math.round((s2-s1)/2400));for(let j=0;j<k;j++){const u={x:a.x+dx*(s1+(s2-s1)*j/k),y:a.y+dy*(s1+(s2-s1)*j/k)},v={x:a.x+dx*(s1+(s2-s1)*(j+1)/k),y:a.y+dy*(s1+(s2-s1)*(j+1)/k)},m=lerp(u,v,.5);
   items.push({dep:E.depth(m),front:facing,svg:poly([at(u,0),at(v,0),at(v,FH),at(u,FH)],'fill="url(#'+(facing?'mesh':'wm-shadecloth')+')" pointer-events="none"')+(facing?poly([at(u,0),at(v,0),at(v,700),at(u,700)],'fill="#2f5d45" fill-opacity=".8" pointer-events="none"'):'')+'<path d="M'+P(at(u,-60))+'L'+P(at(u,FH))+'M'+P(at(u,FH))+'L'+P(at(v,FH))+'" stroke="#9aa3a0" stroke-width="55" stroke-linecap="round" pointer-events="none"/>'+block(E,box4(u.x-260,u.y-130,520,260),-60,120,'#c9c2b2','#ddd6c7','#6f695d',14)});}}
  for(const [g0,g1] of gaps){for(const [t,sg] of [[g0,1],[g1,-1]]){const A={x:a.x+dx*t,y:a.y+dy*t},tip={x:A.x+nrm.x*1700+dx*sg*1600,y:A.y+nrm.y*1700+dy*sg*1600};items.push({dep:E.depth(lerp(A,tip,.5)),front:true,svg:poly([at(A,0),at(tip,0),at(tip,FH),at(A,FH)],'fill="url(#mesh)" pointer-events="none"')+'<path d="M'+P(at(A,0))+'L'+P(at(A,FH+200))+'" stroke="#2c3430" stroke-width="140"/><path d="M'+P(at(A,FH-300))+'L'+P(at(A,FH+200))+'" stroke="#f0c230" stroke-width="140"/>'});}}});
 return items;}
const craneKind=(state,siteId)=>(state.resources??[]).filter(r=>r.type==='CRANE'&&r.location===siteId);
// One site in four layers: its laydown ground (live: the click target), the static art behind its stock (fence panels facing away, the building under
// scaffold, the shed, the crane mast), the live stock and crew, and the static art in front (fence panels and gate leaves facing the street).
// The site plan is placed on the map by placePoint / placeRect (its offset, and a half turn when its gate side is at the back of the plan).
export function wmSiteParts(p,l,state,ctx={},opts={}){
 const src=p.src,pts=p.pts??[],e=p.ext,out={ground:'',back:'',live:'',front:'',crane:false};if(pts.length<3)return out;
 let ground='<polygon points="'+pts.map(q=>P(add(q,LOW))).join(' ')+'" fill="none" stroke="#b3ac9a" stroke-width="1600" stroke-linejoin="round"/>';
 const area=pts.reduce((s,q,i)=>{const r=pts[(i+1)%pts.length];return s+q.x*r.y-r.x*q.y;},0);let kerb='';pts.forEach((a,i)=>{const b=pts[(i+1)%pts.length],len=Math.hypot(b.x-a.x,b.y-a.y)||1,n=area>0?{x:(b.y-a.y)/len,y:-(b.x-a.x)/len}:{x:-(b.y-a.y)/len,y:(b.x-a.x)/len},d=proj(n);if(d.y>0.02)kerb+=poly([a,b,add(b,LOW),add(a,LOW)],'fill="'+shade('#b3a17f',.8-.18*d.x/Math.hypot(d.x,d.y))+'" stroke="#8a7a5c" stroke-width="30"');});
 ground+=kerb+'<polygon class="wm-site-pad" points="'+pts.map(P).join(' ')+'" fill="url(#wm-dirt)" stroke="#8a7a5c" stroke-width="40"/>';
 if(src.loading){const z=placeRect(p,src.loading.x,src.loading.y,2000,1500);ground+='<rect x="'+R(z.x)+'" y="'+R(z.y)+'" width="2000" height="1500" fill="url(#hatch)" stroke="#e3bd2c" stroke-width="70"/>';}
 out.ground=ground;
 out.crane=craneKind(state,src.id).length>0;
 if(opts.art!==false){const back=[],front=[];for(const it of hoardingItems(p,p.attachX))(it.front?front:back).push(it);
  const b=buildingOf(p,l);if(b)back.push({dep:E.depth({x:b.x+b.w/2,y:b.y+b.d/2}),svg:buildingSVG(b)});
  const shedX=e.x0-7400,shedY=(p.fs??1)>0?e.y1-4800:e.y0+2000;if(shedX>p.block.x0+800)back.push({dep:E.depth({x:shedX+3000,y:shedY+1400}),svg:shedSVG(shedX,shedY,6000,2800)});
  const sorted=a=>a.sort((x,y)=>x.dep-y.dep).map(o=>o.svg).join('');out.back=sorted(back);out.front=sorted(front);}
 if(opts.live===false)return out;
 // stillages on site, stacked, with their contents in the tooltip (world.items is unpaged, state.containers is only the current page)
 const items=[],stock=(state.world?itemsOf(state):state.containers??[]).filter(c=>c.location===src.id),byId=new Map(stock.map(c=>[c.id,c])),names=new Map((state.products??[]).map(q=>[q.id,q.name]));
 const linesOf=c=>Array.isArray(c.lines)?c.lines.map(([id,q])=>({name:names.get(id)??'Material',quantity:q,reserved:0})):c.pcs!=null?[{name:'pieces',quantity:c.pcs,reserved:0}]:(state.balances??[]).filter(x=>x.container===c.id&&x.quantity>0).map(x=>({name:names.get(x.product_id)??'Material',quantity:x.quantity,reserved:x.reserved||0}));
 const baseOf=c=>{let h=0,cur=byId.get(c.support),n=0;while(cur&&n++<9){h+=cur.height||1000;cur=byId.get(cur.support);}return h;},levelOf=c=>{let n=0,cur=c;while(cur?.support&&n<9){cur=byId.get(cur.support);n++;}return n;};
 for(const c of stock){const rw=c.rotation===90?c.envelopeWidth:c.envelopeLength,rh=c.rotation===90?c.envelopeLength:c.envelopeWidth;if(!(rw>0&&rh>0))continue;const z=placeRect(p,c.x,c.y,rw,rh),lc={...c,x:z.x,y:z.y},lv=levelOf(c);items.push({dep:E.depth({x:lc.x+rw/2,y:lc.y+rh/2})+lv*1e-3,svg:packSVG(E,lc,rw,rh,baseOf(c),lv,{selected:ctx.selected===c.id,lines:linesOf(c),shadow:lv===0,stackH:c.height})});}
 for(const w of (state.resources??[]).filter(r=>r.type==='WORKER'&&r.location===src.id&&Number.isFinite(r.x))){const g=placePoint(p,w.x+250,w.y+250),busy=!!w.task;items.push({dep:E.depth(g),svg:'<g class="wm-crew" transform="translate('+R(g.x)+' '+R(g.y)+')"><title>'+esc(w.name)+(busy?' - unloading':' - on site')+'</title><g transform="'+E.bb+'">'+workerFigure(busy?'#ff8a1e':'#d7f02f',busy?'#9a4a06':'#7d8a16')+'</g></g>'});}
 out.live=items.sort((a,b)=>a.dep-b.dep).map(o=>o.svg).join('');
 return out;}
// The whole site as one string (Node tests, and a browser without Blob): ground, back, stock and crew, front.
export function wmSiteSVG(p,l,state,ctx={}){const s=wmSiteParts(p,l,state,ctx);return s.ground?'<g class="wm-site-ground">'+s.ground+'</g>'+s.back+s.live+s.front:'';}
// Where a site's static art reaches on the plan (for its pictures): the block, the building and crane mast behind it, lifted by their height.
const siteArtBox=p=>planBox([{x:p.block.x0-S/2,y:p.block.y0-S/2},{x:p.block.x1+S/2,y:p.block.y1+S/2}],30000,3000);

// ---------------------------------------------------------------- trucks
const HEAD_STEP=Math.PI/12;
const headingKey=(hx,hy)=>{const a=Math.atan2(hy,hx);return ((R(a/HEAD_STEP)%24)+24)%24;};
// The truck art at the origin for one of 24 headings, cargo on the deck (cargo boxes as on the yard plan's parked truck).
function truckArtAt(truck,hk,cargo){const a=hk*HEAD_STEP,hx=Math.cos(a),hy=Math.sin(a),D=truckDims(truck),tl=truck.length??6000,tw=truck.width??2050,total=tl+120+D.cab,M=(X,Y)=>({x:(X-total/2)*hx+(Y-tw/2)*hy,y:(X-total/2)*hy-(Y-tw/2)*hx}),lb=new Map(cargo.map(c=>[c.id,c]));
 const items=cargo.map(c=>{const rw=c.rotation===90?c.envelopeWidth:c.envelopeLength,rh=c.rotation===90?c.envelopeLength:c.envelopeWidth;if(!(rw>0&&rh>0))return null;let z=G+D.DK,cur=lb.get(c.support),n=0;while(cur&&n++<9){z+=cur.height||1000;cur=lb.get(cur.support);}return {d:E.depth(M(c.x+rw/2,c.y+rh/2)),svg:cargoBox(c,[M(c.x,c.y),M(c.x+rw,c.y),M(c.x+rw,c.y+rh),M(c.x,c.y+rh)],z)};}).filter(Boolean);
 return truckSVG(E,truck,M,G,items);}
function cargoBox(c,cs,z){const cage=c.type==='CAGE',rim=c.condition==='SERVICEABLE'?(cage?STATUS_COLOURS.cage:STATUS_COLOURS.stillage):STATUS_COLOURS.damaged,h=c.height||1000,tt=up(z+h),a=cs[0],b=cs[1],d=cs[3],len=Math.hypot(b.x-a.x,b.y-a.y),wd=Math.hypot(d.x-a.x,d.y-a.y);let g='';const along=len>=wd;for(let k=170;k<(along?wd:len)-100;k+=150){const u=k/(along?wd:len);const p0=along?lerp(a,d,u):lerp(a,b,u),p1=along?lerp(b,cs[2],u):lerp(d,cs[2],u);g+='M'+P(add(p0,tt))+'L'+P(add(p1,tt));}
 return '<g class="truck-load"><title>'+esc(c.name)+'</title>'+block(E,cs,z,z+h,cage?'#d8ab2b':'#a8b2b5',null,'#34403b',18)+poly(cs.map(p=>add(p,tt)),'fill="#39413d" stroke="'+rim+'" stroke-width="70"')+(g?'<path d="'+g+'" stroke="'+(cage?'#e9bb2c':'#cdd5d9')+'" stroke-width="80"/>':'')+'</g>';}

// ---------------------------------------------------------------- the stage (browser only)
let W=null;// {stage, svg, cam, ground, diags, slots, air, tags, ghost, mini, card, strip, ...}
// Camera modes: director (frames whatever is happening), fit (everything, and any truck on the road), free (the owner's own pan and zoom),
// follow (one truck, from its card).
let barMore=false,cam=null,camTarget=null,mode='director',followId=null,arrange=false,raf=0,idleT=0,lastT=0,ctxNow=null,stateSeen=null,cardFor=null,lastUser=0,camKey='worldcam';
const trips=new Map();// truck id -> {g, route geom, D, anchorR, anchorT, u, hk, slot, art key}
const cranes=new Map();// site id -> {g, c, cur:{a,r,z}, load, ...}
const built={sig:null,yard:null,sites:new Map()};
const MODES=['director','fit','free'];
// The camera is remembered per browser, for each company and user.
const loadCam=()=>{try{const v=JSON.parse(localStorage.getItem(camKey)||'null');return v&&Number.isFinite(v.cx)&&Number.isFinite(v.cy)&&v.s>0?v:null;}catch{return null;}};
const saveCam=()=>{if(!cam)return;try{localStorage.setItem(camKey,JSON.stringify({cx:R(cam.cx),cy:R(cam.cy),s:+cam.s.toFixed(6),mode:mode==='follow'?(W?.prevMode??'director'):mode,v:2}));}catch{}};

// The host operations.js renders: the stage is moved into it after every render.
export function wmShell(){return '<div class="wm-host" data-wm-host></div>';}
// The map's toolbar, part of the Home markup (operations.js homeView): camera modes, zoom, the yard plan's Turn view / 3D view, Arrange map.
export function wmTools(opts={}){const v=opts.view??VIEW,tilt=v.tilt!==false;return '<div class="wm-bar" role="toolbar" aria-label="Map controls"><button type="button" class="wm-btn wm-director" data-wm="director" aria-pressed="false" title="The camera follows what is happening: loading, the drive, the unload"><i class="wm-rec" aria-hidden="true"></i>Director</button><button type="button" class="wm-btn wm-fit" data-wm="fit" aria-pressed="false" title="Show the yard and every site, and keep any truck on the road in view">Fit all</button><button type="button" class="wm-btn" data-wm="yard">Yard</button>'
 +'<span class="wm-zoom"><button type="button" class="wm-btn wm-sq" data-wm="out" aria-label="Zoom out">&minus;</button><b class="wm-zl" title="Zoom (Fit all = 100%)">100%</b><button type="button" class="wm-btn wm-sq" data-wm="in" aria-label="Zoom in">+</button></span>'
 +'<span class="wm-turn"><button type="button" class="wm-btn" data-wm="turn:-45" title="Turn the map left" aria-label="Turn view left">&#8634;<span class="wm-tt"> Turn view</span></button><button type="button" class="wm-btn" data-wm="turn:45" title="Turn the map right" aria-label="Turn view right"><span class="wm-tt">Turn view </span>&#8635;</button><button type="button" class="wm-btn'+(tilt?' on':'')+'" data-wm="tilt" aria-pressed="'+tilt+'" title="Switch between the 3D view and the flat plan view">'+(tilt?'3D view':'Plan view')+'</button></span>'
 +(opts.ops?'<button type="button" class="wm-btn wm-arrange" data-wm="arrange" aria-pressed="false">Arrange map</button>':'')+'<button type="button" class="wm-btn wm-morebar" data-wm="bar-more" aria-expanded="false">More</button><span class="wm-hint">Drag to pan &middot; scroll or pinch to zoom &middot; click a truck to follow it</span></div>';}
// Live content, built from the state (cached per state object and selection); the part's HTML changes when any live layer changed, which makes the
// Home patch call wmAttach. Pure strings: runs in Node too.
let live={key:null,v:0,yard:'',sites:new Map(),sig:''};const yardCache={key:null,parts:null},siteCache=new Map();
export function wmSignal(ctx){if(ctx.view)setProjection(ctx.view);const l=wmLayout(ctx.state);const k=[ctx.state,ctx.selected,ctx.selectedWorker,ctx.planned,ctx.pulse,VK];if(live.key&&live.key.every((v,i)=>v===k[i]))return '<i class="wm-sig" hidden data-v="'+live.v+'"></i>';
 const t0=typeof performance!=='undefined'?performance.now():0,next=l?buildLive(l,ctx):{yard:'',sites:new Map(),trucks:''};measure('wm-build',t0);if(next.yard!==live.yard)live.yv=(live.yv??0)+1;const sig=live.yv+'|'+[...next.sites].map(([id,s])=>id+strHash(s.ground+s.live)+(s.crane?'c':'')).join(',')+'|'+next.trucks+'|'+layoutSig(l)+'|'+VK+'|'+(ctx.state?.config?.paused?1:0);
 if(sig!==live.sig)live.v++;live={...live,...next,key:k,sig,layout:l};return '<i class="wm-sig" hidden data-v="'+live.v+'"></i>';}
// The yard (the plan's own layers, bay truck included), each site's live layers, and a signature of everything the trucks layer draws.
function buildLive(l,ctx){const st=ctx.state,out={yard:'',sites:new Map(),trucks:''},yp=l.places.find(p=>p.kind==='yard');
 const trucks=(st.trucks??[]).filter(t=>!t.retired);const rest=new Map();for(const p of l.places)for(const [id,pose] of restPoses(l,p.id,trucks.filter(t=>t.at===p.id&&['AT_YARD','AT_SITE'].includes(t.status)),trucks))rest.set(id,pose);
 if(yp&&st.yards?.[0]){const bayTruck=trucks.find(t=>t.at===yp.id&&t.status==='AT_YARD'&&rest.get(t.id)?.bay),items=itemsOf(st),have=new Set((ctx.containers??st.containers??[]).map(c=>c.id)),containers=[...(ctx.containers??st.containers??[]),...items.filter(c=>!have.has(c.id)&&c.location===bayTruck?.id)];
  // the yard is drawn again only when something it shows changed (its stillages and their contents, the crew, the tasks, the bay truck, a selection)
  const here=new Set([yp.id,bayTruck?.id].filter(Boolean)),ytasks=(st.tasks??[]).filter(x=>x.handling===yp.id||x.to===yp.id),yv={...st.yards[0]};delete yv.lastSweep;delete yv.version;const yk=JSON.stringify([yv,containers.filter(c=>here.has(c.location)),(st.balances??[]).filter(b=>here.has(b.location)),ytasks,(st.resources??[]).filter(r=>r.location===yp.id),bayTruck??null,ctx.selected??null,ctx.selectedWorker??null,[...(ctx.planned??[])],ctx.opts?.pulse??null,ctx.opts?.cornerNumbers??null,VK,st.products?.length??0]);
  const parts=yk===yardCache.key?yardCache.parts:yardSVG(st.yards[0],containers,ytasks,ctx.selected??null,bayTruck?[bayTruck]:[],st.resources??[],ctx.selectedWorker??null,{...(ctx.opts??{}),view:{...DEFAULT_VIEW,tilt:VIEW.tilt,rotate:VIEW.rotate},planned:ctx.planned??null,world:true});yardCache.key=yk;yardCache.parts=parts;
  if(parts&&typeof parts==='object'){out.U=parts.U;const b=yp.bay,hit=bayTruck&&b?'<rect class="wm-hit" data-wm-truck="'+esc(bayTruck.id)+'" tabindex="0" role="button" aria-label="'+esc(bayTruck.name)+': show on the map" x="'+(b.px)+'" y="'+(b.py)+'" width="'+b.width+'" height="'+b.length+'" fill="#000" fill-opacity="0"/>':'';out.yard='<defs>'+parts.defs+'</defs><g id="plan">'+parts.plan+'</g>'+hit;}}
 for(const p of l.places)if(p.kind==='site'){const revs=st.world?.revs,crew=(st.resources??[]).filter(r=>r.location===p.id).map(r=>[r.id,r.type,r.x,r.y,!!r.task,r.name]),key=revs?(revs[p.id]??'-')+'|'+JSON.stringify(crew)+'|'+(ctx.selected??'')+'|'+VK+'|'+p.ox+','+p.oy+','+p.rot+'|'+(st.products?.length??0):null;
  let c=siteCache.get(p.id);if(!key||!c||c.key!==key){c={key,parts:wmSiteParts(p,l,st,ctx,{art:false})};siteCache.set(p.id,c);}out.sites.set(p.id,c.parts);}
 out.trucks=trucks.map(t=>t.id+t.status+(t.at??'')+(t.destination??'')+(t.route?.delivery??'')+(rest.get(t.id)?P(rest.get(t.id)):'')+itemsOf(st).filter(c=>c.location===t.id).map(c=>c.id+c.x+','+c.y+c.support).join('')).join('|')+'|'+(st.tasks??[]).filter(x=>l.byId.get(x.handling)?.kind==='site').map(x=>x.id+x.state).join(',');
 out.rest=rest;return out;}

// ---- mounting and syncing
const el=(tag,attrs={},html='')=>{const n=document.createElementNS(SVGNS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(html)n.innerHTML=html;return n;};
function setSVG(g,html){// parse in SVG context and keep unchanged nodes (hover, focus, running glides)
 const t=document.createElementNS(SVGNS,'g');t.innerHTML=html;morphKids(g,t);}
function morphKids(a,b){const ac=a.childNodes,bc=[...b.childNodes];if(ac.length!==bc.length){a.replaceChildren(...bc);return;}for(let i=0;i<bc.length;i++)morph(ac[i],bc[i]);}
function morph(a,b){if(a.nodeType!==b.nodeType||a.nodeName!==b.nodeName){a.replaceWith(b);return;}if(a.nodeType!==1){if(a.nodeValue!==b.nodeValue)a.nodeValue=b.nodeValue;return;}if(a.isEqualNode(b))return;for(const n of a.getAttributeNames())if(!b.hasAttribute(n)&&n!=='style')a.removeAttribute(n);for(const n of b.getAttributeNames()){const v=b.getAttribute(n);if(a.getAttribute(n)!==v)a.setAttribute(n,v);}morphKids(a,b);}
// ---- pictures: the static art (ground, houses and trees, a site's building, shed and fence) as <image>s, never as thousands of live shapes.
// Each picture is an SVG document (a blob URL; CSP img-src allows blob:), sharp at any zoom, and is also drawn once into bitmaps at the zoom levels
// in use: every picture at the level Fit all needs, the pictures in view at a closer level. A bitmap is one texture for the browser to draw, so
// moving the camera or a truck never repaints the scenery shape by shape. Close in, the few pictures in view are shown as SVG again.
// Bitmaps are drawn in the background, one at a time, and swapped in once decoded; their blob URLs are released when no longer shown or needed.
let defsPic=null;const DEFS_PIC=()=>defsPic??=defsSVG(DEFS_EXTRA);
const hasBlob=()=>typeof Blob==='function'&&typeof URL!=='undefined'&&typeof URL.createObjectURL==='function';
const pics=new Map();// g -> {g, svg, box, defs, vec (blob url), bm: Map(level -> url), shown ('v' | level), used}
let picQ=[],picBusy=false,picFar=1/512,picGen=0,picPx=0;const PIC_MID=1/128,PIC_MAX_PX=6e6;
function setPic(g,svg,box,defs=''){dropPic(g);if(!svg){g.replaceChildren();return;}if(!hasBlob()){g.innerHTML=svg;return;}const p={g,svg,box,defs,vec:null,bm:new Map(),shown:null,used:0};pics.set(g,p);showPic(p,'v');}
function dropPic(g){const p=pics.get(g);if(!p)return;pics.delete(g);if(p.vec)URL.revokeObjectURL(p.vec);for(const u of p.bm.values())URL.revokeObjectURL(u);p.bm.clear();p.dead=true;}
function dropAllPics(){for(const g of [...pics.keys()])dropPic(g);picQ=[];picGen++;picPx=0;}
const vecURL=p=>p.vec??=URL.createObjectURL(new Blob([wmPicture(p.svg,p.box,p.defs)],{type:'image/svg+xml'}));
// Show one form of a picture: a new <image> swapped in once it has decoded, so a change never flashes.
function showPic(p,rep){if(p.dead||p.shown===rep)return;const url=rep==='v'?vecURL(p):p.bm.get(rep);if(!url)return;p.shown=rep;p.used=performance.now();const b=p.box,img=el('image',{class:'wm-pic',x:b[0],y:b[1],width:b[2],height:b[3],preserveAspectRatio:'none','pointer-events':'none'});img.setAttribute('href',url);
 const g=p.g;g.__pending=img;const swap=()=>{if(g.__pending!==img)return;g.__pending=null;g.replaceChildren(img);};if(g.firstChild&&typeof img.decode==='function'){let done=false;const once=()=>{if(!done){done=true;swap();}};img.decode().then(once,once);setTimeout(once,1500);}else swap();}
// The pictures in view (with a margin) for the committed camera.
function picVisible(p){if(!W?.mat)return true;const b=p.box,cs=[[b[0],b[1]],[b[0]+b[2],b[1]],[b[0],b[1]+b[3]],[b[0]+b[2],b[1]+b[3]]].map(([x,y])=>toScreen({x,y})),VW=W.w*OVER,VH=W.h*OVER,m=.15*Math.max(VW,VH);return !(Math.max(...cs.map(q=>q.x))<-m||Math.min(...cs.map(q=>q.x))>VW+m||Math.max(...cs.map(q=>q.y))<-m||Math.min(...cs.map(q=>q.y))>VH+m);}
// The level Fit all needs (bitmap pixels per plan millimetre), a power of two, no finer than the memory budget allows.
function farLevel(){const need=fitScale(fitAllBox(built.layout))*1.03*(globalThis.devicePixelRatio||1)*1.4;let area=0;for(const p of pics.values())area+=p.box[2]*p.box[3];let lv=2**Math.ceil(Math.log2(Math.max(1e-6,need)));while(lv>1/4096&&area*lv*lv>PIC_MAX_PX*1.5)lv/=2;return Math.min(lv,PIC_MID/2);}
// After the camera settles: the form each picture should show now, and the bitmaps still to draw (those in view first).
const picWant=()=>{const need=cam.s*1.03*(globalThis.devicePixelRatio||1);return need<=picFar*1.6?picFar:need<=PIC_MID*1.5?PIC_MID:'v';};
function lodPass(){if(!W?.mat||!pics.size||!hasBlob()||!cam)return;const far=picFar,want=picWant(),now=performance.now();picQ=[];W.lodStale=false;
 for(const p of pics.values()){if(p.noBitmap){showPic(p,'v');continue;}const vis=picVisible(p);if(!p.bm.has(far))picQ.push({p,lv:far,pri:vis?1:3});
  if(!vis){if(p.shown==='v'&&p.bm.has(far))showPic(p,far);continue;}p.used=now;
  if(want==='v'||p.bm.has(want)){showPic(p,want);continue;}
  // while the camera moves (a glide, a drag, following a driving truck) no closer bitmap is drawn: the picture is shown sharp as SVG, and the
  // bitmap is drawn once the camera rests
  if(camMoving()){W.lodStale=true;showPic(p,'v');continue;}
  picQ.push({p,lv:want,pri:0});if(p.shown===null||(p.shown!=='v'&&!p.bm.has(p.shown)))showPic(p,p.bm.has(far)?far:'v');}
 // closer bitmaps of pictures out of view are released, the most recently shown kept up to the budget
 let mid=0;for(const p of [...pics.values()].sort((a,b)=>b.used-a.used))for(const [lv,u] of [...p.bm]){if(lv<=far)continue;const px=p.box[2]*p.box[3]*lv*lv;if(p.shown!==lv&&mid+px>PIC_MAX_PX){URL.revokeObjectURL(u);p.bm.delete(lv);}else mid+=px;}
 picQ.sort((a,b)=>a.pri-b.pri);pumpPics();}
// Draw the next bitmap: the SVG picture into a canvas at the level's size, as a PNG blob. One at a time, in idle time, so frames keep coming.
function pumpPics(){if(picBusy||!picQ.length||typeof document==='undefined')return;picBusy=true;const gen=picGen,idle=f=>typeof requestIdleCallback==='function'?requestIdleCallback(f,{timeout:250}):setTimeout(f,16);
 idle(async()=>{if(!W?.stage?.isConnected||document.hidden){picBusy=false;return;}const job=picQ.shift();try{const {p,lv}=job??{};if(job&&!p.dead&&!p.bm.has(lv)&&gen===picGen){const w=Math.max(1,Math.min(4096,R(p.box[2]*lv))),h=Math.max(1,Math.min(4096,R(p.box[3]*lv))),src=new Image();src.src=vecURL(p);await src.decode();
    const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d'),t0=performance.now();x.drawImage(src,0,0,w,h);measure('wm-pic',t0);let blob=null;const enc=encodeInWorker(c);if(enc)blob=await enc;if(!blob)blob=await new Promise(r=>c.toBlob(r,'image/png'));
    if(blob&&!p.dead&&gen===picGen){const u=URL.createObjectURL(blob),pre=new Image();pre.src=u;await pre.decode().catch(()=>{});p.bm.set(lv,u);if(lv===picFar)picPx+=w*h;if(W?.mat&&cam){const want=picWant(),vis=picVisible(p);if(want===lv||(!vis&&lv===picFar&&p.shown==='v'))showPic(p,lv);}}}}
  catch(e){if(job)job.p.noBitmap=true;}finally{picBusy=false;if(gen===picGen)pumpPics();}});}
// PNG encoding off the page's main thread: the bitmap goes to a worker (public/world-pic.js) that encodes it; any trouble and the page encodes it itself.
let picWorker=null,picWorkerOff=false,picSeq=0;const picWait=new Map();
function encodeInWorker(canvas){if(picWorkerOff||typeof Worker!=='function'||typeof createImageBitmap!=='function')return null;
 try{if(!picWorker){picWorker=new Worker(new URL('world-pic.js',import.meta.url));picWorker.onmessage=e=>{const w=picWait.get(e.data?.id);if(w){picWait.delete(e.data.id);w(e.data.blob??null);}};picWorker.onerror=()=>{picWorkerOff=true;for(const w of picWait.values())w(null);picWait.clear();};}}catch{picWorkerOff=true;return null;}
 return createImageBitmap(canvas).then(bmp=>new Promise(res=>{const id=++picSeq;const to=setTimeout(()=>{if(picWait.delete(id)){picWorkerOff=true;res(null);}},6000);picWait.set(id,b=>{clearTimeout(to);res(b);});picWorker.postMessage({id,bmp},[bmp]);})).catch(()=>null);}
const revokeAll=()=>dropAllPics();
let lodT=0;const lodSoon=()=>{if(lodT||typeof setTimeout!=='function')return;lodT=setTimeout(()=>{lodT=0;if(W?.picsDirty){W.picsDirty=false;picFar=farLevel();}lodPass();},60);};
function buildStage(){
 const stage=document.createElement('div');stage.className='wm-stage';
 stage.innerHTML='<div class="wm-view"><div class="wm-slide"><svg class="yard-svg tilted world-svg" role="img" aria-label="Live map of the yard and the sites" viewBox="0 0 900 560"><defs>'+defsSVG(DEFS_EXTRA).slice(6,-7)+'</defs><rect class="wm-sky" x="-50000" y="-50000" width="100000" height="100000" fill="#a3b27a"/><g class="wm-cam"></g></svg>'
  // what moves every frame (the trucks and the site cranes) is drawn over the map, in a transparent svg and a layer of truck boxes: a truck driving
  // never repaints the map under it, only its own few shapes. The three move together in one box (.wm-slide) the camera slides and scales.
  +'<svg class="world-svg wm-over-svg" viewBox="0 0 900 560"><g class="wm-cam2"><g class="wm-air" pointer-events="none"></g></g></svg><div class="wm-tlayer"></div></div>'
  // the place name tags go on top of everything (cranes and trucks too) and are placed in screen pixels for the camera as it is at that moment, so
  // a camera glide never scales them up with the picture
  +'<svg class="world-svg wm-tag-svg" aria-hidden="true" viewBox="0 0 900 560"><g class="wm-tags"></g></svg>'
  +'<svg class="wm-mini" aria-label="Overview map: click to look there" role="img"></svg><div class="wm-note" hidden></div><button type="button" class="wm-watch" data-wm="watch" hidden></button></div>'
  // the card sits over the map's corner on a wide screen and under the map on a phone, so it never covers the truck it follows
  +'<div class="wm-card" hidden role="region" aria-live="polite"></div><div class="wm-strip" aria-label="Trucks" role="list"></div>';
 const svg=stage.querySelector('svg.yard-svg'),camG=svg.querySelector('.wm-cam'),over=stage.querySelector('svg.wm-over-svg'),tagSvg=stage.querySelector('svg.wm-tag-svg');W={stage,svg,over,tagSvg,slide:stage.querySelector('.wm-slide'),svgs:[svg,over],cam:camG,cam2:over.querySelector('.wm-cam2'),air:over.querySelector('.wm-air'),tlayer:stage.querySelector('.wm-tlayer'),tags:tagSvg.querySelector('.wm-tags'),card:stage.querySelector('.wm-card'),mini:stage.querySelector('.wm-mini'),strip:stage.querySelector('.wm-strip'),note:stage.querySelector('.wm-note'),watch:stage.querySelector('.wm-watch'),view:stage.querySelector('.wm-view'),w:900,h:560,diagG:new Map(),slotG:new Map(),placeG:new Map()};
 bindStage();if(typeof ResizeObserver==='function'){W.ro=new ResizeObserver(()=>measureView());W.ro.observe(W.view);}W.onScreen=true;if(typeof IntersectionObserver==='function'){W.io=new IntersectionObserver(es=>{for(const e of es){W.onScreen=e.isIntersecting;if(W.onScreen)kick();}});W.io.observe(W.view);}return W;}
// The svg is OVER times the view in each direction, centred on it: between repaints the camera slides and scales the finished picture (a CSS transform
// the compositor applies), and the svg is redrawn for the new camera when the slide would show an edge or blur, or once the camera rests.
const OVER=1.4;
function measureView(){if(!W)return;W.k=parseFloat(getComputedStyle(W.svg).getPropertyValue('--k'))||1;const r=W.view.getBoundingClientRect(),w=Math.max(200,R(r.width)),h=Math.max(160,R(r.height));if(w===W.w&&h===W.h)return;const first=!W.sized;W.w=w;W.h=h;W.sized=true;const VW=R(w*OVER),VH=R(h*OVER);for(const v of [...W.svgs,W.tagSvg,W.tlayer]){if(v!==W.tlayer)v.setAttribute('viewBox','0 0 '+VW+' '+VH);const st=v.style;st.width=VW+'px';st.height=VH+'px';const inSlide=v!==W.tagSvg;st.left=inSlide?'0px':R((w-VW)/2)+'px';st.top=inSlide?'0px':R((h-VH)/2)+'px';}{const st=W.slide.style;st.width=VW+'px';st.height=VH+'px';st.left=R((w-VW)/2)+'px';st.top=R((h-VH)/2)+'px';}W.tagCam=null;if(first&&W.fitPending&&built.layout){W.fitPending=false;fitNow(fitAllBox(built.layout));holdUntil=performance.now()+3500;}applyCam(true);kick();}
// Static scenery for a new layout: the ground pictures, then every block back to front for the view: its scenery picture (houses, trees) and the
// place on it. The trucks and cranes are drawn over all of it (the overlay svg).
function buildStatic(l){const st=wmStatic(l);dropAllPics();W.cam.replaceChildren();W.zq=0;
 const ground=el('g',{class:'wm-ground-pics'});W.cam.append(ground);for(const gc of st.grounds){const g=el('g',{class:'wm-ground-pic'});ground.append(g);setPic(g,gc.svg,gc.box,DEFS_PIC());}
 W.cellG=new Map();W.blks=[];
 for(const k of st.cells){const key=k.c+','+k.r,g=el('g',{class:'wm-d'}),b=st.blocks.get(key);if(b){const bg=el('g',{class:'wm-blk'});g.append(bg);setPic(bg,b.svg,b.box);W.blks.push({el:bg,bb:b.bb,on:true});}W.cam.append(g);W.cellG.set(key,g);}
 W.ghost=el('g',{class:'wm-ghost','pointer-events':'none'});W.cam.append(W.ghost);W.placeG=new Map();
 for(const p of l.places){const g=el('g',{class:'wm-place wm-'+p.kind+(p.archived?' wm-archived':''),transform:p.kind==='yard'?'translate('+p.ox+' '+p.oy+')':'translate(0 0)','data-wm-place':p.id});if(p.kind==='site'){g.setAttribute('data-wm-site',p.id);g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',(p.name||'Site')+': site details');}(W.cellG.get(p.col+','+p.row)??W.cam).append(g);W.placeG.set(p.id,g);}
 for(const t of trips.values())dropTruck(t);trips.clear();for(const c of cranes.values())c.g?.remove();cranes.clear();built.yard=null;built.sites=new Map();stateSeen=null;buildMini(l);W.picsDirty=true;}
// One site: the ground and the live stock patched in place; the static art (behind and in front of the stock) redrawn only when the layout, the view
// or whether it has a crane changes.
function syncSite(p,s){const g=W.placeG.get(p.id);if(!g||!s)return;let k=g.__wm;if(!k){g.replaceChildren();k=g.__wm={ground:el('g',{class:'wm-site-ground'}),back:el('g',{class:'wm-site-back'}),live:el('g',{class:'wm-site-live'}),front:el('g',{class:'wm-site-front'})};g.append(k.ground,k.back,k.live,k.front);}
 if(k.groundS!==s.ground){k.groundS=s.ground;setSVG(k.ground,s.ground);}
 const art=built.sig+'|'+(s.crane?1:0);if(k.artS!==art){k.artS=art;const a=wmSiteParts(p,built.layout,ctxNow.state,{},{live:false}),box=siteArtBox(p);setPic(k.back,a.back,box,DEFS_PIC());setPic(k.front,a.front,box,DEFS_PIC());W.picsDirty=true;}
 if(k.liveS!==s.live){k.liveS=s.live;setSVG(k.live,s.live);}}
// Called after every Home render or patch (operations.js bindPage), before the page binds [data-select] and animates the crew.
export function wmAttach(ctx){if(typeof document==='undefined')return;const host=document.querySelector('.scene [data-wm-host]');if(!host)return;ctxNow=ctx;const t0=performance.now();
 const key='worldcam:'+(ctx.account?.company?.id??'')+':'+(ctx.account?.user?.id??'');if(key!==camKey){camKey=key;cam=null;camTarget=null;followId=null;cardFor=null;}
 if(!W)buildStage();if(W.stage.parentNode!==host)host.replaceChildren(W.stage);bindBar();
 wmSignal(ctx);const l=live.layout;if(!l){revokeAll(W.cam);W.cam.replaceChildren();built.sig=null;return;}
 const sig=VK+'#'+layoutSig(l);if(sig!==built.sig){built.sig=sig;built.layout=l;buildStatic(l);// First look: the owner's own camera if they left it somewhere; else Fit all (every name readable) for a moment, then the director takes over.
  if(!cam){const saved=loadCam();mode=MODES.includes(saved?.mode)?saved.mode:'director';if(mode==='free'&&saved)cam={cx:saved.cx,cy:saved.cy,s:saved.s};else{cam={cx:0,cy:0,s:.01};W.fitPending=true;}}}
 if(!W.sized)measureView();if(W.fitPending&&W.sized){W.fitPending=false;fitNow(fitAllBox(l));holdUntil=performance.now()+3500;}
 // planning a yard layout or giving a worker a spot to go to happens on the yard: the camera goes there (and stays until the owner moves it)
 const yardWork=!!(ctx.layoutDraft||ctx.workerMoveMode);if(yardWork&&!W.yardWork){const yp=l.places.find(p=>p.kind==='yard');if(yp&&cam){userCam();if(cardFor)closeCard();animateTo(boxCam(yardBox(yp)));}
  // the order was given from the crew panel below the map: bring the whole map into view, as the next click goes on it
  if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>{if(!W?.stage?.isConnected)return;const r=W.view.getBoundingClientRect(),dy=r.top<8?r.top-8:r.bottom>innerHeight-8?Math.min(r.top-8,r.bottom-innerHeight+8):0;if(dy)scrollBy(0,dy);W.anchor=null;});}W.yardWork=yardWork;
 if(live.yard!==built.yard){const g=W.placeG.get(l.places.find(p=>p.kind==='yard')?.id);if(g){const old=workerPos(g);setSVG(g,live.yard);if(!W.far&&yardInView())glide(g,old);}built.yard=live.yard;W.U=live.U??W.U??30;}
 for(const p of l.places)if(p.kind==='site')syncSite(p,live.sites.get(p.id));
 if(ctx.state!==stateSeen){stateSeen=ctx.state;syncTrips(l,ctx);}tick();
 syncBar();syncTags(l,ctx);renderStrip(ctx);if(cardFor)renderCard();applyCam();if(W.picsDirty)lodSoon();else pumpPics();kick();holdSoon();measure('wm-attach',t0);}
// Scroll anchoring for the map: after a render or patch, if the page was not scrolled since the last one and the map moved on screen (content above
// it grew or shrank), scroll by the same amount so the map stays put under the owner's eyes. Measured in the next animation frame, where the
// browser lays the page out anyway (reading it straight after the patch would force a second layout).
let holdR=0;const holdSoon=()=>{if(holdR||typeof requestAnimationFrame!=='function')return;holdR=requestAnimationFrame(()=>{holdR=0;if(W?.stage?.isConnected)holdPlace();});};
function holdPlace(){if(typeof scrollY!=='number')return;const top=W.view.getBoundingClientRect().top,y=scrollY,a=W.anchor;if(a&&a.y===y&&y>0&&Math.abs(top-a.top)>1&&a.top<innerHeight&&a.top>-W.h){scrollBy(0,top-a.top);W.anchor={top:a.top,y:scrollY};return;}W.anchor={top,y};}
const yardInView=()=>{const yp=built.layout?.places.find(p=>p.kind==='yard');if(!yp||!W?.mat||!cam)return false;const b=boxProj({x0:yp.ext.x0,y0:yp.ext.y0,x1:yp.ext.x1,y1:yp.ext.y1,tall:3000}),C=proj({x:cam.cx,y:cam.cy}),x0=cam.s*(b.x0-C.x)+W.w/2,x1=cam.s*(b.x1-C.x)+W.w/2,y0=cam.s*(b.y0-C.y)+W.h/2,y1=cam.s*(b.y1-C.y)+W.h/2;return x1>0&&x0<W.w&&y1>0&&y0<W.h;};
const workerPos=g=>new Map([...g.querySelectorAll('[data-worker],[data-forklift],[data-glide]')].map(n=>[n.dataset.worker??n.dataset.forklift??n.dataset.glide,n.getAttribute('transform')]));
function glide(g,old){if(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;for(const n of g.querySelectorAll('[data-worker],[data-forklift],[data-glide]')){const id=n.dataset.worker??n.dataset.forklift??n.dataset.glide,b=old.get(id),a=n.getAttribute('transform');if(b&&a&&b!==a&&n.dataset.wmGlide!==a){n.dataset.wmGlide=a;const css=t=>t.replace(/translate\(([-.0-9]+) ([-.0-9]+)\)/,'translate($1px, $2px)');try{n.animate([{transform:css(b)},{transform:css(a)}],{duration:900,easing:'linear'});}catch{}}}}

// ---- trucks: parked ones where their spot is, driving ones along their route.
// Each truck is its own small element over the map (an HTML box holding its art and its name tag). A driving truck is moved by a Web Animation the
// browser plays on the compositor: its positions for the next few seconds are worked out from the shared countdown whenever a poll arrives or the
// camera changes, so the drive stays smooth even while the page is busy, and the map under it is never repainted for it.
function syncTrips(l,ctx){const st=ctx.state,now=performance.now(),seen=new Set(),rest=live.rest??new Map(),paused=!!st.config?.paused;
 for(const t of (st.trucks??[]).filter(t=>!t.retired)){let tr=trips.get(t.id);
  // a stored road is drawn while it still matches the map; after the map changed (a site moved, a new site resized the blocks) the same trip is
  // drawn on today's roads, at the same fraction of the way, the same in every browser
  if(t.status==='IN_TRANSIT'){const stored=t.route?.points?.length>1&&routeFits(l,t.route);let route=stored?t.route:null;if(!route){const r=worldRoute(l,t,t.route?.from??t.at,t.route?.to??t.destination);route=r?{...r,durationMs:t.route?.durationMs??Math.max(3000,t.remainingMs??3000)}:null;}if(!route)continue;
   const D=route.durationMs??t.route?.durationMs??3000,key=t.id+':'+(t.route?.delivery??t.delivery)+':'+(stored?'s':'r'+l.bw+','+l.bh+','+route.points.length+','+route.points.at(-1).join(','));if(!tr||tr.key!==key){tr={...(tr??{}),key,geom:routeGeom(route),D,u:null};trips.set(t.id,tr);}
   if(tr.u!=null)advance(tr,now);tr.driving=true;tr.D=D;tr.anchorR=Math.max(0,t.remainingMs??D);tr.anchorT=now;tr.paused=paused;tr.to=t.destination;tr.from=t.at;if(tr.u==null){tr.u=clamp(1-tr.anchorR/D,0,1);tr.uT=now;}}
  else{const pose=rest.get(t.id);if(!pose||(pose.bay&&st.yards?.[0]?.id===t.at)){if(tr){dropTruck(tr);trips.delete(t.id);}continue;}if(!tr){tr={key:'rest'};trips.set(t.id,tr);}if(tr.driving)tr.arrivedT=now;tr.driving=false;tr.pose=pose;tr.u=null;tr.geom=null;}
  tr.truck=t;tr.cargo=itemsOf(st).filter(c=>c.location===t.id);seen.add(t.id);}
 for(const [id,tr] of trips)if(!seen.has(id)){dropTruck(tr);trips.delete(id);}
 syncCranes(l,ctx);const lifted=liftedNow();for(const tr of trips.values())if(tr.truck)planTruck(tr,now,lifted);}
const dropTruck=tr=>{tr.anim?.cancel();clearTimeout(tr.swapT);clearTimeout(tr.replanT);tr.g?.remove();};
// The drive between polls: the truck eases toward where the shared countdown says it should be (never backwards, never jumping), in fixed steps so
// the positions planned ahead and the position asked for now agree.
const STEP=16;
// The truck never gets to its stop before the server says it has arrived (U_MAX): a browser that ran ahead (a stalled page catching up) waits at
// the last metre instead of parking early.
const U_MAX=.995;
function advance(tr,to,m=tr){if(!tr.driving||m.u==null)return;if(tr.paused){m.uT=to;return;}let t=m.uT??to;while(t+STEP<=to){t+=STEP;const target=clamp(1-(tr.anchorR-(t-tr.anchorT))/tr.D,0,U_MAX),err=(target-m.u)*tr.D,speed=clamp(1+err/1200,0.25,2.2);m.u=clamp(m.u+STEP/tr.D*speed,0,U_MAX);}m.uT=t;}
function poseNow(tr,now){if(!tr.driving)return tr.pose;advance(tr,now);return poseAt(tr.geom,distanceAt(tr.geom,tr.u,tr.D));}
const tripPose=(tr,now)=>poseNow(tr,now);
// The truck's element: art drawn for the committed camera around the truck's own centre, and its name tag.
function truckEl(tr){if(tr.g)return tr.g;const t=tr.truck,g=document.createElement('div');g.className='wm-truck';g.dataset.wmTruck=t.id;g.tabIndex=0;g.setAttribute('role','button');g.innerHTML='<svg class="wm-tsvg" aria-hidden="true"><g></g></svg><span class="wm-ttag"></span>';tr.g=g;tr.svg=g.firstChild;tr.art=tr.svg.firstChild;tr.tag=g.lastChild;W.tlayer.append(g);return g;}
function truckArt(tr,hk,lifted){const t=tr.truck,cargo=tr.cargo.filter(c=>!lifted?.has(c.id)),m=W.mat,ak=VK+'|'+hk+'|'+cargo.map(c=>c.id+c.x+c.y+c.support).join(',')+'|'+[m.a,m.b,m.c,m.d].map(v=>v.toFixed(7)).join(',');if(tr.ak===ak)return;tr.ak=ak;tr.hk=hk;
 const r=Math.ceil(14000*Math.hypot(m.a,m.b,m.c,m.d))+6,sv=tr.svg;sv.setAttribute('viewBox',(-r)+' '+(-r)+' '+2*r+' '+2*r);sv.setAttribute('width',2*r);sv.setAttribute('height',2*r);sv.style.left=-r+'px';sv.style.top=-r+'px';tr.r=r;
 tr.art.setAttribute('transform','matrix('+[m.a,m.b,m.c,m.d].map(v=>+v.toFixed(7)).join(' ')+' 0 0)');tr.art.innerHTML='<title>'+esc(t.name)+'</title>'+truckArtAt(t,hk,cargo);
 const u=up(G+truckDims(t).CH+500);tr.tag.style.left=R(m.a*u.x+m.c*u.y)+'px';tr.tag.style.top=R(m.b*u.x+m.d*u.y)+'px';}
function truckLabel(tr){const t=tr.truck,txt=t.name+(tr.driving?' → '+placeName(tr.to):'');if(tr.tagText!==txt){tr.tagText=txt;tr.tag.textContent=txt;}const label=t.name+(tr.driving?' driving to '+placeName(tr.to):' at '+placeName(t.at))+': follow on the map';if(tr.label!==label){tr.label=label;tr.g.setAttribute('aria-label',label);}
 tr.g.classList.toggle('followed',followId===t.id);tr.g.classList.toggle('parked',!tr.driving);tr.tag.style.borderColor=truckDims(t).trim;}
// Place the truck for the committed camera: parked ones once, driving ones as a Web Animation of the next few seconds of their drive.
const AHEAD=3200,KEY=80;
function planTruck(tr,now,lifted){if(!W?.mat||!tr.truck)return;truckEl(tr);truckLabel(tr);
 // where the old plan shows the truck right now (same camera only), so the new plan starts there and blends into its own course in 320 ms
 const mk=[W.mat.a,W.mat.b,W.mat.e,W.mat.f].join(',');let from=null;try{if(tr.anim&&tr.pts&&tr.mk===mk&&tr.anim.currentTime!=null){const f=clamp(tr.anim.currentTime/KEY,0,tr.pts.length-1),i=Math.floor(f),j=Math.min(tr.pts.length-1,i+1),w=f-i;from={x:tr.pts[i].x+(tr.pts[j].x-tr.pts[i].x)*w,y:tr.pts[i].y+(tr.pts[j].y-tr.pts[i].y)*w};}}catch{from=null;}
 tr.anim?.cancel();tr.anim=null;clearTimeout(tr.swapT);clearTimeout(tr.replanT);tr.mk=mk;tr.pts=null;
 const css=q=>'translate('+q.x.toFixed(1)+'px,'+q.y.toFixed(1)+'px)',at=p=>css(toScreen(p));
 if(!tr.driving||tr.paused||(tr.u??0)>=1){const pose=poseNow(tr,now);tr.at=pose;truckArt(tr,headingKey(pose.hx,pose.hy),lifted);tr.g.style.transform=at(pose);return;}
 const m={u:tr.u,uT:tr.uT},frames=[],heads=[],pts=[];let off=null;for(let t=0;t<=AHEAD;t+=KEY){advance(tr,now+t,m);const p=poseAt(tr.geom,distanceAt(tr.geom,m.u,tr.D));if(!t)tr.at=p;const q=toScreen(p);if(!t&&from&&Math.hypot(from.x-q.x,from.y-q.y)<80)off={x:from.x-q.x,y:from.y-q.y};if(off&&t<320){const f=1-t/320;q.x+=off.x*f;q.y+=off.y*f;}pts.push(q);frames.push({transform:css(q),offset:t/AHEAD});const hk=headingKey(p.hx,p.hy);if(!heads.length||heads.at(-1).hk!==hk)heads.push({t,hk});}
 tr.pts=pts;truckArt(tr,heads[0].hk,lifted);tr.g.style.transform=frames[0].transform;
 if(typeof tr.g.animate==='function'&&!(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)){try{tr.anim=tr.g.animate(frames,{duration:AHEAD,fill:'forwards',easing:'linear'});}catch{tr.anim=null;}}
 // the art turns with the road, and the drive is planned again before this stretch runs out if no poll comes
 let k=1;const nextHead=()=>{if(k>=heads.length)return;const h=heads[k++];tr.swapT=setTimeout(()=>{if(tr.g?.isConnected){truckArt(tr,h.hk,liftedNow());}nextHead();},Math.max(0,h.t-(performance.now()-now)));};nextHead();
 tr.replanT=setTimeout(()=>{if(tr.g?.isConnected&&tr.driving)planTruck(tr,performance.now(),liftedNow());},AHEAD-600);}
const liftedNow=()=>new Set([...cranes.values()].map(c=>c.load?.id).filter(Boolean));
function replanTrucks(){const now=performance.now(),lifted=liftedNow();for(const tr of trips.values())if(tr.truck)planTruck(tr,now,lifted);}
const placeName=id=>built.layout?.byId.get(id)?.name??'the site';

// ---- the site crane: a hook that eases toward where the current lift wants it; the load hangs from it from pickup to set-down
const PHASES=['QUEUED','RESERVED','ASSIGNED','TRAVELLING_TO_PICKUP','PICKING','CARRYING','PLACING','COMPLETE'];
function syncCranes(l,ctx){const st=ctx.state,now=performance.now(),cfg=st.config??{},step=cfg.stepMs??700,speed=cfg.speed??4000;
 for(const p of l.places){if(p.kind!=='site')continue;const has=craneKind(st,p.id).length>0;let c=cranes.get(p.id);if(!has){if(c){c.g?.remove();cranes.delete(p.id);}continue;}
  if(!c){const geo=craneOf(p,l);c={geo,site:p.id,cur:{a:Math.atan2((p.ext.y0+p.ext.y1)/2-geo.y,(p.ext.x0+p.ext.x1)/2-geo.x),r:geo.reach*.45,z:geo.H-5000},g:el('g',{class:'wm-crane'})};c.g.innerHTML='<g class="wm-mast">'+mastSVG(geo)+'</g><g class="wm-jib"></g>';c.jib=c.g.lastChild;W.air.append(c.g);cranes.set(p.id,c);}
  const tasks=(st.tasks??[]).filter(t=>t.handling===p.id&&t.state!=='BLOCKED');const t=tasks.find(t=>t.resources?.length&&PHASES.indexOf(t.state)>=2)??null;c.task=t?{...t,anchorT:now,carryMs:t.path?.length>1?Math.max(step,t.path.slice(1).reduce((s,q,i)=>s+Math.hypot(q.x-t.path[i].x,q.y-t.path[i].y),0)/speed*1000):step}:null;c.step=step;c.paused=!!cfg.paused;c.blocked=(st.tasks??[]).find(t=>t.handling===p.id&&t.state==='BLOCKED')??null;c.waiting=tasks.length>0;
  c.items=itemsOf(st);c.place=p;}}
// Where the hook wants to be now, from the task's phase predicted forward from the poll (each step lasts its due, then one engine tick).
function craneWant(c,now){const t=c.task,geo=c.geo,rest={a:c.cur.a,r:Math.max(4000,c.cur.r),z:geo.H-5000};if(!t)return {...rest,load:null};
 const dur=s=>(s==='CARRYING'?t.carryMs:c.step)+250;let s=t.state,left=Math.max(0,(t.due??0)-(c.paused?0:now-t.anchorT))+250,el0=now-t.anchorT;
 if(!c.paused){let spent=el0;let i=PHASES.indexOf(s);let rem=(t.due??0)+250;while(spent>rem&&i<PHASES.length-1){spent-=rem;i++;s=PHASES[i];rem=dur(s);}left=Math.max(0,rem-spent);}
 const frac=1-left/dur(s),item=c.items.find(x=>x.id===t.container),src=pointOf(c,t.from,item,false),dst=pointOf(c,t.to,t.position?{...item,...t.position}:item,true);
 const polar=q=>({a:Math.atan2(q.y-geo.y,q.x-geo.x),r:clamp(Math.hypot(q.x-geo.x,q.y-geo.y),3000,geo.reach)}),hi=geo.H-6000,h=item?.height??1000;
 if(!src||!dst)return {...rest,load:null};
 if(['QUEUED','RESERVED','ASSIGNED','TRAVELLING_TO_PICKUP'].includes(s))return {...polar(src),z:hi,load:null,phase:s};
 if(s==='PICKING')return {...polar(src),z:hi+(src.z+h+400-hi)*Math.min(1,frac*1.6),load:null,phase:s};
 if(s==='CARRYING'){const f=frac,liftF=clamp(f/.22,0,1),moveF=clamp((f-.18)/.64,0,1),dropF=clamp((f-.8)/.2,0,1),A=polar(src),B=polar(dst);let da=B.a-A.a;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;const m=moveF<.5?2*moveF*moveF:1-2*(1-moveF)*(1-moveF);const z0=src.z+h+400,z1=dst.z+h+1800;return {a:A.a+da*m,r:A.r+(B.r-A.r)*m,z:moveF<1?z0+(hi-z0)*liftF:hi+(z1-hi)*dropF,load:item,phase:s};}
 if(s==='PLACING')return {...polar(dst),z:dst.z+h+400+1400*(1-Math.min(1,frac*1.4)),load:item,phase:s};
 return {...polar(dst),z:hi,load:null,phase:s};}
// A place, a truck deck or the site ground as a world point with the height of its surface.
function pointOf(c,locId,item,isDest){const l=built.layout;if(!item)return null;const p=l.byId.get(locId);const rw=item.rotation===90?item.envelopeWidth:item.envelopeLength,rh=item.rotation===90?item.envelopeLength:item.envelopeWidth;
 if(p){const z=placeRect(p,item.x,item.y,rw,rh);return {x:z.x+rw/2,y:z.y+rh/2,z:0};}const tr=trips.get(locId);if(tr?.at){const t=tr.truck,D=truckDims(t),a=headingKey(tr.at.hx,tr.at.hy)*HEAD_STEP,hx=Math.cos(a),hy=Math.sin(a),total=truckTotal(t),tw=t.width??2050,X=item.x+rw/2,Y=item.y+rh/2;return {x:tr.at.x+(X-total/2)*hx+(Y-tw/2)*hy,y:tr.at.y+(X-total/2)*hy-(Y-tw/2)*hx,z:G+D.DK};}return null;}
function stepCrane(c,now,dt){const w=craneWant(c,now),k=dt==null?1:1-Math.exp(-dt/260);let da=w.a-c.cur.a;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;const maxA=dt==null?Math.PI:dt/1000*1.6;c.cur.a+=clamp(da*k*2,-maxA,maxA);c.cur.r+=(w.r-c.cur.r)*k;c.cur.z+=(w.z-c.cur.z)*k;
 c.load=w.load;c.moving=Math.abs(da)>0.002||Math.abs(w.r-c.cur.r)>20||Math.abs(w.z-c.cur.z)>20||(!!c.task&&!c.paused&&w.phase!=='COMPLETE');// redrawn only when the hook has moved about a pixel on screen (far out, a crane at work costs almost nothing)
 const px=1.2/Math.max(1e-6,cam?.s??1),key=[VK,R(c.cur.a*c.geo.reach/px),R(c.cur.r/px),R(c.cur.z/px),c.load?.id??''].join('|');if(key!==c.key){c.key=key;c.jib.innerHTML=craneSVG(c);}return c.load?.id??null;}
function craneSVG(c){const g=c.geo,a=c.cur.a,dx=Math.cos(a),dy=Math.sin(a),nx=-dy,ny=dx,base={x:g.x,y:g.y},Z=G+g.H,J=g.reach,cj=J*.3,pt=(r,side=0)=>({x:base.x+dx*r+nx*side,y:base.y+dy*r+ny*side});
 let lace='';for(let r=-cj,k=0;r<J-900;r+=1800,k++)lace+='M'+P(at(pt(r,k%2?-550:550),Z))+'L'+P(at(pt(r+900,0),Z+1300));
 const chord='M'+P(at(pt(-cj,-550),Z))+'L'+P(at(pt(J,-200),Z))+'M'+P(at(pt(-cj,550),Z))+'L'+P(at(pt(J,200),Z))+'M'+P(at(pt(-cj,0),Z+1300))+'L'+P(at(pt(J,0),Z+400));
 const apex=at(base,Z+5200),ties='M'+P(apex)+'L'+P(at(pt(J*.62),Z+1100))+'M'+P(apex)+'L'+P(at(pt(-cj),Z+1300));
 const cw=[pt(-cj+300,-900),pt(-cj+2600,-900),pt(-cj+2600,900),pt(-cj+300,900)];const trolley=pt(c.cur.r),hookZ=G+Math.max(600,c.cur.z),hook=at(trolley,hookZ);
 let s=block(E,cw,Z-1400,Z,'#9b9d98','#b9bbb5','#4f524e',16)+'<path d="M'+P(at(base,Z))+'L'+P(apex)+'" stroke="#e5ad1f" stroke-width="2.4"'+NSK+'/><path d="'+ties+'" stroke="#4f565a" stroke-width=".9"'+NSK+'/>';
 s+=block(E,[pt(-300,650),pt(1500,650),pt(1500,1900),pt(-300,1900)],Z-1500,Z,'#f0c230','#ffd84d','#7a5a0e',16)+'<path d="'+lace+'" stroke="#c8901a" stroke-width="1"'+NSK+'/><path d="'+chord+'" stroke="#e5ad1f" stroke-width="1.9"'+NSK+' stroke-linejoin="round"/>';
 s+='<path d="M'+P(at(trolley,Z))+'L'+P(hook)+'" stroke="#2b2f31" stroke-width="1.2"'+NSK+'/>'+block(E,box4(trolley.x-450,trolley.y-450,900,900),Z-300,Z,'#3e4446','#5a6164','#1d2224',12)+block(E,box4(trolley.x-330,trolley.y-330,660,660),hookZ-600,hookZ,'#f0a81c','#ffd36a','#7a5410',14);
 if(c.load){const it=c.load,rw=it.rotation===90?it.envelopeWidth:it.envelopeLength,rh=it.rotation===90?it.envelopeLength:it.envelopeWidth,h=it.height||1000,z=hookZ-1300-h,cs=box4(trolley.x-rw/2,trolley.y-rh/2,rw,rh);s+='<path d="M'+P(hook)+'L'+P(at(cs[0],z+h))+'M'+P(hook)+'L'+P(at(cs[1],z+h))+'M'+P(hook)+'L'+P(at(cs[2],z+h))+'M'+P(hook)+'L'+P(at(cs[3],z+h))+'" stroke="#2b2f31" stroke-width=".9"'+NSK+'/>'+shadowOf(E,cs,0,.18,up(G))+cargoBox(it,cs,z);}
 return s;}

// ---- camera: screen = s * (L p - C) + centre of the view
let camC=null,slideT=0;
// Where the committed picture sits for camera v: its scale k against the picture and its shift (tx,ty) in view pixels; covered when it still fills the view.
// The truck name tags ride on the truck layer and are scaled back by 1/k (--ik), so they keep their size while the picture is scaled.
const setSlide=(t,k=1)=>{W.slide.style.transform=t;W.slideOn=!!t;const ik=t?String(+(Math.round(50/k)/50).toFixed(2)):'1';if(W.ik!==ik){W.ik=ik;W.tlayer.style.setProperty('--ik',ik);}};
const slideCSS=q=>'translate('+q.tx.toFixed(2)+'px,'+q.ty.toFixed(2)+'px) scale('+q.k.toFixed(5)+')';
function slideOf(v){const k=v.s/camC.s,Cc=proj({x:camC.cx,y:camC.cy}),Cl=proj({x:v.cx,y:v.cy}),tx=v.s*(Cc.x-Cl.x),ty=v.s*(Cc.y-Cl.y);return {k,tx,ty,ok:k*OVER*W.w/2-Math.abs(tx)>=W.w/2+2&&k*OVER*W.h/2-Math.abs(ty)>=W.h/2+2};}
function applyCam(force){if(!W||!cam)return;if(camPlan&&!force)return;// a planned glide is being played
 // back exactly on the committed camera: no slide may be left showing (a stale scaled picture with the zoom saying 100%)
 if(!force&&camC&&cam.cx===camC.cx&&cam.cy===camC.cy&&cam.s===camC.s){if(W.slideOn){setSlide('');W.sliding=false;zoomLabel();drawMiniView();placeTags();}return;}
 if(!force&&camC&&W.sized){const q=slideOf(cam);
  if(q.ok&&q.k<(W.glide?10:1.3)){setSlide(slideCSS(q),q.k);W.sliding=true;slideT=performance.now();zoomLabel();panTags();if(ctxNow?.selected)ctxNow.placeSoon?.();return;}}
 commitCam();}
// Before a camera glide: if the committed picture cannot cover the whole way, draw one picture (at the lower zoom) that covers both ends, so the glide
// itself only slides and scales that picture (the compositor's work); it is drawn sharp again once the camera rests. One or two redraws per move.
// The camera that shows both ends of a glide at the lower zoom (the picture drawn for it covers the whole way).
function glideSu(t,cam=camNow()){const a=proj({x:cam.cx,y:cam.cy}),b=proj({x:t.cx,y:t.cy}),wa=W.w/2/cam.s,ha=W.h/2/cam.s,wb=W.w/2/t.s,hb=W.h/2/t.s;
 const x0=Math.min(a.x-wa,b.x-wb),x1=Math.max(a.x+wa,b.x+wb),y0=Math.min(a.y-ha,b.y-hb),y1=Math.max(a.y+ha,b.y+hb);return {C:{x:(x0+x1)/2,y:(y0+y1)/2},su:Math.min(cam.s,t.s,.98*OVER*W.w/(x1-x0),.98*OVER*W.h/(y1-y0))};}
const camNow=()=>cam;
function prepareGlide(t,force){if(!W?.sized||!camC||!cam)return;if(!force&&slideOf(cam).ok&&slideOf(t).ok)return;const {C,su}=glideSu(t),inv=E.inverse;
 const keep=cam;W.glide=true;cam={cx:inv[0]*C.x+inv[2]*C.y,cy:inv[1]*C.x+inv[3]*C.y,s:su};commitCam();cam=keep;applyCam();}
function commitCam(){if(camPlan)cancelPlan();const tc0=performance.now(),keep=cam,lead=followId&&W.lead&&!W.glide?W.lead:null;if(lead){const d=(OVER-1)/2*.8*Math.min(W.w,W.h)/cam.s;cam={...cam,cx:cam.cx+lead.x*d,cy:cam.cy+lead.y*d};}camC={...cam};W.sliding=false;setSlide('');const VW=W.w*OVER,VH=W.h*OVER;const C=proj({x:cam.cx,y:cam.cy}),s=cam.s,a=s*L[0],b=s*L[1],c=s*L[2],d=s*L[3],e=VW/2-s*C.x,f=VH/2-s*C.y;{const m='matrix('+[a,b,c,d,e,f].map(n=>+n.toFixed(6)).join(' ')+')';W.cam.setAttribute('transform',m);W.cam2.setAttribute('transform',m);}cull(C,s,VW,VH);
 // --z (the yard plan's label scale) restyles every shape under the svg when it changes, so it moves in 4% steps only
 const z=s*(W.U??30);if(!W.zq||Math.abs(z/W.zq-1)>.04||W.uq!==W.U){W.zq=z;W.uq=W.U;W.svg.style.setProperty('--z',String(+z.toFixed(3)));W.svg.style.setProperty('--u',String(+(W.U??30).toFixed(2)));}W.far=z<.55;for(const v of [...W.svgs,W.tagSvg,W.tlayer]){v.classList.toggle('wm-far',z<.55);v.classList.toggle('wm-mid',z<1.1);v.classList.toggle('wm-near',z>=.72);}const fb='fb'+labelBand(labelRoom(z,W.k??1));if(fb!==W.fb||!W.svg.classList.contains(fb)){for(const c of [...W.svg.classList])if(/^fb[0-9]+$/.test(c))W.svg.classList.remove(c);W.svg.classList.add(fb);W.fb=fb;}
 W.mat={a,b,c,d,e,f};zoomLabel();drawMiniView();if(ctxNow?.selected)ctxNow.placeSoon?.();
 lodSoon();replanTrucks();measure('wm-commit',tc0);
 if(lead){cam=keep;const q=slideOf(cam);if(q.ok&&q.k<1.3){setSlide(slideCSS(q),q.k);W.sliding=true;slideT=performance.now();}else{W.lead=null;commitCam();return;}}
 placeTags();}
// The zoom shown on the bar: 100% is Fit all (the yard and every site in view).
function zoomLabel(){const zl=document.querySelector('.scene .wm-zl');if(!zl||!cam||!built.layout)return;const f=fitScale(fitAllBox(built.layout)),t=f>0?R(cam.s/f*100)+'%':'';if(zl.textContent!==t)zl.textContent=t;}
const toScreen=p=>{const m=W.mat;return {x:m.a*p.x+m.c*p.y+m.e,y:m.b*p.x+m.d*p.y+m.f};};
// Scenery blocks and sites far outside the drawn area are left out of the picture (display none) until the camera comes near.
function cull(C,s,VW,VH){const m=Math.max(VW,VH)*.25,vis=(x0,y0,x1,y1)=>!(s*(x1-C.x)+VW/2<-m||s*(x0-C.x)+VW/2>VW+m||s*(y1-C.y)+VH/2<-m||s*(y0-C.y)+VH/2>VH+m);
 for(const b of W.blks??[]){const on=vis(...b.bb);if(on!==b.on){b.on=on;if(on)b.el.removeAttribute('display');else b.el.setAttribute('display','none');}}
 for(const p of built.layout?.places??[]){if(p.kind!=='site')continue;const g=W.placeG.get(p.id);if(!g)continue;const cs=[{x:p.block.x0,y:p.block.y0},{x:p.block.x1,y:p.block.y0},{x:p.block.x1,y:p.block.y1},{x:p.block.x0,y:p.block.y1}].map(proj),t=proj(up(30000)).y,on=vis(Math.min(...cs.map(q=>q.x)),Math.min(...cs.map(q=>q.y))+t,Math.max(...cs.map(q=>q.x)),Math.max(...cs.map(q=>q.y)));if(on!==(g.getAttribute('display')!=='none')){if(on)g.removeAttribute('display');else g.setAttribute('display','none');}}}
const toWorld=(sx,sy)=>{const C=proj({x:cam.cx,y:cam.cy}),q={x:(sx-W.w/2)/cam.s+C.x,y:(sy-W.h/2)/cam.s+C.y},inv=E.inverse;return {x:inv[0]*q.x+inv[2]*q.y,y:inv[1]*q.x+inv[3]*q.y};};
const sMax=()=>6/(W?.U??30),sMin=()=>Math.min(fitScale(fitAllBox(built.layout))*.6,.2/(W?.U??30));
// Everything that matters: each place with the building and crane behind a site and the street in front where the trucks stop.
function fitAllBox(l){if(!l)return {x0:-30000,y0:-30000,x1:30000,y1:30000};let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of l.places){const b=placeBox(p);x0=Math.min(x0,b.x0);y0=Math.min(y0,b.y0);x1=Math.max(x1,b.x1);y1=Math.max(y1,b.y1);}return {x0,y0,x1,y1,tall:18000};}
// A place with what belongs to it on the map: its ground, the site's building and crane behind it, the street in front where the trucks stop.
function placeBox(p,m=6000){const e=p.ext,b=p.kind==='site'?buildingOf(p,built.layout??{bw:p.block.x1-p.block.x0}):null,ys=[e.y0-(p.kind==='yard'?4000:2000),e.y1+2000,p.streetY-4000,p.streetY+4000];if(b)ys.push(b.y,b.y+b.d);return {x0:e.x0-m,x1:e.x1+m,y0:Math.min(...ys),y1:Math.max(...ys),tall:p.kind==='site'?20000:6000};}
const siteBox=p=>placeBox(p,8000);
function boxProj(b){const cs=[{x:b.x0,y:b.y0},{x:b.x1,y:b.y0},{x:b.x1,y:b.y1},{x:b.x0,y:b.y1}].map(proj),top=proj(up(b.tall??6000));const xs=cs.map(p=>p.x),ys=cs.map(p=>p.y);return {x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys)+top.y,y1:Math.max(...ys)};}
// A shot fills the view but for a 7% margin (the hold test below allows 6%, so a framed shot holds still).
function fitScale(b){if(!b||!W)return .01;const q=boxProj(b);return Math.min(W.w*.86/(q.x1-q.x0),W.h*.86/(q.y1-q.y0));}
function boxCam(b){const q=boxProj(b),C={x:(q.x0+q.x1)/2,y:(q.y0+q.y1)/2},inv=E.inverse;return {cx:inv[0]*C.x+inv[2]*C.y,cy:inv[1]*C.x+inv[3]*C.y,s:clamp(fitScale(b),W?sMin():0,W?sMax():1)};}
function fitNow(b){if(!W)return;cancelPlan();const t=boxCam(b);cam={...t};camTarget=null;applyCam(true);}
const boxAround=(p,r,tall=6000)=>({x0:p.x-r,y0:p.y-r,x1:p.x+r,y1:p.y+r,tall});
// The director: frames the drive (the truck and where it is going), the unloading (the site, its crane and the truck at the gate), the loading yard,
// or everything. On a phone it frames only a drive or an unloading; otherwise the whole district stays in view with every name readable.
let lastFocus=null,lastFocusT=0,holdUntil=0;
const phone=()=>!!W&&W.w<560;
// A drive is framed once for the whole trip (the road from where the truck is to where it stops, and the place it is going), so the camera holds
// still while the truck drives across the shot.
let driveFocus=null;
function tripBox(tr){const P=tr.geom.P,i0=Math.max(0,tr.geom.cum.findIndex(c=>c>=distanceAt(tr.geom,tr.u??0,tr.D))-1);let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(let i=i0;i<P.length;i++){x0=Math.min(x0,P[i][0]);y0=Math.min(y0,P[i][1]);x1=Math.max(x1,P[i][0]);y1=Math.max(y1,P[i][1]);}
 const p=tr.at;x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);const dest=built.layout?.byId.get(tr.to);if(dest?.kind==='site'){const b=placeBox(dest,4000);x0=Math.min(x0,b.x0);y0=Math.min(y0,b.y0);x1=Math.max(x1,b.x1);y1=Math.max(y1,b.y1);}else if(dest?.bay){x0=Math.min(x0,dest.bay.x-4000);y0=Math.min(y0,dest.bay.y-4000);x1=Math.max(x1,dest.bay.x+dest.bay.width+4000);y1=Math.max(y1,dest.bay.y+dest.bay.length+4000);}// back to the yard: its bay
 const cx=(x0+x1)/2,cy=(y0+y1)/2,hw=Math.max(34000,(x1-x0)/2+12000),hh=Math.max(30000,(y1-y0)/2+12000);return {x0:cx-hw,y0:cy-hh,x1:cx+hw,y1:cy+hh,tall:dest?.kind==='site'?20000:8000};}
const unloadBox=p=>{const e=p.ext,c=craneOf(p,built.layout),ys=[e.y0,e.y1,c.y-3000,c.y+3000,p.streetY-3000,p.streetY+3000];return {x0:Math.min(e.x0,c.x-3000)-3000,y0:Math.min(...ys)-2000,x1:Math.max(e.x1,c.x+3000)+3000,y1:Math.max(...ys)+2000,tall:c.H+7000};};
const yardBox=yp=>({x0:yp.ext.x0-3000,y0:yp.ext.y0-3000,x1:yp.ext.x1+3000,y1:yp.streetY,tall:4000});
const unloadingAt=(st,t)=>(st?.tasks??[]).some(k=>k.from===t.id||(t.status==='AT_SITE'&&k.to===t.id))?t.at:null;// the crane lifting off or on
// Nothing happening: hold the last shot a few seconds (the loaded truck, the unloaded site) before pulling back to the whole district.
function directorBox(now){const l=built.layout;if(!l)return null;const f=directorFocus(now,l);if(f){lastFocus=f;lastFocusT=now;return f;}return lastFocus&&now-lastFocusT<7000?lastFocus:fitAllBox(l);}
// Who gets the shot: the truck the owner last sent, unloaded or loaded (while it is doing something); then a truck that has just arrived and waits
// to be unloaded; then a site crane at work; then the trucks on the road (two in one shot while both still read as trucks, about 30 px long).
function directorFocus(now,l){const st=ctxNow?.state;
 if(followId){const tr=trips.get(followId),t=st?.trucks?.find(x=>x.id===followId),yp=l.places.find(p=>p.kind==='yard');const u=t&&unloadingAt(st,t),site=u&&l.byId.get(u);if(site?.kind==='site')return unloadBox(site);
  if(tr?.at)return boxAround(tr.at,26000);if(t&&yp&&t.at===yp.id)return boxAround({x:yp.bay.x+yp.bay.width/2,y:yp.bay.y+yp.bay.length/2},24000);return null;}
 const trk=st?.trucks??[],focusOf=id=>{const t=trk.find(x=>x.id===id),tr=trips.get(id);if(!t)return null;const u=unloadingAt(st,t),site=u&&l.byId.get(u);if(site?.kind==='site')return unloadBox(site);if(tr?.driving&&tr.at&&(tr.u??0)<1)return tripBox(tr);
  if(t.status==='AT_SITE'&&itemsOf(st).some(c=>c.location===t.id)){const p=l.byId.get(t.at);if(p?.kind==='site')return unloadBox(p);}const yp=l.places.find(p=>p.kind==='yard');if(yp&&t.at===yp.id&&(st.tasks??[]).some(k=>k.to===t.id||k.from===t.id))return yardBox(yp);return null;};
 if(W.acted&&now-W.acted.t<180000){const f=focusOf(W.acted.id);if(f)return f;}
 const waiting=[...trips.values()].filter(tr=>tr.arrivedT&&now-tr.arrivedT<20000&&tr.truck?.status==='AT_SITE'&&tr.cargo?.length&&!openTasks(st,tr.truck).length).sort((a,b)=>b.arrivedT-a.arrivedT)[0];if(waiting){const p=l.byId.get(waiting.truck.at);if(p?.kind==='site')return unloadBox(p);}
 const busySite=l.places.find(p=>p.kind==='site'&&(st?.tasks??[]).some(t=>t.handling===p.id&&t.state!=='BLOCKED'));if(busySite)return unloadBox(busySite);
 const drives=[...trips.values()].filter(t=>t.driving&&t.at&&(t.u??0)<1);if(drives.length){const pick=drives.find(t=>t.truck?.id===driveFocus)??drives.sort((a,b)=>(b.u??0)-(a.u??0))[0];driveFocus=pick.truck?.id;
  if(drives.length>1){const u=drives.map(tripBox).reduce((a,b)=>({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1),tall:Math.max(a.tall,b.tall)}));if(fitScale(u)*8000>=30)return u;}return tripBox(pick);}
 if(phone())return null;
 const yp=l.places.find(p=>p.kind==='yard');if(yp&&(st?.tasks??[]).some(t=>t.handling===yp.id&&(st.trucks??[]).some(k=>k.id===t.to||k.id===t.from)))return yardBox(yp);
 return null;}
// Fit all: the yard and every site, grown to keep any truck on the road in view.
function fitBox(){const b={...fitAllBox(built.layout)};for(const tr of trips.values())if(tr.driving&&tr.at){b.x0=Math.min(b.x0,tr.at.x-9000);b.y0=Math.min(b.y0,tr.at.y-9000);b.x1=Math.max(b.x1,tr.at.x+9000);b.y1=Math.max(b.y1,tr.at.y+9000);}return b;}
// The director and the follow camera hold still while the shot still works (everything wanted is in view, the zoom not far off) and only then
// glide to a new framing: the picture stays put most of the time, which is what keeps a drive smooth, and the moves read as deliberate cuts.
let camGoal=null;
function shotFits(b,follow){if(!W?.mat)return false;const q=boxProj(b),C=proj({x:cam.cx,y:cam.cy}),toV=(x,y)=>({x:cam.s*(x-C.x)+W.w/2,y:cam.s*(y-C.y)+W.h/2}),a=toV(q.x0,q.y0),z=toV(q.x1,q.y1),mx=W.w*.06,my=W.h*.06,ideal=fitScale(b);return a.x>=mx-1&&a.y>=my-1&&z.x<=W.w-mx+1&&z.y<=W.h-my+1&&cam.s>=ideal*.72&&(follow||cam.s<=ideal*1.02);}
function stepCam(now,dt){if(!cam||!W)return false;if(!camGoal&&camPlan?.kind==='goal')cancelPlan();if(mode==='free'&&!followId){if(camPlan?.kind==='goal')cancelPlan();camGoal=null;return false;}if(mode==='director'&&!followId&&now<holdUntil)return false;
 const b=mode==='fit'&&!followId?fitBox():directorBox(now);if(!b)return false;
 if(followId){const tr=trips.get(followId);W.lead=tr?.at&&tr.driving?{x:tr.at.hx,y:tr.at.hy}:null;}
 if(!camGoal){if(shotFits(b,!!followId))return false;let t=boxCam(b);if(followId&&mode==='follow'){const tr=trips.get(followId);if(tr?.at&&tr.driving){const lead=boxAround({x:tr.at.x+tr.at.hx*14000,y:tr.at.y+tr.at.hy*14000},30000);t={...boxCam(lead),s:t.s};}t.s=Math.max(t.s,Math.min(cam.s,sMax()));}prepareGlide(t);camGoal=t;W.glide=true;}
 return runPlan('goal',now);}
function userCam(){cancelPlan();lastUser=performance.now();camGoal=null;camTarget=null;if(W)W.glide=false;if(followId){followId=null;mode='free';if(cardFor)renderCard();syncBar();}else if(mode!=='free'){mode='free';syncBar();}}
function zoomAt(sx,sy,f){const before=toWorld(sx,sy);cam.s=clamp(cam.s*f,sMin(),sMax());applyCam();const after=toWorld(sx,sy);cam.cx+=before.x-after.x;cam.cy+=before.y-after.y;applyCam();saveCamSoon();}
let camSaveT=0;const saveCamSoon=()=>{clearTimeout(camSaveT);camSaveT=setTimeout(saveCam,400);};

// ---- tags in screen space: place names, trucks on the road
function syncTags(l,ctx){const st=ctx.state,out=[],places=[],items=itemsOf(st),busy=new Set();for(const t of (st.trucks??[]).filter(t=>!t.retired)){if(t.status==='IN_TRANSIT'){busy.add(t.destination);busy.add(t.at);}else if(t.status==='AT_SITE')busy.add(t.at);}
 for(const p of l.places){const stock=items.filter(c=>c.location===p.id),pieces=stock.reduce((n,c)=>n+pcsOf(c),0),e=p.ext,yard=p.kind==='yard';
  const sub=yard?null:(stock.length?stock.length+' stillage'+(stock.length===1?'':'s')+' · '+num(pieces)+' pcs':'No stock yet');
  const bld=yard?null:buildingOf(p,l),name=p.name||(yard?'Yard':'Site');
  places.push({id:'p:'+p.id,world:bld?{x:bld.x+bld.w/2,y:p.fs>0?bld.y+bld.d:bld.y}:{x:(e.x0+e.x1)/2,y:e.y0-(yard?1200:2600)},z:bld?G+bld.H+2600:yard?2600:4000,text:short(name)+(p.archived?' (archived)':''),full:name,sub,empty:!yard&&!stock.length,kind:yard?'yard':'site',site:yard?null:p.id,prio:yard?0:busy.has(p.id)?1:2});
  if(!yard){const by=new Map(stock.map(c=>[c.id,c])),onTop=new Set(stock.map(c=>c.support).filter(Boolean));for(const c of stock){if(onTop.has(c.id))continue;let z=c.height||1000,cur=by.get(c.support),k=0;while(cur&&k++<9){z+=cur.height||1000;cur=by.get(cur.support);}const rw=c.rotation===90?c.envelopeWidth:c.envelopeLength,rh=c.rotation===90?c.envelopeLength:c.envelopeWidth;const z0=placeRect(p,c.x,c.y,rw,rh);out.push({id:'s:'+c.id,world:{x:z0.x+rw/2,y:z0.y+rh/2},z:z+150,text:c.name+(k?' · '+(k+1)+' high':''),sub:null,kind:'stock',ring:c.condition==='SERVICEABLE'?(c.type==='CAGE'?STATUS_COLOURS.cage:STATUS_COLOURS.stillage):STATUS_COLOURS.damaged});}}}
 // stock pills first (under the rest), then the places, the most wanted last (drawn on top, and placed first)
 places.sort((a,b)=>b.prio-a.prio);out.push(...places);
 W.tagData=out;let html='';for(const t of out){if(t.kind==='stock'){const fs=10.5,h=17,w=textW(t.text,fs)+13;t.w=w;t.h=h+3;html+='<g class="wm-tag wm-tag-stock" data-tag="'+esc(t.id)+'"><rect x="'+R(-w/2)+'" y="'+(-h-3)+'" width="'+R(w)+'" height="'+h+'" rx="8.5" fill="#1c3a2d" stroke="'+t.ring+'" stroke-width="1.5"/><text x="0" y="'+R(-h/2-3+fs*.36)+'" text-anchor="middle" font-size="'+fs+'" fill="#fff">'+esc(t.text)+'</text></g>';continue;}
  const fs=13,h=fs*1.62,w=textW(t.text,fs)+fs*1.2,sfs=11,sh=sfs*1.6,sw=t.sub?textW(t.sub,sfs)+sfs*1.1:0,gap=t.sub?sh+2:0;t.w=Math.max(w,sw);t.mw=w;t.h=h+gap+8;t.mt=-h-gap-8;t.gap=gap;
  html+='<g class="wm-tag wm-tag-'+t.kind+'" data-tag="'+esc(t.id)+'"><title>'+esc(t.full)+'</title><path class="wm-lead" d="" stroke="'+(t.kind==='yard'?'#1c3a2d':'#6b3f16')+'" stroke-width="1.6"/><g class="wm-tag-main"><rect x="'+R(-w/2)+'" y="'+R(t.mt)+'" width="'+R(w)+'" height="'+R(h)+'" rx="'+R(h/2)+'" fill="'+(t.kind==='yard'?'#1c3a2d':'#6b3f16')+'" stroke="'+(t.kind==='yard'?'#98cc2e':'#f0a81c')+'" stroke-width="1.6"/><text x="0" y="'+R(t.mt+h/2+fs*.36)+'" text-anchor="middle" font-size="'+fs+'" fill="#fff">'+esc(t.text)+'</text></g>'+(t.sub?'<g class="wm-tag-sub'+(t.empty?' wm-empty-sub':'')+'"><rect x="'+R(-sw/2)+'" y="'+R(-sh-8)+'" width="'+R(sw)+'" height="'+R(sh)+'" rx="'+R(sh/2)+'" fill="#fbfcf7" stroke="#1c3a2d" stroke-opacity=".35"/><text x="0" y="'+R(-sh/2-8+sfs*.36)+'" text-anchor="middle" font-size="'+sfs+'" fill="#24402f">'+esc(t.sub)+'</text></g>':'')+'<path d="M-5 -8L0 -1L5 -8Z" fill="'+(t.kind==='yard'?'#1c3a2d':'#6b3f16')+'"/></g>';}
 if(html!==W.tagHTML){W.tagHTML=html;W.tags.innerHTML=html;W.tagEls=[...W.tags.children];for(const n of W.tagEls){n.__sub=n.querySelector('.wm-tag-sub');n.__main=n.querySelector('.wm-tag-main');n.__lead=n.querySelector('.wm-lead');}}placeTags();}
// A place's name tag stays inside the view while its place is (at least partly) in view: slid in from the edge, never cut off.
// ---- camera glides played by the compositor. Moving the picture from script every frame makes the browser re-layer the whole page each
// frame; a glide is worked out in full when it starts (the same easing, 16 ms steps) and handed to the browser as one Web Animation of the picture
// (and of the tag layer when it only pans; tags fade out while the zoom changes). The camera value in script follows the plan, so input, the
// director and the overview map always know where the camera is. A stretch ends early where the picture would no longer cover the view or would be
// blown up more than about twice: the picture is drawn again there and the next stretch planned (a long glide never looks blurred).
const PLAN_DT=16;let camPlan=null;
function makePlan(kind,goal,now){const cams=[{...cam}],tau=kind==='goal'?420:220,k=1-Math.exp(-PLAN_DT/tau),lt=Math.log(goal.s);let c={...cam},done=false;
 for(let i=0;i<400;i++){const ls=Math.log(c.s);let n={cx:c.cx+(goal.cx-c.cx)*k,cy:c.cy+(goal.cy-c.cy)*k,s:Math.exp(ls+(lt-ls)*k)};
  // a director or follow move is never faster than about 1.6 px per ms on screen: it reads as a camera move, never as a cut
  if(kind==='goal'){const a=proj({x:c.cx,y:c.cy}),b=proj({x:n.cx,y:n.cy}),d=Math.hypot(b.x-a.x,b.y-a.y)*n.s,cap=Math.max(20,PLAN_DT*1.6);if(d>cap){const f=cap/d;n={...n,cx:c.cx+(n.cx-c.cx)*f,cy:c.cy+(n.cy-c.cy)*f};}}
  const last=i===399||(Math.hypot(goal.cx-n.cx,goal.cy-n.cy)*n.s<(kind==='goal'?.6:.5)&&Math.abs(lt-Math.log(n.s))<(kind==='goal'?.004:.002));if(last)n={...goal};
  const q=slideOf(n);if(i>0&&(!q.ok||q.k>=10||(q.k>2.2&&glideSu(goal,n).su>camC.s*1.3)))break;
  cams.push(n);c=n;if(last){done=true;break;}}
 const plan={kind,cams,done,t0:now};if(cams.length<2)return plan;
 const kf=cams.map((v,i)=>{const q=slideOf(v);return {transform:slideCSS(q),offset:i/(cams.length-1)};}),dur=(cams.length-1)*PLAN_DT,opt={duration:dur,fill:'forwards',easing:'linear'};
 try{plan.anim=W.slide.animate(kf,opt);}catch{plan.anim=null;}
 // the tag layer moves with the picture (placed for the glide's first camera, then slid and scaled like it) while the zoom changes by less than a
 // quarter; a bigger zoom fades the tags out and places them again at the end
 const s0=cams[0].s,small=cams.every(v=>Math.abs(Math.log(v.s/s0))<Math.log(1.25));
 if(small){cam={...cams[0]};placeTags();const tc=W.tagCam,a=proj({x:tc.cx,y:tc.cy});try{plan.tagAnim=W.tagSvg.animate(cams.map((v,i)=>{const b=proj({x:v.cx,y:v.cy});return {transform:'translate('+(v.s*(a.x-b.x)).toFixed(1)+'px,'+(v.s*(a.y-b.y)).toFixed(1)+'px) scale('+(v.s/tc.s).toFixed(5)+')',offset:i/(cams.length-1)};}),opt);}catch{plan.tagAnim=null;}}
 else W.view.classList.add('wm-zooming');
 return plan;}
// Play the glide: the camera value follows the plan; at the end of a stretch the picture takes its place (and a new stretch is planned if the goal
// is not reached yet).
function runPlan(kind,now){const goal=kind==='goal'?camGoal:camTarget;if(!goal){if(camPlan?.kind===kind)cancelPlan();return false;}
 if(camPlan&&camPlan.kind!==kind)cancelPlan();if(!camPlan){camPlan=makePlan(kind,goal,now);W.glide=true;}
 const p=camPlan,i=Math.min(p.cams.length-1,Math.max(0,Math.floor((now-p.t0)/PLAN_DT)));cam={...p.cams[i]};
 // while it plays, no frame loop runs for the camera (the page stays idle; the compositor moves the picture): one timer wakes it at the end
 if(i<p.cams.length-1){if(!p.timer)p.timer=setTimeout(()=>{p.timer=0;kick();},Math.max(0,p.t0+(p.cams.length-1)*PLAN_DT-performance.now())+4);return false;}
 endPlan();
 if(p.done){if(kind==='goal')camGoal=null;else{camTarget=null;saveCam();}W.glide=!!(camGoal||camTarget);applyCam();return false;}
 prepareGlide(goal,true);return true;}
// The plan stops (played to the end, or cut short by the owner): the picture is left exactly where the camera is.
function endPlan(){const p=camPlan;if(!p)return;camPlan=null;clearTimeout(p.timer);const q=camC?slideOf(cam):null;if(q){setSlide(slideCSS(q),q.k);W.sliding=true;slideT=performance.now();}p.anim?.cancel();p.tagAnim?.cancel();W.view.classList.remove('wm-zooming');zoomLabel();drawMiniView();placeTags();}
const planCam=()=>{const p=camPlan;return p?{...p.cams[Math.min(p.cams.length-1,Math.max(0,Math.floor((performance.now()-p.t0)/PLAN_DT)))]}:cam;};
function cancelPlan(){const p=camPlan;if(!p)return;const i=Math.min(p.cams.length-1,Math.max(0,Math.floor((performance.now()-p.t0)/PLAN_DT)));cam={...p.cams[i]};endPlan();}
// A camera that only pans (same zoom as when the tags were placed) moves the whole tag layer in one piece (the compositor's work); any zoom places
// every tag again.
function panTags(){const c=W.tagCam;if(c&&Math.abs(cam.s/c.s-1)<.002){const a=proj({x:c.cx,y:c.cy}),b=proj({x:cam.cx,y:cam.cy}),t='translate('+(cam.s*(a.x-b.x)).toFixed(1)+'px,'+(cam.s*(a.y-b.y)).toFixed(1)+'px)';if(W.tagT!==t){W.tagT=t;W.tagSvg.style.transform=t;}return;}placeTags();}
// The camera as it is now (not the committed picture): screen = s * (L p - C) + centre of the tag svg.
function liveMat(){const VW=W.w*OVER,VH=W.h*OVER,C=proj({x:cam.cx,y:cam.cy}),s=cam.s;return {a:s*L[0],b:s*L[1],c:s*L[2],d:s*L[3],e:VW/2-s*C.x,f:VH/2-s*C.y};}
// Every tag for the live camera. A place's tag stays inside the view while its place is (at least partly) in view. Place tags never overlap: the
// most wanted first (the yard, then the sites a truck is on its way to, from or parked at), a tag that would overlap drops its stock line, and
// if it still overlaps it waits hidden until there is room. Far out, "No stock yet" lines step back.
function placeTags(){if(!W?.mat||!cam||!W.tagEls)return;W.tagCam={...cam};if(W.tagT){W.tagT='';W.tagSvg.style.transform='';}const m=liveMat(),vx0=(W.w*OVER-W.w)/2,vy0=(W.h*OVER-W.h)/2,vx1=vx0+W.w,vy1=vy0+W.h,data=W.tagData??[],boxes=[],noSub=phone(),hit=r=>boxes.some(b=>r[0]<b[2]+3&&r[2]>b[0]-3&&r[1]<b[3]+2&&r[3]>b[1]-2);
 for(let i=data.length-1;i>=0;i--){const t=data[i],n=W.tagEls[i];if(!n)continue;const p=at(t.world,t.z);let x=m.a*p.x+m.c*p.y+m.e,y=m.b*p.x+m.d*p.y+m.f,vis=true,sub=!!t.sub;
  if(t.kind!=='stock'&&t.w){const hw=t.w/2+5;if(x>vx0-hw*2&&x<vx1+hw*2&&y>vy0-40&&y<vy1+t.h+60){x=clamp(x,vx0+hw,Math.max(vx0+hw,vx1-hw));y=clamp(y,vy0+t.h+4,Math.max(vy0+t.h+4,vy1-4));}
   // without its stock line the name drops down onto the pointer; a name that still overlaps is lifted up to three rows on a leader line
   sub=sub&&!noSub&&!(W.far&&t.empty);const full=d=>[x-t.w/2,y+t.mt+d,x+t.w/2,y+d],bare=d=>[x-t.mw/2,y+t.mt+t.gap+d,x+t.mw/2,y+d];let r=sub?full(0):bare(0),dy=0,dx=0;
   if(sub&&hit(r)){sub=false;r=bare(0);}if(hit(r)){const row=-(t.h-t.gap+3),sx=t.mw/2+6;search:for(let k=0;k<=3;k++)for(const ox of [0,-sx,sx]){if(!k&&!ox)continue;const q=bare(row*k);q[0]+=ox;q[2]+=ox;if(!hit(q)&&q[1]>=vy0&&q[0]>=vx0&&q[2]<=vx1){dy=row*k;dx=ox;r=q;break search;}}if(hit(r)){vis=false;dy=0;dx=0;}}
   if(vis&&x>vx0-t.w&&x<vx1+t.w&&y>vy0-t.h&&y<vy1+t.h)boxes.push(r);t.box=r;t.vis=vis;
   if(n.__sub){const d=sub?'inline':'none';if(n.__subD!==d){n.__subD=d;n.__sub.setAttribute('display',d);n.__main?.setAttribute('transform',sub?'':'translate(0 '+R(t.gap)+')');}}
   const ld=dy||dx?'M0 -1L'+R(-dx)+' '+R(-dy):'';if(n.__ld!==ld){n.__ld=ld;n.__lead?.setAttribute('d',ld);}y+=dy;x+=dx;}
  const v=vis?'visible':'hidden';if(n.__vis!==v){n.__vis=v;n.setAttribute('visibility',v);}
  const tf='translate('+R(x)+' '+R(y)+')';if(n.__tf!==tf){n.__tf=tf;n.setAttribute('transform',tf);}}
}

// ---- overview minimap: the district from above at a tiny scale, trucks as dots, the view as a box
function buildMini(l){const m=W.mini,{c0,c1,r0,r1}=l.range,b={x0:(c0)*l.pw-S,y0:(r0)*l.ph-S,x1:(c1+1)*l.pw,y1:(r1+1)*l.ph},cs=[{x:b.x0,y:b.y0},{x:b.x1,y:b.y0},{x:b.x1,y:b.y1},{x:b.x0,y:b.y1}].map(proj),xs=cs.map(p=>p.x),ys=cs.map(p=>p.y),vb=[Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)];
 W.miniVB=vb;m.setAttribute('viewBox',vb.map(R).join(' '));const mat='matrix('+[L[0],L[1],L[2],L[3],0,0].join(' ')+')';let s='<rect x="'+R(vb[0])+'" y="'+R(vb[1])+'" width="'+R(vb[2])+'" height="'+R(vb[3])+'" fill="#e9eddc"/><g transform="'+mat+'">';
 for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)s+='<rect x="'+c*l.pw+'" y="'+r*l.ph+'" width="'+l.bw+'" height="'+l.bh+'" fill="#b9c79a"/>';
 for(const p of l.places)s+='<rect class="wm-mini-'+p.kind+'" data-mini="'+esc(p.id)+'" x="'+p.ext.x0+'" y="'+p.ext.y0+'" width="'+(p.ext.x1-p.ext.x0)+'" height="'+(p.ext.y1-p.ext.y0)+'" fill="'+(p.kind==='yard'?'#d8d1c1':'#c8a574')+'" stroke="'+(p.kind==='yard'?'#2f7353':'#8a5a1c')+'" stroke-width="2500"/>';
 m.innerHTML=s+'</g><g class="wm-mini-dots"></g><rect class="wm-mini-view" fill="none" stroke="#1c3a2d" stroke-width="'+R(vb[2]/90)+'"/>';W.miniDots=m.querySelector('.wm-mini-dots');W.miniView=m.querySelector('.wm-mini-view');drawMiniView();}
function drawMiniView(){if(!W?.miniView||!cam)return;const C=proj({x:cam.cx,y:cam.cy}),w=W.w/cam.s,h=W.h/cam.s;W.miniView.setAttribute('x',R(C.x-w/2));W.miniView.setAttribute('y',R(C.y-h/2));W.miniView.setAttribute('width',R(w));W.miniView.setAttribute('height',R(h));}
function drawMiniDots(){if(!W?.miniDots||!W.miniVB)return;const r=W.miniVB[2]/70,seen=new Set();W.miniDotEls??=new Map();for(const tr of trips.values()){if(!tr.at||!tr.truck)continue;const id=tr.truck.id;seen.add(id);let c=W.miniDotEls.get(id);if(!c||!c.isConnected){c=el('circle',{r:R(r),stroke:'#fff','stroke-width':R(r/3)});W.miniDots.append(c);W.miniDotEls.set(id,c);}const q=proj(tr.at),x=String(R(q.x)),y=String(R(q.y)),f=tr.driving?'#f0a81c':'#2f7353';if(c.__x!==x){c.__x=x;c.setAttribute('cx',x);}if(c.__y!==y){c.__y=y;c.setAttribute('cy',y);}if(c.__f!==f){c.__f=f;c.setAttribute('fill',f);}}for(const [id,c] of W.miniDotEls)if(!seen.has(id)){c.remove();W.miniDotEls.delete(id);}}

// ---- the trip strip: every truck in words, with its progress on the road
// The scheduled collection (src/domain/collections.js) a truck is working on: loading it at the site, bringing it back, or booked and parked there.
const RT_LIVE=['BOOKED','LOADING','ON THE WAY'];
function rtOf(st,t){const l=(st?.collections??[]).filter(c=>RT_LIVE.includes(c.status));return l.find(c=>c.truck===t.id&&c.status!=='BOOKED')??l.find(c=>c.status==='BOOKED'&&c.plannedTruck===t.id&&t.status==='AT_SITE'&&t.at===c.site)??null;}
const kindAt=id=>built.layout?.byId.get(id)?.kind??null;
// What the site's crew can do: a crane and enough crane workers (config.craneWorkers) lift stillages off a truck or onto it; without them the
// unload or collection tasks stop BLOCKED ("No crane is available.").
function siteKit(st,id){const crew=(st?.resources??[]).filter(r=>r.location===id),need=Math.max(1,st?.config?.craneWorkers??1),cranes=crew.filter(r=>r.type==='CRANE').length,workers=crew.filter(r=>r.type==='WORKER').length;return {cranes,workers,need,ok:cranes>0&&workers>=need};}
const kitWords=(k,name)=>(!k.cranes?'There is no crane at '+name:'There '+(k.workers===1?'is ':'are ')+k.workers+' of the '+k.need+' crane worker'+(k.need===1?'':'s')+' needed at '+name)+'. Set up a crane and a crew on the Yard page (Configure workers & equipment).';
// Where a loaded truck at the yard is meant to go: the site its reserved request or yard list is for, else where it is set to go, else the site
// it last went to. null when nothing says (the page then asks, never picks a site on its own).
function sendTo(st,t){const act=new Set((st?.sites??[]).filter(s=>s.status==='ACTIVE').map(s=>s.id)),ok=id=>id&&act.has(id)&&id!==t.at?id:null;
 for(const r of st?.requests??[])if(r.truck===t.id&&['ALLOCATED','PARTIALLY ALLOCATED'].includes(r.status)&&ok(r.site))return r.site;
 for(const l of st?.loadLists??[])if(l.truck===t.id&&!l.cancelled&&!l.delivery&&ok(l.site))return l.site;
 if(ok(t.destination))return t.destination;
 const d=[...(st?.deliveries??[])].reverse().find(d=>d.truck===t.id&&ok(d.to));return d?d.to:null;}
const openTasks=(st,t)=>(st?.tasks??[]).filter(k=>(k.from===t.id||k.to===t.id)&&!['COMPLETE','CANCELLED'].includes(k.state));
function truckLine(tr,st){const t=tr.truck,cargo=tr.cargo??[],pieces=cargo.reduce((n,c)=>n+pcsOf(c),0),load=cargo.length?cargo.length+' stillage'+(cargo.length===1?'':'s')+' · '+num(pieces)+' pcs':'Empty',rt=rtOf(st,t);
 if(t.status==='IN_TRANSIT'){const paused=!!st?.config?.paused;return {state:'road',paused,title:t.name+' → '+placeName(t.destination),sub:load,status:(paused?'Paused on the road. ':'')+(cargo.length?(kindAt(t.destination)==='yard'?(rt?'Bringing the collection from '+placeName(rt.site)+' back to ':'Bringing it back to '):'Delivering to '):'Driving empty to ')+placeName(t.destination)};}
 const here=placeName(t.at),atSite=t.status==='AT_SITE',tasks=st?.tasks??[],from=tasks.filter(x=>x.from===t.id),to=tasks.filter(x=>x.to===t.id),stuck=[...from,...to].find(x=>x.state==='BLOCKED');
 if(stuck){const what=from.some(x=>x.state==='BLOCKED')?'Unloading':'Loading',why=stuck.reason??'the crane or crew is missing';return {state:'stuck',title:t.name+' · stuck at '+here,sub:why,status:what+' is stuck at '+here+': '+why};}
 if(from.length){const air=from.filter(x=>x.picked).length,words=(air?air+' in the air · ':'')+cargo.length+' on the truck';return {state:'busy',title:t.name+' · unloading at '+here,sub:words,status:'Unloading at '+here+' · '+words};}
 if(to.length)return {state:'busy',title:t.name+' · '+(atSite&&rt?'loading the collection at ':'loading at ')+here,sub:to.length+' to go · '+load,status:(atSite&&rt?'The site crane is loading the collection at ':'Loading at ')+here+' · '+to.length+' to go'};
 if(atSite&&rt?.status==='LOADING'&&cargo.length)return {state:'wait',title:t.name+' · collection loaded at '+here,sub:load,status:'Collection loaded at '+here+', ready to go back to the yard'};
 if(!atSite&&rt?.status==='ON THE WAY'&&cargo.length)return {state:'wait',title:t.name+' · back at '+here,sub:load,status:'Back from '+placeName(rt.site)+' with the collection, waiting to unload'};
 if(cargo.length)return {state:'wait',title:t.name+' · loaded at '+here,sub:load,status:atSite?'Loaded, waiting to unload at '+here:'Loaded, parked at '+here};
 if(atSite&&rt?.status==='BOOKED')return {state:'idle',title:t.name+' · at '+here,sub:'Collection booked',status:'Waiting to load the collection at '+here};
 return {state:'idle',title:t.name+' · at '+here,sub:load,status:'Empty, parked at '+here};}
function renderStrip(ctx){if(!W)return;const st=ctx.state,list=(st.trucks??[]).filter(t=>!t.retired);let html='';
 for(const t of list){const tr=trips.get(t.id)??{truck:t,cargo:itemsOf(st).filter(c=>c.location===t.id)},x=truckLine({...tr,truck:t},st);html+='<button type="button" class="wm-chip '+x.state+(followId===t.id?' on':'')+'" data-wm-follow="'+esc(t.id)+'" role="listitem"><span class="wm-chip-t">'+esc(x.title)+'</span><span class="wm-chip-s">'+esc(x.sub)+(x.state==='road'?' · <b data-eta="'+esc(t.id)+'"></b>':'')+'</span>'+(x.state==='road'?'<i class="wm-bar-p"><b data-prog="'+esc(t.id)+'"></b></i>':'')+'</button>';}
 if(!list.length)html='<p class="wm-empty">No trucks yet. Add one in Fleet.</p>';if(html!==W.stripHTML){W.stripHTML=html;W.strip.innerHTML=html;W.stripEls=new Map([...W.strip.querySelectorAll('[data-prog]')].map(b=>[b.dataset.prog,{b,e:W.strip.querySelector('[data-eta="'+CSS.escape(b.dataset.prog)+'"]')}]));}tickStrip();}
// The arrival words, from the truck's own clock: paused with the simulation, else the seconds to go.
const etaWords=tr=>{if(tr.paused)return 'paused on the road';const left=Math.max(0,Math.ceil((1-(tr.u??0))*tr.D/1000));return left?'arrives in '+left+' s':'arriving now';};
function tickStrip(){if(!W?.stripEls)return;for(const tr of trips.values()){if(!tr.driving||!tr.truck)continue;const x=W.stripEls.get(tr.truck.id);if(!x)continue;const u=tr.u??0,w=(u*100).toFixed(1)+'%';if(x.b.__w!==w){x.b.__w=w;x.b.style.width=w;}if(x.e){const t=etaWords(tr);if(x.e.textContent!==t)x.e.textContent=t;}}}

// ---- cards: follow a truck, or a site
const siteOpts=(sites,sel,ph)=>(ph?'<option value="">'+esc(ph)+'</option>':'')+sites.map(s=>'<option value="'+esc(s.id)+'"'+(s.id===sel?' selected':'')+'>'+esc(s.name)+'</option>').join('');
function truckCard(st,t,ops){const tr=trips.get(t.id)??{truck:t,cargo:itemsOf(st).filter(c=>c.location===t.id)},x=truckLine({...tr,truck:t},st),cargo=tr.cargo??[],names=new Map((st.products??[]).map(p=>[p.id,p.name]));
 const lines=new Map();for(const c of cargo)for(const [id,q] of c.lines??[])lines.set(id,(lines.get(id)??0)+q);const top=[...lines].sort((a,b)=>b[1]-a[1]).slice(0,4),pieces=cargo.reduce((n,c)=>n+pcsOf(c),0);
 const at=l=>placeName(l),open=openTasks(st,t),busy=open.length>0,blocked=open.filter(k=>k.state==='BLOCKED'),sites=(st.sites??[]).filter(s=>s.status==='ACTIVE'&&s.id!==t.at),place=built.layout?.byId.get(t.at),archived=!!place?.archived;
 const rt=rtOf(st,t),collecting=t.status==='AT_SITE'&&rt?.status==='LOADING',kit=t.status==='AT_SITE'?siteKit(st,t.at):null;let acts='',warn='';
 if(blocked.length){const unl=blocked.some(k=>k.from===t.id);warn='<p class="wm-warn">'+(unl?'Unloading':'Loading')+' is stuck: '+esc(blocked[0].reason??'the crane or crew is missing')+'</p>';
  if(ops)acts+='<button type="button" data-wm-act="retry" data-id="'+esc(t.id)+'">Try again</button><button type="button" class="secondary" data-wm-act="stop" data-id="'+esc(t.id)+'">Cancel the '+(unl?'unload':'loading')+'</button>'+(t.status==='AT_SITE'&&kit&&!kit.ok?'<button type="button" class="secondary" data-wm-go="yard">Set up the crane</button>':'');}
 if(ops&&!busy){
  if(t.status==='AT_SITE'){
   if(rt?.canLoad){if(kit.ok)acts+='<button type="button" data-wm-act="collect" data-id="'+esc(t.id)+'" data-rt="'+esc(rt.id)+'">Load the collection onto '+esc(t.name)+'</button>';}
   if(cargo.length&&!collecting&&!archived){if(kit.ok)acts+='<button type="button" data-wm-act="unload" data-id="'+esc(t.id)+'">Unload at '+esc(at(t.at))+'</button>';}
   if(kit&&!kit.ok&&((cargo.length&&!collecting&&!archived)||rt?.canLoad)){warn+='<p class="wm-warn">'+esc(kitWords(kit,at(t.at)))+'</p>';acts+='<button type="button" disabled>'+(cargo.length&&!collecting?'Unload at '+esc(at(t.at)):'Load the collection')+'</button><button type="button" class="secondary" data-wm-go="yard">Set up the crane</button>';}
   if(archived)warn+='<p class="wm-warn">'+esc(at(t.at))+' is archived. Send the truck back to the yard.</p>';
   acts+='<button type="button" class="'+(collecting&&cargo.length||archived||(kit&&!kit.ok)?'':'secondary')+'" data-wm-act="home" data-id="'+esc(t.id)+'">'+(collecting&&cargo.length?'Bring the collection back to the yard':'Send back to yard')+'</button>';}
  else if(t.status==='AT_YARD'){const want=cargo.length?sendTo(st,t):null;
   if(want)acts+='<button type="button" data-wm-act="send" data-id="'+esc(t.id)+'" data-dest="'+esc(want)+'">Send to '+esc(at(want))+'</button>';
   if(sites.length)acts+='<span class="wm-send"><select data-wm-dest="'+esc(t.id)+'" aria-label="Destination for '+esc(t.name)+'">'+siteOpts(want?sites.filter(s=>s.id!==want):sites,null,want?'or another site…':'Choose a site…')+'</select><button type="button" class="'+(want?'secondary':'')+'" data-wm-act="send" data-id="'+esc(t.id)+'">Send</button></span>';
   if(cargo.length)acts+='<button type="button" class="wm-link" data-wm-act="unload" data-id="'+esc(t.id)+'">Unload here instead</button>';}}
 return '<div class="wm-card-head"><span class="wm-card-kicker">'+(t.status==='IN_TRANSIT'?'ON THE ROAD':t.status==='AT_SITE'?'AT SITE':'AT THE YARD')+'</span><span class="wm-card-tools"><button type="button" class="wm-more-btn" data-wm="card-more" aria-expanded="'+!!W.cardMore+'">'+(W.cardMore?'Less':'Details')+'</button><button type="button" class="wm-x" data-wm="close" aria-label="Close">&times;</button></span></div><h3>'+esc(t.name)+'</h3>'
  +(t.status==='IN_TRANSIT'?'<p class="wm-route"><span>'+esc(at(t.at))+'</span><i aria-hidden="true">→</i><span>'+esc(at(t.destination))+'</span></p><i class="wm-bar-p big"><b data-prog="'+esc(t.id)+'"></b></i><p class="wm-eta" data-eta-card="'+esc(t.id)+'"></p>':'<p class="wm-route"><span>'+esc(x.status)+'</span></p>')
  +'<p class="wm-load"><b>'+(cargo.length?cargo.length+' stillage'+(cargo.length===1?'':'s'):'No load')+'</b>'+(cargo.length?' &middot; '+num(pieces)+' pieces':'')+'</p>'
  +(cargo.length?'<ul class="wm-lines wm-stillages wm-more">'+cargo.slice(0,8).map(c=>'<li><span>'+esc(c.name)+'</span><b>'+num(pcsOf(c))+' pcs</b></li>').join('')+(cargo.length>8?'<li><span>and '+(cargo.length-8)+' more</span><b></b></li>':'')+'</ul>':'')
  +(top.length?'<ul class="wm-lines wm-products wm-more">'+top.map(([id,q])=>'<li><span>'+esc(names.get(id)??'Material')+'</span><b>'+num(q)+'</b></li>').join('')+'</ul>':'')
  +warn+(acts?'<div class="wm-acts">'+acts+'</div>':'')+'<div class="wm-acts wm-more"><button type="button" class="secondary" data-wm="follow" aria-pressed="'+(followId===t.id)+'">'+(followId===t.id?'Stop following':'Follow')+'</button><button type="button" class="secondary" data-wm-go="truck" data-id="'+esc(t.id)+'">Truck page</button></div>';}
function siteCard(st,p,s){const ops=isOps(ctxNow?.account),stock=itemsOf(st).filter(c=>c.location===s.id),names=new Map((st.products??[]).map(q=>[q.id,q.name])),lines=new Map();for(const c of stock)for(const [id,q] of c.lines??[])lines.set(id,(lines.get(id)??0)+q);const top=[...lines].sort((a,b)=>b[1]-a[1]).slice(0,5);
 const kit=siteKit(st,s.id),here=(st.trucks??[]).filter(t=>t.at===s.id&&t.status==='AT_SITE'),coming=(st.trucks??[]).filter(t=>t.status==='IN_TRANSIT'&&t.destination===s.id),blocked=(st.tasks??[]).find(t=>t.handling===s.id&&t.state==='BLOCKED'),rt=(st.collections??[]).find(c=>c.site===s.id&&RT_LIVE.concat('REQUESTED').includes(c.status)),rtT=rt?.runTruck?(st.trucks??[]).find(t=>t.id===rt.runTruck):null,loadedRt=t=>rt?.status==='LOADING'&&rt.truck===t.id,craneBusy=(st.tasks??[]).some(t=>t.handling===s.id),archived=!!p.archived;
 const toUnload=here.filter(t=>!loadedRt(t)&&itemsOf(st).some(c=>c.location===t.id));
 return '<div class="wm-card-head"><span class="wm-card-kicker">'+(archived?'ARCHIVED SITE':'SITE')+'</span><span class="wm-card-tools"><button type="button" class="wm-more-btn" data-wm="card-more" aria-expanded="'+!!W.cardMore+'">'+(W.cardMore?'Less':'Details')+'</button><button type="button" class="wm-x" data-wm="close" aria-label="Close">&times;</button></span></div><h3>'+esc(s.name)+'</h3><p class="wm-addr wm-more">'+esc(s.address??'')+(s.client?' &middot; '+esc(s.client):'')+'</p>'
  +'<p class="wm-load"><b>'+(stock.length?stock.length+' stillage'+(stock.length===1?'':'s')+' on site':'Nothing on site yet')+'</b>'+(stock.length?' &middot; '+num(stock.reduce((n,c)=>n+pcsOf(c),0))+' pieces':'')+'</p>'+(top.length?'<ul class="wm-lines wm-more">'+top.map(([id,q])=>'<li><span>'+esc(names.get(id)??'Material')+'</span><b>'+num(q)+'</b></li>').join('')+'</ul>':'')
  +'<p class="wm-crewline">'+(kit.cranes?kit.cranes+' crane'+(kit.cranes===1?'':'s'):'No crane')+' &middot; '+kit.workers+' worker'+(kit.workers===1?'':'s')+(here.length?' &middot; '+here.map(t=>esc(t.name)).join(', ')+' here':'')+(coming.length?' &middot; '+coming.map(t=>esc(t.name)).join(', ')+' on the way':'')+'</p>'+(rt?'<p class="wm-crewline">Collection '+esc(rt.status.toLowerCase())+(rt.runTruckName?' &middot; '+esc(rt.runTruckName):' &middot; no truck booked')+(rt.pieces?' &middot; '+num(rt.pieces)+' pcs':'')+'</p>':'')
  +(ops&&rt?.canLoad&&rtT&&!craneBusy&&kit.ok?'<div class="wm-acts"><button type="button" data-wm-act="collect" data-id="'+esc(rtT.id)+'" data-rt="'+esc(rt.id)+'">Load the collection onto '+esc(rtT.name)+'</button></div>':'')
  +(blocked?'<p class="wm-warn">Crane work is blocked: '+esc(blocked.reason??'see Movement activity')+'</p>':!kit.ok?'<p class="wm-warn">'+esc(kitWords(kit,s.name))+'</p>':'')
  +(ops&&!kit.ok?'<div class="wm-acts"><button type="button" class="secondary" data-wm-go="yard">Set up the crane</button></div>':'')
  +(ops&&kit.ok&&!archived&&toUnload.length&&!craneBusy?'<div class="wm-acts">'+toUnload.map(t=>'<button type="button" data-wm-act="unload" data-id="'+esc(t.id)+'">Unload '+esc(t.name)+'</button>').join('')+'</div>':'')
  +(arrange&&ops&&!archived?'<div class="wm-move" aria-label="Move this site on the map"><span>Move on the map</span><button type="button" class="secondary" data-wm-move="-1,0" aria-label="Move up-left">&#8598;</button><button type="button" class="secondary" data-wm-move="0,-1" aria-label="Move up-right">&#8599;</button><button type="button" class="secondary" data-wm-move="0,1" aria-label="Move down-left">&#8601;</button><button type="button" class="secondary" data-wm-move="1,0" aria-label="Move down-right">&#8600;</button></div>':'')
  +'<div class="wm-acts"><button type="button" class="secondary" data-wm-go="site" data-id="'+esc(s.id)+'">Open on the Sites page</button></div>';}
function renderCard(){if(!W||!cardFor){if(W){W.card.hidden=true;W.stage.classList.remove('carded');}return;}const st=ctxNow?.state,ops=isOps(ctxNow?.account);let html='';
 if(cardFor.kind==='truck'){const t=(st.trucks??[]).find(x=>x.id===cardFor.id);if(!t){closeCard();return;}html=truckCard(st,t,ops);}
 else{const p=built.layout?.byId.get(cardFor.id),s=(st.sites??[]).find(x=>x.id===cardFor.id);if(!p||!s){closeCard();return;}html=siteCard(st,p,s);}
 // a choice made in the card's site list survives a redraw of the card
 if(html!==W.cardHTML){const sel=W.card.querySelector('select[data-wm-dest]'),keep=sel?.value;W.cardHTML=html;W.card.innerHTML=html;if(keep){const n=W.card.querySelector('select[data-wm-dest]');if(n&&[...n.options].some(o=>o.value===keep))n.value=keep;}}
 W.card.classList.toggle('more',!!W.cardMore);W.card.hidden=false;W.stage.classList.add('carded');tickStrip();tickCard();}
function tickCard(){if(!W||cardFor?.kind!=='truck')return;const tr=trips.get(cardFor.id);if(!tr?.driving)return;const b=W.card.querySelector('[data-prog]'),e=W.card.querySelector('[data-eta-card]'),u=tr.u??0;if(b)b.style.width=(u*100).toFixed(1)+'%';if(e){const t=R(u*100)+'% of the way · '+etaWords(tr);if(e.textContent!==t)e.textContent=t;}}
// Opening a site card frames the site: the Fit all and director cameras step aside (free), so they never pull the camera back mid-glide.
function openCard(kind,id){if(mode!=='follow')W.prevMode=mode;cardFor={kind,id};if(kind==='truck'){followId=id;mode='follow';}else{followId=null;if(mode==='follow')mode=W.prevMode??'free';const p=built.layout?.byId.get(id);if(p&&!arrange){if(mode==='director'||mode==='fit')mode='free';camGoal=null;animateTo(boxCam(siteBox(p)));}}renderCard();syncBar();kick();tick();}
function closeCard(){cardFor=null;if(followId){followId=null;if(mode==='follow')mode=W?.prevMode??'director';}if(W){W.card.hidden=true;W.cardHTML='';W.stage.classList.remove('carded');}syncBar();kick();tick();}
const barEl=()=>document.querySelector('.scene .wm-bar');
function syncBar(){if(!W)return;const bar=barEl();if(bar){const set=(sel,on)=>{const b=bar.querySelector(sel);if(b){b.setAttribute('aria-pressed',String(on));b.classList.toggle('on',on);}};set('.wm-director',mode==='director');set('.wm-fit',mode==='fit');
  bar.classList.toggle('more',barMore);bar.querySelector('.wm-morebar')?.setAttribute('aria-expanded',String(barMore));
  const a=bar.querySelector('.wm-arrange');if(a){a.setAttribute('aria-pressed',String(arrange));a.classList.toggle('on',arrange);a.textContent=arrange?'Done arranging':'Arrange map';}}
 zoomLabel();W.stage.classList.toggle('arranging',arrange);W.note.hidden=!arrange;if(arrange)W.note.textContent='Drag a site onto an empty block to move it. Trucks already on the road keep their road.';syncWatch();}
// With the director off (Fit all, or the owner's own pan and zoom) a truck on the road gets a one-click offer to watch it.
function syncWatch(){if(!W?.watch)return;const tr=!arrange&&mode!=='director'&&!followId?[...trips.values()].find(t=>t.driving&&t.truck&&(t.u??0)<1):null;const txt=tr?'Watch '+tr.truck.name+' drive to '+placeName(tr.to):'';
 if(W.watch.dataset.t!==txt){W.watch.dataset.t=txt;W.watch.hidden=!tr;if(tr)W.watch.innerHTML='<i class="wm-rec" aria-hidden="true"></i>'+esc(txt);}}
// The toolbar is part of the Home markup (wmTools): one delegated handler, re-attached after every render.
function bindBar(){const bar=barEl();if(bar&&bar.onclick!==barClick)bar.onclick=barClick;}
function barClick(e){const b=e.target.closest('button[data-wm]');if(!b||!W||!cam)return;const k=b.dataset.wm;
 if(k==='director'){followId=null;if(cardFor?.kind==='truck')closeCard();mode=mode==='director'?'free':'director';camGoal=null;holdUntil=0;syncBar();saveCam();kick();}
 else if(k==='fit'){if(cardFor?.kind==='truck')closeCard();followId=null;lastUser=performance.now();camGoal=null;mode='fit';syncBar();saveCam();animateTo(boxCam(fitBox()));}
 else if(k==='yard'){userCam();followId=null;const yp=built.layout?.places.find(p=>p.kind==='yard');if(yp)animateTo(boxCam(yardBox(yp)));}
 else if(k==='in'||k==='out'){userCam();zoomAt(W.w/2,W.h/2,k==='in'?1.3:1/1.3);}
 else if(k==='bar-more'){barMore=!barMore;syncBar();}
 else if(k==='arrange'){arrange=!arrange;if(arrange){mode='free';followId=null;if(cardFor?.kind==='truck')closeCard();}syncBar();if(cardFor?.kind==='site')renderCard();}
 else if(k.startsWith('turn:'))ctxNow?.setView?.({rotate:((VIEW.rotate+Number(k.slice(5)))%360+360)%360,tilt:VIEW.tilt});
 else if(k==='tilt')ctxNow?.setView?.({rotate:VIEW.rotate,tilt:!VIEW.tilt});}
// ---- input
function bindStage(){const svg=W.view,pts=new Map(),onMap=e=>!!e.target?.closest?.('svg.world-svg,.wm-tlayer .wm-truck');let gesture=null;
 const local=e=>{const r=W.rect??W.view.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
 // Capture phase on the map's box (both svgs): the plan's own wheel and drag handlers (Yard page view) never see these events.
 svg.addEventListener('wheel',e=>{if(!onMap(e))return;e.preventDefault();e.stopPropagation();W.rect=W.view.getBoundingClientRect();const p=local(e);userCam();zoomAt(p.x,p.y,e.deltaY<0?1.15:1/1.15);},{passive:false,capture:true});
 svg.addEventListener('pointerdown',e=>{if(!onMap(e)||(e.button!==0&&e.pointerType==='mouse'))return;const special=ctxNow&&(ctxNow.layoutDraft||ctxNow.workerMoveMode==='PLACE');if(special)return;W.rect=W.view.getBoundingClientRect();pts.set(e.pointerId,local(e));W.gesture=true;
  const siteG=arrange&&(e.target.closest?.('[data-wm-site]')||siteUnder(local(e)));if(siteG&&pts.size===1){gesture={kind:'site',id:siteG.dataset.wmSite,start:local(e),moved:false};}
  else if(pts.size===1)gesture={kind:'pan',start:local(e),cam:{...cam},moved:false,onItem:!!e.target.closest?.('[data-select],[data-worker],[data-forklift]')};
  else if(pts.size===2){const [a,b]=[...pts.values()];gesture={kind:'pinch',d:Math.hypot(a.x-b.x,a.y-b.y),mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},cam:{...cam},moved:true};}
  if(gesture&&!gesture.onItem)e.stopPropagation();},{capture:true});
 svg.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId)||!gesture)return;pts.set(e.pointerId,local(e));const p=local(e);
  if(gesture.kind==='pan'){if(!gesture.moved&&Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)<6)return;if(!gesture.moved){gesture.moved=true;userCam();try{svg.setPointerCapture(e.pointerId);}catch{}}const C0=proj({x:gesture.cam.cx,y:gesture.cam.cy}),C={x:C0.x-(p.x-gesture.start.x)/cam.s,y:C0.y-(p.y-gesture.start.y)/cam.s},inv=E.inverse;cam.cx=inv[0]*C.x+inv[2]*C.y;cam.cy=inv[1]*C.x+inv[3]*C.y;applyCam();saveCamSoon();}
  else if(gesture.kind==='pinch'&&pts.size===2){const [a,b]=[...pts.values()],d=Math.hypot(a.x-b.x,a.y-b.y),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};userCam();cam={...gesture.cam};applyCam();zoomAt(gesture.mid.x,gesture.mid.y,d/Math.max(1,gesture.d));const C0=proj({x:cam.cx,y:cam.cy}),C={x:C0.x-(mid.x-gesture.mid.x)/cam.s,y:C0.y-(mid.y-gesture.mid.y)/cam.s},inv=E.inverse;cam.cx=inv[0]*C.x+inv[2]*C.y;cam.cy=inv[1]*C.x+inv[3]*C.y;applyCam();}
  else if(gesture.kind==='site'){if(!gesture.moved&&Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)<6)return;gesture.moved=true;try{svg.setPointerCapture(e.pointerId);}catch{}const w=toWorld(p.x,p.y),lot=lotOf(built.layout,w.x,w.y);gesture.lot=lot;drawGhost(gesture.id,lot);}},{capture:true});
 const end=e=>{if(!pts.has(e.pointerId))return;pts.delete(e.pointerId);if(!pts.size){W.gesture=false;kick();}if(!gesture)return;const g=gesture;if(pts.size>0&&g.kind==='pinch')return;gesture=null;
  if(g.moved){W.suppress=performance.now();saveCamSoon();}
  if(g.kind==='site'&&g.moved){clearGhost();const p=built.layout.byId.get(g.id);if(g.lot&&(g.lot.c!==p.col||g.lot.r!==p.row))placeSite(g.id,g.lot.c,g.lot.r);}};
 svg.addEventListener('pointerup',end,{capture:true});svg.addEventListener('pointercancel',end,{capture:true});
 svg.addEventListener('click',e=>{if(!onMap(e))return;if(W.suppress&&performance.now()-W.suppress<300){e.stopPropagation();e.preventDefault();return;}if(e.target.closest('[data-select],[data-worker],[data-forklift]'))return;if(ctxNow?.workerMoveMode||ctxNow?.layoutDraft)return;
  const t=e.target.closest('[data-wm-truck]');if(t){e.stopPropagation();openCard('truck',t.dataset.wmTruck);return;}const s=e.target.closest('[data-wm-site]');if(s){e.stopPropagation();openCard('site',s.dataset.wmSite);}},{capture:true});
 svg.addEventListener('keydown',e=>{if(!onMap(e)||(e.key!=='Enter'&&e.key!==' '))return;const t=e.target.closest?.('[data-wm-truck]'),s=e.target.closest?.('[data-wm-site]');if(t){e.preventDefault();openCard('truck',t.dataset.wmTruck);}else if(s&&!e.target.closest('[data-select]')){e.preventDefault();openCard('site',s.dataset.wmSite);}});
 W.stage.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||!W.stage.contains(b)||b.closest('svg'))return;const k=b.dataset.wm;
  if(k==='watch'){followId=null;mode='director';holdUntil=0;camGoal=null;syncBar();saveCam();kick();}
  else if(k==='close')closeCard();
  else if(k==='card-more'){W.cardMore=!W.cardMore;renderCard();}
  else if(k==='follow'){if(followId){followId=null;mode='free';}else if(cardFor?.kind==='truck'){followId=cardFor.id;mode='follow';}renderCard();syncBar();kick();}
  else if(b.dataset.wmFollow){if(followId===b.dataset.wmFollow)closeCard();else openCard('truck',b.dataset.wmFollow);}
  else if(b.dataset.wmGo){ctxNow?.go?.(b.dataset.wmGo,b.dataset.id);}
  else if(b.dataset.wmMove&&cardFor?.kind==='site'){const [dc,dr]=b.dataset.wmMove.split(',').map(Number),p=built.layout.byId.get(cardFor.id);placeSite(p.id,p.col+dc,p.row+dr);}
  else if(b.dataset.wmAct){const act=b.dataset.wmAct,id=b.dataset.id,st=ctxNow.state,t=(st.trucks??[]).find(x=>x.id===id);if(!t)return;
   let dest=null;if(act==='send'){dest=b.dataset.dest||W.card.querySelector('[data-wm-dest="'+CSS.escape(id)+'"]')?.value||'';if(!dest){ctxNow.notify?.('Choose a site for '+t.name+' first.');W.card.querySelector('[data-wm-dest]')?.focus();return;}}
   b.disabled=true;try{let r=null,msg=null;const here=placeName(t.at);
    if(act==='unload'){r=await ctxNow.cmd('unload',{id});const n=Array.isArray(r)?r.length:0;msg='Unloading '+t.name+' at '+here+': '+(t.status==='AT_YARD'?'the forklifts lift ':'the site crane lifts ')+n+' stillage'+(n===1?'':'s')+' off.';}
    else if(act==='collect')r=await ctxNow.cmd('loadCollection',{id:b.dataset.rt,truck:id});
    else if(act==='home'){r=await ctxNow.cmd('dispatch',{id,destination:t.yard});msg=t.name+' is on the road back to the yard.';}
    else if(act==='send'){r=await ctxNow.cmd('dispatch',{id,destination:dest});msg=t.name+' is on the road to '+placeName(dest)+'.';}
    else if(act==='retry'){let n=0;for(const k of openTasks(st,t).filter(k=>k.state==='BLOCKED')){await ctxNow.cmd('retry',{id:k.id});n++;}msg=n?'Trying again.':'Nothing is stuck now.';}
    else if(act==='stop'){let n=0;for(const k of openTasks(st,t).filter(k=>!k.picked)){try{await ctxNow.cmd('cancel',{id:k.id,withDependents:true});n++;}catch{}}msg=n?'Cancelled. The stillages stay where they are.':'Nothing to cancel: the crane is holding one. Let it finish.';}
    ctxNow.notify?.(r?.message??msg??'Done.');W.acted={id,t:performance.now()};if(act!=='retry'&&act!=='stop'){followId=id;mode='follow';showMap();}await ctxNow.refresh?.();}catch(err){ctxNow.notify?.(err.message);}finally{b.disabled=false;}}});
 W.mini.addEventListener('click',e=>{if(!W.miniVB)return;const r=W.mini.getBoundingClientRect(),vb=W.miniVB,k=Math.max(vb[2]/r.width,vb[3]/r.height),ox=(r.width*k-vb[2])/2,oy=(r.height*k-vb[3])/2,q={x:vb[0]+(e.clientX-r.left)*k-ox,y:vb[1]+(e.clientY-r.top)*k-oy},inv=E.inverse;userCam();followId=null;animateTo({cx:inv[0]*q.x+inv[2]*q.y,cy:inv[1]*q.x+inv[3]*q.y,s:cam.s});});}
// In Arrange map, the site whose block is under a point of the view (its building, crane and tag included), not only its bare ground.
function siteUnder(q){const l=built.layout;if(!l||!cam)return null;const ok=p=>p&&p.kind==='site'&&!p.archived,hit=p=>({dataset:{wmSite:p.id}}),VW=W.w*OVER,VH=W.h*OVER,x=q.x+(VW-W.w)/2,y=q.y+(VH-W.h)/2;
 for(const t of W.tagData??[])if(t.site&&t.vis&&t.box&&x>=t.box[0]&&x<=t.box[2]&&y>=t.box[1]&&y<=t.box[3]){const p=l.byId.get(t.site);if(ok(p))return hit(p);}
 const w=toWorld(q.x,q.y),lot=lotOf(l,w.x,w.y),on=l.places.find(p=>ok(p)&&p.col===lot.c&&p.row===lot.r);if(on)return hit(on);
 // the building and the crane standing up from a site's block: the nearest site whose shot box holds the point
 const C=proj({x:cam.cx,y:cam.cy});let best=null,bd=Infinity;for(const p of l.places){if(!ok(p))continue;const b=boxProj(placeBox(p,0)),x0=cam.s*(b.x0-C.x)+VW/2,x1=cam.s*(b.x1-C.x)+VW/2,y0=cam.s*(b.y0-C.y)+VH/2,y1=cam.s*(b.y1-C.y)+VH/2;if(x<x0||x>x1||y<y0||y>y1)continue;const d=Math.hypot(x-(x0+x1)/2,y-(y0+y1)/2);if(d<bd){bd=d;best=p;}}
 return best?hit(best):null;}
// On a phone the card sits under the map: after an order from it, the page scrolls back up so the whole map (and the truck on it) is in view.
function showMap(){if(!phone()||typeof requestAnimationFrame!=='function')return;requestAnimationFrame(()=>{if(!W?.stage?.isConnected)return;const r=W.view.getBoundingClientRect(),top=64;if(r.top<top||r.bottom>innerHeight)scrollBy({top:r.top-top,behavior:'smooth'});W.anchor=null;});}
function animateTo(t){cancelPlan();prepareGlide(t);camTarget=t;W.glide=true;kick();}
function drawGhost(id,lot){const l=built.layout,taken=l.places.find(p=>p.id!==id&&p.col===lot.c&&p.row===lot.r),x=lot.c*l.pw,y=lot.r*l.ph;W.ghost.innerHTML='<rect x="'+x+'" y="'+y+'" width="'+l.bw+'" height="'+l.bh+'" transform="translate('+R(LOW.x)+' '+R(LOW.y)+')" fill="'+(taken?'#bd4636':'#98cc2e')+'" fill-opacity=".28" stroke="'+(taken?'#bd4636':'#2f7353')+'" stroke-width="700" stroke-dasharray="2400 1400"/>';}
const clearGhost=()=>{if(W?.ghost)W.ghost.innerHTML='';};
async function placeSite(id,col,row){const p=built.layout?.byId.get(id);if(!p||!ctxNow)return;try{const r=await ctxNow.cmd('worldPlace',{id,col,row});ctxNow.notify?.(r.message??'Moved.');await ctxNow.refresh?.();}catch(err){ctxNow.notify?.(err.message);}}

// ---- the frame loop: only while something moves, never while the tab is hidden or the stage is off the page
// kick() starts the loop unless one is scheduled or running (frame() itself decides whether it goes on): never two loops at once.
let inFrame=false;
function kick(){if(typeof requestAnimationFrame!=='function'||raf||inFrame||!W)return;lastT=0;raf=requestAnimationFrame(frame);}
function frame(t){raf=0;if(!W||!W.stage.isConnected||document.hidden||W.onScreen===false)return;inFrame=true;try{frameBody(t);}finally{inFrame=false;}}
function frameBody(t){W.glide=!!(camGoal||camTarget);const t0=performance.now();const dt=lastT?Math.min(100,t-lastT):16;lastT=t;const now=performance.now();let busy=false;
 const lifted=new Set();for(const c of cranes.values()){const id=stepCrane(c,now,dt);if(id)lifted.add(id);if(c.moving)busy=true;}
 const lk=[...lifted].sort().join(',');if(lk!==W.liftKey){W.liftKey=lk;for(const tr of trips.values())if(tr.truck&&tr.hk!=null&&tr.cargo?.length)truckArt(tr,tr.hk,lifted);}
 if(followId){const tr=trips.get(followId);if(tr?.driving)tr.at=poseNow(tr,now);}
 if(camTarget){if(camPlan?.kind==='goal')cancelPlan();if(runPlan('target',now))busy=true;}
 else if(stepCam(now,dt))busy=true;
 if(W.sliding){if(performance.now()-slideT>200&&!W.gesture&&!W.glide){if(Math.abs(slideOf(cam).k-1)>.02)commitCam();else W.sliding=false;}else if(W.gesture||(W.glide&&!camPlan)||performance.now()-slideT<=200)busy=true;}
 if(now-(W.tickT??0)>200)tick(now);
 if(!busy&&!camPlan&&W.slideOn&&!W.gesture&&camC){const q=slideOf(cam);if(!q.ok||Math.abs(q.k-1)>.02)commitCam();}
 measure('wm-frame',t0);
 if(busy)raf=requestAnimationFrame(frame);}
// Five times a second while a truck drives or a card is open: where each truck is now (for the overview map, the trip strip, the card and the
// director's shot), without touching the map itself.
const camMoving=()=>!!(camGoal||camTarget||W?.gesture||W?.glide||(followId&&trips.get(followId)?.driving&&!trips.get(followId)?.paused));
function tick(now=performance.now()){if(!W)return;W.tickT=now;if(camPlan)cam=planCam();let driving=false;for(const tr of trips.values())if(tr.driving&&tr.truck){tr.at=poseNow(tr,now);if(!tr.paused&&(tr.u??0)<1)driving=true;}drawMiniDots();drawMiniView();zoomLabel();tickStrip();tickCard();syncWatch();if(W.lodStale&&!camMoving())lodSoon();
 if(driving&&mode!=='free'&&!raf)kick();const want=driving||!!cardFor;if(want&&!W.ticker)W.ticker=setInterval(()=>{if(!W?.stage?.isConnected||document.hidden){clearInterval(W.ticker);W.ticker=null;return;}tick();},200);else if(!want&&W.ticker){clearInterval(W.ticker);W.ticker=null;}}
// operations.js applyView on Home: the world camera, not the yard view; a selected yard stillage off screen brings the camera to the yard.
export function wmApplyView(selectedId){if(!W||!W.stage.isConnected)return false;if(selectedId){const el=W.svg.querySelector('[data-select="'+CSS.escape(selectedId)+'"]');const yp=built.layout?.places.find(p=>p.kind==='yard');if(el&&yp){const r=el.getBoundingClientRect(),v=W.view.getBoundingClientRect();if(r.right<v.left||r.left>v.right||r.bottom<v.top||r.top>v.bottom){userCam();fitNow({x0:yp.ext.x0-2000,y0:yp.ext.y0-2000,x1:yp.ext.x1+2000,y1:yp.ext.y1+2000,tall:4000});}}}applyCam();return true;}
export function wmStop(){if(raf&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(raf);raf=0;if(W?.ticker){clearInterval(W.ticker);W.ticker=null;}clearTimeout(lodT);lodT=0;for(const tr of trips.values()){clearTimeout(tr.swapT);clearTimeout(tr.replanT);}}
// Tests and measurements.
export const __wm={commit:()=>{if(W&&cam){camC=null;commitCam();}},setCam:c=>{cam={...cam,...c};camGoal=null;camTarget=null;mode='free';followId=null;},layout:wmLayout,signal:wmSignal,staticSVG:wmStatic,siteSVG:wmSiteSVG,siteParts:wmSiteParts,headingKey,truckArtAt,truckLine,rtOf,sendTo,siteKit,short,state:()=>({cam,mode,followId,arrange,trips,cranes,W,live}),reset(){yardCache.key=null;W=null;cam=null;mode='director';followId=null;arrange=false;trips.clear();cranes.clear();built.sig=null;built.yard=null;built.sites=new Map();live={key:null,v:0,yard:'',sites:new Map(),sig:''};stateSeen=null;cardFor=null;}};
