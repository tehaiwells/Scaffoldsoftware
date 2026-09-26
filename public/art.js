import {truckArt,forkliftSprite,workerFigure} from './visual.js';
export function icon(type){
 const paths={HOME:'M3 10 12 3 21 10M5 9v12h14V9M9 21v-8h6v8',YARD:'M3 4h18v16H3zM3 9h18M8 9v11M16 9v11',STOCK:'m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10',TRUCKS:'M2 6h12v12H2zM14 10h5l3 4v4h-8M5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4',SITES:'M4 21V3h12l-2 4 2 4H4M2 21h8',REQUESTS:'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',SETTINGS:'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',OVERVIEW:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',WORKERS:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',EQUIPMENT:'M3 20h18M5 20V9h6l3 5h5v6M8 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4M17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4M11 9V4h6',TRUCK12:'M2 6h12v12H2zM14 10h5l3 4v4h-8M5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4M5 10h6',TRUCK2:'M3 8h9v9H3zM12 11h4l2 3v3h-6M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4M15 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4',MATERIALS:'M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4zM8 4v16',ACCOUNT:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8'};
 return `<svg class="line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[type]??paths.STOCK}"/></svg>`;
}
// Card art in the same daylight style as the yard plan: galvanised stillage (status-green uprights, tubes inside) or yellow mesh cage, lit from the upper left.
function packShape(type){
 const cage=type==='CAGE',rim=cage?'#f0c230':'#98cc2e',h=80,A=[34,70],B=[166,99],C=[242,62],D=[110,33],dn=p=>[p[0],p[1]+h],at=(p,q,t,dy=0)=>[p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t+dy],pt=p=>p.map(n=>+n.toFixed(1)).join(' '),face=(ps,a)=>`<path d="M${ps.map(pt).join('L')}Z" ${a}/>`;
 let s=`<ellipse cx="150" cy="168" rx="122" ry="15" fill="#2a1d08" fill-opacity=".14"/><path d="M${pt(dn(A))}L${pt(dn(B))}L${pt(dn(C))}l22 8L${pt([dn(B)[0]+22,dn(B)[1]+9])}Z" fill="#2a1d08" fill-opacity=".1"/>`;
 s+=face([A,B,dn(B),dn(A)],cage?'fill="#f0c230" fill-opacity=".55"':'fill="#c7cfd2"')+face([B,C,dn(C),dn(B)],cage?'fill="#c99a1c" fill-opacity=".6"':'fill="#9aa5a9"');
 if(cage){let m='';for(let t=.1;t<.95;t+=.1)m+=`M${pt(at(A,B,t))}L${pt(at(A,B,t,h))}`;for(let t=.12;t<.95;t+=.14)m+=`M${pt(at(B,C,t))}L${pt(at(B,C,t,h))}`;for(const k of [.33,.66])m+=`M${pt(at(A,A,0,h*k))}L${pt(at(B,B,0,h*k))}L${pt(at(C,C,0,h*k))}`;s+=`<path d="${m}" stroke="#b38714" stroke-width="1.6" fill="none"/>`;}
 else s+=`<path d="M${pt(at(A,B,.18,h-12))}l22 5v8l-22-5zM${pt(at(A,B,.66,h-12))}l22 5v8l-22-5z" fill="#1d2422"/>`;
 s+=face([A,B,C,D],'fill="'+(cage?'#4a4230':'#2f3734')+'"');
 let g='',hi='',e='';for(let k=1;k<6;k++){const p=at(A,D,k/6.2),q=at(B,C,k/6.2);if(cage){g+=`M${pt(p)}L${pt(q)}`;continue;}g+=`M${pt([p[0]+3,p[1]+1])}L${pt([q[0]-3,q[1]-1])}`;hi+=`M${pt([p[0]+6,p[1]-1.5])}L${pt([q[0]-6,q[1]-3])}`;e+=`M${pt([p[0]+3,p[1]+1])}h.1M${pt([q[0]-3,q[1]-1])}h.1`;}
 s+=cage?`<path d="${g}${[.25,.5,.75].map(t=>`M${pt(at(A,B,t))}L${pt(at(D,C,t))}`).join('')}" stroke="#e9bb2c" stroke-width="1.8"/><path d="M92 70h.1M120 66h.1M140 80h.1M110 82h.1M160 70h.1M178 78h.1" stroke="#9aa3a7" stroke-width="9" stroke-linecap="round"/>`:`<path d="${g}" stroke="#cdd5d9" stroke-width="8.5" stroke-linecap="round"/><path d="${hi}" stroke="#fbfdfd" stroke-width="2.2"/><path d="${e}" stroke="#4a565c" stroke-width="5.5" stroke-linecap="round"/>`;
 s+=`<g fill="none" stroke="${rim}" stroke-linejoin="round" stroke-linecap="square"><path d="M${[A,B,C,D].map(pt).join('L')}Z" stroke-width="6"/><path d="M${pt(A)}L${pt(dn(A))}M${pt(B)}L${pt(dn(B))}M${pt(C)}L${pt(dn(C))}" stroke-width="7"/><path d="M${pt(at(A,A,0,h*.52))}L${pt(at(B,B,0,h*.52))}L${pt(at(C,C,0,h*.52))}M${pt(dn(A))}L${pt(dn(B))}L${pt(dn(C))}" stroke-width="${cage?5:4}" stroke="${cage?rim:'#7fae22'}"/></g>`;
 return s;
}
export const packArt=(type='STILLAGE')=>`<svg class="pack-art" viewBox="0 0 280 190" aria-hidden="true">${packShape(type)}</svg>`;
export const yardIllustration=()=>`<svg class="yard-illustration" viewBox="0 0 600 300" aria-hidden="true"><path d="m35 175 282-122 252 104-284 120z" fill="#c7d4b8"/><path d="m35 175 250 102 284-120v12L285 289 35 187" fill="#7d9675"/><g fill="none" stroke="#77937a" stroke-width="3"><path d="M35 175v-60L317-7M35 135 317 13M80 155V95M130 134V74M180 112V52M230 91V31"/></g><path d="m245 180 88-38 88 37-88 40z" fill="#eff2cf" opacity=".5"/><g transform="translate(65 75) scale(.8)">${packShape('STILLAGE')}</g><g transform="translate(225 10) scale(.72)">${packShape('CAGE')}</g><g transform="translate(355 93) scale(.7)">${packShape('STILLAGE')}</g></svg>`;

export function componentIcon(p){
 const n=((p.category??'')+' '+(p.name??'')).toLowerCase();
 const pick=/caster|castor/.test(n)?'wheel':/jack/.test(n)?'jack':/sole ?board|mudsill|base plate|soleboard/.test(n)?'plate':/stair/.test(n)?'stairs':/ladder/.test(n)?'ladder':/spanner|hammer|ratchet|tools/.test(n)?'tool':/coupler|clamp|fitting|swivel|sleeve|joiner|adapter/.test(n)?'coupler':/hop ?up|bracket/.test(n)?'bracket':/toe ?board/.test(n)?'toeboard':/guardrail|handrail|top rail|rail/.test(n)?'rail':/plank|board|deck|panel|batten/.test(n)?'plank':/beam|girder|truss/.test(n)?'beam':/brace/.test(n)?'brace':/transom|putlog/.test(n)?'transom':/ledger|horizontal/.test(n)?'ledger':/standard|vertical|collar|spigot/.test(n)?'standard':/tube|pipe/.test(n)?'tube':/cage|rack|stillage|insert/.test(n)?'box':/wedge|pin|clip|end|pressing|retainer/.test(n)?'small':'box';
 // Built once per kind (see ICONS below): a body path and an accent path, coloured by its ci-* class.
 return ICON_HTML[pick];
}
// ---- Home sprite sheet: the plan's own truck, forklift, worker and stillage art as <symbol>s (built once), referenced with <use>. ----
const S={dk:'#3d494e',st:'#c4ced2',hi:'#f6fafb',mid:'#8e9ba1',al:'#d9e0e3'};
const tube=(d,c=S.st,w=3.6)=>'<path d="'+d+'" stroke="'+S.dk+'" stroke-width="'+(w+2.2)+'"/><path d="'+d+'" stroke="'+c+'" stroke-width="'+w+'"/><path d="'+d+'" stroke="'+S.hi+'" stroke-width="'+(w*.32).toFixed(1)+'" transform="translate(-.5 -.7)"/>';
const ol='stroke="'+S.dk+'" stroke-width="1.3" stroke-linejoin="round"',wood='stroke="#7d5428" stroke-width="1.2" stroke-linejoin="round"';
const sym=(id,vb,body)=>'<symbol id="'+id+'" viewBox="'+vb+'">'+body+'</symbol>';
let sheet=null;
export function spriteSheet(){if(sheet)return sheet;const t12=truckArt({length:6000,width:2050}),t2=truckArt({length:4200,width:1900}),fl='-1500 -2540 3900 3120',wk='-420 -1640 1000 1840';
 const tree='<ellipse cx="650" cy="160" rx="1350" ry="480" fill="#2a1d08" fill-opacity=".2"/><path d="M0 60V-1400" stroke="#6b4a2b" stroke-width="230" stroke-linecap="round"/><circle cy="-2350" r="1250" fill="#557a35"/><circle cx="420" cy="-2000" r="820" fill="#4a6c2e"/><circle cx="-380" cy="-2700" r="760" fill="#79a146"/>';
 const bundle='<ellipse cx="30" cy="37" rx="27" ry="4.5" fill="#2a1d08" fill-opacity=".16"/>'+[[0,0],[7,-3.5],[3.5,-8],[10.5,-11.5],[14,-7]].map(([x,y])=>'<g transform="translate('+x+' '+y+')">'+tube('M6 33L40 16',S.st,6)+'<ellipse cx="6" cy="33" rx="2.6" ry="3.6" transform="rotate(-27 6 33)" fill="#5c686d" '+ol+'/></g>').join('');
 sheet='<svg class="sprite-sheet" width="0" height="0" aria-hidden="true" focusable="false"><defs>'+sym('spr-truck12',t12.viewBox,t12.svg)+sym('spr-truck2',t2.viewBox,t2.svg)+sym('spr-forklift',fl,forkliftSprite({}))+sym('spr-forklift-driven',fl,forkliftSprite({driver:true}))+sym('spr-forklift-load',fl,forkliftSprite({driver:true,load:{type:'STILLAGE',condition:'SERVICEABLE'}}))+sym('spr-worker',wk,workerFigure())+sym('spr-worker-busy',wk,workerFigure('#ff8a1e','#9a4a06'))+sym('spr-stillage','20 20 250 165',packShape('STILLAGE'))+sym('spr-cage','20 20 250 165',packShape('CAGE'))+sym('spr-tree','-1500 -3500 3600 4250',tree)+sym('spr-bundle','0 -2 60 44','<g fill="none" stroke-linecap="round">'+bundle+'</g>')+'</defs></svg>';return sheet;}
// The sheet lives once in <body>, outside the app root, so a page render never re-parses it.
export function mountSprites(){if(typeof document==='undefined'||document.getElementById('sprite-sheet'))return;document.body.insertAdjacentHTML('beforeend',spriteSheet().replace('<svg class="sprite-sheet"','<svg id="sprite-sheet" class="sprite-sheet"'));}
// One sprite from the sheet; the box keeps the drawing's aspect ratio.
export const sprite=(id,cls='')=>'<svg class="sprite'+(cls?' '+cls:'')+'" aria-hidden="true"><use href="#'+id+'"/></svg>';
// ---- Stockpile slot icons: two-tone (a body path, an accent path), one tile = one <svg> + two <path>s, so 580 slots stay as light as the old line icons. Colours come from the ci-* class (design.css). ----
const f1=n=>+n.toFixed(1);
// A tube from (x1,y1) to (x2,y2), w wide, with round ends, as a closed outline.
const T=(x1,y1,x2,y2,w)=>{const l=Math.hypot(x2-x1,y2-y1)||1,r=w/2,nx=-(y2-y1)/l*r,ny=(x2-x1)/l*r;return 'M'+f1(x1+nx)+' '+f1(y1+ny)+'L'+f1(x2+nx)+' '+f1(y2+ny)+'A'+r+' '+r+' 0 0 0 '+f1(x2-nx)+' '+f1(y2-ny)+'L'+f1(x1-nx)+' '+f1(y1-ny)+'A'+r+' '+r+' 0 0 0 '+f1(x1+nx)+' '+f1(y1+ny)+'Z';};
const E=(cx,cy,rx,ry)=>'M'+f1(cx-rx)+' '+cy+'a'+rx+' '+ry+' 0 1 0 '+f1(2*rx)+' 0a'+rx+' '+ry+' 0 1 0 '+f1(-2*rx)+' 0Z';
const Q=(...p)=>'M'+p.map(f1).join(' ').replace(/^(\S+ \S+) /,'$1L')+'Z';
// A rotated box centred on (cx,cy): w along the angle a (degrees), h across.
const B=(cx,cy,w,h,a)=>{const t=a*Math.PI/180,c=Math.cos(t),s=Math.sin(t),p=[[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].map(([x,y])=>[cx+x*c-y*s,cy+x*s+y*c]);return 'M'+p.map(q=>f1(q[0])+' '+f1(q[1])).join('L')+'Z';};
const ICONS={
 standard:['steel',T(20,4,20,37,4.6),E(20,13,7.5,2.8)+E(20,22,7.5,2.8)+E(20,31,7.5,2.8)],
 ledger:['steel',T(6,27,34,13,4.4),B(6,27,7.5,6,-26.6)+B(34,13,7.5,6,-26.6)+B(6,21,2.4,5,0)+B(34,7,2.4,5,0)],
 transom:['steel',T(6,24,34,10,4.4)+T(6,24,6,31,4)+T(34,10,34,17,4),B(6,24,6,5.5,-26.6)+B(34,10,6,5.5,-26.6)],
 brace:['steel',T(8,33,32,7,4.4),E(8,33,3.6,3.6)+E(32,7,3.6,3.6)],
 plank:['timber',Q(4,24,26,12,36,17,14,29),Q(4,24,14,29,14,33.5,4,28.5)+Q(14,29,36,17,36,21.5,14,33.5)],
 toeboard:['timber',Q(5,21,30,9,34,11,9,23),Q(9,23,34,11,34,19,9,31)+Q(5,21,9,23,9,31,5,29)],
 beam:['steel',T(4,23,36,9,3.6)+T(4,33,36,19,3.6)+T(5,32.5,10.5,20.6,2.2)+T(10.5,20.6,16,28,2.2)+T(16,28,21.5,16.2,2.2)+T(21.5,16.2,27,23.6,2.2)+T(27,23.6,32.5,11.8,2.2)+T(32.5,11.8,35,19,2.2),''],
 coupler:['steel','M8.5 13h6a3.5 3.5 0 0 1 3.5 3.5v9a3.5 3.5 0 0 1-3.5 3.5h-6A3.5 3.5 0 0 1 5 25.5v-9A3.5 3.5 0 0 1 8.5 13ZM23.5 11h8a3.5 3.5 0 0 1 3.5 3.5v11a3.5 3.5 0 0 1-3.5 3.5h-8a3.5 3.5 0 0 1-3.5-3.5v-11a3.5 3.5 0 0 1 3.5-3.5Z'+T(11.5,13,11.5,6,2.6)+T(27.5,11,27.5,4,2.6),E(11.5,21,3.6,3.6)+E(27.5,20,5,2.4)],
 tube:['steel',T(5,29,32,15,6.8),B(32.6,14.7,3.2,6.8,-27)],
 plate:['steel',T(20,28,20,6,4.4),Q(5,28,20,21,35,28,20,35)+Q(5,28,20,35,35,28,35,30.5,20,37.5,5,30.5)],
 jack:['jack',Q(9,31,20,26,31,31,20,36)+T(20,31,20,4,3.8),Q(11,18.5,29,18.5,26.5,22,13.5,22)],
 rail:['steel',T(8,7,8,35,4.2)+T(32,3,32,31,4.2)+T(8,14,32,9,4)+T(8,25,32,20,4),''],
 stairs:['alu',T(5,35,35,5,3.2),B(10,32,6,3,0)+B(16,26,6,3,0)+B(22,20,6,3,0)+B(28,14,6,3,0)+B(34,8,6,3,0)],
 ladder:['alu',T(13,4,11,36,3.6)+T(29,4,27,36,3.6)+T(12.5,10,28.5,10,2.4)+T(12,17,28,17,2.4)+T(11.6,24,27.6,24,2.4)+T(11.2,31,27.2,31,2.4),''],
 wheel:['wheel','M11 7h18v3.5H11Z'+T(14.5,10.5,16.5,21,2.8)+T(25.5,10.5,23.5,21,2.8),E(20,26,9,9)+E(20,26,3.6,3.6)],
 tool:['tool',T(8,32,25,15,3.6)+E(28,12,6,6),T(8,32,16,24,5)],
 bracket:['steel',T(9,8,9,34,4.2)+T(9,12,33,12,4)+T(9,30,31,12,3.2)+T(33,12,33,6,3),''],
 small:['zinc',T(8,31,27,12,3.6)+Q(8,17,17,13,18,24),E(30,9,4.8,4.8)+E(30,9,2.6,2.6)],
 box:['box',Q(6,16,6,28,20,34,20,22)+Q(20,22,20,34,34,28,34,16),Q(6,16,20,10,34,16,20,22)]};
const ICON_HTML={};for(const [k,[cls,a,b]] of Object.entries(ICONS))ICON_HTML[k]='<svg class="tile-icon ci-'+cls+'" viewBox="0 0 40 40" aria-hidden="true"><path class="a" d="'+a+'"/>'+(b?'<path class="b" d="'+b+'"/>':'')+'</svg>';
// ---- Overview (page o): a client site - a small building wrapped in scaffold, on its own pad - as the <symbol> #ov-site; ovPicture / ovImg below draw it (and the sheet's sprites) as cached images. ----
export function ovSiteSymbol(){
 const P=(u,v,z=0)=>f1(60+.87*u-.87*v)+' '+f1(52+.42*u+.42*v-z),poly=(pts,a)=>'<path d="M'+pts.map(p=>P(...p)).join('L')+'Z" '+a+'/>',L=36,W=30,H=34;
 let s='<ellipse cx="60" cy="80" rx="52" ry="14" fill="#2a1d08" fill-opacity=".13"/>'+poly([[-10,-8],[L+12,-8],[L+12,W+18],[-10,W+18]],'fill="#d8d1c1"')+poly([[-10,W+18],[L+12,W+18],[L+12,W+18,-3],[-10,W+18,-3]],'fill="#a79f8b"')+poly([[L+12,-8],[L+12,W+18],[L+12,W+18,-3],[L+12,-8,-3]],'fill="#bdb49f"');
 s+=poly([[0,W],[L,W],[L,W,H],[0,W,H]],'fill="#efe6d4" '+ol)+poly([[L,0],[L,W],[L,W,H],[L,0,H]],'fill="#cbbd9f" '+ol)+poly([[0,0],[L,0],[L,W],[0,W]].map(p=>[...p,H]),'fill="#7f8b86" '+ol);
 for(const z of [9,20])for(const v of [6,15,24])s+=poly([[L,v,z],[L,v+5,z],[L,v+5,z+6],[L,v,z+6]],'fill="#4a6470"');
 const V=W+6,tub=(a,b,c=S.st,w=2.2)=>tube('M'+P(...a)+'L'+P(...b),c,w);let g='';
 for(const z of [11,22,33])g+='<path d="M'+P(0,W,z)+'L'+P(L,W,z)+'L'+P(L,V,z)+'L'+P(0,V,z)+'Z" fill="#c98f3e" stroke="#7d5428" stroke-width=".9"/>';
 for(const u of [0,12,24,L])g+=tub([u,V,0],[u,V,H+8]);for(const z of [11,22,33,H+6])g+=tub([0,V,z],[L,V,z]);g+=tub([L+.5,V,11],[L+.5,W,11],S.st,1.8)+tub([L+.5,V,H+6],[L+.5,W-2,H+6],S.st,1.8)+tub([0,V,3],[12,V,11],'#e3bd2c',1.8)+tub([12,V,11],[24,V,22],'#e3bd2c',1.8);
 s+='<g fill="none" stroke-linecap="round">'+g+'</g><path d="M'+P(L+8,-4,0)+'V'+f1(52+.42*(L+8)+.42*-4-44)+'" stroke="#5c686d" stroke-width="1.6"/><path d="M'+P(L+8,-4,44)+'l13 3-13 5z" fill="#d9f56b" stroke="#40601c" stroke-width="1" stroke-linejoin="round"/>';
 return '<symbol id="ov-site" viewBox="6 4 112 92">'+s+'</symbol>';}
// Overview pictures: a sprite (or a small scene of sprites) as one cached image URL, so a page render draws an <img> instead of instantiating a <use> shadow tree per copy (the Overview re-renders every second).
const ovPics=new Map();let ovDefs=null;
const ovURL=svg=>{try{if(typeof Blob!=='undefined'&&typeof URL!=='undefined'&&URL.createObjectURL)return URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));}catch{}return 'data:image/svg+xml,'+encodeURIComponent(svg);};
const ovSymbols=()=>ovDefs??=new Map([...(spriteSheet()+ovSiteSymbol()).matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)].map(m=>[m[1],[m[2],m[3]]]));
// key: cache key; one sprite id -> that sprite alone; otherwise viewBox + body with <use href="#spr-..."> references (all sprite symbols are included).
export function ovPicture(key,viewBox,body){let url=ovPics.get(key);if(url)return url;const defs=ovSymbols();if(viewBox==null){const [vb,inner]=defs.get(key)??['0 0 1 1',''];url=ovURL('<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+vb+'">'+inner+'</svg>');}else url=ovURL('<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+viewBox+'"><defs>'+[...defs].map(([id,[vb,inner]])=>'<symbol id="'+id+'" viewBox="'+vb+'">'+inner+'</symbol>').join('')+'</defs>'+body+'</svg>');ovPics.set(key,url);return url;}
export const ovImg=(key,cls='',viewBox,body)=>'<img class="ov-img'+(cls?' '+cls:'')+'" src="'+ovPicture(key,viewBox,body)+'" alt="" aria-hidden="true" decoding="sync">';
// ---- Sites page sprites: a building going up inside its scaffold, a tower crane, a docket clipboard (own sheet, built once), a small site scene and line glyphs. ----
const siF=n=>+n.toFixed(1),siPt=p=>siF(p[0])+' '+siF(p[1]),siPoly=(ps,a)=>'<path d="M'+ps.map(siPt).join('L')+'Z" '+a+'/>',siLine=(ps,a)=>'<path d="M'+ps.map(siPt).join('L')+'" '+a+'/>';
// A three-storey frame going up (open floors, bare columns and rebar on top) wrapped in an access scaffold with timber decks, braces and a lime site flag. Isometric, lit from the upper left like the yard plan.
function siBuilding(){const P=(x,y,z)=>[80+(x-y)*13.9,58+(x+y)*8-z*13];let s=siPoly([P(-.5,-.3,0),P(5.2,-.3,0),P(5.2,4.1,0),P(-.5,4.1,0)],'fill="#2a1d08" fill-opacity=".16"');
 const top=3.75;
 s+=siPoly([P(0,0,0),P(4,0,0),P(4,0,2.5),P(0,0,2.5)],'fill="#56615c"')+siPoly([P(0,0,0),P(0,3,0),P(0,3,2.5),P(0,0,2.5)],'fill="#48524e"');
 for(const z of [0,1.25])s+=siPoly([P(0,0,z),P(4,0,z),P(4,3,z),P(0,3,z)],'fill="#6b7571"');
 const col=(x,y,z0,z1,w=2.6)=>siLine([P(x,y,z0),P(x,y,z1)],'stroke="#6f7975" stroke-width="'+w+'"')+siLine([P(x,y,z0),P(x,y,z1)],'stroke="#c9cfcb" stroke-width="'+siF(w*.4)+'" transform="translate(-.6 0)"');
 for(const z of [0,1.25])for(const [x,y] of [[4,0],[4,1.5],[4,3],[2,3],[0,3]])s+=col(x,y,z,z+1.25);
 const slab=z=>siPoly([P(0,0,z),P(4,0,z),P(4,3,z),P(0,3,z)],'fill="#dcdfd9"')+siPoly([P(4,0,z),P(4,3,z),P(4,3,z-.25),P(4,0,z-.25)],'fill="#a3aaa5"')+siPoly([P(0,3,z),P(4,3,z),P(4,3,z-.25),P(0,3,z-.25)],'fill="#c2c8c3"');
 s+=slab(1.25)+slab(2.5);
 // Top floor: formwork on the back edges, bare columns with rebar, a bundle of tubes on the slab.
 s+=siPoly([P(0,0,2.5),P(2.4,0,2.5),P(2.4,0,3.3),P(0,0,3.3)],'fill="#d9a55c" stroke="#9c6f3c" stroke-width=".8"')+siPoly([P(0,0,2.5),P(0,1.6,2.5),P(0,1.6,3.3),P(0,0,3.3)],'fill="#c48f48" stroke="#9c6f3c" stroke-width=".8"');
 for(const [x,y] of [[0,0],[4,0],[0,3],[2,3],[4,1.5],[4,3]]){s+=col(x,y,2.5,top);const t=P(x,y,top);s+='<path d="M'+siF(t[0]-1.5)+' '+siF(t[1])+'v-5M'+siF(t[0]+1.5)+' '+siF(t[1])+'v-4" stroke="#9a5a2e" stroke-width=".9"/>';}
 for(let k=0;k<3;k++){const a=P(1.2+k*.18,1.2,2.62+k*.1),b=P(2.9+k*.18,1.2,2.62+k*.1);s+=siLine([a,b],'stroke="#56636a" stroke-width="2.4" stroke-linecap="round"')+siLine([a,b],'stroke="#dfe5e8" stroke-width="1.2" stroke-linecap="round"');}
 // Scaffold on the two faces we see: timber decks at every floor, braces, ledgers and guard rails, standards.
 const X=4.5,Y=3.5,xs=[-.15,1.05,2.2,3.35,X],ys=[-.15,1.1,2.3],deck=[1.25,2.5,3.75],rails=[.62,1.87,3.12,4.25,4.65];
 for(const z of deck)s+=siPoly([P(4,-.15,z),P(X,-.15,z),P(X,Y,z),P(-.15,Y,z),P(-.15,3,z),P(4,3,z)],'fill="#cf9b5c"')+siPoly([P(X,-.15,z),P(X,Y,z),P(X,Y,z-.14),P(X,-.15,z-.14)],'fill="#8f6333"')+siPoly([P(-.15,Y,z),P(X,Y,z),P(X,Y,z-.14),P(-.15,Y,z-.14)],'fill="#a9773f"');
 const tube=(a,b,w=1.9)=>siLine([a,b],'stroke="#56636a" stroke-width="'+siF(w+1)+'" stroke-linecap="round"')+siLine([a,b],'stroke="#d3dadd" stroke-width="'+siF(w*.55)+'" stroke-linecap="round"');
 for(const z of rails)s+=tube(P(X,-.15,z),P(X,Y,z),1.5)+tube(P(-.15,Y,z),P(X,Y,z),1.5);
 s+=tube(P(X,-.15,0),P(X,1.1,1.25),1.2)+tube(P(X,1.1,1.25),P(X,2.3,2.5),1.2)+tube(P(-.15,Y,0),P(1.05,Y,1.25),1.2)+tube(P(1.05,Y,1.25),P(2.2,Y,2.5),1.2)+tube(P(2.2,Y,2.5),P(3.35,Y,3.75),1.2);
 for(const y of ys)s+=tube(P(X,y,0),P(X,y,4.65));for(const x of xs)s+=tube(P(x,Y,0),P(x,Y,4.65));
 const f=P(X,-.15,4.65),g=P(X,-.15,5.9);s+=siLine([f,g],'stroke="#3d494e" stroke-width="1.3"')+'<path d="M'+siPt(g)+'l15 4.5-15 5z" fill="#b9ef4b" stroke="#58801f" stroke-width=".9" stroke-linejoin="round"/>';
 return s;}
function siCraneArt(){let s='<ellipse cx="40" cy="163" rx="22" ry="6" fill="#2a1d08" fill-opacity=".16"/><path d="M26 160l14-6 14 6-14 6z" fill="#b8b3a6"/><path d="M26 160v3l14 6v-3zM54 160v3l-14 6v-3z" fill="#8d887b"/>';
 let m='';for(let y=156;y>42;y-=9)m+='M34 '+y+'L46 '+(y-9)+'M34 '+y+'H46';s+='<path d="'+m+'" stroke="#9b7414" stroke-width="1.3" fill="none"/><path d="M34 158V40M46 158V40" stroke="#6f520c" stroke-width="3.6"/><path d="M34 158V40M46 158V40" stroke="#f0c230" stroke-width="2"/>';
 let j='';for(let x=48;x<134;x+=8)j+='M'+x+' '+siF(35+(x-48)*.058)+'L'+(x+4)+' '+siF(29.5+(x-44)*.058)+'L'+(x+8)+' '+siF(35+(x-40)*.058);s+='<path d="'+j+'" stroke="#9b7414" stroke-width="1.1" fill="none"/><path d="M46 35.2L136 40.4M46 29.4L136 34.6M6 34H34M8 29.5H34" stroke="#6f520c" stroke-width="3.2"/><path d="M46 35.2L136 40.4M46 29.4L136 34.6M6 34H34M8 29.5H34" stroke="#f0c230" stroke-width="1.8"/>';
 s+='<path d="M40 6L8 29.5M40 6L134 34.6" stroke="#4a4f4c" stroke-width=".9"/><path d="M36 30L40 6l4 24" fill="none" stroke="#6f520c" stroke-width="3.2"/><path d="M36 30L40 6l4 24" fill="none" stroke="#f0c230" stroke-width="1.7"/>';
 s+='<rect x="3" y="27" width="14" height="13" rx="1.5" fill="#9aa39f" stroke="#5c6561" stroke-width="1"/><path d="M3 32h14" stroke="#7f8884" stroke-width="1"/><rect x="31" y="35" width="18" height="9" rx="1.5" fill="#e3b21f" stroke="#6f520c" stroke-width="1"/><path d="M46 36h7.5l1.5 8h-9z" fill="#bfe0ee" stroke="#34525e" stroke-width="1"/>';
 s+='<rect x="100" y="36" width="8" height="5" rx="1" fill="#3d494e"/><path d="M104 41V104" stroke="#3d494e" stroke-width="1"/><path d="M101 104h6l-1 4h-4z" fill="#3d494e"/><path d="M104 108v3.5a3 3 0 1 1-4 2.8" fill="none" stroke="#3d494e" stroke-width="1.6"/><path d="M104 111L90 120M104 111L118 120" stroke="#3d494e" stroke-width=".8"/>';
 for(let k=0;k<3;k++)s+='<path d="M89 '+siF(122+k*3.4)+'L119 '+siF(120+k*3.4)+'" stroke="#56636a" stroke-width="3.8" stroke-linecap="round"/><path d="M89 '+siF(122+k*3.4)+'L119 '+siF(120+k*3.4)+'" stroke="#dfe5e8" stroke-width="1.8" stroke-linecap="round"/>';
 return s;}
const SI_DOCKET='<ellipse cx="25" cy="45" rx="17" ry="3" fill="#2a1d08" fill-opacity=".15"/><rect x="8" y="6" width="33" height="38" rx="4" fill="#b98a4e" stroke="#7d5428" stroke-width="1.4"/><rect x="11.5" y="11" width="26" height="29.5" rx="1.5" fill="#fdfdf8"/><path d="M16 19h11M16 25h15M16 31h9" stroke="#bfcab6" stroke-width="2.2" stroke-linecap="round"/><path d="M29.5 18.5l1.8 1.8 3.4-3.6M33 24.5l1.8 1.8 3.4-3.6" fill="none" stroke="#5e9a2c" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><rect x="17" y="3" width="15" height="7.5" rx="2.5" fill="#2f6b47" stroke="#1b4430" stroke-width="1.2"/><circle cx="24.5" cy="5.6" r="1.4" fill="#b9ef4b"/>';
let siSheetHTML=null;
// Symbols: si-site (building + scaffold, 160x130), si-crane (140x170), si-docket (48x48). The sheet sits once in <body> next to the main sprite sheet.
export function siSheet(){if(siSheetHTML)return siSheetHTML;return siSheetHTML='<svg id="si-sprite-sheet" class="sprite-sheet" width="0" height="0" aria-hidden="true" focusable="false"><defs><symbol id="si-site" viewBox="0 0 160 130">'+siBuilding()+'</symbol><symbol id="si-crane" viewBox="0 0 140 170">'+siCraneArt()+'</symbol><symbol id="si-docket" viewBox="0 0 48 48">'+SI_DOCKET+'</symbol></defs></svg>';}
export function siMount(){if(typeof document==='undefined'||document.getElementById('si-sprite-sheet'))return;document.body.insertAdjacentHTML('beforeend',siSheet());}
// One Sites sprite (spr-* from the main sheet or si-* from this one) as an inline <svg><use>: the server's CSP (img-src 'self') rules out blob: and data: image URLs.
export const siImg=(key,cls='')=>'<svg class="si-img'+(cls?' '+cls:'')+'" aria-hidden="true" focusable="false"><use href="#'+key+'"/></svg>';
// The Sites hero scene: a site pad behind green hoarding, the building in its scaffold, the tower crane, a 12.5 t truck unloading stillages at the gate, crew and trees. Uses the main sheet's truck, worker, stillage and tree sprites.
let siSceneHTML=null;
export function siSceneArt(){if(siSceneHTML)return siSceneHTML;let panels='';for(let k=1;k<8;k++){const x=60+k*29.75,y=150+k*11;panels+='M'+siF(x)+' '+siF(y-18)+'v18';}
 return siSceneHTML='<svg class="si-diorama" viewBox="-14 -40 588 262" aria-hidden="true" focusable="false"><path d="M-20 150 250 32 600 150 330 290Z" fill="#8fa866"/><path d="M-20 196 430 0h60L-20 224Z" fill="#55595b" opacity=".9"/><path d="M-4 206 450 8" stroke="#e8e4d6" stroke-width="2" stroke-dasharray="14 12" opacity=".75"/><path d="M60 150 262 62 500 150 298 238Z" fill="#cfc3a9"/><path d="M60 150 298 238 500 150v6L298 244 60 156Z" fill="#a39479"/>'+
 '<use href="#spr-tree" x="226" y="-6" width="52" height="62"/><use href="#spr-tree" x="474" y="58" width="58" height="68"/><use href="#spr-tree" x="0" y="92" width="64" height="76"/>'+
 '<use href="#si-crane" x="96" y="-38" width="150" height="182"/><use href="#si-site" x="158" y="-8" width="206" height="168"/>'+
 '<path d="M298 238 60 150V132L298 220Z" fill="#2f6b47"/><path d="M298 238 60 150V146L298 234Z" fill="#b9ef4b" opacity=".85"/><path d="M60 132 298 220" stroke="#1d4a32" stroke-width="1.5"/><path d="'+panels+'" stroke="#1d4a32" stroke-width="1"/>'+
 '<use href="#spr-stillage" x="330" y="150" width="62" height="41"/><use href="#spr-stillage" x="362" y="136" width="62" height="41"/><use href="#spr-cage" x="300" y="170" width="50" height="33"/>'+
 '<use href="#spr-truck12" x="378" y="86" width="176" height="94"/><use href="#spr-worker" x="420" y="160" width="24" height="44"/><use href="#spr-worker-busy" x="286" y="128" width="22" height="40"/></svg>';}
// Line glyphs for the site chips (24 grid, currentColor).
const SI_GLYPHS={pin:'M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11ZM12 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',client:'M4 21V5.5L12 3v18M12 8.5h8V21M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2M2 21h20',person:'M12 11.5a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6ZM4.5 20.5a7.5 7.5 0 0 1 15 0',phone:'M6.5 3.5h3l1.6 4.4-2.2 1.4a10.5 10.5 0 0 0 5.8 5.8l1.4-2.2 4.4 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.6a2 2 0 0 1 2-2.1Z',mail:'M3.5 6h17v12h-17zM3.5 7l8.5 6 8.5-6',size:'M4 20V4M4 20h16M8 16l8-8M13 8h3v3M8 13v3h3',hat:'M3.5 17.5h17M5.5 17.5a6.5 6.5 0 0 1 13 0M10 11.5V7.5h4v4',clock:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2',drop:'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',road:'M8 3 5 21M16 3l3 18M12 4v3M12 10v3M12 16v3'};
export const siGlyph=k=>'<svg class="si-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(SI_GLYPHS[k]??SI_GLYPHS.pin)+'"/></svg>';
export const scheduleIcon=()=>'<svg class="line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v16H4zM4 10h16M8 3v4M16 3v4M8 14h3v3H8z"/></svg>';
// ---- Materials list sprites: a cantilever stock rack loaded with tubes, ledgers and timber boards, a platform scale (own sheet, built once), and the page's hero scene. ----
const mlF=n=>+n.toFixed(1),mlPt=p=>mlF(p[0])+' '+mlF(p[1]),mlPoly=(ps,a)=>'<path d="M'+ps.map(mlPt).join('L')+'Z" '+a+'/>',mlLine=(a,b,attr)=>'<path d="M'+mlPt(a)+'L'+mlPt(b)+'" '+attr+'/>';
// Isometric, lit from the upper left like the yard plan. Uprights along x at the back (y=0), arms reach forward (+y), each level holds a different load.
function mlRack(){const P=(x,y,z)=>[46+(x-y)*17,116+(x+y)*9.8-z*22];let s=mlPoly([P(-.7,-.5,0),P(5.9,-.5,0),P(5.9,1.9,0),P(-.7,1.9,0)],'fill="#2a1d08" fill-opacity=".16"');
 const xs=[0,1.8,3.6,5.3],levels=[.75,2.15,3.55],top=4.25;
 const steel=(a,b,w,c='#2f6b47',hi='#4f9a6c')=>mlLine(a,b,'stroke="#173826" stroke-width="'+(w+1.6)+'" stroke-linecap="round"')+mlLine(a,b,'stroke="'+c+'" stroke-width="'+w+'" stroke-linecap="round"')+mlLine(a,b,'stroke="'+hi+'" stroke-width="'+mlF(w*.35)+'" stroke-linecap="round" transform="translate(-.6 -.4)"');
 // Feet and the back bracing between the columns.
 for(const x of xs)s+=steel(P(x,-.25,0),P(x,1.55,0),3.2);
 for(let k=0;k<xs.length-1;k++)s+=steel(P(xs[k],0,.35),P(xs[k+1],0,top-.3),1.3,'#3f5a4b','#6d8a79')+steel(P(xs[k],0,top-.3),P(xs[k+1],0,.35),1.3,'#3f5a4b','#6d8a79');
 for(const x of xs)s+=steel(P(x,0,0),P(x,0,top),4.6);
 const tube=(a,b,w,c='#c4ced2')=>mlLine(a,b,'stroke="#3d494e" stroke-width="'+mlF(w+1.8)+'" stroke-linecap="round"')+mlLine(a,b,'stroke="'+c+'" stroke-width="'+w+'" stroke-linecap="round"')+mlLine(a,b,'stroke="#f6fafb" stroke-width="'+mlF(w*.32)+'" stroke-linecap="round" transform="translate(-.4 -.6)"');
 const cap=(p,r,fill='#5c686d')=>'<ellipse cx="'+mlF(p[0])+'" cy="'+mlF(p[1])+'" rx="'+mlF(r*.8)+'" ry="'+r+'" fill="'+fill+'" stroke="#3d494e" stroke-width=".9"/>';
 levels.forEach((z,i)=>{for(const x of xs)s+=steel(P(x,0,z),P(x,1.45,z+.08),2.6,'#e3bd2c','#fbe38a')+'<path d="M'+mlPt(P(x,1.45,z+.08))+'l0 -4" stroke="#8a6d10" stroke-width="2.4" stroke-linecap="round"/>';
  if(i===0){for(const [y,dz] of [[.3,.14],[.6,.14],[.9,.14],[1.2,.14],[.75,.38],[1.05,.38]]){const a=P(-.45,y,z+dz),b=P(5.75,y,z+dz);s+=tube(a,b,3.6)+cap(b,2.1);}}
  else if(i===1){for(const [y,dz] of [[.3,.13],[.62,.13],[.94,.13],[1.24,.13],[.78,.34],[1.1,.34]]){const a=P(-.1,y,z+dz),b=P(4.6,y,z+dz);s+=tube(a,b,3,'#d3dadd')+'<path d="M'+mlPt(a)+'l-3.4 1.7M'+mlPt(b)+'l3.4 -1.7" stroke="#e38a2c" stroke-width="4.2" stroke-linecap="round"/>';}}
  else{for(let k=0;k<2;k++){const y0=.2,y1=1.3,x0=-.3,x1=5.6,zb=z+.08+k*.17,zt=zb+.15;s+=mlPoly([P(x0,y1,zb),P(x1,y1,zb),P(x1,y1,zt),P(x0,y1,zt)],'fill="#b07d42" stroke="#7d5428" stroke-width=".7"')+mlPoly([P(x1,y0,zb),P(x1,y1,zb),P(x1,y1,zt),P(x1,y0,zt)],'fill="#c48f48" stroke="#7d5428" stroke-width=".7"')+mlPoly([P(x0,y0,zt),P(x1,y0,zt),P(x1,y1,zt),P(x0,y1,zt)],'fill="#dcae70" stroke="#7d5428" stroke-width=".7"');}
   const t=z+.08+2*.17;s+='<path d="M'+mlPt(P(.4,.45,t))+'L'+mlPt(P(5.1,.45,t))+'M'+mlPt(P(.4,1.05,t))+'L'+mlPt(P(5.1,1.05,t))+'" stroke="#c99356" stroke-width=".8"/>';}});
 s+='<path d="M'+mlPt(P(5.3,0,top))+'l7 -3.5 0 7z" fill="#b9ef4b" stroke="#58801f" stroke-width=".8" stroke-linejoin="round"/>';
 return s;}
// A platform scale: steel deck on a low base, the read-out post with a lime display.
function mlScale(){const P=(x,y,z)=>[40+(x-y)*13,34+(x+y)*7.5-z*12];let s=mlPoly([P(-.3,-.3,0),P(3.3,-.3,0),P(3.3,2.4,0),P(-.3,2.4,0)],'fill="#2a1d08" fill-opacity=".16"');
 const box=(x0,y0,x1,y1,z0,z1,top,side,end)=>mlPoly([P(x0,y1,z0),P(x1,y1,z0),P(x1,y1,z1),P(x0,y1,z1)],'fill="'+side+'" stroke="#3d494e" stroke-width=".9" stroke-linejoin="round"')+mlPoly([P(x1,y0,z0),P(x1,y1,z0),P(x1,y1,z1),P(x1,y0,z1)],'fill="'+end+'" stroke="#3d494e" stroke-width=".9" stroke-linejoin="round"')+mlPoly([P(x0,y0,z1),P(x1,y0,z1),P(x1,y1,z1),P(x0,y1,z1)],'fill="'+top+'" stroke="#3d494e" stroke-width=".9" stroke-linejoin="round"');
 s+=box(0,0,3,2.1,0,.35,'#c9d3d7','#8e9ba1','#a7b3b8');
 let g='';for(let k=1;k<6;k++){g+='M'+mlPt(P(k/2,0.1,.35))+'L'+mlPt(P(k/2,2,.35));}s+='<path d="'+g+'" stroke="#9aa6ab" stroke-width=".8"/>';
 s+=box(.15,-.15,.45,.15,.35,3.2,'#56636a','#3d494e','#4a565c')+box(-.35,-.3,.95,.25,3.2,4.3,'#2f3734','#1d2422','#2a302e');
 const d=[P(-.35,.25,3.4),P(.95,.25,3.4),P(.95,.25,4.1),P(-.35,.25,4.1)];s+=mlPoly([[d[0][0]+1.4,d[0][1]-.4],[d[1][0]-1.4,d[1][1]-.4],[d[2][0]-1.4,d[2][1]+.8],[d[3][0]+1.4,d[3][1]+.8]],'fill="#b9ef4b"');
 s+=box(1.1,.5,2.2,1.5,.35,1.05,'#e3bd2c','#b38714','#c99a1c');
 return s;}
// The rack and the scale go into cached pictures (ovImg) as nested <svg>s: one <img> per use instead of a <use> that re-clones the drawing on every render.
let mlRackSVG=null,mlSceneBody=null;
const mlRackArt=()=>mlRackSVG??=mlRack();
const mlNest=(vb,body,x,y,w,h)=>'<svg x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" viewBox="'+vb+'">'+body+'</svg>';
// ml-rack (160x200), ml-scale (80x72), or any sprite of the main sheet (spr-*).
export const mlImg=(key,cls='')=>key==='ml-rack'?ovImg('ml-rack',cls,'0 0 160 200',mlRackArt()):key==='ml-scale'?ovImg('ml-scale',cls,'0 0 80 72',mlScale()):ovImg(key,cls);
// The Materials hero scene: a stock-yard pad with two loaded racks, stillages and a cage, a forklift bringing a stillage in, crew and trees.
export function mlSceneArt(){return ovImg('ml-scene','ml-diorama','-14 -34 588 256',mlSceneBody??='<path d="M-20 150 250 32 600 150 330 290Z" fill="#8fa866"/><path d="M-20 196 430 0h60L-20 224Z" fill="#55595b" opacity=".9"/><path d="M-4 206 450 8" stroke="#e8e4d6" stroke-width="2" stroke-dasharray="14 12" opacity=".75"/><path d="M50 152 262 60 510 152 298 244Z" fill="#d8d1c1"/><path d="M50 152 298 244 510 152v7L298 251 50 159Z" fill="#a79f8b"/><path d="M92 152 262 78 468 152 298 226Z" fill="none" stroke="#e3bd2c" stroke-width="2" stroke-dasharray="9 6" opacity=".9"/>'+
 '<use href="#spr-tree" x="214" y="-22" width="54" height="64"/><use href="#spr-tree" x="480" y="54" width="58" height="68"/><use href="#spr-tree" x="0" y="90" width="64" height="76"/>'+
 mlNest('0 0 160 200',mlRackArt(),250,-40,150,188)+mlNest('0 0 160 200',mlRackArt(),138,0,150,188)+
 '<use href="#spr-stillage" x="392" y="104" width="74" height="49"/><use href="#spr-stillage" x="392" y="76" width="74" height="49"/><use href="#spr-cage" x="438" y="128" width="56" height="37"/>'+
 '<use href="#spr-bundle" x="92" y="160" width="54" height="40"/><use href="#spr-worker-busy" x="136" y="150" width="24" height="46"/>'+
 '<use href="#spr-forklift-load" x="300" y="138" width="98" height="75"/><use href="#spr-worker" x="416" y="162" width="24" height="44"/>');}
// ---- Set-up guide (Home): a fenced yard pad with its size marked out, and a dated yard list (own sheet, built once, next to the main sheet). Isometric, lit from the upper left like the yard plan; the pad reuses the main sheet's stillage. ----
let sgSheetHTML=null;
const SG_YARD='<ellipse cx="60" cy="76" rx="54" ry="9" fill="#1d3a2a" opacity=".13"/><path d="M60 8 118 38 60 68 2 38Z" fill="#8fa866"/><path d="M2 38 60 68 118 38v5L60 73 2 43Z" fill="#6f8a4e"/><path d="M60 15 106 38 60 61 14 38Z" fill="#d8d1c1"/><path d="M14 38 60 61 106 38v4L60 65 14 42Z" fill="#a79f8b"/>'
 +'<path d="M60 21 94 38 60 55 26 38Z" fill="none" stroke="#e3bd2c" stroke-width="1.3" stroke-dasharray="4 3"/>'
 +'<path d="M14 38v-9L60 6l46 23v9M14 33.5 60 10.5l46 23M26 32v-9M38 26v-9M49 20.5v-9M71 20.5v-9M82 26v-9M94 32v-9" fill="none" stroke="#9aa6a0" stroke-width="1.2" stroke-linecap="round"/>'
 +'<use href="#spr-stillage" x="36" y="24" width="30" height="20"/><use href="#spr-stillage" x="54" y="32" width="30" height="20"/>'
 +'<path d="M8 49 56 73M66 73l48-24" fill="none" stroke="#2b5a3d" stroke-width="1.3"/><path d="M8 49l1.2 4.2M8 49l4.3.6M56 73l-4.3-.6M56 73l-1.2-4.2M66 73l1.2-4.2M66 73l4.3-.6M114 49l-4.3.6M114 49l-1.2 4.2" fill="none" stroke="#2b5a3d" stroke-width="1.3" stroke-linecap="round"/>'
 +'<rect x="18" y="56.5" width="24" height="11" rx="5.5" fill="#d2ea83" stroke="#5f7d2c" stroke-width=".9"/><text x="30" y="64.6" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="7.2" font-weight="700" text-anchor="middle" fill="#27421f">30 m</text>'
 +'<rect x="78" y="56.5" width="24" height="11" rx="5.5" fill="#d2ea83" stroke="#5f7d2c" stroke-width=".9"/><text x="90" y="64.6" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="7.2" font-weight="700" text-anchor="middle" fill="#27421f">20 m</text>';
const SG_LIST='<ellipse cx="29" cy="55" rx="21" ry="3.6" fill="#1d3a2a" opacity=".14"/><rect x="8" y="8" width="34" height="44" rx="4" fill="#b98a4e" stroke="#8a6232" stroke-width="1.2"/><rect x="12" y="13" width="26" height="35" rx="1.5" fill="#fbfaf4"/>'
 +'<rect x="18" y="5" width="14" height="7" rx="2" fill="#7c8a86"/><rect x="21" y="3.4" width="8" height="3.2" rx="1.6" fill="#56636a"/>'
 +'<path d="M15.5 19.5l1.4 1.4 2.6-2.8M15.5 26.5l1.4 1.4 2.6-2.8M15.5 33.5l1.4 1.4 2.6-2.8" fill="none" stroke="#6fae2f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 20h12M22 27h10M22 34h8" stroke="#c9d1c2" stroke-width="1.8" stroke-linecap="round"/>'
 +'<rect x="31" y="29" width="23" height="23" rx="3.2" fill="#fff" stroke="#2b5a3d" stroke-width="1.4"/><path d="M31 32.2a3.2 3.2 0 0 1 3.2-3.2h16.6a3.2 3.2 0 0 1 3.2 3.2V37H31Z" fill="#6fae2f"/><path d="M36.5 27v4.4M48.5 27v4.4" stroke="#2b5a3d" stroke-width="1.8" stroke-linecap="round"/>'
 +'<path d="M35 41h3M40.5 41h3M46 41h3M35 46h3M46 46h3" stroke="#c9d1c2" stroke-width="1.8" stroke-linecap="round"/><rect x="39.6" y="43.4" width="4.8" height="5" rx="1.2" fill="#d2ea83" stroke="#5f7d2c" stroke-width=".8"/>';
// Symbols: sg-yard (120x84), sg-list (60x60).
export function sgSheet(){return sgSheetHTML??='<svg id="sg-sprite-sheet" class="sprite-sheet" width="0" height="0" aria-hidden="true" focusable="false"><defs><symbol id="sg-yard" viewBox="0 0 120 84">'+SG_YARD+'</symbol><symbol id="sg-list" viewBox="0 0 60 60">'+SG_LIST+'</symbol></defs></svg>';}
export function sgMount(){if(typeof document==='undefined'||document.getElementById('sg-sprite-sheet'))return;document.body.insertAdjacentHTML('beforeend',sgSheet());}
