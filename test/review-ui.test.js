import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './simulation.test.js';
import { yardSVG } from '../public/visual.js';
import { stopOperations } from '../public/operations.js';
// Regression tests for the review of the shape editor and one-click turning (UI side). The operations page runs in node with no DOM.
const ops=f=>({permissions:['operations.manage','stock.adjust','requests.create'],systems:[],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});
const load=async()=>(await import('../public/operations.js')).__test;
const css=readFileSync(new URL('../public/design.css',import.meta.url),'utf8');
const workspace={querySelector:s=>s===':scope>.workspace'?{}:null},accountPage={querySelector:()=>null};
// A fake server: turn-preview answers from the live simulation (optionally slowly), state returns a snapshot, rotate commands go through fetch.
function wire(t,T,f,{delay=0}={}){const calls=[],notes=[],rotates=[];const realFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{rotates.push(String(url));try{const r=f.cmd('rotate',JSON.parse(init.body));return {ok:true,json:async()=>({message:r.plan.message,plan:r.plan})};}catch(e){return {ok:false,json:async()=>({error:e.message})};}};
  T.wire({live:true,notify:m=>notes.push(m),api:async(path,data)=>{calls.push(path);if(delay)await new Promise(r=>setTimeout(r,delay));if(path==='turn-preview')return f.sim.turnPreview(data);if(path.startsWith('state'))return f.sim.snapshot();throw new Error('unexpected '+path);}});
  t.after(()=>{globalThis.fetch=realFetch;T.wire({live:false});T.setApp(null);T.setSelected(null);T.setShapeEditor(null);T.containerPage(0);});return {calls,notes,rotates};}

test('n6: leaving Operations unregisters page keys, and keys never reach Operations while another page is showing',async t=>{const T=await load();t.after(()=>{T.wire({live:false});T.setApp(null);});
  let pressed=0;T.setApp(workspace);T.wire({live:true});const before=T.keyHandlerCount();T.addRenderKey(()=>pressed++);
  T.dispatchKey({key:'r'});assert.equal(pressed,1,'R reaches the Operations page while it is showing');
  T.setApp(accountPage);T.dispatchKey({key:'r'});assert.equal(pressed,1,'the Account page replaced the workspace: R is ignored');
  T.setApp(workspace);stopOperations();assert.equal(T.renderKeyCount(),0,'stopOperations drops the page key handlers');assert.equal(T.keyHandlerCount(),before,'and unregisters them');
  T.dispatchKey({key:'r'});assert.equal(pressed,1,'nothing is dispatched after stopOperations');});

test('n6: a refresh that lands after leaving Operations does not touch the page',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot();T.setState(s,ops(f));t.after(()=>T.wire({live:false}));
  T.wire({live:true,api:async()=>({...s,containerCount:150})});stopOperations();await T.refresh(true);assert.equal(T.pager(),'','the late state is dropped, so nothing is rebuilt over the Account page');});

test('n7: the turn check is keyed on everything turnPlan reads, and a stale refusal is re-checked before R refuses',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot();T.setState(s,ops(f));T.setSelected(f.a.id);const w=wire(t,T,f);t.after(()=>T.setTurnInfo(f.a.id,null));
  const a=s.containers.find(c=>c.id===f.a.id),key=T.turnKey(a),again=m=>{const n=structuredClone(s);m(n);T.setState(n,ops(f));const k=T.turnKey(n.containers.find(c=>c.id===f.a.id));T.setState(s,ops(f));return k;};
  assert.equal(again(()=>{}),key,'an unchanged state keeps the key');
  assert.notEqual(again(n=>n.resources.push({id:'k2',type:'FORKLIFT',location:f.yard.id,enabled:true,capacity:1500000,reach:4000})),key,'a new forklift re-checks');
  assert.notEqual(again(n=>{n.resources.find(r=>r.type==='FORKLIFT'&&r.location===f.yard.id).enabled=false;}),key,'a disabled forklift re-checks');
  assert.notEqual(again(n=>{n.config.paused=true;}),key,'pausing re-checks');
  assert.notEqual(again(n=>{n.yards[0].fixtures=[{kind:'OFFICE',name:'Office',x:5000,y:4000,w:2000,h:2000}];}),key,'a fixture re-checks');
  assert.notEqual(again(n=>{n.yards[0].points=[{x:0,y:0},{x:30000,y:0},{x:30000,y:16000},{x:0,y:16000}];n.yards[0].shapeRev=2;}),key,'a new yard shape re-checks');
  assert.notEqual(again(n=>{n.counts=[...(n.counts??[]),{id:'n1',state:'OPEN',scope:f.yard.id}];}),key,'an open stocktake re-checks');
  assert.notEqual(again(n=>{n.balances.find(b=>b.container===f.a.id).quantity=99;}),key,'a change of contents (weight) re-checks');
  // The page cached "no forklift" under the current key; the owner has since fixed it. R must ask the server again instead of repeating the refusal.
  T.setTurnInfo(f.a.id,{ok:false,container:f.a.id,message:'There is no forklift at Yard. Add one first.'},key);
  await T.turnNow(f.a.id);
  assert.deepEqual(w.calls.filter(c=>c==='turn-preview'),['turn-preview'],'the refusal is checked again');assert.equal(w.rotates.length,1,'and the turn is sent');assert.match(w.notes[0],/^The forklift will lift A/);assert.ok(!w.notes.some(n=>/no forklift/.test(n)),'the stale refusal is never shown');
  assert.equal(f.sim.snapshot().tasks.filter(x=>x.turn).length,1);});

test('n7: a fresh ok plan for the current state is used as is; one cached under an old key is checked again',async t=>{const f=fixture(t),T=await load();const s=f.sim.snapshot();T.setState(s,ops(f));T.setSelected(f.a.id);const w=wire(t,T,f);t.after(()=>{T.setTurnInfo(f.a.id,null);T.setTurnInfo(f.b.id,null);});
  const a=s.containers.find(c=>c.id===f.a.id);T.setTurnInfo(f.a.id,f.sim.turnPreview({container:f.a.id}),T.turnKey(a));await T.turnNow(f.a.id);
  assert.equal(w.calls.filter(c=>c==='turn-preview').length,0);assert.equal(w.rotates.length,1);
  T.setState(f.sim.snapshot(),ops(f));T.setSelected(f.b.id);T.setTurnInfo(f.b.id,{ok:true,moves:[{}],message:'old'},'stale-key');await T.turnNow(f.b.id);assert.equal(w.calls.filter(c=>c==='turn-preview').length,1,'a plan cached under an old key is checked again');});

test('n8: a double-click (or two R presses) while the room is still being checked sends one turn and shows no false refusal',async t=>{const f=fixture(t),T=await load();T.setState(f.sim.snapshot(),ops(f));T.setSelected(f.a.id);T.setTurnInfo(f.a.id,null);const w=wire(t,T,f,{delay:60});
  await Promise.all([T.turnNow(f.a.id),T.turnNow(f.a.id)]);
  assert.equal(w.rotates.length,1,'one rotate command');assert.equal(w.calls.filter(c=>c==='turn-preview').length,1,'one preview');assert.equal(w.notes.length,1);assert.match(w.notes[0],/^The forklift will lift A/);
  assert.equal(f.sim.snapshot().tasks.filter(x=>x.turn).length,1);
  // Busy is released afterwards whatever happened, here after a refusal.
  T.setState(f.sim.snapshot(),ops(f));await T.turnNow(f.a.id);assert.match(w.notes.at(-1),/already has a movement waiting/);await T.turnNow(f.a.id);assert.equal(w.notes.length,3,'the stillage is not left busy after a refusal');});

test('n9: the 100-stillage pager is hidden while the shape editor is open, and an out-of-range page is pulled back',async t=>{const f=fixture(t),T=await load();const s={...f.sim.snapshot(),containerCount:102};T.setState(s,ops(f));const calls=[];
  t.after(()=>{T.wire({live:false});T.setShapeEditor(null);T.containerPage(0);});
  assert.ok(T.pager().includes('Stillages / cages 1–100 of 102'),T.pager());
  T.setShapeEditor({target:{kind:'yard',id:f.yard.id},dirty:()=>false,confirmLeave:()=>true,mount(){},update(){},destroy(){}});assert.equal(T.pager(),'','no pager above the editor');T.setShapeEditor(null);
  T.wire({live:true,api:async p=>{calls.push(p);return s;}});T.containerPage(4);await T.refresh(true);
  assert.deepEqual(calls,['state?page=4','state?page=1'],'page 4 of 102 stillages is fetched again as the last page');assert.equal(T.containerPage(),1);assert.ok(T.pager().includes('101–102 of 102'));assert.match(T.pager(),/id="next-page" disabled/);
  T.containerPage(-1);await T.refresh(true);assert.equal(T.containerPage(),0);});

test('n12: a carried turn that is blocked says BLOCKED, without the turn symbol',t=>{const f=fixture(t);const r=f.cmd('rotate',{container:f.a.id,rotation:90}),id=r.tasks[0].id;
  for(let i=0;i<50&&f.sim.repo.get(id).state!=='CARRYING';i++)f.tick(1);const s=f.sim.snapshot(),task=s.tasks.find(x=>x.id===id),y=s.yards.find(x=>x.id===f.yard.id);assert.equal(task.state,'CARRYING');
  const carried=svg=>svg.match(/<g class="carried-turn[^"]*"[\s\S]*?<\/g><\/g>/)?.[0]??'',rect=g=>g.match(/<rect x="[-\d]+" y="[-\d]+" width="(\d+)" height="(\d+)"/).slice(1).map(Number);
  let g=carried(yardSVG(y,s.containers,[task]));assert.ok(g.includes('A · TURNING')&&g.includes('⟳'),'carrying: TURNING');
  g=carried(yardSVG(y,s.containers,[{...task,state:'BLOCKED',resumeState:'CARRYING',reason:'Placement is obstructed'}]));
  assert.ok(g.includes('A · BLOCKED'),g);assert.ok(!g.includes('TURNING')&&!g.includes('⟳'),'no turning caption or symbol');assert.ok(g.includes('turn blocked: Placement is obstructed'));assert.ok(g.includes('class="carried-turn blocked"'));assert.deepEqual(rect(g),[2000,1000],'drawn as it was picked up');
  g=carried(yardSVG(y,s.containers,[{...task,state:'BLOCKED',resumeState:'PLACING'}]));assert.ok(g.includes('A · BLOCKED'));assert.deepEqual(rect(g),[1000,2000],'blocked while setting down: drawn turned');});

test('n14: corner badges sit under the stillages and never take a click',t=>{const f=fixture(t);const s=f.sim.snapshot(),y=s.yards.find(x=>x.id===f.yard.id);
  const svg=yardSVG(y,[{...s.containers.find(c=>c.id===f.a.id),x:0,y:0}],[],null,[],[],null,{cornerNumbers:true});
  assert.match(svg,/<g class="corner-number" data-corner="1" transform="[^"]+" pointer-events="none">/);assert.ok(svg.indexOf('class="corner-number"')<svg.indexOf('data-select='),'badges are drawn before the stillages');
  assert.match(css,/\.corner-number,\.corner-number \*\{pointer-events:none\}/);});

test('n10, n11, n13: shape editor rows fit their column (measured in headless Edge at 1920, 1400, 1280, 1024 and 375 px)',()=>{
  assert.ok(!/\.shape-fixture\{[^}]*minmax\(110px/.test(css),'fixture rows have no 521 px minimum');assert.match(css,/\.shape-fixture\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);assert.match(css,/@container \(min-width:560px\)\{\.shape-fixture\{/,'one line only where the column has room');
  assert.match(css,/\.shape-corners\{width:auto;min-width:0;/,'the corner table ignores the global 520 px phone minimum');
  assert.match(css,/\.shape-sides li\{display:flex;flex-wrap:wrap;/);assert.match(css,/\.side-len\{display:inline-flex;[^}]*white-space:nowrap\}/,'the input and its unit stay together');assert.match(css,/@container \(max-width:430px\)\{\.side-actions\{flex-basis:100%/,'on a narrow column the actions take their own line');});
