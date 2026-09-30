import { createCipheriv, createDecipheriv, createHash, createPrivateKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, scryptSync, constants } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AppError } from './service.js';

// Encrypted backup copies (for a USB drive or another synced folder) and the restore drill.
//
// The passphrase is never stored. Setting up makes a key pair: the public half encrypts every copy automatically; the private half is
// locked with a key derived from the passphrase (scrypt) and AES-256-GCM, and that locked key travels inside every encrypted copy, so the
// passphrase alone opens a copy even if this PC is gone. Without the passphrase nobody can read the copies, including us.
// A copy: MAGIC, 4-byte header length, JSON header (also authenticated), the database encrypted with AES-256-GCM under a random key
// (wrapped with RSA-OAEP-SHA256), then the 16-byte GCM tag.
// What this does not do: prove who made a copy. The public key (kept in plain next to the live database) is enough to make a well-formed copy
// that the passphrase opens, so a copy is only as trustworthy as the folder it was kept in (KNOWN_LIMITATIONS.md).
const MAGIC=Buffer.from('SCAFFOLD-YARD-ENCRYPTED-BACKUP\n'),TAG=16,MAXMEM=512*1024*1024;
export const KEY_COST={N:2**17,r:8,p:1};
export const MIN_PASSPHRASE=12;
export const ENCRYPTED_SUFFIX='.enc';
const b64=buffer=>buffer.toString('base64'),unb64=text=>Buffer.from(String(text),'base64');
const derive=(passphrase,salt,{N,r,p})=>scryptSync(String(passphrase).normalize('NFC'),salt,32,{N,r,p,maxmem:MAXMEM});

export function checkPassphrase(passphrase){
  if(typeof passphrase!=='string'||[...passphrase].length<MIN_PASSPHRASE)throw new AppError(400,`Choose a passphrase of at least ${MIN_PASSPHRASE} characters (a few words you will remember works well).`);
  if(passphrase.length>1024)throw new AppError(400,'That passphrase is too long.');
}
// The key kept on this PC: a public key and the private key locked with the passphrase. Nothing in it opens a copy without the passphrase.
export function createBackupKey(passphrase,cost={}){
  checkPassphrase(passphrase);
  const {N,r,p}={...KEY_COST,...cost};
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'der'}});
  const salt=randomBytes(16),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derive(passphrase,salt,{N,r,p}),iv),data=Buffer.concat([cipher.update(privateKey),cipher.final()]);
  return {v:1,publicKey,lockedKey:{kdf:'scrypt',N,r,p,salt:b64(salt),cipher:'aes-256-gcm',iv:b64(iv),tag:b64(cipher.getAuthTag()),data:b64(data)},fingerprint:createHash('sha256').update(publicKey).digest('hex').slice(0,16),createdAt:new Date().toISOString()};
}
function unlock(lockedKey,passphrase){
  try{const k=derive(passphrase,unb64(lockedKey.salt),lockedKey),d=createDecipheriv('aes-256-gcm',k,unb64(lockedKey.iv));d.setAuthTag(unb64(lockedKey.tag));return createPrivateKey({key:Buffer.concat([d.update(unb64(lockedKey.data)),d.final()]),format:'der',type:'pkcs8'});}
  catch{throw new AppError(400,'The passphrase is not right for this encrypted copy.');}
}
// Encrypts one backup file into dest (written as dest.partial, then renamed, so a copy is never half there).
export function encryptBackup(source,dest,key){
  const plain=readFileSync(source),dataKey=randomBytes(32),iv=randomBytes(12);
  const header=Buffer.from(JSON.stringify({v:1,cipher:'aes-256-gcm',iv:b64(iv),wrappedKey:b64(publicEncrypt({key:key.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},dataKey)),lockedKey:key.lockedKey,fingerprint:key.fingerprint,source:basename(source),createdAt:new Date().toISOString()}));
  const cipher=createCipheriv('aes-256-gcm',dataKey,iv);cipher.setAAD(header);
  const body=Buffer.concat([cipher.update(plain),cipher.final()]),length=Buffer.alloc(4);length.writeUInt32BE(header.length);
  const partial=dest+'.partial';
  try{writeFileSync(partial,Buffer.concat([MAGIC,length,header,body,cipher.getAuthTag()]));renameSync(partial,dest);}catch(error){rmSync(partial,{force:true});throw error;}
  return dest;
}
export function isEncryptedBackup(file){try{const b=readFileSync(file).subarray(0,MAGIC.length);return b.equals(MAGIC);}catch{return false;}}
// The database bytes of an encrypted copy, or a plain error: wrong passphrase, or a copy that was damaged or changed.
export function decryptBackup(file,passphrase){
  const all=readFileSync(file),damaged=()=>new AppError(400,'This encrypted copy is damaged or changed; it cannot be restored.');
  if(all.length<MAGIC.length+4+TAG||!all.subarray(0,MAGIC.length).equals(MAGIC))throw new AppError(400,'This is not an encrypted Scaffold Yard backup.');
  const size=all.readUInt32BE(MAGIC.length),start=MAGIC.length+4,headerBytes=all.subarray(start,start+size);
  let header;try{header=JSON.parse(headerBytes.toString('utf8'));}catch{throw damaged();}
  if(start+size+TAG>all.length||!header?.lockedKey)throw damaged();
  const privateKey=unlock(header.lockedKey,passphrase);
  try{
    const dataKey=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},unb64(header.wrappedKey));
    const d=createDecipheriv('aes-256-gcm',dataKey,unb64(header.iv));d.setAAD(headerBytes);d.setAuthTag(all.subarray(all.length-TAG));
    return Buffer.concat([d.update(all.subarray(start+size,all.length-TAG)),d.final()]);
  }catch{throw damaged();}
}

// Where the encrypted-copy settings live: next to the live database (on Windows the per-user local app-data folder), never in a backup.
export const offsiteSettingsPath=(databasePath,env=process.env)=>env.SCAFFOLD_BACKUP_SETTINGS||join(dirname(databasePath),'offsite-backup.json');

// ---- Restore drill (npm run restore-drill) ----
export const DRILL_LOG='restore-drill.log';
export function readDrillLog(directory){
  let text;try{text=readFileSync(join(directory,DRILL_LOG),'utf8');}catch{return null;}
  const lines=text.trim().split('\n').filter(Boolean);for(let i=lines.length-1;i>=0;i--)try{return JSON.parse(lines[i]);}catch{}return null;
}
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
const counts=db=>Object.fromEntries(tables(db).map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM "${t.replaceAll('"','""')}"`).get().n]));
// The backups a drill can restore: this database's plain copies in the backup folder, and its encrypted copies in the encrypted-copy folder.
export function findBackups({directory,name='scaffold',offsiteFolder=null}){
  const list=[],prefix=name+'-',plain=/^\d{4}-\d{2}-\d{2}(T\d{2}-\d{2}-\d{2}-manual)?\.sqlite$|^before-update-v\d+-to-v\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/;
  const scan=(dir,encrypted)=>{let names=[];try{names=readdirSync(dir);}catch{return;}for(const n of names){if(!n.startsWith(prefix))continue;const rest=n.slice(prefix.length);const base=encrypted?(rest.endsWith(ENCRYPTED_SUFFIX)?rest.slice(0,-ENCRYPTED_SUFFIX.length):null):rest;if(base&&plain.test(base))try{list.push({file:join(dir,n),encrypted,at:statSync(join(dir,n)).mtimeMs});}catch{}}};
  scan(directory,false);if(offsiteFolder)scan(offsiteFolder,true);
  return list.sort((a,b)=>b.at-a.at);
}
// Restores one backup into a temporary folder, runs a full integrity check, compares row counts with the live database and logs one line.
// Not logged: a drill that stopped before restoring anything because the passphrase was missing or wrong (that says nothing about the backups,
// and Account > Backups would show "did not pass" for it).
// file: a given backup; otherwise the newest plain backup (encrypted:true = the newest encrypted copy, which needs the passphrase).
export async function restoreDrill({databasePath,directory,name='scaffold',offsiteFolder=null,file=null,encrypted=false,passphrase=async()=>null,now=()=>new Date()}){
  const started=Date.now(),entry={at:now().toISOString(),ok:false,file:null,encrypted:false};let work=null;
  try{
    const all=findBackups({directory,name,offsiteFolder});
    const pick=file?{file,encrypted:isEncryptedBackup(file)}:encrypted?all.find(b=>b.encrypted):(all.find(b=>!b.encrypted)??all.find(b=>b.encrypted));
    if(!pick)throw new Error(encrypted?'No encrypted copy found'+(offsiteFolder?` in ${offsiteFolder}`:' (no encrypted-copy folder is set up)'):`No backup found in ${directory}`);
    entry.file=pick.file;entry.encrypted=pick.encrypted;
    work=mkdtempSync(join(tmpdir(),'scaffold-restore-drill-'));const restored=join(work,'restored.sqlite');
    if(pick.encrypted){const pass=await passphrase();if(!pass){entry.noPassphrase=true;throw new Error('The encrypted copy needs its passphrase');}
      try{writeFileSync(restored,decryptBackup(pick.file,pass));}catch(error){if(/passphrase is not right/.test(error.message))entry.noPassphrase=true;throw error;}}
    else copyFileSync(pick.file,restored);
    const db=new DatabaseSync(restored,{readOnly:true});
    try{entry.integrity=db.prepare('PRAGMA integrity_check').all().map(r=>Object.values(r)[0]).join('; ');entry.rows=counts(db);}catch(error){entry.integrity=error.message;}finally{db.close();}
    if(databasePath&&existsSync(databasePath)){const live=new DatabaseSync(databasePath,{readOnly:true});try{entry.live=counts(live);}finally{live.close();}}
    const problems=[];
    if(entry.integrity!=='ok')problems.push('the integrity check did not pass: '+entry.integrity);
    else if(!entry.rows?.schema_migrations)problems.push('it is not a Scaffold Yard database');
    else if(entry.live?.companies>0&&!entry.rows.companies)problems.push('it has no companies in it');
    if(problems.length)throw new Error('The restored copy failed: '+problems.join('; '));
    entry.ok=true;
  }catch(error){entry.error=error.message;}
  finally{if(work)try{rmSync(work,{recursive:true,force:true});}catch{}}
  entry.ms=Date.now()-started;
  if(entry.noPassphrase){entry.notLogged=true;return entry;}
  try{mkdirSync(directory,{recursive:true});appendFileSync(join(directory,DRILL_LOG),JSON.stringify(entry)+'\n');}catch(error){entry.logError=error.message;}
  return entry;
}
