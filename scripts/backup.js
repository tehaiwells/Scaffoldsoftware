import { DatabaseSync,backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveDatabasePath } from '../src/paths.js';
const source=resolve(resolveDatabasePath()),destination=process.argv[2];
if(!destination||!existsSync(source)||existsSync(resolve(destination))||resolve(destination)===source)throw new Error('Provide a new backup filename, and an existing source database. Existing backups are never overwritten.');
const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,resolve(destination));console.log(`Consistent SQLite backup saved: ${resolve(destination)}`);}finally{db.close();}
