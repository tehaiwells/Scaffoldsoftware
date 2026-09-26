import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Where files live. Nothing here is machine-specific: every path comes from the environment, the OS or this project's own folder.
export const projectRoot=fileURLToPath(new URL('..',import.meta.url));
// The database's original home inside the project folder. On Windows that folder is often synced (OneDrive), which suits a daily backup but not a file written several times a second.
export const legacyDatabasePath=(root=projectRoot)=>join(root,'data','scaffold.sqlite');
// Where the database belongs when DATABASE_PATH is not set: on Windows the per-user local app-data folder (never synced); elsewhere the project's data folder.
export function defaultDatabasePath({env=process.env,platform=process.platform,home=homedir(),root=projectRoot}={}){
  if(platform!=='win32')return legacyDatabasePath(root);
  return join(env.LOCALAPPDATA||join(home,'AppData','Local'),'ScaffoldYard','scaffold.sqlite');
}
// The database in use right now, without moving anything: DATABASE_PATH if set; otherwise the new home once it exists; otherwise the old file if it has not been moved yet (the server moves it on its next start); otherwise the new home.
// Scripts use this so that running one before the server's first start on the new version never creates an empty database at the new home and strands the real one.
export function resolveDatabasePath(options={}){
  const env=options.env??process.env;if(env.DATABASE_PATH)return resolve(env.DATABASE_PATH);
  const target=defaultDatabasePath(options),legacy=legacyDatabasePath(options.root);
  return existsSync(target)||!existsSync(legacy)?target:legacy;
}
// Automatic daily backups go inside the project folder on purpose: one file a day gives an off-site copy through the synced folder without constant churn.
export const backupDirectory=({env=process.env,root=projectRoot}={})=>env.BACKUP_DIR?resolve(env.BACKUP_DIR):join(root,'data','backups');
// Backup file names start with a name for the database they came from, so databases sharing one backup folder never take each other's daily slot or rotate each other's files.
// The app's own database (DATABASE_PATH not set) is "scaffold" wherever it lives; any DATABASE_PATH database gets its file name plus a short hash of its full path.
export function backupName({env=process.env,databasePath}={}){
  if(!env.DATABASE_PATH)return 'scaffold';
  const full=resolve(databasePath??env.DATABASE_PATH),slug=basename(full).replace(/\.[^.]*$/,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'db';
  return `scaffold-${slug}-${createHash('sha256').update(process.platform==='win32'?full.toLowerCase():full).digest('hex').slice(0,8)}`;
}
