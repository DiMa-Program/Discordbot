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
  cpSync,
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

  // Declared here, before either SFTP step, because the backup needs it too. It used to be declared
  // inside the upload section, which made the backup step throw "Cannot access 'hostKey' before
  // initialization" â€” a Temporal Dead Zone error caught by the backup's own try/catch, so the backup
  // silently degraded to a warning on every single deploy.
  const hostKey = process.env['HEAVEN_SFTP_HOST_KEY'] ?? DEFAULT_SSH_HOST_KEY;

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

  // Under the project root, NOT the OS temp directory. WinSCP runs as a separate process and the
  // temp path this script creates is not writable from it; the transfer fails with a Windows
  // "Access denied" that has nothing to do with the host. A project-relative path is writable.
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
        // A path RELATIVE to the session root, with no `cd` and no `-filemask`, one `get` per file.
        //
        // Every other shape fails on this host while reporting `no such file` for files that are
        // demonstrably present. Verified individually against the live database:
        //   `get /home/container/data/bot.db`      absolute  -> fails
        //   `cd /home/container` then `get data/`  with a trailing slash -> fails, "ambiguous"
        //   `get -filemask="bot.db*" data`         filemask  -> fails
        //   `get data/bot.db <local>`              relative  -> transfers, 20 KB
        //
        // The session already opens at the container home, so the relative path needs no `cd`, and
        // naming each file sidesteps both the filemask and the trailing-slash rejection.
        `get data/bot.db ${backupStaging}\\bot.db`,
        `get data/bot.db-wal ${backupStaging}\\bot.db-wal`,
        `get data/bot.db-shm ${backupStaging}\\bot.db-shm`,
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
        // The WAL and SHM sidecars belong to the snapshot above and take the same stamp. They were
        // previously mangled into `botdb-shm` and `botdb-wal`, which lost the separator and made the
        // sidecars look like unrelated files rather than part of one consistent snapshot.
        const target = path.join(backupDir, file.replace(/^bot\.db/, `bot-${stamp}.db`));
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
  // 4b. Compile here, not on the host
  // -------------------------------------------------------------------------------------------
  //
  // WHY THE BUILD CANNOT HAPPEN ON THE HOST
  //
  // The container has a Node runtime and nothing else. There is no `npm` on the PATH, no `tsc`, and
  // no `node_modules`, because the image ships no dev dependencies and the deploy uploads none.
  // Asking the host to compile therefore cannot succeed, no matter how the build is triggered.
  //
  // The previous design relied on `index.js` compiling on first boot. That worked exactly once, on
  // the very first deploy, and never again: `index.js` only compiles when `dist/index.js` is absent,
  // and every later deploy left `dist/` in place, so that branch was never taken again. The
  // container restarted into the original build indefinitely. Source fixes were shipped and provably
  // never executed, with no error anywhere to indicate it.
  //
  // Compiling locally and uploading the output removes the dependency on the host. The host becomes
  // a runtime-only target, which is what it actually is, and the deployed artifact matches the
  // committed source by construction instead of by hope.
  //
  // `npm ci` rather than `npm install` so the build uses the lockfile exactly.
  console.log('[deploy] installing dependencies ...');
  execFileSync('npm', ['ci'], { cwd: projectRoot, stdio: 'inherit', shell: true });

  console.log('[deploy] compiling ...');
  execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit', shell: true });

  // The worktree checkout has no `dist/`, so the freshly built output is copied into the tree that
  // gets uploaded. Copying rather than building in place keeps the one rule intact: what is uploaded
  // is a checkout of HEAD plus its compiled form, with no local edits mixed in.
  const builtDist = path.join(projectRoot, 'dist');
  if (!existsSync(path.join(builtDist, 'index.js'))) {
    fail(
      'The build finished but dist/index.js does not exist, so there is nothing to deploy.\n' +
        '  Nothing was uploaded, and the host still runs the previous build.',
    );
  }

  cpSync(builtDist, path.join(stagingDir, 'dist'), { recursive: true });

  // The upload is reported as successful whether or not it carried the build, so the number of
  // compiled files now staged is stated before the transfer. A count of zero here means the host
  // would keep running the previous build while the deploy still printed success, which is exactly
  // the failure this step exists to make impossible.
  const stagedBuildFiles = readdirSync(path.join(stagingDir, 'dist'), { recursive: true }).filter(
    (entry) => typeof entry === 'string' && entry.endsWith('.js'),
  ).length;
  console.log(`[deploy] staged ${stagedBuildFiles} compiled files.`);

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

  // `put` overwrites file by file, so the freshly compiled `dist/` replaces the previous build in
  // place. The stale output is deliberately NOT deleted first: doing that left the container with
  // no `dist/index.js` to boot, and since the host has no compiler it never came back. Overwriting
  // is both safer and sufficient.
  const script = [
    `open ${uploadUrl} -hostkey="${hostKey}"`,
    `put -filemask="*;*/|.git" "${localSpec}" ${remoteDir}/`,
    `ls ${remoteDir}/dist/features/ranks`,
    'exit',
  ].join('\r\n');

  // No stale-build removal here, deliberately.
  //
  // An earlier version deleted the remote `dist/` so that `index.js` would recompile on restart.
  // That was wrong twice over. It left the container with no `dist/index.js` to boot, and the host
  // has no `tsc`, so nothing ever replaced it: the bot could not start at all. The failure looked
  // like a permissions or Discord problem because the deploy itself still reported success.
  //
  // The host never needed to compile. The compiled output is now built locally and uploaded, so the
  // `put` overwrites the previous build file by file and there is nothing to clear.
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

  // The trailing `ls` in the script reports what the host actually holds after the transfer. This
  // is the only trustworthy signal that the new build arrived: the transfer itself succeeds whether
  // or not it carried the compiled output, and the previous version of this script reported success
  // while the host kept an hours-old build indefinitely.
  //
  // The word boundary matters. A bare `includes('sync.js')` also matches `role-sync.js`, which the
  // previous build contained, so the check passed while `sync.js` was genuinely absent. An earlier
  // attempt matched both `sync.js` and `prompt.js` and still reported success, which is a reminder
  // that a verification derived from the wrong evidence is worse than no verification at all.
  const listing = output.slice(output.indexOf('\nls ') === -1 ? 0 : output.indexOf('\nls '));
  const landed = /\bsync\.js\b/.test(listing) && /\bprompt\.js\b/.test(listing);
  if (landed) {
    console.log('[deploy] the host now holds the new build.');
  } else {
    console.log('[deploy] WARNING: the host does not show the new build after the upload.');
    console.log('[deploy]   The restart below will bring up the previous build.');
  }

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
