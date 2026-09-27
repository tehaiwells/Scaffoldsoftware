import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { Simulation } from '../src/simulation.js';
import { createApp } from '../src/server.js';
import { bdAbnValid, bdAbnFormat, bdSanitiseSvg, bdCheckLogo, bdDetails, BD_LOGO_MAX } from '../src/domain/brand.js';
import { fixture } from './simulation.test.js';
// Company details and logo for the paperwork (src/domain/brand.js, prefix bd): ABN checksum, field checks, logo type / size limits, SVG sanitising,
// permissions (only an owner changes them; supervisors and managers read them), the routes, and the print header built from them (public/operations.js).

// A made-up ABN with valid check digits (synthetic: the nine digits are arbitrary, the first two are solved for the checksum).
export function synthAbn(body='004085616'){for(let c=10;c<100;c++){const d=String(c)+body;if(bdAbnValid(d))return d;}throw new Error('no check digits');}
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td)>>>0);return Buffer.concat([len,td,crc]);};
export function png(w=40,h=20){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=y*(w*3+1)+1+x*3;raw[o]=40;raw[o+1]=110;raw[o+2]=60;}
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const jpeg=(w=64,h=32)=>{const sof=Buffer.from([0xff,0xc0,0,17,8,h>>8,h&255,w>>8,w&255,3,1,0x22,0,2,0x11,1,3,0x11,1]);return Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0]),sof,Buffer.from([0xff,0xd9])]);};
const b64=b=>Buffer.from(b).toString('base64');
const people=f=>{const add=(name,roles)=>{const email=randomUUID()+'@example.com';f.auth.addUser(f.user,{name,email,password:'demonstration-password',roles});return new Simulation(f.db,f.auth.authenticate(f.auth.login({email,password:'demonstration-password'})));};return {manager:add('Manager',['GENERAL_MANAGER']),supervisor:add('Supervisor',['SUPERVISOR'])};};
const run=(sim,action,input)=>sim.execute(action,input,randomUUID());

test('ABN checksum: 11 digits, weights 10,1,3..19 with the first digit less one, divisible by 89',()=>{
  const abn=synthAbn();assert.equal(abn.length,11);assert.ok(bdAbnValid(abn));assert.ok(bdAbnValid(bdAbnFormat(abn)),'spaces are ignored');assert.equal(bdAbnFormat(abn),abn.slice(0,2)+' '+abn.slice(2,5)+' '+abn.slice(5,8)+' '+abn.slice(8));
  const wrong=abn.slice(0,10)+String((+abn[10]+1)%10);assert.equal(bdAbnValid(wrong),false,'one digit changed');
  const swapped=abn.slice(0,3)+abn[4]+abn[3]+abn.slice(5);if(abn[3]!==abn[4])assert.equal(bdAbnValid(swapped),false,'two digits swapped');
  for(const bad of ['','1234567890','123456789012','1234567890a','00000000000',null,undefined])assert.equal(bdAbnValid(bad),false,String(bad));
  assert.ok(bdAbnValid(synthAbn('987654321'))&&bdAbnValid(synthAbn('123123123')));
});

test('details: trimmed and checked; a wrong ABN, email, phone or website is refused with a plain message',()=>{
  const abn=synthAbn(),d=bdDetails({tradingName:'  Demo   Scaffolding  ',abn:bdAbnFormat(abn),address:['1 Example St',' ','Sometown NSW 2000'],phone:'(02) 9000 0000',email:'Office@Example.com.au',website:'https://www.example.com.au/'});
  assert.deepEqual(d,{tradingName:'Demo Scaffolding',abn,address:['1 Example St','Sometown NSW 2000'],phone:'(02) 9000 0000',email:'office@example.com.au',website:'www.example.com.au'});
  assert.deepEqual(bdDetails({}),{tradingName:'',abn:'',address:[],phone:'',email:'',website:''},'every field is optional');
  assert.throws(()=>bdDetails({abn:'12 345 678 901'}),/not valid/);assert.throws(()=>bdDetails({abn:'1234'}),/11 digits/);
  assert.throws(()=>bdDetails({email:'office at example'}),/valid email/);assert.throws(()=>bdDetails({phone:'call me'}),/phone/);
  assert.throws(()=>bdDetails({website:'javascript:alert(1)'}),/website/);assert.throws(()=>bdDetails({website:'<b>x</b>.com'}),/website/);
  assert.throws(()=>bdDetails({tradingName:'x'.repeat(121)}),/too long/);assert.throws(()=>bdDetails({address:['a','b','c','d']}),/three/);assert.throws(()=>bdDetails({tradingName:'bad\u0007bell'}),/cannot be printed/);
  assert.throws(()=>bdDetails({tradingName:42}),/text/);
});

test('logo: PNG and JPEG by their bytes, 300 KB limit, the declared type must match, SVG rebuilt',()=>{
  const p=bdCheckLogo({type:'image/png',data:b64(png(40,20))});assert.equal(p.type,'image/png');assert.equal(p.width,40);assert.equal(p.height,20);assert.match(p.sha,/^[0-9a-f]{64}$/);
  const j=bdCheckLogo({type:'image/jpeg',data:b64(jpeg(64,32))});assert.deepEqual([j.width,j.height],[64,32]);
  assert.throws(()=>bdCheckLogo({type:'image/jpeg',data:b64(png())}),/is a PNG picture, not a JPEG/);
  assert.throws(()=>bdCheckLogo({type:'image/png',data:b64(Buffer.from('GIF89a......'))}),/not a PNG or JPEG/);
  assert.throws(()=>bdCheckLogo({type:'image/gif',data:b64(png())}),/PNG, JPEG or SVG/);
  assert.throws(()=>bdCheckLogo({type:'image/png',data:'not base64!'}),/did not arrive whole/);
  assert.throws(()=>bdCheckLogo({type:'image/png',data:''}),/Choose a logo/);
  const big=Buffer.concat([png(),Buffer.alloc(BD_LOGO_MAX)]);assert.throws(()=>bdCheckLogo({type:'image/png',data:b64(big)}),/under 300 KB/);
  const fits=Buffer.concat([png(),Buffer.alloc(BD_LOGO_MAX-png().length)]);assert.equal(bdCheckLogo({type:'image/png',data:b64(fits)}).bytes.length,BD_LOGO_MAX,'exactly 300 KB is allowed');
  assert.throws(()=>bdCheckLogo({type:'image/png',data:b64(png(8,8))}),/too small/);
  const huge=png(1,1);huge.writeUInt32BE(9000,16);assert.throws(()=>bdCheckLogo({type:'image/png',data:b64(huge)}),/too large/);
  const s=bdCheckLogo({type:'image/svg+xml',data:b64('<svg viewBox="0 0 120 40"><rect width="120" height="40" fill="#2d6b3f"/></svg>')});assert.equal(s.type,'image/svg+xml');assert.deepEqual([s.width,s.height],[120,40]);assert.match(s.bytes.toString(),/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 120 40"><rect/);
  assert.throws(()=>bdCheckLogo({type:'image/svg+xml',data:b64(png())}),/PNG picture, not an SVG/);
  assert.throws(()=>bdCheckLogo({type:'image/svg+xml',data:b64('<html><body>hi</body></html>')}),/not an SVG/);
});

test('SVG sanitising: scripts, handlers, links out, foreign content, entities and external CSS are removed; the drawing stays',()=>{
  const evil=`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "&#106;avascript:alert(1)">]><!-- c --><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="x" width="200" height="80" onload="alert(1)" viewBox="0 0 200 80">
<script>alert(document.cookie)</script><script><![CDATA[ if(a<b) alert(2) ]]></script>
<sodipodi:namedview id="n"/><metadata><rdf>x</rdf></metadata>
<defs><linearGradient id="g"><stop offset="0" stop-color="#2d6b3f"/><stop offset="1" stop-color="#d4ec85"/></linearGradient><style>.a{fill:url(#g)} @import url(https://evil.test/x.css);</style><style>.b{fill:#123}</style></defs>
<a href="javascript:alert(3)" xlink:href="https://evil.test"><rect class="b" width="200" height="80" fill="url(#g)" onclick="alert(4)" style="stroke:red;background:url(https://evil.test/t.png)"/></a>
<image href="https://evil.test/track.png" width="1" height="1"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.test"></iframe></div></foreignObject>
<use xlink:href="#g"/><use href="https://evil.test/s.svg#x"/><set attributeName="href" to="javascript:alert(5)"/><animate attributeName="href" values="javascript:alert(6)"/>
<text x="10" y="50" font-family="Arial" fill="#fff">Demo &amp; Co &lt;Pty&gt; &x;</text><path d="M0 0L10 10" style="fill:red;behavior:url(x.htc)" transform="translate(1 2)"/>
<circle cx="5" cy="5" r="3" fill="javascript:alert(7)" stroke="&#106;avascript:x"/></svg><script>after()</script>`;
  const out=bdSanitiseSvg(evil);
  for(const bad of ['script','onload','onclick','javascript','evil.test','foreignObject','iframe','<image','<a ','<set','<animate','sodipodi','metadata','DOCTYPE','ENTITY','@import','behavior','<?xml','after()','document.cookie','alert'])assert.ok(!out.includes(bad),bad+' removed: '+out);
  for(const good of ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="80" viewBox="0 0 200 80">','<linearGradient id="g">','<stop offset="0" stop-color="#2d6b3f"/>','<rect class="b" width="200" height="80" fill="url(#g)" style="stroke:red;background:none"/>','<use xlink:href="#g"/>','.b{fill:#123}','Demo &amp; Co &lt;Pty&gt; </text>','<path d="M0 0L10 10" transform="translate(1 2)"/>','<circle cx="5" cy="5" r="3"/>'])assert.ok(out.includes(good),good+' kept: '+out);
  assert.ok(out.endsWith('</svg>'));
  assert.throws(()=>bdSanitiseSvg('<svg><g></svg>'),/tags do not match/);assert.throws(()=>bdSanitiseSvg('<svg><rect/>'),/ends early/);assert.throws(()=>bdSanitiseSvg('<div/>'),/not an SVG/);assert.throws(()=>bdSanitiseSvg('just text'),/no <svg>/);
  assert.equal(bdSanitiseSvg('<svg/>'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.ok(!bdSanitiseSvg('<svg><rect style="fill:red;\\75rl(x)"/></svg>').includes('style'),'CSS escapes drop the whole style');
  assert.ok(!bdSanitiseSvg('<svg><rect fill="&#x75;rl(https://x.test/a)"/></svg>').includes('x.test'),'encoded url() to the outside dropped');
});

test('commands: the owner saves details and a logo; managers and supervisors can read them but never change them',t=>{
  const f=fixture(t),{manager,supervisor}=people(f),abn=synthAbn();
  let v=f.sim.bdView();assert.equal(v.has,false);assert.equal(v.name,'Demo','the company name when nothing is set');assert.equal(v.logo,null);
  v=f.cmd('bdSaveDetails',{tradingName:'Demo Scaffolding',abn,address:['1 Example St','Sometown NSW 2000'],phone:'02 9000 0000',email:'office@example.com.au',website:'example.com.au'});
  assert.equal(v.name,'Demo Scaffolding');assert.equal(v.abnText,bdAbnFormat(abn));assert.equal(v.has,true);assert.deepEqual(v.address,['1 Example St','Sometown NSW 2000']);
  const logo=f.cmd('bdSaveLogo',{type:'image/png',data:b64(png(40,20))}).logo;assert.equal(logo.type,'image/png');assert.match(logo.url,/^\/api\/company-logo\?v=[0-9a-f]{16}$/);assert.equal(logo.width,40);
  assert.equal(f.sim.bdView().tradingName,'Demo Scaffolding','saving a logo keeps the details');
  v=f.cmd('bdSaveDetails',{tradingName:'Demo Scaffolding Pty Ltd',abn});assert.equal(v.logo.version,logo.version,'saving details keeps the logo');assert.deepEqual(v.address,[]);
  for(const who of [manager,supervisor]){assert.equal(who.bdView().name,'Demo Scaffolding Pty Ltd');assert.equal(who.bdView().logo.version,logo.version);
    for(const [a,input] of [['bdSaveDetails',{tradingName:'Hijack'}],['bdSaveLogo',{type:'image/png',data:b64(png())}],['bdRemoveLogo',{}]])assert.throws(()=>run(who,a,input),{status:403},a);}
  assert.equal(f.sim.bdView().name,'Demo Scaffolding Pty Ltd');
  assert.throws(()=>f.cmd('bdSaveDetails',{abn:'12 345 678 901'}),/not valid/);assert.equal(f.sim.bdView().abn,abn,'a refused save changes nothing');
  // replacing the logo keeps one image row; removing it clears the row
  f.cmd('bdSaveLogo',{type:'image/jpeg',data:b64(jpeg())});assert.equal(f.sim.repo.all('companyLogo').length,1);assert.equal(f.sim.bdView().logo.type,'image/jpeg');
  f.cmd('bdRemoveLogo',{});assert.equal(f.sim.repo.all('companyLogo').length,0);assert.equal(f.sim.bdView().logo,null);assert.throws(()=>f.cmd('bdRemoveLogo',{}),/no logo/);
  const audit=f.auth.snapshot(f.user).audit.map(a=>a.action);assert.ok(audit.includes('company.paperwork')&&audit.includes('company.logo'));
  // another company sees none of it
  const other=new Simulation(f.db,f.auth.authenticate(f.auth.register({name:'Other',companyName:'Other Co',email:randomUUID()+'@example.com',password:'demonstration-password',systems:['quickstage']})));
  assert.equal(other.bdView().name,'Other Co');assert.equal(other.bdView().has,false);
  assert.ok(!('companyBrand' in f.sim.snapshot())&&!JSON.stringify(f.sim.snapshot(0,{lean:true})).includes('iVBOR'),'the image never rides in the snapshot');
});

test('routes: details for any member, the logo with its content type and cache headers, uploads over 16 KB on that route only, owner only',async t=>{
  const f=fixture(t),{supervisor}=people(f);const handler=createApp(f.db).listeners('request')[0];
  const owner=f.auth.login({email:f.user.email,password:'demonstration-password'}),sup=f.auth.login({email:supervisor.user.email,password:'demonstration-password'});
  const call=(method,url,{token=owner,body,headers={}}={})=>new Promise(done=>{const chunks=body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))];const req={method,url,headers:{host:'x',...(token?{cookie:'session='+token}:{}),...(body!==undefined?{'content-type':'application/json','idempotency-key':randomUUID()}:{}),...headers},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield* chunks;}};let status=200;const hdrs={};const res={setHeader(k,v){hdrs[k.toLowerCase()]=v;},writeHead(s,h={}){status=s;for(const [k,v] of Object.entries(h))hdrs[k.toLowerCase()]=v;},end(b){done({status,headers:hdrs,body:b});}};handler(req,res);});
  const json=r=>JSON.parse(r.body);
  assert.equal((await call('GET','/api/company-details',{token:null})).status,401);assert.equal(json(await call('GET','/api/company-details')).name,'Demo');
  assert.equal((await call('GET','/api/company-logo')).status,404);
  const big=Buffer.concat([png(),Buffer.alloc(100000)]);// ~100 KB: over the usual 16 KB body limit
  assert.equal((await call('POST','/api/commands/bdSaveLogo',{body:{type:'image/png',data:b64(big)}})).status,413,'the general command route keeps its 16 KB limit');
  assert.equal((await call('POST','/api/company-logo',{token:sup,body:{type:'image/png',data:b64(png())}})).status,403,'a supervisor cannot upload');
  const up=await call('POST','/api/company-logo',{body:{type:'image/png',data:b64(big)}});assert.equal(up.status,200,up.body);const v=json(up).logo.version;
  assert.equal((await call('POST','/api/company-logo',{body:{type:'image/png',data:'A'.repeat(600000)}})).status,413,'even this route has a ceiling');
  const got=await call('GET','/api/company-logo?v='+v,{token:sup});assert.equal(got.status,200);assert.equal(got.headers['content-type'],'image/png');assert.ok(Buffer.from(got.body).equals(big));
  assert.match(got.headers['cache-control'],/max-age=31536000/);assert.equal(got.headers.etag,'"'+v+'"');assert.match(got.headers['content-security-policy'],/sandbox/);
  assert.equal((await call('GET','/api/company-logo')).headers['cache-control'],'private, no-cache','no version: revalidate');
  assert.equal((await call('GET','/api/company-logo',{headers:{'if-none-match':'"'+v+'"'}})).status,304);
  assert.equal((await call('GET','/api/company-logo',{token:null})).status,401);
  // an SVG is served as the cleaned file, never what was sent
  await call('POST','/api/company-logo',{body:{type:'image/svg+xml',data:b64('<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>')}});
  const svg=await call('GET','/api/company-logo');assert.equal(svg.headers['content-type'],'image/svg+xml');assert.equal(String(svg.body),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
  assert.equal((await call('POST','/api/commands/bdSaveDetails',{token:sup,body:{tradingName:'X'}})).status,403);
  assert.equal((await call('POST','/api/commands/bdSaveDetails',{body:{tradingName:'Demo Scaffolding'}})).status,200);assert.equal(json(await call('GET','/api/company-details',{token:sup})).name,'Demo Scaffolding');
});

test('print header: logo top-left, trading name, ABN and a contact line; the plain company name when nothing is set',async()=>{
  const {bdHead,prSheetHTML}=await import('../public/operations.js'),abn=synthAbn();
  const brand={company:'Demo',name:'Demo Scaffolding',tradingName:'Demo Scaffolding',abn,abnText:bdAbnFormat(abn),address:['1 Example St','Sometown NSW 2000'],phone:'02 9000 0000',email:'office@example.com.au',website:'example.com.au',logo:{type:'image/png',version:'abc123def4567890',width:400,height:100,url:'/api/company-logo?v=abc123def4567890'},has:true};
  const html=bdHead({company:'Demo',kind:'pick',yard:'Main yard',brand});
  for(const s of ['<img class="bd-logo','src="/api/company-logo?v=abc123def4567890"','Demo Scaffolding','ABN '+bdAbnFormat(abn),'1 Example St, Sometown NSW 2000','02 9000 0000','office@example.com.au','example.com.au'])assert.ok(html.includes(s),s);
  assert.ok(!/style="/.test(html),'no style attributes');
  const plain=bdHead({company:'Demo',kind:'pick',yard:'Main yard',brand:{...brand,has:false,logo:null,name:'Demo',tradingName:'',abn:'',abnText:'',address:[],phone:'',email:'',website:''}});
  assert.ok(plain.includes('pr-mark')&&plain.includes('<b>Demo</b>')&&!plain.includes('ABN'),'fallback: the mark and the company name');
  assert.ok(bdHead({company:'Demo',kind:'pick',yard:'Main yard'}).includes('<b>Demo</b>'),'no brand at all');
  const hostile=bdHead({company:'x',kind:'docket',brand:{...brand,name:'<img src=x onerror=alert(1)>',logo:{...brand.logo,url:'javascript:alert(1)'}}});assert.ok(!hostile.includes('<img src=x')&&!hostile.includes('javascript:'),'escaped, and only our own logo URL');
  // every sheet goes through it
  const sheet=prSheetHTML({kind:'pick',no:'PL-1',name:'L',status:'OPEN',site:{name:'S'},lines:[],totals:{lines:0,pieces:0,weight:0,noWeight:0,stillages:0,short:0},company:'Demo',brand,printedAt:'2026-09-25T23:00:00Z'});assert.ok(sheet.includes('bd-logo')&&sheet.includes('ABN '));
});
