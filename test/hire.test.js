process.env.TZ='Australia/Sydney';// the server's local day is Sydney's in this file
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';
import { createApp } from '../src/server.js';
import { fixture } from './simulation.test.js';
import { hireBook,hireArrive,hireLeave,hirePeriod,hireRateFor,hireAmount,hireGst,hireMoney,overlapDays } from '../src/domain/hire.js';

// ---- The piece-day core ----
const book=(steps)=>{const b=hireBook();for(const [kind,q,day] of steps)(kind==='in'?hireArrive:hireLeave)(b,'S','P',q,day);return b.get('S').get('P');};

test('overlap counts the delivery day and not the return day, clipped to the period',()=>{
 assert.equal(overlapDays('2026-08-03','2026-08-06','2026-08-01','2026-08-31'),3);// 3, 4, 5 Aug
 assert.equal(overlapDays('2026-08-03','2026-08-03','2026-08-01','2026-08-31'),0);// same-day turnaround
 assert.equal(overlapDays('2026-07-20','2026-08-10','2026-08-01','2026-08-05'),5);// both ends clipped
 assert.equal(overlapDays('2026-08-06','2026-08-10','2026-08-01','2026-08-05'),0);// after the period
 assert.equal(overlapDays('2026-08-05','2026-08-10','2026-08-01','2026-08-05'),1);// starts on the last day
});

test('a partial return ends hire for the oldest pieces first (FIFO) and splits the lot',()=>{
 const s=book([['in',100,'2026-08-03'],['in',50,'2026-08-10'],['out',120,'2026-08-17']]);
 assert.deepEqual(s.closed,[{q:100,start:'2026-08-03',end:'2026-08-17'},{q:20,start:'2026-08-10',end:'2026-08-17'}]);
 assert.deepEqual(s.open,[{q:30,start:'2026-08-10'}]);
 const p=hirePeriod(s,'2026-08-01','2026-08-31','2026-08-20');
 assert.equal(p.pieceDays,100*14+20*7+30*11,'100 for 14 days, 20 for 7 days, 30 still out for 11 days to today');
 assert.equal(p.daily[1],0);assert.equal(p.daily[2],100);assert.equal(p.daily[9],150);assert.equal(p.daily[15],150);assert.equal(p.daily[16],30);assert.equal(p.daily[19],30);assert.equal(p.daily[20],0,'nothing counted after today');
 assert.equal(p.start,0);assert.equal(p.end,0);
 // a second partial return keeps taking from what is left of the older lot
 const t=book([['in',10,'2026-08-03'],['in',10,'2026-08-04'],['out',4,'2026-08-05'],['out',8,'2026-08-06']]);
 assert.deepEqual(t.closed,[{q:4,start:'2026-08-03',end:'2026-08-05'},{q:6,start:'2026-08-03',end:'2026-08-06'},{q:2,start:'2026-08-04',end:'2026-08-06'}]);assert.deepEqual(t.open,[{q:8,start:'2026-08-04'}]);
 // more back than was ever delivered: the extra is reported, nothing goes negative
 const b=hireBook();hireArrive(b,'S','P',5,'2026-08-03');assert.equal(hireLeave(b,'S','P',8,'2026-08-04'),3);assert.deepEqual(b.get('S').get('P').open,[]);
});

test('multiple deliveries and period boundaries: per-day pieces add up to the piece-days',()=>{
 const s=book([['in',100,'2026-08-03'],['in',25,'2026-08-03'],['in',50,'2026-08-10'],['out',40,'2026-08-12']]);
 assert.deepEqual(s.open,[{q:85,start:'2026-08-03'},{q:50,start:'2026-08-10'}],'same-day deliveries merge into one lot');
 const p=hirePeriod(s,'2026-08-05','2026-08-12','2026-08-31');
 assert.deepEqual(p.daily,[125,125,125,125,125,175,175,135]);assert.equal(p.pieceDays,125*5+175*2+135);assert.equal(p.start,125);assert.equal(p.end,135);
 const whole=hirePeriod(s,'2026-08-01','2026-08-31','2026-08-31');assert.equal(whole.pieceDays,whole.daily.reduce((a,n)=>a+n,0));
 // two statements that meet add up to one statement over both
 const a=hirePeriod(s,'2026-08-01','2026-08-15','2026-08-31'),b=hirePeriod(s,'2026-08-16','2026-08-31','2026-08-31');assert.equal(a.pieceDays+b.pieceDays,whole.pieceDays);
});

test('minimum hire: pieces back early are topped up to the minimum, on the statement that holds the return day',()=>{
 const s=book([['in',10,'2026-08-03'],['out',10,'2026-08-06'],['in',4,'2026-08-10'],['out',4,'2026-08-10'],['in',6,'2026-08-11'],['out',6,'2026-08-25']]);
 const all=hirePeriod(s,'2026-08-01','2026-08-31','2026-08-31',7);
 assert.equal(all.pieceDays,10*3+0+6*14);assert.equal(all.topUp,10*4+4*7,'3 days held -> 4 more; a same-day return -> the full 7; 14 days held -> none');
 assert.equal(hirePeriod(s,'2026-08-01','2026-08-05','2026-08-31',7).topUp,0,'the return day is outside this period');
 const late=hirePeriod(s,'2026-08-06','2026-08-10','2026-08-31',7);assert.equal(late.topUp,10*4+4*7);assert.equal(late.pieceDays,0);
 assert.equal(hirePeriod(s,'2026-08-01','2026-08-31','2026-08-31',null).topUp,0,'no minimum, no top-up');
 // still on site: no top-up yet, the days simply run on
 const open=book([['in',5,'2026-08-30']]);assert.equal(hirePeriod(open,'2026-08-01','2026-08-31','2026-08-31',7).topUp,0);
});

test('rates: a site price replaces the standard price as a whole, its minimum wins on its own; a week rate costs a seventh a day; money and GST round to the cent',()=>{
 const std={week:1400,day:null,minDays:7};
 assert.deepEqual(hireRateFor(std,null),{week:1400,day:null,minDays:7,source:'standard',minSource:'standard',priced:true,rule:'week',perDay:200,perWeek:1400});
 const r=hireRateFor(std,{week:null,day:250,minDays:null});assert.equal(r.day,250);assert.equal(r.week,null,'the negotiated day price is not mixed with the standard week price');assert.equal(r.minDays,7);assert.equal(r.source,'site');assert.equal(r.minSource,'standard');assert.equal(r.perDay,250);
 const minOnly=hireRateFor(std,{week:null,day:null,minDays:28});assert.equal(minOnly.source,'standard','a site minimum alone keeps the standard price (and its label)');assert.equal(minOnly.minSource,'site');assert.equal(minOnly.minDays,28);
 assert.equal(hireRateFor(std,{week:1050,day:null,minDays:14}).perDay,150);assert.equal(hireRateFor(std,{week:1050,day:null,minDays:14}).minDays,14);
 assert.equal(hireRateFor(null,null).priced,false);assert.equal(hireRateFor(null,{minDays:7}).priced,false,'a minimum alone is not a rate');
 assert.equal(hireAmount(10,hireRateFor({week:1000},null)),1429,'10 x $10.00/7 = $14.2857 -> $14.29');
 assert.equal(hireAmount(7,hireRateFor({week:1000},null)),1000);assert.equal(hireAmount(3,hireRateFor({week:1001},null)),429,'3003/7 = 429');
 assert.equal(hireAmount(12,hireRateFor({day:175},null)),2100);assert.equal(hireAmount(5,hireRateFor(null,null)),null,'no rate, no amount');
 assert.equal(hireGst(1429),143);assert.equal(hireGst(1235),124,'half a cent rounds up');assert.equal(hireGst(1234),123);assert.equal(hireGst(0),0);
 assert.equal(hireMoney(123456),'1234.56');assert.equal(hireMoney(5),'0.05');assert.equal(hireMoney(0),'0.00');assert.equal(hireMoney(null),'');
});

// ---- Replayed from a real ledger: deliveries, a collection, rates, a statement, permissions and the HTTP routes ----
const START=Date.parse('2026-08-02T23:00:00Z');// Monday 3 Aug 2026, 9 am in Sydney
const later=(t,days)=>t.mock.timers.setTime(Date.now()+days*86400000);
const settle=(f,n=150)=>{f.tick(n);for(const task of f.sim.tasks().filter(t=>t.state==='BLOCKED'))f.cmd('retry',{id:task.id});f.tick(n);};
const deliver=(f,container,site=f.site)=>{f.cmd('loadTruck',{truck:f.truck.id,containers:[container.id]});settle(f);f.cmd('dispatch',{id:f.truck.id,destination:site.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);};
const giveBack=(f,container,site=f.site)=>{f.cmd('dispatch',{id:f.truck.id,destination:site.id});f.tick(5);f.cmd('returnStock',{container:container.id,truck:f.truck.id});settle(f,60);f.cmd('dispatch',{id:f.truck.id,destination:f.yard.id});f.tick(5);f.cmd('unload',{id:f.truck.id});settle(f,60);};
const user=(f,email,role)=>{f.auth.addUser(f.user,{name:role,email,password:'demonstration-password',roles:[role]});return new Simulation(f.db,f.auth.authenticate(f.auth.login({email,password:'demonstration-password'})));};
const story=t=>{t.mock.timers.enable({apis:['Date'],now:START});const f=fixture(t);
 deliver(f,f.a);// Mon 3 Aug: 100 pieces delivered
 later(t,7);deliver(f,f.b);// Mon 10 Aug: 100 more of the same material
 later(t,4);giveBack(f,f.a);// Fri 14 Aug: one stillage (100) collected: hire ends for the 3 Aug pieces (FIFO), whichever stillage they came in
 later(t,3);// Mon 17 Aug
 return f;};

test('the ledger replay: deliveries start hire, a collection ends the oldest, and the book matches the live count at the site',t=>{const f=story(t);
 assert.equal(f.sim.repo.get(f.a.id).location,f.yard.id);assert.equal(f.sim.repo.get(f.b.id).location,f.site.id);
 const h=f.sim.hire();assert.equal(h.today,'2026-08-17');assert.equal(h.weekStart,'2026-08-17');
 assert.deepEqual(h.check,{rebuilt:100,actual:100,ok:true});
 const row=h.sites.find(s=>s.id===f.site.id);assert.equal(row.pieces,100);assert.equal(row.since,'2026-08-10');assert.equal(row.days,8);assert.equal(row.first,'2026-08-03');
 assert.equal(h.totals.pieces,100);assert.equal(h.totals.sites,1);assert.equal(h.totals.longest.since,'2026-08-10');assert.equal(h.totals.longest.days,8);
 assert.equal(row.accrued,0,'no rate yet: nothing is priced');assert.deepEqual(row.missing,[f.products[0].id]);assert.equal(h.unpriced[0].id,f.products[0].id);assert.equal(h.unpriced[0].pieces,100);
 const s=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-17'}).statement;
 assert.equal(s.days,17);assert.equal(s.lines.length,1);const l=s.lines[0];
 assert.equal(l.pieceDays,100*11+100*8,'3-13 Aug (11 days) and 10-17 Aug (8 days)');assert.equal(l.amount,null);assert.equal(s.missing,1);assert.equal(s.complete,false);assert.equal(s.subtotal,0);
 assert.equal(s.daily[2],100);assert.equal(s.daily[9],200);assert.equal(s.daily[13],100);assert.equal(s.daily[16],100);
});

test('rates set by the owner price the statement: standard, then a negotiated site rate, a minimum, GST and the CSV',t=>{const f=story(t);const P=f.products[0].id;
 f.cmd('hireRate',{product:P,week:7000});// $70.00 a week -> $10.00 a day
 let s=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-17'}).statement;
 assert.equal(s.lines[0].amount,1900*1000);assert.equal(s.subtotal,1900000);assert.equal(s.gst,190000);assert.equal(s.total,2090000);assert.equal(s.complete,true);assert.equal(s.lines[0].rate.source,'standard');
 const h=f.sim.hire();assert.equal(h.totals.thisWeek,100*1*1000,'Mon 17 Aug: 100 pieces for one day');assert.equal(h.totals.runRate,100*7000);assert.equal(h.sites[0].accrued,1900000);assert.deepEqual(h.unpriced,[]);
 f.cmd('hireSiteRate',{site:f.site.id,product:P,day:850,note:'Negotiated Aug 2026'});// $8.50 a day at this site
 s=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-17'}).statement;assert.equal(s.lines[0].rate.source,'site');assert.equal(s.lines[0].amount,1900*850);assert.equal(s.gst,hireGst(1900*850));assert.equal(s.overrides,1);
 f.cmd('hireSiteRate',{site:f.site.id,product:P,minDays:28});// only the minimum overridden: the standard week rate prices it again
 s=f.sim.hire({site:f.site.id,from:'2026-08-01',to:'2026-08-17'}).statement;const l=s.lines[0];
 assert.equal(l.rate.day,null);assert.equal(l.rate.week,7000);assert.equal(l.topUp.pieceDays,100*(28-11),'the 3 Aug pieces went back after 11 days');assert.equal(l.topUp.amount,1700*1000);assert.equal(s.subtotal,1900000+1700000);
 assert.equal(f.sim.hire({site:f.site.id,from:'2026-08-15',to:'2026-08-17'}).statement.lines[0].topUp,null,'the top-up sits with the return day (14 Aug)');
 const csv=f.sim.hireCSV({site:f.site.id,from:'2026-08-01',to:'2026-08-17'});assert.match(csv.name,/^hire-statement-site-a-2026-08-01-to-2026-08-17\.csv$/);
 assert.ok(csv.csv.includes('"Subtotal (ex GST)","","","","","","","","","36000.00"'));assert.ok(csv.csv.includes('"GST 10%","","","","","","","","","3600.00"'));assert.ok(csv.csv.includes('"Total (inc GST)","","","","","","","","","39600.00"'));
 assert.ok(csv.csv.includes('minimum hire top-up (28 days)'));assert.ok(csv.csv.includes('"2026-08-10","200","200"'));
 // removing every field removes the rate; the ledger row never carries money
 f.cmd('hireSiteRate',{site:f.site.id,product:P});f.cmd('hireRate',{product:P});assert.equal(f.sim.repo.all('hireRate').length,0);assert.equal(f.sim.repo.all('hireSiteRate').length,0);
 const rows=f.sim.repo.history(2000).filter(r=>r.event==='HIRE_RATE');assert.equal(rows.length,5);assert.ok(rows.every(r=>!/\$|\d{3}/.test(r.reason)),'no amounts in the ledger text');
});

test('rate input is checked: whole cents, sensible ranges, a real material and site',t=>{const f=story(t);const P=f.products[0].id;
 assert.throws(()=>f.cmd('hireRate',{product:P,week:12.5}),/Week rate \(cents\) must be a whole number/);assert.throws(()=>f.cmd('hireRate',{product:P,day:-1}),/whole number/);
 assert.throws(()=>f.cmd('hireRate',{product:P,week:100000001}),/between 0 and 10000000/);assert.throws(()=>f.cmd('hireRate',{product:P,minDays:0}),/Minimum hire/);
 assert.throws(()=>f.cmd('hireRate',{product:'nope',week:100}),/Record not found/);assert.throws(()=>f.cmd('hireSiteRate',{site:f.yard.id,product:P,week:100}),/Record not found/);
 assert.throws(()=>f.cmd('hireSiteRate',{site:f.site.id,product:P,week:100,note:'x'.repeat(121)}),/120 characters/);
 assert.throws(()=>f.sim.hire({site:f.site.id,from:'2026-08-10',to:'2026-08-01'}),/starts after it ends/);assert.throws(()=>f.sim.hire({site:f.site.id,from:'2026-13-01'}),/From must be a date/);
 assert.throws(()=>f.sim.hire({site:f.site.id,from:'2026-09-01'}),/cannot start after today/);
 const s=f.sim.hire({site:f.site.id,from:'2026-08-10',to:'2026-12-31'}).statement;assert.equal(s.to,'2026-08-17');assert.equal(s.clamped,true);
});

test('only the owner sees hire: managers and supervisors get neither the figures nor the rate commands',t=>{const f=story(t);const P=f.products[0].id;
 const gm=user(f,'gm@example.com','GENERAL_MANAGER'),sup=user(f,'sup@example.com','SUPERVISOR');
 for(const sim of [gm,sup]){assert.throws(()=>sim.hire(),/owner only/);assert.throws(()=>sim.hireCSV({site:f.site.id}),/owner only/);assert.throws(()=>sim.execute('hireRate',{product:P,week:100},'key-'+Math.random()),/does not allow/);assert.throws(()=>sim.execute('hireSiteRate',{site:f.site.id,product:P,week:100},'key-'+Math.random()),/does not allow/);}
 assert.equal(f.sim.hire().totals.pieces,100);
});

test('the sums are kept until the hire book, a rate or the day changes, and a rate change shows at once',t=>{const f=story(t);
 const a=f.sim.hire({site:f.site.id});assert.equal(f.sim.hire({site:f.site.id}).statement.lines[0].daily,a.statement.lines[0].daily,'the kept statement is reused');
 f.cmd('hireRate',{product:f.products[0].id,day:100});const b=f.sim.hire({site:f.site.id});assert.notEqual(b,a);assert.equal(b.statement.lines[0].rate.day,100);assert.ok(b.seq>a.seq);
 assert.equal(b.statement.from,'2026-08-01','no dates: the month so far');assert.equal(b.statement.to,'2026-08-17');
});

test('GET /api/hire and /api/hire.csv: the owner gets JSON and a CSV download, others 403',async t=>{const f=story(t);const handler=createApp(f.db).listeners('request')[0];
 f.auth.addUser(f.user,{name:'Sup',email:'sup2@example.com',password:'demonstration-password',roles:['SUPERVISOR']});
 const owner=f.auth.login({email:f.user.email,password:'demonstration-password'}),sup=f.auth.login({email:'sup2@example.com',password:'demonstration-password'});
 const call=(url,token)=>new Promise(done=>{const req={method:'GET',url,headers:{host:'x',cookie:'session='+token},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){}};let status=200,headers={};const res={setHeader(){},writeHead(s,h={}){status=s;headers=h;},end(b){done({status,headers,body:String(b)});}};handler(req,res);});
 const ok=await call('/api/hire?site='+f.site.id+'&from=2026-08-01&to=2026-08-17',owner);assert.equal(ok.status,200);const j=JSON.parse(ok.body);assert.equal(j.statement.pieceDays,1900);assert.equal(j.totals.pieces,100);
 const csv=await call('/api/hire.csv?site='+f.site.id+'&from=2026-08-01&to=2026-08-17',owner);assert.equal(csv.status,200);assert.match(csv.headers['Content-Type'],/text\/csv/);assert.match(csv.headers['Content-Disposition'],/attachment; filename="hire-statement-site-a-2026-08-01-to-2026-08-17\.csv"/);assert.ok(csv.body.startsWith('﻿"HIRE STATEMENT'));
 assert.equal((await call('/api/hire',sup)).status,403);assert.equal((await call('/api/hire.csv?site='+f.site.id,sup)).status,403);
});
