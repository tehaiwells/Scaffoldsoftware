// Pictures for the game board (public/game.js): the inventory item pictures (Factorio-style little items, one per kind of component, drawn a little
// longer or shorter with the component's length so a 0.7 m ledger and a 3 m ledger look different), the category tab pictures, and the pictures on
// the big buttons. Each picture is one small SVG document behind a blob URL (the CSP allows img-src blob:), made once and shared by every slot,
// so a grid of hundreds of slots is hundreds of <img> tags pointing at a few dozen pictures. Pure string builders: they run in Node tests too.
import {componentIcon,ovImg,sgSheet,siSheet,hcSheet,hrSheet} from './art.js';
const f=n=>+n.toFixed(1);
const C={ol:'#23302f',steel:'#c6d0d4',hi:'#f5f9fa',shade:'#8a979d',orange:'#f08a24',oranged:'#a3550f',yellow:'#f2c230',yellowd:'#9b7a12',blue:'#3f86c9',blued:'#1f4d7a',red:'#d9493b',redd:'#7e2219',timber:'#c98d52',timberd:'#7a4a22',timberh:'#e7b27a',alu:'#e3e9ec',dark:'#4a5559',lime:'#b9ef4b'};
// A tube from a to b: an outline, the body and a highlight, with round ends.
const tube=(x1,y1,x2,y2,w=5.2,body=C.steel)=>'<path d="M'+f(x1)+' '+f(y1)+'L'+f(x2)+' '+f(y2)+'" stroke="'+C.ol+'" stroke-width="'+f(w+2)+'" stroke-linecap="round"/><path d="M'+f(x1)+' '+f(y1)+'L'+f(x2)+' '+f(y2)+'" stroke="'+body+'" stroke-width="'+f(w)+'" stroke-linecap="round"/><path d="M'+f(x1)+' '+f(y1-w*.22)+'L'+f(x2)+' '+f(y2-w*.22)+'" stroke="'+C.hi+'" stroke-width="'+f(w*.3)+'" stroke-linecap="round" opacity=".9"/>';
const poly=(pts,fill,stroke=C.ol,sw=1.2)=>'<path d="M'+pts.map(p=>f(p[0])+' '+f(p[1])).join('L')+'Z" fill="'+fill+'" stroke="'+stroke+'" stroke-width="'+sw+'" stroke-linejoin="round"/>';
const shadow=(cx,cy,rx,ry=rx*.28)=>'<ellipse cx="'+f(cx)+'" cy="'+f(cy)+'" rx="'+f(rx)+'" ry="'+f(ry)+'" fill="#000" opacity=".28"/>';
// along a diagonal (up to the right) centred on (24,26): the ends of a bar s long at angle a (degrees up from the horizontal)
const ends=(s,a=28,cx=24,cy=26)=>{const t=a*Math.PI/180,dx=Math.cos(t)*s/2,dy=Math.sin(t)*s/2;return [cx-dx,cy+dy,cx+dx,cy-dy];};
const ART={
 tube:L=>{const [x1,y1,x2,y2]=ends(26+16*L);return shadow(24,34,13+5*L)+tube(x1,y1,x2,y2,8)+'<ellipse cx="'+f(x1)+'" cy="'+f(y1)+'" rx="3" ry="4.1" transform="rotate(-28 '+f(x1)+' '+f(y1)+')" fill="#55636a" stroke="'+C.ol+'" stroke-width="1.2"/>';},
 standard:L=>{const h=26+14*L,y0=25+h/2,y1=25-h/2;let s=shadow(24,y0+2,8)+tube(24,y0,24,y1+4,7)+tube(24,y1+4,24,y1,4.4,C.shade);for(let y=y0-5;y>y1+6;y-=Math.max(6,(h-10)/4))s+=poly([[17.5,y-2.8],[30.5,y-2.8],[28.5,y+1.8],[19.5,y+1.8]],C.yellow,C.yellowd,1.2);return s;},
 ledger:L=>{const [x1,y1,x2,y2]=ends(24+16*L,26);return shadow(24,33,12+6*L)+tube(x1,y1,x2,y2,6)+poly([[x1-4,y1-5],[x1+2.5,y1-7],[x1+2.5,y1+4],[x1-4,y1+6]],C.orange,C.oranged)+poly([[x2-2.5,y2-6],[x2+4,y2-8],[x2+4,y2+3],[x2-2.5,y2+5]],C.orange,C.oranged);},
 transom:L=>{const [x1,y1,x2,y2]=ends(24+14*L,26);return shadow(24,35,12+6*L)+tube(x1,y1+8,x1,y1,4.4,C.blue)+tube(x2,y2+8,x2,y2,4.4,C.blue)+tube(x1,y1,x2,y2,6)+poly([[x1-3.4,y1-4],[x1+3.4,y1-5.4],[x1+3.4,y1+2.6],[x1-3.4,y1+4]],C.blue,C.blued)+poly([[x2-3.4,y2-4],[x2+3.4,y2-5.4],[x2+3.4,y2+2.6],[x2-3.4,y2+4]],C.blue,C.blued);},
 brace:L=>{const [x1,y1,x2,y2]=ends(28+12*L,56);return shadow(24,41,10)+tube(x1,y1,x2,y2,5.6)+'<circle cx="'+f(x1)+'" cy="'+f(y1)+'" r="4.4" fill="'+C.red+'" stroke="'+C.redd+'" stroke-width="1.4"/><circle cx="'+f(x2)+'" cy="'+f(y2)+'" r="4.4" fill="'+C.red+'" stroke="'+C.redd+'" stroke-width="1.4"/>';},
 rail:L=>{const [x1,y1,x2,y2]=ends(26+14*L,26);return shadow(24,37,13)+tube(x1,y1+7,x2,y2+7,5)+tube(x1,y1-3,x2,y2-3,5)+tube(x1,y1-3,x1,y1+7,4,C.yellow)+tube(x2,y2-3,x2,y2+7,4,C.yellow);},
 plank:L=>{const s=26+14*L,[x1,y1,x2,y2]=ends(s,26);const w=10,top=[[x1-2,y1-w/2],[x2-2,y2-w/2],[x2+3,y2+w/2-1],[x1+3,y1+w/2-1]];let d=shadow(25,36,13+6*L)+poly(top.map(p=>[p[0],p[1]+3.4]),C.shade)+poly(top,'#d3dadd');for(let k=.12;k<.92;k+=.13){const x=x1+(x2-x1)*k,y=y1+(y2-y1)*k;d+='<circle cx="'+f(x-.6)+'" cy="'+f(y-1.6)+'" r="1.1" fill="#6f7d83"/><circle cx="'+f(x+1.6)+'" cy="'+f(y+1)+'" r="1.1" fill="#6f7d83"/>';}return d+'<path d="M'+f(top[0][0])+' '+f(top[0][1])+'L'+f(top[1][0])+' '+f(top[1][1])+'" stroke="'+C.hi+'" stroke-width="1.2"/>';},
 board:L=>{const s=26+14*L,[x1,y1,x2,y2]=ends(s,26);const top=[[x1-3,y1-4],[x2-3,y2-4],[x2+3,y2+2],[x1+3,y1+2]];return shadow(25,36,13+6*L)+poly(top.map(p=>[p[0],p[1]+4]),C.timberd)+poly(top,C.timber)+'<path d="M'+f(x1+1)+' '+f(y1-1.6)+'L'+f(x2-4)+' '+f(y2-.8)+'M'+f(x1+4)+' '+f(y1+.2)+'L'+f(x2-7)+' '+f(y2+.9)+'" stroke="'+C.timberh+'" stroke-width="1" opacity=".9"/><path d="M'+f(x2-4)+' '+f(y2-3)+'L'+f(x2+2)+' '+f(y2+1.4)+'" stroke="'+C.ol+'" stroke-width="2.4" opacity=".45"/>';},
 toeboard:L=>{const [x1,y1,x2,y2]=ends(26+14*L,26);return shadow(25,38,14)+poly([[x1,y1-7],[x2,y2-7],[x2,y2+5],[x1,y1+5]],C.timber,C.timberd,1.4)+poly([[x2-5,y2-4.6],[x2,y2-7],[x2,y2+5],[x2-5,y2+7.4]],C.yellow,C.yellowd,1.2)+'<path d="M'+f(x1+1)+' '+f(y1-1.4)+'L'+f(x2-6)+' '+f(y2-1.4)+'" stroke="'+C.timberh+'" stroke-width="1.1"/>';},
 coupler:()=>shadow(24,40,15)+'<rect x="5" y="14" width="18" height="22" rx="6" fill="'+C.yellow+'" stroke="'+C.yellowd+'" stroke-width="1.6"/><rect x="25" y="11" width="18" height="22" rx="6" fill="#dfe6e9" stroke="'+C.ol+'" stroke-width="1.6"/><circle cx="14" cy="25" r="5" fill="#5b676d"/><circle cx="34" cy="22" r="5" fill="#5b676d"/>'+tube(14,14,14,5,3.4,C.dark)+tube(34,11,34,3,3.4,C.dark)+'<path d="M8 18h11" stroke="#fff3c4" stroke-width="1.4" opacity=".8"/>',
 plate:()=>shadow(24,38,18)+poly([[4,31],[24,22],[44,31],[24,40]],'#6d7a80')+poly([[4,31],[24,40],[24,43],[4,34]],'#4c575c')+poly([[24,40],[44,31],[44,34],[24,43]],'#3b4448')+tube(24,31,24,6,6.4),
 jack:()=>shadow(24,41,13)+poly([[9,35],[24,29],[39,35],[24,41]],'#6d7a80')+'<path d="M24 34V4" stroke="'+C.ol+'" stroke-width="7" stroke-linecap="round"/><path d="M24 34V4" stroke="#8c979c" stroke-width="5"/><path d="M21 8h6M21 11.5h6M21 15h6M21 18.5h6M21 26h6M21 29.5h6" stroke="'+C.ol+'" stroke-width="1.1"/>'+poly([[12,24],[36,24],[32,19],[16,19]],C.orange,C.oranged,1.4),
 stairs:L=>{let s=shadow(24,42,16)+tube(6,40,38,8,4,C.alu)+tube(11,43,43,11,4,C.alu);for(let k=0;k<5;k++){const x=10+k*7,y=37-k*7;s+=poly([[x-4,y],[x+3,y-1.6],[x+7,y+1.4],[x,y+3]],C.dark,C.ol,.9);}return s;},
 ladder:L=>{const h=30+10*L,y0=25+h/2,y1=25-h/2;let s=shadow(24,y0+2,12)+tube(14,y0,15,y1,4.2,C.alu)+tube(33,y0,34,y1,4.2,C.alu);for(let y=y0-5;y>y1+2;y-=6.5)s+=tube(14.6,y,33.4,y,3,C.alu);return s;},
 beam:L=>{const [x1,y1,x2,y2]=ends(28+12*L,26);let s=shadow(24,39,15)+tube(x1,y1+6,x2,y2+6,4,C.alu)+tube(x1,y1-7,x2,y2-7,4,C.alu),n=6;for(let k=0;k<n;k++){const a=k/n,b=(k+.5)/n,c=(k+1)/n,P=u=>[x1+(x2-x1)*u,y1+(y2-y1)*u];const [ax,ay]=P(a),[bx,by]=P(b),[cx,cy]=P(c);s+='<path d="M'+f(ax)+' '+f(ay+6)+'L'+f(bx)+' '+f(by-7)+'L'+f(cx)+' '+f(cy+6)+'" stroke="#8d9aa0" stroke-width="2.2" fill="none"/>';}return s;},
 bracket:()=>shadow(24,42,13)+tube(12,42,12,6,5.4)+tube(12,9,40,9,5.4)+tube(12,36,38,10,4,C.orange),
 small:()=>shadow(24,40,14)+poly([[8,12],[21,7],[19,37],[12,40]],C.orange,C.oranged,1.4)+tube(27,37,38,10,4.6,C.steel)+'<circle cx="38" cy="10" r="4.4" fill="none" stroke="'+C.ol+'" stroke-width="2.4"/>',
 wheel:()=>shadow(24,44,13)+'<path d="M13 5h22v5H13Z" fill="'+C.steel+'" stroke="'+C.ol+'" stroke-width="1.4"/>'+tube(18,10,20,24,3.4)+tube(30,10,28,24,3.4)+'<circle cx="24" cy="30" r="12" fill="#2d3538" stroke="'+C.ol+'" stroke-width="1.6"/><circle cx="24" cy="30" r="5" fill="'+C.steel+'"/>',
 tool:()=>shadow(24,42,15)+tube(7,40,28,17,6,C.red)+'<circle cx="33" cy="12" r="8.5" fill="'+C.steel+'" stroke="'+C.ol+'" stroke-width="1.6"/><path d="M29.5 8.5l7 7" stroke="'+C.ol+'" stroke-width="3.6"/>',
 box:()=>shadow(24,42,17)+poly([[5,17],[24,9],[43,17],[24,25]],'#e3be83')+poly([[5,17],[24,25],[24,44],[5,36]],'#c99a5c')+poly([[24,25],[43,17],[43,36],[24,44]],'#b0824a')+'<path d="M14.5 13l19 8" stroke="#8a6232" stroke-width="2.4"/>'
};
// Which picture a component gets (the same reading of its name and category as the Materials list icons, plus boards vs steel decks).
export function gaKind(p){const n=((p?.category??'')+' '+(p?.name??'')).toLowerCase();
 if(/caster|castor|ginny wheel|gin wheel/.test(n))return 'wheel';if(/tie bar/.test(n))return 'ledger';if(/jack/.test(n))return 'jack';if(/sole ?board|mudsill|base plate|soleboard/.test(n))return 'plate';if(/stair/.test(n))return 'stairs';if(/ladder/.test(n))return 'ladder';
 if(/spanner|hammer|ratchet|\btools?\b|podger|level/.test(n))return 'tool';if(/coupler|clamp|fitting|swivel|sleeve|joiner|adapter|clip(?! ?on)/.test(n)&&!/toe/.test(n))return 'coupler';if(/hop ?up|bracket/.test(n))return 'bracket';
 if(/toe ?board/.test(n))return 'toeboard';if(/guardrail|handrail|top rail|\brail\b/.test(n))return 'rail';if(/timber|wood|scaffold board|\bboard\b/.test(n)&&!/sole|steel|alumin|metal|plank|deck/.test(n))return 'board';if(/plank|deck|panel|batten|platform/.test(n))return 'plank';
 if(/beam|girder|truss|lattice/.test(n))return 'beam';if(/brace/.test(n))return 'brace';if(/transom|putlog/.test(n))return 'transom';if(/ledger|horizontal/.test(n))return 'ledger';if(/standard|vertical|collar|spigot/.test(n))return 'standard';if(/tube|pipe/.test(n))return 'tube';
 if(/wedge|pin|clip|pressing|retainer|bolt|nut/.test(n))return 'small';return 'box';}
// Length in metres from the catalogue (length in mm) or the name ("3.0 m", "2400 mm", "10'", "7ft"); null when unknown.
export function gaLength(p){if(p?.length>0)return p.length/1000;const s=String(p?.name??'')+' '+String(p?.nominalSize??'');let m=s.match(/(\d+(?:\.\d+)?)\s*m(?![m\w])/i);if(m)return +m[1];m=s.match(/(\d{3,5})\s*mm/i);if(m)return +m[1]/1000;m=s.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet)/i);if(m)return +m[1]*.3048;return null;}
// 0..1 across the usual scaffold lengths (0.5 m .. 6.4 m); unknown lengths draw in the middle.
const lenScale=m=>m==null?.55:Math.max(0,Math.min(1,(m-.5)/5.9));
// Short length words for the slot's corner: 3m, 2.4m, 700 (mm under a metre).
export function gaLenTag(p){const m=gaLength(p);if(m==null||!['tube','standard','ledger','transom','brace','rail','plank','board','toeboard','beam','ladder'].includes(gaKind(p)))return '';return (Math.round(m*10)/10)+'m';}
const urls=new Map();
function svgURL(key,body,vb='2 2 44 44'){let u=urls.get(key);if(u)return u;const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+vb+'" fill="none">'+body+'</svg>';
 try{u=typeof Blob==='function'&&typeof URL?.createObjectURL==='function'?URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})):'';}catch{u='';}urls.set(key,u);return u;}
// The item picture of a component as an <img> (or, where there is no Blob, the Materials list's line icon).
export function gaItemURL(p){const kind=gaKind(p),L=lenScale(gaLength(p)),step=Math.round(L*4)/4;return svgURL('it-'+kind+'-'+step,(ART[kind]??ART.box)(step));}
export function gaItem(p,cls='gm-pic'){const u=gaItemURL(p);return u?'<img class="'+cls+'" src="'+u+'" alt="" draggable="false">':componentIcon(p);}
export const gaKindPic=(kind,L=.6,cls='gm-pic')=>{const u=svgURL('it-'+kind+'-'+L,(ART[kind]??ART.box)(L));return u?'<img class="'+cls+'" src="'+u+'" alt="" draggable="false">':'';};
// The inventory's category tabs: what each tab holds, its picture and name.
export const GA_TABS=[
 {id:'all',name:'All',pic:()=>gaImg(GA_BUTTONS.stock(),'gm-tab-pic gm-tab-all')},
 {id:'tubes',name:'Tubes',pic:()=>gaKindPic('tube',.8,'gm-tab-pic')},
 {id:'frame',name:'Frame',pic:()=>gaKindPic('ledger',.7,'gm-tab-pic')},
 {id:'boards',name:'Boards',pic:()=>gaKindPic('plank',.7,'gm-tab-pic')},
 {id:'fittings',name:'Fittings',pic:()=>gaKindPic('coupler',.5,'gm-tab-pic')},
 {id:'access',name:'Access',pic:()=>gaKindPic('ladder',.6,'gm-tab-pic')}];
const TAB_OF={tube:'tubes',standard:'frame',ledger:'frame',transom:'frame',brace:'frame',rail:'boards',plank:'boards',board:'boards',toeboard:'boards',coupler:'fittings',plate:'fittings',jack:'fittings',small:'fittings',tool:'fittings',wheel:'fittings',box:'fittings',bracket:'fittings',stairs:'access',ladder:'access',beam:'access'};
// Rows inside a tab, top to bottom (a new row starts for each).
export const GA_ROW_ORDER=['tube','standard','ledger','transom','brace','rail','plank','board','toeboard','coupler','small','plate','jack','bracket','wheel','tool','box','ladder','stairs','beam'];
export const gaTab=p=>TAB_OF[gaKind(p)]??'fittings';
// The big buttons' pictures and the office door, drawn at 0 0 96 72.
const truck=(flip=false)=>'<g'+(flip?' transform="translate(96 0) scale(-1 1)"':'')+'>'+shadow(46,60,34,5)+poly([[10,30],[58,30],[58,52],[10,52]],'#e7ecee')+poly([[10,30],[58,30],[58,34],[10,34]],'#cfd8dc')+poly([[58,36],[76,36],[84,46],[84,56],[58,56]],'#2f7d4f')+poly([[62,39],[74,39],[80,46],[62,46]],'#bfe3f2')+poly([[8,52],[86,52],[86,57],[8,57]],'#3a4548')+'<circle cx="22" cy="58" r="6" fill="#23302f"/><circle cx="22" cy="58" r="2.4" fill="#c6d0d4"/><circle cx="70" cy="58" r="6" fill="#23302f"/><circle cx="70" cy="58" r="2.4" fill="#c6d0d4"/>'+tube(14,44,54,40,4.2)+tube(14,38,54,34,4.2)+'</g>';
const arrow=(x,y,dir=1,col='#b9ef4b')=>'<g transform="translate('+x+' '+y+') scale('+dir+' 1)"><path d="M-12 -5h12v-7l13 12-13 12v-7h-12Z" fill="'+col+'" stroke="#1b3a2a" stroke-width="2" stroke-linejoin="round"/></g>';
export const GA_BUTTONS={
 send:()=>svgURL('btn-send',truck()+arrow(80,18),'0 0 96 72'),
 back:()=>svgURL('btn-back',truck(true)+arrow(18,18,-1,'#ffd25a'),'0 0 96 72'),
 add:()=>svgURL('btn-add',shadow(44,62,32,5)+poly([[14,34],[44,22],[74,34],[44,46]],'#d9e0e3')+poly([[14,34],[44,46],[44,62],[14,50]],'#aab6bb')+poly([[44,46],[74,34],[74,50],[44,62]],'#8f9ca2')+tube(20,34,46,23,3.4)+tube(24,37,50,26,3.4)+tube(28,40,54,29,3.4)+'<path d="M14 34v16M44 46v16M74 34v16" stroke="#2f7d4f" stroke-width="3"/><circle cx="76" cy="18" r="13" fill="#b9ef4b" stroke="#1b3a2a" stroke-width="2.4"/><path d="M76 11v14M69 18h14" stroke="#1b3a2a" stroke-width="3.6" stroke-linecap="round"/>','0 0 96 72'),
 office:()=>svgURL('btn-office',poly([[14,30],[48,14],[82,30],[82,34],[14,34]],'#4e6b58')+poly([[18,34],[78,34],[78,64],[18,64]],'#f1ecdc')+poly([[40,44],[56,44],[56,64],[40,64]],'#2f5d45')+'<circle cx="52" cy="54" r="1.6" fill="#e3bd2c"/>'+poly([[24,40],[34,40],[34,50],[24,50]],'#6fa2c0',C.ol,1)+poly([[62,40],[72,40],[72,50],[62,50]],'#6fa2c0',C.ol,1),'0 0 96 72'),
 stock:()=>svgURL('btn-stock',shadow(48,62,32,5)+poly([[18,24],[48,12],[78,24],[48,36]],'#d9e0e3')+poly([[18,24],[48,36],[48,62],[18,50]],'#aab6bb')+poly([[48,36],[78,24],[78,50],[48,62]],'#8f9ca2')+tube(24,24,50,14,3.4)+tube(28,27,54,17,3.4)+tube(32,30,58,20,3.4),'0 0 96 72')};
export const gaImg=(url,cls='')=>url?'<img class="'+cls+'" src="'+url+'" alt="" draggable="false">':'';
// Any sprite of the app as a cached picture: spr-* and ov-site through ovImg, the page sheets' symbols (sg-yard, sg-list, si-site, si-crane, hc-board,
// hr-board, hr-tag) through their own sheets.
let symbols=null;
export function gaSprite(id,cls=''){if(id.startsWith('spr-')||id==='ov-site')return ovImg(id,cls);symbols??=new Map([...(sgSheet()+siSheet()+hcSheet()+hrSheet()).matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)].map(m=>[m[1],[m[2],m[3]]]));
 const d=symbols.get(id);if(!d)return '';return ovImg('gm-sym-'+id,cls,d[0],d[1]);}// with every main sprite in its defs (sg-yard stands the main sheet's stillages on its pad)
// The first-run yard size pictures: a fenced pad in the plan's colours, sized S / M / L, with a few of the plan's own stillages and a forklift on it.
export function gaYardPad(size,cls=''){const k={S:.62,M:.8,L:1}[size]??.8,W=150*k,D=100*k,ox=100,oy=24+(1-k)*40,P=(x,y)=>[f(ox+(x-y)*.866),f(oy+(x+y)*.5)];
 const pad=(a,b,c,d,fill)=>'<path d="M'+P(...a).join(' ')+'L'+P(...b).join(' ')+'L'+P(...c).join(' ')+'L'+P(...d).join(' ')+'Z" fill="'+fill+'"/>';
 let s='<ellipse cx="100" cy="'+f(oy+(W+D)*.5*.5+22)+'" rx="'+f(80*k+14)+'" ry="'+f(14*k+4)+'" fill="#000" opacity=".12"/>'+pad([-8,-8],[W+8,-8],[W+8,D+8],[-8,D+8],'#8fa866')+pad([0,0],[W,0],[W,D],[0,D],'#d8d1c1');
 const [a1,a2]=[P(0,D),P(W,D)],[b1]=[P(W,0)];s+='<path d="M'+a1.join(' ')+'L'+a2.join(' ')+'L'+b1.join(' ')+'" fill="none" stroke="#a79f8b" stroke-width="3"/>';
 s+='<path d="M'+P(0,D).join(' ')+'L'+P(0,0).join(' ')+'L'+P(W,0).join(' ')+'" fill="none" stroke="#9aa6a0" stroke-width="1.6"/><path d="M'+P(W*.62,D*.66).join(' ')+'L'+P(W*.92,D*.66).join(' ')+'L'+P(W*.92,D*.92).join(' ')+'L'+P(W*.62,D*.92).join(' ')+'Z" fill="none" stroke="#e3bd2c" stroke-width="1.6" stroke-dasharray="4 3"/>';
 const n={S:3,M:6,L:10}[size]??6,spots=[];for(let i=0;i<n;i++)spots.push([14+(i%4)*26*k*1.2,14+Math.floor(i/4)*26*k*1.1]);
 for(const [x,y] of spots){const [sx,sy]=P(x,y);s+='<use href="#spr-stillage" x="'+f(sx-17)+'" y="'+f(sy-16)+'" width="34" height="23"/>';}
 const [fx,fy]=P(W*.5,D*.6);s+='<use href="#spr-forklift-load" x="'+f(fx-18)+'" y="'+f(fy-26)+'" width="36" height="29"/>';
 return ovImg('gm-pad-'+size,cls,'0 0 200 150',s);}
