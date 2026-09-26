process.env.TZ='Australia/Sydney';// the server's local day is Sydney's in this file
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './simulation.test.js';
import { hireBook,hireArrive,hireLeave,hireReopen,hirePeriod,hireRateFor,hireCharge,hireTimeline,hireCost,hireVersions } from '../src/domain/hire.js';
import { addDays } from '../src/domain/schedule.js';
// Hire rules after review: negotiated prices, week + day rates, rate changes from a date, loads put back on the same site, transfers between sites,
// stocktakes, retired materials, and the overview's arithmetic.
const lots=steps=>{const b=hireBook();for(const [kind,q,day,why] of steps)(kind==='in'?hireArrive:hireLeave)(b,'S','P',q,day,...(kind==='in'?[]:[why??null]));return b.get('S').get('P');};
const one=(s,from,to,today,std,own=null)=>hireCharge(s,from,to,today,hireTimeline(std,own));

test('a negotiated week price is used on its own: the standard day price never mixes in',()=>{
 const std={week:1000,day:200},site={week:700};
 const r=hireRateFor(std,site);assert.deepEqual([r.week,r.day,r.source,r.rule],[700,null,'site','week']);
 const s=lots([['in',10,'2026-08-03']]);const [c]=one(s,'2026-08-03','2026-08-09','2026-08-09',std,site);
 assert.equal(c.pieceDays,70);assert.equal(c.amount,7000,'10 pieces for a week at the negotiated $7.00 a week');
 const [plain]=one(s,'2026-08-03','2026-08-09','2026-08-09',std);assert.equal(plain.amount,10000,'the standard: a full week at the week rate ($10), not 7 x $2');
});

test('week and day rates together: whole weeks at the week rate, extra days at the day rate, never more than a week for a part week',()=>{
 const r=hireRateFor({week:1000,day:300},null);assert.equal(r.rule,'both');assert.equal(r.perWeek,1000);
 assert.equal(hireCost(r,7),1000);assert.equal(hireCost(r,9),1600,'a week + 2 days');assert.equal(hireCost(r,13),2000,'a week + 6 days capped at a second week');assert.equal(hireCost(r,3),900);assert.equal(hireCost(r,4),1000,'4 days x $3 capped at the week');
 const s=lots([['in',100,'2026-08-03'],['in',50,'2026-08-10'],['out',100,'2026-08-12']]);// 100 for 9 days, 50 still out
 const whole=one(s,'2026-08-01','2026-08-20','2026-08-20',{week:1000,day:300})[0];
 assert.equal(whole.pieceDays,100*9+50*11);assert.equal(whole.amount,100*1600+50*(1000+min(4*300,1000)),'per lot, weeks counted from its own start');
 // statements that meet add up to one over both (weeks keep counting from the delivery day)
 const parts=['2026-08-01','2026-08-06','2026-08-11','2026-08-16'].map((from,i,a)=>one(s,from,i+1<a.length?addDays(a[i+1],-1):'2026-08-20','2026-08-20',{week:1000,day:300})[0].amount);
 assert.equal(parts.reduce((x,y)=>x+y,0),whole.amount);
 // a statement for exactly one full week from the delivery day charges the week rate
 assert.equal(one(lots([['in',100,'2026-08-03']]),'2026-08-03','2026-08-09','2026-08-31',{week:1000,day:300})[0].amount,100000);
});
const min=(a,b)=>Math.min(a,b);

test('rates change from a day: earlier days keep the old price, the statement splits the line; a correction for every day replaces it',()=>{
 const std={versions:[{from:null,week:700},{from:'2026-08-10',week:1400}]};
 const segs=hireTimeline(std,null);assert.deepEqual(segs.map(x=>[x.from,x.to,x.rate.week]),[[null,'2026-08-09',700],['2026-08-10',null,1400]]);
 const s=lots([['in',10,'2026-08-03']]);const c=hireCharge(s,'2026-08-01','2026-08-16','2026-08-16',segs).filter(x=>x.pieceDays);
 assert.deepEqual(c.map(x=>[x.pieceDays,x.amount]),[[70,7000],[70,14000]]);
 // a site price from a later day joins the timeline
 const both=hireTimeline(std,{versions:[{from:'2026-08-13',day:150}]});assert.deepEqual(both.map(x=>[x.from,x.to,x.rate.source]),[[null,'2026-08-09','standard'],['2026-08-10','2026-08-12','standard'],['2026-08-13',null,'site']]);
 // a site minimum on its own keeps the standard price: no split in the price, but the minimum changes from that day
 assert.equal(hireTimeline({week:700},{versions:[{from:null,minDays:14}]}).length,1);
 assert.deepEqual(hireVersions({week:5,day:null,minDays:null}),[{from:null,week:5,day:null,minDays:null}],'rates saved before versions: one version for every day');
});

test('minimum hire: only for pieces collected, never for a stocktake shortfall or a transfer; found pieces reopen with their start day',()=>{
 const s=lots([['in',100,'2026-08-03'],['out',10,'2026-08-06','counted'],['out',20,'2026-08-07']]);
 assert.equal(hirePeriod(s,'2026-08-01','2026-08-31','2026-08-31',7).topUp,20*(7-4),'only the 20 collected on day 4 are topped up');
 const [c]=one(s,'2026-08-01','2026-08-31','2026-08-31',{day:100,minDays:7});assert.equal(c.topUp,60);assert.equal(c.topUpAmount,6000);
 const b=hireBook();hireArrive(b,'S','P',100,'2026-08-03');hireLeave(b,'S','P',10,'2026-08-06','counted');
 assert.equal(hireReopen(b,'S','P',10,x=>x.why==='counted'),10);assert.deepEqual(b.get('S').get('P').open,[{q:100,start:'2026-08-03'}],'as if they never went missing');assert.deepEqual(b.get('S').get('P').closed,[]);
 const t=lots([['in',100,'2026-08-03'],['out',100,'2026-08-05','transfer']]);assert.equal(hirePeriod(t,'2026-08-01','2026-08-31','2026-08-31',7).topUp,0);
});

// ---- Through the real engine ----
const START=Date.parse('2026-08-02T23:00:00Z');// Monday 3 Aug 2026, 9 am in Sydney
const later=(t,days)=>t.mock.timers.setTime(Date.now()+days*86400000);
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const deliver=(f,container,site=f.site)=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[container.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);};

test('a load put back down on the same site never ends its hire: no top-up, the same since day, the same place in the queue',t=>{
 t.mock.timers.enable({apis:['Date'],now:START});const f=fixture(t);const P=f.products[0].id;
 deliver(f,f.a);f.cmd('hireRate',{product:P,week:7000,minDays:28});
 later(t,2);// Wed 5 Aug: the truck comes, A goes onto it, then back down on the same site
 f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('returnStock',{container:f.a.id,truck:f.truck.id});settle(f,60);
 assert.equal(f.sim.repo.get(f.a.id).location,f.truck.id);assert.equal(f.sim.hire().totals.pieces,0,'on the truck: off hire for now');
 later(t,1);f.cmd('unload',{id:f.truck.id});settle(f,60);assert.equal(f.sim.repo.get(f.a.id).location,f.site.id);
 const h=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-06'}),l=h.statement.lines[0];
 assert.equal(l.topUp,null,'nothing left the site: no minimum hire top-up');assert.equal(l.pieceDays,400,'3 to 6 Aug without a gap');assert.equal(h.sites[0].since,'2026-08-03');assert.ok(h.check.ok);
 assert.equal(h.statement.subtotal,400*1000);
});

test('a direct transfer to another site keeps one minimum hire: no top-up at the first site, the second tops up only what is missing',t=>{
 t.mock.timers.enable({apis:['Date'],now:START});const f=fixture(t);const P=f.products[0].id;
 const siteB=f.cmd('site',{name:'Site B'});f.cmd('resources',{location:siteB.id,workers:2,machines:1,stepMs:100,speed:100000,jobs:false});
 deliver(f,f.a);f.cmd('hireRate',{product:P,day:100,minDays:7});later(t,3);// Thu 6 Aug: A goes from Site A to Site B
 f.cmd('dispatch',{id:f.truck.id,destination:f.site.id});f.tick(5);f.cmd('returnStock',{container:f.a.id,truck:f.truck.id});settle(f,60);
 f.cmd('dispatch',{id:f.truck.id,destination:siteB.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);assert.equal(f.sim.repo.get(f.a.id).location,siteB.id);
 later(t,2);// Sat 8 Aug: back to the yard
 f.cmd('returnStock',{container:f.a.id,truck:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);
 later(t,1);
 const a=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-09'}).statement,b=f.sim.hire({site:siteB.id,from:'2026-08-01',to:'2026-08-09'}).statement;
 assert.equal(a.pieceDays,300);assert.equal(a.lines[0].topUp,null,'a transfer is not a collection');
 assert.equal(b.pieceDays,200);assert.equal(b.lines[0].topUp.pieceDays,100*(7-5),'out 5 days in all: 2 more days to the 7-day minimum');
 assert.equal(a.subtotal+b.subtotal,700*100,'one 7-day minimum for 100 pieces');assert.ok(f.sim.hire().check.ok);
});

test('a stocktake shortfall at a site ends hire for those pieces without a minimum hire top-up',t=>{
 t.mock.timers.enable({apis:['Date'],now:START});const f=fixture(t);const P=f.products[0].id;
 deliver(f,f.a);deliver(f,f.b);f.cmd('hireRate',{product:P,day:100,minDays:7});later(t,2);
 const count=f.cmd('count',{scope:f.b.id}),lines=f.sim.repo.get(count.id,'count').lines;f.cmd('observe',{id:count.id,observed:lines.map(l=>l.expected-10),reason:'Ten missing'});f.cmd('approveCount',{id:count.id});
 later(t,2);const s=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-07'}).statement;
 assert.equal(s.lines[0].topUp,null);assert.deepEqual(s.daily.slice(2,7),[200,200,190,190,190]);assert.ok(f.sim.hire().check.ok);
});

test('a rate change from a day leaves an earlier statement as it was; the ledger never carries the money',t=>{
 t.mock.timers.enable({apis:['Date'],now:START});const f=fixture(t);const P=f.products[0].id;
 deliver(f,f.a);f.cmd('hireRate',{product:P,week:7000});later(t,20);// Sun 23 Aug
 const before=f.sim.hire({site:f.site.id,from:'2026-08-03',to:'2026-08-09'}).statement.total;assert.equal(before,770000);
 const r=f.cmd('hireRate',{product:P,week:14000,from:'2026-08-17'});assert.match(r.message,/from Mon 17 Aug/);assert.equal(r.rate.versions.length,2);assert.equal(r.rate.week,14000,'the rate in force today');
 assert.equal(f.sim.hire({site:f.site.id,from:'2026-08-03',to:'2026-08-09'}).statement.total,before,'the week of 3 Aug keeps its price');
 const s=f.sim.hire({site:f.site.id,from:'2026-08-10',to:'2026-08-23'}).statement;assert.equal(s.lines.length,2);assert.equal(s.rateChanges,1);
 assert.deepEqual(s.lines.map(l=>[l.rateFrom,l.rateTo,l.pieceDays,l.amount]),[['2026-08-10','2026-08-16',700,700000],['2026-08-17','2026-08-23',700,1400000]]);
 const csv=f.sim.hireCSV({site:f.site.id,from:'2026-08-10',to:'2026-08-23'}).csv;assert.ok(csv.includes('(2026-08-17 to 2026-08-23)'));assert.ok(csv.includes('rate in force that day'));
 // a correction for every day replaces the history (the owner chose it in the editor)
 f.cmd('hireRate',{product:P,week:7700});assert.equal(f.sim.repo.all('hireRate')[0].versions.length,1);assert.equal(f.sim.hire({site:f.site.id,from:'2026-08-03',to:'2026-08-09'}).statement.subtotal,770000);
 assert.throws(()=>f.cmd('hireRate',{product:P,week:1,from:'2027-12-01'}),/at most a year ahead/);assert.throws(()=>f.cmd('hireRate',{product:P,week:1,from:'2026-02-30'}),/Applies from must be a date/);
 assert.ok(f.sim.repo.history(2000).filter(x=>x.event==='HIRE_RATE').every(x=>!/\$|\d{3}/.test(x.reason.replace(/\d{1,2} [A-Z][a-z]{2}/g,''))));
});

test('retired materials can still be priced and cleared: their past hire needs a rate',t=>{
 t.mock.timers.enable({apis:['Date'],now:START});const f=fixture(t);const P=f.products[0].id;
 deliver(f,f.a);f.cmd('hireRate',{product:P,day:100});later(t,3);
 if(f.products[0].verification==='DEMO ONLY'){f.cmd('purgeDemo',{});assert.ok(f.sim.effective(P).retired);}
 f.cmd('hireRate',{product:P});assert.equal(f.sim.repo.all('hireRate').length,0);f.cmd('hireRate',{product:P,day:120});
 f.cmd('hireSiteRate',{site:f.site.id,product:P,day:90});assert.equal(f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-05'}).statement.lines[0].rate.day,90);
});

test('the overview adds piece-days per lot without daily arrays and matches the per-day count',()=>{
 const b=hireBook(),start='2026-01-01';for(let p=0;p<20;p++)for(let d=0;d<365;d+=7){hireArrive(b,'S','P'+p,20,addDays(start,d));if(d>30)hireLeave(b,'S','P'+p,15+(p%3),addDays(start,d+(p%5)));}
 const today=addDays(start,365),segs=hireTimeline({week:700,versions:[{from:null,week:700},{from:'2026-06-01',week:900}]},null);const t0=performance.now();
 for(const [,s] of b.get('S')){const c=hireCharge(s,start,today,today,segs),p=hirePeriod(s,start,today,today);assert.equal(c.reduce((a,x)=>a+x.pieceDays,0),p.pieceDays);}
 assert.ok(performance.now()-t0<1500,'a year of weekly lots for 20 materials stays quick');
});
