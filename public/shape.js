// Pure, dependency-free geometry shared by the browser (shape editor, planner) and the server (src/domain/geometry.js re-exports it).
// Units: millimetres, y grows downward (screen / plan coordinates). Never import anything here.
export const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
export const on=(a,b,p)=>Math.abs(cross(a,b,p))<0.01&&p.x>=Math.min(a.x,b.x)-0.01&&p.x<=Math.max(a.x,b.x)+0.01&&p.y>=Math.min(a.y,b.y)-0.01&&p.y<=Math.max(a.y,b.y)+0.01;
export function intersects(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);return x*y<0&&z*w<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);}
export function inside(p,poly){let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(on(a,b,p))return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)result=!result;}return result;}
export const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
export const contains=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.w<=outer.x+outer.w&&inner.y+inner.h<=outer.y+outer.h;
export function fitsPolygon(r,poly){const corners=[{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}];if(!corners.every(p=>inside(p,poly)))return false;for(let i=0;i<4;i++){const a=corners[i],b=corners[(i+1)%4];for(let j=0;j<poly.length;j++){const c=poly[j],d=poly[(j+1)%poly.length];if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return false;}}return inside({x:r.x+r.w/2,y:r.y+r.h/2},poly);}
export const ringArea=pts=>Math.abs(pts.reduce((s,a,i)=>{const b=pts[(i+1)%pts.length];return s+a.x*b.y-b.x*a.y;},0))/2;

// Every problem with a closed ring of corners, in the order the server reports them (the first one is the server's message).
// Sides are numbered from 1: side i runs from corner i to corner i+1; the last side runs back to corner 1.
export function ringProblems(pts){
  const out=[];if(pts.length<3)return [{code:'CORNERS',message:'A boundary needs at least 3 corners.',sides:[],corners:[]}];
  const n=pts.length;
  for(let i=0;i<n;i++){const a=pts[i],b=pts[(i+1)%n];
    if(!(Math.hypot(b.x-a.x,b.y-a.y)>1))out.push({code:'SHORT',message:'Side '+(i+1)+' has no length: corners '+(i+1)+' and '+((i+1)%n+1)+' are in the same place.',sides:[i],corners:[(i+1)%n]});
    for(let j=i+1;j<n;j++){if(j===i+1||i===0&&j===n-1)continue;if(intersects(a,b,pts[j],pts[(j+1)%n]))out.push({code:'CROSS',message:'Sides '+(i+1)+' and '+(j+1)+' cross or touch each other.',sides:[i,j],corners:[]});}
    const prev=pts[(i+n-1)%n];if(Math.abs(cross(prev,a,b))<0.01&&((prev.x-a.x)*(b.x-a.x)+(prev.y-a.y)*(b.y-a.y))>0)out.push({code:'SPIKE',message:'The boundary folds back on itself at corner '+(i+1)+'.',sides:[(i+n-1)%n,i],corners:[i]});
    if(out.length>=20)return out;}
  if(!(ringArea(pts)>1))out.push({code:'AREA',message:'The boundary has no area.',sides:[],corners:[]});
  return out;
}
// Structural check of corners sent by a client. keep = stored corners that may be sent back unchanged even when not whole millimetres.
// Returns {points} or {problem:{status,message}}; drops a trailing repeat of the first corner.
export function cleanCorners(input,keep=[]){
  const max=Math.max(100,keep.length);
  if(!Array.isArray(input)||input.length<3||input.length>max+1)return {problem:{status:409,message:'A boundary needs between 3 and 100 corners.'}};
  const pts=[];for(let i=0;i<input.length;i++){const p=input[i];if(!p||typeof p!=='object')return {problem:{status:400,message:'Corner '+(i+1)+' is missing.'}};
    if(keep.some(k=>k.x===p.x&&k.y===p.y)){pts.push({x:p.x,y:p.y});continue;}
    for(const axis of ['x','y'])if(!Number.isSafeInteger(p[axis])||p[axis]<-1000000||p[axis]>1000000)return {problem:{status:400,message:'Corner '+(i+1)+' '+axis.toUpperCase()+' must be a whole number of millimetres between -1000000 and 1000000.'}};
    pts.push({x:p.x,y:p.y});}
  if(pts.length>3&&pts[0].x===pts.at(-1).x&&pts[0].y===pts.at(-1).y)pts.pop();
  if(pts.length>max)return {problem:{status:409,message:'A boundary needs between 3 and 100 corners.'}};
  return {points:pts};
}

// ---- stillage footprints and quarter turns ----
export function footprint(c,p=c){const r=(p.rotation??0)===90,L=c.envelopeLength??c.length,W=c.envelopeWidth??c.width;return {x:p.x,y:p.y,w:r?W:L,h:r?L:W};}
export const TURN_ANCHORS=['CENTRE','TL','TR','BL','BR'];
// Where a quarter turn puts the stillage. CENTRE keeps its middle (within 0.5 mm, exact over a round trip); TL/TR/BL/BR keep that corner.
export function turnSpot(c,from,anchor='CENTRE'){const r=footprint(c,from),to=(from.rotation??0)===90?0:90,t=footprint(c,{x:0,y:0,rotation:to}),dx=r.w-t.w,dy=r.h-t.h,k=v=>Math.trunc(v/2);const [ox,oy]={CENTRE:[k(dx),k(dy)],TL:[0,0],TR:[dx,0],BL:[0,dy],BR:[dx,dy]}[anchor];return {x:from.x+ox,y:from.y+oy,rotation:to};}
// The circle the load sweeps while the forklift turns it and moves its middle from the old to the new spot in a straight line.
export const turnSweep=(c,from,to)=>sweepOf(footprint(c,from),footprint(c,to));
export const circleBox=d=>({x:d.x-d.r,y:d.y-d.r,w:2*d.r,h:2*d.r});
// True when a rectangle reaches more than 1 mm into the circle (just touching is allowed).
export function circleHits(d,o){const px=Math.max(o.x,Math.min(d.x,o.x+o.w)),py=Math.max(o.y,Math.min(d.y,o.y+o.h));return Math.hypot(px-d.x,py-d.y)<d.r-1;}
// Rigid quarter turn of a whole pile: members keep their offsets relative to the base (clockwise 0->90, the exact inverse 90->0).
export function pileTurn(base,members,to){const R=footprint(base),cw=(base.rotation??0)===0;return members.map(m=>{if(m.id===base.id)return {container:m.id,x:to.x,y:to.y,rotation:to.rotation,support:m.support??null};const r=footprint(m),ox=r.x-R.x,oy=r.y-R.y;const [lx,ly]=cw?[R.h-oy-r.h,ox]:[oy,R.w-ox-r.w];return {container:m.id,x:to.x+lx,y:to.y+ly,rotation:90-(m.rotation??0),support:m.support??null};});}
// The circle swept between two footprints of the same load (old and new spot of a turn).
export function sweepOf(a,b){const ca={x:a.x+a.w/2,y:a.y+a.h/2},cb={x:b.x+b.w/2,y:b.y+b.h/2};return {x:(ca.x+cb.x)/2,y:(ca.y+cb.y)/2,r:Math.hypot(a.w,a.h)/2+Math.hypot(cb.x-ca.x,cb.y-ca.y)/2};}

// ---- shape editor helpers (browser); every function returns new arrays and rounds anything it creates to whole millimetres ----
export const bbox=pts=>{const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);return {x0:Math.min(...xs),y0:Math.min(...ys),x1:Math.max(...xs),y1:Math.max(...ys)};};
const R=Math.round;
// Clockwise on screen (y down), starting at the top-most, then left-most corner, so side 1 is the top edge running right.
export function normalise(pts){let p=pts.map(q=>({x:q.x,y:q.y}));if(pts.reduce((s,a,i)=>{const b=pts[(i+1)%pts.length];return s+a.x*b.y-b.x*a.y;},0)<0)p.reverse();let s=0;for(let i=1;i<p.length;i++)if(p[i].y<p[s].y||p[i].y===p[s].y&&p[i].x<p[s].x)s=i;return [...p.slice(s),...p.slice(0,s)];}
export const axisAligned=pts=>pts.every((a,i)=>{const b=pts[(i+1)%pts.length];return a.x===b.x||a.y===b.y;});
export function rectangle(w,d,anchor,box){const L=anchor==='TR'||anchor==='BR'?box.x1-w:box.x0,T=anchor==='BL'||anchor==='BR'?box.y1-d:box.y0;return [{x:L,y:T},{x:L+w,y:T},{x:L+w,y:T+d},{x:L,y:T+d}];}
export function lShape(w,d,cw,cd,corner,box){const L=box.x0,T=box.y0,Rt=L+w,B=T+d;return {TR:[{x:L,y:T},{x:Rt-cw,y:T},{x:Rt-cw,y:T+cd},{x:Rt,y:T+cd},{x:Rt,y:B},{x:L,y:B}],BR:[{x:L,y:T},{x:Rt,y:T},{x:Rt,y:B-cd},{x:Rt-cw,y:B-cd},{x:Rt-cw,y:B},{x:L,y:B}],BL:[{x:L,y:T},{x:Rt,y:T},{x:Rt,y:B},{x:L+cw,y:B},{x:L+cw,y:B-cd},{x:L,y:B-cd}],TL:[{x:L+cw,y:T},{x:Rt,y:T},{x:Rt,y:B},{x:L,y:B},{x:L,y:T+cd},{x:L+cw,y:T+cd}]}[corner];}
// RECT {w,d} when 4 square corners; L {w,d,cutW,cutD,cutCorner} when 6 square corners forming an L; otherwise CUSTOM.
export function detectPreset(points){const p=normalise(points),b=bbox(p),w=b.x1-b.x0,d=b.y1-b.y0;if(!axisAligned(p))return {preset:'CUSTOM'};
  if(p.length===4)return {preset:'RECT',w,d};
  if(p.length===6){const corners={TL:{x:b.x0,y:b.y0},TR:{x:b.x1,y:b.y0},BL:{x:b.x0,y:b.y1},BR:{x:b.x1,y:b.y1}};const missing=Object.keys(corners).filter(k=>!p.some(q=>q.x===corners[k].x&&q.y===corners[k].y));const inner=p.find(q=>q.x!==b.x0&&q.x!==b.x1&&q.y!==b.y0&&q.y!==b.y1);
    if(missing.length===1&&inner){const k=missing[0],cutW=Math.abs(corners[k].x-inner.x),cutD=Math.abs(corners[k].y-inner.y);const again=normalise(lShape(w,d,cutW,cutD,k,b));if(again.every((q,i)=>q.x===p[i].x&&q.y===p[i].y))return {preset:'L',w,d,cutW,cutD,cutCorner:k};}}
  return {preset:'CUSTOM'};}
const ARROWS=['→','↘','↓','↙','←','↖','↑','↗'];
export function sides(pts){return pts.map((a,i)=>{const b=pts[(i+1)%pts.length],dx=b.x-a.x,dy=b.y-a.y,t=Math.atan2(dy,dx)/(Math.PI/4),k=Math.round(t),slanted=Math.abs(t-k)*45>1;return {i,from:i,to:(i+1)%pts.length,length:Math.hypot(dx,dy),arrow:slanted?null:ARROWS[((k%8)+8)%8],slanted,degrees:Math.round(((Math.atan2(dy,dx)*180/Math.PI)+360)%360)};});}
// A shape the owner should be offered to square up: not RECT/L, and the corners' bounding box is what he probably meant.
export function slantedSides(pts){return sides(pts).filter(s=>s.slanted);}
// Side i gets a new length: its end corner and the corner after it slide along side i, so the next side keeps its angle and length.
export function setSideLength(pts,i,mm){const n=pts.length,a=pts[i],b=pts[(i+1)%n],len=Math.hypot(b.x-a.x,b.y-a.y);if(!len)return pts;const dx=R((b.x-a.x)/len*(mm-len)),dy=R((b.y-a.y)/len*(mm-len));return pts.map((p,k)=>k===(i+1)%n||k===(i+2)%n?{x:p.x+dx,y:p.y+dy}:p);}
// Side i moves square to itself by d mm (positive = outward); its two corners move, the neighbouring sides stretch.
export function pushSide(pts,i,d){const n=pts.length,a=pts[i],b=pts[(i+1)%n],len=Math.hypot(b.x-a.x,b.y-a.y);if(!len)return pts;const nx=(b.y-a.y)/len,ny=-(b.x-a.x)/len,dx=R(nx*d),dy=R(ny*d);return pts.map((p,k)=>k===i||k===(i+1)%n?{x:p.x+dx,y:p.y+dy}:p);}
// Corner i moves to p. square: a neighbouring side that was horizontal/vertical stays so (rectangles resize from that corner).
export function moveCorner(pts,i,p,square=true){const n=pts.length,old=pts[i],out=pts.map(q=>({...q}));if(square)for(const k of [(i+n-1)%n,(i+1)%n]){if(out[k].y===old.y&&out[k].x!==old.x)out[k].y=p.y;else if(out[k].x===old.x&&out[k].y!==old.y)out[k].x=p.x;}out[i]={x:p.x,y:p.y};return out;}
export const splitSide=(pts,i)=>{const n=pts.length,a=pts[i],b=pts[(i+1)%n];return [...pts.slice(0,i+1),{x:R((a.x+b.x)/2),y:R((a.y+b.y)/2)},...pts.slice(i+1)];};
export const removeCorner=(pts,i)=>pts.length>3?pts.filter((_,k)=>k!==i):pts;
// Which stored stillages a boundary save would move (mirrors inventory.js reshape): outside, on the loading zone, on a fixture, over height; plus everything stacked on them.
export function affected(points,containers,loading,fixtures,height){const zone={x:loading.x,y:loading.y,w:2000,h:1500},byId=new Map(containers.map(c=>[c.id,c]));const stack=c=>{let h=c.height,cur=c,n=0;while(cur?.support&&n++<9){cur=byId.get(cur.support);h+=cur?.height??0;}return h;};
  const why=new Map();for(const c of containers){const r=c.w!==undefined?{x:c.x,y:c.y,w:c.w,h:c.h}:footprint(c);const w=!fitsPolygon(r,points)?'outside':overlap(r,zone)?'loading':fixtures.some(f=>overlap(r,f))?'fixture':c.support&&stack(c)>height?'height':null;if(w)why.set(c.id,w);}
  let grew=true;while(grew){grew=false;for(const c of containers)if(c.support&&why.has(c.support)&&!why.has(c.id)){why.set(c.id,'pile');grew=true;}}return why;}
// First clear w × h spot inside points on a 500 mm grid, avoiding the given rectangles.
export function freeSpot(points,w,h,taken){const b=bbox(points);for(let y=Math.ceil(b.y0/500)*500;y<b.y1;y+=500)for(let x=Math.ceil(b.x0/500)*500;x<b.x1;x+=500){const r={x,y,w,h};if(fitsPolygon(r,points)&&!taken.some(t=>overlap(r,t)))return {x,y};}return null;}
// Same closed boundary: same corners in the same cyclic order, either direction, from any starting corner.
export function sameRing(a,b){const n=a.length;if(!b||n!==b.length)return false;const eq=(p,q)=>p.x===q.x&&p.y===q.y;for(let k=0;k<n;k++){if(!eq(a[0],b[k]))continue;if(a.every((p,i)=>eq(p,b[(k+i)%n]))||a.every((p,i)=>eq(p,b[(k-i+n)%n])))return true;}return false;}

// Corners in the middle of a straight side (an 'Add corner' that was never moved) do not change the ground.
export function simplifyRing(pts){let p=pts.map(q=>({x:q.x,y:q.y})),again=true;while(again&&p.length>3){again=false;for(let i=0;i<p.length;i++){const a=p[(i+p.length-1)%p.length],b=p[i],c=p[(i+1)%p.length];if(Math.abs(cross(a,b,c))<0.01&&((a.x-b.x)*(c.x-b.x)+(a.y-b.y)*(c.y-b.y))<0){p.splice(i,1);again=true;break;}}}return p;}
export const sameGround=(a,b)=>sameRing(simplifyRing(a),simplifyRing(b??[]));
// Where a 2 m x 1.5 m loading zone or gate can go: the preferred spots first, then the nearest spot to 'near' on a 500 mm lattice
// (at most ~40,000 candidates on very large yards). Shared by the server (reshape fitPoint, new yards) and the editor (instant check).
export function freeZone(points,avoid=[],prefer=[],near=null){const box=p=>({x:p.x,y:p.y,w:2000,h:1500}),ok=p=>fitsPolygon(box(p),points)&&!avoid.some(o=>overlap(box(p),o));for(const p of prefer)if(ok(p))return {x:p.x,y:p.y};
  const b=bbox(points),o=near??{x:Math.ceil(b.x0)+500,y:Math.ceil(b.y0)+500},step=Math.max(500,Math.ceil(Math.max(b.x1-b.x0,b.y1-b.y0)/200/500)*500),out=[];
  for(let y=o.y-Math.ceil((o.y-b.y0)/step)*step;y<b.y1;y+=step)for(let x=o.x-Math.ceil((o.x-b.x0)/step)*step;x<b.x1;x+=step)out.push({x,y,d:Math.hypot(x-o.x,y-o.y)});
  out.sort((p,q)=>p.d-q.d||p.y-q.y||p.x-q.x);for(const p of out)if(ok(p))return {x:p.x,y:p.y};return null;}
// True when ring 'inner' lies entirely inside ring 'outer' (touching the fence or sharing sides is allowed): every inner corner is inside or
// on outer, no inner side properly crosses an outer side, and each piece of an inner side between outer corners it touches runs inside.
export function ringInside(inner,outer){if(!Array.isArray(inner)||!Array.isArray(outer)||inner.length<3||outer.length<3)return false;if(!inner.every(p=>inside(p,outer)))return false;
  const n=inner.length,m=outer.length;for(let i=0;i<n;i++){const a=inner[i],b=inner[(i+1)%n],ts=[0,1];
    for(let j=0;j<m;j++){const c=outer[j],d=outer[(j+1)%m];if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return false;if(on(a,b,c)){const L=(b.x-a.x)**2+(b.y-a.y)**2;if(L)ts.push(((c.x-a.x)*(b.x-a.x)+(c.y-a.y)*(b.y-a.y))/L);}}
    ts.sort((p,q)=>p-q);for(let k=1;k<ts.length;k++){if(ts[k]-ts[k-1]<1e-9)continue;const t=(ts[k]+ts[k-1])/2;if(!inside({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},outer))return false;}}
  return true;}
