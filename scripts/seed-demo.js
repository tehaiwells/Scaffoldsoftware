import {randomBytes,randomUUID} from 'node:crypto';
import {openDatabase} from '../src/database.js';
import {Service} from '../src/service.js';
import {Simulation} from '../src/simulation.js';
import {lockDatabaseChoice} from '../src/relocate.js';
// Chosen under the server's relocation lock (held until done), so this never writes to a database the server is moving, nor creates an empty one.
const choice=await lockDatabaseChoice(),db=openDatabase(choice.path);
try{
 const auth=new Service(db),password=process.env.DEMO_PASSWORD??randomBytes(18).toString('base64url');
 const token=auth.register({name:'Demonstration Owner',companyName:'SCAFFOLD · SYNTHETIC DEMO',email:process.env.DEMO_EMAIL??'demo@example.test',password,systems:['quickstage','at-pac','tube-clip']});
 const sim=new Simulation(db,auth.authenticate(token)),cmd=(a,b={})=>sim.execute(a,b,randomUUID());
 const yard=cmd('yard',{name:'Demo yard',closed:true,segments:[{direction:'RIGHT',length:20000},{direction:'DOWN',length:16000},{direction:'LEFT',length:20000}]});
 const [product]=cmd('seed');cmd('resources',{location:yard.id,workers:5,machines:1});
 for(let i=0;i<3;i++){const c=cmd('container',{name:`S-00${i+1}`,location:yard.id,type:'STILLAGE',length:2000,width:1000,height:1000,tare:50000,x:4000+i*3000,y:4000});if(i<2)cmd('opening',{container:c.id,product:product.id,quantity:100,reason:'SYNTHETIC DEMO opening balance'});}
 cmd('truck',{name:'T-01',yard:yard.id});const site=cmd('site',{name:'George Street · DEMO',address:'Synthetic demonstration location'});cmd('resources',{location:site.id,workers:5,machines:1});
 console.log(`Synthetic demonstration company created.\nEmail: ${process.env.DEMO_EMAIL??'demo@example.test'}\nPassword: ${password}\nOpen http://127.0.0.1:3000. Request 120 DEMO ledgers for George Street to exercise exact partial packing.`);
}finally{db.close();choice.release();}
