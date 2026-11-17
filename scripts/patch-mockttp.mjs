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
// A third bug: over HTTP/2 a rule's reply (a mock, a file, a plugin's or a breakpoint's reply) with
// a header that applies to one connection only, such as Transfer-Encoding or Keep-Alive, never
// finished. HTTP/2 forbids those (RFC 9113, section 8.2.2). Node takes them as they're set but
// refuses them as it sends the head, and keeps them, so Mockttp's own error reply failed the same
// way; in trailers, Node's refusal was an uncaught error, which stopped Wirescry's backend. The
// patch leaves them out of HTTP/2 heads and trailers.
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
/** Marks the parts that record a response's headers as Node sends them (UTILS_TARGET). */
export const TRACK_MARKER = 'Wirescry patch: recorded response headers';
/** Marks the parts that leave out per-connection headers over HTTP/2, in TARGET and UTILS_TARGET. */
export const CONNECTION_MARKER = 'Wirescry patch: HTTP/2 per-connection headers';
/** Marks the part that lets Wirescry choose the proxy's listening address (LISTEN_TARGET). */
export const LISTEN_MARKER = 'Wirescry patch: listening address';

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
    name: 'connection-callback',
    tag: `        // ${CONNECTION_MARKER}: left out`,
    find: '        validateCustomHeaders({}, result.headers);\n',
    replace:
      '        validateCustomHeaders({}, result.headers);\n' +
      '        // ' +
      CONNECTION_MARKER +
      ': left out over HTTP/2, here so that a reply\n' +
      "        // with no body (wirescryHeadAndEnd) doesn't have them either. Raw headers become an object,\n" +
      '        // as writeHead makes them over HTTP/2.\n' +
      '        if ((0, request_utils_1.isHttp2)(response))\n' +
      '            result.headers = (0, request_utils_1.wirescryDropConnectionHeaders)(Array.isArray(result.headers)\n' +
      '                ? (0, header_utils_1.rawHeadersToObject)(result.headers)\n' +
      '                : result.headers);\n',
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

export const CONNECTION_HELPER = `
// ${CONNECTION_MARKER} (scripts/patch-mockttp.mjs in Wirescry).
// The headers (an object) without those HTTP/2 forbids, as applying to one connection only (RFC 9113,
// section 8.2.2). Node refuses them only as it sends the head (or trailers), too late for Mockttp
// to report it, and keeps them, so Mockttp's own error reply fails too. Names are matched as Node
// stores them, trimmed and in any case. TE is kept only as Node allows it: one TE header, which is
// "trailers". Anything else is passed on as it was; with nothing to leave out, the same object.
function wirescryDropConnectionHeaders(headers) {
    const perConnection = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings'];
    const key = (name) => String(name).trim().toLowerCase();
    const te = Object.entries(headers).filter(([name, value]) => key(name) === 'te' && value !== undefined);
    const keepTe = te.length === 0 || (te.length === 1 && [te[0][1]].flat().length === 1 && [te[0][1]].flat()[0] === 'trailers');
    const dropped = (name) => perConnection.includes(key(name)) || (key(name) === 'te' && !keepTe);
    if (!Object.keys(headers).some(dropped))
        return headers;
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped(name)));
}
exports.wirescryDropConnectionHeaders = wirescryDropConnectionHeaders;
`;

/** Mockttp's request utilities: where it writes and records the head of each response. */
export const UTILS_TARGET = 'dist/util/request-utils.js';

/**
 * The edits to UTILS_TARGET. The first three are from Mockttp's fix (httptoolkit/mockttp#232). A
 * reply sent by wirescryHeadAndEnd has its headers set before Node's writeHead, so Mockttp records
 * them from getHeaders(), which needed fixing twice: repeated values were reversed in place (so Node
 * sent them reversed too), and :status came after them. The others leave out per-connection
 * headers and trailers over HTTP/2.
 */
export const UTILS_EDITS = [
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
  {
    name: 'connection-helper',
    tag: `// ${CONNECTION_MARKER} (scripts/patch-mockttp.mjs in Wirescry).`,
    find: 'exports.writeHead = writeHead;\n',
    replace: 'exports.writeHead = writeHead;\n' + CONNECTION_HELPER,
  },
  {
    name: 'connection-trailers',
    tag: `        // ${CONNECTION_MARKER}: trailers`,
    find: '        const trailersArg = args[0];\n',
    replace:
      '        // ' +
      CONNECTION_MARKER +
      ': trailers too. Node refuses them only as it\n' +
      '        // sends the trailers, as an uncaught error. It takes trailers as an object over HTTP/2.\n' +
      '        if (isHttp2(trackedResponse) && args[0])\n' +
      '            args[0] = wirescryDropConnectionHeaders(Array.isArray(args[0])\n' +
      '                ? (0, header_utils_1.rawHeadersToObject)(args[0])\n' +
      '                : args[0]);\n' +
      '        const trailersArg = args[0];\n',
  },
  {
    name: 'connection-write-head',
    tag: `    // ${CONNECTION_MARKER}: left out`,
    find:
      '    if (statusMessage === undefined) {\n' +
      "        // Cast is required as Node H2 types don't know about raw headers:\n" +
      '        response.writeHead(status, flatHeaders);\n' +
      '    }\n' +
      '    else {\n' +
      '        response.writeHead(status, statusMessage, flatHeaders);\n' +
      '    }\n',
    replace:
      '    // ' +
      CONNECTION_MARKER +
      ': left out over HTTP/2 (flatHeaders is an object there).\n' +
      '    const wirescryHeaders = isHttp2(response) ? wirescryDropConnectionHeaders(flatHeaders) : flatHeaders;\n' +
      '    if (statusMessage === undefined) {\n' +
      "        // Cast is required as Node H2 types don't know about raw headers:\n" +
      '        response.writeHead(status, wirescryHeaders);\n' +
      '    }\n' +
      '    else {\n' +
      '        response.writeHead(status, statusMessage, wirescryHeaders);\n' +
      '    }\n',
  },
];

/** Mockttp's server, where it starts listening. */
export const LISTEN_TARGET = 'dist/server/mockttp-server.js';

/**
 * The edits to LISTEN_TARGET. Mockttp listens on all addresses, with no option for another. On
 * Windows and macOS, Wirescry sets `wirescryListenHost` to 127.0.0.1 on the server before starting
 * it, with a fixed port: nothing listens on the network, so Windows doesn't ask to let Wirescry
 * through its firewall. Unset, the listen is as before.
 */
export const LISTEN_EDITS = [
  {
    name: 'listen-host',
    tag: `            // ${LISTEN_MARKER}:`,
    find: '            this.server.listen(port);\n',
    replace:
      '            // ' +
      LISTEN_MARKER +
      ': the one Wirescry set, or all addresses as before.\n' +
      '            this.server.listen(port, this.wirescryListenHost);\n',
  },
];

/** The text the packaging check looks for in TARGET: every part of the patch is in place. */
export const MARKERS = [MARKER, CALLBACK_MARKER, UPGRADE_MARKER, CONNECTION_MARKER];

/** The same for SERVER_TARGET. */
export const SERVER_MARKERS = [UPGRADE_MARKER];

/** The same for UTILS_TARGET. */
export const UTILS_MARKERS = [TRACK_MARKER, CONNECTION_MARKER];

/** The same for LISTEN_TARGET. */
export const LISTEN_MARKERS = [LISTEN_MARKER];

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
    [UTILS_TARGET, UTILS_EDITS],
    [LISTEN_TARGET, LISTEN_EDITS],
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
      `Mockttp: ${result} (headers-only HTTP/2 responses and callback replies, recorded response headers, upgrade offers, HTTP/2 per-connection headers, listening address).`,
    );
  } catch (error) {
    console.error(`Mockttp patch failed. ${error instanceof Error ? error.message : error}`);
    console.error('See scripts/patch-mockttp.mjs for what to do.');
    process.exit(1);
  }
}
