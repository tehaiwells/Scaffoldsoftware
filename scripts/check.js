import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const files=[];function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())walk(p);else if(p.endsWith('.js'))files.push(p);}}for(const dir of ['src','public','test','scripts','e2e'])walk(dir);for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){console.error(result.stderr);process.exit(1);}}console.log(`Syntax checks passed for ${files.length} JavaScript files.`);
