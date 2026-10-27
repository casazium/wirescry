// @ts-check
/**
 * Signs, notarizes and staples each macOS .dmg, so the disk image itself passes
 * Gatekeeper, not just the app inside it. electron-builder notarizes only the app.
 *
 * Runs as electron-builder's artifactBuildCompleted hook: after the .dmg is made and
 * before it's uploaded. The .dmg isn't in latest-mac.yml (dmg.writeUpdateInfo is off,
 * since the updater uses the zip), so changing it here leaves no stale checksums.
 *
 * It does nothing unless the build is signed and notarized: CSC_NAME (set by the release
 * workflow) and APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER. A signed but
 * un-notarized .dmg would be worse than an unsigned one, since Gatekeeper rejects it.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = promisify(execFile);

/** @param {string} command @param {string[]} args */
async function exec(command, args) {
  try {
    const { stdout } = await run(command, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const e = /** @type {{ stdout?: string, stderr?: string, message: string }} */ (error);
    throw new Error(`${command} ${args[0]} failed: ${e.stderr || e.stdout || e.message}`, { cause: error });
  }
}

/** Like exec, but returns stdout even when the command exits with an error. */
async function output(command, args) {
  try {
    return await exec(command, args);
  } catch (error) {
    const cause = /** @type {{ cause?: { stdout?: string } }} */ (error).cause;
    if (cause?.stdout) return cause.stdout;
    throw error;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {import('electron-builder').ArtifactCreated} event */
module.exports = async function notarizeDmg(event) {
  const file = event.file;
  if (!file || !file.endsWith('.dmg')) return;
  const env = process.env;
  if (!env.CSC_NAME) {
    // Only the release workflow sets CSC_NAME (see its "Set up macOS signing" step).
    if (env.CSC_LINK) console.warn(`  • leaving ${path.basename(file)} unsigned: CSC_NAME isn't set`);
    return;
  }
  if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
    console.warn(`  • leaving ${path.basename(file)} unsigned: the build isn't notarized`);
    return;
  }
  const name = path.basename(file);

  const sign = ['--sign', `Developer ID Application: ${env.CSC_NAME}`, '--timestamp'];
  if (env.SIGNING_KEYCHAIN) sign.push('--keychain', env.SIGNING_KEYCHAIN);
  console.log(`  • signing ${name}`);
  await exec('codesign', [...sign, file]);

  console.log(`  • notarizing ${name} (this takes a few minutes)`);
  // notarytool may exit with an error for a rejected submission; its JSON still says why.
  const out = await output('xcrun', [
    'notarytool',
    'submit',
    file,
    '--key',
    env.APPLE_API_KEY,
    '--key-id',
    env.APPLE_API_KEY_ID,
    '--issuer',
    env.APPLE_API_ISSUER,
    '--wait',
    '--timeout',
    '30m',
    '--output-format',
    'json',
  ]);
  /** @type {{ id?: string, status?: string }} */
  let result;
  try {
    result = JSON.parse(out);
  } catch (error) {
    throw new Error(`Couldn't read notarytool's result for ${name}: ${out}`, { cause: error });
  }
  if (result.status !== 'Accepted') {
    let log = '';
    if (result.id) {
      log = await exec('xcrun', [
        'notarytool',
        'log',
        result.id,
        '--key',
        env.APPLE_API_KEY,
        '--key-id',
        env.APPLE_API_KEY_ID,
        '--issuer',
        env.APPLE_API_ISSUER,
      ]).catch((error) => String(error));
    }
    throw new Error(`Apple didn't notarize ${name} (status: ${result.status ?? 'unknown'}).\n${log}`);
  }

  console.log(`  • stapling ${name}`);
  // Apple's ticket can take a moment to be available after "Accepted".
  for (let attempt = 1; ; attempt++) {
    try {
      await exec('xcrun', ['stapler', 'staple', file]);
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      console.warn(`  • stapling ${name} failed, retrying (${attempt}/4)`);
      await sleep(15_000 * attempt);
    }
  }
  await exec('xcrun', ['stapler', 'validate', file]);
  // Gatekeeper's own verdict, which must name notarization as the source.
  const assessment = await run('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '-v',
    file,
  ]).catch((error) => {
    throw new Error(`Gatekeeper rejected ${name}: ${error.stderr || error.message}`, { cause: error });
  });
  // spctl prints its verdict to stderr.
  const verdict = `${assessment.stdout}${assessment.stderr}`;
  if (!verdict.includes('source=Notarized Developer ID')) {
    throw new Error(`Gatekeeper didn't see ${name} as notarized: ${verdict.trim()}`);
  }
  console.log(`  • ${name} is signed, notarized and stapled`);
};
