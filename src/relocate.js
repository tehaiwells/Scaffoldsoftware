import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupDirectory, defaultDatabasePath, legacyDatabasePath, projectRoot } from './paths.js';

// A file-safe local timestamp, e.g. 2026-09-26T07-05-09.
export const stamp=(date=new Date())=>{const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;};
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
export const rowCounts=db=>Object.fromEntries(tables(db).map(name=>[name,db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"','""')}"`).get().n]));
const hasLease=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_lease'").get();
const removeSet=path=>{for(const suffix of ['','-wal','-shm','-journal'])rmSync(path+suffix,{force:true});};

// Decide which database file the server opens, moving the old project-folder database to its new home once.
// Only when DATABASE_PATH is unset, the new file does not exist and the old one does. The old file is never changed unless the copy is complete and verified;
// it is then renamed (kept as a backup that can never be picked up by accident) and a note says where the live database went. Idempotent: later starts find the new file and do nothing.
export async function prepareDatabase({env=process.env,root=projectRoot,platform=process.platform,now=()=>new Date(),log=console.log}={}){
  if(env.DATABASE_PATH)return {path:resolve(env.DATABASE_PATH),status:'env'};
  const target=defaultDatabasePath({env,platform,root}),legacy=legacyDatabasePath(root);
  if(resolve(target)===resolve(legacy))return {path:legacy,status:'default'};
  if(existsSync(target)){if(existsSync(legacy))log(`Database: using ${target}. Note: an older database file also exists at ${legacy}; it is NOT used (move or delete it yourself if you do not need it).`);return {path:target,status:'current'};}
  if(!existsSync(legacy))return {path:target,status:'new'};
  const keep=reason=>{log(`Database NOT moved (${reason}). Still using ${legacy}. Nothing was changed; the move is tried again on the next start.`);return {path:legacy,status:'kept',reason};};
  const when=now(),partial=`${target}.partial-${stamp(when)}`,moved=`${legacy}.moved-${stamp(when)}`,owner=`relocation-${randomUUID()}`;
  let source=null,copy=null,claimed=false,renamed=false;
  try{
    source=new DatabaseSync(legacy);source.exec('PRAGMA busy_timeout=5000');
    if(hasLease(source)){
      // Another server holding a live engine lease is using this file: refuse. Otherwise hold the lease ourselves so no server can start on it while it is copied.
      source.exec('BEGIN IMMEDIATE');
      try{const lease=source.prepare('SELECT owner,expires_at FROM engine_lease WHERE id=1').get();
        if(lease&&lease.expires_at>=Date.now()){source.exec('ROLLBACK');source.close();source=null;return keep('another Scaffold Yard server seems to be running on it; close that server window and start again');}
        source.prepare('INSERT INTO engine_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(owner,Date.now()+600000);source.exec('COMMIT');claimed=true;
      }catch(error){try{source.exec('ROLLBACK');}catch{}throw error;}
    }
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before=rowCounts(source);
    mkdirSync(dirname(target),{recursive:true});
    await backup(source,partial,{rate:1000000});
    copy=new DatabaseSync(partial);
    const check=copy.prepare('PRAGMA integrity_check').all().map(r=>Object.values(r)[0]).join('; ');
    if(check!=='ok')throw new Error(`copy failed its integrity check: ${check}`);
    const after=rowCounts(copy),diff=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(name=>before[name]!==after[name]);
    if(diff.length)throw new Error(`copy row counts differ for ${diff.join(', ')}`);
    if(claimed)copy.prepare('DELETE FROM engine_lease WHERE owner=?').run(owner);
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');copy.close();copy=null;
    if(claimed){source.prepare('DELETE FROM engine_lease WHERE owner=?').run(owner);claimed=false;}
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');source.close();source=null;
    // SQLite removes the -wal file when the last connection closes. If it is still there, something else has the old database open: do not move it.
    if(existsSync(`${legacy}-wal`))throw new Error('another program still has the old database open');
    renameSync(legacy,moved);renamed=true;
    for(const suffix of ['-wal','-shm'])if(existsSync(legacy+suffix))renameSync(legacy+suffix,moved+suffix);
    for(const suffix of ['-wal','-shm'])rmSync(partial+suffix,{force:true});
    renameSync(partial,target);
    try{writeFileSync(join(dirname(legacy),'DATABASE-MOVED.txt'),[`The live Scaffold Yard database was moved on ${when.toString()}.`,'',`It now lives at:`,`  ${target}`,'','That folder is on this computer only and is not synced, so the server can write to it quickly without OneDrive getting in the way.',`The old file was kept, renamed, as a backup: ${moved}`,'The server never opens that renamed file.',`Daily backups are saved in ${backupDirectory({env,root})} (see the Account page, "Backups").`,'','To use a different location, set the DATABASE_PATH environment variable before starting the server.',''].join('\r\n'));}catch(error){log(`Database moved, but the note in ${dirname(legacy)} could not be written: ${error.message}`);}
    log(`Database moved to ${target} (checked: integrity ok, ${Object.keys(before).length} tables with identical row counts). The old file is kept as ${moved}.`);
    return {path:target,status:'moved',moved};
  }catch(error){
    try{copy?.close();}catch{}
    if(renamed&&!existsSync(legacy)){try{renameSync(moved,legacy);for(const suffix of ['-wal','-shm'])if(existsSync(moved+suffix))renameSync(moved+suffix,legacy+suffix);}catch(undo){log(`Database move failed and the old file could not be renamed back: ${undo.message}. Rename ${moved} back to ${legacy} by hand.`);}}
    try{if(!source&&claimed)source=new DatabaseSync(legacy);if(claimed)source.prepare('DELETE FROM engine_lease WHERE owner=?').run(owner);}catch{}
    try{source?.close();}catch{}
    removeSet(partial);
    return keep(error.message);
  }
}
