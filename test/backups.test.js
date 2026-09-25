import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';
import { defaultDatabasePath, legacyDatabasePath, resolveDatabasePath, backupDirectory } from '../src/paths.js';
import { prepareDatabase, rowCounts } from '../src/relocate.js';
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
  const result=await prepareDatabase({env,root:dir,platform:'win32',now,log});
  const target=defaultDatabasePath({env,platform:'win32',root:dir});
  assert.equal(result.status,'moved');assert.equal(result.path,target);
  assert.ok(!existsSync(legacy),'the old path is gone, so nothing can open it silently');
  assert.ok(existsSync(`${legacy}.moved-2026-09-26T07-05-09`),'the old file is kept under a new name');
  assert.match(readFileSync(join(dir,'data','DATABASE-MOVED.txt'),'utf8'),new RegExp(target.replaceAll('\\','\\\\')));
  const db=new DatabaseSync(target);assert.deepEqual(rowCounts(db),counts);assert.equal(db.prepare('SELECT COUNT(*) n FROM engine_lease').get().n,0);db.close();
  const old=new DatabaseSync(`${legacy}.moved-2026-09-26T07-05-09`);assert.deepEqual(rowCounts(old),counts);old.close();
  assert.equal(log.lines.length,1);assert.match(log.lines[0],/^Database moved to /);
  assert.deepEqual(readdirSync(join(dir,'local','ScaffoldYard')),['scaffold.sqlite'],'no partial copy is left behind');
  const again=await prepareDatabase({env,root:dir,platform:'win32',log});assert.equal(again.status,'current');assert.equal(again.path,target);
  // The moved database opens and works as the live one.
  const live=openDatabase(target);assert.ok(new Service(live).login(owner));live.close();
});

test('the move is refused while another server holds a live engine lease, and the old database is left exactly as it was',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir);makeDatabase(legacy);
  const other=new DatabaseSync(legacy);other.prepare('INSERT INTO engine_lease VALUES(1,?,?)').run('another-server',Date.now()+60000);const before=rowCounts(other);
  const log=quiet(),result=await prepareDatabase({env,root:dir,platform:'win32',log});
  assert.equal(result.status,'kept');assert.equal(result.path,legacy);assert.match(log.lines[0],/NOT moved .*another Scaffold Yard server/);
  assert.deepEqual(rowCounts(other),before);assert.equal(other.prepare('SELECT owner FROM engine_lease').get().owner,'another-server');other.close();
  assert.ok(!existsSync(defaultDatabasePath({env,platform:'win32',root:dir})));assert.deepEqual(readdirSync(join(dir,'data')).filter(n=>/moved|MOVED/.test(n)),[]);
});

test('an expired lease (a server that stopped abruptly) does not block the move, and the stale lease is cleared',async t=>{
  const dir=temp(t),env=winEnv(dir),legacy=legacyDatabasePath(dir);makeDatabase(legacy);
  const db=new DatabaseSync(legacy);db.prepare('INSERT INTO engine_lease VALUES(1,?,?)').run('crashed',Date.now()-10000);db.close();
  const result=await prepareDatabase({env,root:dir,platform:'win32',log:quiet()});assert.equal(result.status,'moved');
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
  const log=quiet(),result=await prepareDatabase({env,root:dir,platform:'win32',log});other.close();
  assert.equal(result.status,'kept');assert.match(log.lines[0],/still has the old database open/);
  assert.ok(existsSync(legacy));assert.ok(!existsSync(defaultDatabasePath({env,platform:'win32',root:dir})));assert.deepEqual(readdirSync(join(dir,'local','ScaffoldYard')),[]);
  const db=new DatabaseSync(legacy);assert.deepEqual(rowCounts(db),counts);db.close();
});

test('DATABASE_PATH, a fresh install and a non-Windows default never move anything',async t=>{
  const dir=temp(t);makeDatabase(legacyDatabasePath(dir));
  assert.deepEqual(await prepareDatabase({env:{DATABASE_PATH:join(dir,'mine.sqlite'),...winEnv(dir)},root:dir,platform:'win32',log:quiet()}),{path:join(dir,'mine.sqlite'),status:'env'});
  assert.equal((await prepareDatabase({env:{},root:dir,platform:'linux',log:quiet()})).status,'default');
  assert.ok(existsSync(legacyDatabasePath(dir)));
  const fresh=temp(t);assert.equal((await prepareDatabase({env:winEnv(fresh),root:fresh,platform:'win32',log:quiet()})).status,'new');
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
  assert.deepEqual(planRotation(['a.sqlite','scaffold-2020-01-01-manual.sqlite'],today),{keep:[],remove:[]});
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
