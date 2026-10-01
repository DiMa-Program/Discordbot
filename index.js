/**
 * Hosting entrypoint for panels that bypass npm scripts.
 *
 * Pterodactyl's generic Node.js egg starts the application by running `node <MAIN_FILE>` directly.
 * It never invokes `npm start`, so a project whose start script depends on a compiled output has no
 * place to put its build step. This file is that place.
 *
 * Behaviour:
 *   - If `dist/index.js` already exists, boot it immediately. Restarts are fast.
 *   - Otherwise run the TypeScript build once, then boot.
 *
 * This matters for hosts that wipe the container home on redeploy: the build simply runs again,
 * because there is no `dist/` left to reuse.
 *
 * Running this locally is equivalent to `npm run build && npm start`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const compiledEntry = path.join(projectRoot, 'dist', 'index.js');

if (!existsSync(compiledEntry)) {
  console.log('[entrypoint] dist/index.js not found — running the TypeScript build first.');

  // The command is a single fixed string with no interpolation, and `shell: true` is required on
  // Windows where npm is `npm.cmd` rather than an executable file. Passing an args array alongside
  // `shell: true` triggers DEP0190, so the whole command is one string instead.
  execFileSync('npm run build', { cwd: projectRoot, stdio: 'inherit', shell: true });

  if (!existsSync(compiledEntry)) {
    // Failing here beats booting a half-built tree and surfacing a confusing module-not-found later.
    throw new Error('[entrypoint] the build finished but dist/index.js still does not exist.');
  }
}

await import('./dist/index.js');
