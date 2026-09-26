// Renders the app icons (public/art.js tdAppIcon) to the PNG files under public/icons/ that the web app manifest and index.html point at.
// Run once after changing the icon art, then commit the PNGs:  node scripts/make-icons.js [output folder]
// Needs the Playwright dev dependency and Microsoft Edge (or set PW_CHANNEL=chromium for the bundled browser).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tdAppIcon } from '../public/art.js';

export const ICONS=[
  {file:'icon-192.png',size:192,art:{rounded:true}},
  {file:'icon-512.png',size:512,art:{rounded:true}},
  {file:'icon-maskable-512.png',size:512,art:{maskable:true}},
  {file:'apple-touch-icon.png',size:180,art:{}},
  {file:'icon-32.png',size:32,art:{small:true,rounded:true}}
];
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const out=resolve(process.argv[2]??fileURLToPath(new URL('../public/icons/',import.meta.url)));mkdirSync(out,{recursive:true});
  const {chromium}=await import('@playwright/test');
  const browser=await chromium.launch({channel:process.env.PW_CHANNEL??'msedge',headless:true});
  try{for(const icon of ICONS){const page=await browser.newPage({viewport:{width:icon.size,height:icon.size},deviceScaleFactor:1});
    await page.setContent('<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:'+icon.size+'px;height:'+icon.size+'px}</style></head><body>'+tdAppIcon(icon.art)+'</body></html>');
    writeFileSync(resolve(out,icon.file),await page.screenshot({omitBackground:true,type:'png'}));await page.close();console.log('Wrote '+icon.file+' ('+icon.size+' px)');}}
  finally{await browser.close();}
}
