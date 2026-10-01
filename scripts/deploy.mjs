/**
 * One-command deploy: upload the committed code to the Pterodactyl host and restart the bot.
 *
 * WHY THIS EXISTS
 *
 * This host cannot clone from GitHub. The code arrived as an extracted zip, so there is no `.git`
 * directory and the container's `git pull` guard never fires. The free tier also does not run the
 * egg's install script. Pushing to GitHub therefore does nothing to the running server, and every
 * deploy has to be uploaded by hand through the web file manager, which is several error-prone
 * steps. This turns that into one command.
 *
 * UPLOAD IS NOT THE ZIP PATH
 *
 * SFTP has no "extract this archive" verb, so this uploads the extracted tree directly. Uploading a
 * zip and extracting it would put an extraction step back into the manual workflow, which is the
 * thing being removed here.
 *
 * SECRETS
 *
 * The SFTP password is read from the environment and written into a WinSCP ini file that lives in the
 * OS temp directory and is deleted in a `finally` block. It is never passed as a command-line
 * argument, where it would be visible to any process listing on the machine.
 *
 * Requirements (one-time setup):
 *   - WinSCP installed, and `winscp.com` reachable
 *   - HEAVEN_SFTP_PASSWORD in .env (or the environment)
 *
 * Usage: npm run deploy
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env from the project root explicitly rather than relying on the working directory. Without
// this the script only saw variables exported in the calling shell, so `npm run deploy` from a fresh
// terminal reported that things were "missing from your .env" without ever opening the file.
loadDotenv({ path: path.join(projectRoot, '.env') });

const stagingDir = path.join(projectRoot, 'dist-package', 'content');

/** Where database copies land. Local only, gitignored, and the reason a wipe is survivable. */
const backupDir = path.join(projectRoot, 'backups');

/** How many database copies to keep. Old ones are pruned oldest-first. */
const BACKUP_HISTORY = 15;

/**
 * Keeps the newest `BACKUP_HISTORY` copies and removes the rest.
 *
 * Named with a sortable ISO timestamp so "newest" is a string comparison rather than a stat call per
 * file. `bot.db-wal` and `bot.db-shm` share a stamp with their `bot.db` and are pruned together, so a
 * retained set is never half a WAL pair.
 */
function pruneBackups() {
  if (!existsSync(backupDir)) {
    return;
  }

  const stamps = new Map();

  for (const file of readdirSync(backupDir)) {
    const match = /^bot-(.+?)(\.db(-wal|-shm)?)$/.exec(file);
    if (match !== null) {
      const stamp = match[1];
      stamps.set(stamp, [...(stamps.get(stamp) ?? []), file]);
    }
  }

  const ordered = [...stamps.keys()].sort().reverse();

  for (const stamp of ordered.slice(BACKUP_HISTORY)) {
    for (const file of stamps.get(stamp) ?? []) {
      rmSync(path.join(backupDir, file), { force: true });
    }
  }
}

/**
 * The hosting node's SSH host key, pinned so a substituted host cannot receive the SFTP password.
 *
 * This is WinSCP's own display form: no `SHA256:` prefix and no trailing `=`. Both of those variants
 * were tried and both were rejected as a mismatch against the server's real key. Override with
 * HEAVEN_SFTP_HOST_KEY if the provider ever moves the machine.
 */
const DEFAULT_SSH_HOST_KEY = 'ssh-ed25519 255 HjV7vEkMibVIR+NApBvRtt58JlwLERfc2fJcTjkDt2U';

function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function resolveWinScp() {
  const candidates = [
    process.env['WINSCP_PATH'],
    'C:\\Program Files (x86)\\WinSCP\\WinSCP.com',
    'C:\\Program Files\\WinSCP\\WinSCP.com',
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'WinSCP', 'WinSCP.com'),
  ].filter((entry) => typeof entry === 'string' && entry !== '');

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const found = spawnSync('winscp.com', ['/version'], { shell: true, encoding: 'utf8' });
  return found.status === 0 ? 'winscp.com' : null;
}

/**
 * Thrown instead of calling `process.exit` on a failure path.
 *
 * `process.exit()` does not run `finally` blocks, so an earlier version of this script exited with a
 * half-registered worktree still in `git worktree list` and a staging directory left on disk. Throwing
 * lets the single `finally` at the bottom of `main` do the cleanup on every path, including a failed
 * upload or an upload that partly succeeded.
 */
class DeployError extends Error {}

function fail(message) {
  throw new DeployError(message);
}

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// 1. Refuse to ship something that does not match Git
// ---------------------------------------------------------------------------------------------

let winscp = null;
let iniPath = null;
let scriptPath = null;

try {
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty !== '') {
    fail(
      'There are uncommitted changes. An upload built from uncommitted work looks identical to a\n' +
        '  committed one once it is on the host, which is how a server ends up running code that\n' +
        '  exists nowhere else. Commit or stash first.\n\n' +
        dirty
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
    );
  }

  const shortSha = git(['rev-parse', '--short', 'HEAD']).trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  // -------------------------------------------------------------------------------------------
  // 2. Required configuration
  // -------------------------------------------------------------------------------------------

  const host = process.env['HEAVEN_SFTP_HOST'];
  const user = process.env['HEAVEN_SFTP_USER'];
  const password = process.env['HEAVEN_SFTP_PASSWORD'];
  const port = process.env['HEAVEN_SFTP_PORT'] ?? '2022';
  const remoteDir = process.env['HEAVEN_REMOTE_DIR'] ?? '/home/container';
  const panel = process.env['PANEL_URL'] ?? 'https://control.heavencloud.in';
  const serverId = process.env['HEAVEN_SERVER_ID'];
  const panelKey = process.env['HEAVEN_CLOUDE_API_KEY'];

  const missing = [];
  if (host === undefined) missing.push('HEAVEN_SFTP_HOST');
  if (user === undefined) missing.push('HEAVEN_SFTP_USER');
  if (password === undefined) missing.push('HEAVEN_SFTP_PASSWORD');
  if (serverId === undefined) missing.push('HEAVEN_SERVER_ID');

  if (missing.length > 0) {
    fail(
      `Missing from your .env: ${missing.join(', ')}\n` +
        '  See .env.example for the values. HEAVEN_SFTP_PASSWORD is your Pterodactyl panel\n' +
        '  password, which is also the SFTP password.',
    );
  }

  winscp = resolveWinScp();
  if (winscp === null) {
    fail(
      'WinSCP is not installed, so there is no way to upload.\n' +
        '  Download it from https://winscp.net/eng/download.php and run this again.\n' +
        '  This is a one-time setup; the CLI mode is used here, the GUI is not needed.',
    );
  }

  // -------------------------------------------------------------------------------------------
  // 3. Back up the live database
  // -------------------------------------------------------------------------------------------
  //
  // WHY THIS IS NOT OPTIONAL
  //
  // HeavenCloud's own documentation states "free instances can wipe", and a server that is not
  // renewed is deleted two days after it suspends. The database holds every member's linked Riot ID,
  // which is the one thing on that host that cannot be regenerated from the repository. Backing it up
  // before touching the host means a wipe, a wipe-recreate, or a bot pointed at the wrong directory all
  // cost a restore instead of the data.
  //
  // It runs BEFORE the upload, so a deploy that fails part-way still leaves a copy of what was there
  // beforehand. The three SQLite files are fetched together because the database runs in WAL mode:
  // `bot.db` alone can be missing commits that are still only in `bot.db-wal`.
  //
  // A backup failure warns and continues. Blocking a deploy on a backup would be worse than the
  // problem it protects against, since the deploy itself does not touch `data/`.

  const backupStaging = path.join(projectRoot, 'dist-package', 'backup-download');

  try {
    rmSync(backupStaging, { recursive: true, force: true });
    mkdirSync(backupStaging, { recursive: true });

    const backupIni = path.join(tmpdir(), `winscp-backup-${process.pid}.ini`);
    const backupScript = path.join(tmpdir(), `winscp-backup-${process.pid}.txt`);

    writeFileSync(
      backupIni,
      `[Configuration]\r\n[Session\\backup]\r\nHostName=${host}\r\nPortNumber=${port}\r\n` +
        `UserName=${user}\r\nProtocol=SFTP\r\nPuttyProtocol=putty-sftp\r\nTimeout=30\r\n`,
      { encoding: 'utf8' },
    );

    const backupUrl = `sftp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/`;
    writeFileSync(
      backupScript,
      [
        `open ${backupUrl} -hostkey="${hostKey}"`,
        `option batch on`,
        `option confirm off`,
        `cd /home/container`,
        `get -filemask="bot.db*" data/ ${backupStaging.replace(/\\/g, '/')}`,
        `exit`,
      ].join('\r\n') + '\r\n',
      { encoding: 'utf8' },
    );

    const downloaded = spawnSync(winscp, ['/ini=' + backupIni, '/script=' + backupScript], {
      encoding: 'utf8',
      windowsHide: true,
    });

    rmSync(backupIni, { force: true });
    rmSync(backupScript, { force: true });

    const fetched = existsSync(backupStaging) ? readdirSync(backupStaging) : [];

    if (fetched.length === 0) {
      console.log('[deploy] no database on the host yet, nothing to back up.');
    } else {
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const saved = [];

      for (const file of fetched) {
        const target = path.join(backupDir, file.replace(/\.(db-wal|db-shm)$/, '$1') .replace(/^bot\.db/, `bot-${stamp}.db`));
        copyFileSync(path.join(backupStaging, file), target);
        saved.push(path.basename(target));
      }

      pruneBackups();
      console.log(`[deploy] database backed up to backups/ (${saved.join(', ')}).`);
    }
  } catch (error) {
    console.log(`[deploy] WARNING: could not back up the database. Continuing.`);
    console.log(`[deploy]   ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(backupStaging, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------
  // 4. Stage the exact committed tree
  // -------------------------------------------------------------------------------------------

  rmSync(path.dirname(stagingDir), { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // A detached worktree is a clean checkout of HEAD, so what is uploaded is exactly what is committed
  // and nothing local leaks in.
  execFileSync('git', ['worktree', 'add', '--detach', '--force', stagingDir, 'HEAD'], { cwd: projectRoot });

  // -------------------------------------------------------------------------------------------
  // 5. Upload over SFTP
  // -------------------------------------------------------------------------------------------
  //
  // Two things about WinSCP's CLI took real work to get right, and both are load-bearing:
  //
  // HOST KEY. The CLI cannot answer the interactive "do you trust this server?" prompt and aborts
  // with "the server key has not been verified" before sending any credential. That is why the same
  // credentials worked in the WinSCP GUI, where the prompt had been answered once. The key is pinned
  // rather than merely accepted, so a substituted host fails loudly instead of receiving the
  // password. Note the format is WinSCP's own display form, which has no `SHA256:` prefix and no
  // trailing `=`.
  //
  // PASSWORD. `open sftp://user@host/` builds a fresh session from the URL and ignores whatever the
  // ini file holds, which ends in "no credentials were provided". Supplying the password on the
  // command line would fix that, but it is visible to every process listing on the machine for the
  // life of the process and lands in shell history. Putting it in a temp script file that is created
  // and deleted within the run keeps it out of both.
  //
  // The switches also have to travel in a script file rather than via /command: the `-hostkey` value
  // contains spaces, and the command-line parser truncates it at the first space.

  iniPath = path.join(tmpdir(), `winscp-deploy-${process.pid}.ini`);
  scriptPath = path.join(tmpdir(), `winscp-deploy-${process.pid}.txt`);

  const hostKey = process.env['HEAVEN_SFTP_HOST_KEY'] ?? DEFAULT_SSH_HOST_KEY;

  const ini = [
    `HostName=${host}`,
    `PortNumber=${port}`,
    `UserName=${user}`,
    `Protocol=SFTP`,
    `FSProtocol2=1`,
    `SFTP=1`,
    `PuttyProtocol=putty-sftp`,
    `LocalDirectory=${stagingDir}`,
    `RemoteDirectory=${remoteDir}`,
    `Timeout=30`,
    `PingType=1`,
    `PingInterval=10`,
  ].join('\r\n');

  writeFileSync(iniPath, `[Configuration]\r\n[Session\\deploy]\r\n${ini}\r\n`, { encoding: 'utf8' });

  const uploadUrl = `sftp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/`;

  // `-filemask="*;*/"` is what makes this recurse: `*` matches files and `*/` matches directories,
  // so a plain `put *` would upload the top level and skip everything nested under src/. WinSCP's put
  // has no `-recursive` switch, and `-resent` and `-resuming` are rejected as unknown options too.
  // Only switches that actually exist are used here; every one of them was verified against the host.
  //
  // `synchronize local` also recurses and only transfers changed files, but it can remove remote files
  // that are absent locally, and the two directories that must never be removed are exactly the two
  // that are absent locally: `.env` and `data/`. A plain recursive put cannot delete anything.
  //
  // The local side is absolute rather than relative to the process working directory, so the transfer
  // cannot silently pick up the project root instead of the staging checkout.
  // The `|.git` exclusion matters. A `git worktree` checkout carries `.git` as a FILE containing
  // `gitdir: <local path>`, so uploading it puts a pointer to this machine on the host. It is also the
  // one file that could make the container's `if [[ -d .git ]] && git pull` guard fire against a
  // directory that is not a repository.
  const localSpec = `${stagingDir}\\*`;

  const script = [
    `open ${uploadUrl} -hostkey="${hostKey}"`,
    `put -filemask="*;*/|.git" "${localSpec}" ${remoteDir}/`,
    `exit`,
  ].join('\r\n');

  writeFileSync(scriptPath, script + '\r\n', { encoding: 'utf8' });

  console.log(`[deploy] ${branch} @ ${shortSha}`);
  console.log(`[deploy] uploading to ${remoteDir} ...`);

  const put = spawnSync(winscp, ['/ini=' + iniPath, '/script=' + scriptPath], {
    encoding: 'utf8',
    windowsHide: true,
  });

  const output = (put.stdout ?? '').split(password).join('<redacted>');
  if (put.status !== 0) {
    if (output.trim() !== '') console.error(output.trim());
    if (put.stderr !== undefined && put.stderr.trim() !== '') console.error(put.stderr.trim());
    fail(
      `The upload failed (WinSCP exit ${put.status}).\n` +
        '  Check HEAVEN_SFTP_HOST, HEAVEN_SFTP_PORT and HEAVEN_SFTP_PASSWORD. Whatever was\n' +
        '  already on the host has been left alone.',
    );
  }

  const fileCount = (output.match(/^([A-Za-z]:\\|[^:]+)$/gm) ?? []).length;
  console.log(`[deploy] uploaded${fileCount > 0 ? ` (${fileCount} paths)` : ''}.`);

  // -------------------------------------------------------------------------------------------
  // 5. Restart through the panel API
  // -------------------------------------------------------------------------------------------

  if (panelKey !== undefined) {
    const power = await fetch(`${panel}/api/client/servers/${serverId}/power`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${panelKey}`,
        Accept: 'Application/vnd.pterodactyl.v1+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ signal: 'restart' }),
    });

    if (power.ok || power.status === 409) {
      console.log('[deploy] restart requested.');
    } else {
      console.log(`[deploy] uploaded, but the restart returned HTTP ${power.status}.`);
      console.log('[deploy] restart the server from the panel when you can.');
    }
  } else {
    console.log('[deploy] no HEAVEN_CLOUDE_API_KEY set, so the restart has to be manual.');
  }

  console.log('');
  console.log('  Deployed. Check the console in the panel for:');
  console.log('    "logged in"');
  console.log('');
} catch (error) {
  if (error instanceof DeployError) {
    console.error(`\n[deploy] ${error.message}\n`);
    process.exitCode = 1;
  } else {
    console.error('\n[deploy] unexpected failure:\n');
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  // Every exit path lands here, including a failed upload. Leaving a registered worktree behind
  // makes the next run trip over `git worktree add`, and leaving the staging directory behind
  // invites someone to upload stale files.
  if (iniPath !== null) rmSync(iniPath, { force: true });
  // The script file carries the password, so it is the one artifact that must not survive the run.
  if (scriptPath !== null) rmSync(scriptPath, { force: true });
  try {
    execFileSync('git', ['worktree', 'remove', '--force', stagingDir], { cwd: projectRoot, stdio: 'ignore' });
  } catch {
    // The worktree was never created, or git already forgot it.
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot, stdio: 'ignore' });
  rmSync(path.dirname(stagingDir), { recursive: true, force: true });
}
