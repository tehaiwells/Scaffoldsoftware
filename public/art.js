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
