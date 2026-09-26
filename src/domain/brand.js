import { createHash } from 'node:crypto';
import { cached } from '../database.js';
import { AppError } from '../service.js';
import { requireRule } from './geometry.js';
// Company details and logo for the paperwork (prefix bd). The owner (company.manage) keeps one 'companyBrand' object per company: trading name, ABN,
// address lines, phone, email, website and a reference to the logo. The logo's bytes live in their own 'companyLogo' object (base64 in its JSON), so no
// snapshot or kind scan ever reads them; GET /api/company-logo serves them with their own content type (the page CSP allows no data: images).
// PNG and JPEG are checked by their bytes and size; SVG is rebuilt from an allowlist (no scripts, no event handlers, no links out, no external styles).
export const BD_LOGO_MAX=300*1024;// bytes of the image itself
export const BD_LOGO_BODY=Math.ceil(BD_LOGO_MAX*4/3)+8192;// the JSON body of POST /api/company-logo (base64 plus a little)
export const BD_TYPES=['image/png','image/jpeg','image/svg+xml'];
const MAX_SIDE=6000;
// ---- ABN: 11 digits; subtract 1 from the first, weight 10,1,3,5,...,19, the sum divides by 89. ----
const ABN_W=[10,1,3,5,7,9,11,13,15,17,19];
export function bdAbnValid(value){const d=String(value??'').replace(/[\s.-]+/g,'');if(!/^\d{11}$/.test(d)||d[0]==='0')return false;let sum=0;for(let i=0;i<11;i++)sum+=((+d[i])-(i===0?1:0))*ABN_W[i];return sum%89===0;}
export const bdAbnFormat=d=>{const s=String(d??'').replace(/[\s.-]+/g,'');return /^\d{11}$/.test(s)?s.slice(0,2)+' '+s.slice(2,5)+' '+s.slice(5,8)+' '+s.slice(8):s;};
// ---- Field checks ----
// Control characters, line/paragraph separators and the bidi marks, overrides and isolates (they can reverse or disguise printed text).
const CTRL=/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function line(v,label,max){if(v==null)return '';requireRule(typeof v==='string',label+' must be text.');const s=v.replace(/\s+/g,' ').trim();requireRule(!CTRL.test(s),label+' has characters that cannot be printed.');requireRule(s.length<=max,label+' is too long (maximum '+max+' characters).');return s;}
export function bdDetails(input){
  requireRule(input&&typeof input==='object'&&!Array.isArray(input),'Send the company details.');
  const tradingName=line(input.tradingName,'Trading name',120);
  const abnRaw=line(input.abn,'ABN',20).replace(/[\s.-]+/g,'');// spaces, dashes and dots are fine: 53 004 085 616, 53-004-085-616
  requireRule(!abnRaw||/^\d{11}$/.test(abnRaw),'An ABN has 11 digits, for example 12 345 678 901.');
  requireRule(!abnRaw||bdAbnValid(abnRaw),'That ABN is not valid: check the digits against your ABN record (the check digits do not match).');
  const lines=input.address==null?[]:input.address;requireRule(Array.isArray(lines)&&lines.length<=3,'Give up to three address lines.');
  const address=lines.map((l,i)=>line(l,'Address line '+(i+1),120)).filter(Boolean);
  const phone=line(input.phone,'Phone',40);requireRule(!phone||(/^[0-9+()\s.-]+$/.test(phone)&&phone.replace(/\D/g,'').length>=6),'Enter the phone number with digits, spaces, + ( ) or - only.');
  const email=line(input.email,'Email',254).toLowerCase();requireRule(!email||/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email),'Enter a valid email address.');
  let website=line(input.website,'Website',200);
  if(website){requireRule(/^(https?:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?(\/[^\s<>"']*)?$/i.test(website),'Enter the website like www.example.com.au.');website=website.replace(/^https?:\/\//i,'').replace(/\/$/,'');}
  return {tradingName,abn:abnRaw,address,phone,email,website};
}
// ---- Image checks ----
const PNG_SIG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
function pngSize(b){if(b.length<33||!b.subarray(0,8).equals(PNG_SIG)||b.toString('latin1',12,16)!=='IHDR')return null;return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};}
function jpegSize(b){if(b.length<4||b[0]!==0xff||b[1]!==0xd8||b[2]!==0xff)return null;let i=2;
  while(i+9<b.length){if(b[i]!==0xff){i++;continue;}const m=b[i+1];if(m===0xff){i++;continue;}if(m===0xd8||m===0x01||(m>=0xd0&&m<=0xd7)){i+=2;continue;}if(m===0xd9||m===0xda)break;const len=b.readUInt16BE(i+2);if(len<2)return null;
    if(m>=0xc0&&m<=0xcf&&![0xc4,0xc8,0xcc].includes(m))return {width:b.readUInt16BE(i+7),height:b.readUInt16BE(i+5)};i+=2+len;}
  return null;}
const sniff=b=>b.subarray(0,8).equals(PNG_SIG)?'image/png':(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)?'image/jpeg':null;
// ---- SVG: rebuilt token by token from what is allowed; everything else is dropped. ----
const SVG_ELEMENTS=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','textPath','defs','linearGradient','radialGradient','stop','clipPath','mask','pattern','symbol','use','title','desc','style','marker','filter','feGaussianBlur','feOffset','feBlend','feColorMatrix','feFlood','feComposite','feMerge','feMergeNode','feMorphology','feDropShadow']);
const SVG_UNWRAP=new Set(['a','switch']);// kept for their children only
const SVG_ATTRS=new Set(['id','class','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','fx','fy','fr','dx','dy','width','height','d','points','pathLength','transform','viewBox','preserveAspectRatio','version','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-dasharray','stroke-dashoffset','stroke-opacity','opacity','clip-path','clip-rule','mask','filter','style','color','display','visibility','overflow','font-family','font-size','font-weight','font-style','font-variant','font-stretch','text-anchor','text-decoration','letter-spacing','word-spacing','dominant-baseline','alignment-baseline','baseline-shift','writing-mode','rotate','textLength','lengthAdjust','startOffset','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','spreadMethod','patternUnits','patternContentUnits','patternTransform','maskUnits','maskContentUnits','clipPathUnits','filterUnits','primitiveUnits','markerWidth','markerHeight','markerUnits','refX','refY','orient','in','in2','result','mode','operator','k1','k2','k3','k4','values','type','stdDeviation','flood-color','flood-opacity','radius','vector-effect','paint-order','shape-rendering','text-rendering','image-rendering','color-interpolation','color-interpolation-filters','mix-blend-mode','isolation','marker-start','marker-mid','marker-end','href','xlink:href','xml:space','xmlns','xmlns:xlink']);
const NAMED={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
const decode=s=>s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);?/gi,(m,e)=>{if(e[0]==='#'){const n=e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';}return NAMED[e.toLowerCase()]??'';});
const xmlEsc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(CTRL_XML,'');
const CTRL_XML=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BAD_CSS=/@import|@font-face|@namespace|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|\\|<|image-set|image\s*\(|cross-fade|element\s*\(|attr\s*\(|src\s*\(/i;
// CSS kept only when it holds nothing that can fetch, run or escape; url() may point only inside the file (url(#id)).
// Anything that still says url( after the rewrite (a quoted URL holding a bracket, an escape) drops the whole style.
function cleanCss(css){const s=css.replace(/\/\*[\s\S]*?\*\//g,' ');if(BAD_CSS.test(s))return null;const out=s.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi,(m,q,u)=>u.trim().startsWith('#')?'url(#'+u.trim().slice(1).replace(/[^\w.:-]/g,'')+')':'none');
  return /url\s*\(/i.test(out.replace(/url\(#[\w.:-]*\)/g,''))?null:out;}
function cleanAttr(name,raw){const v=decode(raw);if(/[\u0000-\u0008]/.test(v))return null;
  if(name==='href'||name==='xlink:href')return /^#[\w.:-]+$/.test(v.trim())?v.trim():null;
  if(name==='style')return cleanCss(v);
  if(/javascript:|vbscript:|data:|expression\s*\(/i.test(v.replace(/\s+/g,'')))return null;
  if(/url\(/i.test(v))return /^\s*url\(\s*['"]?#[\w.:-]+['"]?\s*\)\s*(none|[\w#(),.\s%-]*)?$/i.test(v)?v.replace(/url\(\s*['"]?#([\w.:-]+)['"]?\s*\)/gi,'url(#$1)'):null;
  return v;}
const TOKEN=/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|([^<]+)|(<)/gi;
const ATTR=/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g;
export function bdSanitiseSvg(text){
  requireRule(typeof text==='string'&&text.length>0,'That SVG file is empty.');
  const src=text.replace(/^﻿/,'');requireRule(!src.includes('\u0000'),'That file is not an SVG image.');
  let out='',root=false,done=false,skip=0,usesXlink=false;const stack=[];
  for(const m of src.matchAll(TOKEN)){
    if(done)break;
    const [tok,cdata,close,open,attrs,self,txt,lone]=m;
    if(lone!==undefined)throw new AppError(400,'That SVG file could not be read (a stray < sign).');
    if(close!==undefined){if(skip){skip--;continue;}const top=stack.pop();requireRule(top&&top.name===close,'That SVG file could not be read (its tags do not match).');if(top.emit)out+='</'+top.name+'>';if(!stack.length){done=true;}continue;}
    if(open!==undefined){
      if(skip){if(!self)skip++;continue;}
      if(!root){requireRule(open==='svg','That file is not an SVG image (it does not start with <svg>).');}
      const name=open,keep=SVG_ELEMENTS.has(name)&&(root||name==='svg'),unwrap=root&&SVG_UNWRAP.has(name);
      if(!keep&&!unwrap){if(!self)skip=1;continue;}
      if(unwrap){if(!self)stack.push({name,emit:false});continue;}
      let a='';const seen=new Set();
      for(const [,an,av] of (attrs??'').matchAll(ATTR)){if(!SVG_ATTRS.has(an)||seen.has(an))continue;if(an==='xmlns'||an==='xmlns:xlink')continue;const raw=av===undefined?'':av.replace(/^["']|["']$/g,'');const v=cleanAttr(an,raw);if(v==null)continue;seen.add(an);if(an==='xlink:href')usesXlink=true;a+=' '+an+'="'+xmlEsc(v)+'"';}
      if(name==='svg'&&!root){a=' xmlns="http://www.w3.org/2000/svg"'+'\u0001'+a;root=true;}
      out+='<'+name+a+(self?'/>':'>');
      if(self){if(!stack.length)done=true;}else stack.push({name,emit:true});
      continue;}
    if(skip||!root)continue;
    if(cdata!==undefined||txt!==undefined){const inStyle=stack.at(-1)?.name==='style';let t=cdata!==undefined?cdata:decode(txt);if(inStyle){const c=cleanCss(t);if(c==null)continue;t=c;}else if(!['text','tspan','textPath','title','desc'].includes(stack.at(-1)?.name)&&!/^\s*$/.test(t))continue;out+=xmlEsc(t);}
    // comments, processing instructions and doctypes are dropped
  }
  requireRule(root,'That file is not an SVG image (no <svg> element found).');
  requireRule(done,'That SVG file could not be read (it ends early).');
  out=out.replace('\u0001',usesXlink?' xmlns:xlink="http://www.w3.org/1999/xlink"':'');
  return out;
}
// Width and height (or the viewBox) for the preview's proportions; 0 when the file does not say.
function svgSize(svg){const tag=svg.match(/^<svg[^>]*>/)?.[0]??'';const vb=tag.match(/viewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i);const n=k=>{const v=tag.match(new RegExp('\\s'+k+'="\\s*([\\d.]+)(px)?\\s*"'))?.[1];return v?Math.round(+v):0;};
  const w=n('width'),h=n('height');if(w&&h)return {width:w,height:h};if(vb)return {width:Math.round(+vb[1]),height:Math.round(+vb[2])};return {width:0,height:0};}
export function bdCheckLogo(input){
  requireRule(input&&typeof input==='object'&&!Array.isArray(input),'Send the logo file.');
  requireRule(BD_TYPES.includes(input.type),'Use a PNG, JPEG or SVG image for the logo.');
  requireRule(typeof input.data==='string'&&input.data.length>0,'Choose a logo file.');
  requireRule(input.data.length<=Math.ceil(BD_LOGO_MAX*4/3)+4,'That logo is too big: keep it under 300 KB.');
  requireRule(/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)&&input.data.length%4===0,'The logo file did not arrive whole. Try again.');
  let bytes=Buffer.from(input.data,'base64');
  requireRule(bytes.length>0,'That logo file is empty.');requireRule(bytes.length<=BD_LOGO_MAX,'That logo is too big: keep it under 300 KB.');
  let type=input.type,size;
  if(type==='image/svg+xml'){requireRule(!sniff(bytes),'That file is a '+(sniff(bytes)==='image/png'?'PNG':'JPEG')+' picture, not an SVG. Choose it again.');const text=bytes.toString('utf8');requireRule(!text.includes('�'),'That SVG file is not plain text (UTF-8).');const clean=bdSanitiseSvg(text);bytes=Buffer.from(clean,'utf8');requireRule(bytes.length<=BD_LOGO_MAX,'That logo is too big: keep it under 300 KB.');size=svgSize(clean);
    requireRule(size.width>0&&size.height>0,'That SVG does not say how big it is (no width and height, or viewBox). Save it again with a size, or use a PNG.');}
  else{const real=sniff(bytes);requireRule(real,'That file is not a PNG or JPEG picture.');requireRule(real===type,'That file is a '+(real==='image/png'?'PNG':'JPEG')+' picture, not a '+(type==='image/png'?'PNG':'JPEG')+'. Choose it again.');
    size=type==='image/png'?pngSize(bytes):jpegSize(bytes);requireRule(size,'That picture could not be read.');requireRule(size.width<=MAX_SIDE&&size.height<=MAX_SIDE,'That picture is too large: keep each side under '+MAX_SIDE+' pixels.');requireRule(size.width>=16&&size.height>=16,'That picture is too small for a logo (at least 16 × 16 pixels).');}
  const sha=createHash('sha256').update(bytes).digest('hex');
  return {type,bytes,sha,width:size.width,height:size.height};
}
const EMPTY={tradingName:'',abn:'',address:[],phone:'',email:'',website:''};
export const brandMethods={
  bdRecord(){return this.repo.all('companyBrand')[0]??null;},
  bdCompanyName(){return cached(this.db,'SELECT name FROM companies WHERE id=?').get(this.user.company_id)?.name??'';},
  // What the Account card, the top bar and every printed sheet read (any member of the company may read it; only an owner changes it).
  bdView(){const r=this.bdRecord(),d={...EMPTY,...(r??{})},logo=r?.logo??null;const company=this.bdCompanyName();
    const has=!!(d.tradingName||d.abn||d.address.length||d.phone||d.email||d.website||logo);
    return {company,name:d.tradingName||company,tradingName:d.tradingName,abn:d.abn,abnText:d.abn?bdAbnFormat(d.abn):'',address:d.address,phone:d.phone,email:d.email,website:d.website,
      logo:logo?{type:logo.type,version:logo.sha.slice(0,16),width:logo.width,height:logo.height,size:logo.size,url:'/api/company-logo?v='+logo.sha.slice(0,16)}:null,has,updatedAt:r?.updatedAt??null};},
  bdSave(patch,audit){const r=this.bdRecord(),now=new Date().toISOString();const next={...EMPTY,...(r??{}),...patch,updatedAt:now,updatedBy:this.user.id};
    if(r)this.repo.save({...next,id:r.id,kind:r.kind,version:r.version});else{const {id,kind,version,...data}=next;this.repo.add('companyBrand',data);}
    this.auth.audit(this.user,audit.action,audit.details??{});return this.bdView();},
  bdSaveDetails(input){return this.bdSave(bdDetails(input),{action:'company.paperwork'});},
  bdSaveLogo(input){const logo=bdCheckLogo(input);const r=this.bdRecord();if(r?.logo?.id)this.repo.remove(r.logo.id,'companyLogo');
    const row=this.repo.add('companyLogo',{type:logo.type,data:logo.bytes.toString('base64'),sha:logo.sha,size:logo.bytes.length,width:logo.width,height:logo.height,uploadedAt:new Date().toISOString()});
    return this.bdSave({logo:{id:row.id,type:logo.type,sha:logo.sha,size:logo.bytes.length,width:logo.width,height:logo.height}},{action:'company.logo',details:{type:logo.type,size:logo.bytes.length}});},
  bdRemoveLogo(){const r=this.bdRecord();requireRule(r?.logo,'There is no logo to remove.');this.repo.remove(r.logo.id,'companyLogo');return this.bdSave({logo:null},{action:'company.logo',details:{removed:true}});},
  // The stored image, or null. SVG was rebuilt when it was saved, so what is served is only what the allowlist kept.
  bdLogo(){const r=this.bdRecord();if(!r?.logo?.id)return null;let row;try{row=this.repo.get(r.logo.id,'companyLogo');}catch{return null;}return {type:row.type,bytes:Buffer.from(row.data,'base64'),version:row.sha.slice(0,16)};}
};
// The two routes (server.js): GET /api/company-details, GET /api/company-logo (cached for a year under its version, revalidated otherwise) and POST /api/company-logo.
export function bdRoute(req,res,simulation,path,body,send){
  if(path==='/api/company-details'&&req.method==='GET')return send(200,simulation.bdView());
  if(path==='/api/company-logo'&&req.method==='POST')return send(200,simulation.execute('bdSaveLogo',body,req.headers['idempotency-key']));
  if(path==='/api/company-logo'&&req.method==='GET'){const logo=simulation.bdLogo();if(!logo)throw new AppError(404,'No logo has been added.');
    const v=new URL(req.url,'http://localhost').searchParams.get('v'),etag='"'+logo.version+'"';
    res.setHeader('Cache-Control',v===logo.version?'private, max-age=31536000, immutable':'private, no-cache');res.setHeader('ETag',etag);
    // An SVG opened on its own gets no scripts, no plugins and nothing from elsewhere (it holds none anyway).
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox");res.setHeader('Content-Disposition','inline; filename="logo.'+({'image/png':'png','image/jpeg':'jpg','image/svg+xml':'svg'}[logo.type])+'"');
    if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
    res.writeHead(200,{'Content-Type':logo.type,'Content-Length':logo.bytes.length});res.end(logo.bytes);return;}
  throw new AppError(405,'Method not allowed.');
}
