import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';

const input=(suffix='a')=>({companyName:`Yard ${suffix}`,name:'Owner',email:`${suffix}@example.com`,password:'a-long-test-password',systems:['quickstage']});
function setup(t){const db=openDatabase(':memory:');t.after(()=>db.close());return {db,s:new Service(db)};}
test('registration creates owner, hashed credentials and audit atomically',t=>{const {db,s}=setup(t);const u=s.authenticate(s.register(input()));assert.ok(s.permissions(u).includes('company.manage'));assert.notEqual(db.prepare('SELECT password_hash FROM users').get().password_hash,input().password);assert.equal(s.snapshot(u).audit.length,1);assert.equal(s.snapshot(u).systems.filter(x=>x.enabled).length,1);});
test('duplicate email rolls back the entire company registration',t=>{const {db,s}=setup(t);s.register(input());assert.throws(()=>s.register(input()),{status:409});assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,1);});
test('login, expiry and logout reject invalid sessions',t=>{const {db,s}=setup(t);s.register(input());assert.throws(()=>s.login({...input(),password:'wrong'}),{status:401});const token=s.login(input());s.authenticate(token);s.logout(token);assert.throws(()=>s.authenticate(token),{status:401});const expired=s.login(input());db.prepare('UPDATE sessions SET expires_at=0').run();assert.throws(()=>s.authenticate(expired),{status:401});});
test('tenant isolation ignores client company identifiers',t=>{const {s}=setup(t);const a=s.authenticate(s.register(input('a'))),b=s.authenticate(s.register(input('b')));s.updateCompany(a,{name:'Changed A',systems:['at-pac'],company_id:b.company_id});assert.equal(s.snapshot(b).company.name,'Yard b');assert.equal(s.snapshot(b).users.length,1);assert.equal(s.snapshot(b).audit.length,1);assert.equal(s.snapshot(b).systems.find(x=>x.id==='quickstage').enabled,1);});
test('multiple roles grant operational access but no company or financial access',t=>{const {s}=setup(t);const owner=s.authenticate(s.register(input()));s.addUser(owner,{...input('member'),roles:['GENERAL_MANAGER','SUPERVISOR']});const member=s.authenticate(s.login(input('member')));assert.ok(s.permissions(member).includes('operations.manage'));assert.ok(s.permissions(member).includes('sites.assigned'));assert.ok(!s.permissions(member).includes('finance.view'));assert.throws(()=>s.updateCompany(member,{name:'No',systems:['quickstage']}),{status:403});assert.throws(()=>s.addUser(member,{...input('other'),roles:['OWNER']}),{status:403});assert.deepEqual(s.snapshot(member).users,[]);});
test('invalid role rolls back and cross-tenant role association fails',t=>{const {db,s}=setup(t);const a=s.authenticate(s.register(input('a'))),b=s.authenticate(s.register(input('b')));assert.throws(()=>s.addUser(a,{...input('c'),roles:['ADMIN']}),{status:400});assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);assert.throws(()=>db.prepare('INSERT INTO user_roles VALUES(?,?,?)').run(a.company_id,b.id,'OWNER'));});
test('system disabling preserves records, supports re-enable and future systems',t=>{const {db,s}=setup(t);const u=s.authenticate(s.register(input()));s.updateCompany(u,{name:'Yard',systems:['at-pac']});assert.equal(db.prepare("SELECT enabled FROM company_systems WHERE system_id='quickstage'").get().enabled,0);db.prepare('INSERT INTO scaffold_systems VALUES(?,?)').run('future','Future system');s.updateCompany(u,{name:'Yard',systems:['quickstage','future']});assert.equal(s.snapshot(u).systems.filter(x=>x.enabled).length,2);assert.throws(()=>s.updateCompany(u,{name:'Yard',systems:[]}),{status:400});assert.throws(()=>s.updateCompany(u,{name:'Yard',systems:['unknown']}),{status:400});});
test('input validation rejects weak passwords and invalid email',t=>{const {db,s}=setup(t);assert.throws(()=>s.register({...input(),password:'short'}),{status:400});assert.throws(()=>s.register({...input(),email:'invalid'}),{status:400});assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n,0);});
test('HTTP startup, auth, cookie, CSRF, malformed inputs and authorization',async t=>{
  const db=openDatabase(':memory:'),server=createApp(db);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status,200);
  assert.equal((await fetch(`${base}/api/me`)).status,401);
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/register',input(),{Origin:'http://evil.example'})).status,403);
  const registered=await post('/api/register',input());assert.equal(registered.status,200);const cookie=registered.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const me=await fetch(`${base}/api/me`,{headers:{Cookie:cookie}});assert.equal(me.status,200);assert.equal((await me.json()).company.name,'Yard a');
  assert.equal((await post('/api/company',{name:'Updated',systems:['at-pac']},{Cookie:cookie})).status,200);
  assert.equal((await post('/api/company',null,{Cookie:cookie})).status,400);
  assert.equal((await fetch(`${base}/api/company`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{'})).status,400);
  assert.equal((await post('/api/logout',{}, {Cookie:cookie})).status,200);
  assert.equal((await fetch(`${base}/api/me`,{headers:{Cookie:cookie}})).status,401);
});
