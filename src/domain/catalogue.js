import { integer, requireRule } from './geometry.js';
import { readFileSync } from 'node:fs';
import { catalogueRevision } from '../repository.js';
import { cached } from '../database.js';
const synthetic=JSON.parse(readFileSync(new URL('../../catalogues/synthetic.json',import.meta.url),'utf8'));
export const label=(v,name='Name')=>{requireRule(typeof v==='string'&&v.trim().length>0&&v.length<=250,`${name} is required (maximum 250 characters).`);return v.trim();};
export const nullable=(v,name)=>v===null||v===undefined?null:integer(v,name,0);
const catalogueCache=new WeakMap();
const byIdOf=list=>{const m=new Map();for(const p of list)if(!m.has(p.id))m.set(p.id,p);return m;};
// A product with its company settings applied: the company's weight / pack win, then the product's own figures. A product with company settings also says so
// (figuresStatus, and figuresSource: where the company says the figures came from), so a demo product whose figures the company entered is not shown as demo figures.
// Each figure keeps its own source (weightSource / packSource); a record saved before that has one sourceNote for both.
const sourceOf=s=>{if(!s)return null;const w=s.weightSource,k=s.packSource;if(w===undefined&&k===undefined)return s.sourceNote??null;return w&&k?(w===k?w:'Weight: '+w+' · Pack: '+k):w?'Weight: '+w:k?'Pack: '+k:null;};
// A settings record that only holds a minimum yard level (figures:false, see override) says nothing about the figures. minYard is carried only when set.
const withSettings=(p,setting,pack)=>({...p,unitWeight:setting?.unitWeight??p.unitWeight,packQuantity:setting?.packQuantity??pack?.operatingQuantity??null,...(setting&&setting.figures!==false?{figuresStatus:setting.status??'COMPANY CONFIGURED',figuresSource:sourceOf(setting)}:{}),...(setting?.minYard>0?{minYard:setting.minYard}:{})});
export function computeEffectiveProducts(repo){const first=(kind)=>{const m=new Map();for(const s of repo.all(kind))if(!m.has(s.product))m.set(s.product,s);return m;};const settings=first('productSettings'),packs=first('packaging');return repo.all('product').map(p=>withSettings(p,settings.get(p.id),packs.get(p.id)));}
export const catalogueMethods={
  product(input){
    const system=cached(this.db,'SELECT s.id FROM scaffold_systems s JOIN company_systems c ON c.system_id=s.id WHERE c.company_id=? AND s.id=? AND c.enabled=1').get(this.user.company_id,input.system);
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
  // A company's own weight / pack for a product (grams, pieces per stillage). sourceNote (optional) records where the company took the figures from: a figure this save changes
  // takes the note as its own source (weightSource / packSource), a figure it leaves as it was keeps its earlier source. An omitted spannerSize keeps the one already set.
  // minYard (optional): keep at least this many free in the yard (0 or null clears it); an omitted minYard keeps the one already set. A save with minYard and no
  // weight or pack (a 'minimum only' save) changes nothing else: it needs no reason, and on a product with no settings yet it adds a record marked figures:false.
  override(input){const product=this.repo.get(input.product,'product');const settings=this.repo.all('productSettings').find(s=>s.product===product.id);
    const minYard=input.minYard===undefined?undefined:input.minYard===null||input.minYard===0?null:integer(input.minYard,'Minimum in the yard',1,1000000);
    if(minYard!==undefined&&input.unitWeight===undefined&&input.packQuantity===undefined){const reason=input.reason==null||input.reason===''?'Minimum yard level':label(input.reason,'Reason');
      const result=settings?this.repo.save({...settings,minYard}):this.repo.add('productSettings',{product:product.id,unitWeight:null,packQuantity:null,spannerSize:null,minYard,figures:false,reason,status:'COMPANY CONFIGURED',actor:this.user.id});
      this.repo.event(this.user.id,'PRODUCT_OVERRIDE',{product:product.id,reason:reason+': '+(minYard==null?'no minimum':'keep at least '+minYard+' in the yard'),key:this.key});this.alCheck({quiet:product.id});return result;}
    const before=this.effective(product.id);
    const unitWeight=nullable(input.unitWeight,'Unit weight (g)'),packQuantity=input.packQuantity==null?null:integer(input.packQuantity,'Pack quantity',1),note=input.sourceNote==null||input.sourceNote===''?null:label(input.sourceNote,'Source note');
    const kept=k=>settings?(settings[k]!==undefined?settings[k]:settings.sourceNote??null):null;
    const data={product:product.id,unitWeight,packQuantity,spannerSize:input.spannerSize===undefined?(settings?.spannerSize??null):input.spannerSize==null?null:integer(input.spannerSize,'Spanner size (tenths mm)',1),reason:label(input.reason,'Reason'),sourceNote:note,weightSource:unitWeight!==(before.unitWeight??null)?note:kept('weightSource'),packSource:packQuantity!==(before.packQuantity??null)?note:kept('packSource'),status:'COMPANY CONFIGURED',actor:this.user.id,figures:undefined,...(minYard!==undefined?{minYard}:{})};const result=settings?this.repo.save({...settings,...data}):this.repo.add('productSettings',data);this.repo.event(this.user.id,'PRODUCT_OVERRIDE',{product:product.id,reason:data.reason,key:this.key});return result;},
  // Cached per company by the exact catalogue revision (see Repository); callers get fresh shallow copies and may mutate them.
  catalogue(){if(this.catalogueMemo)return this.catalogueMemo;if(this.catalogueBypass){const list=computeEffectiveProducts(this.repo);return {list,byId:byIdOf(list)};}let byCompany=catalogueCache.get(this.db);if(!byCompany)catalogueCache.set(this.db,byCompany=new Map());const rev=catalogueRevision(this.db,this.user.company_id);let entry=byCompany.get(this.user.company_id);if(entry?.rev!==rev){const list=computeEffectiveProducts(this.repo);entry={rev,list,byId:byIdOf(list)};byCompany.set(this.user.company_id,entry);}return entry;},
  effectiveProducts(){return this.catalogue().list.map(p=>({...p}));},
  effective(productId){const p=this.catalogueBypass?null:this.catalogue().byId.get(productId);if(p)return {...p};const q=this.repo.get(productId,'product'),setting=this.repo.all('productSettings').find(s=>s.product===productId),pack=this.repo.all('packaging').find(s=>s.product===productId);return withSettings(q,setting,pack);},
  seed(){
    requireRule(!this.repo.all('product').length,'Synthetic catalogue has already been configured.');
    const system=cached(this.db,'SELECT system_id FROM company_systems WHERE company_id=? AND enabled=1 ORDER BY system_id LIMIT 1').get(this.user.company_id)?.system_id;
    return synthetic.map(product=>this.product({...product,system}));
  },
  importCatalogue(input){requireRule(Array.isArray(input.products)&&input.products.length>0&&input.products.length<=100,'Import between 1 and 100 factual variants per batch.');const batch=this.repo.add('importBatch',{actor:this.user.id,createdAt:new Date().toISOString(),status:'REVIEWED BY COMPANY',name:label(input.name,'Batch name')});const products=input.products.map(p=>this.product(p));batch.products=products.map(p=>p.id);this.repo.save(batch);return {batch,products};}
};
