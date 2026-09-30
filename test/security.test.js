// Phase 0 security (audit D1-D6, D12): the audit's probe scripts (sec-probe, fc-eng/probe, rebind) turned into tests.
// Every request goes through the real HTTP server with a Host header we choose (fetch cannot set Host, so node:http is used).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp, hostAllowed, listenHost } from '../src/server.js';
import { createBackups } from '../src/backups.js';

const pw='a-long-test-password';
const company=k=>({companyName:'Yard '+k,name:'Owner '+k,email:k+'@example.test',password:pw,systems:['quickstage']});
// Temp folders go when the whole file is done (every database and server in them is closed by then).
const dirs=[];after(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const temp=()=>{const dir=mkdtempSync(join(tmpdir(),'scaffold-sec-'));dirs.push(dir);return dir;};
// Registration is closed by default; a test that needs a second company opens it for its own duration.
const openRegistration=t=>{const was=process.env.SCAFFOLD_OPEN_REGISTRATION;process.env.SCAFFOLD_OPEN_REGISTRATION='1';t.after(()=>{if(was===undefined)delete process.env.SCAFFOLD_OPEN_REGISTRATION;else process.env.SCAFFOLD_OPEN_REGISTRATION=was;});};
async function serve(t,db,options){
  const server=createApp(db,options);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const port=server.address().port;
  const req=(method,path,{body,cookie,headers={}}={})=>new Promise((resolve,reject)=>{
    const data=body===undefined?null:JSON.stringify(body),h={host:'127.0.0.1:'+port,...headers};
    if(cookie)h.cookie=cookie;if(data!==null){h['content-type']='application/json';h['content-length']=Buffer.byteLength(data);}
    const r=http.request({host:'127.0.0.1',port,path,method,headers:h},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{let json=null;try{json=JSON.parse(s);}catch{}resolve({status:res.statusCode,headers:res.headers,json,text:s});});});
    r.on('error',reject);if(data!==null)r.write(data);r.end();
  });
  return {port,req};
}
const cookieOf=r=>(r.headers['set-cookie']||[])[0]?.split(';')[0];
const tokenOf=link=>new URL(link).hash.replace(/^#invite=/,'');

test('F2 (rebind.log): a forged Host gets 421 before anything runs; Origin must match an allowed Host; Referrer-Policy is same-origin',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const {port,req}=await serve(t,db);
  const evil={host:`attacker.example:${port}`,origin:`http://attacker.example:${port}`};
  const rebound=await req('POST','/api/register',{body:company('rebind'),headers:evil});
  assert.equal(rebound.status,421,'the rebinding probe registered a company (200) before the fix');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n,0,'nothing was created');
  for(const path of ['/','/health','/api/systems','/app.js'])assert.equal((await req('GET',path,{headers:{host:'attacker.example:'+port}})).status,421,path);
  assert.equal((await req('GET','/health',{headers:{host:'localhost:'+port}})).status,200);
  assert.equal((await req('GET','/health',{headers:{host:'[::1]:'+port}})).status,200);
  const page=await req('GET','/');assert.equal(page.status,200);assert.equal(page.headers['referrer-policy'],'same-origin');
  assert.equal((await req('POST','/api/login',{body:{email:'x@example.test',password:pw},headers:{origin:'http://evil.example'}})).status,403,'a foreign Origin with the real Host');
  assert.equal((await req('POST','/api/login',{body:{email:'x@example.test',password:pw},headers:{origin:'null'}})).status,403);
});

test('host allowlist: loopback always; this PC\'s own addresses and name only while Wi-Fi sharing is on; extra names only when configured',()=>{
  const pc={hostname:'YARD-PC',addresses:['192.168.1.20','fe80::1']};
  for(const h of ['127.0.0.1:3000','localhost:3000','LOCALHOST','[::1]:3000','127.0.0.1'])assert.equal(hostAllowed(h,{...pc,lan:false}),true,h);
  for(const h of ['192.168.1.20:3000','yard-pc:3000','attacker.example:3000','127.0.0.1.attacker.example','',undefined,'127.0.0.2:3000','[fe80::1]:3000'])assert.equal(hostAllowed(h,{...pc,lan:false}),false,String(h));
  for(const h of ['192.168.1.20:3000','YARD-PC:3000','yard-pc.local:3000','[fe80::1]:3000'])assert.equal(hostAllowed(h,{...pc,lan:true}),true,h);
  assert.equal(hostAllowed('192.168.1.21:3000',{...pc,lan:true}),false,'another machine on the network');
  assert.equal(hostAllowed('yard.example.com',{...pc,lan:false,extra:['yard.example.com']}),true);
  assert.equal(hostAllowed('evil.com:3000',{...pc,lan:true,extra:['yard.example.com']}),false);
});

test('D5: the server listens on this PC only unless Wi-Fi sharing is switched on (HOST still wins)',()=>{
  assert.equal(listenHost({env:{},lanSharing:false}),'127.0.0.1');
  assert.equal(listenHost({env:{},lanSharing:true}),'0.0.0.0');
  assert.equal(listenHost({env:{HOST:'127.0.0.1'},lanSharing:true}),'127.0.0.1');
  const launcher=readFileSync(new URL('../scripts/launch.cmd',import.meta.url),'utf8');
  assert.ok(!/HOST=0\.0\.0\.0/.test(launcher),'the desktop launcher no longer opens the port to the whole network');
});

test('D4: registration is open on a new server only; afterwards 403 unless the administrator switches it on',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const {req}=await serve(t,db);
  assert.deepEqual((await req('GET','/api/welcome')).json,{register:true},'a new server offers "Create company"');
  const first=await req('POST','/api/register',{body:company('first')});assert.equal(first.status,200,'first run');const admin=cookieOf(first);
  assert.deepEqual((await req('GET','/api/welcome')).json,{register:false});
  const second=await req('POST','/api/register',{body:company('second')});assert.equal(second.status,403,'open registration returned 200 before the fix');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n,1);
  const me=(await req('GET','/api/me',{cookie:admin})).json;assert.equal(me.admin,true,'whoever creates the first company runs the server');
  assert.deepEqual((await req('GET','/api/server-settings',{cookie:admin})).json.openRegistration,false);
  assert.equal((await req('POST','/api/server-settings',{cookie:admin,body:{openRegistration:true}})).status,200);
  assert.equal((await req('POST','/api/register',{body:company('second')})).status,200,'switched on by the administrator');
  const other=cookieOf(await req('POST','/api/login',{body:{email:'second@example.test',password:pw}}));
  assert.equal((await req('GET','/api/me',{cookie:other})).json.admin,false,'a later company owner is not the administrator');
  assert.equal((await req('POST','/api/server-settings',{cookie:other,body:{openRegistration:false}})).status,403);
  assert.equal((await req('GET','/api/server-settings',{cookie:other})).status,403);
  assert.equal((await req('POST','/api/server-settings',{cookie:admin,body:{openRegistration:false}})).status,200);
  assert.equal((await req('POST','/api/register',{body:company('third')})).status,403);
  openRegistration(t);assert.equal((await req('POST','/api/register',{body:company('third')})).status,200,'SCAFFOLD_OPEN_REGISTRATION=1 (tests and the browser suite)');
});

test('D3 (fc-eng/probe.log): register, users and memberships answer the same for a known and an unknown email',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const {req}=await serve(t,db);
  const a=cookieOf(await req('POST','/api/register',{body:company('a')}));
  openRegistration(t);cookieOf(await req('POST','/api/register',{body:company('b')}));delete process.env.SCAFFOLD_OPEN_REGISTRATION;
  const same=(x,y,label)=>{assert.equal(x.status,y.status,label);assert.deepEqual(Object.keys(x.json).sort(),Object.keys(y.json).sort(),label);if(x.json.error||y.json.error)assert.equal(x.json.error,y.json.error,label);};
  same(await req('POST','/api/register',{body:company('b')}),await req('POST','/api/register',{body:company('nobody')}),'register (409 "That email cannot be used." before)');
  const known={name:'X',email:'b@example.test',password:pw,roles:['SUPERVISOR']},unknown={...known,email:'nobody@example.test'};
  const u1=await req('POST','/api/users',{cookie:a,body:known}),u2=await req('POST','/api/users',{cookie:a,body:unknown});same(u1,u2,'users');assert.equal(u1.status,201);
  const m1=await req('POST','/api/memberships',{cookie:a,body:{email:'b@example.test',roles:['OWNER']}}),m2=await req('POST','/api/memberships',{cookie:a,body:{email:'nobody2@example.test',roles:['OWNER']}});
  same(m1,m2,'memberships (201 vs 404 "No existing account has that email" before)');assert.equal(m1.status,201);
  // The invitation page shows the same things whether or not the email already signs in somewhere.
  const i1=await req('POST','/api/invitation',{body:{token:tokenOf(m1.json.link)}}),i2=await req('POST','/api/invitation',{body:{token:tokenOf(m2.json.link)}});same(i1,i2,'invitation details');
});

test('F1 (fc-eng/probe.log): a membership needs the invitee\'s own acceptance, the link works once, and an owner can remove a member',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const {req}=await serve(t,db);
  const a=cookieOf(await req('POST','/api/register',{body:company('a')}));
  openRegistration(t);const b=cookieOf(await req('POST','/api/register',{body:company('b')}));
  const names=async c=>(await req('GET','/api/me',{cookie:c})).json.memberships.map(m=>m.name).sort();
  const invite=await req('POST','/api/memberships',{cookie:a,body:{email:'b@example.test',roles:['OWNER']}});assert.equal(invite.status,201);
  assert.deepEqual(await names(b),['Yard b'],'B is NOT made a member of A without saying yes (201 + membership before the fix)');
  const token=tokenOf(invite.json.link);assert.match(token,/^[0-9a-f]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invitations WHERE token_hash=?').get(token).n,0,'only a hash of the link is stored');
  const info=(await req('POST','/api/invitation',{body:{token}})).json;assert.equal(info.company,'Yard a');assert.deepEqual(info.roles,['OWNER']);assert.equal(info.email,'b@example.test');
  assert.equal((await req('POST','/api/accept-invite',{body:{token,name:'B',password:'the-wrong-password'}})).status,401);
  assert.deepEqual(await names(b),['Yard b']);
  const accepted=await req('POST','/api/accept-invite',{body:{token,name:'B',password:pw}});assert.equal(accepted.status,200);
  const bInA=cookieOf(accepted);assert.equal((await req('GET','/api/me',{cookie:bInA})).json.company.name,'Yard a','signed in to the company that invited them');
  assert.deepEqual(await names(b),['Yard a','Yard b']);
  assert.equal((await req('POST','/api/accept-invite',{body:{token,name:'B',password:pw}})).status,404,'the link works once');
  assert.equal((await req('POST','/api/invitation',{body:{token}})).status,404);
  // A new person sets their own password.
  const sup=await req('POST','/api/users',{cookie:a,body:{name:'Sam',email:'sam@example.test',roles:['SUPERVISOR']}});
  const samIn=await req('POST','/api/accept-invite',{body:{token:tokenOf(sup.json.link),name:'Sam',password:'sams-own-password'}});assert.equal(samIn.status,200);
  const sam=cookieOf(await req('POST','/api/login',{body:{email:'sam@example.test',password:'sams-own-password'}}));assert.ok(sam);
  assert.deepEqual((await req('GET','/api/me',{cookie:sam})).json.roles,['SUPERVISOR']);
  // Expired and cancelled links are refused.
  const late=await req('POST','/api/users',{cookie:a,body:{name:'Late',email:'late@example.test',roles:['SUPERVISOR']}});db.prepare('UPDATE invitations SET expires_at=0 WHERE email=?').run('late@example.test');
  assert.equal((await req('POST','/api/accept-invite',{body:{token:tokenOf(late.json.link),name:'Late',password:pw}})).status,404);
  const gone=await req('POST','/api/users',{cookie:a,body:{name:'Gone',email:'gone@example.test',roles:['SUPERVISOR']}});
  assert.equal((await req('POST','/api/invitations/cancel',{cookie:a,body:{id:gone.json.id}})).status,200);
  assert.equal((await req('POST','/api/accept-invite',{body:{token:tokenOf(gone.json.link),name:'Gone',password:pw}})).status,404);
  assert.equal((await req('POST','/api/invitations/cancel',{cookie:b,body:{id:late.json.id}})).status,404,'another company cannot touch A\'s invitations');
  // Pending invitations are listed for the people who can invite; a fresh link replaces the old one.
  const pending=(await req('GET','/api/me',{cookie:a})).json.invitations;assert.deepEqual(pending.map(i=>i.email),['late@example.test']);
  const renewed=await req('POST','/api/invitations/renew',{cookie:a,body:{id:late.json.id}});assert.equal(renewed.status,200);
  assert.equal((await req('POST','/api/invitation',{body:{token:tokenOf(late.json.link)}})).status,404,'the old link stops working');
  assert.equal((await req('POST','/api/invitation',{body:{token:tokenOf(renewed.json.link)}})).status,200);
  // Removing a member (there was no route: 404 in sec-probe.log).
  const users=(await req('GET','/api/me',{cookie:a})).json.users,samId=users.find(u=>u.email==='sam@example.test').id,bId=users.find(u=>u.email==='b@example.test').id,aId=users.find(u=>u.email==='a@example.test').id;
  const audits=db.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
  assert.equal((await req('POST','/api/members/remove',{cookie:sam,body:{userId:bId}})).status,403,'a supervisor cannot');
  assert.equal((await req('POST','/api/members/remove',{cookie:a,body:{userId:samId}})).status,200);
  assert.equal((await req('GET','/api/me',{cookie:sam})).status,401,'their session in that company ends at once');
  assert.equal((await req('POST','/api/login',{body:{email:'sam@example.test',password:'sams-own-password'}})).status,401,'with no company left they cannot sign in');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,audits+1,'history is kept; the removal is recorded');
  assert.equal((await req('POST','/api/members/remove',{cookie:a,body:{userId:aId}})).status,409,'not yourself');
  assert.equal((await req('POST','/api/members/remove',{cookie:bInA,body:{userId:aId}})).status,200,'B (an owner of A by acceptance) may remove another owner');
  assert.equal((await req('GET','/api/me',{cookie:a})).status,401);
  const a2=cookieOf(await req('POST','/api/login',{body:{email:'a@example.test',password:pw}}));assert.equal(a2,undefined,'A has no company left either');
  assert.equal((await req('POST','/api/members/remove',{cookie:bInA,body:{userId:bId}})).status,409,'never yourself, so an owner can never remove the last owner');
  assert.deepEqual(await names(b),['Yard a','Yard b'],'removing A did not touch B');
  // Someone removed can be invited back and says yes again.
  const back=await req('POST','/api/users',{cookie:bInA,body:{name:'Sam',email:'sam@example.test',roles:['GENERAL_MANAGER']}});
  assert.equal((await req('POST','/api/accept-invite',{body:{token:tokenOf(back.json.link),name:'Sam',password:'sams-own-password'}})).status,200);
  const samBack=cookieOf(await req('POST','/api/login',{body:{email:'sam@example.test',password:'sams-own-password'}}));assert.deepEqual((await req('GET','/api/me',{cookie:samBack})).json.roles,['GENERAL_MANAGER'],'the old roles did not come back');
});

test('invitations: managers invite managers and supervisors, never owners; only owners remove people',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const s=new Service(db),owner=s.authenticate(s.register(company('o')));
  s.addUser(owner,{name:'GM',email:'gm@example.test',password:pw,roles:['GENERAL_MANAGER']});const gm=s.authenticate(s.login({email:'gm@example.test',password:pw}));
  assert.match(s.invite(gm,{email:'sup@example.test',roles:['SUPERVISOR']}).token,/^[0-9a-f]{64}$/);
  assert.throws(()=>s.invite(gm,{email:'boss@example.test',roles:['OWNER']}),{status:403});
  s.addUser(owner,{name:'Sup',email:'s@example.test',password:pw,roles:['SUPERVISOR']});const sup=s.authenticate(s.login({email:'s@example.test',password:pw}));
  assert.throws(()=>s.invite(sup,{email:'x@example.test',roles:['SUPERVISOR']}),{status:403});
  assert.throws(()=>s.removeMember(gm,{userId:sup.id}),{status:403});
  assert.throws(()=>s.invite(owner,{email:'x@example.test',roles:['ADMIN']}),{status:400});
  assert.throws(()=>s.invite(owner,{email:'not-an-email',roles:['SUPERVISOR']}),{status:400});
});

test('D6: only the server administrator sees file paths and backs up the whole server',async t=>{
  const dir=temp(),path=join(dir,'live.sqlite'),db=openDatabase(path);t.after(()=>db.close());
  const backups=createBackups({databasePath:path,directory:join(dir,'b'),log:()=>{}});const {req}=await serve(t,db,{backups});
  const a=cookieOf(await req('POST','/api/register',{body:company('a')}));openRegistration(t);const b=cookieOf(await req('POST','/api/register',{body:company('b')}));
  const mine=await req('GET','/api/backups',{cookie:a});assert.equal(mine.json.databasePath,path);
  const theirs=await req('GET','/api/backups',{cookie:b});assert.equal(theirs.status,200);
  assert.ok(!('databasePath' in theirs.json)&&!('directory' in theirs.json),'B saw databasePath before the fix');
  assert.ok(!theirs.text.includes(dir.replaceAll('\\','\\\\'))&&!/[A-Za-z]:\\\\|\/tmp\//.test(theirs.text),'no filesystem path at all: '+theirs.text);
  assert.equal(theirs.json.serverManaged,true);
  assert.equal((await req('POST','/api/backup-now',{cookie:b,body:{}})).status,403,'a tenant owner cannot copy the whole server');
  const made=await req('POST','/api/backup-now',{cookie:a,body:{}});assert.equal(made.status,200);assert.ok(existsSync(made.json.file));
  for(const route of ['/api/me','/api/server-settings'])assert.ok(!(await req('GET',route,{cookie:b})).text.includes(dir.replaceAll('\\','\\\\')),route);
});

test('D6: SCAFFOLD_ADMIN_EMAIL names the administrator instead', t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const s=new Service(db);const first=s.authenticate(s.register(company('first')));const later=s.authenticate(s.register(company('later')));
  assert.equal(s.isAdmin(first),true);assert.equal(s.isAdmin(later),false);
  const was=process.env.SCAFFOLD_ADMIN_EMAIL;process.env.SCAFFOLD_ADMIN_EMAIL='Later@Example.test';t.after(()=>{if(was===undefined)delete process.env.SCAFFOLD_ADMIN_EMAIL;else process.env.SCAFFOLD_ADMIN_EMAIL=was;});
  assert.equal(s.isAdmin(first),false);assert.equal(s.isAdmin(later),true);
});

test('migration 006: on an existing server everyone who created a company so far keeps the administrator\'s rights',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const s=new Service(db);const bot=s.authenticate(s.register(company('bot'))),owner=s.authenticate(s.register(company('owner')));
  s.addUser(owner,{name:'Sup',email:'sup@example.test',password:pw,roles:['SUPERVISOR']});
  db.exec('DELETE FROM server_admins');// as before 006 ran
  const line=readFileSync(new URL('../src/migrations/006_invitations.sql',import.meta.url),'utf8').split('\n').find(l=>l.startsWith('INSERT OR IGNORE INTO server_admins'));db.exec(line);
  assert.equal(s.isAdmin(bot),true);assert.equal(s.isAdmin(owner),true,'the owner on his own PC keeps Backups');
  assert.equal(s.isAdmin(s.authenticate(s.login({email:'sup@example.test',password:pw}))),false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('memberships') WHERE name='removed_at'").get().n,1);
});

// ---- D12: the port is claimed before the database, the engine or the backups are touched ----
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
function start(t,env){
  const child=spawn(process.execPath,['src/server.js'],{cwd:new URL('..',import.meta.url),env:(()=>{const e={...process.env,...env};delete e.HOST;return e;})(),stdio:['ignore','pipe','pipe']});
  let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);t.after(()=>{if(child.exitCode===null)child.kill();});
  const exited=new Promise(r=>child.on('exit',code=>r(code)));
  return {child,out:()=>out,exited,until:async(re,ms=15000)=>{const end=Date.now()+ms;while(!re.test(out)&&Date.now()<end&&child.exitCode===null)await new Promise(r=>setTimeout(r,50));return re.test(out);}};
}
test('D12: a busy port stops the start cleanly, before the database or backups are opened',async t=>{
  const dir=temp(),port=await freePort(),other=net.createServer();await new Promise(r=>other.listen(port,'127.0.0.1',r));t.after(()=>other.close());
  const run=start(t,{PORT:String(port),DATABASE_PATH:join(dir,'x.sqlite'),BACKUP_DIR:join(dir,'b')});
  const code=await Promise.race([run.exited,new Promise(r=>setTimeout(()=>r('still running'),15000))]);
  assert.equal(code,1,run.out());assert.match(run.out(),new RegExp(`port ${port} is in use`,'i'));
  assert.ok(!/EADDRINUSE|at Server\.|node:events/.test(run.out()),'no crash dump: '+run.out());
  assert.equal(existsSync(join(dir,'x.sqlite')),false,'the database was not opened (the engine and backups had started before the fix)');
  assert.equal(existsSync(join(dir,'b')),false);
});
test('D12: when Scaffold Yard itself holds the port the start says so and exits quietly',async t=>{
  const dir=temp(),port=await freePort();
  const fake=http.createServer((q,s)=>{s.writeHead(200,{'Content-Type':'application/json'});s.end(JSON.stringify({status:'ok',mode:'simulation',database:6}));});await new Promise(r=>fake.listen(port,'127.0.0.1',r));t.after(()=>fake.close());
  const run=start(t,{PORT:String(port),DATABASE_PATH:join(dir,'x.sqlite'),BACKUP_DIR:join(dir,'b')});
  const code=await Promise.race([run.exited,new Promise(r=>setTimeout(()=>r('still running'),15000))]);
  assert.equal(code,0,run.out());assert.match(run.out(),/Scaffold Yard is already running/);assert.equal(existsSync(join(dir,'x.sqlite')),false);
});
test('D5 + D12: a normal start listens on 127.0.0.1 only and answers only when ready',async t=>{
  const dir=temp(),port=await freePort();
  const run=start(t,{PORT:String(port),DATABASE_PATH:join(dir,'x.sqlite'),BACKUP_DIR:join(dir,'b')});
  assert.ok(await run.until(/Scaffold Yard: http:\/\/127\.0\.0\.1:\d+/),run.out());
  assert.ok(!/other devices|Wi-Fi/.test(run.out()),run.out());
  const health=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(health.status,200);
  run.child.kill();await run.exited;
});

test('the sign-in throttle counts failures only (probe: 12 correct sign-ins gave 429 from the 7th)',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const {req}=await serve(t,db);
  assert.equal((await req('POST','/api/register',{body:company('a')})).status,200);
  const good=[];for(let i=0;i<12;i++)good.push((await req('POST','/api/login',{body:{email:'a@example.test',password:pw}})).status);
  assert.deepEqual(good,Array(12).fill(200));
  const bad=[];for(let i=0;i<12;i++)bad.push((await req('POST','/api/login',{body:{email:'a@example.test',password:'not-the-password'}})).status);
  assert.deepEqual(bad,[...Array(10).fill(401),429,429]);
  assert.equal((await req('POST','/api/login',{body:{email:'a@example.test',password:pw}})).status,429,'then everything waits a minute');
});
