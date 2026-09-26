// Home world map ("director cam district map"): the yard and every site the viewer may see on one isometric district of streets and houses, each place
// at the scale of its own plan. Trucks drive the road their trip was timed on (public/world-layout.js, shared with the server), smoothly between polls;
// the site crane lifts the load off; a director camera frames whatever is happening, or the owner pans and zooms freely.
// The map owns one persistent DOM tree (the stage). operations.js renders an empty host (wmShell), reports live changes through a tiny part (wmSignal)
// and calls wmAttach after every render or patch; wmAttach moves the stage into the host and patches only what changed. Static scenery (ground,
// streets, houses, trees) is built once per layout; the yard, each site and each truck are live layers; requestAnimationFrame runs only while
// something moves. No DOM access at module level: the string builders run in Node tests.
import {esc,num,DEFAULT_VIEW,planLinear,yardSVG,workerFigure,truckDims,STATUS_COLOURS,projection,block,poly,box4,shade,shadowOf,walls,quad,onWall,defsSVG,packSVG,truckSVG,textW,labelBand,labelRoom} from './visual.js';
import {WORLD,worldLayout,nodeAt,restPoses,routeGeom,poseAt,distanceAt,worldRoute,truckTotal} from './world-layout.js';

const SVGNS='http://www.w3.org/2000/svg',S=WORLD.street,G=-260,R=Math.round,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const L=planLinear({...DEFAULT_VIEW,tilt:true,rotate:0}),E=projection(L,0.9),LOW=E.up(G);
const P=p=>R(p.x)+' '+R(p.y),add=(p,v)=>({x:p.x+v.x,y:p.y+v.y}),lerp=(p,q,u)=>({x:p.x+(q.x-p.x)*u,y:p.y+(q.y-p.y)*u}),up=h=>E.up(h),at=(p,h)=>add(p,up(h));
const proj=p=>({x:L[0]*p.x+L[2]*p.y,y:L[1]*p.x+L[3]*p.y});
const hash=(...n)=>{let h=2166136261;for(const v of n){h^=(v|0)+0x9e3779b9;h=Math.imul(h,16777619);h^=h>>>13;}return ((h>>>0)%100003)/100003;};
const strHash=s=>{let h=0;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0;};
const isOps=a=>!!a?.permissions?.includes('operations.manage');
// User Timing marks (wm-build, wm-attach, wm-frame) for measuring the map in a browser's performance panel; cleared now and then so they never pile up.
let marks=0;const measure=(name,t0)=>{if(typeof performance==='undefined'||typeof performance.measure!=='function')return;try{performance.measure(name,{start:t0});if(++marks>600){marks=0;for(const n of ['wm-build','wm-attach','wm-frame'])performance.clearMeasures(n);}}catch{}};

// ---------------------------------------------------------------- layout from the snapshot
// The server's lots and block size when the snapshot has them (a supervisor sees only some sites, but draws them where everybody does).
export function wmLayout(state){
 const yard=state?.yards?.[0]??state?.world?.yard??null,sites=(state?.sites??[]).filter(s=>s.status==='ACTIVE'),w=state?.world;
 if(!yard&&!sites.length)return null;return worldLayout(yard,sites,w?.bw?{bw:w.bw,bh:w.bh,lots:w.lots}:null);}
const layoutSig=l=>l?l.bw+'|'+l.bh+'|'+l.places.map(p=>p.id+':'+p.col+':'+p.row+':'+p.ox+':'+p.oy+':'+strHash(JSON.stringify([p.src.points,p.src.fixtures??null,p.src.parking??null,p.src.gate??null,p.src.loading??null,p.src.name]))).join(','):'';
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
function streetsSVG(l,ext){const {X0,X1,Y0,Y1,C0,C1,R0,R1}=ext,{pw,ph,bw,bh}=l;let foot='',road='',kerb='',dash='',zebra='';const cw=S-2*WORLD.foot,o=WORLD.foot;
 const hs=[],vs=[];for(let r=R0-1;r<=R1;r++)hs.push(r*ph+bh);for(let c=C0-1;c<=C1;c++)vs.push(c*pw+bw);
 for(const y of hs){foot+='<rect x="'+X0+'" y="'+y+'" width="'+(X1-X0)+'" height="'+S+'"/>';road+='<rect x="'+X0+'" y="'+(y+o)+'" width="'+(X1-X0)+'" height="'+cw+'"/>';kerb+='M'+X0+' '+(y+o)+'H'+X1+'M'+X0+' '+(y+o+cw)+'H'+X1;}
 for(const x of vs){foot+='<rect x="'+x+'" y="'+Y0+'" width="'+S+'" height="'+(Y1-Y0)+'"/>';road+='<rect x="'+(x+o)+'" y="'+Y0+'" width="'+cw+'" height="'+(Y1-Y0)+'"/>';kerb+='M'+(x+o)+' '+Y0+'V'+Y1+'M'+(x+o+cw)+' '+Y0+'V'+Y1;}
 // centre lines between the intersections, zebra crossings on the approaches
 for(const y of hs){const cy=y+S/2;for(let i=0;i<vs.length-1;i++){const a=vs[i]+S+600,b=vs[i+1]-600;if(b>a)dash+='M'+a+' '+cy+'H'+b;}}
 for(const x of vs){const cx=x+S/2;for(let i=0;i<hs.length-1;i++){const a=hs[i]+S+600,b=hs[i+1]-600;if(b>a)dash+='M'+cx+' '+a+'V'+b;}}
 for(const y of hs)for(const x of vs)if(hash(x,y,7)<.35){for(let k=0;k<7;k++){const yy=y+o+400+k*1050;zebra+='M'+(x-2200)+' '+yy+'h1700';}}
 return '<g fill="url(#wm-paving)">'+foot+'</g><g fill="url(#asphalt)">'+road+'</g><path d="'+kerb+'" stroke="#e4ded0" stroke-width="200" fill="none"/><path d="'+kerb+'" stroke="#8a8474" stroke-width="50" stroke-opacity=".7" fill="none"/><path d="'+dash+'" stroke="#f4f1e6" stroke-width="130" stroke-dasharray="1500 1100" fill="none"/><path d="'+zebra+'" stroke="#f2efe4" stroke-width="600" fill="none" stroke-opacity=".9"/>';}
// Everything static for one layout: {ground, blocks: Map diag -> svg}. Houses fill the empty blocks, trees the margins; the fronts of places stay clear.
export function wmStatic(l){
 const {c0,c1,r0,r1}=l.range,C0=c0-1,C1=c1+1,R0=r0-1,R1=r1+1,X0=C0*l.pw-S,X1=(C1+1)*l.pw,Y0=R0*l.ph-S,Y1=(R1+1)*l.ph,ext={X0,X1,Y0,Y1,C0,C1,R0,R1};
 const placeAt=new Map(l.places.map(p=>[p.col+','+p.row,p])),front=new Set(l.places.map(p=>p.col+','+p.row));
 let ground='<rect x="'+X0+'" y="'+Y0+'" width="'+(X1-X0)+'" height="'+(Y1-Y0)+'" fill="url(#grass)"/>'+streetsSVG(l,ext),drive='';
 const blocks=new Map(),put=(d,s)=>blocks.set(d,(blocks.get(d)??'')+s);
 for(let r=R0;r<=R1;r++)for(let c=C0;c<=C1;c++){const x0=c*l.pw,y0=r*l.ph,x1=x0+l.bw,y1=y0+l.bh,d=c+r,items=[],inner=c>=c0&&c<=c1&&r>=r0&&r<=r1,place=placeAt.get(c+','+r);
  const tree=(x,y,sz,v)=>items.push({dep:E.depth({x,y}),svg:treeSVG({x,y},sz,v)});
  // street trees on this block's footpaths (not along the front of a place, where the trucks stop, nor across the street from one)
  const across=front.has(c+','+(r-1)),mine=!!place;
  for(let x=x0+5000;x<x1-4000;x+=15000+R(hash(c,r,x)*3000)){if(!mine&&hash(c,r,x,1)<.85)tree(x,y1+900,.72+hash(c,r,x)*.2,R(hash(x,r)*3));if(!across&&hash(c,r,x,2)<.85)tree(x,y0-900,.72+hash(c,r,x,3)*.2,R(hash(x,c)*3));}
  if(!inner){for(let k=0;k<4;k++){if(hash(c,r,k,9)<.55)tree(x0+4000+hash(c,r,k)*(l.bw-8000),y0+4000+hash(r,c,k)*(l.bh-8000),.8+hash(k,c,r)*.35,k);}}
  else if(!place){// a suburban block: two rows of houses back to back, the front row facing the street below, the back row the street above
   const n=Math.max(2,Math.floor(l.bw/16000)),lw=l.bw/n;for(let row=0;row<2;row++)for(let i=0;i<n;i++){const v=hash(c,r,i,row),w=R(Math.min(lw-5000,10500+v*2500)),dd=R(10500+hash(c,r,i,row,5)*2500),x=R(x0+i*lw+(lw-w)/2+(hash(i,r,c)-.5)*1200),yf=row===0?y1-6000-dd:y0+6000,y=R(yf),fr=row===0?1:-1;
    items.push({dep:E.depth({x:x+w/2,y:y+dd/2}),svg:houseSVG(x,y,w,dd,fr,v)});
    const gx=x+(hash(c,i,row)<.5?600:w-3600);drive+=row===0?'<rect x="'+R(gx)+'" y="'+(y+dd)+'" width="3000" height="'+(y1-(y+dd))+'"/>':'<rect x="'+R(gx)+'" y="'+y0+'" width="3000" height="'+(y-y0)+'"/>';
    if(hash(c,r,i,row,8)<.7)tree(x+w*.5+(hash(i,c)-.5)*w*.6,row===0?y-3500:y+dd+3500,.85+hash(r,i)*.3,i+row);}}
  else if(place.kind==='yard'){// trees in the side margins and behind the yard
   const e=place.ext;for(let y=e.y0;y<e.y1-2000;y+=9000){if(e.x0-x0>6500)tree(x0+2600+hash(c,y)*1500,y+2000,.85,R(y/9000));if(x1-e.x1>6500&&!(place.bay&&y<place.bay.y+place.bay.length+4000))tree(x1-2600-hash(y,c)*1500,y+2000,.85,R(y/7000));}
   for(let x=e.x0;x<e.x1;x+=11000)if(e.y0-y0>6000)tree(x+3000,y0+2500+hash(x)*1500,.9,R(x/11000));}
  else{// a site block: trees at the back corners; the building and the shed belong to the site layer
   const e=place.ext;if(e.x0-x0>6000)tree(x0+2500,y0+3000,.95,1);if(x1-e.x1>6000)tree(x1-2500,y0+3500,.9,2);}
  items.sort((a,b)=>a.dep-b.dep);if(items.length){const cs=[{x:x0-S,y:y0-S},{x:x1+S,y:y0-S},{x:x1+S,y:y1+S},{x:x0-S,y:y1+S}].map(proj),top=proj(up(12000));put(d,'<g class="wm-blk" data-bb="'+[Math.min(...cs.map(p=>p.x)),Math.min(...cs.map(p=>p.y))+top.y,Math.max(...cs.map(p=>p.x)),Math.max(...cs.map(p=>p.y))].map(R).join(' ')+'">'+items.map(o=>o.svg).join('')+'</g>');}}
 // driveways and crossovers: the yard bay to the street (flared where the truck reverses in), each site's gate crossover, lanes out of the yard
 for(const p of l.places){const kerbY=p.streetY-S/2+WORLD.foot;if(p.kind==='yard'&&p.bay){const b=p.bay,x=b.x,w=b.width,y=b.y+b.length;drive+='<path d="M'+x+' '+y+'H'+(x+w)+'V'+(kerbY-3000)+'L'+(x+w+5000)+' '+kerbY+'H'+(x-5000)+'L'+x+' '+(kerbY-3000)+'Z" fill="url(#asphalt)"/>';
   for(const f of (p.src.fixtures??[]).filter(f=>f.kind==='ENTRY'||f.kind==='EXIT')){const e=p.ext;if(f.y+f.h+p.oy>=e.y1-2600)drive+='<rect x="'+(f.x+p.ox)+'" y="'+(f.y+f.h+p.oy-200)+'" width="'+f.w+'" height="'+(kerbY-(f.y+f.h+p.oy)+200)+'" fill="url(#asphalt)"/>';}}
  else if(p.kind==='site')drive+='<rect x="'+(p.attachX-3200)+'" y="'+(p.block.y1-600)+'" width="6400" height="'+(kerbY-p.block.y1+600)+'" fill="#cfc9bb" stroke="#b3ac9c" stroke-width="60"/>';}
 ground+='<g fill="#d3cdbf" stroke="#bdb6a6" stroke-width="40">'+drive+'</g>';
 return {ground:'<g class="wm-ground" transform="translate('+R(LOW.x)+' '+R(LOW.y)+')">'+ground+'</g>',blocks,ext,diags:[C0+R0-1,C1+R1+1]};}

// ---------------------------------------------------------------- sites
const SITE_H=2100;
// The tower crane stands behind the site's own ground, between it and the building; its jib reaches the kerb where trucks stop.
function craneOf(p,l){const e=p.ext,x=R((e.x0+e.x1)/2),y=R(e.y0-2600),kerb=p.streetY-WORLD.lane,reach=Math.max(Math.hypot(e.x0-x,e.y1-y),Math.hypot(e.x1-x,e.y1-y),Math.hypot(p.attachX-x,kerb-y),Math.hypot(p.attachX-26000-x,kerb-y))+3000;return {x,y,H:24000,reach:Math.min(reach,62000)};}
function buildingOf(p,l){const e=p.ext,top=p.block.y0+3500,bot=e.y0-5500,d=Math.min(15000,bot-top);if(d<8000)return null;const w=Math.min(e.x1-e.x0+6000,l.bw-16000,32000),x=R((e.x0+e.x1)/2-w/2),n=3+(strHash(p.id)%2);return {x,y:R(bot-d),w,d,n,H:n*3200};}
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
function mastSVG(c){const r=800,base=G,cs=box4(c.x-r,c.y-r,2*r,2*r);let chords='',lace='';const corners=cs;for(const q of corners)chords+='M'+P(at(q,base+300))+'L'+P(at(q,base+c.H));
 for(const [a,b] of [[corners[3],corners[2]],[corners[1],corners[2]]]){for(let z=base+300,k=0;z<base+c.H-1200;z+=1600,k++){const p=k%2?a:b,q=k%2?b:a;lace+='M'+P(at(p,z))+'L'+P(at(q,z+1600));}}
 return shadowOf(E,box4(c.x-1400,c.y-1400,2800,2800),c.H*.25,.18,LOW)+block(E,box4(c.x-1600,c.y-1600,3200,3200),G,G+300,'#a39d90','#bdb7aa','#6d6a62',20)+'<path d="'+chords+'" stroke="#c99a16" stroke-width="120"/><path d="'+lace+'" stroke="#e4b22a" stroke-width="60"/>';}
// Temporary fence panels on feet along the site boundary (see-through mesh on the street side, shade cloth behind), open where the gate is.
function hoardingItems(p,gateU){const pts=p.src.points??[],items=[],FH=SITE_H,ox=p.ox,oy=p.oy,e=p.ext;const area=pts.reduce((s,q,i)=>{const r=pts[(i+1)%pts.length];return s+q.x*r.y-r.x*q.y;},0);
 pts.forEach((a0,i)=>{const b0=pts[(i+1)%pts.length],a={x:a0.x+ox,y:a0.y+oy},b={x:b0.x+ox,y:b0.y+oy},len=Math.hypot(b.x-a.x,b.y-a.y);if(len<1)return;const dx=(b.x-a.x)/len,dy=(b.y-a.y)/len,nrm=area>0?{x:dy,y:-dx}:{x:-dy,y:dx},facing=proj(nrm).y>0.02;
  let gaps=[];if(gateU&&Math.abs(dy)<1e-6&&Math.abs(a.y-e.y1)<5){const g0=Math.min(a.x,b.x),g1=Math.max(a.x,b.x);if(gateU>g0+2600&&gateU<g1-2600){const t0=Math.abs(gateU-2400-a.x),t1=Math.abs(gateU+2400-a.x);gaps=[[Math.min(t0,t1),Math.max(t0,t1)]];}}
  const segs=[];let s0=0;for(const [g0,g1] of gaps){if(g0>s0+100)segs.push([s0,g0]);s0=g1;}if(s0<len-100)segs.push([s0,len]);
  for(const [s1,s2] of segs){const k=Math.max(1,Math.round((s2-s1)/2400));for(let j=0;j<k;j++){const u={x:a.x+dx*(s1+(s2-s1)*j/k),y:a.y+dy*(s1+(s2-s1)*j/k)},v={x:a.x+dx*(s1+(s2-s1)*(j+1)/k),y:a.y+dy*(s1+(s2-s1)*(j+1)/k)},m=lerp(u,v,.5);
   items.push({dep:E.depth(m),svg:poly([at(u,0),at(v,0),at(v,FH),at(u,FH)],'fill="url(#'+(facing?'mesh':'wm-shadecloth')+')" pointer-events="none"')+(facing?poly([at(u,0),at(v,0),at(v,700),at(u,700)],'fill="#2f5d45" fill-opacity=".8" pointer-events="none"'):'')+'<path d="M'+P(at(u,-60))+'L'+P(at(u,FH))+'M'+P(at(u,FH))+'L'+P(at(v,FH))+'" stroke="#9aa3a0" stroke-width="55" stroke-linecap="round" pointer-events="none"/>'+block(E,box4(u.x-260,u.y-130,520,260),-60,120,'#c9c2b2','#ddd6c7','#6f695d',14)});}}
  for(const [g0,g1] of gaps){for(const [t,sg] of [[g0,1],[g1,-1]]){const A={x:a.x+dx*t,y:a.y+dy*t},tip={x:A.x+nrm.x*1700+dx*sg*1600,y:A.y+nrm.y*1700+dy*sg*1600};items.push({dep:E.depth(lerp(A,tip,.5)),svg:poly([at(A,0),at(tip,0),at(tip,FH),at(A,FH)],'fill="url(#mesh)" pointer-events="none"')+'<path d="M'+P(at(A,0))+'L'+P(at(A,FH+200))+'" stroke="#2c3430" stroke-width="140"/><path d="M'+P(at(A,FH-300))+'L'+P(at(A,FH+200))+'" stroke="#f0c230" stroke-width="140"/>'});}}});
 return items;}
const craneKind=(state,siteId)=>(state.resources??[]).filter(r=>r.type==='CRANE'&&r.location===siteId);
// One site: its laydown ground, fence and gate, the shed, the building under scaffold behind it, the crane mast, and everything live on it (stillages, crew).
export function wmSiteSVG(p,l,state,ctx={}){
 const src=p.src,pts=(src.points??[]).map(q=>({x:q.x+p.ox,y:q.y+p.oy})),items=[],e=p.ext;if(pts.length<3)return '';
 let ground='<polygon points="'+pts.map(q=>P(add(q,LOW))).join(' ')+'" fill="none" stroke="#b3ac9a" stroke-width="1600" stroke-linejoin="round"/>';
 const area=pts.reduce((s,q,i)=>{const r=pts[(i+1)%pts.length];return s+q.x*r.y-r.x*q.y;},0);let kerb='';pts.forEach((a,i)=>{const b=pts[(i+1)%pts.length],len=Math.hypot(b.x-a.x,b.y-a.y)||1,n=area>0?{x:(b.y-a.y)/len,y:-(b.x-a.x)/len}:{x:-(b.y-a.y)/len,y:(b.x-a.x)/len},d=proj(n);if(d.y>0.02)kerb+=poly([a,b,add(b,LOW),add(a,LOW)],'fill="'+shade('#b3a17f',.8-.18*d.x/Math.hypot(d.x,d.y))+'" stroke="#8a7a5c" stroke-width="30"');});
 ground+=kerb+'<polygon points="'+pts.map(P).join(' ')+'" fill="url(#wm-dirt)" stroke="#8a7a5c" stroke-width="40"/>';
 if(src.loading)ground+='<rect x="'+(src.loading.x+p.ox)+'" y="'+(src.loading.y+p.oy)+'" width="2000" height="1500" fill="url(#hatch)" stroke="#e3bd2c" stroke-width="70"/>';
 const gateU=p.attachX;for(const it of hoardingItems(p,gateU))items.push(it);
 const b=buildingOf(p,l);if(b)items.push({dep:E.depth({x:b.x+b.w/2,y:b.y+b.d/2}),svg:buildingSVG(b)});
 const shedX=e.x0-7400;if(shedX>p.block.x0+800)items.push({dep:E.depth({x:shedX+3000,y:e.y1-3400}),svg:shedSVG(shedX,e.y1-4800,6000,2800)});
 const cranes=craneKind(state,src.id);if(cranes.length){const c=craneOf(p,l);items.push({dep:E.depth(c),svg:mastSVG(c)});}
 // stillages on site, stacked, with their contents in the tooltip (world.items is unpaged, state.containers is only the current page)
 const stock=(state.world?.items??state.containers??[]).filter(c=>c.location===src.id),byId=new Map(stock.map(c=>[c.id,c])),names=new Map((state.products??[]).map(q=>[q.id,q.name]));
 const linesOf=c=>Array.isArray(c.lines)?c.lines.map(([id,q])=>({name:names.get(id)??'Material',quantity:q,reserved:0})):(state.balances??[]).filter(x=>x.container===c.id&&x.quantity>0).map(x=>({name:names.get(x.product_id)??'Material',quantity:x.quantity,reserved:x.reserved||0}));
 const baseOf=c=>{let h=0,cur=byId.get(c.support),n=0;while(cur&&n++<9){h+=cur.height||1000;cur=byId.get(cur.support);}return h;},levelOf=c=>{let n=0,cur=c;while(cur?.support&&n<9){cur=byId.get(cur.support);n++;}return n;};
 for(const c of stock){const rw=c.rotation===90?c.envelopeWidth:c.envelopeLength,rh=c.rotation===90?c.envelopeLength:c.envelopeWidth;if(!(rw>0&&rh>0))continue;const lc={...c,x:c.x+p.ox,y:c.y+p.oy},lv=levelOf(c);items.push({dep:E.depth({x:lc.x+rw/2,y:lc.y+rh/2})+lv*1e-3,svg:packSVG(E,lc,rw,rh,baseOf(c),lv,{selected:ctx.selected===c.id,lines:linesOf(c),shadow:lv===0,stackH:c.height})});}
 for(const w of (state.resources??[]).filter(r=>r.type==='WORKER'&&r.location===src.id&&Number.isFinite(r.x))){const g={x:w.x+250+p.ox,y:w.y+250+p.oy},busy=!!w.task;items.push({dep:E.depth(g),svg:'<g class="wm-crew" transform="translate('+R(g.x)+' '+R(g.y)+')"><title>'+esc(w.name)+(busy?' - unloading':' - on site')+'</title><g transform="'+E.bb+'">'+workerFigure(busy?'#ff8a1e':'#d7f02f',busy?'#9a4a06':'#7d8a16')+'</g></g>'});}
 items.sort((a,b)=>a.dep-b.dep);
 return '<g class="wm-site-ground">'+ground+'</g>'+items.map(o=>o.svg).join('');}

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
let cam=null,camTarget=null,mode='director',followId=null,arrange=false,raf=0,lastT=0,ctxNow=null,stateSeen=null,cardFor=null,lastUser=0;
const trips=new Map();// truck id -> {g, route geom, D, anchorR, anchorT, u, hk, slot, art key}
const cranes=new Map();// site id -> {g, c, cur:{a,r,z}, load, ...}
const built={sig:null,yard:null,sites:new Map(),statics:null};
const loadCam=()=>{try{const v=JSON.parse(localStorage.getItem('worldcam')||'null');return v&&Number.isFinite(v.cx)&&Number.isFinite(v.cy)&&v.s>0?v:null;}catch{return null;}};
const saveCam=()=>{try{localStorage.setItem('worldcam',JSON.stringify({cx:R(cam.cx),cy:R(cam.cy),s:+cam.s.toFixed(6),mode:mode==='follow'?'free':mode,v:1}));}catch{}};

// The host operations.js renders: the stage is moved into it after every render.
export function wmShell(){return '<div class="wm-host" data-wm-host></div>';}
// Live content, built from the state (cached per state object and selection); the part's HTML changes when any live layer changed, which makes the
// Home patch call wmAttach. Pure strings: runs in Node too.
let live={key:null,v:0,yard:'',sites:new Map(),sig:''};
export function wmSignal(ctx){const l=wmLayout(ctx.state);const k=[ctx.state,ctx.selected,ctx.selectedWorker,ctx.planned,ctx.pulse];if(live.key&&live.key.every((v,i)=>v===k[i]))return '<i class="wm-sig" hidden data-v="'+live.v+'"></i>';
 const t0=performance.now(),next=l?buildLive(l,ctx):{yard:'',sites:new Map(),trucks:''};measure('wm-build',t0);const sig=next.yard.length+':'+strHash(next.yard)+'|'+[...next.sites].map(([id,s])=>id+strHash(s)).join(',')+'|'+next.trucks+'|'+layoutSig(l)+'|'+(ctx.state?.config?.paused?1:0);
 if(sig!==live.sig)live.v++;live={...live,...next,key:k,sig,layout:l};return '<i class="wm-sig" hidden data-v="'+live.v+'"></i>';}
// The yard (the plan's own layers, bay truck included), each site, and a signature of everything the trucks layer draws.
function buildLive(l,ctx){const st=ctx.state,out={yard:'',sites:new Map(),trucks:''},yp=l.places.find(p=>p.kind==='yard');
 const trucks=(st.trucks??[]).filter(t=>!t.retired);const rest=new Map();for(const p of l.places)for(const [id,pose] of restPoses(l,p.id,trucks.filter(t=>t.at===p.id&&['AT_YARD','AT_SITE'].includes(t.status)),trucks))rest.set(id,pose);
 if(yp&&st.yards?.[0]){const bayTruck=trucks.find(t=>t.at===yp.id&&t.status==='AT_YARD'&&rest.get(t.id)?.bay),items=st.world?.items??[],have=new Set((ctx.containers??st.containers??[]).map(c=>c.id)),containers=[...(ctx.containers??st.containers??[]),...items.filter(c=>!have.has(c.id)&&c.location===bayTruck?.id)];
  const parts=yardSVG(st.yards[0],containers,st.tasks??[],ctx.selected??null,bayTruck?[bayTruck]:[],st.resources??[],ctx.selectedWorker??null,{...(ctx.opts??{}),view:{...DEFAULT_VIEW,tilt:true,rotate:0},planned:ctx.planned??null,world:true});
  if(parts&&typeof parts==='object'){out.U=parts.U;const b=yp.bay,hit=bayTruck&&b?'<rect class="wm-hit" data-wm-truck="'+esc(bayTruck.id)+'" tabindex="0" role="button" aria-label="'+esc(bayTruck.name)+': show on the map" x="'+(b.px)+'" y="'+(b.py)+'" width="'+b.width+'" height="'+b.length+'" fill="#000" fill-opacity="0"/>':'';out.yard='<defs>'+parts.defs+'</defs><g id="plan">'+parts.plan+'</g>'+hit;}}
 else if(yp){const y=yp.src,pts=(y.points??[]).map(q=>({x:q.x,y:q.y}));out.yard=pts.length>2?'<g id="plan" class="wm-yard-outline"><polygon points="'+pts.map(q=>P(add(q,LOW))).join(' ')+'" fill="none" stroke="#9f967f" stroke-width="2150" stroke-linejoin="round"/><polygon points="'+pts.map(P).join(' ')+'" fill="url(#concrete)" stroke="#8b836f" stroke-width="40"/></g>':'';}
 for(const p of l.places)if(p.kind==='site')out.sites.set(p.id,wmSiteSVG(p,l,st,ctx));
 out.trucks=trucks.map(t=>t.id+t.status+(t.at??'')+(t.destination??'')+(t.route?.delivery??'')+(rest.get(t.id)?P(rest.get(t.id)):'')+(st.world?.items??[]).filter(c=>c.location===t.id).map(c=>c.id+c.x+','+c.y+c.support).join('')).join('|')+'|'+(st.tasks??[]).filter(x=>l.byId.get(x.handling)?.kind==='site').map(x=>x.id+x.state).join(',');
 out.rest=rest;return out;}

// ---- mounting and syncing
const el=(tag,attrs={},html='')=>{const n=document.createElementNS(SVGNS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(html)n.innerHTML=html;return n;};
function setSVG(g,html){// parse in SVG context and keep unchanged nodes (hover, focus, running glides)
 const t=document.createElementNS(SVGNS,'g');t.innerHTML=html;morphKids(g,t);}
function morphKids(a,b){const ac=a.childNodes,bc=[...b.childNodes];if(ac.length!==bc.length){a.replaceChildren(...bc);return;}for(let i=0;i<bc.length;i++)morph(ac[i],bc[i]);}
function morph(a,b){if(a.nodeType!==b.nodeType||a.nodeName!==b.nodeName){a.replaceWith(b);return;}if(a.nodeType!==1){if(a.nodeValue!==b.nodeValue)a.nodeValue=b.nodeValue;return;}if(a.isEqualNode(b))return;for(const n of a.getAttributeNames())if(!b.hasAttribute(n)&&n!=='style')a.removeAttribute(n);for(const n of b.getAttributeNames()){const v=b.getAttribute(n);if(a.getAttribute(n)!==v)a.setAttribute(n,v);}morphKids(a,b);}
function buildStage(){
 const stage=document.createElement('div');stage.className='wm-stage';
 stage.innerHTML='<div class="wm-bar" role="toolbar" aria-label="Map controls"><button type="button" class="wm-btn wm-director" data-wm="director" aria-pressed="true"><i class="wm-rec" aria-hidden="true"></i>Director</button><button type="button" class="wm-btn" data-wm="fit">Fit all</button><button type="button" class="wm-btn" data-wm="yard">Yard</button><span class="wm-zoom"><button type="button" class="wm-btn wm-sq" data-wm="out" aria-label="Zoom out">&minus;</button><b class="wm-zl">100%</b><button type="button" class="wm-btn wm-sq" data-wm="in" aria-label="Zoom in">+</button></span><button type="button" class="wm-btn wm-arrange" data-wm="arrange" aria-pressed="false" hidden>Arrange map</button><span class="wm-hint">Drag to pan &middot; scroll or pinch to zoom &middot; click a truck to follow it</span></div>'
  +'<div class="wm-view"><svg class="yard-svg tilted world-svg" role="img" aria-label="Live map of the yard and the sites" viewBox="0 0 900 560"><defs>'+defsSVG(DEFS_EXTRA).slice(6,-7)+'</defs><rect class="wm-sky" x="-50000" y="-50000" width="100000" height="100000" fill="#a3b27a"/><g class="wm-cam"></g><g class="wm-tags" pointer-events="none"></g></svg>'
  +'<div class="wm-card" hidden role="region" aria-live="polite"></div><svg class="wm-mini" aria-label="Overview map: click to look there" role="img"></svg><div class="wm-note" hidden></div></div>'
  +'<div class="wm-strip" aria-label="Trucks" role="list"></div>';
 const svg=stage.querySelector('svg.world-svg'),camG=svg.querySelector('.wm-cam');W={stage,svg,cam:camG,tags:svg.querySelector('.wm-tags'),card:stage.querySelector('.wm-card'),mini:stage.querySelector('.wm-mini'),strip:stage.querySelector('.wm-strip'),note:stage.querySelector('.wm-note'),view:stage.querySelector('.wm-view'),w:900,h:560,diagG:new Map(),slotG:new Map(),placeG:new Map()};
 bindStage();if(typeof ResizeObserver==='function'){W.ro=new ResizeObserver(()=>measureView());W.ro.observe(W.view);}W.onScreen=true;if(typeof IntersectionObserver==='function'){W.io=new IntersectionObserver(es=>{for(const e of es){W.onScreen=e.isIntersecting;if(W.onScreen)kick();}});W.io.observe(W.view);}return W;}
// The svg is OVER times the view in each direction, centred on it: between repaints the camera slides and scales the finished picture (a CSS transform
// the compositor applies), and the svg is redrawn for the new camera when the slide would show an edge or blur, or once the camera rests.
const OVER=1.4;
function measureView(){if(!W)return;W.k=parseFloat(getComputedStyle(W.svg).getPropertyValue('--k'))||1;const r=W.view.getBoundingClientRect(),w=Math.max(200,R(r.width)),h=Math.max(160,R(r.height));if(w===W.w&&h===W.h)return;const first=!W.sized;W.w=w;W.h=h;W.sized=true;const VW=R(w*OVER),VH=R(h*OVER);W.svg.setAttribute('viewBox','0 0 '+VW+' '+VH);const st=W.svg.style;st.width=VW+'px';st.height=VH+'px';st.left=R((w-VW)/2)+'px';st.top=R((h-VH)/2)+'px';if(first&&!loadCam()&&built.layout)fitNow(fitAllBox(built.layout));applyCam(true);kick();}
// Static scenery for a new layout: ground, the diagonal groups (scenery, then the places on that diagonal) and a truck slot after each.
function buildStatic(l){const st=wmStatic(l),[d0,d1]=st.diags;let html=st.ground;for(let d=d0;d<=d1;d++){html+='<g class="wm-d" data-d="'+d+'"><g class="wm-scn">'+(st.blocks.get(d)??'')+'</g></g><g class="wm-slot" data-d="'+d+'"></g>';}html+='<g class="wm-air" pointer-events="none"></g><g class="wm-ghost" pointer-events="none"></g>';
 W.cam.innerHTML=html;W.diagG=new Map([...W.cam.querySelectorAll('.wm-d')].map(g=>[+g.dataset.d,g]));W.slotG=new Map([...W.cam.querySelectorAll('.wm-slot')].map(g=>[+g.dataset.d,g]));W.air=W.cam.querySelector('.wm-air');W.ghost=W.cam.querySelector('.wm-ghost');W.placeG=new Map();W.range=st.diags;W.blks=[...W.cam.querySelectorAll('.wm-blk')].map(el=>({el,bb:el.dataset.bb.split(' ').map(Number),on:true}));
 for(const p of l.places){const g=el('g',{class:'wm-place wm-'+p.kind,transform:p.kind==='yard'?'translate('+p.ox+' '+p.oy+')':'translate(0 0)','data-wm-place':p.id});if(p.kind==='site'){g.setAttribute('data-wm-site',p.id);g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',(p.name||'Site')+': site details');}(W.diagG.get(p.col+p.row)??W.diagG.get(d0)).append(g);W.placeG.set(p.id,g);}
 for(const t of trips.values())t.g?.remove();trips.clear();for(const c of cranes.values())c.g?.remove();cranes.clear();built.yard=null;built.sites=new Map();buildMini(l);}
// Called after every Home render or patch (operations.js bindPage), before the page binds [data-select] and animates the crew.
export function wmAttach(ctx){if(typeof document==='undefined')return;const host=document.querySelector('.scene [data-wm-host]');if(!host)return;ctxNow=ctx;const t0=performance.now();
 if(!W)buildStage();if(W.stage.parentNode!==host)host.replaceChildren(W.stage);
 wmSignal(ctx);const l=live.layout;if(!l){W.cam.replaceChildren();return;}
 const sig=layoutSig(l);if(sig!==built.sig){built.sig=sig;built.layout=l;buildStatic(l);if(!cam){const saved=loadCam();cam=saved?{cx:saved.cx,cy:saved.cy,s:saved.s}:{cx:0,cy:0,s:.01};mode=saved?.mode==='free'?'free':'director';if(!saved)fitNow(fitAllBox(l));}}
 if(!W.sized)measureView();
 if(live.yard!==built.yard){const g=W.placeG.get(l.places.find(p=>p.kind==='yard')?.id);if(g){const old=workerPos(g);setSVG(g,live.yard);glide(g,old);}built.yard=live.yard;W.U=live.U??W.U??30;}
 for(const [id,s] of live.sites)if(built.sites.get(id)!==s){const g=W.placeG.get(id);if(g)setSVG(g,s);built.sites.set(id,s);}
 if(ctx.state!==stateSeen){stateSeen=ctx.state;syncTrips(l,ctx);}
 W.stage.querySelector('.wm-arrange').hidden=!isOps(ctx.account);syncBar();
 syncTags(l,ctx);renderStrip(ctx);if(cardFor)renderCard();applyCam();kick();measure('wm-attach',t0);}
const workerPos=g=>new Map([...g.querySelectorAll('[data-worker],[data-forklift],[data-glide]')].map(n=>[n.dataset.worker??n.dataset.forklift??n.dataset.glide,n.getAttribute('transform')]));
function glide(g,old){if(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;for(const n of g.querySelectorAll('[data-worker],[data-forklift],[data-glide]')){const id=n.dataset.worker??n.dataset.forklift??n.dataset.glide,b=old.get(id),a=n.getAttribute('transform');if(b&&a&&b!==a&&n.dataset.wmGlide!==a){n.dataset.wmGlide=a;const css=t=>t.replace(/translate\(([-.0-9]+) ([-.0-9]+)\)/,'translate($1px, $2px)');try{n.animate([{transform:css(b)},{transform:css(a)}],{duration:900,easing:'linear'});}catch{}}}}

// ---- trucks: parked ones where their spot is, driving ones along their route, every frame
function syncTrips(l,ctx){const st=ctx.state,now=performance.now(),seen=new Set(),rest=live.rest??new Map(),paused=!!st.config?.paused;
 for(const t of (st.trucks??[]).filter(t=>!t.retired)){let tr=trips.get(t.id);
  if(t.status==='IN_TRANSIT'){let route=t.route?.points?.length>1?t.route:null;if(!route){const r=worldRoute(l,t,t.at,t.destination);route=r?{...r,durationMs:Math.max(3000,t.remainingMs??3000)}:null;}if(!route)continue;
   const D=route.durationMs??t.route?.durationMs??3000,key=t.id+':'+(t.route?.delivery??t.delivery);if(!tr||tr.key!==key){tr={...(tr??{}),key,geom:routeGeom(route),D,u:null};trips.set(t.id,tr);}
   tr.driving=true;tr.D=D;tr.anchorR=Math.max(0,t.remainingMs??D);tr.anchorT=now;tr.paused=paused;tr.to=t.destination;tr.from=t.at;if(tr.u==null)tr.u=clamp(1-tr.anchorR/D,0,1);}
  else{const pose=rest.get(t.id);if(!pose||(pose.bay&&st.yards?.[0]?.id===t.at)){if(tr){tr.g?.remove();trips.delete(t.id);}continue;}if(!tr){tr={key:'rest'};trips.set(t.id,tr);}tr.driving=false;tr.pose=pose;tr.u=null;tr.geom=null;}
  tr.truck=t;tr.cargo=(st.world?.items??[]).filter(c=>c.location===t.id);seen.add(t.id);}
 for(const [id,tr] of trips)if(!seen.has(id)){tr.g?.remove();trips.delete(id);}
 syncCranes(l,ctx);}
function tripPose(tr,now,dt){if(!tr.driving)return tr.pose;const target=clamp(1-(tr.anchorR-(tr.paused?0:now-tr.anchorT))/tr.D,0,1);
 if(dt==null||tr.u==null)tr.u=target;else if(!tr.paused){const err=(target-tr.u)*tr.D,speed=clamp(1+err/1200,0.25,2.2);tr.u=clamp(tr.u+dt/tr.D*speed,0,1);}
 return poseAt(tr.geom,distanceAt(tr.geom,tr.u,tr.D));}
function placeTruck(tr,pose,hidden){const t=tr.truck,hk=headingKey(pose.hx,pose.hy),cargo=tr.cargo.filter(c=>!hidden?.has(c.id)),ak=hk+'|'+cargo.map(c=>c.id+c.x+c.y+c.support).join(',');
 if(!tr.g){tr.g=el('g',{class:'wm-truck','data-wm-truck':t.id,tabindex:'0',role:'button'});tr.inner=el('g');tr.g.append(tr.inner);}
 const label=t.name+(tr.driving?' driving to '+placeName(tr.to):' at '+placeName(t.at))+': follow on the map';if(tr.label!==label){tr.label=label;tr.g.setAttribute('aria-label',label);}
 if(tr.ak!==ak){tr.ak=ak;tr.inner.innerHTML='<title>'+esc(t.name)+'</title>'+truckArtAt(t,hk,cargo);}
 const tf='translate('+R(pose.x)+' '+R(pose.y)+')';if(tr.tf!==tf){tr.tf=tf;tr.g.setAttribute('transform',tf);}tr.g.classList.toggle('followed',followId===t.id);
 const lot=lotOf(built.layout,pose.x,pose.y),slot=W.slotG.get(clamp(lot.c+lot.r,W.range[0],W.range[1]));if(slot&&tr.g.parentNode!==slot)slot.append(tr.g);tr.at=pose;}
const placeName=id=>built.layout?.byId.get(id)?.name??'the site';

// ---- the site crane: a hook that eases toward where the current lift wants it; the load hangs from it from pickup to set-down
const PHASES=['QUEUED','RESERVED','ASSIGNED','TRAVELLING_TO_PICKUP','PICKING','CARRYING','PLACING','COMPLETE'];
function syncCranes(l,ctx){const st=ctx.state,now=performance.now(),cfg=st.config??{},step=cfg.stepMs??700,speed=cfg.speed??4000;
 for(const p of l.places){if(p.kind!=='site')continue;const has=craneKind(st,p.id).length>0;let c=cranes.get(p.id);if(!has){if(c){c.g?.remove();cranes.delete(p.id);}continue;}
  if(!c){const geo=craneOf(p,l);c={geo,site:p.id,cur:{a:Math.atan2((p.ext.y0+p.ext.y1)/2-geo.y,(p.ext.x0+p.ext.x1)/2-geo.x),r:geo.reach*.45,z:geo.H-5000},g:el('g',{class:'wm-crane'})};W.air.append(c.g);cranes.set(p.id,c);}
  const tasks=(st.tasks??[]).filter(t=>t.handling===p.id&&t.state!=='BLOCKED');const t=tasks.find(t=>t.resources?.length&&PHASES.indexOf(t.state)>=2)??null;c.task=t?{...t,anchorT:now,carryMs:t.path?.length>1?Math.max(step,t.path.slice(1).reduce((s,q,i)=>s+Math.hypot(q.x-t.path[i].x,q.y-t.path[i].y),0)/speed*1000):step}:null;c.step=step;c.paused=!!cfg.paused;c.blocked=(st.tasks??[]).find(t=>t.handling===p.id&&t.state==='BLOCKED')??null;c.waiting=tasks.length>0;
  c.items=st.world?.items??[];c.place=p;}}
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
 if(p)return {x:item.x+p.ox+rw/2,y:item.y+p.oy+rh/2,z:0};const tr=trips.get(locId);if(tr?.at){const t=tr.truck,D=truckDims(t),a=headingKey(tr.at.hx,tr.at.hy)*HEAD_STEP,hx=Math.cos(a),hy=Math.sin(a),total=truckTotal(t),tw=t.width??2050,X=item.x+rw/2,Y=item.y+rh/2;return {x:tr.at.x+(X-total/2)*hx+(Y-tw/2)*hy,y:tr.at.y+(X-total/2)*hy-(Y-tw/2)*hx,z:G+D.DK};}return null;}
function stepCrane(c,now,dt){const w=craneWant(c,now),k=dt==null?1:1-Math.exp(-dt/260);let da=w.a-c.cur.a;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;const maxA=dt==null?Math.PI:dt/1000*1.6;c.cur.a+=clamp(da*k*2,-maxA,maxA);c.cur.r+=(w.r-c.cur.r)*k;c.cur.z+=(w.z-c.cur.z)*k;
 c.load=w.load;c.moving=Math.abs(da)>0.002||Math.abs(w.r-c.cur.r)>20||Math.abs(w.z-c.cur.z)>20||!!c.task;const key=[c.cur.a.toFixed(3),R(c.cur.r/20),R(c.cur.z/20),c.load?.id??''].join('|');if(key!==c.key){c.key=key;c.g.innerHTML=craneSVG(c);}return c.load?.id??null;}
function craneSVG(c){const g=c.geo,a=c.cur.a,dx=Math.cos(a),dy=Math.sin(a),nx=-dy,ny=dx,base={x:g.x,y:g.y},Z=G+g.H,J=Math.min(g.reach,Math.max(22000,g.reach)),cj=J*.32,pt=(r,side=0)=>({x:base.x+dx*r+nx*side,y:base.y+dy*r+ny*side});
 let lace='';for(let r=1500,k=0;r<J-1000;r+=1800,k++)lace+='M'+P(at(pt(r,k%2?-550:550),Z))+'L'+P(at(pt(r+1800,0),Z+1300));
 const chord='M'+P(at(pt(0,-550),Z))+'L'+P(at(pt(J,-200),Z))+'M'+P(at(pt(0,550),Z))+'L'+P(at(pt(J,200),Z))+'M'+P(at(pt(0,0),Z+1300))+'L'+P(at(pt(J,0),Z+400));
 const apex=at(base,Z+5200),ties='M'+P(apex)+'L'+P(at(pt(J*.62),Z+1100))+'M'+P(apex)+'L'+P(at(pt(-cj),Z+300));
 const cw=[pt(-cj+600,-900),pt(-cj+2600,-900),pt(-cj+2600,900),pt(-cj+600,900)];const trolley=pt(c.cur.r),hookZ=G+Math.max(600,c.cur.z),hook=at(trolley,hookZ);
 let s='<path d="M'+P(at(pt(-cj,-500),Z))+'L'+P(at(pt(0,-500),Z))+'M'+P(at(pt(-cj,500),Z))+'L'+P(at(pt(0,500),Z))+'" stroke="#c99a16" stroke-width="140"/>'+block(E,cw,Z,Z+1400,'#9b9d98','#b9bbb5','#4f524e',16);
 s+='<path d="M'+P(at(base,Z))+'L'+P(apex)+'" stroke="#c99a16" stroke-width="160"/><path d="'+ties+'" stroke="#3e4446" stroke-width="45"/>'+block(E,box4(g.x-900,g.y-900,1800,1800),Z-1600,Z,'#e4b22a','#f0c230','#7a5a0e',16)+block(E,[pt(-300,650),pt(1500,650),pt(1500,1900),pt(-300,1900)],Z-1500,Z,'#f0c230','#ffd84d','#7a5a0e',16);
 s+='<path d="'+chord+'" stroke="#c9960f" stroke-width="170" stroke-linejoin="round"/><path d="'+lace+'" stroke="#f0c230" stroke-width="85"/>';
 s+='<path d="M'+P(at(trolley,Z))+'L'+P(hook)+'" stroke="#2b2f31" stroke-width="60"/>'+block(E,box4(trolley.x-450,trolley.y-450,900,900),Z-300,Z,'#3e4446','#5a6164','#1d2224',12)+block(E,box4(trolley.x-330,trolley.y-330,660,660),hookZ-600,hookZ,'#f0a81c','#ffd36a','#7a5410',14);
 if(c.load){const it=c.load,rw=it.rotation===90?it.envelopeWidth:it.envelopeLength,rh=it.rotation===90?it.envelopeLength:it.envelopeWidth,h=it.height||1000,z=hookZ-1300-h,cs=box4(trolley.x-rw/2,trolley.y-rh/2,rw,rh);s+='<path d="M'+P(hook)+'L'+P(at(cs[0],z+h))+'M'+P(hook)+'L'+P(at(cs[1],z+h))+'M'+P(hook)+'L'+P(at(cs[2],z+h))+'M'+P(hook)+'L'+P(at(cs[3],z+h))+'" stroke="#2b2f31" stroke-width="26"/>'+shadowOf(E,cs,0,.18,up(G))+cargoBox(it,cs,z);}
 return s;}

// ---- camera: screen = s * (L p - C) + centre of the view
let camC=null,slideT=0;
function applyCam(force){if(!W||!cam)return;if(!force&&camC&&cam.cx===camC.cx&&cam.cy===camC.cy&&cam.s===camC.s)return;if(!force&&camC&&W.sized){const k=cam.s/camC.s,Cc=proj({x:camC.cx,y:camC.cy}),Cl=proj({x:cam.cx,y:cam.cy}),tx=cam.s*(Cc.x-Cl.x),ty=cam.s*(Cc.y-Cl.y);
  if(k<1.3&&k*OVER*W.w/2-Math.abs(tx)>=W.w/2+2&&k*OVER*W.h/2-Math.abs(ty)>=W.h/2+2){W.svg.style.transform='translate('+tx.toFixed(2)+'px,'+ty.toFixed(2)+'px) scale('+k.toFixed(5)+')';W.sliding=true;slideT=performance.now();const zl=W.stage.querySelector('.wm-zl');if(zl)zl.textContent=R(cam.s*(W.U??30)*100)+'%';drawMiniView();if(ctxNow?.selected)ctxNow.placeSoon?.();return;}}
 commitCam();}
function commitCam(){camC={...cam};W.sliding=false;W.svg.style.transform='';const VW=W.w*OVER,VH=W.h*OVER;const C=proj({x:cam.cx,y:cam.cy}),s=cam.s,a=s*L[0],b=s*L[1],c=s*L[2],d=s*L[3],e=VW/2-s*C.x,f=VH/2-s*C.y;W.cam.setAttribute('transform','matrix('+[a,b,c,d,e,f].map(n=>+n.toFixed(6)).join(' ')+')');cull(C,s,VW,VH);
 const z=s*(W.U??30);W.svg.style.setProperty('--z',String(+z.toFixed(3)));W.svg.style.setProperty('--u',String(+(W.U??30).toFixed(2)));W.svg.classList.toggle('wm-far',z<.55);W.svg.classList.toggle('wm-mid',z<1.1);W.svg.classList.toggle('wm-near',z>=.72);const fb='fb'+labelBand(labelRoom(z,W.k??1));if(fb!==W.fb||!W.svg.classList.contains(fb)){for(const c of [...W.svg.classList])if(/^fb[0-9]+$/.test(c))W.svg.classList.remove(c);W.svg.classList.add(fb);W.fb=fb;}
 const zl=W.stage.querySelector('.wm-zl');if(zl)zl.textContent=R(z*100)+'%';W.mat={a,b,c,d,e,f};placeTags();drawMiniView();if(ctxNow?.selected)ctxNow.placeSoon?.();}
const toScreen=p=>{const m=W.mat;return {x:m.a*p.x+m.c*p.y+m.e,y:m.b*p.x+m.d*p.y+m.f};};
// Scenery blocks and sites far outside the drawn area are left out of the picture (display none) until the camera comes near.
function cull(C,s,VW,VH){const m=Math.max(VW,VH)*.25,vis=(x0,y0,x1,y1)=>!(s*(x1-C.x)+VW/2<-m||s*(x0-C.x)+VW/2>VW+m||s*(y1-C.y)+VH/2<-m||s*(y0-C.y)+VH/2>VH+m);
 for(const b of W.blks??[]){const on=vis(...b.bb);if(on!==b.on){b.on=on;if(on)b.el.removeAttribute('display');else b.el.setAttribute('display','none');}}
 for(const p of built.layout?.places??[]){if(p.kind!=='site')continue;const g=W.placeG.get(p.id);if(!g)continue;const cs=[{x:p.block.x0,y:p.block.y0},{x:p.block.x1,y:p.block.y0},{x:p.block.x1,y:p.block.y1},{x:p.block.x0,y:p.block.y1}].map(proj),t=proj(up(30000)).y,on=vis(Math.min(...cs.map(q=>q.x)),Math.min(...cs.map(q=>q.y))+t,Math.max(...cs.map(q=>q.x)),Math.max(...cs.map(q=>q.y)));if(on!==(g.getAttribute('display')!=='none')){if(on)g.removeAttribute('display');else g.setAttribute('display','none');}}}
const toWorld=(sx,sy)=>{const C=proj({x:cam.cx,y:cam.cy}),q={x:(sx-W.w/2)/cam.s+C.x,y:(sy-W.h/2)/cam.s+C.y},inv=E.inverse;return {x:inv[0]*q.x+inv[2]*q.y,y:inv[1]*q.x+inv[3]*q.y};};
const sMax=()=>6/(W?.U??30),sMin=()=>Math.min(fitScale(fitAllBox(built.layout))*.6,.2/(W?.U??30));
// Everything that matters: each place with the building and crane behind a site and the street in front where the trucks stop.
function fitAllBox(l){if(!l)return {x0:-30000,y0:-30000,x1:30000,y1:30000};let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of l.places){x0=Math.min(x0,p.ext.x0-6000);y0=Math.min(y0,p.ext.y0-(p.kind==='site'?16000:4000));x1=Math.max(x1,p.ext.x1+6000);y1=Math.max(y1,p.streetY+4000);}return {x0,y0,x1,y1,tall:18000};}
const siteBox=p=>({x0:p.ext.x0-9000,y0:p.ext.y0-17000,x1:p.ext.x1+6000,y1:p.streetY+5000,tall:20000});
function boxProj(b){const cs=[{x:b.x0,y:b.y0},{x:b.x1,y:b.y0},{x:b.x1,y:b.y1},{x:b.x0,y:b.y1}].map(proj),top=proj(up(b.tall??6000));const xs=cs.map(p=>p.x),ys=cs.map(p=>p.y);return {x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys)+top.y,y1:Math.max(...ys)};}
function fitScale(b){if(!b||!W)return .01;const q=boxProj(b);return Math.min((W.w-40)/(q.x1-q.x0),(W.h-40)/(q.y1-q.y0));}
function boxCam(b){const q=boxProj(b),C={x:(q.x0+q.x1)/2,y:(q.y0+q.y1)/2},inv=E.inverse;return {cx:inv[0]*C.x+inv[2]*C.y,cy:inv[1]*C.x+inv[3]*C.y,s:clamp(fitScale(b),W?sMin():0,W?sMax():1)};}
function fitNow(b){if(!W)return;const t=boxCam(b);cam={...t};camTarget=null;applyCam(true);}
const boxAround=(p,r,tall=6000)=>({x0:p.x-r,y0:p.y-r,x1:p.x+r,y1:p.y+r,tall});
// The director: frames the drive (the truck and where it is going), the unloading site, the loading yard, or everything.
let lastFocus=null,lastFocusT=0;
// Nothing happening: hold the last shot a few seconds (the loaded truck, the unloaded site) before pulling back to the whole district.
function directorBox(now){const l=built.layout;if(!l)return null;const f=directorFocus(now,l);if(f){lastFocus=f;lastFocusT=now;return f;}return lastFocus&&now-lastFocusT<7000?lastFocus:fitAllBox(l);}
function directorFocus(now,l){
 if(followId){const tr=trips.get(followId);if(tr?.at)return boxAround(tr.at,26000);const yp=l.places.find(p=>p.kind==='yard');const t=ctxNow?.state?.trucks?.find(x=>x.id===followId);if(t&&yp&&t.at===yp.id)return boxAround({x:yp.bay.x+yp.bay.width/2,y:yp.bay.y+yp.bay.length/2},24000);}
 const driving=[...trips.values()].filter(t=>t.driving&&t.at);if(driving.length){const tr=driving.sort((a,b)=>(b.u??0)-(a.u??0))[0],dest=l.byId.get(tr.to),end=tr.geom.P.at(-1),p=tr.at;const x0=Math.min(p.x,end[0])-16000,x1=Math.max(p.x,end[0])+16000,y0=Math.min(p.y,end[1])-18000,y1=Math.max(p.y,end[1])+14000;return {x0,y0,x1,y1,tall:dest?.kind==='site'?20000:8000};}
 const st=ctxNow?.state;const busySite=l.places.find(p=>p.kind==='site'&&(st?.tasks??[]).some(t=>t.handling===p.id));if(busySite){const e=busySite.ext;return {x0:e.x0-5000,y0:e.y0-8000,x1:e.x1+5000,y1:busySite.streetY+4000,tall:19000};}
 const yp=l.places.find(p=>p.kind==='yard');if(yp&&(st?.tasks??[]).some(t=>t.handling===yp.id&&(st.trucks??[]).some(k=>k.id===t.to))){const e=yp.ext;return {x0:e.x0-3000,y0:e.y0-3000,x1:e.x1+3000,y1:yp.streetY,tall:4000};}
 return null;}
// The director and the follow camera hold still while the shot still works (everything wanted is in view, the zoom not far off) and only then
// glide to a new framing: the picture stays put most of the time, which is what keeps a drive smooth, and the moves read as deliberate cuts.
let camGoal=null;
function shotFits(b,follow){if(!W?.mat)return false;const q=boxProj(b),C=proj({x:cam.cx,y:cam.cy}),toV=(x,y)=>({x:cam.s*(x-C.x)+W.w/2,y:cam.s*(y-C.y)+W.h/2}),a=toV(q.x0,q.y0),z=toV(q.x1,q.y1),mx=W.w*.06,my=W.h*.06,ideal=fitScale(b);return a.x>=mx&&a.y>=my&&z.x<=W.w-mx&&z.y<=W.h-my&&cam.s>=ideal*.72&&(follow||cam.s<=ideal*1.02);}
function stepCam(now,dt){if(!cam||!W)return false;if(mode==='free'&&!followId){camGoal=null;return false;}const b=directorBox(now);if(!b)return false;
 if(!camGoal){if(shotFits(b,!!followId))return false;let t=boxCam(b);if(followId&&mode==='follow'){const tr=trips.get(followId);if(tr?.at&&tr.driving){const lead=boxAround({x:tr.at.x+tr.at.hx*14000,y:tr.at.y+tr.at.hy*14000},30000);t={...boxCam(lead),s:t.s};}t.s=Math.max(t.s,Math.min(cam.s,sMax()));}camGoal=t;}
 const t=camGoal,k=dt==null?1:1-Math.exp(-dt/420),ls=Math.log(cam.s),lt=Math.log(t.s);cam={cx:cam.cx+(t.cx-cam.cx)*k,cy:cam.cy+(t.cy-cam.cy)*k,s:Math.exp(ls+(lt-ls)*k)};
 if(Math.hypot(t.cx-cam.cx,t.cy-cam.cy)*cam.s<.6&&Math.abs(lt-Math.log(cam.s))<.004){cam={...t};camGoal=null;applyCam();return false;}applyCam();return true;}
function userCam(){lastUser=performance.now();camGoal=null;if(followId){followId=null;mode='free';if(cardFor)renderCard();syncBar();}else if(mode==='director'){mode='free';syncBar();}}
function zoomAt(sx,sy,f){const before=toWorld(sx,sy);cam.s=clamp(cam.s*f,sMin(),sMax());applyCam();const after=toWorld(sx,sy);cam.cx+=before.x-after.x;cam.cy+=before.y-after.y;applyCam();saveCamSoon();}
let camSaveT=0;const saveCamSoon=()=>{clearTimeout(camSaveT);camSaveT=setTimeout(saveCam,400);};

// ---- tags in screen space: place names, trucks on the road
function syncTags(l,ctx){const st=ctx.state,out=[];
 for(const p of l.places){const stock=(st.world?.items??[]).filter(c=>c.location===p.id),pieces=stock.reduce((n,c)=>n+(c.lines??[]).reduce((m,x)=>m+x[1],0),0),e=p.ext,yard=p.kind==='yard';
  const sub=yard?(()=>{const n=(st.containers??[]).filter(c=>c.location===p.id).length;return n+' stillage'+(n===1?'':'s')+' on this page';})():(stock.length?stock.length+' stillage'+(stock.length===1?'':'s')+' · '+num(pieces)+' pcs':'No stock yet');
  const bld=yard?null:buildingOf(p,l);
  out.push({id:'p:'+p.id,world:bld?{x:bld.x+bld.w/2,y:bld.y+bld.d}:{x:(e.x0+e.x1)/2,y:e.y0-(yard?1200:2600)},z:bld?G+bld.H+2600:yard?2600:4000,text:p.name||(yard?'Yard':'Site'),sub:yard?null:sub,kind:yard?'yard':'site',site:yard?null:p.id});
  if(!yard){const by=new Map(stock.map(c=>[c.id,c])),onTop=new Set(stock.map(c=>c.support).filter(Boolean));for(const c of stock){if(onTop.has(c.id))continue;let z=c.height||1000,cur=by.get(c.support),k=0;while(cur&&k++<9){z+=cur.height||1000;cur=by.get(cur.support);}const rw=c.rotation===90?c.envelopeWidth:c.envelopeLength,rh=c.rotation===90?c.envelopeLength:c.envelopeWidth,pcs=(c.lines??[]).reduce((m,x)=>m+x[1],0);out.push({id:'s:'+c.id,world:{x:c.x+p.ox+rw/2,y:c.y+p.oy+rh/2},z:z+150,text:c.name+(k?' · '+(k+1)+' high':''),sub:null,kind:'stock',ring:c.condition==='SERVICEABLE'?(c.type==='CAGE'?STATUS_COLOURS.cage:STATUS_COLOURS.stillage):STATUS_COLOURS.damaged,pcs});}}}
 W.tagData=out;let html='';for(const t of out){if(t.kind==='stock'){const fs=10.5,h=17,w=textW(t.text,fs)+13;html+='<g class="wm-tag wm-tag-stock" data-tag="'+esc(t.id)+'"><rect x="'+R(-w/2)+'" y="'+(-h-3)+'" width="'+R(w)+'" height="'+h+'" rx="8.5" fill="#1c3a2d" stroke="'+t.ring+'" stroke-width="1.5"/><text x="0" y="'+R(-h/2-3+fs*.36)+'" text-anchor="middle" font-size="'+fs+'" fill="#fff">'+esc(t.text)+'</text></g>';continue;}const fs=13,h=fs*1.62,w=textW(t.text,fs)+fs*1.2,sfs=11,sh=sfs*1.6,sw=t.sub?textW(t.sub,sfs)+sfs*1.1:0;
  html+='<g class="wm-tag wm-tag-'+t.kind+'" data-tag="'+esc(t.id)+'"><rect x="'+R(-w/2)+'" y="'+R(-h-(t.sub?sh+2:0)-8)+'" width="'+R(w)+'" height="'+R(h)+'" rx="'+R(h/2)+'" fill="'+(t.kind==='yard'?'#1c3a2d':'#6b3f16')+'" stroke="'+(t.kind==='yard'?'#98cc2e':'#f0a81c')+'" stroke-width="1.6"/><text x="0" y="'+R(-h/2-(t.sub?sh+2:0)-8+fs*.36)+'" text-anchor="middle" font-size="'+fs+'" fill="#fff">'+esc(t.text)+'</text>'+(t.sub?'<g class="wm-tag-sub"><rect x="'+R(-sw/2)+'" y="'+R(-sh-8)+'" width="'+R(sw)+'" height="'+R(sh)+'" rx="'+R(sh/2)+'" fill="#fbfcf7" stroke="#1c3a2d" stroke-opacity=".35"/><text x="0" y="'+R(-sh/2-8+sfs*.36)+'" text-anchor="middle" font-size="'+sfs+'" fill="#24402f">'+esc(t.sub)+'</text></g>':'')+'<path d="M-5 -8L0 -1L5 -8Z" fill="'+(t.kind==='yard'?'#1c3a2d':'#6b3f16')+'"/></g>';}
 for(const tr of trips.values()){const t=tr.truck;if(!t)continue;const txt=t.name+(tr.driving?' → '+placeName(tr.to):'');html+='<g class="wm-tag wm-tag-truck'+(followId===t.id?' on':'')+(tr.driving?'':' parked')+'" data-tag="t:'+esc(t.id)+'"><rect x="'+R(-(textW(txt,11.5)+14)/2)+'" y="-26" width="'+R(textW(txt,11.5)+14)+'" height="19" rx="9.5" fill="#2b3a33" stroke="'+(truckDims(t).trim)+'" stroke-width="1.6"/><text x="0" y="-12.5" text-anchor="middle" font-size="11.5" fill="#fff">'+esc(txt)+'</text></g>';}
 if(html!==W.tagHTML){W.tagHTML=html;W.tags.innerHTML=html;W.tagEls=[...W.tags.children];}placeTags();}
function placeTags(trucksOnly){if(!W?.tagEls||!W.mat)return;let i=0;if(trucksOnly)i=(W.tagData??[]).length;else for(const t of W.tagData??[]){const n=W.tagEls[i++];if(!n)continue;const q=toScreen(at(t.world,t.z));n.setAttribute('transform','translate('+R(q.x)+' '+R(q.y)+')');}
 for(const tr of trips.values()){if(!tr.truck)continue;const n=W.tagEls[i++];if(!n)continue;if(!tr.at){n.setAttribute('transform','translate(-999 -999)');continue;}const q=toScreen(at(tr.at,G+truckDims(tr.truck).CH+500));n.setAttribute('transform','translate('+R(q.x)+' '+R(q.y)+')');}}

// ---- overview minimap: the district from above at a tiny scale, trucks as dots, the view as a box
function buildMini(l){const m=W.mini,{c0,c1,r0,r1}=l.range,b={x0:(c0)*l.pw-S,y0:(r0)*l.ph-S,x1:(c1+1)*l.pw,y1:(r1+1)*l.ph},cs=[{x:b.x0,y:b.y0},{x:b.x1,y:b.y0},{x:b.x1,y:b.y1},{x:b.x0,y:b.y1}].map(proj),xs=cs.map(p=>p.x),ys=cs.map(p=>p.y),vb=[Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)];
 W.miniVB=vb;m.setAttribute('viewBox',vb.map(R).join(' '));const mat='matrix('+[L[0],L[1],L[2],L[3],0,0].join(' ')+')';let s='<rect x="'+R(vb[0])+'" y="'+R(vb[1])+'" width="'+R(vb[2])+'" height="'+R(vb[3])+'" fill="#e9eddc"/><g transform="'+mat+'">';
 for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)s+='<rect x="'+c*l.pw+'" y="'+r*l.ph+'" width="'+l.bw+'" height="'+l.bh+'" fill="#b9c79a"/>';
 for(const p of l.places)s+='<rect class="wm-mini-'+p.kind+'" data-mini="'+esc(p.id)+'" x="'+p.ext.x0+'" y="'+p.ext.y0+'" width="'+(p.ext.x1-p.ext.x0)+'" height="'+(p.ext.y1-p.ext.y0)+'" fill="'+(p.kind==='yard'?'#d8d1c1':'#c8a574')+'" stroke="'+(p.kind==='yard'?'#2f7353':'#8a5a1c')+'" stroke-width="2500"/>';
 m.innerHTML=s+'</g><g class="wm-mini-dots"></g><rect class="wm-mini-view" fill="none" stroke="#1c3a2d" stroke-width="'+R(vb[2]/90)+'"/>';W.miniDots=m.querySelector('.wm-mini-dots');W.miniView=m.querySelector('.wm-mini-view');drawMiniView();}
function drawMiniView(){if(!W?.miniView||!cam)return;const C=proj({x:cam.cx,y:cam.cy}),w=W.w/cam.s,h=W.h/cam.s;W.miniView.setAttribute('x',R(C.x-w/2));W.miniView.setAttribute('y',R(C.y-h/2));W.miniView.setAttribute('width',R(w));W.miniView.setAttribute('height',R(h));}
function drawMiniDots(){if(!W?.miniDots||!W.miniVB)return;const r=W.miniVB[2]/70;let s='';for(const tr of trips.values())if(tr.at){const q=proj(tr.at);s+='<circle cx="'+R(q.x)+'" cy="'+R(q.y)+'" r="'+R(r)+'" fill="'+(tr.driving?'#f0a81c':'#2f7353')+'" stroke="#fff" stroke-width="'+R(r/3)+'"/>';}if(s!==W.miniS){W.miniS=s;W.miniDots.innerHTML=s;}}

// ---- the trip strip: every truck in words, with its progress on the road
function truckLine(tr,st){const t=tr.truck,cargo=tr.cargo??[],pieces=cargo.reduce((n,c)=>n+(c.lines??[]).reduce((m,x)=>m+x[1],0),0),load=cargo.length?cargo.length+' stillage'+(cargo.length===1?'':'s')+' · '+num(pieces)+' pcs':'Empty';
 if(t.status==='IN_TRANSIT')return {state:'road',title:t.name+' → '+placeName(t.destination),sub:load};
 const here=placeName(t.at),unloading=(st.tasks??[]).filter(x=>x.from===t.id).length,loading=(st.tasks??[]).filter(x=>x.to===t.id).length;
 if(unloading)return {state:'busy',title:t.name+' · unloading at '+here,sub:unloading+' to go · '+load};if(loading)return {state:'busy',title:t.name+' · loading at '+here,sub:loading+' to go · '+load};
 return {state:cargo.length?'wait':'idle',title:t.name+' · at '+here,sub:load};}
function renderStrip(ctx){if(!W)return;const st=ctx.state,list=(st.trucks??[]).filter(t=>!t.retired);let html='';
 for(const t of list){const tr=trips.get(t.id)??{truck:t,cargo:(st.world?.items??[]).filter(c=>c.location===t.id)},x=truckLine({...tr,truck:t},st);html+='<button type="button" class="wm-chip '+x.state+(followId===t.id?' on':'')+'" data-wm-follow="'+esc(t.id)+'" role="listitem"><span class="wm-chip-t">'+esc(x.title)+'</span><span class="wm-chip-s">'+esc(x.sub)+(x.state==='road'?' · <b data-eta="'+esc(t.id)+'"></b>':'')+'</span>'+(x.state==='road'?'<i class="wm-bar-p"><b data-prog="'+esc(t.id)+'"></b></i>':'')+'</button>';}
 if(!list.length)html='<p class="wm-empty">No trucks yet. Add one in Fleet.</p>';if(html!==W.stripHTML){W.stripHTML=html;W.strip.innerHTML=html;}tickStrip();}
function tickStrip(){if(!W)return;for(const tr of trips.values()){if(!tr.driving||!tr.truck)continue;const id=tr.truck.id,b=W.strip.querySelector('[data-prog="'+CSS.escape(id)+'"]'),e=W.strip.querySelector('[data-eta="'+CSS.escape(id)+'"]'),u=tr.u??0;if(b)b.style.width=(u*100).toFixed(1)+'%';if(e){const left=Math.max(0,Math.ceil((1-u)*tr.D/1000));const t=left?'arrives in '+left+' s':'arriving';if(e.textContent!==t)e.textContent=t;}}}

// ---- cards: follow a truck, or a site
function renderCard(){if(!W||!cardFor){if(W)W.card.hidden=true;return;}const st=ctxNow?.state,ops=isOps(ctxNow?.account);let html='';
 if(cardFor.kind==='truck'){const t=(st.trucks??[]).find(x=>x.id===cardFor.id);if(!t){closeCard();return;}const tr=trips.get(t.id)??{truck:t,cargo:(st.world?.items??[]).filter(c=>c.location===t.id)},x=truckLine({...tr,truck:t},st),cargo=tr.cargo??[],names=new Map((st.products??[]).map(p=>[p.id,p.name]));
  const lines=new Map();for(const c of cargo)for(const [id,q] of c.lines??[])lines.set(id,(lines.get(id)??0)+q);const top=[...lines].sort((a,b)=>b[1]-a[1]).slice(0,4);
  const at=l=>placeName(l),busy=(st.tasks??[]).some(k=>k.from===t.id||k.to===t.id),sites=(st.sites??[]).filter(s=>s.status==='ACTIVE'&&s.id!==t.at);
  let acts='';if(ops&&t.status==='AT_SITE'&&cargo.length&&!busy)acts+='<button type="button" data-wm-act="unload" data-id="'+esc(t.id)+'">Unload at '+esc(at(t.at))+'</button>';
  if(ops&&t.status==='AT_SITE'&&!busy)acts+='<button type="button" class="secondary" data-wm-act="home" data-id="'+esc(t.id)+'">Send back to yard</button>';
  if(ops&&t.status==='AT_YARD'&&!busy&&sites.length)acts+='<span class="wm-send"><select data-wm-dest="'+esc(t.id)+'" aria-label="Destination for '+esc(t.name)+'">'+sites.map(s=>'<option value="'+esc(s.id)+'"'+(s.id===t.destination?' selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select><button type="button" data-wm-act="send" data-id="'+esc(t.id)+'">Send</button></span>';
  html='<div class="wm-card-head"><span class="wm-card-kicker">'+(t.status==='IN_TRANSIT'?'ON THE ROAD':t.status==='AT_SITE'?'AT SITE':'AT THE YARD')+'</span><button type="button" class="wm-x" data-wm="close" aria-label="Close">&times;</button></div><h3>'+esc(t.name)+'</h3>'
   +(t.status==='IN_TRANSIT'?'<p class="wm-route"><span>'+esc(at(t.at))+'</span><i aria-hidden="true">→</i><span>'+esc(at(t.destination))+'</span></p><i class="wm-bar-p big"><b data-prog="'+esc(t.id)+'"></b></i><p class="wm-eta" data-eta-card="'+esc(t.id)+'"></p>':'<p class="wm-route"><span>'+esc(x.title.split(' · ').slice(1).join(' · ')||at(t.at))+'</span></p>')
   +'<p class="wm-load"><b>'+(cargo.length?cargo.length+' stillage'+(cargo.length===1?'':'s'):'No load')+'</b>'+(cargo.length?' &middot; '+num([...lines.values()].reduce((a,b)=>a+b,0))+' pieces':'')+'</p>'+(top.length?'<ul class="wm-lines">'+top.map(([id,q])=>'<li><span>'+esc(names.get(id)??'Material')+'</span><b>'+num(q)+'</b></li>').join('')+'</ul>':'')
   +(acts?'<div class="wm-acts">'+acts+'</div>':'')+'<div class="wm-acts"><button type="button" class="secondary" data-wm="follow" aria-pressed="'+(followId===t.id)+'">'+(followId===t.id?'Stop following':'Follow')+'</button><button type="button" class="secondary" data-wm-go="truck" data-id="'+esc(t.id)+'">Truck page</button></div>';}
 else{const p=built.layout?.byId.get(cardFor.id),s=(st.sites??[]).find(x=>x.id===cardFor.id);if(!p||!s){closeCard();return;}const stock=(st.world?.items??[]).filter(c=>c.location===s.id),names=new Map((st.products??[]).map(q=>[q.id,q.name])),lines=new Map();for(const c of stock)for(const [id,q] of c.lines??[])lines.set(id,(lines.get(id)??0)+q);const top=[...lines].sort((a,b)=>b[1]-a[1]).slice(0,5);
  const crew=(st.resources??[]).filter(r=>r.location===s.id),cr=crew.filter(r=>r.type==='CRANE').length,wk=crew.filter(r=>r.type==='WORKER').length,here=(st.trucks??[]).filter(t=>t.at===s.id&&t.status==='AT_SITE'),coming=(st.trucks??[]).filter(t=>t.status==='IN_TRANSIT'&&t.destination===s.id),blocked=(st.tasks??[]).find(t=>t.handling===s.id&&t.state==='BLOCKED');
  html='<div class="wm-card-head"><span class="wm-card-kicker">SITE</span><button type="button" class="wm-x" data-wm="close" aria-label="Close">&times;</button></div><h3>'+esc(s.name)+'</h3><p class="wm-addr">'+esc(s.address??'')+(s.client?' &middot; '+esc(s.client):'')+'</p>'
   +'<p class="wm-load"><b>'+(stock.length?stock.length+' stillage'+(stock.length===1?'':'s')+' on site':'Nothing on site yet')+'</b>'+(stock.length?' &middot; '+num([...lines.values()].reduce((a,b)=>a+b,0))+' pieces':'')+'</p>'+(top.length?'<ul class="wm-lines">'+top.map(([id,q])=>'<li><span>'+esc(names.get(id)??'Material')+'</span><b>'+num(q)+'</b></li>').join('')+'</ul>':'')
   +'<p class="wm-crewline">'+(cr?cr+' crane':'No crane')+' &middot; '+wk+' worker'+(wk===1?'':'s')+(here.length?' &middot; '+here.map(t=>esc(t.name)).join(', ')+' here':'')+(coming.length?' &middot; '+coming.map(t=>esc(t.name)).join(', ')+' on the way':'')+'</p>'+(blocked?'<p class="wm-warn">Unloading is blocked: '+esc(blocked.reason??'see Movement activity')+'</p>':!cr?'<p class="wm-warn">Unloading here needs a crane and a worker. Set them up under Yard &rarr; Configure workers &amp; equipment.</p>':'')
   +(isOps(ctxNow?.account)&&here.some(t=>(st.world?.items??[]).some(c=>c.location===t.id))&&!(st.tasks??[]).some(t=>t.handling===s.id)?'<div class="wm-acts">'+here.filter(t=>(st.world?.items??[]).some(c=>c.location===t.id)).map(t=>'<button type="button" data-wm-act="unload" data-id="'+esc(t.id)+'">Unload '+esc(t.name)+'</button>').join('')+'</div>':'')
   +(arrange&&isOps(ctxNow?.account)?'<div class="wm-move" aria-label="Move this site on the map"><span>Move on the map</span><button type="button" class="secondary" data-wm-move="-1,0" aria-label="Move up-left">&#8598;</button><button type="button" class="secondary" data-wm-move="0,-1" aria-label="Move up-right">&#8599;</button><button type="button" class="secondary" data-wm-move="0,1" aria-label="Move down-left">&#8601;</button><button type="button" class="secondary" data-wm-move="1,0" aria-label="Move down-right">&#8600;</button></div>':'')
   +'<div class="wm-acts"><button type="button" class="secondary" data-wm-go="site" data-id="'+esc(s.id)+'">Open on the Sites page</button></div>';}
 if(html!==W.cardHTML){W.cardHTML=html;W.card.innerHTML=html;}W.card.hidden=false;tickStrip();tickCard();}
function tickCard(){if(!W||cardFor?.kind!=='truck')return;const tr=trips.get(cardFor.id);if(!tr?.driving)return;const b=W.card.querySelector('[data-prog]'),e=W.card.querySelector('[data-eta-card]'),u=tr.u??0;if(b)b.style.width=(u*100).toFixed(1)+'%';if(e){const left=Math.max(0,Math.ceil((1-u)*tr.D/1000)),t=R(u*100)+'% of the way · '+(left?'arrives in '+left+' s':'arriving now');if(e.textContent!==t)e.textContent=t;}}
function openCard(kind,id){if(mode!=='follow')W.prevMode=mode;cardFor={kind,id};if(kind==='truck'){followId=id;mode='follow';}else{followId=null;if(mode==='follow')mode=W.prevMode??'free';const p=built.layout?.byId.get(id);if(p&&!arrange){if(mode==='director'){mode='free';}animateTo(boxCam(siteBox(p)));}}renderCard();syncBar();kick();}
function closeCard(){cardFor=null;if(followId){followId=null;if(mode==='follow')mode=W?.prevMode??'director';}if(W){W.card.hidden=true;W.cardHTML='';}syncBar();kick();}
function syncBar(){if(!W)return;const d=W.stage.querySelector('.wm-director');d.setAttribute('aria-pressed',String(mode==='director'));d.classList.toggle('on',mode==='director');const a=W.stage.querySelector('.wm-arrange');a.setAttribute('aria-pressed',String(arrange));a.classList.toggle('on',arrange);a.textContent=arrange?'Done arranging':'Arrange map';W.stage.classList.toggle('arranging',arrange);
 W.note.hidden=!arrange;if(arrange)W.note.textContent='Drag a site onto an empty block to move it. Trucks already on the road keep their road.';}

// ---- input
function bindStage(){const svg=W.svg,pts=new Map();let gesture=null;
 const local=e=>{const r=W.rect??W.view.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
 // Capture phase on the svg: the plan's own wheel and drag handlers (Yard page view) never see these events, so the Yard view is untouched.
 svg.addEventListener('wheel',e=>{e.preventDefault();e.stopPropagation();W.rect=W.view.getBoundingClientRect();const p=local(e);userCam();zoomAt(p.x,p.y,e.deltaY<0?1.15:1/1.15);},{passive:false,capture:true});
 svg.addEventListener('pointerdown',e=>{if(e.button!==0&&e.pointerType==='mouse')return;const special=ctxNow&&(ctxNow.layoutDraft||ctxNow.workerMoveMode==='PLACE');if(special)return;W.rect=W.view.getBoundingClientRect();pts.set(e.pointerId,local(e));W.gesture=true;
  const siteG=arrange&&e.target.closest?.('[data-wm-site]');if(siteG&&pts.size===1){gesture={kind:'site',id:siteG.dataset.wmSite,start:local(e),moved:false};}
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
 svg.addEventListener('click',e=>{if(W.suppress&&performance.now()-W.suppress<300){e.stopPropagation();e.preventDefault();return;}if(e.target.closest('[data-select],[data-worker],[data-forklift]'))return;if(ctxNow?.workerMoveMode||ctxNow?.layoutDraft)return;
  const t=e.target.closest('[data-wm-truck]');if(t){e.stopPropagation();openCard('truck',t.dataset.wmTruck);return;}const s=e.target.closest('[data-wm-site]');if(s){e.stopPropagation();openCard('site',s.dataset.wmSite);}},{capture:true});
 svg.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const t=e.target.closest?.('[data-wm-truck]'),s=e.target.closest?.('[data-wm-site]');if(t){e.preventDefault();openCard('truck',t.dataset.wmTruck);}else if(s&&!e.target.closest('[data-select]')){e.preventDefault();openCard('site',s.dataset.wmSite);}});
 W.stage.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||!W.stage.contains(b)||b.closest('svg'))return;const k=b.dataset.wm;
  if(k==='director'){mode=mode==='director'?'free':'director';followId=null;if(cardFor?.kind==='truck')closeCard();syncBar();saveCam();kick();}
  else if(k==='fit'){userCam();followId=null;const t=boxCam(fitAllBox(built.layout));animateTo(t);}
  else if(k==='yard'){userCam();followId=null;const yp=built.layout?.places.find(p=>p.kind==='yard');if(yp)animateTo(boxCam({x0:yp.ext.x0-3000,y0:yp.ext.y0-3000,x1:yp.ext.x1+3000,y1:yp.streetY,tall:4000}));}
  else if(k==='in'||k==='out'){userCam();zoomAt(W.w/2,W.h/2,k==='in'?1.3:1/1.3);}
  else if(k==='arrange'){arrange=!arrange;if(arrange){mode='free';followId=null;}syncBar();if(cardFor?.kind==='site')renderCard();}
  else if(k==='close')closeCard();
  else if(k==='follow'){if(followId){followId=null;mode='free';}else if(cardFor?.kind==='truck'){followId=cardFor.id;mode='follow';}renderCard();syncBar();kick();}
  else if(b.dataset.wmFollow){if(followId===b.dataset.wmFollow)closeCard();else openCard('truck',b.dataset.wmFollow);}
  else if(b.dataset.wmGo){ctxNow?.go?.(b.dataset.wmGo,b.dataset.id);}
  else if(b.dataset.wmMove&&cardFor?.kind==='site'){const [dc,dr]=b.dataset.wmMove.split(',').map(Number),p=built.layout.byId.get(cardFor.id);placeSite(p.id,p.col+dc,p.row+dr);}
  else if(b.dataset.wmAct){const id=b.dataset.id,t=ctxNow.state.trucks.find(x=>x.id===id);b.disabled=true;try{let r;if(b.dataset.wmAct==='unload')r=await ctxNow.cmd('unload',{id});else if(b.dataset.wmAct==='home')r=await ctxNow.cmd('dispatch',{id,destination:t.yard});else if(b.dataset.wmAct==='send'){const dest=W.card.querySelector('[data-wm-dest="'+CSS.escape(id)+'"]')?.value;r=await ctxNow.cmd('dispatch',{id,destination:dest});}
    ctxNow.notify?.(b.dataset.wmAct==='unload'?'Unloading '+t.name+': the crew and crane will lift it off.':t.name+' is on the road.');followId=id;mode='follow';await ctxNow.refresh?.();}catch(err){ctxNow.notify?.(err.message);}finally{b.disabled=false;}}});
 W.mini.addEventListener('click',e=>{if(!W.miniVB)return;const r=W.mini.getBoundingClientRect(),vb=W.miniVB,k=Math.max(vb[2]/r.width,vb[3]/r.height),ox=(r.width*k-vb[2])/2,oy=(r.height*k-vb[3])/2,q={x:vb[0]+(e.clientX-r.left)*k-ox,y:vb[1]+(e.clientY-r.top)*k-oy},inv=E.inverse;userCam();followId=null;animateTo({cx:inv[0]*q.x+inv[2]*q.y,cy:inv[1]*q.x+inv[3]*q.y,s:cam.s});});}
function animateTo(t){camTarget=t;kick();}
function drawGhost(id,lot){const l=built.layout,taken=l.places.find(p=>p.id!==id&&p.col===lot.c&&p.row===lot.r),x=lot.c*l.pw,y=lot.r*l.ph;W.ghost.innerHTML='<rect x="'+x+'" y="'+y+'" width="'+l.bw+'" height="'+l.bh+'" transform="translate('+R(LOW.x)+' '+R(LOW.y)+')" fill="'+(taken?'#bd4636':'#98cc2e')+'" fill-opacity=".28" stroke="'+(taken?'#bd4636':'#2f7353')+'" stroke-width="700" stroke-dasharray="2400 1400"/>';}
const clearGhost=()=>{if(W?.ghost)W.ghost.innerHTML='';};
async function placeSite(id,col,row){const p=built.layout?.byId.get(id);if(!p||!ctxNow)return;try{const r=await ctxNow.cmd('worldPlace',{id,col,row});ctxNow.notify?.(r.message??'Moved.');await ctxNow.refresh?.();}catch(err){ctxNow.notify?.(err.message);}}

// ---- the frame loop: only while something moves, never while the tab is hidden or the stage is off the page
function kick(){if(typeof requestAnimationFrame!=='function'||raf||!W)return;lastT=0;raf=requestAnimationFrame(frame);}
function frame(t){raf=0;if(!W||!W.stage.isConnected||document.hidden||W.onScreen===false){return;}const t0=performance.now();const dt=lastT?Math.min(100,t-lastT):null;lastT=t;const now=performance.now();let busy=false;
 const lifted=new Set();for(const c of cranes.values()){const id=stepCrane(c,now,dt);if(id)lifted.add(id);if(c.moving)busy=true;}
 for(const tr of trips.values()){if(!tr.truck)continue;const pose=tripPose(tr,now,dt);if(!pose)continue;placeTruck(tr,pose,lifted);if(tr.driving&&(tr.u??0)<1)busy=true;}
 if(camTarget){const k=dt==null?1:1-Math.exp(-dt/220),ls=Math.log(cam.s),lt=Math.log(camTarget.s);cam={cx:cam.cx+(camTarget.cx-cam.cx)*k,cy:cam.cy+(camTarget.cy-cam.cy)*k,s:Math.exp(ls+(lt-ls)*k)};applyCam();if(Math.hypot(camTarget.cx-cam.cx,camTarget.cy-cam.cy)*cam.s<.5&&Math.abs(lt-ls)<.002){cam={...camTarget};camTarget=null;applyCam();saveCam();}else busy=true;}
 else if(stepCam(now,dt))busy=true;
 if(W.sliding){if(performance.now()-slideT>200&&!W.gesture)commitCam();else busy=true;}
 placeTags(true);drawMiniDots();tickStrip();tickCard();measure('wm-frame',t0);
 if(busy||[...trips.values()].some(t=>t.driving))raf=requestAnimationFrame(frame);}
// operations.js applyView on Home: the world camera, not the yard view; a selected yard stillage off screen brings the camera to the yard.
export function wmApplyView(selectedId){if(!W||!W.stage.isConnected)return false;if(selectedId){const el=W.svg.querySelector('[data-select="'+CSS.escape(selectedId)+'"]');const yp=built.layout?.places.find(p=>p.kind==='yard');if(el&&yp){const r=el.getBoundingClientRect(),v=W.view.getBoundingClientRect();if(r.right<v.left||r.left>v.right||r.bottom<v.top||r.top>v.bottom){userCam();fitNow({x0:yp.ext.x0-2000,y0:yp.ext.y0-2000,x1:yp.ext.x1+2000,y1:yp.ext.y1+2000,tall:4000});}}}applyCam();return true;}
export function wmStop(){if(raf&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(raf);raf=0;}
// Tests and measurements.
export const __wm={layout:wmLayout,signal:wmSignal,staticSVG:wmStatic,siteSVG:wmSiteSVG,headingKey,truckArtAt,state:()=>({cam,mode,followId,arrange,trips,cranes,W,live}),reset(){W=null;cam=null;mode='director';followId=null;arrange=false;trips.clear();cranes.clear();built.sig=null;built.yard=null;built.sites=new Map();live={key:null,v:0,yard:'',sites:new Map(),sig:''};stateSeen=null;cardFor=null;}};
