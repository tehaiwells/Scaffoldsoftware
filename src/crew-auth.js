// @ts-check
// A driver's phone (ADR 0009, audit thin #5). The office makes a one-time link for a driver on the team; the phone opens it and becomes a
// device signed in for that driver only: long-lived (180 days, renewed while it is used), revocable from the office ("Sign out this phone")
// or the phone itself. A driver's first link makes their CREW sign-in: a member of the company with the CREW role (permission
// trips.confirm) and no password, so it can never sign in to the Office. The device cookie ('crew') opens /api/crew/* only (server.js).
// Only hashes of tokens are kept. A driver who leaves the team (or is removed from the company) is signed out everywhere at once.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { atomic, cached } from './database.js';
import { AppError } from './service.js';

export const CREW_LINK_MS = 7 * 86400000,
  CREW_DEVICE_MS = 180 * 86400000,
  CREW_RENEW_MS = 3600000;
const hash = (/** @type {string} */ t) => createHash('sha256').update(t).digest('hex');
const fail = (/** @type {number} */ status, /** @type {string} */ message) => {
  throw new AppError(status, message);
};
const TOKEN = /^[0-9a-f]{64}$/;
/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {{id:string,company_id:string,name:string,email:string,crew?:{driver:string,device:string}}} User */

/** @param {Db} db @param {string} company @param {string} id */
function activeDriver(db, company, id) {
  const row =
    typeof id === 'string'
      ? cached(db, "SELECT data FROM objects WHERE company_id=? AND id=? AND kind='driver'").get(company, id)
      : null;
  const d = row ? JSON.parse(row.data) : null;
  return d && d.active ? { id, ...d } : null;
}
// The office makes a sign-in link for one driver (operations.manage, a real yard only). Returns the token once; only its hash is kept.
/** @param {import('./service.js').Service} service @param {User} user @param {any} input */
export function crewLink(service, user, input) {
  const db = service.db;
  service.require(user, 'operations.manage');
  if (cached(db, 'SELECT mode FROM companies WHERE id=?').get(user.company_id)?.mode !== 'LIVE')
    fail(409, 'Phone links are for your real yard only.');
  const driver = activeDriver(db, user.company_id, input?.driver);
  if (!driver) fail(404, 'Choose a driver from your team.');
  return atomic(db, () => {
    let userId = cached(
      db,
      'SELECT user_id FROM crew_links WHERE company_id=? AND driver_id=? ORDER BY created_at LIMIT 1',
    ).get(user.company_id, driver.id)?.user_id;
    if (!userId) {
      userId = randomUUID();
      cached(db, 'INSERT INTO users(id,company_id,name,email,password_hash) VALUES(?,?,?,?,?)').run(
        userId,
        user.company_id,
        driver.name,
        'crew.' + userId + '@crew.invalid',
        '!crew-no-password',
      );
      cached(db, 'INSERT INTO memberships(company_id,user_id) VALUES(?,?)').run(user.company_id, userId);
    } else {
      cached(db, 'UPDATE users SET name=? WHERE id=?').run(driver.name, userId);
      cached(db, 'UPDATE memberships SET removed_at=NULL WHERE company_id=? AND user_id=?').run(
        user.company_id,
        userId,
      );
    }
    cached(db, "INSERT OR IGNORE INTO user_roles VALUES(?,?,'CREW')").run(user.company_id, userId);
    const id = randomUUID(),
      token = randomBytes(32).toString('hex'),
      expires = Date.now() + CREW_LINK_MS;
    cached(
      db,
      'INSERT INTO crew_links(id,token_hash,company_id,driver_id,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, hash(token), user.company_id, driver.id, userId, user.id, new Date().toISOString(), expires);
    service.audit(user, 'crew.link.created', { driver: driver.id, link: id });
    return {
      id,
      token,
      expiresAt: new Date(expires).toISOString(),
      driver: { id: driver.id, name: driver.name, mobile: driver.mobile ?? null },
    };
  });
}
// The phone opens its link: the link is used up and this phone becomes a signed-in device for that driver. Returns the device token.
/** @param {import('./service.js').Service} service @param {any} input */
export function crewClaim(service, input) {
  const db = service.db,
    token = input?.token;
  const link =
    typeof token === 'string' && TOKEN.test(token)
      ? cached(
          db,
          "SELECT l.*,c.name company FROM crew_links l JOIN companies c ON c.id=l.company_id AND c.mode='LIVE' JOIN memberships m ON m.company_id=l.company_id AND m.user_id=l.user_id AND m.removed_at IS NULL WHERE l.token_hash=? AND l.used_at IS NULL AND l.cancelled_at IS NULL AND l.expires_at>?",
        ).get(hash(token), Date.now())
      : null;
  const driver = link ? activeDriver(db, link.company_id, link.driver_id) : null;
  if (!link || !driver) fail(404, 'This link has expired or was already used. Ask the office for a new one.');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : 'Phone';
  return atomic(db, () => {
    if (
      cached(db, 'UPDATE crew_links SET used_at=? WHERE id=? AND used_at IS NULL').run(
        new Date().toISOString(),
        link.id,
      ).changes !== 1
    )
      fail(404, 'This link was already used. Ask the office for a new one.');
    const id = randomUUID(),
      device = randomBytes(32).toString('hex'),
      now = new Date().toISOString();
    cached(
      db,
      'INSERT INTO crew_devices(id,token_hash,company_id,driver_id,user_id,link_id,label,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      hash(device),
      link.company_id,
      link.driver_id,
      link.user_id,
      link.id,
      label,
      now,
      now,
      Date.now() + CREW_DEVICE_MS,
    );
    service.audit({ id: link.user_id, company_id: link.company_id }, 'crew.device.signed_in', {
      device: id,
      link: link.id,
    });
    return { token: device, device: id, driver: { id: driver.id, name: driver.name }, company: link.company };
  });
}
// A request from a driver's phone: its device, still signed in, for a driver still on the team, in a company they still belong to.
// Renews the device's 180 days at most once an hour.
/** @param {Db} db @param {string|undefined} token @returns {User} */
export function crewAuthenticate(db, token) {
  if (typeof token !== 'string' || !TOKEN.test(token))
    fail(401, 'This phone is not signed in. Ask the office for a link.');
  const row = cached(
    db,
    'SELECT d.id device,d.driver_id,d.company_id,d.last_seen_at,u.id,u.name,u.email FROM crew_devices d JOIN users u ON u.id=d.user_id JOIN memberships m ON m.company_id=d.company_id AND m.user_id=d.user_id AND m.removed_at IS NULL WHERE d.token_hash=? AND d.revoked_at IS NULL AND d.expires_at>?',
  ).get(hash(/** @type {string} */ (token)), Date.now());
  if (!row || !activeDriver(db, row.company_id, row.driver_id))
    fail(401, 'This phone is not signed in. Ask the office for a link.');
  if (Date.now() - Date.parse(row.last_seen_at) > CREW_RENEW_MS)
    cached(db, 'UPDATE crew_devices SET last_seen_at=?,expires_at=? WHERE id=?').run(
      new Date().toISOString(),
      Date.now() + CREW_DEVICE_MS,
      row.device,
    );
  return {
    id: row.id,
    company_id: row.company_id,
    name: row.name,
    email: row.email,
    crew: { driver: row.driver_id, device: row.device },
  };
}
// "Sign out this phone", from the phone itself.
/** @param {Db} db @param {User} crewUser */
export function crewSignOut(db, crewUser) {
  if (!crewUser.crew) return;
  cached(db, 'UPDATE crew_devices SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    crewUser.id,
    crewUser.crew.device,
  );
}
// The office's list of signed-in phones (and open links), per driver.
/** @param {import('./service.js').Service} service @param {User} user */
export function crewDevices(service, user) {
  const db = service.db;
  service.require(user, 'operations.manage');
  const name = (/** @type {string} */ id) => activeDriver(db, user.company_id, id)?.name ?? 'Left the team';
  const now = Date.now();
  return {
    devices: cached(
      db,
      'SELECT id,driver_id,label,created_at,last_seen_at,expires_at FROM crew_devices WHERE company_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 200',
    )
      .all(user.company_id, now)
      .map((r) => ({
        id: r.id,
        driver: r.driver_id,
        driverName: name(r.driver_id),
        label: r.label,
        signedInAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      })),
    links: cached(
      db,
      'SELECT id,driver_id,created_at,expires_at FROM crew_links WHERE company_id=? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 200',
    )
      .all(user.company_id, now)
      .map((r) => ({
        id: r.id,
        driver: r.driver_id,
        driverName: name(r.driver_id),
        createdAt: r.created_at,
        expiresAt: new Date(r.expires_at).toISOString(),
      })),
  };
}
// "Sign out this phone" from the office (operations.manage); or a link not used yet, cancelled.
/** @param {import('./service.js').Service} service @param {User} user @param {any} input */
export function crewRevoke(service, user, input) {
  const db = service.db;
  service.require(user, 'operations.manage');
  return atomic(db, () => {
    const at = new Date().toISOString();
    if (typeof input?.device === 'string') {
      if (
        cached(
          db,
          'UPDATE crew_devices SET revoked_at=?,revoked_by=? WHERE id=? AND company_id=? AND revoked_at IS NULL',
        ).run(at, user.id, input.device, user.company_id).changes !== 1
      )
        fail(404, 'That phone is already signed out.');
      service.audit(user, 'crew.device.signed_out', { device: input.device });
      return { ok: true };
    }
    if (typeof input?.link === 'string') {
      if (
        cached(
          db,
          'UPDATE crew_links SET cancelled_at=? WHERE id=? AND company_id=? AND used_at IS NULL AND cancelled_at IS NULL',
        ).run(at, input.link, user.company_id).changes !== 1
      )
        fail(404, 'That link is not open any more.');
      service.audit(user, 'crew.link.cancelled', { link: input.link });
      return { ok: true };
    }
    fail(400, 'Choose a phone or a link.');
  });
}
// The words that go with a link: how a phone reaches this server, and a text-message body for the driver.
/** @param {{link:string,driverName:string,company:string,lan:boolean,hosted:boolean}} p */
export function crewReach({ link, driverName, company, lan, hosted }) {
  const reachable = lan || hosted;
  return {
    reachable,
    words: reachable
      ? hosted
        ? 'Phones can open this link anywhere.'
        : "Phones on this computer's Wi-Fi can open this link. It is not encrypted, so use it on your own Wi-Fi only."
      : "Phones can't reach this computer yet. Turn on Wi-Fi sharing in Account, This computer (the phone must be on the same Wi-Fi), or wait for hosting.",
    text:
      'Hi ' +
      driverName +
      ', this is ' +
      company +
      '. Open this link on your phone to see your trips and tap Loaded & left and Delivered: ' +
      link,
  };
}
