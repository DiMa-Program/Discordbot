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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDir = path.join(projectRoot, 'dist-package', 'content');

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
  // 3. Stage the exact committed tree
  // -------------------------------------------------------------------------------------------

  rmSync(path.dirname(stagingDir), { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // A detached worktree is a clean checkout of HEAD, so what is uploaded is exactly what is committed
  // and nothing local leaks in.
  execFileSync('git', ['worktree', 'add', '--detach', '--force', stagingDir, 'HEAD'], { cwd: projectRoot });

  // -------------------------------------------------------------------------------------------
  // 4. Upload over SFTP
  // -------------------------------------------------------------------------------------------

  iniPath = path.join(tmpdir(), `winscp-deploy-${process.pid}.ini`);

  const ini = [
    `HostName=${host}`,
    `PortNumber=${port}`,
    `UserName=${user}`,
    `Password=${password}`,
    `Protocol=SFTP`,
    `FSProtocol2=1`,
    `SFTP=1`,
    `PuttyProtocol=putty-sftp`,
    `LocalDirectory=${stagingDir}`,
    `RemoteDirectory=${remoteDir}`,
    // Do not let a failed transfer look like a successful one.
    `ConfirmBeforeClose=0`,
    `PingType=1`,
    `PingInterval=10`,
    `Timeout=30`,
  ].join('\r\n');

  writeFileSync(iniPath, `[Configuration]\r\n[Session\\deploy]\r\n${ini}\r\n`, { encoding: 'utf8' });

  console.log(`[deploy] ${branch} @ ${shortSha}`);
  console.log(`[deploy] uploading to ${remoteDir} ...`);

  const put = spawnSync(
    winscp,
    ['/ini=' + iniPath, '/command', `put -recursive -resent -resuming=no * ${remoteDir}/`, 'exit'],
    { cwd: stagingDir, encoding: 'utf8', windowsHide: true },
  );

  if (put.status !== 0) {
    if (put.stdout !== undefined && put.stdout.trim() !== '') console.error(put.stdout);
    if (put.stderr !== undefined && put.stderr.trim() !== '') console.error(put.stderr);
    fail(
      `The upload failed (WinSCP exit ${put.status}).\n` +
        '  Check HEAVEN_SFTP_HOST, HEAVEN_SFTP_PORT and HEAVEN_SFTP_PASSWORD. Whatever was\n' +
        '  already on the host has been left alone.',
    );
  }

  console.log('[deploy] uploaded.');

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
  try {
    execFileSync('git', ['worktree', 'remove', '--force', stagingDir], { cwd: projectRoot, stdio: 'ignore' });
  } catch {
    // The worktree was never created, or git already forgot it.
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot, stdio: 'ignore' });
  rmSync(path.dirname(stagingDir), { recursive: true, force: true });
}
