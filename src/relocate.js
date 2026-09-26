import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { backupDirectory, defaultDatabasePath, legacyDatabasePath, projectRoot } from './paths.js';

// A file-safe local timestamp, e.g. 2026-09-26T07-05-09.
export const stamp=(date=new Date())=>{const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;};
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
export const rowCounts=db=>Object.fromEntries(tables(db).map(name=>[name,db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"','""')}"`).get().n]));
const hasTable=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const liveLease=db=>{if(!hasTable(db,'engine_lease'))return null;const lease=db.prepare('SELECT owner,expires_at FROM engine_lease WHERE id=1').get();return lease&&lease.expires_at>=Date.now()?lease:null;};
const removeSet=path=>{for(const suffix of ['','-wal','-shm','-journal'])rmSync(path+suffix,{force:true});};
const renameSet=(from,to)=>{renameSync(from,to);for(const suffix of ['-wal','-shm'])if(existsSync(from+suffix))renameSync(from+suffix,to+suffix);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const nothing=()=>{};

// An OS-level lock file next to the new database home. Every Scaffold Yard program that chooses (and may move or create) the database holds it while it does so:
// the server until its movement engine has claimed the database, the writing scripts until they finish. A second starter waits instead of racing.
// Created with 'wx' (fails if it exists), so only one process can hold it. A lock whose process is gone (or that is very old) is stale and is taken over.
export async function acquireRelocationLock(directory,{waitMs=60000,staleMs=15*60000,log=console.log}={}){
  mkdirSync(directory,{recursive:true});
  const file=join(directory,'relocate.lock'),started=Date.now();let told=false;
  for(;;){
    try{
      const fd=openSync(file,'wx');try{writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));}finally{closeSync(fd);}
      const mine=readFileSync(file,'utf8');let held=true;
      const release=()=>{if(!held)return;held=false;process.off('exit',release);try{if(readFileSync(file,'utf8')===mine)rmSync(file,{force:true});}catch{}};
      process.on('exit',release);return {file,release};
    }catch(error){if(error.code!=='EEXIST')throw error;}
    let text=null,holder=null;try{text=readFileSync(file,'utf8');holder=JSON.parse(text);}catch{}
    const age=(()=>{try{return Date.now()-statSync(file).mtimeMs;}catch{return 0;}})();
    const stale=holder?(holder.pid!==process.pid&&!alive(holder.pid))||Date.now()-holder.at>staleMs:text!==null&&age>10000;
    if(stale){try{if(readFileSync(file,'utf8')===text)rmSync(file,{force:true});}catch{}continue;}
    if(Date.now()-started>=waitMs)throw new Error(`another Scaffold Yard program (process ${holder?.pid??'unknown'}) is opening or moving the database and did not finish within ${Math.round(waitMs/1000)} s. If no other "Scaffold Yard server" window or script is running, delete ${file} and start again`);
    if(!told){told=true;log(`Waiting for another Scaffold Yard program (process ${holder?.pid??'unknown'}) that is opening the database…`);}
    await sleep(200);
  }
}

// Files that show the database has been moved before (the renamed old file, or a copy half-way to the new home).
const leftovers=(target,legacy)=>{
  const list=(dir,test)=>{try{return readdirSync(dir).filter(test).map(n=>join(dir,n));}catch{return [];}};
  return [...list(dirname(legacy),n=>n.startsWith(`${basename(legacy)}.moved-`)&&!/-(wal|shm)$/.test(n)),...list(dirname(target),n=>n.startsWith(`${basename(target)}.partial-`)&&!/-(wal|shm|journal)$/.test(n))];
};
// A database at the new home that is plainly not the real one: an empty file, or a database with no companies. Anything that cannot be read counts as real (never touched).
function emptyDatabase(path){
  try{if(statSync(path).size===0)return true;}catch{return false;}
  let db=null;try{db=new DatabaseSync(path,{readOnly:true});return !hasTable(db,'companies')||db.prepare('SELECT COUNT(*) n FROM companies').get().n===0;}catch{return false;}finally{try{db?.close();}catch{}}
}
const leaseOn=path=>{let db=null;try{db=new DatabaseSync(path,{readOnly:true});return liveLease(db);}catch{return null;}finally{try{db?.close();}catch{}}};
const missingMessage=(target,found)=>`there is no database at ${target}, but the database was moved before (found ${found.join(', ')}). Starting now would create a new, EMPTY database. Put the database back at ${target} (rename the newest of those files to scaffold.sqlite there), or set DATABASE_PATH to the file you want, then start again`;

// For scripts that write (seed:demo, import-catalogue): choose the database under the same lock as the server, and hold the lock until done,
// so a script can never write to the old file while the server is moving it, nor create an empty database at the new home while the real one sits elsewhere.
export async function lockDatabaseChoice({env=process.env,root=projectRoot,platform=process.platform,log=console.log,waitMs}={}){
  if(env.DATABASE_PATH)return {path:resolve(env.DATABASE_PATH),release:nothing};
  const target=defaultDatabasePath({env,platform,root}),legacy=legacyDatabasePath(root);
  if(resolve(target)===resolve(legacy))return {path:legacy,release:nothing};
  const lock=await acquireRelocationLock(dirname(target),{log,waitMs});
  try{
    if(existsSync(target))return {path:target,release:lock.release};
    if(existsSync(legacy))return {path:legacy,release:lock.release};
    const found=leftovers(target,legacy);if(found.length)throw new Error(missingMessage(target,found));
    return {path:target,release:lock.release};
  }catch(error){lock.release();throw error;}
}

// Decide which database file the server opens, moving the old project-folder database to its new home once.
// Only when DATABASE_PATH is unset, the new file does not exist and the old one does. The result carries release(): the caller keeps the relocation lock
// until its movement engine has claimed the database (or it has finished), so no second program can choose, move or create a database in between.
// Order of the move, so that a crash or a failure at any point leaves a complete database in place:
//   1. hold a write transaction on the old file (other writers wait; the OS drops it if this process dies — no lease row is written),
//   2. copy it with SQLite's backup API through a second connection and verify the copy (integrity_check, identical row counts),
//   3. rename the verified copy to the new home (the old file is still untouched),
//   4. release the old file and rename it to data/scaffold.sqlite.moved-<time>; if it changed in between, undo 3 and keep the old file.
export async function prepareDatabase({env=process.env,root=projectRoot,platform=process.platform,now=()=>new Date(),log=console.log,waitMs}={}){
  if(env.DATABASE_PATH)return {path:resolve(env.DATABASE_PATH),status:'env',release:nothing};
  const target=defaultDatabasePath({env,platform,root}),legacy=legacyDatabasePath(root);
  if(resolve(target)===resolve(legacy))return {path:legacy,status:'default',release:nothing};
  const keep=reason=>{log(`Database NOT moved (${reason}). Still using ${legacy}. Nothing was changed; the move is tried again on the next start.`);return {path:legacy,status:'kept',reason};};
  let lock;
  try{lock=await acquireRelocationLock(dirname(target),{log,waitMs});}
  catch(error){
    // The new home cannot even be created, so nothing can be moved there and the old file is safe to keep using.
    if(error.code&&existsSync(legacy)&&!existsSync(target))return {...keep(`the folder ${dirname(target)} cannot be used: ${error.message}`),release:nothing};
    throw error;
  }
  try{return {...await choose({env,root,target,legacy,now,log,keep}),release:lock.release};}catch(error){lock.release();throw error;}
}

async function choose({env,root,target,legacy,now,log,keep}){
  if(existsSync(legacy)){
    // Copies left half-way by an earlier run that stopped abruptly: the old file is still here and complete, so they are not needed.
    for(const partial of leftovers(target,legacy).filter(p=>p.startsWith(`${target}.partial-`))){try{removeSet(partial);}catch(error){log(`Could not remove the unfinished copy ${partial}: ${error.message}`);}}
  }
  if(existsSync(target)){
    if(!existsSync(legacy)){
      // After a move the new home must hold the real data. If it is empty (0 bytes or no companies) while a moved-aside old file has data, refuse rather than run on nothing.
      if(emptyDatabase(target)&&!leaseOn(target)){const found=leftovers(target,legacy).filter(p=>p.startsWith(`${legacy}.moved-`)&&!emptyDatabase(p));if(found.length)throw new Error(`the database at ${target} is empty, but the moved-aside old database ${found.join(', ')} has data. Rename the newest of those files to ${target} (after moving the empty one away), or set DATABASE_PATH to the file you want, then start again`);}
      return {path:target,status:'current'};
    }
    if(!emptyDatabase(target)||emptyDatabase(legacy)){log(`Database: using ${target}. Note: an older database file also exists at ${legacy}; it is NOT used (move or delete it yourself if you do not need it).`);return {path:target,status:'current'};}
    // The new home holds an empty database while the real one is still at the old place: never let the empty one win.
    if(leaseOn(target)){log(`WARNING: the database at ${target} has no companies while ${legacy} has data, but a Scaffold Yard server is running on ${target}. Close every "Scaffold Yard server" window and start again to move the real database.`);return {path:target,status:'current'};}
    const aside=`${target}.empty-${stamp(now())}`;
    try{renameSet(target,aside);}catch(error){return keep(`${target} holds an empty database that could not be set aside: ${error.message}`);}
    log(`The database at ${target} had no companies; it was set aside as ${aside} and the real one at ${legacy} is moved in its place.`);
  }
  if(!existsSync(legacy)){
    const found=leftovers(target,legacy);if(found.length)throw new Error(missingMessage(target,found));
    return {path:target,status:'new'};
  }
  return move({env,root,target,legacy,now,log,keep});
}

async function move({env,root,target,legacy,now,log,keep}){
  const when=now(),partial=`${target}.partial-${stamp(when)}`,moved=`${legacy}.moved-${stamp(when)}`;
  let guard=null,reader=null,copy=null,placed=false,renamed=false,before=null;
  try{
    guard=new DatabaseSync(legacy);guard.exec('PRAGMA busy_timeout=5000');
    guard.exec('BEGIN IMMEDIATE');
    if(liveLease(guard)){guard.exec('ROLLBACK');guard.close();guard=null;return keep('another Scaffold Yard server seems to be running on it; close that server window and start again');}
    // While the guard holds the write lock nothing can commit, so the copy, the counts and the old file all show the same state.
    reader=new DatabaseSync(legacy);reader.exec('PRAGMA busy_timeout=5000');
    before=rowCounts(reader);
    await backup(reader,partial,{rate:1000000});reader.close();reader=null;
    copy=new DatabaseSync(partial);
    const check=copy.prepare('PRAGMA integrity_check').all().map(r=>Object.values(r)[0]).join('; ');
    if(check!=='ok')throw new Error(`copy failed its integrity check: ${check}`);
    const after=rowCounts(copy),diff=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(name=>before[name]!==after[name]);
    if(diff.length)throw new Error(`copy row counts differ for ${diff.join(', ')}`);
    if(hasTable(copy,'engine_lease'))copy.exec('DELETE FROM engine_lease');// only an expired lease can be here
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');copy.close();copy=null;
    for(const suffix of ['-wal','-shm','-journal'])rmSync(partial+suffix,{force:true});
    renameSync(partial,target);placed=true;
    guard.exec('ROLLBACK');guard.close();guard=null;
    // SQLite removes the -wal file when the last connection closes. If it is still there, something else has the old database open: do not move it.
    if(existsSync(`${legacy}-wal`))throw new Error('another program still has the old database open');
    const seen=statSync(legacy);
    // Only the main file needs renaming (there is no -wal, checked above); a leftover -shm without a -wal holds nothing and is removed.
    renameSync(legacy,moved);renamed=true;try{rmSync(`${legacy}-shm`,{force:true});}catch{}
    // A program that opened, wrote and closed the old file in the moment between releasing it and renaming it would change it: detect that and undo.
    const kept=statSync(moved);
    if(kept.size!==seen.size||kept.mtimeMs!==seen.mtimeMs||existsSync(`${moved}-wal`))throw new Error('another program changed the old database during the move');
    try{writeFileSync(join(dirname(legacy),'DATABASE-MOVED.txt'),[`The live Scaffold Yard database was moved on ${when.toString()}.`,'',`It now lives at:`,`  ${target}`,'','That folder is on this computer only and is not synced, so the server can write to it quickly without OneDrive getting in the way.',`The old file was kept, renamed, as a backup: ${moved}`,'The server never opens that renamed file.',`Daily backups are saved in ${backupDirectory({env,root})} (see the Account page, "Backups").`,'','To use a different location, set the DATABASE_PATH environment variable before starting the server.',''].join('\r\n'));}catch(error){log(`Database moved, but the note in ${dirname(legacy)} could not be written: ${error.message}`);}
    log(`Database moved to ${target} (checked: integrity ok, ${Object.keys(before).length} tables with identical row counts). The old file is kept as ${moved}.`);
    return {path:target,status:'moved',moved};
  }catch(error){
    for(const db of [copy,reader])try{db?.close();}catch{}
    if(guard){try{guard.exec('ROLLBACK');}catch{}try{guard.close();}catch{}}
    let restored=true;
    if(renamed){try{renameSet(moved,legacy);}catch(undo){restored=false;log(`Database move failed and the old file could not be renamed back: ${undo.message}. Rename ${moved} back to ${legacy} by hand.`);}}
    if(placed){
      if(!restored){log(`WARNING: the database was moved to ${target}, but ${error.message}; that change is only in ${moved}.`);return {path:target,status:'moved',moved};}
      try{renameSet(target,partial);}catch(undo){log(`WARNING: ${error.message}, and the new copy at ${target} could not be taken back (${undo.message}). Using ${target}; the old file ${legacy} may hold a change that is not in it.`);return {path:target,status:'current'};}
    }
    try{removeSet(partial);}catch(cleanup){log(`Could not remove the unfinished copy ${partial}: ${cleanup.message}`);}
    return keep(error.message);
  }
}
