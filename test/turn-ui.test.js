import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';
import { fixture } from './simulation.test.js';
// The operations page in node, with no DOM: the view functions are pure string builders (see test/jobs.test.js).
const ops=f=>({permissions:['operations.manage','stock.adjust','requests.create'],systems:[],users:[],company:{id:'c',name:'Demo'},user:{id:f.user.id}});
const supervisorOf=f=>({...ops(f),permissions:['requests.create']});
const load=async()=>(await import('../public/operations.js')).__test;
const turnButton=(html,id)=>html.match(new RegExp('<button type="button" data-turn="'+id+'"[^>]*>[^<]*</button>'))?.[0]??'';
const reset=T=>{T.setShapeEditor(null);T.setSelected(null);T.setLayoutDraft(null);};

test('the detail panel and the selection bar under the plan offer a one-click turn to operations users only',async t=>{const f=fixture(t),T=await load();t.after(()=>reset(T));const s=f.sim.snapshot();
  T.setState(s,ops(f));T.setView('YARD');T.setSelected(f.a.id);
  const detail=T.detail(),bar=T.selectionBar(f.yard.id);
  assert.match(turnButton(detail,f.a.id),/>⟳ Turn 90°</,'the detail panel has the turn button');assert.ok(!/disabled/.test(turnButton(detail,f.a.id)),'enabled while the room is still being checked');assert.ok(detail.includes('Checking room to turn…'));
  assert.ok(bar.includes('class="plan-selection" data-turn-for="'+f.a.id+'"'),'the selection bar sits under the plan');assert.match(turnButton(bar,f.a.id),/⟳ Turn 90°/);assert.ok(bar.includes('All details for A ↓'));
  const yard=T.yardView();assert.ok(yard.includes('<div class="plan-wrap" data-plan-for="'+f.yard.id+'">'),'the plan is wrapped for the overlay button');assert.ok(yard.includes('class="plan-turn" data-turn="'+f.a.id+'" aria-label="Turn A 90 degrees (R)"'),'the overlay turn button is placed over the plan');
  assert.ok(yard.indexOf('class="plan-selection"')>yard.indexOf('data-plan-for'),'the selection bar comes right after the plan');
  T.setState(s,supervisorOf(f));
  assert.ok(!T.detail().includes('data-turn='),'no turn control in the detail panel for a supervisor');assert.ok(!T.selectionBar(f.yard.id).includes('data-turn='),'no turn control in the selection bar for a supervisor');assert.ok(T.selectionBar(f.yard.id).includes('where-line'),'the supervisor still sees where it is');});

test('the cached turn plan drives the label, the hint and the disabled state; a request in flight renders Sending…',async t=>{const f=fixture(t),T=await load();t.after(()=>{T.setTurnInfo(f.a.id,null);T.setTurnInfo(f.b.id,null);T.setTurnBusy(f.a.id,false);reset(T);});
  const U=f.container('U',7000,4000,{support:f.b.id});const s=f.sim.snapshot();T.setState(s,ops(f));T.setView('YARD');
  T.setSelected(f.a.id);T.setTurnInfo(f.a.id,f.sim.turnPreview({container:f.a.id}));
  let html=T.detail();assert.ok(html.includes('Turns where it stands.'),'a free stillage turns about its middle');assert.match(turnButton(html,f.a.id),/⟳ Turn 90°/);
  T.setSelected(f.b.id);const pile=f.sim.turnPreview({container:f.b.id});assert.equal(pile.moves.length,2);T.setTurnInfo(f.b.id,pile);
  html=T.detail();assert.match(turnButton(html,f.b.id),/⟳ Turn whole pile 90°/,'a pile turns as a whole');assert.ok(html.includes('Whole pile: 2 stillages, 3 forklift moves (sets U down nearby, turns B, puts it back).'),html.match(/turn-hint[^<]*</)?.[0]);
  T.setSelected(f.a.id);T.setTurnInfo(f.a.id,{ok:false,container:f.a.id,message:'A is marked damaged. The crew only handles serviceable stillages; change its condition first.'});
  html=T.detail();const refused=turnButton(html,f.a.id);assert.match(refused,/disabled/,'a refusal disables the button');assert.match(refused,/title="A is marked damaged\./,'and the button carries the refusal');assert.ok(html.includes('<span class="turn-hint bad" role="status">A is marked damaged.'));
  assert.match(T.yardView(),/class="plan-turn" data-turn="[^"]+" aria-label="Turn A 90 degrees \(R\)" title="A is marked damaged[^"]*" disabled hidden>/,'the overlay button is disabled with the refusal as its title');
  T.setTurnInfo(f.a.id,null);T.setTurnBusy(f.a.id,true);
  const busy=turnButton(T.detail(),f.a.id);assert.match(busy,/disabled/);assert.match(busy,/>Sending…</,'a rebuild while the command is in flight can never re-enable the button');
  assert.ok(U.id);});

test('the move form is pre-filled with where the stillage is now',async t=>{const f=fixture(t),T=await load();t.after(()=>reset(T));const U=f.container('U',7000,4000,{support:f.b.id});T.setState(f.sim.snapshot(),ops(f));
  T.setSelected(f.a.id);let html=T.detail();assert.ok(html.includes('name="x" value="4000"')&&html.includes('name="y" value="4000"'),'X and Y are the current spot');assert.ok(html.includes('<option selected>0</option><option >90</option>'),'the rotation is the current one');
  T.setSelected(U.id);html=T.detail();assert.ok(html.includes('name="x" value="7000"'));assert.ok(html.includes('<option value="'+f.b.id+'" selected>B</option>'),'the support is the stillage it sits on');});

test('where-line names the long side against the numbered sides of the plan',async t=>{const f=fixture(t),T=await load();t.after(()=>reset(T));const U=f.container('U',7000,4000,{support:f.b.id});const s=f.sim.snapshot();T.setState(s,ops(f));
  const a=s.containers.find(c=>c.id===f.a.id);
  let line=T.whereLine(a);assert.ok(line.includes('Yard · 4.0, 4.0 m · 2.0 × 1.0 m · long side along side 1 (20.0 m) · on the ground'),line);assert.ok(line.includes('class="orient-icon"'));
  line=T.whereLine({...a,rotation:90});assert.ok(line.includes('1.0 × 2.0 m · long side along side 2 (16.0 m)'),line);
  assert.ok(T.whereLine(s.containers.find(c=>c.id===U.id)).includes('on B (level 2 of 2)'));assert.ok(T.whereLine(s.containers.find(c=>c.id===f.b.id)).includes('bottom of a pile of 2'));
  T.setSelected(f.a.id);T.setView('YARD');assert.ok(T.detail().includes('long side along side 1 (20.0 m)'),'the detail panel shows the same line');});

test('the shape editor replaces the old line-by-line builder; supervisors are told the office manages the layout',async t=>{const f=fixture(t),T=await load();t.after(()=>reset(T));const s=f.sim.snapshot();T.setState(s,ops(f));T.setView('YARD');
  let html=T.yardView();for(const gone of ['id="segment"','Add segment','Preview and close perimeter','close-yard','save-yard','data-fixture-add','cancel-builder'])assert.ok(!html.includes(gone),'the old builder is gone: '+gone);
  assert.ok(html.includes('<div class="plan-head-actions"><span>20.0 × 16.0 m · 320.0 m² · 1 m grid</span><button type="button" class="secondary" id="edit-shape">Change yard shape &amp; size</button></div>'),'the header button sits next to the size');assert.ok(html.includes('id="edit-yard">Change yard shape, size &amp; fixtures</button>'));
  assert.ok(html.includes('container-card'),'container cards without the editor');
  T.setView('HOME');assert.ok(T.homeView().includes('id="edit-shape"'),'Home has the same header button');assert.ok(T.homeView().includes('Turn view'),'the plan tool that turns the view is not confused with turning a stillage');assert.ok(!T.homeView().includes('&#8634; Rotate'));
  T.setView('SITES');html=T.siteView();assert.ok(html.includes('data-site-panel="'+f.site.id+'"'));assert.ok(html.includes('data-edit-site="'+f.site.id+'">Change site shape &amp; size</button>'));
  const editor=target=>({get target(){return target;},dirty:()=>false,confirmLeave:()=>true,mount(){},update(){},destroy(){}});
  T.setShapeEditor(editor({kind:'yard',id:f.yard.id}));T.setView('YARD');html=T.yardView();assert.equal(html,'<div id="shape-host" class="shape-host"></div>','only the editor is on the page');assert.ok(!html.includes('container-card'));
  assert.ok(T.editorHTML().includes('id="shape-host"'));T.setView('HOME');assert.ok(T.homeView().includes('id="shape-host"'));
  T.setView('SITES');assert.ok(!T.siteView().includes('shape-host'),'a yard editor leaves the sites page alone');
  T.setShapeEditor(editor({kind:'site',id:f.site.id}));assert.equal(T.siteView(),'<div id="shape-host" class="shape-host"></div>');T.setView('YARD');assert.ok(!T.yardView().includes('shape-host'));T.setShapeEditor(null);
  f.auth.addUser(f.user,{name:'Supervisor',email:'supervisor-'+f.user.id+'@example.com',password:'demonstration-password',roles:['SUPERVISOR']});
  const sup=f.auth.authenticate(f.auth.login({email:'supervisor-'+f.user.id+'@example.com',password:'demonstration-password'})),restricted=new Simulation(f.db,sup).snapshot();assert.equal(restricted.yards.length,0);
  T.setState(restricted,supervisorOf(f));html=T.yardView();assert.ok(html.includes('<section class="panel"><h2>Yard layout</h2><p>The office manages the yard layout.</p></section>'));assert.ok(!html.includes('shape-host')&&!html.includes('edit-shape'));});

test('a queued turn shows in Movement activity, on the layouts panel and as a status line instead of the button',async t=>{const f=fixture(t),T=await load();t.after(()=>reset(T));const U=f.container('U',7000,4000,{support:f.b.id});
  f.cmd('rotate',{container:f.a.id,rotation:90});f.cmd('rotate',{container:f.b.id,rotation:90});const s=f.sim.snapshot();T.setState(s,ops(f));T.setView('YARD');
  const activity=T.activityPanel();for(const badge of ['TURN 90°','TURN SET DOWN 1','TURN STEP 2','TURN STEP 3'])assert.ok(activity.includes('<span class="badge turn">'+badge+'</span>'),'badge '+badge);assert.ok(activity.includes('Turn A'));
  assert.ok(T.layoutsPanel().includes('<span class="badge turn">PILE TURN</span>'),'a pile turn is marked on the layouts panel');
  T.setSelected(f.a.id);let bar=T.selectionBar(f.yard.id);assert.ok(bar.includes('Turning: waiting for a forklift'),bar);assert.ok(!bar.includes('data-turn="'),'no second turn while one waits');const task=s.tasks.find(x=>x.turn&&!x.layout);assert.ok(bar.includes('data-cancel="'+task.id+'">Cancel turn</button>'));
  assert.ok(!T.yardView().includes('class="plan-turn"'),'no overlay button during an active turn');
  T.setSelected(U.id);bar=T.selectionBar(f.yard.id);assert.ok(bar.includes('Turning the pile: 0 of 3 moves done'),bar);assert.ok(/data-cancel-layout="[^"]+">Cancel turn<\/button>/.test(bar));});

test('yard and site plans carry corner numbers that match the shape editor',async t=>{const f=fixture(t),T=await load();t.after(()=>reset(T));T.setState(f.sim.snapshot(),ops(f));T.setView('YARD');
  assert.ok(T.yardView().includes('corner-number'),'the yard plan is drawn with numbered corners');T.setView('SITES');assert.ok(T.siteView().includes('corner-number'),'so is each site plan');});
