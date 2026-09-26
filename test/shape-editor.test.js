import test from 'node:test';
import assert from 'node:assert/strict';
import {createShapeEditor,draftFrom,reduce,problems,payloadOf,editorMarkup,planSVG,statusOf,FIXTURE_TYPES,snap,canPlace,labelPx,fitBox} from '../public/shape-editor.js';
import {affected} from '../public/shape.js';

const RECT=[{x:0,y:0},{x:20000,y:0},{x:20000,y:16000},{x:0,y:16000}];
const OWNER=[{x:0,y:0},{x:35000,y:0},{x:35000,y:16000},{x:5000,y:16000}];
const yard=(o={})=>({id:'Y1',kind:'yard',name:'Yard',shapeRev:2,version:9,segments:[{direction:'RIGHT',length:20000}],closed:true,points:RECT,height:10000,loading:{x:1000,y:1000},gate:{x:3500,y:1000},fixtures:[{id:'F7',kind:'TOILET',name:'Toilet',x:15000,y:12000,w:1500,h:1500}],...o});
const site=(o={})=>({id:'S1',kind:'site',name:'Site A',status:'ACTIVE',shapeRev:0,points:RECT,loading:{x:1000,y:1000},gate:{x:3500,y:1000},...o});
const buttons=html=>[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m=>({attrs:m[1],text:m[2]}));
const primary=html=>buttons(html).filter(b=>!/class="[^"]*\b(secondary|text-button)\b/.test(b.attrs));
const widen=d=>reduce(d,{t:'rect',w:25000,d:16000,anchor:'TL'});

test('FIXTURE_TYPES moved from operations.js unchanged',()=>{assert.deepEqual(FIXTURE_TYPES,[['ENTRY','Truck entry',4000,3000],['EXIT','Truck exit',4000,3000],['TOILET','Toilet',1500,1500],['OFFICE','Yard office',6000,3000],['CUSTOM','Custom fixture',2000,2000]]);});

test('reduce undo/redo is exact and history is capped at 100',()=>{
  let d=draftFrom(yard(),'yard');const states=[snap(d)];
  for(let i=1;i<=105;i++){const before=snap(d);d=reduce(d,i%2?{t:'height',mm:10000+i}:{t:'push',i:1,d:500});d=reduce(d,{t:'record',before});states.push(snap(d));}
  assert.equal(d.history.length,100);assert.equal(d.future.length,0);
  for(let i=104;i>=5;i--){d=reduce(d,{t:'undo'});assert.deepEqual(snap(d),states[i]);}
  assert.equal(reduce(d,{t:'undo'}),d,'nothing older than 100 steps');
  for(let i=6;i<=105;i++){d=reduce(d,{t:'redo'});assert.deepEqual(snap(d),states[i]);}
  assert.equal(reduce(d,{t:'redo'}),d);
  const before=snap(d);d=reduce(reduce(d,{t:'undo'}),{t:'record',before:snap(d)});assert.equal(d.future.length,0,'a new step clears redo');});

test('untouched float corners survive edits elsewhere',()=>{
  const pts=[{x:0,y:0},{x:20000,y:0},{x:20000,y:16000},{x:3333.3333,y:16000}];let d=draftFrom(yard({points:pts}),'yard');
  assert.equal(d.preset,'CUSTOM');
  d=reduce(d,{t:'split',i:1});d=reduce(d,{t:'name',value:'Renamed'});d=reduce(d,{t:'zone',which:'gate',x:6000,y:1000});d=reduce(d,{t:'side',i:0,mm:21000});
  const p=payloadOf(d).points;assert.equal(p.length,5);assert.equal(p[4].x,3333.3333);assert.equal(p[4].y,16000);assert.ok(p.slice(0,4).every(q=>Number.isInteger(q.x)&&Number.isInteger(q.y)));
  const r=reduce(d,{t:'corner',i:4,x:3000,y:16000,square:true});assert.deepEqual(r.corners[4],{x:3000,y:16000});});

test('payloadOf has fixture ids and shapeRev, and no version, segments or closed',()=>{
  const d=draftFrom(yard(),'yard'),p=payloadOf(d);
  assert.deepEqual(Object.keys(p).sort(),['fixtures','gate','height','id','loading','name','points','shapeRev']);
  assert.equal(p.shapeRev,2);assert.equal(p.id,'Y1');assert.equal(p.fixtures[0].id,'F7');
  const added=payloadOf(reduce(d,{t:'addFixture',kind:'OFFICE',at:{x:2000,y:5000}}));assert.equal(added.fixtures[1].id,undefined);assert.equal(added.fixtures[1].name,'Yard office');
  const s=payloadOf(draftFrom(site(),'site'));assert.equal(s.fixtures,undefined);assert.equal(s.shapeRev,0);
  const n=payloadOf(draftFrom(null,'new'));assert.equal(n.id,undefined);assert.equal(n.shapeRev,undefined);assert.deepEqual(n.fixtures,[]);assert.equal(n.name,'Main yard');});

test('dirty() is false on an untouched draft of every kind, including new',()=>{
  const state={yards:[yard()],sites:[site()],containers:[],tasks:[],resources:[]},old=globalThis.confirm;globalThis.confirm=()=>{throw new Error('confirm should not be asked');};
  try{for(const target of [{kind:'new'},{kind:'yard',id:'Y1'},{kind:'site',id:'S1'}]){const ed=createShapeEditor({target,state,account:{},api:async()=>({ok:true}),command:async()=>({}),notify:()=>{},onClose:()=>{}});
    assert.equal(ed.dirty(),false,target.kind);assert.equal(ed.confirmLeave(),true,target.kind);assert.deepEqual(ed.target,target);ed.destroy();}}
  finally{globalThis.confirm=old;}
  assert.equal(draftFrom(null,'new').base,widen(draftFrom(null,'new')).base,'base is fixed at opening');});

test('the owner\'s slanted yard stays CUSTOM and squares up to its bounding box',()=>{
  const d=draftFrom(yard({points:OWNER}),'yard');assert.equal(d.preset,'CUSTOM');assert.deepEqual(d.corners,OWNER);
  const r=reduce(d,{t:'preset',p:'RECT'});assert.equal(r.preset,'RECT');assert.deepEqual(r.corners,[{x:0,y:0},{x:35000,y:0},{x:35000,y:16000},{x:0,y:16000}]);
  assert.match(r.notice,/Switched to a rectangle around the old shape/);assert.deepEqual(reduce(reduce(r,{t:'record',before:snap(d)}),{t:'undo'}).corners,OWNER);});

test('draftFrom keeps a legacy gate that equals the loading zone as stored',()=>{
  const d=draftFrom(yard({gate:{x:1000,y:1000}}),'yard');assert.deepEqual(d.gate,{x:1000,y:1000});assert.deepEqual(payloadOf(d).gate,{x:1000,y:1000});
  assert.equal(statusOf(d).text,'No changes yet.');
  const moved=widen(d);assert.match(statusOf(moved).text,/The gate moves to 3\.5, 1\.0 m\./);
  assert.match(editorMarkup(d),/id="gate-notice">The gate shares the loading spot\. Drag GATE to where trucks come in, or it moves to 3\.5, 1\.0 m when you save a shape change\./);});

test('instant checks: blocking problems name the side, fixture, height and zone',()=>{
  const d=draftFrom(yard(),'yard');assert.deepEqual(problems(d),[]);
  const cross=reduce(d,{t:'corner',i:2,x:10000,y:-5000,square:false});assert.ok(problems(cross).some(p=>p.blocking&&p.sides.length));
  const out=reduce(d,{t:'rect',w:10000,d:16000,anchor:'TL'});assert.equal(problems(out)[0].message,'Toilet is outside the yard.');assert.equal(problems(out)[0].fixture,0);
  const low=reduce(d,{t:'height',mm:1000});assert.equal(problems(low,{stock:[{id:'a',name:'A',x:5000,y:5000,w:2000,h:1000,height:1500}]})[0].message,'Height is lower than stillage A (1.5 m).');
  const tiny=reduce(reduce(d,{t:'removeFixture',i:0}),{t:'rect',w:2500,d:2000,anchor:'TL'});assert.match(problems(tiny).find(p=>p.blocking).message,/Too small: the yard must fit the 2 × 1\.5 m loading zone and a separate 2 × 1\.5 m gate\./);
  const onLoading=reduce(d,{t:'fixture',i:0,patch:{x:1500,y:1500}});assert.ok(problems(onLoading).some(p=>p.message==='Toilet overlaps the loading zone.'));});

test('status and Save label count the stillages the save moves, matching shape.affected',()=>{
  const stock=[{id:'a',name:'A',x:22000,y:4000,w:2000,h:1000,height:1000},{id:'b',name:'B',x:4000,y:8000,w:2000,h:1000,height:1000},{id:'c',name:'C',x:22000,y:4000,w:2000,h:1000,height:800,support:'a'}];
  const d=draftFrom(yard({points:[{x:0,y:0},{x:25000,y:0},{x:25000,y:16000},{x:0,y:16000}]}),'yard'),s=reduce(d,{t:'rect',w:20000,d:16000,anchor:'TL'});
  const st=statusOf(s,{stock});assert.equal(st.label,'Save yard · moves 2 stillages');assert.equal(st.tone,'warn');assert.match(st.text,/^20\.0 × 16\.0 m · 320 m² \(−80 m²\)\. 2 stillages will be moved inside the new shape: A, C \(red on the plan\)\./);
  assert.deepEqual([...affected(s.corners,stock,s.loading,s.fixtures,s.height).keys()],['a','c']);
  const q={ok:true,seq:0,affected:[{id:'a',name:'A',why:'outside'},{id:'c',name:'C',why:'pile'}],stops:2,jobs:1,incoming:1,halted:[{task:'t',name:'B',turn:true}],loading:s.loading,gate:s.gate,loadingMoved:false,gateMoved:false};
  const t=statusOf(s,{stock,quick:q,seq:0}).text;assert.match(t,/2 manual worker\/forklift orders will be stopped\. 1 yard job will be handed back and re-assigned\. 1 incoming movement will be re-planned\. The waiting turn of B will be stopped; turn it again after saving\./);
  assert.equal(statusOf(s,{stock,quick:{ok:false,seq:0,message:'Not enough free ground inside the new yard shape for the 38 stillages that must move (76.0 m² needed, 41.0 m² free).'},seq:0}).canSave,false);
  assert.equal(statusOf(s,{stock,quick:{ok:false,seq:0,message:'x'},seq:1}).canSave,true,'a stale result is ignored');
  assert.deepEqual([statusOf(s,{saving:'checking'}).label,statusOf(s,{saving:'saving'}).label,statusOf(s,{saving:'saving'}).canSave],['Checking…','Saving…',false]);
  assert.equal(statusOf(s,{conflict:{}}).canSave,false);assert.equal(statusOf(s,{error:'Server said no.'}).text,'Server said no.');});

test('markup: #shape-save is the only primary button, with the right label per kind',()=>{
  const cases=[[widen(draftFrom(yard(),'yard')),'Save yard'],[widen(draftFrom(site(),'site')),'Save site'],[draftFrom(null,'new'),'Create yard']];
  for(const [d,label] of cases){const html=editorMarkup(d),p=primary(html);assert.equal(p.length,1,label);assert.match(p[0].attrs,/id="shape-save"/);assert.equal(p[0].text,label);assert.doesNotMatch(p[0].attrs,/disabled/);}
  assert.doesNotMatch(editorMarkup(draftFrom(null,'new')),/id="shape-cancel"/);assert.match(editorMarkup(draftFrom(yard(),'yard')),/id="shape-cancel"/);});

test('markup: Width and Depth are pre-filled in metres',()=>{const html=editorMarkup(draftFrom(null,'new'));
  assert.match(html,/<label>Width \(m\)<input [^>]*data-field="rect\.w"[^>]*value="20"/);assert.match(html,/<label>Depth \(m\)<input [^>]*data-field="rect\.d"[^>]*value="16"/);
  assert.match(html,/A 20\.0 × 16\.0 m yard with the loading zone at 1\.0, 1\.0 m and the gate at 3\.5, 1\.0 m\. Change anything, then press Create yard\./);
  assert.match(html,/aria-checked="true" data-anchor="TL"/);assert.match(html,/id="anchor-hint">Grows to the right and downward\./);});

test('markup: an untouched draft says No changes yet; a width change enables Save yard',()=>{
  const d=draftFrom(yard(),'yard'),html=editorMarkup(d),save=buttons(html).find(b=>/id="shape-save"/.test(b.attrs));
  assert.match(html,/No changes yet\./);assert.equal(save.text,'No changes yet');assert.match(save.attrs,/disabled/);
  const w=widen(d),html2=editorMarkup(w),save2=buttons(html2).find(b=>/id="shape-save"/.test(b.attrs));assert.equal(save2.text,'Save yard');assert.doesNotMatch(save2.attrs,/disabled/);
  assert.match(html2,/25\.0 × 16\.0 m · 400 m² \(\+80 m²\)\. Nothing needs to move\./);});

test('markup: sites have no fixtures; the old line builder is gone',()=>{
  const s=editorMarkup(draftFrom(site(),'site'));assert.doesNotMatch(s,/shape-fixtures/);assert.match(s,/CHANGE SITE SHAPE &amp; SIZE/);assert.match(s,/Site name/);
  for(const html of [s,editorMarkup(draftFrom(yard(),'yard')),editorMarkup(draftFrom(null,'new'))]){assert.doesNotMatch(html,/id="close-yard"|id="segment"|Preview and close perimeter/);}
  assert.match(editorMarkup(draftFrom(yard(),'yard')),/id="shape-fixtures"[^>]*><summary>Fixtures \(office, toilet, truck lanes\) · 1<\/summary>/);});

test('markup: the owner\'s slanted yard offers to square up',()=>{
  const html=editorMarkup(draftFrom(yard({points:OWNER}),'yard'));
  assert.match(html,/This yard is not a rectangle: side 4 \(16\.8 m\) runs at an angle\./);assert.match(html,/data-preset="RECT">Make it a 35\.0 × 16\.0 m rectangle<\/button>/);
  assert.match(html,/<li data-side-row="3" class="slanted"><span class="side-name">Side 4 <span class="slanted-tag">slanted<\/span><\/span>/);assert.match(html,/Side 1 →/);
  assert.match(html,/aria-pressed="true">Custom/);
  const two=editorMarkup(draftFrom(yard({points:[{x:0,y:0},{x:30000,y:0},{x:35000,y:16000},{x:5000,y:16000}]}),'yard'));assert.match(two,/sides 2 and 4 run at an angle\./);});

test('planSVG: flat plan, one dimension label per side, slanted side, corner handles, escaped names',()=>{
  const d=draftFrom(yard(),'yard'),svg=planSVG(d);
  assert.doesNotMatch(svg,/tilted/);assert.equal((svg.match(/class="dim-label"/g)||[]).length,4);assert.equal((svg.match(/>20\.0 m<\/text>/g)||[]).length,2+1,'two 20 m sides plus the overall width');
  const handles=[...svg.matchAll(/class="corner-handle[^"]*" data-handle="corner:(\d+)"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)].map(m=>({i:+m[1],x:+m[2],y:+m[3]}));
  assert.deepEqual(handles.map(h=>({x:h.x,y:h.y})),d.corners);assert.deepEqual(handles.map(h=>h.i),[0,1,2,3]);
  const o=planSVG(draftFrom(yard({points:OWNER}),'yard')),edges=[...o.matchAll(/<line class="(edge(?: [^"]*)?)"/g)].map(m=>m[1]);assert.deepEqual(edges,['edge','edge','edge','edge slanted']);
  const bad=draftFrom(yard({fixtures:[{id:'F1',kind:'CUSTOM',name:'<script>x</script>',x:15000,y:10000,w:2000,h:2000}]}),'yard');
  const stock=[{id:'s"1',name:'<img src=x>',x:5000,y:5000,w:2000,h:1000,height:1000}];const svg2=planSVG(bad,{stock}),html=editorMarkup(bad,{stock});
  for(const s of [svg2,html]){assert.doesNotMatch(s,/<script>|<img /);assert.match(s,/&lt;script&gt;x&lt;\/script&gt;/);}
  assert.match(svg2,/data-stock="s&quot;1"/);assert.match(svg2,/class="zone zone-loading" data-handle="loading" tabindex="0" role="button" aria-label="Loading zone at 1\.0, 1\.0 m\. Drag or use arrow keys to move it\."/);});

test('planSVG: stillages the save moves are red; the full preview draws dashed ghosts and arrows',()=>{
  const stock=[{id:'a',name:'A',x:22000,y:4000,w:2000,h:1000,height:1000},{id:'b',name:'B',x:4000,y:8000,w:2000,h:1000,height:1000}];
  const s=reduce(draftFrom(yard({points:[{x:0,y:0},{x:25000,y:0},{x:25000,y:16000},{x:0,y:16000}]}),'yard'),{t:'rect',w:20000,d:16000,anchor:'TL'});
  const svg=planSVG(s,{stock,seq:3,full:{ok:true,seq:3,moved:[{id:'a',name:'A',from:{x:22000,y:4000,rotation:0,support:null},to:{x:3500,y:1000,rotation:0,support:null}}]}});
  assert.match(svg,/class="stock affected" data-stock="a"/);assert.match(svg,/class="stock" data-stock="b"/);assert.match(svg,/class="stock-ghost" x="3500" y="1000" width="2000" height="1000"/);assert.match(svg,/class="move-arrow"[^>]*marker-end="url\(#shape-arrow\)"/);});

// ---------- controller, with a tiny stand-in for the browser ----------
// Elements are made on first lookup and replaced when innerHTML is set (a remount gives a new svg, as in the page). Screen px equal mm on the plan.
class El{constructor(o={}){Object.assign(this,{dataset:{},listeners:{},kids:new Map(),textContent:'',value:'',disabled:false,classList:{add(){},remove(){},toggle(){}},style:{setProperty(){},removeProperty(){}}},o);}
  set innerHTML(v){this.html=v;this.kids=new Map();}get innerHTML(){return this.html??'';}
  querySelector(sel){if(!this.kids.has(sel))this.kids.set(sel,new El());return this.kids.get(sel);}querySelectorAll(){return [];}
  addEventListener(t,fn){(this.listeners[t]??=[]).push(fn);}removeEventListener(t,fn){this.listeners[t]=(this.listeners[t]??[]).filter(f=>f!==fn);}fire(t,e){for(const fn of [...this.listeners[t]??[]])fn(e);}
  contains(){return true;}closest(){return this;}focus(){}blur(){}scrollIntoView(){}setAttribute(){}removeAttribute(){}setPointerCapture(){}releasePointerCapture(){}
  getBoundingClientRect(){return {width:800,height:560,left:0,top:0};}createSVGPoint(){return {x:0,y:0,matrixTransform(){return {x:this.x,y:this.y};}};}getScreenCTM(){return {inverse:()=>({})};}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const box=(c,x,y)=>({id:c,name:c.toUpperCase(),location:'Y1',x,y,length:2000,width:1000,height:1000,rotation:0});
// The server side of the rig: a yard, its stillages and a boundary preview that answers like turning.js (conflict on a stale shapeRev).
function server(o={}){const srv={rev:2,height:10000,stops:0,containers:[box('a',4000,4000)],fixtures:[],...o};
  srv.yard=()=>yard({shapeRev:srv.rev,height:srv.height,fixtures:srv.fixtures});srv.state=()=>({yards:[srv.yard()],sites:[],containers:structuredClone(srv.containers),tasks:[],resources:[]});
  srv.stock=()=>srv.containers.map(c=>({id:c.id,name:c.name,x:c.x,y:c.y,w:c.length,h:c.width,rotation:0,support:null,height:c.height}));
  srv.conflict='Someone else saved Yard while you were editing. Nothing was changed.';
  srv.preview=b=>{if(b.shapeRev!==srv.rev)return {ok:false,message:srv.conflict};const st=srv.stock(),aff=affected(b.points,st,b.loading,b.fixtures??[],b.height);
    return {ok:true,detail:b.detail,affected:[...aff].map(([id,why])=>({id,name:st.find(s=>s.id===id).name,why})),stock:st,stops:srv.stops,jobs:0,incoming:0,halted:[],loading:b.loading,gate:b.gate,loadingMoved:false,gateMoved:false,...(b.detail==='full'?{moved:[]}:{})};};
  return srv;}
function rig(t,srv,{command}={}){
  const saved={document:globalThis.document,raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,confirm:globalThis.confirm};
  const doc=new El({activeElement:null,documentElement:new El()});globalThis.document=doc;globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);globalThis.cancelAnimationFrame=clearTimeout;globalThis.confirm=()=>true;
  const calls=[],sent=[],closed=[];
  const api=async(path,body)=>{calls.push({path,body});await wait(1);return path==='state'?srv.state():srv.preview(body);};
  command??=async(action,p)=>{sent.push(p);await wait(1);if(p.shapeRev!==srv.rev)throw new Error(srv.conflict);return {message:'Saved.'};};
  const ed=createShapeEditor({target:{kind:'yard',id:'Y1'},state:srv.state(),account:{},api,command:(a,p)=>command(a,p,sent),notify:()=>{},onClose:r=>closed.push(r)});
  const host=new El();ed.mount(host);
  t.after(()=>{ed.destroy();Object.assign(globalThis,{document:saved.document,requestAnimationFrame:saved.raf,cancelAnimationFrame:saved.caf,confirm:saved.confirm});});
  const svg=()=>host.querySelector('#shape-svg'),handle=key=>new El({dataset:{handle:key}});
  const field=(key,value)=>{const el=new El({type:key==='name'?'text':'number',dataset:{field:key},value:String(value),valueAsNumber:+value,min:'',max:''});host.fire('focusin',{target:el});host.fire('input',{target:el});host.fire('change',{target:el});return el;};
  const pointer=(type,x,y,key)=>svg().fire(type,{pointerId:1,button:0,clientX:x,clientY:y,shiftKey:false,target:{closest:()=>key?handle(key):null},preventDefault(){}});
  const key=(k,{ctrl=false,on=null}={})=>{const e={key:k,ctrlKey:ctrl,metaKey:false,shiftKey:false,target:on?{tagName:'g',closest:()=>handle(on)}:{tagName:'g'},preventDefault(){}};if(on)svg().fire('keydown',e);doc.fire('keydown',e);};
  const click=id=>host.fire('click',{target:{closest:()=>new El({id})}});
  const status=()=>host.querySelector('#shape-status').textContent,save=()=>host.querySelector('#shape-save');
  const previews=()=>calls.filter(c=>c.path==='boundary-preview').length;
  return {ed,host,calls,sent,closed,field,pointer,key,click,status,save,previews};
}

test('stock activity while the draft has unsaved changes checks the same draft again (status, red stillages, Save label)',async t=>{
  const srv=server(),r=rig(t,srv);await wait(30);
  r.field('rect.w',12);await wait(400);
  assert.match(r.status(),/^12\.0 × 16\.0 m .*Nothing needs to move\./);const n0=r.previews();
  srv.containers[0].x=13000;srv.containers[0].y=9000;srv.stops=1;// a forklift put A where the new shape cuts it off
  r.ed.update(srv.state());await wait(400);r.ed.update(srv.state());await wait(100);
  assert.ok(r.previews()>n0,'the activity sends a new preview for the unchanged draft');
  assert.match(r.status(),/1 stillage will be moved inside the new shape: A \(red on the plan\)\..*1 manual worker\/forklift order will be stopped\./);
  assert.equal(r.save().textContent,'Save yard · moves 1 stillage');
  const n1=r.previews();r.ed.update(srv.state());await wait(400);assert.equal(r.previews(),n1,'no activity, no new check');});

test('a failed full check is re-run when the stock changes, instead of keeping Save disabled',async t=>{
  const srv=server(),r=rig(t,srv);await wait(30);const preview=srv.preview;let crew=true;
  srv.preview=b=>b.detail==='full'&&crew?{ok:false,message:'A has no clear space (crew in the way).'}:preview(b);
  r.field('rect.w',12);srv.containers[0].x=13000;r.ed.update(srv.state());await wait(450);
  assert.match(r.status(),/has no clear space/);assert.equal(r.save().disabled,true);
  crew=false;srv.containers.push(box('b',6000,6000));r.ed.update(srv.state());await wait(450);
  assert.doesNotMatch(r.status(),/no clear space/);assert.equal(r.save().disabled,false);});

test('undo, redo and handle keys during a pointer drag are ignored; the drag ends normally and keeps every undo step',async t=>{
  const r=rig(t,server());await wait(30);
  r.field('rect.w',18);r.field('rect.w',17);assert.equal(r.ed.draft.history.length,2);
  r.pointer('pointerdown',17000,16000,'corner:2');r.pointer('pointermove',18000,17000);await wait(5);
  r.key('z',{ctrl:true});r.key('y',{ctrl:true});r.key('Delete',{on:'corner:2'});r.key('ArrowLeft',{on:'corner:2'});
  assert.equal(r.ed.draft.history.length,2,'no undo step lost');assert.equal(r.ed.draft.future.length,0);assert.equal(r.ed.draft.corners.length,4,'Delete did not remove the corner');
  r.pointer('pointermove',18500,17000);r.pointer('pointerup',18500,17000);
  assert.deepEqual(r.ed.draft.corners[2],{x:18500,y:17000});assert.equal(r.ed.draft.history.length,3);assert.equal(r.ed.draft.history[2].corners[1].x,17000);
  r.key('z',{ctrl:true});assert.equal(r.ed.draft.corners[2].x,17000,'undo works again after the drag');});

test('a remount during a drag finishes the drag, so moving the mouse afterwards never reshapes the yard',async t=>{
  const r=rig(t,server());await wait(30);
  r.pointer('pointerdown',20000,16000,'corner:2');r.pointer('pointermove',21000,16000);await wait(5);
  r.ed.mount(r.host);const after=structuredClone(r.ed.draft.corners);assert.deepEqual(after[2],{x:21000,y:16000});assert.equal(r.ed.draft.history.length,1,'the drag is one undo step');
  r.pointer('pointermove',26000,20000);await wait(5);assert.deepEqual(r.ed.draft.corners,after,'no drag is left running');});

test('typing while the save is in flight does not change the draft and the field shows the saved value',async t=>{
  let release;const srv=server(),r=rig(t,srv,{command:(a,p,sent)=>{sent.push(p);return new Promise(ok=>release=()=>ok({message:'Saved.'}));}});await wait(30);
  r.field('rect.w',18);await wait(400);r.click('shape-save');await wait(20);
  assert.equal(r.save().textContent,'Saving…');assert.equal(r.sent.length,1);
  const name=r.field('name','North yard'),height=r.field('height',6);
  assert.equal(r.ed.draft.name,'Yard');assert.equal(r.ed.draft.height,10000);assert.equal(name.value,'Yard');assert.equal(height.value,'10');
  release();await wait(10);assert.equal(r.closed.length,1);assert.equal(r.sent[0].name,'Yard');});

// Waits for a condition instead of a fixed pause, so a busy machine cannot outrun the simulated server replies.
const until=async(ok,ms=5000)=>{const end=Date.now()+ms;for(;;){try{if(ok())return;}catch{}if(Date.now()>end)return;await wait(10);}};
test('Save mine anyway uses the latest saved shapeRev even when no poll has reached the editor',async t=>{
  const srv=server(),r=rig(t,srv);await wait(30);r.field('rect.w',18);await wait(400);
  srv.rev=3;srv.height=9000;// someone else saves; the poll is paused (a panel is open), so update() never runs
  r.click('shape-save');await until(()=>/Someone else saved/.test(r.status()));assert.match(r.status(),/Someone else saved this yard while you were editing/);assert.equal(r.closed.length,0);
  r.click('shape-save-anyway');await until(()=>r.closed.length===1);
  assert.equal(r.sent.at(-1).shapeRev,3);assert.equal(r.closed.length,1,'saved and closed');assert.ok(r.calls.some(c=>c.path==='state'));});

test('Load their version loads the latest saved shape even when no poll has reached the editor',async t=>{
  const srv=server(),r=rig(t,srv);await wait(30);r.field('rect.w',18);await wait(400);
  srv.rev=3;srv.height=9000;r.click('shape-save');await until(()=>/Someone else saved/.test(r.status()));assert.match(r.status(),/Someone else saved/);
  r.click('shape-load-theirs');await until(()=>r.ed.draft.target.shapeRev===3&&/Loaded their version/.test(r.status()));
  assert.equal(r.ed.draft.height,9000);assert.equal(r.ed.draft.target.shapeRev,3);assert.equal(r.ed.dirty(),false);assert.doesNotMatch(r.status(),/Someone else saved/);assert.match(r.status(),/Loaded their version\./);
  r.ed.update(server().state());assert.equal(r.ed.draft.target.shapeRev,3,'an older snapshot does not undo it');});

test('a drag cancelled with Escape keeps the server facts in the status',async t=>{
  const srv=server({stops:1}),r=rig(t,srv);await wait(30);r.field('rect.w',19);await wait(400);
  const before=r.status();assert.match(before,/1 manual worker\/forklift order will be stopped\./);const n=r.previews();
  r.pointer('pointerdown',19000,16000,'corner:2');r.pointer('pointermove',21000,17000);await wait(5);assert.equal(r.ed.draft.corners[2].x,21000);
  r.key('Escape');assert.equal(r.ed.draft.corners[2].x,19000);
  assert.equal(r.status(),before,'straight away');await wait(400);assert.equal(r.status(),before,'and later');assert.equal(r.previews(),n,'no new check is needed');});

test('the gate cannot be dragged or keyed onto a solid fixture; a gate typed onto one says so',async t=>{
  const office={id:'F1',kind:'OFFICE',name:'Yard office',x:12000,y:10000,w:6000,h:3000};
  const d=draftFrom(yard({fixtures:[office]}),'yard');
  assert.equal(canPlace(d,'gate',{x:14000,y:11000}),false);assert.equal(canPlace(d,'gate',{x:6000,y:1000}),true);assert.equal(canPlace(d,'gate',{x:1500,y:1000}),false,'still clear of loading');
  assert.equal(canPlace(d,'loading',{x:14000,y:11000}),false);
  const lane=draftFrom(yard({fixtures:[{...office,kind:'ENTRY',name:'Truck entry'}]}),'yard');assert.equal(canPlace(lane,'gate',{x:14000,y:11000}),true,'a truck lane is not solid');
  const typed=reduce(d,{t:'zone',which:'gate',x:14000,y:11000}),gp=problems(typed).find(p=>p.zone==='gate');
  assert.match(gp.message,/^The gate is on Yard office; it moves to [\d.]+, [\d.]+ m when you save\.$/);assert.equal(gp.blocking,false);
  const r=rig(t,server({fixtures:[office]}));await wait(30);
  r.pointer('pointerdown',4000,1500,'gate');r.pointer('pointermove',14500,11500);await wait(5);r.pointer('pointerup',14500,11500);
  assert.deepEqual(r.ed.draft.gate,{x:3500,y:1000},'the drop on the office is refused');});

test('each side row groups the length with its unit and the two buttons',()=>{
  const html=editorMarkup(reduce(draftFrom(yard(),'yard'),{t:'preset',p:'CUSTOM'}));
  assert.match(html,/<li data-side-row="0"><span class="side-name">Side 1 →<\/span><span class="side-len"><input id="side-len-0" [^>]*> m<\/span><span class="side-actions"><button type="button" class="text-button" data-split="0">Add corner<\/button> <button type="button" class="text-button" data-remove-corner="1">Remove corner 2<\/button><\/span><\/li>/);
  for(const li of html.match(/<li data-side-row[\s\S]*?<\/li>/g)){const top=li.replace(/^<li[^>]*>|<\/li>$/g,'').replace(/<span class="(side-name|side-len|side-actions)">(?:[^<]|<(?!\/?span)[^>]*>|<span[^>]*>[^<]*<\/span>)*<\/span>/g,'');assert.equal(top,'','nothing but the three groups: '+top);}});

test('zone and fixture labels fit their box: shrunk at the default zoom of a 35 m yard, 13 px when zoomed in, left out when too small',()=>{
  const d=draftFrom(yard({points:[{x:0,y:0},{x:35000,y:0},{x:35000,y:16000},{x:0,y:16000}],fixtures:[{id:'F7',kind:'TOILET',name:'Toilet',x:30000,y:12000,w:1500,h:1500},{id:'F8',kind:'OFFICE',name:'Yard office',x:12000,y:10000,w:6000,h:3000},{id:'F9',kind:'CUSTOM',name:'Custom fixture',x:25000,y:3000,w:2000,h:2000}]}),'yard');
  const labels=(svg,k)=>Object.fromEntries([...svg.matchAll(/<g class="(zone zone-\w+|fixture)[^"]*"[^>]*><rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*\/>(?:<text x="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>|<title>([^<]*)<\/title>)/g)].map(m=>[m[6]??m[7],m[6]?{x:+m[4],px:+m[5]/k,left:+m[2],w:+m[3]}:null]));
  const view=fitBox(d,[],800,560),k=view.w/800,at=labels(planSVG(d,{view}),k);
  const EM={LOADING:4.49,LOAD:2.67,GATE:2.46,'Yard office':5.01,Toilet:2.61},width=(t,px)=>EM[t]*px*k;// measured in Edge: Segoe UI, weight 650
  for(const name of ['GATE','Yard office','Toilet']){const l=at[name];assert.ok(l,name+' is labelled');assert.ok(l.px>=7&&l.px<=13.001,name+' '+l.px);assert.ok(width(name,l.px)<=l.w,name+' fits its box');}
  const load=at.LOADING??at.LOAD;if(load)assert.ok(width(at.LOADING?'LOADING':'LOAD',load.px)<=2000);
  const lx=load?load.x+width(at.LOADING?'LOADING':'LOAD',load.px)/2:2000,gx=at.GATE.x-width('GATE',at.GATE.px)/2;assert.ok(lx<gx,'LOADING and GATE do not run into each other');
  assert.equal(at['Custom fixture'],null,'a 2 m box is too small for "Custom fixture" at this zoom; the name stays in a tooltip');
  const zin={x:0,y:0,w:8000,h:5600},big=labels(planSVG(d,{view:zin}),zin.w/800);
  assert.ok(Math.abs(big.LOADING.px-13)<0.001&&Math.abs(big.GATE.px-13)<0.001,"13 px when zoomed in");
  assert.equal(labelPx('LOADING',2000,1500,500),null);assert.equal(labelPx('GATE',2000,1500,10),13);});
test('the status names the real reason stillages move: loading zone, fixtures or height',()=>{
  const d=draftFrom(yard({points:[{x:0,y:0},{x:25000,y:0},{x:25000,y:16000},{x:0,y:16000}],fixtures:[]}),'yard');
  const onZone=reduce(d,{t:'zone',which:'loading',x:4000,y:8000});
  assert.match(statusOf(onZone,{stock:[{id:'b',name:'B',x:4000,y:8000,w:2000,h:1000,height:1000}]}).text,/1 stillage will be moved off the loading zone: B \(red on the plan\)\./);
  const low=reduce(d,{t:'height',mm:1500});
  assert.match(statusOf(low,{stock:[{id:'a',name:'A',x:4000,y:4000,w:2000,h:1000,height:1000},{id:'u',name:'U',x:4000,y:4000,w:2000,h:1000,height:1000,support:'a'}]}).text,/1 stillage will be set down to fit the new height: U/);
});
