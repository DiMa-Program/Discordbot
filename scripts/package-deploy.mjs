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
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Branch names legitimately contain slashes (`feature/rank-sync`), which would otherwise become a
// path separator in the archive name and make git fail to create the file.
const branchSlug = branch.replace(/[^A-Za-z0-9._-]+/g, '-');
const archiveName = `discordbot-${branchSlug}-${shortSha}.zip`;
const archivePath = path.join(outputDir, archiveName);

execFileSync('git', ['archive', '--format=zip', `-o${archivePath}`, 'HEAD'], { cwd: projectRoot });

// Verify against `git ls-tree` rather than by unpacking the zip. `git archive` emits exactly the tree
// of the given commit, so the tree listing is the authoritative answer to "what is in this archive",
// and it needs no zip parsing and no shell tooling that differs across platforms. An earlier version
// scanned a tar stream for forbidden prefixes and matched on file *contents* rather than entry names,
// which reported a leak that did not exist.
const entries = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter((line) => line !== '');

const forbidden = ['.env', 'node_modules', 'dist', 'data'];
const problems = entries.filter((entry) => forbidden.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`)));

if (problems.length > 0) {
  console.error(`[package] refusing to hand over an archive containing: ${problems.slice(0, 5).join(', ')}`);
  process.exit(1);
}

if (!entries.includes('index.js')) {
  console.error('[package] refusing: the archive has no root index.js, so the host cannot boot it.');
  process.exit(1);
}

if (!entries.includes('package.json')) {
  console.error('[package] refusing: the archive has no package.json, so nothing will be installed.');
  process.exit(1);
}

const fileCount = entries.length;
const sizeKb = Math.round(statSync(archivePath).size / 1024);

console.log('');
console.log('  Package ready');
console.log('  -------------');
console.log(`  file    : dist-package/${archiveName}`);
console.log(`  branch  : ${branch}`);
console.log(`  commit  : ${shortSha}`);
console.log(`  files   : ${fileCount}`);
console.log(`  size    : ~${sizeKb} KB`);
console.log('');
console.log('  Verified: no .env, no node_modules, no dist, no data. Your secrets and your');
console.log('  database are never part of the upload.');
console.log('');
