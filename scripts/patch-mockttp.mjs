#!/usr/bin/env node
// Patches Mockttp after install, until the fix is in a Mockttp release.
//
// The bug: when a server ends an HTTP/2 response with its headers alone, Mockttp passes it on as
// headers, then a separate end of stream. That means the same thing in HTTP, but gRPC sends most
// errors exactly this way ("Trailers-Only"), and gRPC clients (Go, Node, Java) then ignore the
// status and report INTERNAL instead. The patch sends the headers and the end together.
// A reply made by a rule's callback (plugins' rules, a breakpoint's reply) with no body and no
// trailers is split the same way, and is sent the same way too, as Mockttp's fix for it does
// (httptoolkit/mockttp#232): set the status and headers, then end(). That fix also records the
// headers of such a reply correctly, which the parts for dist/util/request-utils.js do here.
//
// A second bug: Node marks a request with an Upgrade header and "upgrade" in Connection as an
// upgrade, and Mockttp handles all of those as WebSockets. A plain-http request may offer another protocol, though:
// Apache HttpClient 5.6 sends "Upgrade: TLS/1.2" on every one, curl --http2 "Upgrade: h2c". A
// server that ignores the offer answers as usual, and Mockttp passed that answer on with its
// "Transfer-Encoding: chunked" header but the body no longer in chunks, which clients can't read
// ("Bad chunk header"). The patch sends only WebSocket upgrades that way (Node's
// shouldUpgradeCallback, from Node 24.9), so the rest are ordinary requests, recorded as sent;
// and it doesn't pass their offer on, as a proxy shouldn't (it's for one connection only).
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
/** Marks the parts for requests offering an upgrade other than WebSocket, in both files. */
export const UPGRADE_MARKER = 'Wirescry patch: non-WebSocket upgrade offers';
/** Marks the parts that record a response's headers as Node sends them (TRACK_TARGET). */
export const TRACK_MARKER = 'Wirescry patch: recorded response headers';

export const UPGRADE_HELPER = `
// ${UPGRADE_MARKER} (scripts/patch-mockttp.mjs in Wirescry).
// The headers to pass on for a request that offered an upgrade (its Connection names "upgrade"):
// without Upgrade, and HTTP2-Settings if Connection names it too, and without those names in
// Connection. They're for one connection only. Anything else is passed on as it was.
function wirescryDropUpgradeOffer(rawHeaders) {
    const named = rawHeaders
        .filter(([name]) => String(name).toLowerCase() === 'connection')
        .flatMap(([, value]) => String(value).split(','))
        .map((token) => token.trim().toLowerCase());
    if (!named.includes('upgrade'))
        return rawHeaders;
    const offer = named.includes('http2-settings') ? ['upgrade', 'http2-settings'] : ['upgrade'];
    return rawHeaders.flatMap(([name, value]) => {
        const key = String(name).toLowerCase();
        if (offer.includes(key))
            return [];
        if (key !== 'connection')
            return [[name, value]];
        const kept = String(value).split(',').map((token) => token.trim())
            .filter((token) => token && !offer.includes(token.toLowerCase()));
        return kept.length > 0 ? [[name, kept.join(', ')]] : [];
    });
}
`;

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

const CALLBACK_CHECK = `// ${CALLBACK_MARKER}: sends a reply with no body as its head
// alone, marked as the end of the stream, like writeHeadAndEnd in Mockttp's fix
// (httptoolkit/mockttp#232). Returns false, having sent nothing, if a header other than Set-Cookie
// is repeated: Node checks those only as it sends them, inside end(), too late to report a problem.
// The reply then goes the usual way (ending with end(""), where #232 has end(); the same to clients).
// A bad status or header name throws as it's set, so Mockttp reports it as before (1xx with Node's
// own message); a bad value or a per-connection header is dropped by Node, as from writeHead.
function wirescryHeadAndEnd(response, status, headers) {
    const objectHeaders = headers === undefined
        ? {}
        : Array.isArray(headers)
            ? (0, header_utils_1.rawHeadersToObject)(headers)
            : headers;
    const hasRepeatedHeaders = Object.entries(objectHeaders).some(([name, value]) => Array.isArray(value) && value.length > 1 && name.toLowerCase() !== 'set-cookie');
    if (hasRepeatedHeaders)
        return false;
    // HTTP/2 has no status message, so it's dropped here as in writeHead.
    response.statusCode = status;
    for (const [name, value] of Object.entries(objectHeaders)) {
        if (value !== undefined)
            response.setHeader(name, value);
    }
    response.end();
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
    tag: `// ${CALLBACK_MARKER}: sends a reply`,
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
      '        wirescryHeadAndEnd(response, result.statusCode || 200, result.headers)) {\n' +
      '        return;\n' +
      '    }\n' +
      '    (0, request_utils_1.writeHead)(response, result.statusCode || 200, result.statusMessage, result.headers);\n' +
      '    if (result.trailers)\n' +
      '        response.addTrailers(result.trailers);\n' +
      '    response.end(result.rawBody || "");\n',
  },
  {
    name: 'upgrade-helper',
    tag: `// ${UPGRADE_MARKER} (scripts/patch-mockttp.mjs in Wirescry).`,
    find: 'function isSerializedBuffer(obj) {\n',
    replace: UPGRADE_HELPER + 'function isSerializedBuffer(obj) {\n',
  },
  {
    name: 'upgrade-forward',
    tag: `        // ${UPGRADE_MARKER}: a request`,
    find: '        let serverReq;\n',
    replace:
      '        // ' +
      UPGRADE_MARKER +
      ': a request that offered an upgrade other than\n' +
      "        // WebSocket comes here as an ordinary request. Its offer isn't passed on: a server that took\n" +
      "        // it would switch protocols on a request that can't. That includes an offer a rule or a\n" +
      '        // breakpoint added.\n' +
      '        rawHeaders = wirescryDropUpgradeOffer(rawHeaders);\n' +
      '        let serverReq;\n',
  },
];

/** Mockttp's server setup, where Node's HTTP/1.1 server is made. */
export const SERVER_TARGET = 'dist/server/http-combo-server.js';

/** The edits to SERVER_TARGET. */
export const SERVER_EDITS = [
  {
    name: 'upgrade-websocket-only',
    tag: `            // ${UPGRADE_MARKER}: only`,
    find: '            requireHostHeader: false\n',
    replace:
      '            requireHostHeader: false,\n' +
      '            // ' +
      UPGRADE_MARKER +
      ": only WebSocket upgrades go to Mockttp's\n" +
      '            // upgrade handling, which is for WebSockets alone: an Upgrade of "websocket", in any case,\n' +
      '            // as its WebSocket server requires. Other offers (h2c, TLS/1.2) are ordinary requests, as\n' +
      "            // for any server that doesn't take them. Node still drops a request pipelined after one\n" +
      '            // (clients rarely pipeline), as it did before.\n' +
      "            shouldUpgradeCallback: (req) => String(req.headers.upgrade ?? '').trim().toLowerCase() === 'websocket'\n",
  },
];

/** Where Mockttp records the headers each response is sent with. */
export const TRACK_TARGET = 'dist/util/request-utils.js';

/**
 * The edits to TRACK_TARGET, from Mockttp's fix (httptoolkit/mockttp#232). A reply sent by
 * wirescryHeadAndEnd has its headers set before Node's writeHead, so Mockttp records them from
 * getHeaders(), which needs both: repeated values were reversed in place (so Node sent them reversed
 * too), and :status came after them.
 */
export const TRACK_EDITS = [
  {
    name: 'track-status-later',
    tag: `        // ${TRACK_MARKER}: :status`,
    find:
      '        writtenHeaders = getHeaderPairsFromArgument(headersArg);\n' +
      '        if (isHttp2(trackedResponse)) {\n' +
      "            writtenHeaders.unshift([':status', args[0].toString()]);\n" +
      '        }\n',
    replace:
      '        writtenHeaders = getHeaderPairsFromArgument(headersArg);\n' +
      '        // ' +
      TRACK_MARKER +
      ': :status is added below, after any headers set earlier, so it comes first.\n',
  },
  {
    name: 'track-copy',
    tag: `                    // ${TRACK_MARKER}: copied`,
    find: '                    value.reverse().forEach(v => writtenHeaders?.unshift([key, v]));\n',
    replace:
      '                    // ' +
      TRACK_MARKER +
      ': copied first: reversing in place would change the headers Node sends.\n' +
      '                    [...value].reverse().forEach(v => writtenHeaders?.unshift([key, v]));\n',
  },
  {
    name: 'track-status-first',
    tag: `        // ${TRACK_MARKER}: added last`,
    find: '        return originalWriteHeader.apply(this, args);\n',
    replace:
      '        // ' +
      TRACK_MARKER +
      ': added last, so it comes first, before any headers set earlier.\n' +
      '        if (isHttp2(trackedResponse)) {\n' +
      "            writtenHeaders.unshift([':status', args[0].toString()]);\n" +
      '        }\n' +
      '        return originalWriteHeader.apply(this, args);\n',
  },
];

/** The text the packaging check looks for in TARGET: every part of the patch is in place. */
export const MARKERS = [MARKER, CALLBACK_MARKER, UPGRADE_MARKER];

/** The same for SERVER_TARGET. */
export const SERVER_MARKERS = [UPGRADE_MARKER];

/** The same for TRACK_TARGET. */
export const TRACK_MARKERS = [TRACK_MARKER];

export const TARGET = 'dist/rules/requests/request-step-impls.js';

/**
 * Applies the edits to the text, skipping any already there (so an install patched by an older
 * version of this script gets the newer parts). Returns the new text, or throws saying which edit
 * didn't fit, or which is there from another version of the script.
 */
export function patchText(text, edits = EDITS, target = TARGET) {
  let out = text;
  for (const edit of edits) {
    if (out.includes(edit.replace)) continue;
    if (out.includes(edit.tag)) {
      throw new Error(
        `Mockttp's ${target} has the "${edit.name}" part of another version of this patch. ` +
          'Reinstall Mockttp (delete node_modules/mockttp, then npm install).',
      );
    }
    const count = out.split(edit.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `Mockttp's ${target} has changed: the "${edit.name}" part of the patch matches ${count} places, not 1.`,
      );
    }
    out = out.replace(edit.find, () => edit.replace);
  }
  return out;
}

export function patchMockttp(packageDir) {
  // All checked before any is written, so a part that no longer fits leaves Mockttp as it was.
  const files = [
    [TARGET, EDITS],
    [SERVER_TARGET, SERVER_EDITS],
    [TRACK_TARGET, TRACK_EDITS],
  ].map(([target, edits]) => {
    const file = path.join(packageDir, target);
    const text = readFileSync(file, 'utf8');
    return { file, text, patched: patchText(text, edits, target) };
  });
  const changed = files.filter(({ text, patched }) => patched !== text);
  for (const { file, patched } of changed) writeFileSync(file, patched);
  return changed.length === 0 ? 'already patched' : 'patched';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const packageDir = process.argv[2] ?? path.join(root, 'node_modules', 'mockttp');
  try {
    const result = patchMockttp(packageDir);
    console.log(
      `Mockttp: ${result} (headers-only HTTP/2 responses and callback replies, recorded response headers, upgrade offers).`,
    );
  } catch (error) {
    console.error(`Mockttp patch failed. ${error instanceof Error ? error.message : error}`);
    console.error('See scripts/patch-mockttp.mjs for what to do.');
    process.exit(1);
  }
}
