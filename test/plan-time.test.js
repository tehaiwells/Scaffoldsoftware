process.env.TZ='Australia/Sydney';// the owner's PC: every planner day and time is Sydney's
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_TIMES,DAY_START,SEND_BEFORE,DAY_END,atLocal,localParts,parseTime,timeWords,fnv1a,planSimAnswer,REASONS } from '../src/domain/plantime.js';
import { monthGrid,monthAdd,monthsBetween,isMonth,smsHref,chipOf,monthTitle } from '../public/plan-cal.js';

test('plan times run 5:00 am to 5:00 pm every half hour and never touch the 2-3 am daylight-saving gap',()=>{
  assert.equal(PLAN_TIMES[0],'05:00');assert.equal(PLAN_TIMES.at(-1),'17:00');assert.equal(PLAN_TIMES.length,25);assert.ok(PLAN_TIMES.includes('07:00')&&PLAN_TIMES.includes('13:30'));
  assert.ok(!PLAN_TIMES.some(t=>t.startsWith('02')),'no time in the gap');assert.deepEqual([DAY_START,SEND_BEFORE,DAY_END],['06:00','15:00','17:00']);
  assert.equal(parseTime(undefined),'07:00');assert.equal(parseTime('13:30'),'13:30');assert.throws(()=>parseTime('02:30'),/between 5:00 am and 5:00 pm/);assert.throws(()=>parseTime('7:15'),/between/);
});

test('local moments: atLocal and localParts round-trip, across both daylight-saving changes in Sydney',()=>{
  // DST starts Sun 4 Oct 2026 (AEST +10 -> AEDT +11): the allocation for Mon 5 Oct goes out Sun 4 Oct at 3 pm AEDT
  assert.equal(atLocal('2026-10-04',SEND_BEFORE),Date.parse('2026-10-04T04:00:00Z'));
  assert.equal(atLocal('2026-10-03',SEND_BEFORE),Date.parse('2026-10-03T05:00:00Z'),'still AEST the day before');
  // DST ends Sun 4 Apr 2027 (AEDT -> AEST): a hire truck on Mon 5 Apr arrives at 6:00 local
  assert.equal(atLocal('2027-04-05',DAY_START),Date.parse('2027-04-04T20:00:00Z'));
  for(const [day,hm] of [['2026-10-04','15:00'],['2027-04-05','06:00'],['2026-12-31','17:00'],['2028-02-29','05:00']])assert.deepEqual(localParts(atLocal(day,hm)),{day,hm});
});

test('month grids: always 42 days from the Monday on or before the 1st (Feb 2027 starts on a Monday, Feb 2028 is a leap month)',()=>{
  for(const [m,first,last] of [['2026-09','2026-08-31','2026-10-11'],['2026-10','2026-09-28','2026-11-08'],['2027-02','2027-02-01','2027-03-14'],['2028-02','2028-01-31','2028-03-12']]){
    const g=monthGrid(m);assert.equal(g.length,42);assert.equal(g[0],first,m);assert.equal(g[41],last,m);assert.equal(new Date(g[0]+'T00:00:00Z').getUTCDay(),1,'a Monday');
    assert.ok(g.includes(m+'-01'));for(let i=1;i<42;i++)assert.equal(Date.parse(g[i]+'T00:00:00Z')-Date.parse(g[i-1]+'T00:00:00Z'),86400000,'one day apart');}
  assert.ok(monthGrid('2028-02').includes('2028-02-29'));assert.ok(monthGrid('2027-02').includes('2027-02-28')&&!monthGrid('2027-02').includes('2027-02-29'));
  assert.equal(monthAdd('2026-12',1),'2027-01');assert.equal(monthAdd('2026-01',-1),'2025-12');assert.equal(monthsBetween('2026-09','2027-10'),13);assert.ok(isMonth('2026-10')&&!isMonth('2026-13')&&!isMonth('2026-1'));
  assert.equal(monthTitle('2026-10'),'October 2026');
});

test('words and helpers: times read the way people say them, fnv1a is the standard hash, text links are pre-written',()=>{
  assert.equal(timeWords('07:00'),'7:00 am');assert.equal(timeWords('13:30'),'1:30 pm');assert.equal(timeWords('12:00'),'12:00 pm');assert.equal(timeWords('05:30'),'5:30 am');
  assert.equal(fnv1a(''),2166136261);assert.equal(fnv1a('a'),0xe40c292c);assert.equal(fnv1a('foobar'),0xbf9cf968);
  assert.equal(smsHref('+61412345678','Hi Dave, can you drive?'),'sms:+61412345678?&body=Hi%20Dave%2C%20can%20you%20drive%3F');
  assert.deepEqual(chipOf({type:'WORKERS',count:3,siteName:'Bondi'}).label,'3 → Bondi');assert.equal(chipOf({kind:'collection',siteName:'Bondi'}).tone,'back');assert.equal(chipOf({type:'TRUCK',truckName:'T-01',driverName:'Dave',big:true}).label,'T-01 · Dave');
});

test('simulated answers are fixed by person, day, kind of ask and attempt: 15-90 s later, about one in eight say no with a plain reason',()=>{
  const m={person:'p-1',day:'2026-10-15',subject:'DRIVE',attempt:1};assert.deepEqual(planSimAnswer(m),planSimAnswer({...m}));
  let no=0;const n=800;for(let i=0;i<n;i++){const a=planSimAnswer({person:'person-'+i,day:'2026-10-15',subject:'WORK',attempt:1});assert.ok(a.delaySec>=15&&a.delaySec<=90);if(!a.yes){no++;assert.ok(REASONS.includes(a.reason));}else assert.equal(a.reason,null);}
  assert.ok(no>n*0.08&&no<n*0.17,'about 12.5 % say no: '+no);
  // asking again is a fresh (but still fixed) answer
  const tries=[1,2,3,4,5,6].map(attempt=>planSimAnswer({...m,attempt}));assert.ok(new Set(tries.map(a=>a.delaySec+'|'+a.yes)).size>1);
});
