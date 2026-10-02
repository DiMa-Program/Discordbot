/**
 * Tests for the deploy script's decisions.
 *
 * These exist because the deploy spent an entire afternoon reporting success while doing something
 * else. Every bug below shipped, and every one of them degraded into a warning or a green result
 * rather than an error:
 *
 *   - a host key read below the step that used it, throwing a Temporal Dead Zone error that the
 *     backup's own catch swallowed into a generic SFTP warning;
 *   - a download path written with forward slashes, which WinSCP reads as a remote path, leading to
 *     the conclusion that the host could not serve subdirectories at all;
 *   - a build check that matched `role-sync.js` when looking for `sync.js`;
 *   - exit codes treated as the result of a multi-command script;
 *   - and backup sidecars renamed so they no longer looked like part of their snapshot.
 *
 * None of those are testable by running a deploy. All of them are decisions about a string or about
 * reading output, so they are asserted directly.
 *
 * What is deliberately NOT here: any test that touches a real host. These run offline and in under a
 * second, which is the property that makes them worth having. A test that needs a deploy to run is a
 * test nobody runs before deploying.
 */

import { describe, expect, it } from 'vitest';

import {
  backupFileName,
  buildBackupScript,
  buildLanded,
  buildUploadScript,
  DATABASE_FILES,
  DEFAULT_SSH_HOST_KEY,
  redact,
  resourcesReportHealthy,
  resolveHostKey,
  restartAccepted,
  snapshotsToPrune,
  sftpUrl,
} from './deploy-core.mjs';

const CREDENTIALS = {
  user: 'dipplox.164bb413',
  password: 'hunter2',
  host: 'flm01.heavencloud.in',
  port: '2022',
};

describe('resolveHostKey', () => {
  it('pins the default so a substituted host cannot receive the password', () => {
    // Not a style preference. An unpinned key means the SFTP password goes to whatever answers on
    // that address, and the failure mode of not pinning is silent.
    expect(resolveHostKey({})).toBe(DEFAULT_SSH_HOST_KEY);
  });

  it('prefers an explicit override for a machine that moved', () => {
    expect(resolveHostKey({ HEAVEN_SFTP_HOST_KEY: 'ssh-rsa 2047 SHA256:elsewhere' })).toBe(
      'ssh-rsa 2047 SHA256:elsewhere',
    );
  });

  it('is WinSCP display form, with no SHA256 prefix and no trailing padding', () => {
    // Both of these variants were rejected as a mismatch against the server's real key.
    expect(DEFAULT_SSH_HOST_KEY).not.toMatch(/^SHA256:/);
    expect(DEFAULT_SSH_HOST_KEY).not.toMatch(/=$/);
  });
});

describe('sftpUrl', () => {
  it('encodes credentials so a special character cannot break the URL', () => {
    const url = sftpUrl({ ...CREDENTIALS, password: 'p@ss:w/rd' });

    expect(url).toContain('p%40ss%3Aw%2Frd');
    expect(url).not.toContain('p@ss');
  });
});

describe('buildBackupScript', () => {
  const script = buildBackupScript({
    url: 'sftp://u:p@h:2022/',
    hostKey: 'KEY',
    stagingDir: 'C:\\project\\staging',
  });

  it('addresses the database relative to the session root', () => {
    // An absolute remote path fails on this host with `no such file` for a file that is present. The
    // session already opens in the container home, so a relative path is both correct and required.
    expect(script).toContain('get data/bot.db ');
    expect(script).not.toMatch(/get \/home\/container/);
  });

  it('never changes directory first', () => {
    // Combined with a directory mask, a preceding `cd` changes how the path resolves and the
    // transfer reports a file that is sitting right there as missing.
    expect(script).not.toMatch(/^cd /m);
  });

  it('uses no filemask and no trailing slash on the remote side', () => {
    // A filemask against the directory fails, and WinSCP rejects a remote path ending in a slash as
    // ambiguous.
    expect(script).not.toContain('-filemask');
    expect(script).not.toMatch(/^get \S+\/$/m);
  });

  it('keeps the local destination native, with no forward slashes', () => {
    // The single change that made this look like a host problem: WinSCP reads `C:/Users/...` as a
    // remote path, so the transfer failed claiming the server had no database.
    const destinations = script
      .split('\r\n')
      .filter((line) => line.startsWith('get '))
      .map((line) => line.split(' ')[2]);

    expect(destinations).toHaveLength(DATABASE_FILES.length);
    for (const destination of destinations) {
      expect(destination).not.toContain('/');
      expect(destination).toMatch(/^[A-Za-z]:\\/);
    }
  });

  it('fetches all three SQLite files, because the database runs in WAL mode', () => {
    // `bot.db` on its own can be missing commits that only exist in the WAL.
    for (const file of DATABASE_FILES) {
      expect(script).toContain(`get data/${file} `);
    }
  });

  it('pins the host key on the open, rather than trusting the host', () => {
    expect(script).toContain('-hostkey="KEY"');
  });

  it('runs unattended, so it cannot stop on a prompt', () => {
    expect(script).toContain('option batch on');
    expect(script).toContain('option confirm off');
  });
});

describe('backupFileName', () => {
  it('gives the sidecars the same stamp as their database', () => {
    const stamp = '2026-10-01T19-02-34';

    expect(backupFileName('bot.db', stamp)).toBe(`bot-${stamp}.db`);
    expect(backupFileName('bot.db-wal', stamp)).toBe(`bot-${stamp}.db-wal`);
    expect(backupFileName('bot.db-shm', stamp)).toBe(`bot-${stamp}.db-shm`);
  });

  it('keeps the separator that used to be stripped', () => {
    // The previous version produced `botdb-shm`, which read as an unrelated leftover rather than
    // part of the snapshot, and did not match the prune pattern either.
    expect(backupFileName('bot.db-wal', 'S')).toBe('bot-S.db-wal');
  });
});

describe('snapshotsToPrune', () => {
  const snapshot = (stamp) => [`bot-${stamp}.db`, `bot-${stamp}.db-wal`, `bot-${stamp}.db-shm`];

  it('removes a snapshot whole, never half of a WAL pair', () => {
    // Deleting one file of a triple leaves a database whose sidecars describe a different moment,
    // which is worse than either state being complete.
    const files = [...snapshot('2026-01-01'), ...snapshot('2026-06-01')];

    expect(snapshotsToPrune(files, 1)).toEqual(snapshot('2026-01-01'));
  });

  it('keeps the newest by stamp rather than by file order', () => {
    const files = [...snapshot('2026-01-01'), ...snapshot('2026-06-01'), ...snapshot('2026-03-01')];

    expect(snapshotsToPrune(files, 2)).toEqual(snapshot('2026-01-01'));
  });

  it('keeps everything while the history has room', () => {
    const files = [...snapshot('2026-01-01'), ...snapshot('2026-06-01')];

    expect(snapshotsToPrune(files, 15)).toEqual([]);
  });

  it('ignores files that are not stamped snapshots', () => {
    expect(snapshotsToPrune(['notes.txt', 'bot.db', 'stray-wal'], 0)).toEqual([]);
  });
});

describe('buildUploadScript', () => {
  const script = buildUploadScript({
    url: 'sftp://u:p@h:2022/',
    hostKey: 'KEY',
    localSpec: 'C:\\staging\\*',
    remoteDir: '/home/container',
  });

  it('recurses, because a plain put skips everything nested under src/', () => {
    // `*` matches files and `*/` matches directories. WinSCP's put has no -recursive switch, and
    // -resent and -resuming are rejected as unknown.
    expect(script).toContain('-filemask="*;*/|.git"');
  });

  it('excludes .git, which is a file holding a path to this machine', () => {
    expect(script).toContain('|.git');
  });

  it('uses a recursive put rather than synchronize', () => {
    // synchronize would remove remote files that are absent locally, and the two that must never be
    // removed are exactly the two that are absent locally: .env and data/.
    expect(script).not.toContain('synchronize');
  });

  it('never deletes the remote build', () => {
    // Deleting dist/ removed the only bootable entrypoint on a host with no compiler to restore it.
    // The failure was the bot not starting at all, which looked like a Discord problem.
    expect(script).not.toMatch(/^rm /m);
  });

  it('lists the host afterwards, because the transfer alone proves nothing', () => {
    // The transfer succeeds whether or not it carried the build. The listing is the only evidence of
    // what actually arrived.
    expect(script).toContain('ls /home/container/dist/features/ranks');
  });
});

describe('buildLanded', () => {
  const uploadLines = [
    'C:\\staging\\dist\\features\\ranks\\sync.js | 15 KB | binary | 100%',
    'C:\\staging\\dist\\features\\ranks\\prompt.js | 5 KB | binary | 100%',
  ].join('\n');

  it('confirms the build once the listing shows both marker files', () => {
    expect(buildLanded(`${uploadLines}\nls\n-rw-r--r-- 1 0 0 15238 sync.js\n-rw-r--r-- 1 0 0 5431 prompt.js`)).toBe(
      true,
    );
  });

  it('does not mistake role-sync.js for sync.js', () => {
    // This is the check that passed while the file it was meant to prove was genuinely absent. Every
    // build ever produced contains role-sync.js, so a substring match was always going to pass.
    const oldBuild = `${uploadLines}\nls\n-rw-r--r-- 1 0 0 10664 role-sync.js\n-rw-r--r-- 1 0 0 8672 role-sync.js.map`;

    expect(buildLanded(oldBuild)).toBe(false);
  });

  it('ignores transfer lines, which mention files that were sent, not files present', () => {
    // The put log names every local path it uploaded. Reading that as proof of remote state would
    // report success for a transfer that carried nothing.
    expect(buildLanded(uploadLines)).toBe(false);
  });

  it('reports false when the listing is missing entirely', () => {
    expect(buildLanded('')).toBe(false);
    expect(buildLanded('ls failed: no such directory')).toBe(false);
  });

  it('requires every marker, not just one', () => {
    const partial = 'ls\n-rw-r--r-- 1 0 0 15238 sync.js';

    expect(buildLanded(partial)).toBe(false);
  });
});

describe('redact', () => {
  it('removes the password from anything headed for a terminal', () => {
    expect(redact('open sftp://user:hunter2@host/', 'hunter2')).toBe('open sftp://user:<redacted>@host/');
  });

  it('is safe when the password is empty', () => {
    expect(redact('unchanged', '')).toBe('unchanged');
  });
});

describe('restartAccepted', () => {
  it('treats a plain success as accepted', () => {
    expect(restartAccepted({ ok: true, status: 204 })).toBe(true);
  });

  it('treats busy as benign, because the instance is not known-down', () => {
    expect(restartAccepted({ ok: false, status: 409 })).toBe(true);
  });

  it('reports anything else instead of swallowing it', () => {
    // A deploy that uploaded code and silently did not restart leaves the host serving the previous
    // build, which is exactly the failure this whole script keeps having to be watched for.
    expect(restartAccepted({ ok: false, status: 500 })).toBe(false);
    expect(restartAccepted({ ok: false, status: 504 })).toBe(false);
  });
});

describe('resourcesReportHealthy', () => {
  it('accepts a 200 carrying real usage figures', () => {
    expect(
      resourcesReportHealthy(200, { attributes: { resources: { memory_bytes: 133_000_000 } } }),
    ).toBe(true);
  });

  it('rejects a 200 with no figures, which is not evidence of anything', () => {
    expect(resourcesReportHealthy(200, { attributes: {} })).toBe(false);
    expect(resourcesReportHealthy(200, {})).toBe(false);
    expect(resourcesReportHealthy(200, null)).toBe(false);
  });

  it('rejects a gateway timeout', () => {
    // A 504 is what a suspended instance returns, and it is what a flapping provider returns too.
    expect(resourcesReportHealthy(504, null)).toBe(false);
  });
});