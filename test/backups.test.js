import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';
import { startScheduler } from '../src/simulation.js';
import { defaultDatabasePath, legacyDatabasePath, resolveDatabasePath, backupDirectory, backupName } from '../src/paths.js';
import { prepareDatabase, rowCounts, acquireRelocationLock, lockDatabaseChoice } from '../src/relocate.js';
import { createBackups, planRotation, dailyName } from '../src/backups.js';

// Temp folders are removed after every test has closed its databases and servers (Windows cannot delete open files).
const dirs=[];after(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true});});
const temp=()=>{const dir=mkdtempSync(join(tmpdir(),'scaffold-backup-test-'));dirs.push(dir);return dir;};
const owner={companyName:'Backup DEMO',name:'Owner',email:'owner@example.test',password:'a-long-test-password',systems:['quickstage']};
// A small real database with a company in it, closed again (as after a clean server stop).
function makeDatabase(path){const db=openDatabase(path);new Service(db).register(owner);const counts=rowCounts(db);db.close();return counts;}
const quiet=()=>{const lines=[];const log=line=>lines.push(line);log.lines=lines;return log;};
const winEnv=dir=>({LOCALAPPDATA:join(dir,'local')});

test('database path: DATABASE_PATH wins; Windows defaults to LOCALAPPDATA; elsewhere the project data folder',t=>{
  const dir=temp(t);
  assert.equal(defaultDatabasePath({env:{LOCALAPPDATA:join(dir,'L')},platform:'win32',root:dir}),join(dir,'L','ScaffoldYard','scaffold.sqlite'));
  assert.equal(defaultDatabasePath({env:{},platform:'win32',home:join(dir,'home'),root:dir}),join(dir,'home','AppData','Local','ScaffoldYard','scaffold.sqlite'));
  assert.equal(defaultDatabasePath({env:{},platform:'linux',root:dir}),join(dir,'data','scaffold.sqlite'));
  assert.equal(resolveDatabasePath({env:{DATABASE_PATH:join(dir,'x.sqlite')},platform:'win32',root:dir}),join(dir,'x.sqlite'));
  assert.equal(backupDirectory({env:{},root:dir}),join(dir,'data','backups'));assert.equal(backupDirectory({env:{BACKUP_DIR:join(dir,'b')},root:dir}),join(dir,'b'));
});

test('scripts keep using the old file until the server has moved it, and never create an empty database at the new home first',t=>{
  const dir=temp(t),env=winEnv(dir),options={env,platform:'win32',root:dir};
  assert.equal(resolveDatabasePath(options),defaultDatabasePath(options));// fresh install: new home
  makeDatabase(legacyDatabasePath(dir));assert.equal(resolveDatabasePath(options),legacyDatabasePath(dir));// not moved yet: old file
});

test('first start on the new version moves the old database: verified copy, old file renamed and kept, note written; later starts do nothing',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),counts=makeDatabase(legacy),log=quiet();
  const now=()=>new Date(2026,8,26,7,5,9);
  const result=await prepareDatabase({env,root:dir,platform:'win32',now,log});result.release();
  const target=defaultDatabasePath({env,platform:'win32',root:dir});
  assert.equal(result.status,'moved');assert.equal(result.path,target);
  assert.ok(!existsSync(legacy),'the old path is gone, so nothing can open it silently');
  assert.ok(existsSync(`${legacy}.moved-2026-09-26T07-05-09`),'the old file is kept under a new name');
  assert.match(readFileSync(join(dir,'data','DATABASE-MOVED.txt'),'utf8'),new RegExp(target.replaceAll('\\','\\\\')));
  const db=new DatabaseSync(target);assert.deepEqual(rowCounts(db),counts);assert.equal(db.prepare('SELECT COUNT(*) n FROM engine_lease').get().n,0);db.close();
  const old=new DatabaseSync(`${legacy}.moved-2026-09-26T07-05-09`);assert.deepEqual(rowCounts(old),counts);old.close();
  assert.equal(log.lines.length,1);assert.match(log.lines[0],/^Database moved to /);
  assert.deepEqual(readdirSync(join(dir,'local','ScaffoldYard')),['scaffold.sqlite'],'no partial copy is left behind');
  const again=await prepareDatabase({env,root:dir,platform:'win32',log});again.release();assert.equal(again.status,'current');assert.equal(again.path,target);
  // The moved database opens and works as the live one.
  const live=openDatabase(target);assert.ok(new Service(live).login(owner));live.close();
});

test('the move is refused while another server holds a live engine lease, and the old database is left exactly as it was',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir);makeDatabase(legacy);
  const other=new DatabaseSync(legacy);other.prepare('INSERT INTO engine_lease VALUES(1,?,?)').run('another-server',Date.now()+60000);const before=rowCounts(other);
  const log=quiet(),result=await prepareDatabase({env,root:dir,platform:'win32',log});result.release();
  assert.equal(result.status,'kept');assert.equal(result.path,legacy);assert.match(log.lines[0],/NOT moved .*another Scaffold Yard server/);
  assert.deepEqual(rowCounts(other),before);assert.equal(other.prepare('SELECT owner FROM engine_lease').get().owner,'another-server');other.close();
  assert.ok(!existsSync(defaultDatabasePath({env,platform:'win32',root:dir})));assert.deepEqual(readdirSync(join(dir,'data')).filter(n=>/moved|MOVED/.test(n)),[]);
});

test('an expired lease (a server that stopped abruptly) does not block the move, and the stale lease is cleared',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir);makeDatabase(legacy);
  const db=new DatabaseSync(legacy);db.prepare('INSERT INTO engine_lease VALUES(1,?,?)').run('crashed',Date.now()-10000);db.close();
  const result=await prepareDatabase({env,root:dir,platform:'win32',log:quiet()});result.release();assert.equal(result.status,'moved');
  const moved=new DatabaseSync(result.path);assert.equal(moved.prepare('SELECT COUNT(*) n FROM engine_lease').get().n,0,'no lease is carried over');assert.ok(moved.prepare('SELECT COUNT(*) n FROM companies').get().n===1);moved.close();
});

test('if the copy cannot be made, the old database stays in place and in use',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),counts=makeDatabase(legacy);
  writeFileSync(join(dir,'local'),'not a folder');// the new home cannot be created
  const log=quiet(),result=await prepareDatabase({env,root:dir,platform:'win32',log});
  assert.equal(result.status,'kept');assert.equal(result.path,legacy);assert.match(log.lines[0],/^Database NOT moved/);
  const db=new DatabaseSync(legacy);assert.deepEqual(rowCounts(db),counts);assert.equal(db.prepare('SELECT COUNT(*) n FROM engine_lease').get().n,0);db.close();
  assert.deepEqual(readdirSync(join(dir,'data')).filter(n=>/moved|MOVED/.test(n)),[]);
});

test('if another program still has the old database open, it is not moved',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),counts=makeDatabase(legacy);
  const other=new DatabaseSync(legacy);other.prepare('SELECT COUNT(*) FROM companies').get();
  const log=quiet(),result=await prepareDatabase({env,root:dir,platform:'win32',log});result.release();other.close();
  assert.equal(result.status,'kept');assert.match(log.lines[0],/still has the old database open/);
  assert.ok(existsSync(legacy));assert.ok(!existsSync(defaultDatabasePath({env,platform:'win32',root:dir})));assert.deepEqual(readdirSync(join(dir,'local','ScaffoldYard')),[]);
  const db=new DatabaseSync(legacy);assert.deepEqual(rowCounts(db),counts);db.close();
});

test('DATABASE_PATH, a fresh install and a non-Windows default never move anything',async t=>{
  const dir=temp(t);makeDatabase(legacyDatabasePath(dir));
  const custom=await prepareDatabase({env:{DATABASE_PATH:join(dir,'mine.sqlite'),...winEnv(dir)},root:dir,platform:'win32',log:quiet()});assert.equal(custom.path,join(dir,'mine.sqlite'));assert.equal(custom.status,'env');
  assert.equal((await prepareDatabase({env:{},root:dir,platform:'linux',log:quiet()})).status,'default');
  assert.ok(existsSync(legacyDatabasePath(dir)));
  const fresh=temp(t),first=await prepareDatabase({env:winEnv(fresh),root:fresh,platform:'win32',log:quiet()});first.release();assert.equal(first.status,'new');
});

test('rotation keeps the 14 newest daily backups plus one per week for 8 weeks and never touches other files',()=>{
  const today=new Date(2026,8,26),names=[];
  for(let i=0;i<120;i++){const d=new Date(2026,8,26-i);names.push(dailyName(d));}
  names.push('before-perf-2026-09-24.sqlite','scaffold-2026-01-01T10-00-00-manual.sqlite','notes.txt','scaffold-2026-09-26.sqlite.partial');
  const {keep,remove}=planRotation(names,today);
  assert.deepEqual(keep.slice(0,14),names.slice(0,14),'the 14 newest');
  const weekly=keep.slice(14);assert.ok(weekly.length>=5&&weekly.length<=7,`weekly extras: ${weekly}`);
  for(const name of keep)assert.ok(name>=dailyName(new Date(2026,8,26-62)),`${name} is within 8 weeks`);
  const weeks=new Set(keep.map(n=>{const [y,m,d]=n.slice(9,19).split('-').map(Number);return Math.floor((Date.UTC(y,m-1,d)/86400000+3)/7);}));assert.equal(weeks.size,8,'one or more per week, 8 weeks');
  assert.equal(keep.length+remove.length,120);for(const n of remove)assert.match(n,/^scaffold-\d{4}-\d{2}-\d{2}\.sqlite$/);
  assert.deepEqual(planRotation(names.slice(0,10),today).remove,[]);
  assert.deepEqual(planRotation(['a.sqlite','scaffold-2020-01-01-manual.sqlite'],today),{keep:[],remove:[],keepManual:[]});
});

test('a backup is a consistent, checked copy; rotation removes only old daily files; manual backups are rate limited',async t=>{
  const dir=temp(t),path=join(dir,'live.sqlite'),backups=join(dir,'backups');makeDatabase(path);
  const live=openDatabase(path);t.after(()=>live.close());
  mkdirSync(backups);for(let i=1;i<=30;i++){const f=join(backups,dailyName(new Date(2026,6,i)));writeFileSync(f,'old');utimesSync(f,new Date(2026,6,i),new Date(2026,6,i));}writeFileSync(join(backups,'keep-me.sqlite'),'x');
  const log=quiet(),manager=createBackups({databasePath:path,directory:backups,log,now:()=>new Date(2026,8,26,1,0,0),minGapMs:60000});
  assert.equal(manager.due(true),true);
  const result=await manager.run(dailyName(new Date(2026,8,26)));assert.equal(result.ok,true);
  const copy=new DatabaseSync(result.file,{readOnly:true});assert.deepEqual(rowCounts(copy),rowCounts(live));assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode,'delete');copy.close();
  const files=readdirSync(backups);assert.ok(files.includes('keep-me.sqlite'));assert.ok(files.includes('scaffold-2026-09-26.sqlite'));
  assert.ok(files.filter(n=>/^scaffold-2026-07-/.test(n)).length<30,'old daily files were rotated');assert.ok(!files.some(n=>n.endsWith('.partial')));
  assert.equal(manager.due(false),false,'today is done');
  const first=await manager.backupNow();assert.equal(first.ok,true);assert.match(first.file,/-manual\.sqlite$/);
  const second=await manager.backupNow();assert.equal(second.busy,true);
  const status=manager.status();assert.equal(status.manual,1);assert.equal(status.directory,backups);assert.equal(status.lastError,null);assert.ok(status.lastBackup);
  const missing=await createBackups({databasePath:join(dir,'nope.sqlite'),directory:backups,log}).run('x.sqlite');assert.equal(missing.ok,false);assert.match(log.lines.at(-1),/^Backup FAILED/);
});

test('backup endpoints are owner-only; Back up now is rate limited',async t=>{
  const dir=temp(t),path=join(dir,'live.sqlite');const db=openDatabase(path);const s=new Service(db);const token=s.register(owner);
  s.addUser(s.authenticate(token),{name:'Manager',email:'gm@example.test',password:'a-long-test-password',roles:['GENERAL_MANAGER']});const gm=s.login({email:'gm@example.test',password:'a-long-test-password'});
  const backups=createBackups({databasePath:path,directory:join(dir,'b'),log:quiet()}),server=createApp(db,{backups});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
  const url=p=>`http://127.0.0.1:${server.address().port}/api/${p}`,as=tok=>({cookie:`session=${tok}`});
  const post=tok=>fetch(url('backup-now'),{method:'POST',headers:{...as(tok),'Content-Type':'application/json'},body:'{}'});
  assert.equal((await fetch(url('backups'),{headers:as(gm)})).status,403);assert.equal((await post(gm)).status,403);assert.equal((await fetch(url('backups'))).status,401);
  const status=await (await fetch(url('backups'),{headers:as(token)})).json();assert.equal(status.databasePath,path);assert.equal(status.lastBackup,null);
  const made=await post(token);assert.equal(made.status,200);const body=await made.json();assert.equal(body.manual,1);assert.ok(existsSync(body.file));
  assert.equal((await post(token)).status,429);
  const plain=createApp(db);await new Promise(r=>plain.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>plain.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${plain.address().port}/api/backups`,{headers:as(token)})).status,404);
});

// ---- Crash, race and late-writer safety of the one-time move (review fixes) ----
const require=createRequire(import.meta.url),fs=require('node:fs');
const src=name=>pathToFileURL(join(import.meta.dirname,'..','src',name)).href;
const companies=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT COUNT(*) n FROM companies').get().n;}finally{db.close();}};
const leaseRows=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT COUNT(*) n FROM engine_lease').get().n;}finally{db.close();}};
// Patch a built-in function for the length of one call (the ESM named imports in src/ follow via syncBuiltinESMExports).
async function patched(module,key,replacement,body){const real=module[key];module[key]=replacement(real);syncBuiltinESMExports();try{return await body();}finally{module[key]=real;syncBuiltinESMExports();}}
// Runs prepareDatabase in a child process that is killed (like a power cut or a closed window) at the named point of the move.
function crashAt(point,dir){
  const code=`import { createRequire, syncBuiltinESMExports } from 'node:module';const require=createRequire(process.cwd()+'/');const fs=require('node:fs'),sqlite=require('node:sqlite');
    const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase(),{LEGACY,TARGET,POINT}=process.env,die=()=>{console.log('FAULT '+POINT);process.kill(process.pid,'SIGKILL');};
    const rename=fs.renameSync,copy=sqlite.backup;
    fs.renameSync=(a,b)=>{rename(a,b);if(POINT==='after-new-home'&&same(b,TARGET))die();if(POINT==='after-old-renamed'&&same(a,LEGACY))die();};
    sqlite.backup=async(...args)=>{const r=await copy(...args);if(POINT==='after-copy')die();if(POINT==='write-during-copy'){const db=new sqlite.DatabaseSync(LEGACY);try{db.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS review_marker(tag TEXT)');console.log('FAULT write-during-copy: WRITTEN');}catch(error){console.log('FAULT write-during-copy: '+error.message);}finally{db.close();}}return r;};syncBuiltinESMExports();
    const {prepareDatabase}=await import(process.env.RELOCATE);const r=await prepareDatabase({env:{LOCALAPPDATA:process.env.LAD},root:process.env.ROOT,platform:'win32',log:()=>{}});console.log('RESULT '+r.status);`;
  const env={...process.env,LEGACY:legacyDatabasePath(dir),TARGET:defaultDatabasePath({env:winEnv(dir),platform:'win32',root:dir}),POINT:point,RELOCATE:src('relocate.js'),LAD:join(dir,'local'),ROOT:dir};
  const out=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8'});assert.match(out.stdout,new RegExp(`FAULT ${point}`),out.stderr);return out.stdout;
}

for(const point of ['after-copy','after-new-home','after-old-renamed'])test(`a server killed during the move (${point}) never leaves an empty or blocked database: the next start uses the complete data at once`,async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),target=defaultDatabasePath({env,platform:'win32',root:dir}),counts=makeDatabase(legacy);
  crashAt(point,dir);
  if(existsSync(legacy))assert.equal(leaseRows(legacy),0,'the move never writes a lease that could block the next start');
  const log=quiet(),next=await prepareDatabase({env,root:dir,platform:'win32',log});next.release();
  assert.equal(next.path,target);assert.equal(next.status,point==='after-copy'?'moved':'current');
  const db=openDatabase(next.path);t.after(()=>db.close());assert.deepEqual(rowCounts(db),counts);assert.equal(companies(next.path),1);
  const stop=startScheduler(db);stop();// no leftover lease: the engine starts straight away
  assert.deepEqual(readdirSync(join(dir,'local','ScaffoldYard')).filter(n=>n.includes('.partial-')),[],'unfinished copies are cleared');
});

test('two servers started at the same moment: one moves, the other waits for it and then uses the moved database (never an empty one)',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),target=defaultDatabasePath({env,platform:'win32',root:dir});makeDatabase(legacy);
  const code=`const {prepareDatabase}=await import(process.env.RELOCATE);const {openDatabase}=await import(process.env.DATABASE);const {startScheduler}=await import(process.env.SIMULATION);
    const r=await prepareDatabase({env:{LOCALAPPDATA:process.env.LAD},root:process.env.ROOT,platform:'win32',log:()=>{}});
    if(!['new','env','default'].includes(r.status)&&!(await import('node:fs')).existsSync(r.path))throw new Error('missing');
    const db=openDatabase(r.path);let engine='started',stop=null;try{stop=startScheduler(db);}catch(e){engine=e.message;}r.release();
    console.log(JSON.stringify({status:r.status,path:r.path,engine,companies:db.prepare('SELECT COUNT(*) n FROM companies').get().n}));
    await new Promise(res=>setTimeout(res,600));stop?.();db.close();`;
  const childEnv={...process.env,RELOCATE:src('relocate.js'),DATABASE:src('database.js'),SIMULATION:src('simulation.js'),LAD:join(dir,'local'),ROOT:dir};
  const run=()=>new Promise(done=>{const kid=spawn(process.execPath,['--input-type=module','-e',code],{env:childEnv});let out='';kid.stdout.on('data',d=>out+=d);kid.stderr.on('data',d=>out+=d);kid.on('exit',()=>done(out));});
  const results=(await Promise.all([run(),run()])).map(out=>JSON.parse(out.trim().split(/\r?\n/).at(-1)));
  assert.deepEqual(results.map(r=>r.status).sort(),['current','moved']);
  for(const r of results){assert.equal(r.path,target);assert.equal(r.companies,1);}
  assert.equal(results.filter(r=>r.engine==='started').length,1,'only one movement engine runs');
  assert.ok(!existsSync(legacy));assert.equal(companies(target),1);
});

test('a relocation lock left by a dead process is taken over; a live one makes the next starter wait, then give up with a clear message',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir);makeDatabase(legacy);
  const home=join(dir,'local','ScaffoldYard'),lock=join(home,'relocate.lock');mkdirSync(home,{recursive:true});
  const gone=spawnSync(process.execPath,['-e','0']).pid;writeFileSync(lock,JSON.stringify({pid:gone,at:Date.now()}));
  const moved=await prepareDatabase({env,root:dir,platform:'win32',log:quiet()});assert.equal(moved.status,'moved');
  const log=quiet();await assert.rejects(prepareDatabase({env,root:dir,platform:'win32',log,waitMs:300}),/another Scaffold Yard program .*relocate\.lock/);assert.match(log.lines[0],/^Waiting for another Scaffold Yard program/);
  await assert.rejects(lockDatabaseChoice({env,root:dir,platform:'win32',log:quiet(),waitMs:300}),/another Scaffold Yard program/);
  moved.release();assert.ok(!existsSync(lock));
  const again=await acquireRelocationLock(home,{log:quiet()});assert.ok(existsSync(lock));again.release();again.release();assert.ok(!existsSync(lock));
});

test('a program that writes to the old database during the move is never lost: blocked while copying, and a write just before the rename undoes the move',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),target=defaultDatabasePath({env,platform:'win32',root:dir});makeDatabase(legacy);
  const write=(tag,timeout)=>{const db=new DatabaseSync(legacy);try{db.exec(`PRAGMA busy_timeout=${timeout};CREATE TABLE IF NOT EXISTS review_marker(tag TEXT)`);db.prepare('INSERT INTO review_marker VALUES(?)').run(tag);}finally{db.close();}};
  // 1. While the copy is made and checked, the old file is write-locked: a writer waits and then fails, instead of writing to a file that is about to be retired.
  const out=crashAt('write-during-copy',dir);assert.match(out,/FAULT write-during-copy: database is locked/);assert.match(out,/RESULT moved/);
  // 2. Start again from an unmoved database; this time a program opens, writes and closes the old file just before it is renamed.
  const moved=readdirSync(join(dir,'data')).find(n=>n.startsWith('scaffold.sqlite.moved-'));rmSync(target);fs.renameSync(join(dir,'data',moved),legacy);rmSync(join(dir,'data','DATABASE-MOVED.txt'));
  const log=quiet();
  const second=await patched(fs,'renameSync',real=>(a,b)=>{if(String(a).toLowerCase()===legacy.toLowerCase())write('before-rename',5000);return real(a,b);},()=>prepareDatabase({env,root:dir,platform:'win32',log}));
  second.release();
  assert.equal(second.status,'kept');assert.equal(second.path,legacy);assert.match(log.lines[0],/NOT moved \(another program changed the old database during the move\)/);
  assert.ok(!existsSync(target),'the move was undone');assert.deepEqual(readdirSync(join(dir,'local','ScaffoldYard')),[]);assert.deepEqual(readdirSync(join(dir,'data')).filter(n=>/moved|MOVED/.test(n)),[]);
  // 3. The next start moves it, late write included.
  const third=await prepareDatabase({env,root:dir,platform:'win32',log:quiet()});third.release();assert.equal(third.status,'moved');
  const db=new DatabaseSync(target,{readOnly:true});assert.deepEqual(db.prepare('SELECT tag FROM review_marker').all().map(r=>r.tag),['before-rename']);db.close();
});

test('an empty database at the new home never wins over the real one; a missing database after a move refuses to start instead of creating an empty one',async t=>{
  for(const kind of ['zero-byte','no-companies']){
    const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),target=defaultDatabasePath({env,platform:'win32',root:dir}),counts=makeDatabase(legacy);
    mkdirSync(dirname(target),{recursive:true});if(kind==='zero-byte')writeFileSync(target,'');else openDatabase(target).close();
    const log=quiet(),result=await prepareDatabase({env,root:dir,platform:'win32',log});result.release();
    assert.equal(result.status,'moved',kind);assert.match(log.lines[0],/had no companies; it was set aside/);
    const db=new DatabaseSync(target,{readOnly:true});assert.deepEqual(rowCounts(db),counts);db.close();
    assert.equal(readdirSync(dirname(target)).filter(n=>n.startsWith("scaffold.sqlite.empty-")&&!/-(wal|shm)$/.test(n)).length,1,'the empty one is kept aside, not deleted');
    // Later the live file goes missing (for example half-way through a manual restore): refuse rather than start empty.
    rmSync(target);
    await assert.rejects(prepareDatabase({env,root:dir,platform:'win32',log:quiet()}),/no database at .*EMPTY database/);
    await assert.rejects(lockDatabaseChoice({env,root:dir,platform:'win32',log:quiet()}),/EMPTY database/);
    assert.ok(!existsSync(target));
  }
});

test('databases sharing a backup folder never take each other\'s daily slot, count or rotate each other\'s files',async t=>{
  const dir=temp(t),folder=join(dir,'backups'),live=join(dir,'live.sqlite'),other=join(dir,'data','seed-validation.sqlite');makeDatabase(live);makeDatabase(other);
  assert.equal(backupName({env:{}}),'scaffold');const otherName=backupName({env:{DATABASE_PATH:other},databasePath:other});
  assert.match(otherName,/^scaffold-seed-validation-[0-9a-f]{8}$/);assert.notEqual(otherName,backupName({env:{DATABASE_PATH:join(dir,'x','seed-validation.sqlite')}}));
  const now=()=>new Date(2026,8,26,9,0,0);
  const theirs=createBackups({databasePath:other,directory:folder,name:otherName,log:quiet(),now});await theirs.tick(true);
  assert.deepEqual(readdirSync(folder),[`${otherName}-2026-09-26.sqlite`]);
  const mine=createBackups({databasePath:live,directory:folder,log:quiet(),now});
  assert.equal(mine.due(true),true);assert.equal(mine.status().lastBackup,null);assert.equal(mine.status().daily,0);
  await mine.tick(true);assert.equal(mine.status().daily,1);assert.equal(theirs.status().daily,1);assert.equal(mine.status().lastBackup.name,'scaffold-2026-09-26.sqlite');
  assert.deepEqual(planRotation([`${otherName}-2020-01-01.sqlite`],new Date(2026,8,26)).remove,[],'another database\'s files are never candidates');
});

test('rotation ignores future and impossible dates, and keeps only the 10 newest Back up now copies',()=>{
  const today=new Date(2026,8,26,1,0,0),real=[],future=[];
  for(let i=0;i<14;i++)real.push(dailyName(new Date(2026,8,26-i)));for(let i=1;i<=14;i++)future.push(dailyName(new Date(2027,0,i)));
  const plan=planRotation([...future,...real,'scaffold-2026-13-01.sqlite','scaffold-2026-02-31.sqlite'],today);
  assert.deepEqual(plan.keep,real,'all 14 real backups are kept');assert.deepEqual(plan.remove,[],'future-dated and impossible names are left alone');
  const manual=[];for(let i=0;i<12;i++)manual.push(`scaffold-2026-09-${String(10+i).padStart(2,'0')}T10-00-00-manual.sqlite`);
  const m=planRotation(manual,today);assert.deepEqual(m.remove.sort(),manual.slice(0,2));assert.equal(m.keepManual.length,10);
});

test('unfinished backup copies from an interrupted run are swept on start; other databases\' are not touched',t=>{
  const dir=temp(t),folder=join(dir,'b');mkdirSync(folder);
  for(const n of ['scaffold-2026-09-25.sqlite.partial','scaffold-2026-09-25.sqlite.partial-wal','scaffold-2026-09-25T10-00-00-manual.sqlite.partial','scaffold-other-12345678-2026-09-25.sqlite.partial','keep.partial'])writeFileSync(join(folder,n),'x');
  const manager=createBackups({databasePath:join(dir,'none.sqlite'),directory:folder,log:quiet()});manager.start({startupDelayMs:3600000});manager.stop();
  assert.deepEqual(readdirSync(folder).sort(),['keep.partial','scaffold-other-12345678-2026-09-25.sqlite.partial']);
});

test('after a move, an emptied new-home database (0 bytes or no companies) is never used while the moved-aside old file has data',async t=>{
  for(const kind of ['zero-byte','no-companies']){
    const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir),target=defaultDatabasePath({env,platform:'win32',root:dir});makeDatabase(legacy);
    const moved=await prepareDatabase({env,root:dir,platform:'win32',log:quiet()});moved.release();assert.equal(moved.status,'moved');
    rmSync(target);if(kind==='zero-byte')writeFileSync(target,'');else openDatabase(target).close();
    await assert.rejects(prepareDatabase({env,root:dir,platform:'win32',log:quiet()}),/is empty, but the moved-aside old database .*has data/,kind);
    assert.ok(!existsSync(join(dirname(target),'relocate.lock')),'the lock is released after refusing');
  }
  // A fresh install (nothing moved) still starts on a new, empty database.
  const fresh=temp(t),env=winEnv(fresh),target=defaultDatabasePath({env,platform:'win32',root:fresh});mkdirSync(dirname(target),{recursive:true});openDatabase(target).close();
  const ok=await prepareDatabase({env,root:fresh,platform:'win32',log:quiet()});ok.release();assert.equal(ok.status,'current');
});
