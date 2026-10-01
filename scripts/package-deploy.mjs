/**
 * Builds the deployable archive for a Pterodactyl-style host.
 *
 * WHY THIS EXISTS
 *
 * This host cannot clone from GitHub. The code arrived as an extracted zip, so there is no `.git`
 * directory and the container's `git pull` guard (`if [[ -d .git ]]`) never fires. Pushing to
 * GitHub therefore does nothing to the running server, and every deploy has to be uploaded by hand.
 * The upload cannot be automated from here. What this script does is make producing the artifact a
 * single command instead of a git incantation, and make it impossible to upload something that does
 * not match what is in Git.
 *
 * It refuses to run on a dirty working tree. An archive built from uncommitted work is
 * indistinguishable from a committed one once uploaded, and that is how a server ends up running
 * code that exists nowhere but on the host.
 *
 * Usage: npm run package
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectRoot, 'dist-package');

function git(args, encoding) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: encoding ?? 'utf8' });
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const shortSha = git(['rev-parse', '--short', 'HEAD']).trim();

if (branch === 'main') {
  console.error(
    'Refusing to package from main.\n' +
      '  Build from a feature branch and merge after the host works. The archive becomes whatever\n' +
      '  the branch tip was at package time, and main is the branch you want reproducible.',
  );
  process.exit(1);
}

const dirty = git(['status', '--porcelain']).trim();
if (dirty !== '') {
  console.error('Refusing to package: the working tree has uncommitted changes.\n');
  for (const line of dirty.split('\n')) console.error(`  ${line}`);
  console.error('\n  Commit them, or stash them, then run this again.');
  process.exit(1);
}

if (!git(['rev-parse', '--verify', 'origin/main'], 'utf8')) {
  // Not fatal: the branch may simply not be pushed yet. Worth saying out loud either way.
  console.log('[package] note: no origin/main found locally. Push the branch if you want a backup.');
}

// The unpushed-commit count is advisory, so a missing remote branch must not stop the build. A brand
// new branch has no origin/<branch> ref at all, and `git rev-list` treats that as a fatal ambiguous
// argument rather than an empty result.
const remoteRef = `origin/${branch}`;
const hasRemote = existsSync(path.join(projectRoot, '.git', 'refs', 'remotes', 'origin', branch));
if (!hasRemote) {
  console.log(`[package] note: ${branch} has no ${remoteRef}; push it if you want a remote backup.`);
} else {
  const unpushed = git(['rev-list', '--count', `${remoteRef}..${branch}`]).trim();
  if (unpushed !== '0' && unpushed !== '') {
    console.log(`[package] note: ${unpushed} commit(s) on ${branch} are not pushed to origin yet.`);
  }
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const archiveName = `discordbot-${branch}-${shortSha}.zip`;
const archivePath = path.join(outputDir, archiveName);

execFileSync('git', ['archive', '--format=zip', `-o${archivePath}`, 'HEAD'], { cwd: projectRoot });

// Verify the archive rather than trusting the tool. A leaked .env here means a token on a shared
// host, and an archive missing the entrypoint just wastes another round trip.
const listing = execFileSync(
  'git',
  ['archive', '--format=tar', 'HEAD'],
  { cwd: projectRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
);

const entries = new Set();
await new Promise((resolve, reject) => {
  const stream = Readable.from(listing);
  const rl = createInterface({ input: stream });
  // The tar header keeps the entry name in its first header line, which is enough for a name scan.
  rl.on('line', (line) => {
    const name = line.slice(0, 100).trim();
    if (name !== '' && !name.startsWith('#') && name.includes('/')) entries.add(name);
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});

const forbidden = ['.env', 'node_modules/', 'dist/', 'data/'];
const problems = forbidden.filter((prefix) =>
  [...entries].some((entry) => entry === prefix || entry.startsWith(prefix)),
);

if (problems.length > 0) {
  console.error(`[package] refusing to hand over an archive containing: ${problems.join(', ')}`);
  process.exit(1);
}

if (!entries.has('index.js')) {
  console.error('[package] refusing: the archive has no root index.js, so the host cannot boot it.');
  process.exit(1);
}

const files = readdirSync(outputDir);
const sizeKb = Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $args[0]).Length', archivePath], { encoding: 'utf8' }).trim()) / 1024);

console.log('');
console.log('  Package ready');
console.log('  -------------');
console.log(`  file   : dist-package/${archiveName}`);
console.log(`  branch : ${branch}`);
console.log(`  commit : ${shortSha}`);
console.log(`  size   : ~${sizeKb} KB`);
console.log('');
console.log('  Upload it: Files -> Upload -> Extract over /home/container -> Restart.');
console.log('  The archive carries no .env, no node_modules and no dist, so your secrets and');
console.log('  your database are never overwritten.');
console.log('');
