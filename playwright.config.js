import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Browser tests run their own server on a throwaway database and backup folder in the system temp folder, never the real ones.
// E2E_PORT (default 3100) picks the port; PW_CHANNEL=msedge uses the installed Edge instead of Playwright's bundled Chromium (CI uses the bundled one).
// The config is loaded once per worker too, so the temp folder is made once and handed down through the environment.
const port=process.env.E2E_PORT??'3100',base=`http://127.0.0.1:${port}`;
const scratch=process.env.E2E_SCRATCH??=mkdtempSync(join(tmpdir(),'scaffold-e2e-'));
export default defineConfig({testDir:'./e2e',timeout:120000,workers:1,retries:process.env.CI?1:0,use:{baseURL:base,headless:true,viewport:{width:1280,height:900},screenshot:'only-on-failure',...(process.env.PW_CHANNEL?{channel:process.env.PW_CHANNEL}:{})},webServer:{command:'node src/server.js',url:`${base}/health`,reuseExistingServer:false,timeout:60000,env:{PORT:port,HOST:'127.0.0.1',DATABASE_PATH:join(scratch,'e2e.sqlite'),BACKUP_DIR:join(scratch,'backups')}}});
