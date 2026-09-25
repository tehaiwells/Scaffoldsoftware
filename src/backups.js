import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stamp } from './relocate.js';

// Automatic backups: scaffold-YYYY-MM-DD.sqlite, one per day. "Back up now" writes scaffold-YYYY-MM-DDTHH-MM-SS-manual.sqlite, which is never deleted automatically.
const DAILY=/^scaffold-(\d{4})-(\d{2})-(\d{2})\.sqlite$/,MANUAL=/^scaffold-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-manual\.sqlite$/,DAY=86400000;
const localDate=(date=new Date())=>{const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;};
export const dailyName=(date=new Date())=>`scaffold-${localDate(date)}.sqlite`;
const dayNumber=name=>{const m=DAILY.exec(name);return m?Date.UTC(+m[1],+m[2]-1,+m[3])/DAY:null;};
// ISO-style week key (weeks start on Monday) for a day number.
const weekOf=day=>Math.floor((day+3)/7);

// Pure rotation rule. Keeps the 14 newest daily backups, plus the newest daily backup of each of the last 8 weeks (counting back from `today`).
// Only files named exactly scaffold-YYYY-MM-DD.sqlite are ever candidates for removal; every other file (manual backups, anything the owner put there) is left alone.
export function planRotation(names,today=new Date(),{daily=14,weeks=8}={}){
  const todayNumber=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())/DAY,thisWeek=weekOf(todayNumber);
  const dated=names.filter(n=>DAILY.test(n)).sort().reverse(),keep=new Set(dated.slice(0,daily)),seen=new Set();
  for(const name of dated){const week=weekOf(dayNumber(name));if(thisWeek-week<weeks&&thisWeek-week>=0&&!seen.has(week)){seen.add(week);keep.add(name);}}
  return {keep:dated.filter(n=>keep.has(n)),remove:dated.filter(n=>!keep.has(n))};
}

// Runs inside the server process. Backups read the live file through their own read-only connection and copy it in one step on a worker thread,
// so they never run inside a scheduler transaction and never block the event loop for the copy itself (WAL readers do not block the writer).
export function createBackups({databasePath,directory,log=console.log,now=()=>new Date(),minGapMs=60000}={}){
  databasePath=resolve(databasePath);directory=resolve(directory);
  let running=null,lastAttempt=null,lastError=null,lastManual=0,timer=null,startTimer=null;
  const list=()=>{try{return readdirSync(directory).filter(n=>DAILY.test(n)||MANUAL.test(n)).map(name=>({name,at:statSync(join(directory,name)).mtimeMs,manual:MANUAL.test(name)})).sort((a,b)=>b.at-a.at);}catch{return [];}};
  async function run(name){
    if(running)return running;
    running=(async()=>{
      const when=now(),file=join(directory,name),partial=`${file}.partial`;let source=null;
      try{
        if(databasePath===':memory:'||!existsSync(databasePath))throw new Error('there is no database file to back up');
        if(existsSync(file))throw new Error(`${name} already exists`);
        mkdirSync(directory,{recursive:true});removeSet(partial);
        source=new DatabaseSync(databasePath,{readOnly:true});
        await backup(source,partial,{rate:1000000});source.close();source=null;
        const copy=new DatabaseSync(partial);try{const check=copy.prepare('PRAGMA quick_check').get();if(Object.values(check)[0]!=='ok')throw new Error('the copy failed its check');copy.exec('PRAGMA journal_mode=DELETE');}finally{copy.close();}
        renameSync(partial,file);
        const removed=[];for(const old of planRotation(readdirSync(directory),when).remove){try{rmSync(join(directory,old));removed.push(old);}catch(error){log(`Backup rotation could not remove ${old}: ${error.message}`);}}
        lastAttempt={at:when.getTime(),ok:true,file};lastError=null;
        log(`Backup saved: ${file}${removed.length?` (removed ${removed.length} old daily backup${removed.length>1?'s':''}: ${removed.join(', ')})`:''}`);
        return {ok:true,file,removed};
      }catch(error){
        try{source?.close();}catch{}removeSet(partial);
        lastAttempt={at:when.getTime(),ok:false};lastError=error.message;log(`Backup FAILED (${error.message}). The live database was not changed.`);
        return {ok:false,error:error.message};
      }finally{running=null;}
    })();
    return running;
  }
  const newestDaily=()=>list().find(b=>!b.manual);
  // Once a day: the first check after midnight (checks run hourly) makes that day's file. At start-up: only if the newest daily backup is older than 24 h.
  const due=(startup=false)=>{if(existsSync(join(directory,dailyName(now()))))return false;const newest=newestDaily();return !newest||!startup||now().getTime()-newest.at>=DAY;};
  const tick=async startup=>{if(due(startup))await run(dailyName(now()));};
  return {
    directory,databasePath,run,due,tick,list,
    // Delay the start-up backup a little so it never competes with the first page loads, then check hourly.
    start({startupDelayMs=30000,intervalMs=3600000}={}){startTimer=setTimeout(()=>tick(true),startupDelayMs);startTimer.unref();timer=setInterval(()=>tick(false),intervalMs);timer.unref();},
    stop(){clearTimeout(startTimer);clearInterval(timer);},
    async backupNow(){
      if(running)return {ok:false,busy:true,error:'A backup is already running. Try again in a moment.'};
      const wait=lastManual+minGapMs-Date.now();if(wait>0)return {ok:false,busy:true,error:`A backup was made moments ago. Try again in ${Math.ceil(wait/1000)} s.`};
      lastManual=Date.now();return run(`scaffold-${stamp(now())}-manual.sqlite`);
    },
    status(){const all=list(),last=all[0];return {databasePath,directory,lastBackup:last?{name:last.name,at:new Date(last.at).toISOString(),manual:last.manual}:null,daily:all.filter(b=>!b.manual).length,manual:all.filter(b=>b.manual).length,lastError,lastAttempt:lastAttempt&&{at:new Date(lastAttempt.at).toISOString(),ok:lastAttempt.ok},running:!!running,policy:'The 14 newest daily backups are kept, plus one per week for 8 weeks. Backups made with “Back up now” are kept until you delete them.'};}
  };
}
const removeSet=path=>{for(const suffix of ['','-wal','-shm','-journal'])rmSync(path+suffix,{force:true});};
