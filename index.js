/**
 * Hosting entrypoint for panels that bypass npm scripts.
 *
 * Pterodactyl's generic Node.js egg starts the application by running `node <MAIN_FILE>` directly.
 * It never invokes `npm start`, so a project whose start script depends on a compiled output has no
 * place to put its build step. This file is that place.
 *
 * Behaviour:
 *   - Boot `dist/index.js`. Nothing else.
 *
 * This file deliberately does NOT build. An earlier version compiled here whenever `dist/` was
 * absent, on the assumption that the host had a toolchain. It does not: there is no `npm` on the
 * PATH, no `tsc`, and no `node_modules`. The build worked once, on a first deploy, and never again,
 * because after that `dist/` always existed and the branch was skipped. Every deploy since shipped
 * source code the container never executed, and reported success while doing it.
 *
 * `npm run deploy` now compiles locally and uploads `dist/`, so this host is a runtime-only target.
 * A missing build is therefore a packaging failure worth naming, not something to paper over by
 * trying and failing to compile.
 *
 * Running this locally is equivalent to `npm run build && npm start`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const compiledEntry = path.join(projectRoot, 'dist', 'index.js');

if (!existsSync(compiledEntry)) {
  // Failing here beats booting a half-built tree and surfacing a confusing module-not-found later.
  throw new Error(
    '[entrypoint] dist/index.js is missing. Run `npm run deploy`, which compiles before uploading.\n' +
      '  This host does not compile; the build is produced on the machine running the deploy.',
  );
}

await import('./dist/index.js');
