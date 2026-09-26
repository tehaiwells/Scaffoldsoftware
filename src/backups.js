import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stamp } from './relocate.js';

// Automatic backups: <name>-YYYY-MM-DD.sqlite, one per day. "Back up now" writes <name>-YYYY-MM-DDTHH-MM-SS-manual.sqlite; the 10 newest of those are kept.
// <name> is "scaffold" for the app's own database and names any other (DATABASE_PATH) database uniquely (backupName in paths.js), so databases sharing a folder never mix.
const DAY=86400000,escapeRe=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=name=>{const n=escapeRe(name);return {daily:new RegExp(`^${n}-(\\d{4})-(\\d{2})-(\\d{2})\\.sqlite$`),manual:new RegExp(`^${n}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-manual\\.sqlite$`),partial:new RegExp(`^${n}-\\d{4}-\\d{2}-\\d{2}(T\\d{2}-\\d{2}-\\d{2}-manual)?\\.sqlite\\.partial(-wal|-shm|-journal)?$`)};};
const localDate=(date=new Date())=>{const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;};
export const dailyName=(date=new Date(),name='scaffold')=>`${name}-${localDate(date)}.sqlite`;
// Day number of a daily file name's date, or null when it is not a real calendar date (e.g. 2026-13-01 or 2026-02-31).
const dayNumber=match=>{if(!match)return null;const [y,m,d]=[+match[1],+match[2],+match[3]],at=new Date(Date.UTC(y,m-1,d));return at.getUTCFullYear()===y&&at.getUTCMonth()===m-1&&at.getUTCDate()===d?at.getTime()/DAY:null;};
// ISO-style week key (weeks start on Monday) for a day number.
const weekOf=day=>Math.floor((day+3)/7);

// Pure rotation rule. Keeps the 14 newest daily backups, plus the newest daily backup of each of the last 8 weeks (counting back from `today`), and the 10 newest "Back up now" copies.
// Only this database's files named exactly <name>-YYYY-MM-DD.sqlite or <name>-<date>T<time>-manual.sqlite are ever removed; every other file is left alone.
// Daily files dated after today (from a clock that was wrong for a while) or with an impossible date are left alone and never push real backups out of the 14.
export function planRotation(names,today=new Date(),{daily=14,weeks=8,manual=10,name='scaffold'}={}){
  const {daily:DAILY,manual:MANUAL}=patterns(name),todayNumber=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())/DAY,thisWeek=weekOf(todayNumber);
  const dated=names.map(n=>({n,day:dayNumber(DAILY.exec(n))})).filter(x=>x.day!==null&&x.day<=todayNumber).sort((a,b)=>b.day-a.day),keep=new Set(dated.slice(0,daily).map(x=>x.n)),seen=new Set();
  for(const {n,day} of dated){const week=weekOf(day);if(thisWeek-week<weeks&&!seen.has(week)){seen.add(week);keep.add(n);}}
  const manuals=names.filter(n=>MANUAL.test(n)).sort().reverse();
  return {keep:dated.map(x=>x.n).filter(n=>keep.has(n)),remove:[...dated.map(x=>x.n).filter(n=>!keep.has(n)),...manuals.slice(manual)],keepManual:manuals.slice(0,manual)};
}

// Runs inside the server process. Backups read the live file through their own read-only connection and copy it in one step on a worker thread,
// so they never run inside a scheduler transaction and never block the event loop for the copy itself (WAL readers do not block the writer).
export function createBackups({databasePath,directory,name='scaffold',log=console.log,now=()=>new Date(),minGapMs=60000,keepManual=10}={}){
  databasePath=resolve(databasePath);directory=resolve(directory);
  const {daily:DAILY,manual:MANUAL,partial:PARTIAL}=patterns(name);
  let running=null,lastAttempt=null,lastError=null,lastManual=0,timer=null,startTimer=null;
  const list=()=>{try{return readdirSync(directory).filter(n=>DAILY.test(n)||MANUAL.test(n)).map(file=>({name:file,at:statSync(join(directory,file)).mtimeMs,manual:MANUAL.test(file)})).sort((a,b)=>b.at-a.at);}catch{return [];}};
  // Unfinished copies of this database left by a server that stopped mid-backup.
  const sweep=()=>{if(running)return;let names=[];try{names=readdirSync(directory);}catch{return;}for(const file of names.filter(n=>PARTIAL.test(n)))try{rmSync(join(directory,file),{force:true});}catch(error){log(`Could not remove the unfinished backup ${file}: ${error.message}`);}};
  async function run(file){
    if(running)return running;
    running=(async()=>{
      const when=now(),path=join(directory,file),partial=`${path}.partial`;let source=null;
      try{
        if(databasePath===':memory:'||!existsSync(databasePath))throw new Error('there is no database file to back up');
        if(existsSync(path))throw new Error(`${file} already exists`);
        mkdirSync(directory,{recursive:true});removeSet(partial);
        source=new DatabaseSync(databasePath,{readOnly:true});
        await backup(source,partial,{rate:1000000});source.close();source=null;
        const copy=new DatabaseSync(partial);try{const check=copy.prepare('PRAGMA quick_check').get();if(Object.values(check)[0]!=='ok')throw new Error('the copy failed its check');copy.exec('PRAGMA journal_mode=DELETE');}finally{copy.close();}
        renameSync(partial,path);
        const removed=[];for(const old of planRotation(readdirSync(directory),when,{name,manual:keepManual}).remove){try{rmSync(join(directory,old));removed.push(old);}catch(error){log(`Backup rotation could not remove ${old}: ${error.message}`);}}
        lastAttempt={at:when.getTime(),ok:true,file:path};lastError=null;
        log(`Backup saved: ${path}${removed.length?` (removed ${removed.length} old backup${removed.length>1?'s':''}: ${removed.join(', ')})`:''}`);
        return {ok:true,file:path,removed};
      }catch(error){
        try{source?.close();}catch{}try{removeSet(partial);}catch{}
        lastAttempt={at:when.getTime(),ok:false};lastError=error.message;log(`Backup FAILED (${error.message}). The live database was not changed.`);
        return {ok:false,error:error.message};
      }finally{running=null;}
    })();
    return running;
  }
  const newestDaily=()=>list().find(b=>!b.manual);
  // Once a day: the first check after midnight (checks run hourly) makes that day's file. At start-up: only if the newest daily backup is older than 24 h.
  const due=(startup=false)=>{if(existsSync(join(directory,dailyName(now(),name))))return false;const newest=newestDaily();return !newest||!startup||now().getTime()-newest.at>=DAY;};
  const tick=async startup=>{if(due(startup))await run(dailyName(now(),name));};
  return {
    directory,databasePath,name,run,due,tick,list,sweep,
    // Delay the start-up backup a little so it never competes with the first page loads, then check hourly.
    start({startupDelayMs=30000,intervalMs=3600000}={}){sweep();startTimer=setTimeout(()=>tick(true),startupDelayMs);startTimer.unref();timer=setInterval(()=>tick(false),intervalMs);timer.unref();},
    stop(){clearTimeout(startTimer);clearInterval(timer);},
    async backupNow(){
      if(running)return {ok:false,busy:true,error:'A backup is already running. Try again in a moment.'};
      const wait=lastManual+minGapMs-Date.now();if(wait>0)return {ok:false,busy:true,error:`A backup was made moments ago. Try again in ${Math.ceil(wait/1000)} s.`};
      lastManual=Date.now();return run(`${name}-${stamp(now())}-manual.sqlite`);
    },
    status(){const all=list(),last=all[0];return {databasePath,directory,lastBackup:last?{name:last.name,at:new Date(last.at).toISOString(),manual:last.manual}:null,daily:all.filter(b=>!b.manual).length,manual:all.filter(b=>b.manual).length,lastError,lastAttempt:lastAttempt&&{at:new Date(lastAttempt.at).toISOString(),ok:lastAttempt.ok},running:!!running,policy:`The 14 newest daily backups are kept, plus one per week for 8 weeks, and the ${keepManual} newest made with “Back up now”.`};}
  };
}
const removeSet=path=>{for(const suffix of ['','-wal','-shm','-journal'])rmSync(path+suffix,{force:true});};
