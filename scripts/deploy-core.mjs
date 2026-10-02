/**
 * Deploy script building blocks.
 *
 * WHY THIS FILE EXISTS
 *
 * Everything here was a bug that shipped and cost real time, and every one of them had the same
 * shape: the script reported success, or a plausible warning, while doing something other than what
 * its output claimed. A deploy that lies about itself is worse than one that fails, because it sends
 * you looking for the problem somewhere else.
 *
 * Specifically, in one afternoon:
 *   - the backup silently degraded to a warning because a Temporal Dead Zone error was swallowed by
 *     the backup's own try/catch, and looked like an SFTP permission problem;
 *   - the database appeared to be unreachable because the download path used forward slashes, which
 *     WinSCP reads as a remote path, and the conclusion drawn was that the host could not serve
 *     subdirectories at all;
 *   - a build check written as `includes('sync.js')` matched `role-sync.js`, so it passed while the
 *     file it was meant to prove was genuinely missing;
 *   - a removal step was reported as failed because WinSCP exits non-zero when ANY command in a
 *     script errors, including removals that had already succeeded;
 *   - and the compiled output was never uploaded, so the bot ran the first build it ever received,
 *     for the entire life of the project, with no error anywhere.
 *
 * So the decisions below are extracted as pure functions that take their inputs and return what they
 * would have written or concluded. That is the only shape in which they can be asserted without a
 * server, a WinSCP install, or a network.
 *
 * The bug is in the composition of strings and the reading of output, never in the transferring
 * itself. That is why these functions are worth having: they are exactly the parts that were wrong.
 */

// ---------------------------------------------------------------------------------------------
// The host key
// ---------------------------------------------------------------------------------------------

/**
 * The hosting node's SSH host key, pinned so a substituted host cannot receive the SFTP password.
 *
 * This is WinSCP's own display form: no `SHA256:` prefix and no trailing `=`. Both of those variants
 * were tried and both were rejected as a mismatch against the server's real key. Override with
 * HEAVEN_SFTP_HOST_KEY if the provider ever moves the machine.
 */
export const DEFAULT_SSH_HOST_KEY = 'ssh-ed25519 255 HjV7vEkMibVIR+NApBvRtt58JlwLERfc2fJcTjkDt2U';

/**
 * Resolves the pinned host key.
 *
 * It is a function rather than a constant read at module load so a test can assert that both the
 * override and the default are used. Reading it at load time is not wrong in itself, but it is what
 * let the backup reference it before it existed: the value was computed inline in the upload section,
 * far below the backup that needed it.
 */
export function resolveHostKey(env = {}) {
  return env['HEAVEN_SFTP_HOST_KEY'] ?? DEFAULT_SSH_HOST_KEY;
}

/** Encodes the credentials into the URL `open` expects. */
export function sftpUrl({ user, password, host, port }) {
  return `sftp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/`;
}

// ---------------------------------------------------------------------------------------------
// The backup transfer
// ---------------------------------------------------------------------------------------------

/** The SQLite files that make up a consistent snapshot: the database plus its WAL sidecars. */
export const DATABASE_FILES = Object.freeze(['bot.db', 'bot.db-wal', 'bot.db-shm']);

/**
 * The WinSCP script that copies the live database down.
 *
 * Every rule encoded here was found by trying the alternative against the real host and watching it
 * fail on a file that was demonstrably present. The shape that works is narrow:
 *
 *   - paths RELATIVE to the directory the session already opens in. An absolute remote path fails
 *     with `no such file`;
 *   - no `cd` beforehand. Combined with a directory mask it changes how the path resolves;
 *   - no `-filemask`. A filemask against the directory fails;
 *   - no trailing slash on the remote side, which WinSCP rejects as ambiguous;
 *   - one `get` per file rather than a mask, naming each one outright.
 *
 * `stagingDir` is used verbatim and is therefore expected to be a native Windows path. It was
 * previously rewritten with forward slashes, which is the single change that made the whole backup
 * look like a host problem: WinSCP treats `C:/Users/...` as a remote path, so the transfer reported
 * that the server did not have a database it was sitting on.
 */
export function buildBackupScript({ url, hostKey, stagingDir }) {
  const lines = [
    `open ${url} -hostkey="${hostKey}"`,
    'option batch on',
    'option confirm off',
  ];

  for (const file of DATABASE_FILES) {
    lines.push(`get data/${file} ${stagingDir}\\${file}`);
  }

  lines.push('exit');
  return lines.join('\r\n') + '\r\n';
}

/**
 * The name a downloaded database file is stored under.
 *
 * The sidecars take the same stamp as their database, because they only mean anything alongside it.
 * An earlier version stripped the dot and produced `botdb-shm` beside a stamped `bot.db`, which read
 * as unrelated leftovers rather than one snapshot, and did not match the prune pattern either.
 */
export function backupFileName(file, stamp) {
  return file.replace(/^bot\.db/, `bot-${stamp}.db`);
}

/**
 * Groups backup filenames by the stamp they belong to.
 *
 * Pruning has to remove a snapshot whole. Removing one file of a triple leaves a database whose
 * sidecars describe a different moment, which is worse than either state being complete.
 */
export function groupBackupsByStamp(files) {
  const byStamp = new Map();

  for (const file of files) {
    const match = /^bot-(.+?)(\.db(-wal|-shm)?)$/.exec(file);
    if (match !== null) {
      byStamp.set(match[1], [...(byStamp.get(match[1]) ?? []), file]);
    }
  }

  return byStamp;
}

/**
 * The snapshots to delete, oldest first.
 *
 * Stamps are sortable ISO strings, so ordering is a string comparison and a retention test is a
 * slice. A whole stamp is returned as a unit for the reason above.
 */
export function snapshotsToPrune(files, history) {
  const byStamp = groupBackupsByStamp(files);
  const ordered = [...byStamp.keys()].sort().reverse();
  return ordered.slice(history).flatMap((stamp) => byStamp.get(stamp) ?? []);
}

// ---------------------------------------------------------------------------------------------
// The upload
// ---------------------------------------------------------------------------------------------

/**
 * The WinSCP script that uploads the staged tree and then lists what the host actually holds.
 *
 * `put` overwrites file by file, so the freshly compiled `dist/` replaces the previous build in
 * place. Deleting the remote build first would be actively harmful: it removes the only bootable
 * entrypoint on a host that has no compiler to restore it.
 *
 * The trailing `ls` is load-bearing. The transfer succeeds whether or not it carried the build, so
 * the listing is the only evidence of what arrived.
 */
export function buildUploadScript({ url, hostKey, localSpec, remoteDir }) {
  return [
    `open ${url} -hostkey="${hostKey}"`,
    `put -filemask="*;*/|.git" "${localSpec}" ${remoteDir}/`,
    `ls ${remoteDir}/dist/features/ranks`,
    'exit',
  ].join('\r\n');
}

/**
 * Files that exist only in a build produced from the current source.
 *
 * `sync.js` and `prompt.js` arrived with the periodic sync. Their absence is therefore proof that
 * the host is still running an older build, which is a failure that otherwise looks like a
 * permissions or Discord problem.
 */
export const BUILD_MARKER_FILES = Object.freeze(['sync.js', 'prompt.js']);

// ---------------------------------------------------------------------------------------------
// Reading the upload result
// ---------------------------------------------------------------------------------------------

/**
 * Whether the new build is present, judged from the tail of the transfer output.
 *
 * WinSCP does not echo commands it runs from a script in batch mode, so there is no line to anchor
 * on. The last thing the script does is the `ls`, so its output is everything after the final
 * transferred path. Anchoring on a literal `ls` line instead reported every build as absent,
 * including the ones that had demonstrably landed.
 *
 * The word boundary is the other half. A bare `includes('sync.js')` also matches `role-sync.js`,
 * which every build has ever contained, so that check passed while the file it was meant to prove was
 * absent. A verification built from the wrong evidence is worse than none, because it converts a
 * silent failure into confident wrongness.
 */
export function buildLanded(output, markers = BUILD_MARKER_FILES) {
  const lines = output.split(/\r?\n/);

  // The listing starts after the last line that names a LOCAL path, which is how every `put` progress
  // line begins. Slicing from there rather than to it matters: searching backwards for the last
  // listing-looking line would start mid-listing and drop whichever marker happened to come before it.
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^[A-Za-z]:\\/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }

  const listing = lines.slice(start).join('\n');
  return markers.every((marker) => new RegExp(`\\b${marker.replace('.', '\\.')}\\b`).test(listing));
}

/**
 * Removes the password from anything on its way to a terminal or a log file.
 *
 * An empty secret is returned untouched. `split('')` splits into single characters, so passing an
 * empty password would otherwise insert the redaction marker between every character of the output
 * and turn a diagnostic into noise. That is reachable: the panel key is optional, and a misconfigured
 * environment is exactly when someone is reading this output.
 */
export function redact(text, password) {
  return password === undefined || password === '' ? text : text.split(password).join('<redacted>');
}

// ---------------------------------------------------------------------------------------------
// Restarting
// ---------------------------------------------------------------------------------------------

/**
 * Whether a power reply means the restart landed.
 *
 * 204 is success and 409 means the panel already considers the instance busy, which for a restart is
 * benign. Anything else is reported rather than swallowed, because a deploy that uploaded code and
 * silently did not restart leaves the host serving the previous build.
 */
export function restartAccepted(response) {
  return response.ok || response.status === 409;
}

/** HTTP statuses a watchdog should treat as proof that an instance is genuinely alive. */
export function resourcesReportHealthy(status, body) {
  return status === 200 && typeof body?.attributes?.resources?.memory_bytes === 'number';
}