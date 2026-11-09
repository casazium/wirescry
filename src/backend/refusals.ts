/**
 * HTTPS connections that refused Wirescry's certificate, counted per source (a captured device,
 * or this computer) by the hostname the client asked for (TLS SNI). The event carries no app: a
 * device's traffic arrives through its tunnel from 127.0.0.1 (android-design.md, "Measured for
 * PR 5b"), and this computer's from any of its programs or containers.
 */
import type { RefusedConnections } from '../shared/api';

/** Distinct hosts kept per source; refusals for further hosts still count. */
export const MAX_REFUSED_HOSTS = 50;

const LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/** The hostname as shown, or '' for none or anything that isn't a hostname (it comes from the client). */
export function cleanHost(host: string | undefined): string {
  const name = (host ?? '').toLowerCase().replace(/\.$/, '');
  return HOSTNAME.test(name) ? name : '';
}

export class Refusals {
  private readonly devices = new Map<
    string,
    { count: number; hosts: Map<string, number>; moreHosts: boolean }
  >();

  add(id: string, host: string | undefined): void {
    const name = cleanHost(host);
    let device = this.devices.get(id);
    if (!device) {
      device = { count: 0, hosts: new Map(), moreHosts: false };
      this.devices.set(id, device);
    }
    device.count += 1;
    const seen = device.hosts.get(name);
    if (seen !== undefined) device.hosts.set(name, seen + 1);
    else if (device.hosts.size < MAX_REFUSED_HOSTS) device.hosts.set(name, 1);
    else device.moreHosts = true;
  }

  clear(id: string): void {
    this.devices.delete(id);
  }

  /**
   * Takes `seen`, an earlier `of(id)`, off this source's refusals, keeping any that came since.
   * Hosts it had but `seen` didn't stay; once nothing is left, it's as if cleared.
   */
  subtract(id: string, seen: RefusedConnections): void {
    const device = this.devices.get(id);
    if (!device) return;
    device.count -= Math.min(seen.count, device.count);
    for (const { host, count } of seen.hosts) {
      const left = (device.hosts.get(host) ?? 0) - count;
      if (left > 0) device.hosts.set(host, left);
      else device.hosts.delete(host);
    }
    if (seen.moreHosts) device.moreHosts = false;
    if (device.count === 0) this.devices.delete(id);
  }

  clearAll(): void {
    this.devices.clear();
  }

  /** This source's refusals, the most frequent hosts first; undefined while there are none. */
  of(id: string): RefusedConnections | undefined {
    const device = this.devices.get(id);
    if (!device) return undefined;
    const hosts = [...device.hosts]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
    return { count: device.count, hosts, ...(device.moreHosts ? { moreHosts: true as const } : {}) };
  }
}
