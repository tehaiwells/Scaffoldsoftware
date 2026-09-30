process.env.TZ='Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addDays } from '../src/domain/schedule.js';
import { addMonths } from '../src/domain/paperwork.js';
import { Simulation } from '../src/simulation.js';
import { planFixture,D0,L } from './helpers/plan-fixture.js';

// Phase 0, D15: a SWMS is "last reviewed", not "expires". It is flagged when its last review is older than the review period (12 months unless
// the owner changes it). A company-wide SWMS never clears a site's own warning. JHSAs and permits keep their expiry dates.
const OWNER=['company.manage','users.manage','operations.manage','sites.assigned','requests.create','finance.view','stock.adjust'];
const acct=(f,perms=OWNER)=>({permissions:perms,systems:[],users:[],company:{id:'c',name:'Tee Scaffolding'},user:{id:f.user.id,name:'Owner'}});
function world(t){const f=planFixture(t,{now:L(D0,'09:00')});const a=f.site('Bondi'),b=f.site('Parramatta');const {p,per}=f.stock(1);
  f.cmd('gameSend',{site:a.id,lines:[{product:p.id,quantity:per}]});assert.ok(f.until(()=>f.piecesAt(a.id,p.id)>0,600));f.cmd('planWorkers',{day:addDays(D0,2),site:b.id,count:1});return {f,a,b};}
const paper=f=>f.sim.todayView().paperwork;

test('addMonths keeps the day inside the month',()=>{
  assert.equal(addMonths('2026-10-13',12),'2027-10-13');assert.equal(addMonths('2026-01-31',1),'2026-02-28');assert.equal(addMonths('2027-12-15',2),'2028-02-15');assert.equal(addMonths('2028-02-29',12),'2029-02-28');
});

test('a SWMS keeps its last review day and is flagged 12 months on: reviewed, due soon, overdue; never "expired"',t=>{
  const {f,a,b}=world(t);
  const fresh=f.cmd('paperworkAdd',{type:'SWMS',site:a.id,reviewedOn:addDays(D0,-10)});assert.equal(fresh.message,'SWMS for Bondi saved. Reviewed 3 Oct.');
  const r=f.sim.repo.get(fresh.paperwork.id,'paperwork');assert.equal(r.reviewedOn,addDays(D0,-10));assert.equal(r.expiresOn,null,'no expiry is stored for a SWMS');
  const soon=f.cmd('paperworkAdd',{type:'SWMS',site:b.id,reviewedOn:addDays(addMonths(D0,-12),5)});assert.equal(soon.message,'SWMS for Parramatta saved. Review due in 5 days.');
  const old=f.cmd('paperworkAdd',{type:'SWMS',title:'Hoist SWMS',site:a.id,reviewedOn:addMonths(D0,-13)});assert.equal(old.message,'Hoist SWMS for Bondi saved. Its review is overdue.');
  const v=paper(f);assert.deepEqual(v.items.map(i=>[i.title,i.status,i.words]),[['Hoist SWMS','EXPIRED','Review overdue: last reviewed 13 Sep 2025'],['SWMS','SOON','Review due in 5 days'],['SWMS','OK','Reviewed 3 Oct']]);
  assert.ok(v.items.every(i=>i.review));assert.deepEqual(v.counts,{expired:0,review:1,soon:1,ok:1});assert.equal(v.words,'1 SWMS due for review · 1 due soon');assert.ok(!/expire/i.test(JSON.stringify(v.items.map(i=>i.words))));
  const al=f.sim.snapshot().alerts.items.filter(x=>x.kind==='PAPERWORK');assert.equal(al.find(x=>x.title==='Hoist SWMS – Bondi').severity,'medium');assert.match(al.find(x=>x.title==='Hoist SWMS – Bondi').detail,/^Review overdue: .+ · mark it reviewed on the Today page$/);
  assert.throws(()=>f.cmd('paperworkAdd',{type:'SWMS',site:a.id,reviewedOn:addDays(D0,1)}),/The last review can't be in the future/);
  // marked reviewed today: good for another 12 months
  const up=f.cmd('paperworkUpdate',{id:old.paperwork.id,reviewedOn:D0});assert.match(up.message,/^Hoist SWMS marked as reviewed on .+\. Next review due 13 Oct 2027\.$/);assert.equal(paper(f).counts.review,0);
  // JHSAs and permits still run out on a date; they cannot be "reviewed"
  const j=f.cmd('paperworkAdd',{type:'JHSA',site:a.id,expiresOn:addDays(D0,-1)});assert.equal(j.message,'JHSA for Bondi saved. It has expired (yesterday).');
  assert.throws(()=>f.cmd('paperworkUpdate',{id:j.paperwork.id,reviewedOn:D0}),/Only a SWMS is reviewed/);
});

test('the owner sets the review period; nobody else can',t=>{
  const {f,a}=world(t);const s=f.cmd('paperworkAdd',{type:'SWMS',site:a.id,reviewedOn:addMonths(D0,-7)});assert.equal(paper(f).items[0].status,'OK');
  const r=f.cmd('paperworkSettings',{swmsReviewMonths:6});assert.equal(r.message,'A SWMS is now flagged for review 6 months after its last review.');
  const v=paper(f);assert.equal(v.reviewMonths,6);assert.equal(v.items[0].status,'EXPIRED');assert.equal(v.canSetReview,true);
  assert.throws(()=>f.cmd('paperworkSettings',{swmsReviewMonths:0}),/Review period/);
  // a general manager (no company.manage) cannot change it
  const email=randomUUID()+'@example.com';f.auth.addUser(f.sim.user,{name:'Mia',email,password:'demonstration-password',roles:['GENERAL_MANAGER']});
  const mia=f.auth.authenticate(f.auth.login({email,password:'demonstration-password'}));const sim=new Simulation(f.db,mia);
  assert.throws(()=>sim.execute('paperworkSettings',{swmsReviewMonths:24},randomUUID()),/Your role does not allow this action/);assert.equal(sim.todayView().paperwork.canSetReview,false);
  assert.equal(s.paperwork.type,'SWMS');
});

test('a company-wide SWMS never clears the warning for a site with no SWMS of its own',t=>{
  const {f,a}=world(t);assert.deepEqual(paper(f).missing.map(m=>m.siteName),['Bondi','Parramatta']);
  f.cmd('paperworkAdd',{type:'SWMS',reviewedOn:D0});let v=paper(f);assert.deepEqual(v.missing.map(m=>m.siteName),['Bondi','Parramatta'],'still named');assert.equal(v.companySwms,true);
  f.cmd('paperworkAdd',{type:'SWMS',site:a.id,reviewedOn:D0});v=paper(f);assert.deepEqual(v.missing.map(m=>m.siteName),['Parramatta']);
});

test('a SWMS saved before this rule (a date, no review day) loads unchanged and that date is when to review it by',t=>{
  const {f,a}=world(t);const id=f.sim.repo.add('paperwork',{type:'SWMS',title:'SWMS',site:a.id,expiresOn:addDays(D0,40),reference:null,note:null,createdAt:new Date().toISOString(),by:f.user.id,renewedAt:null,archived:false}).id;
  const i=paper(f).items.find(x=>x.id===id);assert.equal(i.status,'OK');assert.equal(i.words,'Review by 22 Nov');assert.equal(i.review,true);assert.equal(i.expiresOn,addDays(D0,40));
  f.cmd('paperworkUpdate',{id,reviewedOn:D0});const r=f.sim.repo.get(id,'paperwork');assert.equal(r.reviewedOn,D0);assert.equal(r.expiresOn,null);
});

test('the Today card and form: "Last reviewed" for a SWMS (today by default, no future), "Runs out on" for the rest, a Reviewed button, the review period line for the owner',async t=>{
  const {f,a}=world(t);f.cmd('paperworkAdd',{type:'SWMS',site:a.id,reviewedOn:addMonths(D0,-13)});f.cmd('paperworkAdd',{type:'JHSA',site:a.id,expiresOn:addDays(D0,30)});
  const m=await import('../public/operations.js'),T=m.__test,td=m.tdTest;td.reset();T.setState(f.sim.snapshot(),acct(f));T.setView('TODAY');
  const today=f.sim.todayView();td.setData(f.sim.planMonth(D0.slice(0,7)),today);td.select(D0);td.toggle('paper-all');let html=td.view();const card=html.slice(html.indexOf('id="tdh-paper"'));
  assert.ok(card.includes('<span class="tdh-pill wait">Review overdue: last reviewed 13 Sep 2025</span>'),'amber, not the red of an expired paper');
  assert.match(card,/data-tdh-mini="paper:[^"|]+\|renew">Mark reviewed<\/button>/,'an action, not a status');assert.match(card,/data-tdh-mini="paper:[^"|]+\|renew">Renew<\/button>/,'the JHSA is still renewed');
  assert.ok(card.includes('A SWMS is flagged for review 12 months after its last review.'),'the owner sees the period');assert.ok(card.includes('No SWMS on file for Parramatta'));
  const swms=today.paperwork.items.find(i=>i.type==='SWMS');td.mini('paper:'+swms.id,'renew');html=td.view();
  assert.ok(html.includes('<span>Reviewed on</span><input type="date" name="reviewedOn" value="'+D0+'" max="'+D0+'" required>'));assert.ok(html.includes('Save the review date'));
  td.mini('paper:review','review');html=td.view();assert.ok(html.includes('Flag a SWMS for review after')&&html.includes('<option value="12" selected>12 months</option>'));td.mini(null);
  td.openForm('PAPER',D0);html=td.view();assert.ok(html.includes('<span>Last reviewed</span><input type="date" name="reviewedOn" value="'+D0+'" max="'+D0+'" required>'),'a SWMS asks when it was last reviewed');
  assert.ok(html.includes('Flagged for review 12 months after its last review'));assert.ok(!html.includes('Runs out on'));
  td.openForm('PAPER',D0,{type:'PERMIT'});html=td.view();assert.ok(html.includes('<span>Runs out on</span>'));
  // not the owner: no period line
  td.reset();T.setState(f.sim.snapshot(),acct(f,['operations.manage','requests.create','stock.adjust']));T.setView('TODAY');td.setData(f.sim.planMonth(D0.slice(0,7)),{...today,paperwork:{...today.paperwork,canSetReview:false}});td.select(D0);
  assert.ok(!td.view().includes('A SWMS is flagged for review'));td.reset();
});
