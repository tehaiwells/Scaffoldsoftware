import { integer,requireRule,overlap,fitsPolygon } from './geometry.js';
import { label } from './catalogue.js';
// Yard fixtures: truck entry / exit lanes are kept clear of stock; the toilet, yard office and custom fixtures are solid obstacles.
export const FIXTURE_KINDS={ENTRY:{name:'Truck entry',w:4000,h:3000,solid:false},EXIT:{name:'Truck exit',w:4000,h:3000,solid:false},TOILET:{name:'Toilet',w:1500,h:1500,solid:true},OFFICE:{name:'Yard office',w:6000,h:3000,solid:true},CUSTOM:{name:'Fixture',w:2000,h:2000,solid:true}};
export const solidFixture=f=>FIXTURE_KINDS[f.kind]?.solid!==false;
export function fixtureList(list,points){
  requireRule(Array.isArray(list)&&list.length<=20,'Add up to 20 yard fixtures.');
  const validId=f=>typeof f?.id==='string'&&f.id.length>0&&f.id.length<=40;const used=new Set(list.filter(validId).map(f=>f.id)),seen=new Set();let n=0;const nextId=()=>{do n++;while(used.has('F'+n));used.add('F'+n);return 'F'+n;};
  const out=list.map(f=>{const kind=FIXTURE_KINDS[f?.kind];requireRule(kind,'Choose a fixture type: truck entry, truck exit, toilet, yard office or custom.');const id=validId(f)&&!seen.has(f.id)?f.id:nextId();seen.add(id);const box={id,kind:f.kind,name:label(f.name??kind.name,'Fixture name'),x:integer(f.x,'Fixture x',-1000000),y:integer(f.y,'Fixture y',-1000000),w:integer(f.w??kind.w,'Fixture width',300,100000),h:integer(f.h??kind.h,'Fixture depth',300,100000)};requireRule(fitsPolygon(box,points),box.name+' must sit fully inside the boundary.');return box;});
  for(let i=0;i<out.length;i++)for(let j=i+1;j<out.length;j++)requireRule(!overlap(out[i],out[j]),out[i].name+' overlaps '+out[j].name+'.');
  return out;
}
