import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';

// One idempotency key per user action (Phase 0, D7): a command whose answer was lost is resent with the same key, so it runs once.
// The browser's command sender (public/operations.js) talks to a real server; fetch is wrapped so chosen replies "get lost" after the server acted.
async function served(t){
  const db=openDatabase(':memory:'),auth=new Service(db),email=randomUUID()+'@example.com',password='demonstration-password';
  auth.register({name:'Owner',companyName:'Harbour',email,password,systems:['quickstage']});const token=auth.login({email,password});
  const server=createApp(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const real=globalThis.fetch,keys=[];let lose=0;
  globalThis.fetch=async(url,opts={})=>{keys.push(opts.headers?.['Idempotency-Key']);
    const res=await real(base+url,{...opts,headers:{...opts.headers,Cookie:'session='+token,Origin:base}});
    if(lose>0){lose--;await res.text();throw new TypeError('Failed to fetch');}// the server did it; the answer never arrived
    return res;};
  t.after(async()=>{globalThis.fetch=real;await new Promise(r=>server.close(r));db.close();});
  const ops=await import('../public/operations.js');ops.__test.retryWait(0);
  return {ops:ops.__test,keys,lose:n=>{lose=n;},drivers:()=>db.prepare("SELECT COUNT(*) n FROM objects WHERE kind='driver'").get().n};
}

test('a command whose answer was lost is retried with the same key and runs once (the automatic retry)',async t=>{
  const s=await served(t);s.lose(1);
  const r=await s.ops.command('teamAdd',{name:'Dave',role:'DRIVER'});
  assert.match(r.message,/Dave is in your team/,'the saved answer comes back, not "There\'s already a Dave"');
  assert.equal(s.keys.length,2);assert.equal(s.keys[0],s.keys[1],'the retry resends the first key');assert.equal(s.drivers(),1,'Dave was added once');
});

test('no answer at all: the user presses again and the same key goes, so it still runs once; a definite answer forgets the key',async t=>{
  const s=await served(t);s.lose(3);
  await assert.rejects(s.ops.command('teamAdd',{name:'Dave',role:'DRIVER'}),/did not answer.*press again/i,'a plain message, not "Failed to fetch"');
  assert.equal(new Set(s.keys).size,1,'every automatic retry used one key');
  const r=await s.ops.command('teamAdd',{name:'Dave',role:'DRIVER'});
  assert.match(r.message,/Dave is in your team/);assert.equal(new Set(s.keys).size,1,'pressing again resent the same key');assert.equal(s.drivers(),1);
  // Answered: the next press is a new action with a new key (the server refuses it as a duplicate person, which is the right answer).
  await assert.rejects(s.ops.command('teamAdd',{name:'Dave',role:'DRIVER'}),/already a Dave/);assert.equal(new Set(s.keys).size,2);
  // A different action never borrows a waiting key.
  s.lose(3);await assert.rejects(s.ops.command('teamAdd',{name:'Sam',role:'DRIVER'}));const samKey=s.keys.at(-1);
  await s.ops.command('teamAdd',{name:'Mia',role:'DRIVER'});assert.notEqual(s.keys.at(-1),samKey);
  await s.ops.command('teamAdd',{name:'Sam',role:'DRIVER'});assert.equal(s.keys.at(-1),samKey);assert.equal(s.drivers(),3);
});

test('the logo and company details sender keeps its key the same way',async t=>{
  const s=await served(t);s.lose(1);
  await s.ops.bdPost('/api/company-logo',{type:'image/png',data:''}).catch(()=>{});
  assert.ok(s.keys.length>=2);assert.equal(s.keys[0],s.keys[1]);
});
