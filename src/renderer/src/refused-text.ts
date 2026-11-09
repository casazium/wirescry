/** What the Traffic bar says about HTTPS connections that refused Wirescry’s certificate. */
import type { RefusedConnections } from '../../shared/api';

/** Hosts named in the bar; the rest are counted. */
export const NAMED_REFUSED_HOSTS = 3;

/** The docs on programs that don't trust the certificate. */
export const REFUSED_HELP_URL = 'https://docs.casazium.com/docs/wirescry/troubleshooting#certificate-error';

const connections = (n: number): string => (n === 1 ? '1 connection' : `${n.toLocaleString()} connections`);

/**
 * E.g. "3 connections refused Wirescry’s certificate: api.github.com, registry.npmjs.org, and 1
 * more." The most frequent hosts first; a connection that named no host is called that.
 */
export function refusedSummary(refused: RefusedConnections): string {
  const named = refused.hosts
    .slice(0, NAMED_REFUSED_HOSTS)
    .map(
      (h) => h.host || (h.count === 1 ? 'a connection without a hostname' : 'connections without a hostname'),
    );
  const more = refused.hosts.length - named.length;
  // Past the hosts kept, how many more there are isn't known.
  const rest = refused.moreHosts ? ', and others' : more > 0 ? `, and ${more} more` : '';
  const list = named.length > 0 ? `: ${named.join(', ')}${rest}` : '';
  return `${connections(refused.count)} refused Wirescry’s certificate${list}.`;
}

/** Why those connections aren't in the list. */
export function refusedWhy(count: number): string {
  return count === 1
    ? 'The program that made it doesn’t trust the certificate, so that connection isn’t listed.'
    : 'The programs that made them don’t trust the certificate, so those connections aren’t listed.';
}

/**
 * Whether `now` was all seen when the bar was dismissed (`dismissed`): the same refusals, or more
 * from hosts it already named. A host not among them, or refusals that started over (a new
 * epoch), show the bar again; a program retrying one host doesn't.
 */
export function alreadyDismissed(
  now: RefusedConnections,
  dismissed: RefusedConnections | undefined,
): boolean {
  if (!dismissed || now.epoch !== dismissed.epoch) return false;
  const seen = new Set(dismissed.hosts.map((h) => h.host));
  return now.hosts.every((h) => seen.has(h.host)) && (!now.moreHosts || !!dismissed.moreHosts);
}
