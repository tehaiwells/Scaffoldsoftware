import { createServer, get as httpGet } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase,cached } from './database.js';
import { Service, AppError } from './service.js';
import { Simulation, startScheduler } from './simulation.js';
import { prepareDatabase } from './relocate.js';
import { createBackups } from './backups.js';
import { backupDirectory, backupName, resolveDatabasePath } from './paths.js';
import { bdRoute, BD_LOGO_BODY } from './domain/brand.js';

// Which Host names this server answers (audit D1, F2). A page on any other name (DNS rebinding) gets 421 before anything runs.
// Always: the loopback names. While Wi-Fi sharing is on (the server listens beyond this PC): this PC's own addresses and name too.
// SCAFFOLD_HOSTS adds names, comma-separated (e.g. the name a TLS proxy in front of the server uses).
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']),IPV4=/^\d+\.\d+\.\d+\.\d+$/;
let addressMemo={at:0,list:[]};
export const localAddresses=()=>{if(Date.now()-addressMemo.at>30000){let list=[];try{list=Object.values(networkInterfaces()).flat().filter(i=>i&&!i.internal).map(i=>i.address);}catch{}addressMemo={at:Date.now(),list};}return addressMemo.list;};
const extraHosts=(env=process.env)=>String(env.SCAFFOLD_HOSTS??'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
export function hostAllowed(host,{lan=false,hostname=osHostname(),addresses=lan?localAddresses():[],extra=extraHosts()}={}){
  if(typeof host!=='string'||!host||host.length>300)return false;
  let name;try{const url=new URL('http://'+host);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)return false;name=url.hostname.toLowerCase();}catch{return false;}
  if(LOOPBACK.has(name)||extra.includes(name))return true;
  if(!lan)return false;
  const me=String(hostname??'').toLowerCase();if(me&&(name===me||name===me+'.local'))return true;
  return addresses.some(a=>name===(a.includes(':')?'['+a.toLowerCase()+']':a));
}
// Where the server listens (audit D5): this PC only, unless the administrator switched on Wi-Fi sharing in Account (read at start). HOST, if set, wins.
export const listenHost=({env=process.env,lanSharing=false}={})=>env.HOST||(lanSharing?'0.0.0.0':'127.0.0.1');
const loopbackHost=host=>['127.0.0.1','localhost','::1'].includes(host);
// The address in an invitation link: the page's own address, or this PC's Wi-Fi address when the owner is at the PC and phones can reach it.
function inviteOrigin(req,lan){const proto=req.socket.encrypted?'https':'http';let url;try{url=new URL(proto+'://'+req.headers.host);}catch{return proto+'://'+req.headers.host;}
  if(lan&&LOOPBACK.has(url.hostname)){const ip=localAddresses().find(a=>IPV4.test(a));if(ip)return `${proto}://${ip}${url.port?':'+url.port:''}`;}return url.origin;}
const inviteLink=(req,lan,made)=>({id:made.id,link:`${inviteOrigin(req,lan)}/#invite=${made.token}`,expiresAt:made.expiresAt});
const serverSettings=(service,lan)=>({...service.serverSettings(),lanActive:lan,addresses:lan?localAddresses().filter(a=>IPV4.test(a)):[]});

export const createApp=(db,options={})=>createServer(createHandler(db,options));
export function createHandler(db,{backups=null,lan=false}={}) {
  const service=new Service(db), attempts=new Map();
  const assets={'/art.js':['art.js','text/javascript'],'/design.css':['design.css','text/css'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/operations.js':['operations.js','text/javascript'],'/visual.js':['visual.js','text/javascript'],'/shape.js':['shape.js','text/javascript'],'/shape-editor.js':['shape-editor.js','text/javascript'],'/style.css':['style.css','text/css']};
  Object.assign(assets,{'/world.js':['world.js','text/javascript'],'/world-layout.js':['world-layout.js','text/javascript'],'/world-pic.js':['world-pic.js','text/javascript']});// Home world map
  // The installable app (Today page): the web app manifest and its icons (PNG files made once by scripts/make-icons.js).
  Object.assign(assets,{'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],...Object.fromEntries(['icon-32','icon-192','icon-512','icon-maskable-512','apple-touch-icon'].map(n=>['/icons/'+n+'.png',['icons/'+n+'.png','image/png']]))});
  Object.assign(assets,{'/game.js':['game.js','text/javascript'],'/game-art.js':['game-art.js','text/javascript'],'/game-pick.js':['game-pick.js','text/javascript'],'/game-finish.js':['game-finish.js','text/javascript'],'/game.css':['game.css','text/css']});// the game board
  Object.assign(assets,{'/plan-cal.js':['plan-cal.js','text/javascript']});// the Today calendar's grid and chips (shared with src/domain/today.js)
  return async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(!hostAllowed(req.headers.host,{lan})){send(421,{error:'This address is not served here. Open Scaffold Yard at the address it was started on.'});return;}
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/health'){send(200,{status:'ok',mode:'simulation',database:cached(db,'SELECT MAX(version) version FROM schema_migrations').get().version});return;}
      if(req.method==='GET'&&assets[path]) {const [file,type]=assets[path];res.writeHead(200,{'Content-Type':type});res.end(readFileSync(new URL(`../public/${file}`,import.meta.url)));return;}
      if(!path.startsWith('/api/')) throw new AppError(404,'Not found.');
      if(!['GET','POST'].includes(req.method)) throw new AppError(405,'Method not allowed.');
      let body={};
      if(req.method==='POST') {
        // The Host is on the allowlist by now, so an Origin equal to it is one of this server's own addresses.
        if(req.headers.origin && req.headers.origin.toLowerCase()!==`${req.socket.encrypted?'https':'http'}://${req.headers.host}`.toLowerCase()) throw new AppError(403,'Invalid request origin.');
        if(req.headers['content-type']?.split(';')[0]!=='application/json') throw new AppError(415,'JSON is required.');
        // The logo upload may be bigger: only a signed-in owner gets that far before the body is read.
        if(path==='/api/company-logo') service.require(service.authenticate(req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('session='))?.slice(8)),'company.manage');
        let size=0,chunks=[];for await(const chunk of req) {size+=chunk.length;if(size>(path==='/api/company-logo'?BD_LOGO_BODY:16384)) throw new AppError(413,'Request too large.');chunks.push(chunk);}
        try {body=JSON.parse(Buffer.concat(chunks).toString());}catch {throw new AppError(400,'Invalid JSON.');}
        if(!body||typeof body!=='object'||Array.isArray(body)) throw new AppError(400,'Invalid request.');
      }
      const cookie=token=>res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token?28800:0}${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
      if(req.method==='GET'&&path==='/api/systems') {send(200,cached(db,'SELECT * FROM scaffold_systems ORDER BY name').all());return;}
      // Whether the sign-in page offers "Create a company" (audit D4): only on a new server, or when the server administrator has switched it on.
      if(req.method==='GET'&&path==='/api/welcome') {send(200,{register:service.registrationOpen()});return;}
      if(req.method==='POST'&&['/api/register','/api/login','/api/invitation','/api/accept-invite'].includes(path)) {
        // Failed attempts only, 10 a minute per address: a correct sign-in is never slowed down.
        const now=Date.now(),key=req.socket.remoteAddress;for(const [k,v] of attempts) if(v.until<now) attempts.delete(k);
        const entry=attempts.get(key)??{count:0,until:now+60000};attempts.set(key,entry);if(entry.count>=10) throw new AppError(429,'Too many attempts. Try again in a minute.');
        try {
          // The same answer for every email while registration is closed (audit D3, D4). Checked and done in one step, so two first-run sign-ups cannot both pass.
          if(path==='/api/register'&&!service.registrationOpen()) throw new AppError(403,'New companies are not set up here. Ask the person who runs Scaffold Yard to invite you.');
          if(path==='/api/invitation') {send(200,service.invitationDetails(body.token));return;}
          cookie(path==='/api/register'?service.register(body):path==='/api/login'?service.login(body):service.acceptInvitation(body));send(200,{ok:true});return;
        } catch(error) {if(error instanceof AppError&&error.status<500) entry.count++;throw error;}
      }
      const token=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('session='))?.slice(8);
      const user=service.authenticate(token);
      const simulation=new Simulation(db,user);
      if(req.method==='GET'&&path==='/api/me') send(200,service.snapshot(user));
      else if(req.method==='GET'&&path==='/api/state') {const query=new URL(req.url,'http://localhost').searchParams;send(200,simulation.snapshot(Number(query.get('page')??0),{lean:true,catalogue:query.get('catalogue'),world:query.get('world')}));}
      else if(req.method==='GET'&&path==='/api/history') {const query=new URL(req.url,'http://localhost').searchParams;send(200,simulation.history(Number(query.get('limit')??100),Number(query.get('after')??0)));}
      else if(req.method==='GET'&&path==='/api/reports') {const days=new URL(req.url,'http://localhost').searchParams.get('days');send(200,simulation.reports(days===null?30:Number(days)));}
      else if(req.method==='GET'&&path==='/api/plan') send(200,simulation.planMonth(new URL(req.url,'http://localhost').searchParams.get('month')));// the Today calendar (src/domain/today.js)
      else if(req.method==='GET'&&path==='/api/today') send(200,simulation.todayView());
      else if(req.method==='GET'&&path==='/api/person') {const q=new URL(req.url,'http://localhost').searchParams;send(200,simulation.personView(q.get('kind'),q.get('id')));}
      else if(req.method==='GET'&&path==='/api/team') send(200,simulation.teamView());
      else if(req.method==='GET'&&path==='/api/crew-day') send(200,simulation.crewDay(new URL(req.url,'http://localhost').searchParams.get('worker')));
      else if(req.method==='GET'&&path==='/api/hire') send(200,simulation.hire(Object.fromEntries(new URL(req.url,'http://localhost').searchParams)));
      else if(req.method==='GET'&&path==='/api/game-items') send(200,simulation.gameItemsFor(new URL(req.url,'http://localhost').searchParams.get('loc')));// the game board's Send / Bring back slider (src/domain/game.js)
      else if(req.method==='GET'&&path==='/api/hire.csv') {const out=simulation.hireCSV(Object.fromEntries(new URL(req.url,'http://localhost').searchParams));res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${out.name}"`});res.end('﻿'+out.csv);}
      else if(req.method==='GET'&&path==='/api/export') {const kind=new URL(req.url,'http://localhost').searchParams.get('kind');const output=simulation.export(kind);res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="scaffold-${['stock','register','additions','removals','yardlist'].includes(kind)?kind:'history'}.csv"`});res.end(output);}
      else if(req.method==='POST'&&path==='/api/placement-preview') send(200,simulation.placementPreview(body));
      else if(req.method==='POST'&&path==='/api/layout-preview') send(200,simulation.layoutPreview(body));
      else if(req.method==='POST'&&path==='/api/turn-preview') send(200,simulation.turnPreview(body));
      else if(req.method==='POST'&&path==='/api/boundary-preview') send(200,simulation.boundaryPreview(body));
      else if(req.method==='POST'&&path.startsWith('/api/commands/')) send(200,simulation.execute(path.slice('/api/commands/'.length),body,req.headers['idempotency-key']));
      // A backup copies the whole server, so file paths and "Back up now" are for the server administrator only (audit D6). Another company's owner is told when the last copy was made.
      else if(path==='/api/backups'&&req.method==='GET') {service.require(user,'company.manage');if(!backups){send(200,{configured:false});return;}const status=backups.status();if(!service.isAdmin(user)){send(200,{configured:true,serverManaged:true,lastBackup:status.lastBackup&&{at:status.lastBackup.at}});return;}send(200,status);}
      else if(path==='/api/backup-now'&&req.method==='POST') {service.require(user,'company.manage');service.requireAdmin(user);if(!backups)throw new AppError(404,'Automatic backups are not set up for this server.');const result=await backups.backupNow();if(result.busy)throw new AppError(429,result.error);if(!result.ok)throw new AppError(500,`The backup failed: ${result.error}`);send(200,{...backups.status(),file:result.file});}
      // The encrypted copy and the restore test act on the whole server too: administrator only.
      else if(path==='/api/backup-offsite'&&req.method==='POST') {service.require(user,'company.manage');service.requireAdmin(user);if(!backups)throw new AppError(404,'Automatic backups are not set up for this server.');if(body.off===true)backups.clearOffsite();else await backups.setOffsite({folder:body.folder,passphrase:body.passphrase});send(200,backups.status());}// the encrypted copy (src/protect.js)
      else if(path==='/api/restore-drill'&&req.method==='POST') {service.require(user,'company.manage');service.requireAdmin(user);if(!backups)throw new AppError(404,'Automatic backups are not set up for this server.');const drill=await backups.drill();send(200,{...backups.status(),drill:{ok:drill.ok,at:drill.at,error:drill.error??null}});}
      else if(path==='/api/company-details'||path==='/api/company-logo') await bdRoute(req,res,simulation,path,body,send);
      else if(req.method==='POST'&&path==='/api/logout') {service.logout(token);cookie('');send(200,{ok:true});}
      else if(req.method==='POST'&&path==='/api/company') {service.updateCompany(user,body);send(200,{ok:true});}
      // New people and people from other companies both join by invitation that they accept themselves (audit D2); the answer never says whether the email already signs in (D3).
      else if(req.method==='POST'&&['/api/invitations','/api/users','/api/memberships'].includes(path)) send(201,inviteLink(req,lan,service.invite(user,body)));
      else if(req.method==='POST'&&path==='/api/invitations/renew') send(200,inviteLink(req,lan,service.renewInvitation(user,body)));
      else if(req.method==='POST'&&path==='/api/invitations/cancel') {service.cancelInvitation(user,body);send(200,{ok:true});}
      else if(req.method==='POST'&&path==='/api/members/remove') {service.removeMember(user,body);send(200,{ok:true});}
      else if(req.method==='POST'&&path==='/api/switch-company') {service.switchCompany(user,body.companyId,token);send(200,{ok:true});}
      // Settings of the whole server, for the administrator only: new companies may sign up; phones on this Wi-Fi may open it (read at the next start).
      else if(path==='/api/server-settings'&&req.method==='GET') {service.requireAdmin(user);send(200,serverSettings(service,lan));}
      else if(path==='/api/server-settings'&&req.method==='POST') {service.requireAdmin(user);service.saveServerSettings(user,body);send(200,serverSettings(service,lan));}
      else throw new AppError(404,'Not found.');
    } catch(error) {if(!(error instanceof AppError)) console.error(error);send(error.status??500,{error:error instanceof AppError?error.message:'Something went wrong. Please try again.'});}
  };
}
// Wi-Fi sharing is read from the database without changing it (no migration, no lock), so the port can be claimed before anything else.
function lanSharingSetting(path){try{if(!existsSync(path))return false;const peek=new DatabaseSync(path,{readOnly:true});try{return peek.prepare("SELECT value FROM server_settings WHERE key='lan_sharing'").get()?.value==='1';}finally{peek.close();}}catch{return false;}}
// Is a Scaffold Yard server already answering on this port?
const answersHealth=port=>new Promise(done=>{const r=httpGet({host:'127.0.0.1',port,path:'/health',timeout:2000},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{try{const j=JSON.parse(s);done(j.status==='ok'&&'mode' in j);}catch{done(false);}});});r.on('timeout',()=>r.destroy());r.on('error',()=>done(false));});
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const refuse=message=>{console.error(`Scaffold Yard did NOT start: ${message}.`);process.exit(1);};
  // The port first (audit D12): a second start, or another program on the port, stops here before the database, the engine or the backups are touched.
  const port=Number(process.env.PORT??3000),host=listenHost({env:process.env,lanSharing:lanSharingSetting(resolveDatabasePath())});
  let handler=null;
  const server=createServer((req,res)=>{if(handler)return handler(req,res);res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Scaffold Yard is starting. Try again in a moment.'}));});
  try{await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,()=>{server.off('error',fail);ok();});});}
  catch(error){
    if(error.code==='EADDRINUSE'){if(await answersHealth(port)){console.log(`Scaffold Yard is already running: http://127.0.0.1:${port}`);process.exit(0);}refuse(`port ${port} is in use by another program. Close that program, or start Scaffold Yard with PORT set to a free port`);}
    refuse(`port ${port} could not be used (${error.code??error.message})`);
  }
  server.on('error',error=>console.error(`Server error: ${error.message}`));
  // Without DATABASE_PATH the database lives outside the (often synced) project folder; an old ./data/scaffold.sqlite is moved there once, safely (src/relocate.js).
  // prepareDatabase holds a lock file until release(): kept until the movement engine has claimed the database, so a second server started at the same moment waits and then finds it in use.
  let db,stop,backups;
  try{
    const prepared=await prepareDatabase();
    const {path:databasePath,status}=prepared;
    // An existing database is expected here: never let SQLite create an empty one in its place.
    if(!['new','env','default'].includes(status)&&!existsSync(databasePath))refuse(`the database ${databasePath} disappeared while starting; start again`);
    // A start-up migration first saves a checked copy of the database as it was into the backup folder (src/database.js); if it cannot, nothing is changed.
    db=openDatabase(databasePath,{backupDirectory:backupDirectory(),backupName:backupName({databasePath})});console.log(`Database: ${databasePath}`);
    stop=startScheduler(db);prepared.release();
    backups=createBackups({databasePath,directory:backupDirectory(),name:backupName({databasePath})});backups.start();
  }catch(error){refuse(error.message);}
  const lan=!loopbackHost(host);handler=createHandler(db,{backups,lan});
  console.log(`Scaffold Yard: http://127.0.0.1:${port}`+(lan?` (Wi-Fi sharing is on: phones on this network can open http://${localAddresses().find(a=>IPV4.test(a))??"<this PC's IP>"}:${port}. It is not encrypted.)`:''));
  // SIGHUP: the console window was closed (Windows). Stop the engine first so held job countdowns are saved, then close.
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,()=>{stop();backups.stop();server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(0),2000).unref();});
}
