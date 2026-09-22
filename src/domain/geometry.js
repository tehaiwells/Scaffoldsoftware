import { AppError } from '../service.js';
export const requireRule=(ok,message)=>{if(!ok)throw new AppError(409,message);};
export function integer(value,label,min=0,max=1000000000){if(!Number.isSafeInteger(value)||value<min||value>max)throw new AppError(400,`${label} must be a whole number between ${min} and ${max}.`);return value;}
const directions={RIGHT:[1,0],LEFT:[-1,0],UP:[0,-1],DOWN:[0,1],NE:[1,-1],SE:[1,1],SW:[-1,1],NW:[-1,-1]};
export function vertices(segments){requireRule(Array.isArray(segments)&&segments.length<=100,'Use at most 100 boundary segments.');const points=[{x:0,y:0}];for(const s of segments){const d=directions[s.direction];requireRule(d,'Choose a direction.');integer(s.length,'Segment length',1,1000000);const scale=Math.hypot(...d),p=points.at(-1);points.push({x:p.x+d[0]*s.length/scale,y:p.y+d[1]*s.length/scale});}return points;}
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const on=(a,b,p)=>Math.abs(cross(a,b,p))<0.01&&p.x>=Math.min(a.x,b.x)-0.01&&p.x<=Math.max(a.x,b.x)+0.01&&p.y>=Math.min(a.y,b.y)-0.01&&p.y<=Math.max(a.y,b.y)+0.01;
export function intersects(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);return x*y<0&&z*w<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);}
export function polygon(segments,close){const pts=vertices(segments);requireRule(close===true,'Preview and explicitly close the perimeter.');if(Math.hypot(pts.at(-1).x,pts.at(-1).y)<=1)pts.pop();requireRule(pts.length>=3,'Draw at least three distinct vertices.');for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];requireRule(Math.hypot(b.x-a.x,b.y-a.y)>1,'Boundary segments overlap or have zero length.');for(let j=i+1;j<pts.length;j++){if(j===i+1||i===0&&j===pts.length-1)continue;requireRule(!intersects(a,b,pts[j],pts[(j+1)%pts.length]),'The yard boundary crosses or overlaps itself.');}const prev=pts[(i+pts.length-1)%pts.length];requireRule(!(Math.abs(cross(prev,a,b))<0.01&&((prev.x-a.x)*(b.x-a.x)+(prev.y-a.y)*(b.y-a.y))>0),'Boundary segments double back.');}const area=Math.abs(pts.reduce((sum,a,i)=>{const b=pts[(i+1)%pts.length];return sum+a.x*b.y-b.x*a.y;},0))/2;requireRule(area>1,'Yard area must be greater than zero.');return {points:pts,area};}
export function inside(p,poly){let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(on(a,b,p))return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)result=!result;}return result;}
export function rect(container,position=container){const rotation=position.rotation??0;requireRule(rotation===0||rotation===90,'Rotation must be 0 or 90 degrees.');const length=container.envelopeLength??container.length,width=container.envelopeWidth??container.width;integer(length,'Loaded length',1);integer(width,'Loaded width',1);return {x:position.x,y:position.y,w:rotation===90?width:length,h:rotation===90?length:width};}
export const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
export const contains=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.w<=outer.x+outer.w&&inner.y+inner.h<=outer.y+outer.h;
export function fitsPolygon(r,poly){const corners=[{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}];if(!corners.every(p=>inside(p,poly)))return false;for(let i=0;i<4;i++){const a=corners[i],b=corners[(i+1)%4];for(let j=0;j<poly.length;j++){const c=poly[j],d=poly[(j+1)%poly.length];if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return false;}}return inside({x:r.x+r.w/2,y:r.y+r.h/2},poly);}

// Conservative grid routing: each node and swept edge fits the full load envelope.
export function route(start,end,shape,poly,obstacles,step=500){
  const valid=(x,y)=>{const r={x,y,w:shape.w,h:shape.h};return fitsPolygon(r,poly)&&!obstacles.some(o=>overlap(r,o));};
  const edge=(a,b)=>{const n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/100));for(let i=0;i<=n;i++)if(!valid(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n))return false;return true;};
  if(!valid(start.x,start.y)||!valid(end.x,end.y))return null;
  if(edge(start,end))return [start,end];
  const queue=[start],seen=new Map([[`${start.x},${start.y}`,null]]);let goal=null;
  for(let head=0;head<queue.length&&head<20000;head++){const p=queue[head];if(Math.hypot(p.x-end.x,p.y-end.y)<=step*1.5&&edge(p,end)){goal=p;break;}for(const [dx,dy] of [[step,0],[-step,0],[0,step],[0,-step]]){const next={x:p.x+dx,y:p.y+dy},key=`${next.x},${next.y}`;if(!seen.has(key)&&edge(p,next)){seen.set(key,p);queue.push(next);}}}
  if(!goal)return null;const points=[end];for(let p=goal;p;p=seen.get(`${p.x},${p.y}`))points.push(p);return points.reverse();
}
