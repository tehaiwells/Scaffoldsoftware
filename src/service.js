import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { atomic, cached } from './database.js';

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new AppError(status, message);
};
const text = (v, label, max = 120) =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
    ? v.trim()
    : fail(400, `${label} is required (maximum ${max} characters).`);
const emailOf = (v) => {
  const e = text(v, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email.');
  return e;
};
const ROLE_IDS = ['OWNER', 'GENERAL_MANAGER', 'SUPERVISOR'],
  INVITE_MS = 7 * 86400000;
const hashToken = (t) => createHash('sha256').update(t).digest('hex');
// SCAFFOLD_ADMIN_EMAIL (optional): the email of the account that runs this server, in place of whoever created the first company.
const namedAdmin = () => process.env.SCAFFOLD_ADMIN_EMAIL?.trim().toLowerCase() || null;
// One answer for every failed "join" (audit D3): a wrong password for an email that already signs in and a new person's too-short password look the same.
const JOIN_FAIL =
  'Check your name and password and try again. A password has 12 to 128 characters; if you already sign in with this email, use that password.';
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    fail(400, 'Use a password of 12 to 128 characters.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function matches(password, hash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, key] = hash.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex'));
}
let dummyHash;
export class Service {
  constructor(db) {
    this.db = db;
    this.memo = null;
    this.dummyHash = dummyHash ??= passwordHash(randomBytes(24).toString('hex'));
  }
  systems(ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !cached(this.db, 'SELECT id FROM scaffold_systems WHERE id=?').get(id))
    )
      fail(400, 'Choose at least one valid scaffold system.');
    return ids;
  }
  audit(user, action, details = {}) {
    cached(this.db, 'INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      user.company_id,
      user.id,
      action,
      JSON.stringify(details),
      new Date().toISOString(),
    );
  }
  createUser(companyId, input) {
    const name = text(input.name, 'Name'),
      email = emailOf(input.email),
      hash = passwordHash(input.password);
    // While sign-up is open this still tells whether an email has an account (there is no email check to hide it behind): see KNOWN_LIMITATIONS.md.
    if (cached(this.db, 'SELECT id FROM users WHERE email=?').get(email)) fail(409, 'That email cannot be used.');
    this.reservedAdminEmail(email);
    const id = randomUUID();
    cached(this.db, 'INSERT INTO users(id,company_id,name,email,password_hash) VALUES(?,?,?,?,?)').run(
      id,
      companyId,
      name,
      email,
      hash,
    );
    cached(this.db, 'INSERT INTO memberships(company_id,user_id) VALUES(?,?)').run(companyId, id);
    return { id, company_id: companyId };
  }
  register(input) {
    const name = text(input.companyName, 'Company name'),
      ids = this.systems(input.systems);
    return atomic(this.db, () => {
      const companyId = randomUUID(),
        now = new Date().toISOString();
      cached(this.db, 'INSERT INTO companies VALUES(?,?,?)').run(companyId, name, now);
      const user = this.createUser(companyId, input);
      cached(this.db, 'INSERT INTO user_roles VALUES(?,?,?)').run(companyId, user.id, 'OWNER');
      // Whoever creates the first company on this server runs it (the server administrator, audit D6).
      const named = namedAdmin();
      if (!named || named === emailOf(input.email))
        cached(this.db, 'INSERT INTO server_admins SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM server_admins)').run(
          user.id,
          now,
        );
      this.saveSystems(user, ids);
      this.audit(user, 'company.created');
      return this.session(user.id);
    });
  }
  // Signs in to the user's own company, or (after they were removed from it) to another company they still belong to. None left: no session.
  session(userId, companyId = null) {
    const token = randomBytes(32).toString('hex');
    cached(this.db, 'DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    companyId ??= cached(
      this.db,
      'SELECT m.company_id FROM users u JOIN memberships m ON m.user_id=u.id AND m.removed_at IS NULL WHERE u.id=? ORDER BY m.company_id=u.company_id DESC,m.company_id LIMIT 1',
    ).get(userId)?.company_id;
    if (!companyId) fail(403, 'You are no longer in any company here. Ask an owner to invite you again.');
    cached(this.db, 'INSERT INTO sessions(token_hash,user_id,expires_at,company_id) VALUES(?,?,?,?)').run(
      hashToken(token),
      userId,
      Date.now() + 8 * 60 * 60 * 1000,
      companyId,
    );
    return token;
  }
  login(input) {
    const email = emailOf(input.email),
      user = cached(this.db, 'SELECT * FROM users WHERE email=?').get(email);
    const valid = matches(input.password, user?.password_hash ?? this.dummyHash);
    if (!valid || !user) fail(401, 'Email or password is incorrect.');
    return this.session(user.id);
  }
  authenticate(token) {
    if (!token) fail(401, 'Please sign in.');
    const user = cached(
      this.db,
      'SELECT u.id,s.company_id,u.name,u.email FROM users u JOIN sessions s ON s.user_id=u.id JOIN memberships m ON m.user_id=u.id AND m.company_id=s.company_id AND m.removed_at IS NULL WHERE s.token_hash=? AND s.expires_at>?',
    ).get(hashToken(token), Date.now());
    if (!user) fail(401, 'Please sign in.');
    return user;
  }
  logout(token) {
    cached(this.db, 'DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  }
  switchCompany(user, companyId, token) {
    if (
      typeof companyId !== 'string' ||
      !cached(
        this.db,
        'SELECT company_id FROM memberships WHERE user_id=? AND company_id=? AND removed_at IS NULL',
      ).get(user.id, companyId)
    )
      fail(403, 'You are not a member of that company.');
    cached(this.db, 'UPDATE sessions SET company_id=? WHERE token_hash=? AND user_id=?').run(
      companyId,
      hashToken(token),
      user.id,
    );
  }

  // ---------- Server administrator and server settings (audit D4, D5, D6) ----------
  // The administrator runs this server: sees file paths, backs up the whole server and changes the settings below. SCAFFOLD_ADMIN_EMAIL, if set, names them instead.
  // Nobody else can make an account with that email once the server has users (not by invitation, not by sign-up), so naming an email that has no account yet cannot hand the server to whoever claims it first.
  isAdmin(user) {
    const named = namedAdmin();
    if (named) return String(user?.email ?? '').toLowerCase() === named;
    return !!cached(this.db, 'SELECT 1 FROM server_admins WHERE user_id=?').get(user?.id);
  }
  reservedAdminEmail(email) {
    if (namedAdmin() === email && cached(this.db, 'SELECT 1 FROM users LIMIT 1').get())
      fail(
        403,
        'That email is kept for the person who runs this server. Make its account on the first start, before anyone else.',
      );
  }
  // Is this the server administrator, and is this their only company? A removal must never lock them out of the server's backups and settings.
  adminsLastCompany(userId, companyId) {
    const named = namedAdmin(),
      admin = named
        ? cached(this.db, 'SELECT 1 FROM users WHERE id=? AND email=?').get(userId, named)
        : cached(this.db, 'SELECT 1 FROM server_admins WHERE user_id=?').get(userId);
    return (
      !!admin &&
      !cached(this.db, 'SELECT 1 FROM memberships WHERE user_id=? AND company_id<>? AND removed_at IS NULL').get(
        userId,
        companyId,
      )
    );
  }
  requireAdmin(user) {
    if (!this.isAdmin(user)) fail(403, 'Only the person who runs this server can do that.');
  }
  setting(key) {
    return cached(this.db, 'SELECT value FROM server_settings WHERE key=?').get(key)?.value ?? null;
  }
  // New companies can sign up on a new server (no one yet), when SCAFFOLD_OPEN_REGISTRATION=1 (tests and the browser suite), or when the administrator has switched it on.
  registrationOpen() {
    return (
      process.env.SCAFFOLD_OPEN_REGISTRATION === '1' ||
      this.setting('open_registration') === '1' ||
      !cached(this.db, 'SELECT 1 FROM users LIMIT 1').get()
    );
  }
  // lanNotice: this server was in use before Wi-Fi sharing became a switch (migration 006), so phones stopped opening it at the update. Said on Account until the settings are saved.
  serverSettings() {
    return {
      openRegistration: this.setting('open_registration') === '1',
      lanSharing: this.setting('lan_sharing') === '1',
      lanNotice: this.setting('lan_notice') === '1' && this.setting('lan_sharing') !== '1',
    };
  }
  saveServerSettings(user, input) {
    const changes = Object.entries({ openRegistration: 'open_registration', lanSharing: 'lan_sharing' }).filter(
      ([k]) => input[k] !== undefined,
    );
    if (!changes.length || changes.some(([k]) => typeof input[k] !== 'boolean')) fail(400, 'Choose on or off.');
    atomic(this.db, () => {
      for (const [k, key] of changes)
        cached(
          this.db,
          'INSERT INTO server_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ).run(key, input[k] ? '1' : '0');
      cached(this.db, "DELETE FROM server_settings WHERE key='lan_notice'").run();
      this.audit(user, 'server.settings', Object.fromEntries(changes.map(([k]) => [k, input[k]])));
    });
  }

  // ---------- Invitations (audit D2, D3) ----------
  // Everyone joins a company by an invitation they accept themselves: a one-time link, valid 7 days, of which only a hash is kept.
  // Inviting answers the same whether or not the email already signs in; an owner invites any role, a manager invites managers and supervisors.
  roleList(roles) {
    if (
      !Array.isArray(roles) ||
      !roles.length ||
      new Set(roles).size !== roles.length ||
      roles.some((r) => !ROLE_IDS.includes(r))
    )
      fail(400, 'Choose valid roles.');
    return roles;
  }
  mayInvite(user, roles) {
    const p = this.permissions(user);
    if (p.includes('users.manage') || (p.includes('operations.manage') && !roles.includes('OWNER'))) return;
    fail(403, 'Your role does not allow this action.');
  }
  invite(user, input) {
    const email = emailOf(input.email),
      roles = this.roleList(input.roles);
    this.mayInvite(user, roles);
    if (!cached(this.db, 'SELECT 1 FROM users WHERE email=?').get(email)) this.reservedAdminEmail(email);
    const name = input.name === undefined || input.name === null || input.name === '' ? null : text(input.name, 'Name');
    return atomic(this.db, () => {
      const id = randomUUID(),
        token = randomBytes(32).toString('hex'),
        expires = Date.now() + INVITE_MS;
      cached(
        this.db,
        'INSERT INTO invitations(id,token_hash,company_id,email,name,roles,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        hashToken(token),
        user.company_id,
        email,
        name,
        JSON.stringify(roles),
        user.id,
        new Date().toISOString(),
        expires,
      );
      this.audit(user, 'invitation.created', { invitationId: id, roles });
      return { id, token, expiresAt: new Date(expires).toISOString() };
    });
  }
  // An open invitation of this company (not accepted or cancelled; it may have expired) that this user may manage.
  openInvitation(user, input) {
    const row =
      typeof input?.id === 'string'
        ? cached(
            this.db,
            'SELECT * FROM invitations WHERE id=? AND company_id=? AND accepted_at IS NULL AND cancelled_at IS NULL',
          ).get(input.id, user.company_id)
        : null;
    if (!row) fail(404, 'That invitation is not open any more.');
    this.mayInvite(user, JSON.parse(row.roles));
    return row;
  }
  renewInvitation(user, input) {
    const row = this.openInvitation(user, input);
    return atomic(this.db, () => {
      const token = randomBytes(32).toString('hex'),
        expires = Date.now() + INVITE_MS;
      cached(this.db, 'UPDATE invitations SET token_hash=?,expires_at=? WHERE id=?').run(
        hashToken(token),
        expires,
        row.id,
      );
      this.audit(user, 'invitation.renewed', { invitationId: row.id });
      return { id: row.id, token, expiresAt: new Date(expires).toISOString() };
    });
  }
  cancelInvitation(user, input) {
    const row = this.openInvitation(user, input);
    atomic(this.db, () => {
      cached(this.db, 'UPDATE invitations SET cancelled_at=? WHERE id=?').run(new Date().toISOString(), row.id);
      this.audit(user, 'invitation.cancelled', { invitationId: row.id });
    });
  }
  invitations(user) {
    const p = this.permissions(user);
    if (!p.includes('users.manage') && !p.includes('operations.manage')) return [];
    const now = Date.now();
    return cached(
      this.db,
      'SELECT id,email,name,roles,expires_at FROM invitations WHERE company_id=? AND accepted_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 50',
    )
      .all(user.company_id)
      .map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        roles: JSON.parse(r.roles),
        expiresAt: new Date(r.expires_at).toISOString(),
        expired: r.expires_at <= now,
      }));
  }
  // Also refused: a link from someone who has since been removed from the company, or who may no longer invite those roles.
  validInvitation(token) {
    const row =
      typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)
        ? cached(
            this.db,
            'SELECT i.*,c.name company,u.name inviter FROM invitations i JOIN companies c ON c.id=i.company_id JOIN users u ON u.id=i.invited_by JOIN memberships m ON m.company_id=i.company_id AND m.user_id=i.invited_by AND m.removed_at IS NULL WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at>?',
          ).get(hashToken(token), Date.now())
        : null;
    const p = row ? this.permissions({ id: row.invited_by, company_id: row.company_id }) : [];
    if (
      !row ||
      !(p.includes('users.manage') || (p.includes('operations.manage') && !JSON.parse(row.roles).includes('OWNER')))
    )
      fail(404, 'This invitation link has expired or has already been used. Ask for a new one.');
    return row;
  }
  // What the invitation page shows. The same for every email: it never says whether the email already signs in.
  invitationDetails(token) {
    const row = this.validInvitation(token);
    return {
      company: row.company,
      invitedBy: row.inviter,
      email: row.email,
      name: row.name,
      roles: JSON.parse(row.roles),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
  // The invitee says yes: a new person sets their own password; someone who already signs in confirms with their own password. Returns a session in the inviting company.
  // The same answer whether or not the email already signs in (D3): a 12-128 character password is checked first, and a wrong password for an existing
  // sign-in, or a new person's missing name, get the one reply below. (Only someone who knows the existing password can tell the two apart.)
  acceptInvitation(input) {
    const row = this.validInvitation(input.token);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name : row.name,
      password = input.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, JOIN_FAIL);
    return atomic(this.db, () => {
      const existing = cached(this.db, 'SELECT id,password_hash FROM users WHERE email=?').get(row.email);
      let userId;
      if (!existing) {
        this.reservedAdminEmail(row.email);
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
          matches(password, this.dummyHash);
          fail(400, JOIN_FAIL);
        }
      } // the same work as checking a password
      if (existing) {
        if (!matches(password, existing.password_hash)) fail(400, JOIN_FAIL);
        userId = existing.id;
        const member = cached(this.db, 'SELECT removed_at FROM memberships WHERE company_id=? AND user_id=?').get(
          row.company_id,
          userId,
        );
        if (!member)
          cached(this.db, 'INSERT INTO memberships(company_id,user_id) VALUES(?,?)').run(row.company_id, userId);
        else if (member.removed_at)
          cached(this.db, 'UPDATE memberships SET removed_at=NULL WHERE company_id=? AND user_id=?').run(
            row.company_id,
            userId,
          );
      } else userId = this.createUser(row.company_id, { name, email: row.email, password }).id;
      for (const role of JSON.parse(row.roles))
        cached(this.db, 'INSERT OR IGNORE INTO user_roles VALUES(?,?,?)').run(row.company_id, userId, role);
      if (
        cached(this.db, 'UPDATE invitations SET accepted_at=?,accepted_by=? WHERE id=? AND accepted_at IS NULL').run(
          new Date().toISOString(),
          userId,
          row.id,
        ).changes !== 1
      )
        fail(404, 'This invitation link has already been used.');
      this.audit({ id: userId, company_id: row.company_id }, 'invitation.accepted', { invitationId: row.id });
      return this.session(userId, row.company_id);
    });
  }
  // An owner removes someone from this company: their roles here go and their sessions here end at once. Their sign-in, their other companies and the history stay.
  removeMember(user, input) {
    this.require(user, 'users.manage');
    const userId = input?.userId;
    if (typeof userId !== 'string') fail(400, 'Choose a person.');
    if (userId === user.id) fail(409, 'You cannot remove yourself.');
    atomic(this.db, () => {
      if (
        !cached(this.db, 'SELECT 1 FROM memberships WHERE company_id=? AND user_id=? AND removed_at IS NULL').get(
          user.company_id,
          userId,
        )
      )
        fail(404, 'That person is not in this company.');
      const owners = cached(
        this.db,
        "SELECT ur.user_id FROM user_roles ur JOIN memberships m ON m.company_id=ur.company_id AND m.user_id=ur.user_id AND m.removed_at IS NULL WHERE ur.company_id=? AND ur.role='OWNER'",
      )
        .all(user.company_id)
        .map((r) => r.user_id);
      if (owners.includes(userId) && owners.length < 2) fail(409, 'A company needs at least one owner.');
      if (this.adminsLastCompany(userId, user.company_id))
        fail(
          409,
          'This person runs Scaffold Yard on this computer and this is their only company, so they cannot be removed.',
        );
      cached(this.db, 'DELETE FROM user_roles WHERE company_id=? AND user_id=?').run(user.company_id, userId);
      cached(this.db, 'UPDATE memberships SET removed_at=? WHERE company_id=? AND user_id=?').run(
        new Date().toISOString(),
        user.company_id,
        userId,
      );
      cached(this.db, 'DELETE FROM sessions WHERE user_id=? AND company_id=?').run(userId, user.company_id);
      // Their open invitations here go too: the ones they made, and any to their own email, so a removed person cannot let themselves back in.
      cached(
        this.db,
        'UPDATE invitations SET cancelled_at=? WHERE company_id=? AND accepted_at IS NULL AND cancelled_at IS NULL AND (invited_by=? OR email=(SELECT email FROM users WHERE id=?))',
      ).run(new Date().toISOString(), user.company_id, userId, userId);
      this.audit(user, 'membership.removed', { userId });
    });
  }
  // memo is set only while one Simulation.snapshot runs (same user object), so a snapshot asks SQLite once.
  permissions(user) {
    if (this.memo && this.memo.user === user) return [...this.memo.list];
    return cached(
      this.db,
      'SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role=ur.role WHERE ur.company_id=? AND ur.user_id=?',
    )
      .all(user.company_id, user.id)
      .map((x) => x.permission);
  }
  require(user, permission) {
    if (!this.permissions(user).includes(permission)) fail(403, 'Your role does not allow this action.');
  }
  saveSystems(user, ids) {
    cached(this.db, 'UPDATE company_systems SET enabled=0 WHERE company_id=?').run(user.company_id);
    for (const id of ids)
      cached(
        this.db,
        'INSERT INTO company_systems VALUES(?,?,1) ON CONFLICT(company_id,system_id) DO UPDATE SET enabled=1',
      ).run(user.company_id, id);
  }
  updateCompany(user, input) {
    this.require(user, 'company.manage');
    const name = text(input.name, 'Company name'),
      ids = this.systems(input.systems);
    atomic(this.db, () => {
      cached(this.db, 'UPDATE companies SET name=? WHERE id=?').run(name, user.company_id);
      this.saveSystems(user, ids);
      this.audit(user, 'company.updated', { systems: ids });
    });
  }
  addUser(user, input) {
    this.require(user, 'users.manage');
    if (
      !Array.isArray(input.roles) ||
      !input.roles.length ||
      new Set(input.roles).size !== input.roles.length ||
      input.roles.some((r) => !['OWNER', 'GENERAL_MANAGER', 'SUPERVISOR'].includes(r))
    )
      fail(400, 'Choose valid roles.');
    return atomic(this.db, () => {
      const created = this.createUser(user.company_id, input);
      for (const role of input.roles)
        cached(this.db, 'INSERT INTO user_roles VALUES(?,?,?)').run(user.company_id, created.id, role);
      this.audit(user, 'user.created', { userId: created.id, roles: input.roles });
      return { id: created.id };
    });
  }
  snapshot(user) {
    const permissions = this.permissions(user);
    return {
      user,
      permissions,
      admin: this.isAdmin(user),
      memberships: cached(
        this.db,
        'SELECT c.id,c.name FROM companies c JOIN memberships m ON m.company_id=c.id AND m.removed_at IS NULL WHERE m.user_id=?',
      ).all(user.id),
      company: cached(this.db, 'SELECT id,name FROM companies WHERE id=?').get(user.company_id),
      systems: cached(
        this.db,
        'SELECT s.id,s.name,COALESCE(cs.enabled,0) enabled FROM scaffold_systems s LEFT JOIN company_systems cs ON cs.system_id=s.id AND cs.company_id=? ORDER BY s.name',
      ).all(user.company_id),
      roles: cached(this.db, 'SELECT role FROM user_roles WHERE company_id=? AND user_id=? ORDER BY role')
        .all(user.company_id, user.id)
        .map((r) => r.role),
      users: permissions.includes('users.manage')
        ? cached(
            this.db,
            "SELECT u.id,u.name,u.email,(SELECT group_concat(r.role,',') FROM user_roles r WHERE r.company_id=m.company_id AND r.user_id=u.id) roles FROM users u JOIN memberships m ON m.user_id=u.id AND m.removed_at IS NULL WHERE m.company_id=? ORDER BY u.name",
          ).all(user.company_id)
        : [],
      invitations: this.invitations(user),
      audit: permissions.includes('company.manage')
        ? cached(
            this.db,
            'SELECT action,created_at FROM audit_events WHERE company_id=? ORDER BY created_at DESC LIMIT 20',
          ).all(user.company_id)
        : [],
    };
  }
}
