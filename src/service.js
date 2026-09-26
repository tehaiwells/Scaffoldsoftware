import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { atomic,cached } from './database.js';

export class AppError extends Error { constructor(status,message) { super(message); this.status=status; } }
const fail=(status,message)=>{throw new AppError(status,message);};
const text=(v,label,max=120)=> typeof v==='string' && v.trim().length>0 && v.trim().length<=max ? v.trim() : fail(400,`${label} is required (maximum ${max} characters).`);
const emailOf=v=>{ const e=text(v,'Email',254).toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400,'Enter a valid email.'); return e; };
const hashToken=t=>createHash('sha256').update(t).digest('hex');
function passwordHash(password) {
  if(typeof password!=='string'||password.length<12||password.length>128) fail(400,'Use a password of 12 to 128 characters.');
  const salt=randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
function matches(password,hash) {
  if(typeof password!=='string'||password.length>128) return false;
  const [salt,key]=hash.split(':'); return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(key,'hex'));
}
let dummyHash;
export class Service {
  constructor(db) {this.db=db;this.memo=null; this.dummyHash=dummyHash??=passwordHash(randomBytes(24).toString('hex'));}
  systems(ids) {
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!cached(this.db,'SELECT id FROM scaffold_systems WHERE id=?').get(id))) fail(400,'Choose at least one valid scaffold system.');
    return ids;
  }
  audit(user,action,details={}) { cached(this.db,'INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),user.company_id,user.id,action,JSON.stringify(details),new Date().toISOString()); }
  createUser(companyId,input) {
    const name=text(input.name,'Name'),email=emailOf(input.email),hash=passwordHash(input.password);
    if(cached(this.db,'SELECT id FROM users WHERE email=?').get(email)) fail(409,'That email cannot be used.');
    const id=randomUUID(); cached(this.db,'INSERT INTO users(id,company_id,name,email,password_hash) VALUES(?,?,?,?,?)').run(id,companyId,name,email,hash); cached(this.db,'INSERT INTO memberships VALUES(?,?)').run(companyId,id); return {id,company_id:companyId};
  }
  register(input) {
    const name=text(input.companyName,'Company name'),ids=this.systems(input.systems);
    return atomic(this.db,()=>{
      const companyId=randomUUID(); cached(this.db,'INSERT INTO companies VALUES(?,?,?)').run(companyId,name,new Date().toISOString());
      const user=this.createUser(companyId,input); cached(this.db,'INSERT INTO user_roles VALUES(?,?,?)').run(companyId,user.id,'OWNER');
      this.saveSystems(user,ids); this.audit(user,'company.created'); return this.session(user.id);
    });
  }
  session(userId,companyId=null) {
    const token=randomBytes(32).toString('hex'); cached(this.db,'DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    companyId??=cached(this.db,'SELECT company_id FROM users WHERE id=?').get(userId).company_id;
    cached(this.db,'INSERT INTO sessions(token_hash,user_id,expires_at,company_id) VALUES(?,?,?,?)').run(hashToken(token),userId,Date.now()+8*60*60*1000,companyId); return token;
  }
  login(input) {
    const email=emailOf(input.email),user=cached(this.db,'SELECT * FROM users WHERE email=?').get(email);
    const valid=matches(input.password,user?.password_hash??this.dummyHash);
    if(!valid||!user) fail(401,'Email or password is incorrect.'); return this.session(user.id);
  }
  authenticate(token) {
    if(!token) fail(401,'Please sign in.');
    const user=cached(this.db,'SELECT u.id,s.company_id,u.name,u.email FROM users u JOIN sessions s ON s.user_id=u.id JOIN memberships m ON m.user_id=u.id AND m.company_id=s.company_id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token),Date.now());
    if(!user) fail(401,'Please sign in.'); return user;
  }
  logout(token) {cached(this.db,'DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));}
  switchCompany(user,companyId,token){if(typeof companyId!=='string'||!cached(this.db,'SELECT company_id FROM memberships WHERE user_id=? AND company_id=?').get(user.id,companyId))fail(403,'You are not a member of that company.');cached(this.db,'UPDATE sessions SET company_id=? WHERE token_hash=? AND user_id=?').run(companyId,hashToken(token),user.id);}
  addMembership(user,input){this.require(user,'users.manage');const email=emailOf(input.email),member=cached(this.db,'SELECT id FROM users WHERE email=?').get(email);if(!member)fail(404,'No existing account has that email. Create a new team member instead.');if(!Array.isArray(input.roles)||!input.roles.length||input.roles.some(r=>!['OWNER','GENERAL_MANAGER','SUPERVISOR'].includes(r)))fail(400,'Choose valid roles.');return atomic(this.db,()=>{if(cached(this.db,'SELECT * FROM memberships WHERE company_id=? AND user_id=?').get(user.company_id,member.id))fail(409,'Already a member of this company.');cached(this.db,'INSERT INTO memberships VALUES(?,?)').run(user.company_id,member.id);for(const role of new Set(input.roles))cached(this.db,'INSERT INTO user_roles VALUES(?,?,?)').run(user.company_id,member.id,role);this.audit(user,'membership.created',{userId:member.id});return {id:member.id};});}
  // memo is set only while one Simulation.snapshot runs (same user object), so a snapshot asks SQLite once.
  permissions(user) {if(this.memo&&this.memo.user===user)return [...this.memo.list];return cached(this.db,'SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role=ur.role WHERE ur.company_id=? AND ur.user_id=?').all(user.company_id,user.id).map(x=>x.permission);}
  require(user,permission) {if(!this.permissions(user).includes(permission)) fail(403,'Your role does not allow this action.');}
  saveSystems(user,ids) {
    cached(this.db,'UPDATE company_systems SET enabled=0 WHERE company_id=?').run(user.company_id);
    for(const id of ids) cached(this.db,'INSERT INTO company_systems VALUES(?,?,1) ON CONFLICT(company_id,system_id) DO UPDATE SET enabled=1').run(user.company_id,id);
  }
  updateCompany(user,input) {
    this.require(user,'company.manage'); const name=text(input.name,'Company name'),ids=this.systems(input.systems);
    atomic(this.db,()=>{cached(this.db,'UPDATE companies SET name=? WHERE id=?').run(name,user.company_id); this.saveSystems(user,ids); this.audit(user,'company.updated',{systems:ids});});
  }
  addUser(user,input) {
    this.require(user,'users.manage');
    if(!Array.isArray(input.roles)||!input.roles.length||new Set(input.roles).size!==input.roles.length||input.roles.some(r=>!['OWNER','GENERAL_MANAGER','SUPERVISOR'].includes(r))) fail(400,'Choose valid roles.');
    return atomic(this.db,()=>{const created=this.createUser(user.company_id,input); for(const role of input.roles) cached(this.db,'INSERT INTO user_roles VALUES(?,?,?)').run(user.company_id,created.id,role); this.audit(user,'user.created',{userId:created.id,roles:input.roles}); return {id:created.id};});
  }
  snapshot(user) {
    const permissions=this.permissions(user);
    return {user,permissions,memberships:cached(this.db,'SELECT c.id,c.name FROM companies c JOIN memberships m ON m.company_id=c.id WHERE m.user_id=?').all(user.id),company:cached(this.db,'SELECT id,name FROM companies WHERE id=?').get(user.company_id),systems:cached(this.db,'SELECT s.id,s.name,COALESCE(cs.enabled,0) enabled FROM scaffold_systems s LEFT JOIN company_systems cs ON cs.system_id=s.id AND cs.company_id=? ORDER BY s.name').all(user.company_id),roles:cached(this.db,'SELECT role FROM user_roles WHERE company_id=? AND user_id=? ORDER BY role').all(user.company_id,user.id).map(r=>r.role),users:permissions.includes('users.manage')?cached(this.db,"SELECT u.id,u.name,u.email,(SELECT group_concat(r.role,',') FROM user_roles r WHERE r.company_id=m.company_id AND r.user_id=u.id) roles FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.company_id=? ORDER BY u.name").all(user.company_id):[],audit:permissions.includes('company.manage')?cached(this.db,'SELECT action,created_at FROM audit_events WHERE company_id=? ORDER BY created_at DESC LIMIT 20').all(user.company_id):[]};
  }
}
