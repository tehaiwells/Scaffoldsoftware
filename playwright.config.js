import { defineConfig } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Browser tests run their own servers on throwaway databases and backup folders in the system temp folder, never the real ones.
// E2E_PORT (default 3100) and the port after it are used; PW_CHANNEL=msedge uses the installed Edge instead of Playwright's bundled Chromium (CI uses the bundled one).
// The config is loaded once per worker too, so the temp folder is made once (by the runner) and handed down through the environment.
const port=Number(process.env.E2E_PORT??3100);
if(!process.env.E2E_SCRATCH){
  // Leftovers of earlier runs that could not be removed at the time (older than 6 hours, so never a run still going).
  for(const name of (()=>{try{return readdirSync(tmpdir());}catch{return [];}})().filter(n=>n.startsWith('scaffold-e2e-')))try{const dir=join(tmpdir(),name);if(Date.now()-statSync(dir).mtimeMs>6*3600000)rmSync(dir,{recursive:true,force:true});}catch{}
  const scratch=process.env.E2E_SCRATCH=mkdtempSync(join(tmpdir(),'scaffold-e2e-'));
  // The runner stops the test servers before it exits, so the databases are closed by then and the folder can go.
  process.on('exit',()=>{try{rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}});
}
const scratch=process.env.E2E_SCRATCH;
// Two servers, each with its own database, movement engine and sign-up limit (src/server.js allows 10 sign-ups a minute from one address, and
// every test signs up a fresh company): the shape editor tests (8 sign-ups) on one, every other spec on the other. One server would see
// more than 10 sign-ups in a minute once the tests run in parallel, and the extra sign-ups are refused. Three tests run at once (every test has
// its own company, so they share no data); the shape editor file's own tests also run side by side.
const server=(p,name)=>({command:'node src/server.js',url:`http://127.0.0.1:${p}/health`,reuseExistingServer:false,timeout:60000,env:{PORT:String(p),HOST:'127.0.0.1',DATABASE_PATH:join(scratch,name+'.sqlite'),BACKUP_DIR:join(scratch,name+'-backups')}});
export default defineConfig({testDir:'./e2e',timeout:120000,workers:3,retries:process.env.CI?1:0,
  use:{headless:true,viewport:{width:1280,height:900},screenshot:'only-on-failure',...(process.env.PW_CHANNEL?{channel:process.env.PW_CHANNEL}:{})},
  webServer:[server(port,'flows'),server(port+1,'shape')],
  projects:[{name:'flows',testIgnore:/shape\.spec\.js/,use:{baseURL:`http://127.0.0.1:${port}`}},{name:'shape',testMatch:/shape\.spec\.js/,fullyParallel:true,use:{baseURL:`http://127.0.0.1:${port+1}`}}]});
