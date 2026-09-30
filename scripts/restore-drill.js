// Restore drill: restores the newest backup into a temporary folder, runs a full integrity check, compares its row counts with the
// live database, and adds one line to restore-drill.log in the backup folder (Account > Backups shows the last drill). The live
// database and the backups are only read, never changed.
//   npm run restore-drill                    the newest normal backup
//   npm run restore-drill -- --encrypted     the newest encrypted copy (asks for the passphrase, or reads SCAFFOLD_BACKUP_PASSPHRASE)
//   npm run restore-drill -- --file=<path>   one particular backup or encrypted copy
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDatabasePath, backupDirectory, backupName } from '../src/paths.js';
import { offsiteSettingsPath, restoreDrill } from '../src/protect.js';
import { askPassphrase } from './ask-passphrase.js';
const databasePath = resolveDatabasePath(),
  directory = backupDirectory(),
  name = backupName({ databasePath });
let offsiteFolder = null;
try {
  offsiteFolder = JSON.parse(readFileSync(offsiteSettingsPath(databasePath), 'utf8')).folder ?? null;
} catch {}
const file = process.argv.find((a) => a.startsWith('--file='))?.slice(7) || null,
  encrypted = process.argv.includes('--encrypted');
const r = await restoreDrill({
  databasePath,
  directory,
  name,
  offsiteFolder,
  file,
  encrypted,
  passphrase: askPassphrase,
});
console.log(
  `Restore drill ${r.ok ? 'PASSED' : 'FAILED'}${r.file ? ` for ${r.encrypted ? 'the encrypted copy' : 'the backup'} ${r.file}` : ''} (${(r.ms / 1000).toFixed(1)} s)`,
);
if (r.integrity) console.log(`  integrity: ${r.integrity}`);
if (r.rows) {
  console.log('  table                     backup      now');
  for (const [t, n] of Object.entries(r.rows))
    console.log(`  ${t.padEnd(24)}${String(n).padStart(8)}${String(r.live?.[t] ?? '-').padStart(9)}`);
}
if (r.error) console.log(`  ${r.error.replace(/\.+$/, '')}.`);
console.log(
  r.notLogged
    ? '  Nothing was restored, so this is not logged as a drill.'
    : r.logError
      ? `  The result could not be written to the drill log: ${r.logError}`
      : `  Logged in ${join(directory, 'restore-drill.log')}`,
);
process.exitCode = r.ok ? 0 : 1;
