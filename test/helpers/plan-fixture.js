// A board-made yard (gameStart) with the planner's clock under test control, shared by the Today planner tests. No tests of its own.
// The caller's test file sets process.env.TZ='Australia/Sydney' before importing anything.
import { randomUUID } from 'node:crypto';
import { openDatabase,atomic } from '../../src/database.js';
import { Service } from '../../src/service.js';
import { Simulation } from '../../src/simulation.js';
import { atLocal,planSimAnswer } from '../../src/domain/plantime.js';
import { addDays } from '../../src/domain/schedule.js';
import { gpPerStillage } from '../../public/game-pick.js';
export const D0='2026-10-13';// a Tuesday (AEDT)
export const L=(day,hm)=>atLocal(day,hm);
const mocked=new WeakSet();
export function planFixture(t,{now=L(D0,'09:00'),jobs=false,systems=['quickstage']}={}){
  if(mocked.has(t))t.mock.timers.setTime(now);else{t.mock.timers.enable({apis:['Date'],now});mocked.add(t);}
  const db=openDatabase(':memory:');t.after(()=>db.close());const auth=new Service(db);
  const user=auth.authenticate(auth.register({name:'Owner',companyName:'Tee Scaffolding',email:randomUUID()+'@example.com',password:'demonstration-password',systems}));
  const sim=new Simulation(db,user);const cmd=(action,input={},key=randomUUID())=>sim.execute(action,input,key);
  const {yard}=cmd('gameStart',{size:'S'});const c=sim.repo.all('config')[0];Object.assign(c,{stepMs:100,speed:100000,jobs,routineJobs:false});sim.repo.save(c);
  const clock=(day,hm)=>t.mock.timers.setTime(L(day,hm)),at=ms=>t.mock.timers.setTime(ms);
  const pass=()=>atomic(db,()=>sim.planPass(sim.planNow()));
  const tick=(n=1)=>{for(let i=0;i<n;i++)atomic(db,()=>sim.tick(1000));};
  const until=(fn,n=800)=>{for(let i=0;i<n;i++){if(fn())return true;tick(1);}return fn();};
  const item=id=>sim.repo.get(id,'planItem'),msgs=id=>sim.repo.all('message').filter(m=>m.item===id),view=id=>sim.planItemView(item(id));
  const total=()=>db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM contents WHERE company_id=?').get(user.company_id).n;
  const trucks=()=>sim.repo.all('truck').filter(x=>!x.retired),truck=name=>sim.repo.all('truck').find(x=>x.name===name);
  const driver=name=>sim.repo.all('driver').find(d=>d.name===name),worker=name=>sim.repo.all('resource').find(r=>r.type==='WORKER'&&r.name===name&&r.enabled);
  const piecesAt=(loc,product)=>sim.containers().filter(x=>x.location===loc).reduce((n,x)=>n+sim.repo.quantity(x.id,product),0);
  // a Quickstage part with a weight and no pack size (the owner's own catalogue): n full stillages of it in the yard
  const stock=(n=3,pick=p=>true)=>{if(!sim.repo.all('product').length)cmd('gameCatalogue');const lift=sim.gameLift(yard);const p=sim.repo.all('product').map(x=>sim.effective(x.id)).filter(x=>x.packQuantity==null&&x.unitWeight>0&&gpPerStillage(x,lift)>=10&&gpPerStillage(x,lift)<=400&&pick(x)).sort((a,b)=>a.name.localeCompare(b.name))[0];
    const per=gpPerStillage(p,lift);if(n)cmd('gameAddStock',{lines:[{product:p.id,quantity:per*n}]});return {p,per};};
  const site=(name='Bondi',address)=>cmd('gameSite',{name,...(address?{address}:{})}).site;
  // the first day after `from` where this person's first ask of this kind is answered yes (or no) by the simulation
  const dayWhere=(person,subject,yes,from=D0,attempt=1)=>{for(let i=1;i<400;i++){const d=addDays(from,i);if(planSimAnswer({person,day:d,subject,attempt}).yes===yes)return d;}throw new Error('no such day');};
  return {db,auth,user,sim,cmd,yard,clock,at,pass,tick,until,item,msgs,view,total,trucks,truck,driver,worker,piecesAt,stock,site,dayWhere};
}
