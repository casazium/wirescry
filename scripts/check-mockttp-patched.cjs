// Checks before packaging that Mockttp has Wirescry's patch (scripts/patch-mockttp.mjs, run by
// npm install's postinstall): an install with --ignore-scripts would skip it silently.

const fs = require('node:fs');
const path = require('node:path');

/** Each patched file, relative to Mockttp's package folder, and the markers it must hold. */
const MOCKTTP_PATCHED_FILES = {
  // MARKERS in scripts/patch-mockttp.mjs.
  'dist/rules/requests/request-step-impls.js': [
    'Wirescry patch: headers-only HTTP/2 responses',
    'Wirescry patch: headers-only HTTP/2 callback replies',
    'Wirescry patch: non-WebSocket upgrade offers',
    'Wirescry patch: HTTP/2 per-connection headers',
  ],
  // SERVER_MARKERS.
  'dist/server/http-combo-server.js': ['Wirescry patch: non-WebSocket upgrade offers'],
  // UTILS_MARKERS.
  'dist/util/request-utils.js': [
    'Wirescry patch: recorded response headers',
    'Wirescry patch: HTTP/2 per-connection headers',
  ],
  // LISTEN_MARKERS.
  'dist/server/mockttp-server.js': ['Wirescry patch: listening address'],
};

/** Throws unless every patched file in Mockttp's package folder holds all its markers. */
function checkMockttpPatched(packageDir) {
  for (const [file, markers] of Object.entries(MOCKTTP_PATCHED_FILES)) {
    const text = fs.readFileSync(path.join(packageDir, file), 'utf8');
    if (!markers.every((marker) => text.includes(marker))) {
      throw new Error('Mockttp is not patched. Run `node scripts/patch-mockttp.mjs` (npm install runs it).');
    }
  }
}

module.exports = { MOCKTTP_PATCHED_FILES, checkMockttpPatched };
