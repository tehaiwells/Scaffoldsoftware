import { defineConfig } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Browser tests run their own server on a throwaway database and backup folder in the system temp folder, never the real ones.
// E2E_PORT (default 3100) picks the port; PW_CHANNEL=msedge uses the installed Edge instead of Playwright's bundled Chromium (CI uses the bundled one).
// The config is loaded once per worker too, so the temp folder is made once (by the runner) and handed down through the environment.
const port=process.env.E2E_PORT??'3100',base=`http://127.0.0.1:${port}`;
if(!process.env.E2E_SCRATCH){
  // Leftovers of earlier runs that could not be removed at the time (older than 6 hours, so never a run still going).
  for(const name of (()=>{try{return readdirSync(tmpdir());}catch{return [];}})().filter(n=>n.startsWith('scaffold-e2e-')))try{const dir=join(tmpdir(),name);if(Date.now()-statSync(dir).mtimeMs>6*3600000)rmSync(dir,{recursive:true,force:true});}catch{}
  const scratch=process.env.E2E_SCRATCH=mkdtempSync(join(tmpdir(),'scaffold-e2e-'));
  // The runner stops the test server before it exits, so the database is closed by then and the folder can go.
  process.on('exit',()=>{try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}});
}
const scratch=process.env.E2E_SCRATCH;
export default defineConfig({testDir:'./e2e',timeout:120000,workers:1,retries:process.env.CI?1:0,use:{baseURL:base,headless:true,viewport:{width:1280,height:900},screenshot:'only-on-failure',...(process.env.PW_CHANNEL?{channel:process.env.PW_CHANNEL}:{})},webServer:{command:'node src/server.js',url:`${base}/health`,reuseExistingServer:false,timeout:60000,env:{PORT:port,HOST:'127.0.0.1',DATABASE_PATH:join(scratch,'e2e.sqlite'),BACKUP_DIR:join(scratch,'backups')}}});
