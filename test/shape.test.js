import test from 'node:test';
import assert from 'node:assert/strict';
import {detectPreset,setSideLength,pushSide,moveCorner,rectangle,lShape,ringProblems,splitSide,sameGround,simplifyRing,normalise,freeZone,cleanCorners,sides,slantedSides,bbox} from '../public/shape.js';
import {polygonFromPoints} from '../src/domain/geometry.js';

const RECT=[{x:0,y:0},{x:20000,y:0},{x:20000,y:16000},{x:0,y:16000}];
const OWNER=[{x:0,y:0},{x:35000,y:0},{x:35000,y:16000},{x:5000,y:16000}];
const circle=(n,r=50000)=>Array.from({length:n},(_,i)=>({x:Math.round(r*Math.cos(2*Math.PI*i/n)),y:Math.round(r*Math.sin(2*Math.PI*i/n))}));

test('detectPreset recognises a 20 x 16 m rectangle',()=>{assert.deepEqual(detectPreset(RECT),{preset:'RECT',w:20000,d:16000});assert.equal(detectPreset(OWNER).preset,'CUSTOM');});

test('setSideLength, pushSide and moveCorner keep rectangles',()=>{
  const a=setSideLength(RECT,0,25000);assert.deepEqual(detectPreset(a),{preset:'RECT',w:25000,d:16000});
  const b=setSideLength(RECT,1,10000);assert.deepEqual(detectPreset(b),{preset:'RECT',w:20000,d:10000});
  const c=pushSide(RECT,1,3000);assert.deepEqual(detectPreset(c),{preset:'RECT',w:23000,d:16000});assert.deepEqual(c[0],{x:0,y:0});
  const d=pushSide(RECT,0,-2000);assert.deepEqual(detectPreset(d),{preset:'RECT',w:20000,d:14000});assert.equal(bbox(d).y0,2000);
  const e=moveCorner(RECT,2,{x:22000,y:18000});assert.deepEqual(detectPreset(e),{preset:'RECT',w:22000,d:18000});
  const f=moveCorner(RECT,2,{x:22000,y:18000},false);assert.equal(detectPreset(f).preset,'CUSTOM');});

test('rectangle keeps the anchor corner of the box',()=>{const box={x0:0,y0:0,x1:20000,y1:16000};
  assert.deepEqual(rectangle(10000,5000,'BR',box),[{x:10000,y:11000},{x:20000,y:11000},{x:20000,y:16000},{x:10000,y:16000}]);
  assert.deepEqual(rectangle(10000,5000,'TL',box)[0],{x:0,y:0});assert.deepEqual(rectangle(10000,5000,'TR',box)[1],{x:20000,y:0});assert.deepEqual(rectangle(10000,5000,'BL',box)[3],{x:0,y:16000});});

test('lShape for every cut corner is a valid ring that round-trips through detectPreset',()=>{const box={x0:1000,y0:2000,x1:21000,y1:18000};
  for(const k of ['TL','TR','BL','BR']){const p=normalise(lShape(20000,16000,6000,5000,k,box));assert.equal(ringProblems(p).length,0,k);assert.deepEqual(detectPreset(p),{preset:'L',w:20000,d:16000,cutW:6000,cutD:5000,cutCorner:k},k);}});

test('splitSide adds a pass-through corner that does not change the ground',()=>{const s=splitSide(RECT,1);assert.equal(s.length,5);assert.deepEqual(s[2],{x:20000,y:8000});assert.ok(sameGround(s,RECT));assert.ok(!sameGround(pushSide(s,1,1000),RECT));assert.equal(ringProblems(s).length,0);});

test('simplifyRing drops only pass-through corners',()=>{const s=splitSide(splitSide(RECT,0),3);assert.deepEqual(simplifyRing(s),RECT);
  const notch=[{x:0,y:0},{x:10000,y:0},{x:10000,y:2000},{x:12000,y:2000},{x:12000,y:0},{x:20000,y:0},{x:20000,y:16000},{x:0,y:16000}];assert.deepEqual(simplifyRing(notch),notch);
  assert.deepEqual(simplifyRing(OWNER),OWNER);});

test('normalise gives clockwise corners starting top-left, from any start or direction',()=>{const rev=[...RECT].reverse();assert.deepEqual(normalise(rev),RECT);assert.deepEqual(normalise([RECT[2],RECT[3],RECT[0],RECT[1]]),RECT);
  const o=normalise([...OWNER].reverse());assert.deepEqual(o,OWNER);});

test('freeZone takes a clear preferred spot, otherwise the nearest clear spot',()=>{const loading={x:1000,y:1000,w:2000,h:1500};
  assert.deepEqual(freeZone(RECT,[loading],[{x:3500,y:1000}],{x:1000,y:1000}),{x:3500,y:1000});
  assert.deepEqual(freeZone(RECT,[loading],[{x:30000,y:1000}],{x:18800,y:14000}),{x:17800,y:14000});
  assert.deepEqual(freeZone(RECT,[loading],[],{x:1000,y:1000}),{x:1000,y:2500});
  assert.equal(freeZone([{x:0,y:0},{x:1500,y:0},{x:1500,y:1000},{x:0,y:1000}],[],[],null),null);});

test('cleanCorners accepts 101 kept corners but rejects 101 new ones',()=>{const ring=circle(101);
  assert.equal(cleanCorners(ring,ring).points.length,101);
  assert.equal(cleanCorners(ring).problem.status,409);
  assert.match(cleanCorners([...RECT,{x:0.5,y:0}]).problem.message,/Corner 5 X must be a whole number/);
  const fl=[{x:0,y:0},{x:10000.5,y:0},{x:5000,y:8000}];assert.deepEqual(cleanCorners(fl,fl).points,fl);});

test('the owner\'s slanted yard: side 4 runs at an angle with no arrow',()=>{assert.deepEqual(slantedSides(OWNER).map(s=>[s.i,Math.round(s.length)]),[[3,16763]]);assert.equal(sides(OWNER)[3].arrow,null);assert.equal(sides(OWNER)[0].arrow,'→');assert.equal(sides(OWNER)[1].arrow,'↓');});

test('parity: ringProblems is empty exactly when the server accepts the corners',()=>{
  const fl=[{x:0,y:0},{x:10000.5,y:0},{x:5000.25,y:8660.3}];
  const corpus={rectangle:RECT,L:normalise(lShape(20000,16000,6000,5000,'TR',{x0:0,y0:0,x1:20000,y1:16000})),triangle:[{x:0,y:0},{x:10000,y:0},{x:0,y:8000}],diagonalFloat:fl,
    bowTie:[{x:0,y:0},{x:10000,y:10000},{x:10000,y:0},{x:0,y:10000}],doubleBack:[{x:0,y:0},{x:10000,y:0},{x:5000,y:0},{x:5000,y:5000}],zeroEdge:[{x:0,y:0},{x:0,y:0},{x:10000,y:0},{x:10000,y:10000}],
    collinearSplit:splitSide(RECT,2),hundred:circle(100),owner:OWNER};
  const expected={rectangle:true,L:true,triangle:true,diagonalFloat:true,bowTie:false,doubleBack:false,zeroEdge:false,collinearSplit:true,hundred:true,owner:true};
  for(const [name,pts] of Object.entries(corpus)){let ok=true;try{polygonFromPoints(pts,pts);}catch{ok=false;}assert.equal(ringProblems(pts).length===0,ok,name);assert.equal(ok,expected[name],name);}});
