import {openOperations,stopOperations,catalogueSettings,bindCatalogue} from './operations.js';
import {mountSprites,sprite,siMount,siImg} from './art.js';
const app=document.querySelector('#app'),message=document.querySelector('#message');
let systems=[],state=null;
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,data) {const res=await fetch(`/api/${path}`,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await res.json();if(!res.ok)throw Object.assign(new Error(value.error),{status:res.status});return value;}
// The toast hides itself after 6 s (10 s for long texts) or on a click; a new message restarts the timer.
let toastTimer=null;
function notify(text){clearTimeout(toastTimer);toastTimer=null;text=String(text??'');message.textContent=text;if(text)toastTimer=setTimeout(()=>{message.textContent='';toastTimer=null;},text.length>120?10000:6000);}
message.addEventListener('click',()=>{clearTimeout(toastTimer);toastTimer=null;message.textContent='';});
// System tiles: the short badge is aria-hidden so each checkbox is still named by the system alone ("Quickstage").
const SYS_BADGE={quickstage:'QS','at-pac':'AT','tube-clip':'T&C'};
const badge=x=>SYS_BADGE[x.id]??String(x.name).replace(/[^A-Za-z]/g,'').slice(0,2).toUpperCase();
const checks=(items,selected,name,tiles=false)=>`<div class="checks${tiles?' sys-tiles':''}">${items.map(x=>`<label><input type="checkbox" name="${name}" value="${escape(x.id)}" ${selected.includes(x.id)?'checked':''}>${tiles?`<span class="sys-badge" aria-hidden="true">${escape(badge(x))}</span>`:''}${escape(x.name)}</label>`).join('')}</div>`;
const field=(name,label,type='text',value='')=>`<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" required maxlength="${type==='email'?254:128}" ${type==='password'?'minlength="12" autocomplete="new-password"':''}></label>`;
const ROLES=[{id:'OWNER',name:'Owner / Director'},{id:'GENERAL_MANAGER',name:'General Manager'},{id:'SUPERVISOR',name:'Supervisor'}];
const ROLE_NAME={OWNER:'Owner / Director',GENERAL_MANAGER:'General Manager',SUPERVISOR:'Supervisor'},ROLE_SHORT={OWNER:'Owner',GENERAL_MANAGER:'General Manager',SUPERVISOR:'Supervisor'},ROLE_COUNT={OWNER:'owner',GENERAL_MANAGER:'manager',SUPERVISOR:'supervisor'},ROLE_CLASS={OWNER:'owner',GENERAL_MANAGER:'manager',SUPERVISOR:'supervisor'};
const ROLE_ORDER=['OWNER','GENERAL_MANAGER','SUPERVISOR'];
const rolePills=roles=>roles.map(r=>`<span class="role-pill ${ROLE_CLASS[r]??''}">${escape(ROLE_SHORT[r]??r)}</span>`).join('');

// ---------- Scenery: small isometric dioramas drawn with the shared sprite sheet (spr-*) plus boxes built here (cabins, containers). ----------
const f1=n=>Math.round(n*10)/10;
const isoAt=(ox,oy,k)=>(x,y,z=0)=>[f1(ox+(x-y)*k*.866),f1(oy+(x+y)*k*.5-z*k)];
const OL=' stroke="#23392c" stroke-width="1.1" stroke-linejoin="round"';
const poly=(P,pts,fill,more='')=>'<path d="M'+pts.map(p=>P(...p).join(' ')).join('L')+'Z" fill="'+fill+'"'+more+'/>';
// A box: c = [top, front-left face (y+d), front-right face (x+w)].
const box=(P,x,y,z,w,d,h,c,ol=OL)=>poly(P,[[x,y+d,z],[x+w,y+d,z],[x+w,y+d,z+h],[x,y+d,z+h]],c[1],ol)+poly(P,[[x+w,y,z],[x+w,y+d,z],[x+w,y+d,z+h],[x+w,y,z+h]],c[2],ol)+poly(P,[[x,y,z+h],[x+w,y,z+h],[x+w,y+d,z+h],[x,y+d,z+h]],c[0],ol);
const onL=(P,y,a,b,c,e,fill,more='')=>poly(P,[[a,y,c],[b,y,c],[b,y,e],[a,y,e]],fill,more);
const onR=(P,x,a,b,c,e,fill,more='')=>poly(P,[[x,a,c],[x,b,c],[x,b,e],[x,a,e]],fill,more);
const shadow=(P,x,y,w,d,o=.18)=>poly(P,[[x+.3,y+.3],[x+w+.6,y+.3],[x+w+.6,y+d+.6],[x+.3,y+d+.6]],'#1c2a12',' fill-opacity="'+o+'"');
const glass=' stroke="#23392c" stroke-width=".9"';
// A site cabin: cream walls, dark roof with an overhang, windows along the long face, a door on the end.
function cabin(P,x,y,z,w,d,h,{door=true,sign=''}={}){let s=(z?'':shadow(P,x,y,w,d))+box(P,x,y,z,w,d,h,['#f1ecdc','#e6dfca','#cfc6ad']);
 for(let a=x+.5;a+1.2<=x+w-.3;a+=1.7)s+=onL(P,y+d,a,a+1.2,z+h*.38,z+h*.78,'#6fa2c0',glass)+onL(P,y+d,a+.1,a+.55,z+h*.5,z+h*.74,'#bfe0f0',' fill-opacity=".7"');
 if(door)s+=onR(P,x+w,y+d*.28,y+d*.72,z,z+h*.8,'#2f5d45',glass)+onR(P,x+w,y+d*.58,y+d*.64,z+h*.36,z+h*.42,'#e3bd2c');
 s+=box(P,x-.15,y-.15,z+h,w+.3,d+.3,.22,['#4e6b58','#3b5646','#2f4739']);
 if(sign){const [sx,sy]=P(x+w*.5,y+d,z+h+.9);s+=onL(P,y+d,x+w*.18,x+w*.82,z+h+.24,z+h+1.04,'#1f4a34',OL)+'<text transform="matrix(.866 .5 0 1 '+sx+' '+f1(sy+3)+')" text-anchor="middle" font-size="8.5" font-weight="800" letter-spacing="1.1" fill="#d9f56b">'+sign+'</text>';}
 return s;}
// Sprite from the shared sheet, placed so its foot point (ax, ay as fractions of the box) stands on plan point (x, y).
const put=(P,id,x,y,w,h,ax=.5,ay=.82)=>{const [sx,sy]=P(x,y);return '<use href="#'+id+'" x="'+f1(sx-w*ax)+'" y="'+f1(sy-h*ay)+'" width="'+w+'" height="'+h+'"/>';};
const WK=[.42,.89],TREE=[.42,.82],FL=[.38,.8],ST=[.5,.78];
const slab=(P,W,D)=>poly(P,[[0,0],[W,0],[W,D],[0,D]],'#d8d1c1')+poly(P,[[0,D,0],[W,D,0],[W,D,-.5],[0,D,-.5]],'#b3ab96')+poly(P,[[W,0,0],[W,D,0],[W,D,-.5],[W,0,-.5]],'#a79f8b');
const fence=(P,W,D)=>{let d='';for(let x=0;x<=W;x+=2)d+='M'+P(x,0).join(' ')+'L'+P(x,0,1.4).join(' ');for(let y=2;y<=D;y+=2)d+='M'+P(0,y).join(' ')+'L'+P(0,y,1.4).join(' ');return '<path d="M'+P(0,D,1.2).join(' ')+'L'+P(0,0,1.2).join(' ')+'L'+P(W,0,1.2).join(' ')+'M'+P(0,D,.2).join(' ')+'L'+P(0,0,.2).join(' ')+'L'+P(W,0,.2).join(' ')+'" fill="none" stroke="#9aa6a0" stroke-width="1.4" opacity=".9"/><path d="'+d+'" stroke="#7d8a84" stroke-width="1.6"/>';};
const bay=(P,x,y,w,d)=>poly(P,[[x,y],[x+w,y],[x+w,y+d],[x,y+d]],'none',' stroke="#e3bd2c" stroke-width="1.6" stroke-dasharray="5 4" opacity=".9"');
// Sign-in / sign-up: a working yard — office cabin, stillage bays, a forklift with a load, a 12.5 t truck at the loading bay and the crew.
let authArt=null;
function authScene(){if(authArt)return authArt;const P=isoAt(292,58,17.5),G=isoAt(292,58,17.5);
 const grass=poly(G,[[-4,-4],[20,-4],[20,16],[-4,16]],'#8fa866'),road=poly(G,[[16.6,-4],[19.4,-4],[19.4,16],[16.6,16]],'#55595b')+'<path d="M'+G(18,-4).join(' ')+'L'+G(18,16).join(' ')+'" stroke="#e8e4d6" stroke-width="2" stroke-dasharray="12 10" opacity=".7"/>';
 let s=grass+road+slab(P,16,12)+fence(P,16,12)+bay(P,6.4,.6,8.8,2.6)+bay(P,6.4,4,8.8,2.6)+poly(P,[[10,7.2],[14.6,7.2],[14.6,11.6],[10,11.6]],'#e3bd2c',' fill-opacity=".22" stroke="#e3bd2c" stroke-width="1.6"');
 s+=put(P,'spr-tree',-2.4,1.2,66,78,...TREE)+put(P,'spr-tree',3,-2.6,52,62,...TREE)+put(P,'spr-tree',-2,8.6,58,69,...TREE);
 s+=cabin(P,.6,.6,0,5,2.4,2.5,{sign:'YARD OFFICE'});
 for(const [x,y] of [[7,.8],[9.2,.8],[11.4,.8],[13.6,.8]])s+=put(P,'spr-stillage',x+.9,y+1.2,70,46,...ST);
 s+=put(P,'spr-stillage',7.9,1.6,70,46,.5,1.25)+put(P,'spr-stillage',10.1,1.6,70,46,.5,1.25);
 for(const [x,y] of [[7,4.2],[9.2,4.2]])s+=put(P,'spr-stillage',x+.9,y+1.2,70,46,...ST);
 s+=put(P,'spr-cage',12.4,5.4,54,36,...ST)+put(P,'spr-cage',14.2,5.4,54,36,...ST);
 s+=put(P,'spr-worker',4.2,4.6,24,44,...WK)+put(P,'spr-worker-busy',11.2,3.4,22,41,...WK);
 s+=put(P,'spr-forklift-load',7.6,8.6,94,75,...FL);
 s+=put(P,'spr-truck12',12.1,10,176,94,.5,.72);
 s+=put(P,'spr-worker',3.4,9.4,25,46,...WK)+put(P,'spr-worker-busy',14.9,11.2,24,44,...WK);
 s+=put(P,'spr-tree',-1.4,12.8,56,66,...TREE);
 return authArt='<svg class="auth-diorama" viewBox="0 0 580 350" aria-hidden="true" focusable="false"><g transform="translate(19 26) scale(.84)">'+s+'</g></svg>';}
// Account: the yard office — a two-storey cabin block with the company flag, the team out front, the backup store (a lockable container) and a stillage bay.
let acctArt=null;
function accountScene(){if(acctArt)return acctArt;const P=isoAt(300,100,14);
 let s=poly(P,[[-5,-4],[21,-4],[21,15],[-5,15]],'#8fa866')+slab(P,16,11)+bay(P,10.8,.8,4.4,4.2);
 s+=put(P,'spr-tree',-2.6,1.6,62,74,...TREE)+put(P,'spr-tree',4,-2.8,50,60,...TREE);
 const [fx,fy]=P(.4,6.8),[tx,ty]=P(.4,6.8,6.4);s+='<path d="M'+fx+' '+fy+'L'+tx+' '+ty+'" stroke="#dfe6e2" stroke-width="2.4"/><path d="M'+tx+' '+ty+'l30 5-4 9 4 9-30-5z" fill="#b9ef4b" stroke="#23392c" stroke-width="1"/>';
 s+=cabin(P,.8,.8,0,6.4,2.6,2.4,{door:false})+cabin(P,.8,.8,2.62,6.4,2.6,2.3,{door:false,sign:'SITE OFFICE'});
 // stairs to the upper cabin
 s+=poly(P,[[7.2,1.2,0],[8.4,1.2,0],[8.4,1.2,2.6],[7.2,1.2,2.6]],'#9aa6a0',' fill-opacity=".35"')+'<path d="M'+P(8.4,3.2,0).join(' ')+'L'+P(7.3,1.3,2.62).join(' ')+'M'+P(8.4,2.4,0).join(' ')+'L'+P(7.3,.9,2.4).join(' ')+'" stroke="#e3bd2c" stroke-width="2.2"/>';
 // the backup store: a green shipping container with ribs
 s+=shadow(P,10.6,6.2,4.8,2.2)+box(P,10.6,6.2,0,4.8,2.2,2.3,['#4f8a62','#3f7552','#2f5d42']);let rib='';for(let a=10.9;a<15.3;a+=.45)rib+='M'+P(a,8.4,.15).join(' ')+'L'+P(a,8.4,2.15).join(' ');s+='<path d="'+rib+'" stroke="#2c5a3d" stroke-width="1.1" opacity=".8"/>'+onR(P,15.4,6.5,8.1,.2,2.1,'#356b4b',glass)+'<path d="M'+P(15.4,7.3,.3).join(' ')+'L'+P(15.4,7.3,2).join(' ')+'" stroke="#e3bd2c" stroke-width="1.6"/>';
 for(const [x,y] of [[11.4,1.4],[13.4,1.4]])s+=put(P,'spr-stillage',x+.8,y+1,62,41,...ST);s+=put(P,'spr-stillage',12.2,2.2,62,41,.5,1.22);
 // the team out front
 s+=put(P,'spr-worker-busy',4.2,6.6,26,48,...WK)+put(P,'spr-worker',5.6,6.9,26,48,...WK)+put(P,'spr-worker',7,6.5,26,48,...WK)+put(P,'spr-worker',2.8,7.4,25,46,...WK);
 s+=put(P,'spr-forklift',9,10.2,84,67,...FL)+put(P,'spr-tree',17.4,11.4,58,69,...TREE)+put(P,'spr-tree',-1.4,11.2,54,64,...TREE);
 return acctArt='<svg class="acct-diorama" viewBox="0 0 580 300" aria-hidden="true" focusable="false">'+s+'</svg>';}
// Small symbols for the Account counters and card badges: the office cabin and the backup container.
function acctSheet(){if(typeof document==='undefined'||document.getElementById('acct-sprite-sheet'))return;const C=isoAt(40,14,5.6),B=isoAt(40,10,5.2);
 let rib='';for(let a=.4;a<6.6;a+=.6)rib+='M'+B(a,3,.15).join(' ')+'L'+B(a,3,2.6).join(' ');
 const L=isoAt(20,26,4.4),R=isoAt(52,20,4.4),swap='<path d="M30 12q10-8 20-2" fill="none" stroke="#2f6b47" stroke-width="2.6" stroke-linecap="round"/><path d="M47 5.5l4.6 5-6.4 1.6" fill="none" stroke="#2f6b47" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
 const log='<rect x="14" y="10" width="36" height="48" rx="5" fill="#f4efdf" stroke="#23392c" stroke-width="2"/><rect x="24" y="6" width="16" height="9" rx="3" fill="#4e6b58" stroke="#23392c" stroke-width="1.6"/><path d="M21 24h22M21 32h22M21 40h13" stroke="#9aa6a0" stroke-width="3" stroke-linecap="round"/><circle cx="48" cy="48" r="13" fill="#d9f56b" stroke="#23392c" stroke-width="2"/><path d="M48 41v7.5l5 3" fill="none" stroke="#23392c" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
 const key='<circle cx="30" cy="30" r="11" fill="#e3bd2c" stroke="#6f5a12" stroke-width="3"/><circle cx="30" cy="30" r="4" fill="#6f5a12"/><path d="M39 36l20 20M50 47l6-6M56 53l5-5" stroke="#6f5a12" stroke-width="5" stroke-linecap="round"/>';
 document.body.insertAdjacentHTML('beforeend','<svg id="acct-sprite-sheet" class="sprite-sheet" width="0" height="0" aria-hidden="true" focusable="false"><defs><symbol id="ac-cabin" viewBox="0 0 80 60">'+cabin(C,0,0,0,6.2,3,3,{})+'</symbol><symbol id="ac-archive" viewBox="0 0 80 60">'+shadow(B,0,0,7,3)+box(B,0,0,0,7,3,2.8,['#4f8a62','#3f7552','#2f5d42'])+'<path d="'+rib+'" stroke="#2c5a3d" stroke-width="1"/>'+onR(B,7,.4,2.6,.25,2.5,'#356b4b',glass)+'<circle cx="62" cy="22" r="8.5" fill="#d9f56b" stroke="#23392c" stroke-width="1.4"/><path d="M58 22.5l3 3 5-6" fill="none" stroke="#23392c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol><symbol id="ac-key" viewBox="0 0 70 70">'+key+'</symbol><symbol id="ac-log" viewBox="0 0 70 70">'+log+'</symbol><symbol id="ac-switch" viewBox="0 0 80 60">'+cabin(L,0,0,0,4,2.2,2.4,{})+cabin(R,0,0,0,4,2.2,2.4,{})+swap+'</symbol></defs></svg>');}
const icon=id=>id.startsWith('si-')?siImg(id):id.startsWith('spr-')?sprite(id):'<svg class="sprite" aria-hidden="true" focusable="false"><use href="#'+id+'"/></svg>';

function auth(register=true){
  mountSprites();
  const feats=[['spr-stillage','Every stillage on the plan','Stock by piece, stillage, site and truck.'],['spr-truck12','Loads planned and dispatched','Yard lists, trucks and delivery dockets.'],['spr-worker','Crew and forklifts at work','Jobs, priorities and who is doing what.']];
  app.innerHTML=`<section class="auth auth-split${register?' is-register':' is-login'}"><aside class="auth-hero"><div class="auth-art">${authScene()}</div><div class="auth-pitch"><div class="auth-brand">Scaffold Yard</div><h2>Your whole yard, live on one screen.</h2><ul class="auth-feats">${feats.map(([id,t,s])=>`<li><span class="auth-feat-art">${sprite(id)}</span><span><b>${t}</b><small>${s}</small></span></li>`).join('')}</ul></div><div class="auth-sim"><span class="status-dot"></span> SIMULATION / DEMONSTRATION <span>Synthetic stock and server-controlled movements.</span></div></aside><div class="auth-main"><div class="eyebrow">A clear view of your company</div><h1>${register?'Let’s set up your yard.':'Welcome back.'}</h1><p class="auth-lead">${register?'Start with your company and the scaffold systems you use. You can change these later.':'Sign in to your company workspace.'}</p><form class="panel" id="auth">${register?`<div class="auth-pair">${field('companyName','Company name')+field('name','Your name')}</div>`:''}${field('email','Email','email')}${field('password','Password','password')}${register?`<p class="muted auth-hint">Use at least 12 characters for your password.</p><fieldset><legend>Which scaffold systems do you use?</legend>${checks(systems,[],'systems',true)}</fieldset>`:''}<div class="actions"><button>${register?'Create company':'Sign in'}</button><button type="button" class="secondary" id="toggle">${register?'I already have an account':'Create a company'}</button></div></form><p class="auth-foot"><span class="status-dot"></span>${register?'You become the owner. Add your team, sites and stock from inside.':'New to Scaffold Yard? Create a company and draw your yard in a minute.'}</p></div></section>`;
  if(!register){const input=app.querySelector('[name=password]');input.autocomplete='current-password';input.removeAttribute('minlength');}
  document.querySelector('#toggle').onclick=()=>auth(!register);
  bind('auth',async data=>{await api(register?'register':'login',data);await refresh();},['systems']);
}
function bind(id,handler,arrays=[]){document.getElementById(id).onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),data=Object.fromEntries(fd);arrays.forEach(key=>data[key]=fd.getAll(key));const button=form.querySelector('button');button.disabled=true;try{await handler(data);}catch(error){notify(error.message);}finally{button.disabled=false;}};}
async function refresh(){state=await api('me');await openOperations(app,api,notify,state,settingsHome);}

// ---------- Account ----------
const ago=iso=>{const s=(Date.now()-new Date(iso).getTime())/1000;if(!(s>=0))return 'just now';if(s<90)return 'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400*1.5)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' days ago';};
const stat=(id,art,label,value,sub)=>`<div class="hud-stat" role="listitem"${id?` id="${id}"`:''}><span class="hud-icon">${icon(art)}</span><span class="hud-text"><span class="hud-label">${label}</span><b class="hud-num">${value}</b><span class="hud-sub">${sub}</span></span></div>`;
const cardHead=(art,title,sub,extra='')=>`<div class="acct-head"><span class="acct-badge">${icon(art)}</span><div class="acct-head-text"><h2>${title}</h2>${sub?`<p>${sub}</p>`:''}</div>${extra}</div>`;
const myRoles=()=>{const r=Array.isArray(state.roles)&&state.roles.length?state.roles:state.permissions.includes('company.manage')?['OWNER']:state.permissions.includes('operations.manage')?['GENERAL_MANAGER']:['SUPERVISOR'];return ROLE_ORDER.filter(x=>r.includes(x));};
const ACCESS=[['company.manage','Change the company name and scaffold systems'],['users.manage','Add team members and company memberships'],['operations.manage','Run the yard, trucks, stock, crew and sites'],['sites.assigned','See the sites assigned to you'],['requests.create','Order material for sites'],['finance.view','See financial figures']];
function settingsHome(){
  mountSprites();siMount();acctSheet();
  const owner=state.permissions.includes('company.manage'),team=state.permissions.includes('users.manage'),ops=state.permissions.includes('operations.manage'),roles=myRoles();
  const on=state.systems.filter(x=>x.enabled),users=state.users??[];
  const count=r=>users.filter(u=>String(u.roles??'').split(',').includes(r)).length;
  // Team counter sub-line: the counts by role; a phone shows just the role words (two short lines).
  const held=ROLE_ORDER.map(r=>[r,count(r)]).filter(([,n])=>n),teamSub=users.length&&held.length?'<span class="sub-long">'+held.map(([r,n])=>n+' '+ROLE_COUNT[r]+(n===1?'':'s')).join(' &middot; ')+'</span><span class="sub-short">'+held.map(([r,n])=>ROLE_COUNT[r]+(n===1?'':'s')).join(', ').replace(/^./,c=>c.toUpperCase())+'</span>':users.length?'Your company':'Just you so far';
  const hud=(owner?stat('','spr-worker','Team',users.length,teamSub):stat('acct-stat-orders','spr-truck12','Open orders','…','Counting orders'))
   +stat('','spr-bundle','Systems',`${on.length}<small>/ ${state.systems.length}</small>`,on.length?on.map(x=>escape(x.name)).join(' &middot; '):'None enabled')
   +stat('acct-stat-sites','si-site',state.permissions.includes('operations.manage')?'Client sites':'Your sites','…','Counting sites')
   +(owner?stat('acct-stat-backup','ac-archive','Last backup','…','Checking backups'):stat('','ac-switch','Workspaces',state.memberships.length,state.memberships.length>1?'Switch below':'This company'));
  const hero=`<section class="acct-hero" aria-label="Account"><div class="acct-hero-art">${accountScene()}</div><div class="acct-hero-top"><div class="eyebrow">SCAFFOLD / ACCOUNT &middot; ${escape(state.company.name)}</div><h1>${escape(state.company.name)}</h1><p class="acct-hero-sub">Welcome, ${escape(state.user.name)}. ${owner?'Company settings, your team, the catalogue and backups.':'Your company workspace and what you can do in it.'}</p><p class="acct-hero-who">Signed in as <b>${escape(state.user.email??state.user.name)}</b></p><div class="acct-hero-actions"><button id="back-yard" class="secondary">← Open yard</button><span class="acct-you">${rolePills(roles)}</span><button type="button" class="secondary acct-signout" id="logout">Sign out</button></div></div><div class="hud-stats acct-hud" role="list" aria-label="Account at a glance">${hud}</div></section>`;
  const company=`<section class="panel acct-card acct-company">${cardHead('ac-cabin','Company &amp; systems',owner?'Your company name and the scaffold systems you stock. Turning a system off preserves its records.':'The scaffold systems your company works with.')}${owner?`<form id="company">${field('name','Company name','text',state.company.name)}<fieldset><legend>Systems used by your company</legend>${checks(state.systems,on.map(x=>x.id),'systems',true)}</fieldset><div class="actions"><button>Save company settings</button></div></form>`:`<div class="sys-chips">${on.map(x=>`<span class="sys-chip"><span class="sys-badge" aria-hidden="true">${escape(badge(x))}</span>${escape(x.name)}</span>`).join('')||'<span class="muted">No systems enabled yet.</span>'}</div><p class="acct-note">Only an owner can change the company’s systems.</p>`}</section>`;
  const members=team?`<section class="panel acct-card acct-team">${cardHead('spr-worker','Your team',users.length===1?'1 person can sign in to this company.':users.length+' people can sign in to this company.',`<span class="acct-count">${users.length}</span>`)}<ul class="team-list">${users.map(u=>{const r=ROLE_ORDER.filter(x=>String(u.roles??'').split(',').includes(x));return `<li class="team-row ${ROLE_CLASS[r[0]]??''}"><span class="team-av">${sprite(r[0]==='OWNER'?'spr-worker-busy':'spr-worker')}</span><span class="team-id"><strong>${escape(u.name)}${u.id===state.user.id?' <span class="you-tag">You</span>':''}</strong><small>${escape(u.email)}</small></span><span class="team-roles">${rolePills(r)}</span></li>`;}).join('')}</ul><details class="acct-fold"><summary><span class="fold-title">Add a team member</span><small>A new sign-in with its own password</small></summary><form id="member" class="acct-form">${`<div class="auth-pair">${field('name','Name')+field('email','Email','email')}</div>`}${field('password','Initial password','password')}<fieldset><legend>Roles (choose one or more)</legend>${checks(ROLES,[],'roles')}</fieldset><div class="actions"><button>Add team member</button></div></form></details></section>`:'';
  const membership=owner?`<section class="panel acct-card acct-membership">${cardHead('ac-key','Add an existing account','Someone who already signs in to another company can join this one too.')}<details class="acct-fold"><summary><span class="fold-title">Add an existing account to this company</span><small>Give them one or more roles here</small></summary><form id="membership" class="acct-form">${field('email','Existing account email','email')}<fieldset><legend>Company roles</legend>${checks(ROLES,[],'roles')}</fieldset><div class="actions"><button>Add membership</button></div></form></details></section>`:'';
  const switcher=state.memberships.length>1?`<section class="panel acct-card acct-switch">${cardHead('ac-switch','Company workspaces','You belong to '+state.memberships.length+' companies. Switch to open another one.')}<form id="switch-company"><label>Company workspace<select name="companyId">${state.memberships.map(c=>`<option value="${escape(c.id)}" ${c.id===state.company.id?'selected':''}>${escape(c.name)}</option>`).join('')}</select></label><div class="actions"><button>Switch company</button></div></form></section>`:'';
  const catalogue=owner?`<section class="panel acct-card acct-catalogue">${cardHead('spr-bundle','Catalogue','Your components, weights and pack sizes.')}${ops?`<div class="acct-pointer"><span class="acct-pointer-art">${sprite('spr-stillage')}</span><div><strong>Import your supplier’s list on the Materials list</strong><p>Paste or upload a spreadsheet with Import materials, then fix any missing weights and pack sizes there.</p></div><button type="button" class="secondary" id="acct-materials">Open the Materials list</button></div>`:''}<div class="acct-cat-admin">${catalogueSettings()}</div></section>`:'';
  const backups=owner?`<section class="panel acct-card" id="backups">${cardHead('ac-archive','Backups','Loading backup details…')}</section>`:'';
  const activity=owner?`<section class="panel acct-card acct-activity">${cardHead('ac-log','Recent activity','Company changes, newest first.')}<ul class="activity-list">${state.audit.map(a=>`<li><span>${escape({'company.created':'Company created','company.updated':'Company settings saved','user.created':'Team member added','membership.created':'Company membership added'}[a.action]??a.action)}</span><time>${escape(new Date(a.created_at).toLocaleString())}</time></li>`).join('')||'<li><span class="muted">Nothing yet.</span></li>'}</ul></section>`:'';
  const access=owner?'':`<section class="panel acct-card acct-access">${cardHead('ac-key','What you can do here',escape(roles.map(r=>ROLE_NAME[r]).join(' · ')))}<ul class="access-list">${ACCESS.filter(([p])=>state.permissions.includes(p)).map(([,t])=>`<li>${t}</li>`).join('')}</ul><p class="acct-note">${ops?'Company settings, the team and backups are looked after by an owner.':'The office runs the yard; ask them for access to more sites.'}</p></section>`;
  const left=owner?company+members+membership+activity:company+switcher,right=owner?backups+catalogue+switcher:access;
  app.innerHTML=`<div class="acct${owner?' is-owner':''}">${hero}<div class="acct-grid"><div class="acct-col">${left}</div><div class="acct-col">${right}</div></div></div>`;
  bindCatalogue();
  if(owner)backupsPanel();
  opsCounts(!owner);
  if(state.memberships.length>1)bind('switch-company',async data=>{await api('switch-company',data);await refresh();});
  if(owner)bind('membership',async data=>{await api('memberships',data);await refresh();notify('Company membership added.');},['roles']);
  document.querySelector('#back-yard').onclick=()=>refresh();
  const mat=document.querySelector('#acct-materials');if(mat)mat.onclick=async()=>{try{await refresh();const b=document.querySelector('.nav-button[data-view="MATERIALS"]');if(b){b.click();requestAnimationFrame(()=>document.getElementById('mi-import')?.scrollIntoView({block:'start'}));}}catch(error){notify(error.message);}};
  document.querySelector('#logout').onclick=async()=>{try{stopOperations();await api('logout',{});state=null;auth(false);notify('Signed out.');}catch(error){notify(error.message);}};
  if(owner)bind('company',async data=>{await api('company',data);await refresh();notify('Company settings saved.');},['systems']);
  if(team)bind('member',async data=>{await api('users',data);await refresh();notify('Team member added.');},['roles']);
}
const setStat=(id,value,sub)=>{const el=document.getElementById(id);if(!el)return;el.querySelector('.hud-num').innerHTML=value;el.querySelector('.hud-sub').innerHTML=sub;};
// The sites (and, for managers and supervisors, open orders) counters come from the lean operations snapshot (a supervisor sees only the sites assigned to them).
const CLOSED=new Set(['DELIVERED','COMPLETE','CANCELLED']);
async function opsCounts(orders){try{const s=await api('state?page=0'),sites=s.sites??[],active=sites.filter(x=>x.status==='ACTIVE').length;setStat('acct-stat-sites',String(active),!sites.length?'No sites yet':active===sites.length?(active===1?'Active':'All active'):(sites.length-active)+' archived');
  if(orders){const open=(s.requests??[]).filter(r=>!CLOSED.has(r.status)),waiting=open.filter(r=>r.status==='REQUESTED').length;setStat('acct-stat-orders',String(open.length),!open.length?'Nothing on order':waiting?waiting+' waiting for the yard':'All being handled');}}
 catch{setStat('acct-stat-sites','&ndash;','Not available');setStat('acct-stat-orders','&ndash;','Not available');}}
// Owner-only: where the live database is, the automatic backups, "Back up now" and how to restore by hand (there is no restore button on purpose).
async function backupsPanel(){
  const box=()=>document.getElementById('backups');let b;try{b=await api('backups');}catch(error){box()?.remove();setStat('acct-stat-backup','&ndash;','Not set up on this server');return;}if(!box())return;
  const file=escape(b.databasePath.split(/[\\/]/).pop()),when=b.lastBackup?`${escape(new Date(b.lastBackup.at).toLocaleString())}${b.lastBackup.manual?' (made with “Back up now”)':''}`:'No backup yet — the first one runs within a minute of the server starting.';
  setStat('acct-stat-backup',b.lastBackup?escape(ago(b.lastBackup.at)):'None yet',(b.daily+b.manual)+' kept'+(b.lastError?' &middot; last attempt failed':''));
  if(b.lastError)document.getElementById('acct-stat-backup')?.classList.add('alert');
  box().innerHTML=`${cardHead('ac-archive','Backups','A copy of your whole database, made by the server every day.',`<span class="acct-status${b.lastError?' bad':b.lastBackup?'':' none'}">${b.lastError?'Needs attention':b.lastBackup?'Protected':'Waiting'}</span>`)}<dl class="backup-facts"><div class="bf-last"><dt>Last backup</dt><dd>${when}</dd></div><div><dt>Backups kept</dt><dd>${b.daily} daily/weekly${b.manual?` · ${b.manual} made with “Back up now”`:''}</dd></div><div class="bf-path"><dt>Live database</dt><dd><code>${escape(b.databasePath)}</code></dd></div><div class="bf-path"><dt>Backup folder</dt><dd><code>${escape(b.directory)}</code></dd></div></dl><p class="backup-policy">The server makes a copy every day, and when it starts if the last copy is more than a day old. ${escape(b.policy)}</p>${b.lastError?`<p class="notice">The last backup attempt failed: ${escape(b.lastError)}</p>`:''}<div class="actions"><button type="button" id="backup-now"${b.running?' disabled':''}>Back up now</button></div><div class="backup-restore"><h3>How to restore a backup</h3><ol class="backup-steps"><li>Stop the server: close the “Scaffold Yard server” window (or press Ctrl+C where it runs).</li><li>In the live database folder, move <code>${file}</code> (and any <code>${file}-wal</code> and <code>${file}-shm</code> files next to it) into a spare folder. Keep them until you are sure.</li><li>Copy the backup you want from the backup folder into the live database folder and rename the copy to <code>${file}</code>.</li><li>Start Scaffold Yard again and check your stock.</li></ol></div>`;
  document.getElementById('backup-now').onclick=async event=>{const button=event.currentTarget;button.disabled=true;button.textContent='Backing up…';try{await api('backup-now',{});notify('Backup saved.');}catch(error){notify(error.message);}await backupsPanel();};
}
try{systems=await api('systems');await refresh();}catch(error){if(error.status===401)auth();else{app.textContent='Unable to load your workspace.';notify(error.message);}}
