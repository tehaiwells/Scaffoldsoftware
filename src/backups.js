import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stamp } from './relocate.js';
import { AppError } from './service.js';
import {
  createBackupKey,
  encryptBackup,
  ENCRYPTED_SUFFIX,
  offsiteSettingsPath,
  readDrillLog,
  restoreDrill,
} from './protect.js';

// Automatic backups: <name>-YYYY-MM-DD.sqlite, one per day. "Back up now" writes <name>-YYYY-MM-DDTHH-MM-SS-manual.sqlite; the 10 newest of those are kept.
// <name> is "scaffold" for the app's own database and names any other (DATABASE_PATH) database uniquely (backupName in paths.js), so databases sharing a folder never mix.
// Is child the same folder as parent, or inside it? Windows folder names ignore letter case (E:\Backups is e:\backups).
const win = process.platform === 'win32',
  fold = (p) => (win ? resolve(p).toLowerCase() : resolve(p));
export const sameOrInside = (parent, child) => {
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
// A folder for the encrypted copy: a full path on a drive of this PC (E:\ or C:\...). Never a network share (\\server\share): even looking at one
// makes Windows sign in to that server, and a share is not "a drive you keep somewhere else" anyway.
export const localFolderPath = (folder) => {
  const f = typeof folder === 'string' ? folder.trim() : '';
  if (!f || f.length > 400 || /^[\\/]{2}/.test(f)) return null;
  return (win ? /^[A-Za-z]:[\\/]/.test(f) : isAbsolute(f)) ? f : null;
};
const DAY = 86400000,
  escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = (name) => {
  const n = escapeRe(name);
  return {
    daily: new RegExp(`^${n}-(\\d{4})-(\\d{2})-(\\d{2})\\.sqlite$`),
    manual: new RegExp(`^${n}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-manual\\.sqlite$`),
    partial: new RegExp(
      `^${n}-\\d{4}-\\d{2}-\\d{2}(T\\d{2}-\\d{2}-\\d{2}-manual)?\\.sqlite\\.partial(-wal|-shm|-journal)?$`,
    ),
  };
};
const localDate = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
};
export const dailyName = (date = new Date(), name = 'scaffold') => `${name}-${localDate(date)}.sqlite`;
// Day number of a daily file name's date, or null when it is not a real calendar date (e.g. 2026-13-01 or 2026-02-31).
const dayNumber = (match) => {
  if (!match) return null;
  const [y, m, d] = [+match[1], +match[2], +match[3]],
    at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? at.getTime() / DAY : null;
};
// ISO-style week key (weeks start on Monday) for a day number.
const weekOf = (day) => Math.floor((day + 3) / 7);

// Pure rotation rule. Keeps the 14 newest daily backups, plus the newest daily backup of each of the last 8 weeks (counting back from `today`), and the 10 newest "Back up now" copies.
// Only this database's files named exactly <name>-YYYY-MM-DD.sqlite or <name>-<date>T<time>-manual.sqlite are ever removed; every other file is left alone.
// Daily files dated after today (from a clock that was wrong for a while) or with an impossible date are left alone and never push real backups out of the 14.
export function planRotation(
  names,
  today = new Date(),
  { daily = 14, weeks = 8, manual = 10, name = 'scaffold' } = {},
) {
  const { daily: DAILY, manual: MANUAL } = patterns(name),
    todayNumber = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / DAY,
    thisWeek = weekOf(todayNumber);
  const dated = names
      .map((n) => ({ n, day: dayNumber(DAILY.exec(n)) }))
      .filter((x) => x.day !== null && x.day <= todayNumber)
      .sort((a, b) => b.day - a.day),
    keep = new Set(dated.slice(0, daily).map((x) => x.n)),
    seen = new Set();
  for (const { n, day } of dated) {
    const week = weekOf(day);
    if (thisWeek - week < weeks && !seen.has(week)) {
      seen.add(week);
      keep.add(n);
    }
  }
  const manuals = names
    .filter((n) => MANUAL.test(n))
    .sort()
    .reverse();
  return {
    keep: dated.map((x) => x.n).filter((n) => keep.has(n)),
    remove: [...dated.map((x) => x.n).filter((n) => !keep.has(n)), ...manuals.slice(manual)],
    keepManual: manuals.slice(0, manual),
  };
}

// Runs inside the server process. Backups read the live file through their own read-only connection and copy it in one step on a worker thread,
// so they never run inside a scheduler transaction and never block the event loop for the copy itself (WAL readers do not block the writer).
// Encrypted copy (optional, set up in Account > Backups): after every backup, the same file encrypted (src/protect.js) into a folder the
// administrator chose (a USB drive, another synced folder). Its settings (the folder and a passphrase-locked key) are in settingsPath.
export function createBackups({
  databasePath,
  directory,
  name = 'scaffold',
  log = console.log,
  now = () => new Date(),
  minGapMs = 60000,
  keepManual = 10,
  settingsPath,
  keyCost,
} = {}) {
  databasePath = resolve(databasePath);
  directory = resolve(directory);
  settingsPath = resolve(settingsPath ?? offsiteSettingsPath(databasePath));
  const { daily: DAILY, manual: MANUAL, partial: PARTIAL } = patterns(name);
  let running = null,
    lastAttempt = null,
    lastError = null,
    lastManual = 0,
    timer = null,
    startTimer = null,
    lastCopy = null;
  const readSettings = () => {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      return s?.folder && s?.key?.publicKey ? s : null;
    } catch {
      return null;
    }
  };
  // The encrypted copy of one finished backup. Never fails the backup itself: a missing folder (USB drive not plugged in) is reported and retried next time.
  const copyEncrypted = (file, settings = readSettings()) => {
    if (!settings) return null;
    const when = now();
    try {
      let ok = false;
      if (localFolderPath(settings.folder))
        try {
          ok = statSync(settings.folder).isDirectory();
        } catch {}
      if (!ok)
        throw new Error(
          `the folder ${settings.folder} is not there (is the USB drive plugged in?). The next backup will try again`,
        );
      const dest = join(settings.folder, basename(file) + ENCRYPTED_SUFFIX);
      encryptBackup(file, dest, settings.key);
      const names = readdirSync(settings.folder)
        .filter((n) => n.endsWith(ENCRYPTED_SUFFIX))
        .map((n) => n.slice(0, -ENCRYPTED_SUFFIX.length));
      for (const old of planRotation(names, when, { name, manual: keepManual }).remove)
        try {
          rmSync(join(settings.folder, old + ENCRYPTED_SUFFIX));
        } catch {}
      lastCopy = { at: when.toISOString(), ok: true, file: dest };
      log(`Encrypted copy saved: ${dest}`);
    } catch (error) {
      lastCopy = { at: when.toISOString(), ok: false, error: error.message };
      log(`Encrypted copy NOT saved: ${error.message}`);
    }
    return lastCopy;
  };
  const list = () => {
    try {
      return readdirSync(directory)
        .filter((n) => DAILY.test(n) || MANUAL.test(n))
        .map((file) => ({ name: file, at: statSync(join(directory, file)).mtimeMs, manual: MANUAL.test(file) }))
        .sort((a, b) => b.at - a.at);
    } catch {
      return [];
    }
  };
  // Unfinished copies of this database left by a server that stopped mid-backup.
  const sweep = () => {
    if (running) return;
    let names = [];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const file of names.filter((n) => PARTIAL.test(n)))
      try {
        rmSync(join(directory, file), { force: true });
      } catch (error) {
        log(`Could not remove the unfinished backup ${file}: ${error.message}`);
      }
  };
  async function run(file) {
    if (running) return running;
    running = (async () => {
      const when = now(),
        path = join(directory, file),
        partial = `${path}.partial`;
      let source = null;
      try {
        if (databasePath === ':memory:' || !existsSync(databasePath))
          throw new Error('there is no database file to back up');
        if (existsSync(path)) throw new Error(`${file} already exists`);
        mkdirSync(directory, { recursive: true });
        removeSet(partial);
        source = new DatabaseSync(databasePath, { readOnly: true });
        await backup(source, partial, { rate: 1000000 });
        source.close();
        source = null;
        const copy = new DatabaseSync(partial);
        try {
          const check = copy.prepare('PRAGMA quick_check').get();
          if (Object.values(check)[0] !== 'ok') throw new Error('the copy failed its check');
          copy.exec('PRAGMA journal_mode=DELETE');
        } finally {
          copy.close();
        }
        renameSync(partial, path);
        const removed = [];
        for (const old of planRotation(readdirSync(directory), when, { name, manual: keepManual }).remove) {
          try {
            rmSync(join(directory, old));
            removed.push(old);
          } catch (error) {
            log(`Backup rotation could not remove ${old}: ${error.message}`);
          }
        }
        lastAttempt = { at: when.getTime(), ok: true, file: path };
        lastError = null;
        copyEncrypted(path);
        log(
          `Backup saved: ${path}${removed.length ? ` (removed ${removed.length} old backup${removed.length > 1 ? 's' : ''}: ${removed.join(', ')})` : ''}`,
        );
        return { ok: true, file: path, removed };
      } catch (error) {
        try {
          source?.close();
        } catch {}
        try {
          removeSet(partial);
        } catch {}
        lastAttempt = { at: when.getTime(), ok: false };
        lastError = error.message;
        log(`Backup FAILED (${error.message}). The live database was not changed.`);
        return { ok: false, error: error.message };
      } finally {
        running = null;
      }
    })();
    return running;
  }
  const newestDaily = () => list().find((b) => !b.manual);
  // Once a day: the first check after midnight (checks run hourly) makes that day's file. At start-up: only if the newest daily backup is older than 24 h.
  const due = (startup = false) => {
    if (existsSync(join(directory, dailyName(now(), name)))) return false;
    const newest = newestDaily();
    return !newest || !startup || now().getTime() - newest.at >= DAY;
  };
  const tick = async (startup) => {
    if (due(startup)) await run(dailyName(now(), name));
  };
  return {
    directory,
    databasePath,
    name,
    run,
    due,
    tick,
    list,
    sweep,
    // Delay the start-up backup a little so it never competes with the first page loads, then check hourly.
    start({ startupDelayMs = 30000, intervalMs = 3600000 } = {}) {
      sweep();
      startTimer = setTimeout(() => tick(true), startupDelayMs);
      startTimer.unref();
      timer = setInterval(() => tick(false), intervalMs);
      timer.unref();
    },
    stop() {
      clearTimeout(startTimer);
      clearInterval(timer);
    },
    async backupNow() {
      if (running) return { ok: false, busy: true, error: 'A backup is already running. Try again in a moment.' };
      const wait = lastManual + minGapMs - Date.now();
      if (wait > 0)
        return {
          ok: false,
          busy: true,
          error: `A backup was made moments ago. Try again in ${Math.ceil(wait / 1000)} s.`,
        };
      lastManual = Date.now();
      return run(`${name}-${stamp(now())}-manual.sqlite`);
    },
    // Turns the encrypted copy on (a folder that exists, a passphrase that is never stored) and copies the newest backup there at once.
    async setOffsite({ folder, passphrase } = {}) {
      if (typeof folder === 'string' && /^[\\/]{2}/.test(folder.trim()))
        throw new AppError(
          400,
          'Choose a folder on a drive of this computer, such as a USB drive (E:\\), not a network share.',
        );
      if (!localFolderPath(folder))
        throw new AppError(400, 'Type the full folder path, for example E:\\ for a USB drive.');
      folder = resolve(folder.trim());
      // checked before the folder is looked at: the normal backup folder (or one inside it) and the live database's own folder are not "somewhere else"
      if (sameOrInside(directory, folder) || fold(folder) === fold(dirname(databasePath)))
        throw new AppError(
          400,
          'Choose a different place from the normal backup folder and the live database, such as a USB drive.',
        );
      let ok = false;
      try {
        ok = statSync(folder).isDirectory();
      } catch {}
      if (!ok)
        throw new AppError(400, 'That folder was not found. Plug in the drive (or make the folder) and try again.');
      const probe = join(folder, `.scaffold-yard-write-test-${process.pid}`);
      try {
        writeFileSync(probe, 'ok');
        rmSync(probe);
      } catch {
        throw new AppError(400, 'Scaffold Yard cannot write to that folder.');
      }
      const key = createBackupKey(passphrase, keyCost),
        settings = { folder, key, since: now().toISOString() };
      const partial = settingsPath + '.partial';
      mkdirSync(resolve(settingsPath, '..'), { recursive: true });
      writeFileSync(partial, JSON.stringify(settings, null, 1), { mode: 0o600 });
      renameSync(partial, settingsPath);
      lastCopy = null;
      const newest = list()[0];
      if (newest) copyEncrypted(join(directory, newest.name), settings);
      return this.status();
    },
    clearOffsite() {
      rmSync(settingsPath, { force: true });
      lastCopy = null;
    },
    // Account > Backups "Test the newest backup": the restore drill on the newest normal backup (read-only; logged like npm run restore-drill).
    async drill() {
      if (running) throw new AppError(429, 'A backup is being made. Try again in a moment.');
      return restoreDrill({ databasePath, directory, name, now });
    },
    status() {
      const all = list(),
        last = all[0],
        settings = readSettings(),
        drill = readDrillLog(directory);
      return {
        databasePath,
        directory,
        offsite: settings
          ? { configured: true, folder: settings.folder, since: settings.since, lastCopy }
          : { configured: false },
        lastDrill: drill && { at: drill.at, ok: drill.ok, encrypted: !!drill.encrypted },
        lastBackup: last ? { name: last.name, at: new Date(last.at).toISOString(), manual: last.manual } : null,
        daily: all.filter((b) => !b.manual).length,
        manual: all.filter((b) => b.manual).length,
        lastError,
        lastAttempt: lastAttempt && { at: new Date(lastAttempt.at).toISOString(), ok: lastAttempt.ok },
        running: !!running,
        policy: `The 14 newest daily backups are kept, plus one per week for 8 weeks, and the ${keepManual} newest made with “Back up now”.`,
      };
    },
  };
}
const removeSet = (path) => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
};
