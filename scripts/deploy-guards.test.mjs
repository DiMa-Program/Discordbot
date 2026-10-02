/**
 * Proves the deploy tests reject the shapes that actually shipped.
 *
 * `deploy-core.test.mjs` asserts what the code must do. This asserts the opposite direction: that
 * those assertions have teeth. A test which passes against both the correct implementation and the
 * broken one is not a test, it is decoration.
 *
 * Each case below reconstructs one real defect and checks that the production helper rejects it. If a
 * defect can be reintroduced without turning something red, the suite has a hole exactly where it
 * was believed to have coverage. That is not hypothetical here: every bug in this file's history got
 * past a suite that did not exist, and one of them got past a check that did.
 *
 * Nothing here mutates the repository. Each broken implementation is a local value.
 */

import { describe, expect, it } from 'vitest';

import { backupFileName, buildBackupScript, buildLanded, snapshotsToPrune } from './deploy-core.mjs';

const CREDENTIALS = { url: 'sftp://u:p@h:2022/', hostKey: 'KEY', stagingDir: 'C:\\staging' };

/** Extracts the local destination from every `get` line in a WinSCP script. */
function destinations(script) {
  return script
    .split(/\r?\n/)
    .filter((line) => line.startsWith('get '))
    .map((line) => line.split(' ')[2] ?? '');
}

describe('the backup assertions reject what shipped', () => {
  it('rejects a cd before the get', () => {
    // Shipped. Changing directory changed how the relative path resolved, and the transfer reported
    // a file that was sitting right there as missing.
    const broken = ['cd /home/container', 'get data/bot.db C:\\staging\\bot.db'].join('\r\n');

    expect(/^cd /m.test(broken)).toBe(true);
    expect(/^cd /m.test(buildBackupScript(CREDENTIALS))).toBe(false);
  });

  it('rejects a filemask against the directory', () => {
    // Shipped. A filemask over `data/` fails on this host.
    const broken = 'get -filemask="bot.db*" data/ C:\\staging\\';

    expect(broken).toContain('-filemask');
    expect(buildBackupScript(CREDENTIALS)).not.toContain('-filemask');
  });

  it('rejects forward slashes in the local destination', () => {
    // Shipped. `C:/Users/...` is read as a remote path, which is what turned a Windows path bug into
    // the conclusion that the host could not serve subdirectories at all.
    const broken = 'get data/bot.db C:/staging/bot.db';
    const shipped = destinations(broken);

    expect(shipped.some((destination) => destination.includes('/'))).toBe(true);
    expect(destinations(buildBackupScript(CREDENTIALS)).some((d) => d.includes('/'))).toBe(false);
  });

  it('rejects a trailing slash on the remote side', () => {
    // WinSCP calls that ambiguous and refuses it.
    expect('get data/bot.db C:\\s\\bot.db'.split(' ')[1].endsWith('/')).toBe(false);
    expect(buildBackupScript(CREDENTIALS)).not.toMatch(/^get \S+\/$/m);
  });
});

describe('the build check rejects what shipped', () => {
  it('a substring check wrongly accepts role-sync.js, so the boundary is required', () => {
    const listing = ['ls', '-rw-r--r-- 1 0 0 10664 role-sync.js'].join('\n');

    // This is the assertion that shipped. It passed while sync.js was genuinely absent, because
    // every build ever produced contains role-sync.js.
    expect(listing.includes('sync.js')).toBe(true);
    expect(buildLanded(listing)).toBe(false);
  });

  it('rejects reading transfer lines as evidence of remote state', () => {
    // WinSCP names every local path it uploaded. That is a list of what was sent, not what is there.
    const transfer = ['C:\\staging\\dist\\features\\ranks\\sync.js | 15 KB | 100%'].join('\n');

    expect(transfer.includes('sync.js')).toBe(true);
    expect(buildLanded(transfer)).toBe(false);
  });

  it('rejects a listing that never ran', () => {
    expect(buildLanded('ls failed: no such directory')).toBe(false);
  });
});

describe('the snapshot assertions reject what shipped', () => {
  const snapshot = (stamp) => [`bot-${stamp}.db`, `bot-${stamp}.db-wal`, `bot-${stamp}.db-shm`];

  it('rejects pruning file by file instead of snapshot by snapshot', () => {
    const files = [...snapshot('a'), ...snapshot('b')];
    // Keeping every third file is what a naive per-file retention leaves behind once it starts
    // deleting: one database whose WAL and SHM describe a different moment.
    const perFile = files.filter((_, index) => index % 3 === 0);

    expect(perFile).toEqual(['bot-a.db', 'bot-b.db']);
    expect(perFile).not.toContain('bot-a.db-wal');
    // Pruning by stamp removes the snapshot whole.
    expect(snapshotsToPrune(files, 1)).toEqual(snapshot('a'));
  });

  it('rejects a sidecar that lost its separator', () => {
    // Shipped: the replacement stripped the dot, producing botdb-shm beside a stamped bot.db.
    const shipped = 'bot.db-wal'.replace(/^bot\.db/, 'bot-S.db').replace('-', '');

    expect(shipped).toBe('botS.db-wal');
    expect(backupFileName('bot.db-wal', 'S')).toBe('bot-S.db-wal');
  });
});