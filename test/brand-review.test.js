import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { bdAbnValid, bdSanitiseSvg, bdCheckLogo, bdDetails } from '../src/domain/brand.js';
import { fixture } from './simulation.test.js';
// Company details after review: ABNs typed with dashes or dots, bidi control characters, SVG logos without a size, CSS url() tricks in an SVG,
// and the logo route refusing anonymous uploads before it reads the body.
// A made-up ABN with valid check digits (the nine digits are arbitrary, the first two are solved for the checksum).
const synthAbn=(body='004085616')=>{for(let c=10;c<100;c++){const d=String(c)+body;if(bdAbnValid(d))return d;}throw new Error('no check digits');};
const b64=s=>Buffer.from(s).toString('base64');

test('an ABN may be typed with spaces, dashes or dots; it is saved as 11 digits',()=>{
 const abn=synthAbn(),dashed=abn.slice(0,2)+'-'+abn.slice(2,5)+'-'+abn.slice(5,8)+'-'+abn.slice(8),dotted=abn.slice(0,2)+'.'+abn.slice(2,5)+'.'+abn.slice(5,8)+'.'+abn.slice(8);
 assert.ok(bdAbnValid(dashed));assert.ok(bdAbnValid(dotted));assert.equal(bdDetails({abn:dashed}).abn,abn);assert.equal(bdDetails({abn:dotted}).abn,abn);
 assert.throws(()=>bdDetails({abn:'12-345-678-901'}),/not valid/);assert.throws(()=>bdDetails({abn:'12/345'}),/11 digits/);
});

test('bidi marks, overrides and isolates are refused in the paperwork fields',()=>{
 for(const ch of ['‮','‪','⁦','⁩','‏'])assert.throws(()=>bdDetails({email:'a@b.co'+ch}),/cannot be printed/,JSON.stringify(ch));
 assert.equal(bdDetails({tradingName:'Café Scaffolding'}).tradingName,'Café Scaffolding','ordinary accents are fine');
});

test('an SVG logo must say its size; CSS url() tricks and image() are dropped from its styles',()=>{
 assert.throws(()=>bdCheckLogo({type:'image/svg+xml',data:b64('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>')}),/does not say how big it is/);
 assert.equal(bdCheckLogo({type:'image/svg+xml',data:b64('<svg viewBox="0 0 40 10"><rect width="4" height="4"/></svg>')}).width,40);
 const out=bdSanitiseSvg(`<svg viewBox="0 0 4 4"><style>rect{fill:url( 'http://evil.example/)x' )}</style><rect style="fill:url( 'http://evil.example/)y' )" width="4" height="4"/><circle style="fill:image(&quot;http://evil.example&quot;)" r="1"/><path style="fill:url(#g)" d="M0 0h1"/></svg>`);
 assert.ok(!/evil|image\(/.test(out),out);assert.ok(out.includes('style="fill:url(#g)"'),'an inside reference is kept');
});

test('POST /api/company-logo checks the session and the role before it reads a large body',async t=>{
 const f=fixture(t);const handler=createApp(f.db).listeners('request')[0];let read=0;
 const call=token=>new Promise(done=>{const req={method:'POST',url:'/api/company-logo',headers:{host:'x','content-type':'application/json',...(token?{cookie:'session='+token}:{})},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){read++;yield Buffer.from(JSON.stringify({type:'image/png',data:'A'.repeat(400000)}));}};let status=0;const res={setHeader(){},writeHead(s){status=s;},end(){done(status);}};handler(req,res);});
 assert.equal(await call(null),401);assert.equal(read,0,'nothing read for an anonymous upload');
 const email=randomUUID()+'@example.com';f.auth.addUser(f.user,{name:'Sup',email,password:'demonstration-password',roles:['SUPERVISOR']});
 assert.equal(await call(f.auth.login({email,password:'demonstration-password'})),403);assert.equal(read,0,'nor for a supervisor');
});
