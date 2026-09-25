import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase,cached } from './database.js';
import { Service, AppError } from './service.js';
import { Simulation, startScheduler } from './simulation.js';

export function createApp(db) {
  const service=new Service(db), attempts=new Map();
  const assets={'/art.js':['art.js','text/javascript'],'/design.css':['design.css','text/css'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/operations.js':['operations.js','text/javascript'],'/visual.js':['visual.js','text/javascript'],'/shape.js':['shape.js','text/javascript'],'/shape-editor.js':['shape-editor.js','text/javascript'],'/style.css':['style.css','text/css']};
  return createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/health'){send(200,{status:'ok',mode:'simulation',database:cached(db,'SELECT MAX(version) version FROM schema_migrations').get().version});return;}
      if(req.method==='GET'&&assets[path]) {const [file,type]=assets[path];res.writeHead(200,{'Content-Type':type});res.end(readFileSync(new URL(`../public/${file}`,import.meta.url)));return;}
      if(!path.startsWith('/api/')) throw new AppError(404,'Not found.');
      if(!['GET','POST'].includes(req.method)) throw new AppError(405,'Method not allowed.');
      let body={};
      if(req.method==='POST') {
        if(req.headers.origin && req.headers.origin!==`${req.socket.encrypted?'https':'http'}://${req.headers.host}`) throw new AppError(403,'Invalid request origin.');
        if(req.headers['content-type']?.split(';')[0]!=='application/json') throw new AppError(415,'JSON is required.');
        let size=0,chunks=[];for await(const chunk of req) {size+=chunk.length;if(size>16384) throw new AppError(413,'Request too large.');chunks.push(chunk);}
        try {body=JSON.parse(Buffer.concat(chunks).toString());}catch {throw new AppError(400,'Invalid JSON.');}
        if(!body||typeof body!=='object'||Array.isArray(body)) throw new AppError(400,'Invalid request.');
      }
      const cookie=token=>res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token?28800:0}${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
      if(req.method==='GET'&&path==='/api/systems') {send(200,cached(db,'SELECT * FROM scaffold_systems ORDER BY name').all());return;}
      if(req.method==='POST'&&['/api/register','/api/login'].includes(path)) {
        const now=Date.now(),key=req.socket.remoteAddress;for(const [k,v] of attempts) if(v.until<now) attempts.delete(k);
        const entry=attempts.get(key)??{count:0,until:now+60000};attempts.set(key,entry);if(++entry.count>10) throw new AppError(429,'Too many attempts. Try again in a minute.');
        cookie(path==='/api/register'?service.register(body):service.login(body));send(200,{ok:true});return;
      }
      const token=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('session='))?.slice(8);
      const user=service.authenticate(token);
      const simulation=new Simulation(db,user);
      if(req.method==='GET'&&path==='/api/me') send(200,service.snapshot(user));
      else if(req.method==='GET'&&path==='/api/state') {const query=new URL(req.url,'http://localhost').searchParams;send(200,simulation.snapshot(Number(query.get('page')??0),{lean:true,catalogue:query.get('catalogue')}));}
      else if(req.method==='GET'&&path==='/api/history') {const query=new URL(req.url,'http://localhost').searchParams;send(200,simulation.history(Number(query.get('limit')??100),Number(query.get('after')??0)));}
      else if(req.method==='GET'&&path==='/api/export') {const kind=new URL(req.url,'http://localhost').searchParams.get('kind');const output=simulation.export(kind);res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="scaffold-${['stock','register','additions','removals','yardlist'].includes(kind)?kind:'history'}.csv"`});res.end(output);}
      else if(req.method==='POST'&&path==='/api/placement-preview') send(200,simulation.placementPreview(body));
      else if(req.method==='POST'&&path==='/api/layout-preview') send(200,simulation.layoutPreview(body));
      else if(req.method==='POST'&&path==='/api/turn-preview') send(200,simulation.turnPreview(body));
      else if(req.method==='POST'&&path==='/api/boundary-preview') send(200,simulation.boundaryPreview(body));
      else if(req.method==='POST'&&path.startsWith('/api/commands/')) send(200,simulation.execute(path.slice('/api/commands/'.length),body,req.headers['idempotency-key']));
      else if(req.method==='POST'&&path==='/api/logout') {service.logout(token);cookie('');send(200,{ok:true});}
      else if(req.method==='POST'&&path==='/api/company') {service.updateCompany(user,body);send(200,{ok:true});}
      else if(req.method==='POST'&&path==='/api/users') send(201,service.addUser(user,body));
      else if(req.method==='POST'&&path==='/api/memberships') send(201,service.addMembership(user,body));
      else if(req.method==='POST'&&path==='/api/switch-company') {service.switchCompany(user,body.companyId,token);send(200,{ok:true});}
      else throw new AppError(404,'Not found.');
    } catch(error) {if(!(error instanceof AppError)) console.error(error);send(error.status??500,{error:error instanceof AppError?error.message:'Something went wrong. Please try again.'});}
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const db=openDatabase(process.env.DATABASE_PATH??'./data/scaffold.sqlite');
  const stop=startScheduler(db);
  const server=createApp(db);server.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1',()=>{const {address,port}=server.address();console.log(`Scaffold Yard: http://127.0.0.1:${port}`+(address!=='127.0.0.1'?` (listening on ${address} — reachable from other devices on this network at http://<this PC's IP>:${port})`:''));});
  // SIGHUP: the console window was closed (Windows). Stop the engine first so held job countdowns are saved, then close.
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,()=>{stop();server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(0),2000).unref();});
}
