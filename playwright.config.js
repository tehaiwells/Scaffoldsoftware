import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',timeout:120000,workers:1,use:{baseURL:'http://127.0.0.1:3100',headless:true,viewport:{width:1280,height:900},screenshot:'only-on-failure'},webServer:{command:'node src/server.js',url:'http://127.0.0.1:3100/health',reuseExistingServer:false,env:{PORT:'3100',DATABASE_PATH:'./data/e2e.sqlite'}}});
