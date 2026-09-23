import { integer, requireRule } from './geometry.js';
import { readFileSync } from 'node:fs';
const synthetic=JSON.parse(readFileSync(new URL('../../catalogues/synthetic.json',import.meta.url),'utf8'));
export const label=(v,name='Name')=>{requireRule(typeof v==='string'&&v.trim().length>0&&v.length<=250,`${name} is required (maximum 250 characters).`);return v.trim();};
export const nullable=(v,name)=>v===null||v===undefined?null:integer(v,name,0);
export const catalogueMethods={
  product(input){
    const system=this.db.prepare('SELECT s.id FROM scaffold_systems s JOIN company_systems c ON c.system_id=s.id WHERE c.company_id=? AND s.id=? AND c.enabled=1').get(this.user.company_id,input.system);
    requireRule(system,'Enable this scaffold system before selecting new materials.');
    const reference=label(input.reference,'Manufacturer or demo reference'),manufacturer=label(input.manufacturer??'Synthetic demonstration','Manufacturer'),region=label(input.region??'DEMO','Region');
    const same=this.repo.all('product').find(p=>p.reference===reference&&p.manufacturer===manufacturer&&p.region===region);
    requireRule(!same,'This manufacturer / region / reference already exists. Review conflicting values instead of overwriting.');
    const statuses=['NOT PROVIDED','CONFLICTING','NEEDS REGIONAL CHECK','COMPANY CONFIGURED','SOURCE VERIFIED','DEMO ONLY'];
    requireRule(statuses.includes(input.verification),'Choose an explicit verification status.');
    requireRule(input.verification!=='SOURCE VERIFIED'||input.document&&input.page,'Verified facts need a source document and page.');
    const source=this.repo.add('source',{document:input.document??'Synthetic demonstration fixture',manufacturer,region,edition:input.edition??null,page:input.page??null,url:input.url??null,status:input.verification,limitations:input.limitations??'Not a manufacturer specification. Simulation only.'});
    const definition=this.repo.add('definition',{name:label(input.name),system:input.system,category:label(input.category??'Scaffold components')});
    const product=this.repo.add('product',{definition:definition.id,source:source.id,name:definition.name,system:input.system,category:definition.category,manufacturer,reference,region,finish:input.finish??null,nominalSize:input.nominalSize??null,unit:'each',unitWeight:nullable(input.unitWeight,'Unit weight (g)'),length:nullable(input.length,'Physical length'),width:nullable(input.width,'Physical width'),height:nullable(input.height,'Physical height'),verification:input.verification,unknownReason:input.unknownReason??'NOT PROVIDED'});
    this.repo.add('packaging',{product:product.id,publishedQuantity:nullable(input.publishedQuantity,'Published quantity'),operatingQuantity:input.packQuantity==null?null:integer(input.packQuantity,'Operating pack quantity',1),status:input.verification,source:source.id});
    return product;
  },
  override(input){const product=this.repo.get(input.product,'product');const settings=this.repo.all('productSettings').find(s=>s.product===product.id);const data={product:product.id,unitWeight:nullable(input.unitWeight,'Unit weight (g)'),packQuantity:input.packQuantity==null?null:integer(input.packQuantity,'Pack quantity',1),spannerSize:input.spannerSize==null?null:integer(input.spannerSize,'Spanner size (tenths mm)',1),reason:label(input.reason,'Reason'),status:'COMPANY CONFIGURED',actor:this.user.id};const result=settings?this.repo.save({...settings,...data}):this.repo.add('productSettings',data);this.repo.event(this.user.id,'PRODUCT_OVERRIDE',{product:product.id,reason:data.reason,key:this.key});return result;},
  effectiveProducts(){const first=(kind)=>{const m=new Map();for(const s of this.repo.all(kind))if(!m.has(s.product))m.set(s.product,s);return m;};const settings=first('productSettings'),packs=first('packaging');return this.repo.all('product').map(p=>{const setting=settings.get(p.id),pack=packs.get(p.id);return {...p,unitWeight:setting?.unitWeight??p.unitWeight,packQuantity:setting?.packQuantity??pack?.operatingQuantity??null};});},
  effective(productId){const p=this.repo.get(productId,'product'),setting=this.repo.all('productSettings').find(s=>s.product===productId),pack=this.repo.all('packaging').find(s=>s.product===productId);return {...p,unitWeight:setting?.unitWeight??p.unitWeight,packQuantity:setting?.packQuantity??pack?.operatingQuantity??null};},
  seed(){
    requireRule(!this.repo.all('product').length,'Synthetic catalogue has already been configured.');
    const system=this.db.prepare('SELECT system_id FROM company_systems WHERE company_id=? AND enabled=1 ORDER BY system_id LIMIT 1').get(this.user.company_id)?.system_id;
    return synthetic.map(product=>this.product({...product,system}));
  },
  importCatalogue(input){requireRule(Array.isArray(input.products)&&input.products.length>0&&input.products.length<=100,'Import between 1 and 100 factual variants per batch.');const batch=this.repo.add('importBatch',{actor:this.user.id,createdAt:new Date().toISOString(),status:'REVIEWED BY COMPANY',name:label(input.name,'Batch name')});const products=input.products.map(p=>this.product(p));batch.products=products.map(p=>p.id);this.repo.save(batch);return {batch,products};}
};
