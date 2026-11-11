/**
 * Where a recorded call's server is, for a plugin that needs to send it a request of its own (Pro
 * asking a gRPC server for its schema). The rules are here, in the app: a plugin is told where to
 * connect, or why it mustn't, and never learns more of how traffic is routed.
 */
import net from 'node:net';
import type { ExchangeDetail } from '../shared/api';
import type { UpstreamTarget, UpstreamTargetResult } from '../plugin-api/backend';
import { SETUP_HOST } from './setup-page';

/** Docker containers set up by Wirescry reach this computer by this name; the proxy sends it here. */
const DOCKER_HOST = 'host.docker.internal';

/** Whether a host is this computer. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (net.isIPv4(name)) return name.startsWith('127.');
  if (net.isIPv6(name)) return name === '::1' || /^::ffff:127\./.test(name);
  return false;
}

/**
 * Where to send a request to the server a call went to, or why not. `extraCAs` are the certificates
 * the proxy trusts beyond Node's own, for upstream servers; `ownPorts`, Wirescry's own ports on this
 * computer (its proxy, API and device listeners), never a call's server.
 */
export function upstreamTargetOf(
  detail: ExchangeDetail,
  extraCAs: readonly string[],
  ownPorts: readonly number[] = [],
): UpstreamTargetResult {
  const { summary } = detail;
  if (summary.imported) {
    return {
      refused: 'It was loaded from a HAR file, so this computer may never have contacted its server.',
    };
  }
  if (summary.handledBy) {
    return {
      refused: `The rule "${summary.handledBy.label}" handled it, so it may not have gone to the server shown.`,
    };
  }
  if (summary.composed) {
    return { refused: 'It was sent from the Compose tab. Ask from a call your own app made.' };
  }
  if (summary.source) {
    return {
      refused: `It came from ${summary.source.label}. Asking servers from devices isn't supported yet.`,
    };
  }
  if (summary.websocket) return { refused: 'It is a WebSocket connection.' };
  if (summary.failure?.kind === 'blocked' || summary.failure?.kind === 'rule') {
    return { refused: "It didn't reach a server." };
  }
  // A rule that handles it is known only once its request has arrived (a streaming call's may
  // still be on its way).
  if (detail.timing.bodyReceivedTimestamp === undefined) {
    return { refused: 'Its request is still being sent. Ask once it has been, or from another call.' };
  }
  if (!detail.fromThisComputer || !detail.destination) {
    // A container on its own network, say: its "localhost" isn't this computer's.
    return {
      refused: "It came from another machine or a container, so its server may not be this computer's.",
    };
  }

  let url: URL;
  try {
    url = new URL(summary.url);
  } catch {
    return { refused: "Its address can't be read." };
  }
  const tls = url.protocol === 'https:';
  if (!tls && url.protocol !== 'http:') return { refused: "Its address isn't http or https." };
  // The name it was sent with (from the URL), and where the proxy sent it: the tunnel's or request's
  // own host and port, which a Host header can't change. IPv6 addresses come in brackets.
  const name = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let host = detail.destination.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = detail.destination.port;
  if (!host || !name) return { refused: "Its address can't be read." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { refused: "Its port can't be used." };
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === SETUP_HOST || name.toLowerCase() === SETUP_HOST) {
    return { refused: 'It went to Wirescry’s own setup page.' };
  }
  // The proxy sends Docker's name for this computer here; and any name for this computer is
  // reached as "localhost", never looked up.
  let servername = name;
  if (lower === DOCKER_HOST) {
    host = 'localhost';
    servername = 'localhost';
  } else if (isLoopbackHost(host) && !net.isIP(host)) {
    host = 'localhost';
  }
  const loopback = isLoopbackHost(host);
  if (loopback && ownPorts.includes(port)) {
    return { refused: 'It went to Wirescry itself.' };
  }
  if (!tls && !loopback) {
    // A name could point somewhere else by the time of the new request, and without TLS nothing
    // would tell: only this computer is asked over plain HTTP.
    return {
      refused: 'It went over plain HTTP. Wirescry only asks servers over HTTPS, or servers on this computer.',
    };
  }
  const authority =
    headerValue(detail.requestHeaders, ':authority') ??
    headerValue(detail.requestHeaders, 'host') ??
    url.host;
  const target: UpstreamTarget = {
    host,
    port,
    tls,
    authority,
    ...(tls && !net.isIP(servername) ? { servername } : {}),
    ca: [...extraCAs],
  };
  return { target };
}

function headerValue(headers: ExchangeDetail['requestHeaders'], name: string): string | undefined {
  const value = headers.find(([key]) => key.toLowerCase() === name)?.[1]?.trim();
  return value || undefined;
}
