#!/usr/bin/env node
// Patches Mockttp after install, until the fix is in a Mockttp release.
//
// The bug: when a server ends an HTTP/2 response with its headers alone, Mockttp passes it on as
// headers, then a separate end of stream. That means the same thing in HTTP, but gRPC sends most
// errors exactly this way ("Trailers-Only"), and gRPC clients (Go, Node, Java) then ignore the
// status and report INTERNAL instead. The patch sends the headers and the end together.
// A reply made by a rule's callback (plugins' rules, a breakpoint's reply) with no body and no
// trailers is split the same way, and is sent the same way too.
//
// Run by `postinstall`. Safe to run again. Fails the install if Mockttp's code has changed so the
// patch no longer fits: check whether the new Mockttp already has the fix, and remove this script
// (and the postinstall entry) if so; otherwise update the patch.
//
// Usage: node scripts/patch-mockttp.mjs [path to Mockttp's package folder]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'Wirescry patch: headers-only HTTP/2 responses';
/** Marks the part for callback replies, added later: an install patched before has MARKER only. */
export const CALLBACK_MARKER = 'Wirescry patch: headers-only HTTP/2 callback replies';

const HELPER = `
// ${MARKER} (scripts/patch-mockttp.mjs in Wirescry).
// Holds back Mockttp's usual writeHead until Node first needs the headers: on end() (an empty body),
// Node then sends them marked as the end of the stream, as the server did; on a first write, as
// usual. The held call is exactly the usual one, so headers are recorded and sent the same way.
function wirescryHeadOnly(response, status, statusMessage, headers) {
    const nodeWriteHead = response.writeHead;
    response.writeHead = function () {
        response.writeHead = nodeWriteHead;
        return (0, request_utils_1.writeHead)(response, status, statusMessage, headers);
    };
}
`;

const CALLBACK_CHECK = `// ${CALLBACK_MARKER}: which replies may go out as headers alone.
// Node checks the status and headers only when it sends them, which for these is inside end(), too
// late for Mockttp to report a problem (the exchange would never finish). So only a status and
// headers Node surely accepts go that way; anything else goes the usual way, as before.
const wirescryHttp = require("http");
function wirescryCanEndWithHead(status, headers) {
    if (!Number.isInteger(status) || status < 200 || status > 599)
        return false;
    const pairs = headers === undefined ? [] : Array.isArray(headers) ? headers : Object.entries(headers);
    const perConnection = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te'];
    try {
        for (const [name, value] of pairs) {
            wirescryHttp.validateHeaderName(name);
            if (perConnection.includes(name.toLowerCase()))
                return false;
            const values = Array.isArray(value) ? value : [value];
            // Node allows some headers only once; of those given more than once, only cookies are surely fine.
            if (values.length !== 1 && name.toLowerCase() !== 'set-cookie')
                return false;
            for (const one of values)
                wirescryHttp.validateHeaderValue(name, one);
        }
    }
    catch {
        return false;
    }
    return true;
}
`;

/**
 * Each edit: text to find (exactly once), what replaces it, and a tag: text only that part has,
 * so a part from another version of this script is noticed instead of patched over.
 */
export const EDITS = [
  {
    name: 'helper',
    tag: `// ${MARKER} (scripts/patch-mockttp.mjs in Wirescry).`,
    find: 'const request_utils_1 = require("../../util/request-utils");\n',
    replace: 'const request_utils_1 = require("../../util/request-utils");\n' + HELPER,
  },
  {
    name: 'detect',
    tag: `                // ${MARKER}: if the server`,
    find: '                (0, request_utils_1.writeHead)(clientRes, serverStatusCode, serverStatusMessage, serverRawHeaders\n',
    replace:
      '                // ' +
      MARKER +
      ': if the server has already ended the stream,\n' +
      "                // don't send the headers yet. Ending the response (when the empty body has been piped) then\n" +
      '                // sends them marked as the end, as the server did; if there is a body after all, its first\n' +
      '                // write sends them as usual. Node marks a client stream ended as soon as END_STREAM\n' +
      '                // arrives, before anyone reads it. (Over a native socket, never before the next frame is\n' +
      "                // read, so trailers that follow headers can't be lost this way.)\n" +
      '                const wirescryHeadersOnly = isH2Downstream && !resBodyOverride && !originalBody &&\n' +
      '                    serverRes.req?._request?._readableState?.ended === true;\n' +
      '                (wirescryHeadersOnly ? wirescryHeadOnly : request_utils_1.writeHead)(clientRes, serverStatusCode, serverStatusMessage, serverRawHeaders\n',
  },
  {
    name: 'callback-check',
    tag: `// ${CALLBACK_MARKER}: which replies`,
    find: 'async function writeResponseFromCallback(result, response) {\n',
    replace: CALLBACK_CHECK + 'async function writeResponseFromCallback(result, response) {\n',
  },
  {
    name: 'callback',
    tag: `    // ${CALLBACK_MARKER}: with no body`,
    find:
      '    (0, request_utils_1.writeHead)(response, result.statusCode || 200, result.statusMessage, result.headers);\n' +
      '    if (result.trailers)\n' +
      '        response.addTrailers(result.trailers);\n' +
      '    response.end(result.rawBody || "");\n',
    replace:
      '    // ' +
      CALLBACK_MARKER +
      ': with no body and no trailers, send the headers\n' +
      '    // marked as the end of the stream. end("") would send them first, then a separate end.\n' +
      '    if ((0, request_utils_1.isHttp2)(response) && !result.trailers && !(result.rawBody?.length > 0) &&\n' +
      '        wirescryCanEndWithHead(result.statusCode || 200, result.headers)) {\n' +
      '        wirescryHeadOnly(response, result.statusCode || 200, result.statusMessage, result.headers);\n' +
      '        response.end();\n' +
      '        return;\n' +
      '    }\n' +
      '    (0, request_utils_1.writeHead)(response, result.statusCode || 200, result.statusMessage, result.headers);\n' +
      '    if (result.trailers)\n' +
      '        response.addTrailers(result.trailers);\n' +
      '    response.end(result.rawBody || "");\n',
  },
];

/** The text the packaging check looks for: every part of the patch is in place. */
export const MARKERS = [MARKER, CALLBACK_MARKER];

export const TARGET = 'dist/rules/requests/request-step-impls.js';

/**
 * Applies the edits to the text, skipping any already there (so an install patched by an older
 * version of this script gets the newer parts). Returns the new text, or throws saying which edit
 * didn't fit, or which is there from another version of the script.
 */
export function patchText(text) {
  let out = text;
  for (const edit of EDITS) {
    if (out.includes(edit.replace)) continue;
    if (out.includes(edit.tag)) {
      throw new Error(
        `Mockttp's ${TARGET} has the "${edit.name}" part of another version of this patch. ` +
          'Reinstall Mockttp (delete node_modules/mockttp, then npm install).',
      );
    }
    const count = out.split(edit.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `Mockttp's ${TARGET} has changed: the "${edit.name}" part of the patch matches ${count} places, not 1.`,
      );
    }
    out = out.replace(edit.find, () => edit.replace);
  }
  return out;
}

export function patchMockttp(packageDir) {
  const file = path.join(packageDir, TARGET);
  const text = readFileSync(file, 'utf8');
  const patched = patchText(text);
  if (patched === text) return 'already patched';
  writeFileSync(file, patched);
  return 'patched';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const packageDir = process.argv[2] ?? path.join(root, 'node_modules', 'mockttp');
  try {
    const result = patchMockttp(packageDir);
    console.log(`Mockttp: ${result} (headers-only HTTP/2 responses and callback replies).`);
  } catch (error) {
    console.error(`Mockttp patch failed. ${error instanceof Error ? error.message : error}`);
    console.error('See scripts/patch-mockttp.mjs for what to do.');
    process.exit(1);
  }
}
