import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../src/database.js';
import {Service} from '../src/service.js';
import {Simulation} from '../src/simulation.js';
import {lockDatabaseChoice} from '../src/relocate.js';
if(!process.argv[2]||!process.env.IMPORT_EMAIL||!process.env.IMPORT_PASSWORD)throw new Error('Provide a reviewed JSON batch filename, IMPORT_EMAIL and IMPORT_PASSWORD. No document extraction happens automatically.');
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));const choice=await lockDatabaseChoice(),db=openDatabase(choice.path);try{const auth=new Service(db),token=auth.login({email:process.env.IMPORT_EMAIL,password:process.env.IMPORT_PASSWORD});const result=new Simulation(db,auth.authenticate(token)).execute('importCatalogue',data,randomUUID());auth.logout(token);console.log(`Imported ${result.products.length} separate variants atomically; no stock was created.`);}finally{db.close();choice.release();}
