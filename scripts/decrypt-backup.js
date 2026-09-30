// Unlocks an encrypted backup copy (made by Account > Backups > encrypted copy) into a normal backup file, for a restore by hand.
//   npm run decrypt-backup -- <copy.sqlite.enc> <new file.sqlite>      asks for the passphrase (or reads SCAFFOLD_BACKUP_PASSPHRASE)
// Existing files are never overwritten. The copy itself is only read.
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { decryptBackup } from '../src/protect.js';
const [source,dest]=process.argv.slice(2);
if(!source||!dest||!existsSync(source)||existsSync(resolve(dest))){console.error('Give an encrypted copy that exists and a new file name to write (existing files are never overwritten).');process.exit(1);}
let passphrase=process.env.SCAFFOLD_BACKUP_PASSPHRASE;
if(!passphrase){const rl=createInterface({input:process.stdin,output:process.stdout});passphrase=await rl.question('Passphrase for the encrypted copy: ');rl.close();}
try{writeFileSync(resolve(dest),decryptBackup(source,passphrase),{flag:'wx'});console.log(`Unlocked: ${resolve(dest)}`);}
catch(error){console.error(error.message);process.exitCode=1;}
