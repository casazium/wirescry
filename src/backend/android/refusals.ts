/**
 * HTTPS connections from captured devices that refused Wirescry's certificate, counted per
 * device by the hostname the client asked for (TLS SNI). The event carries no app: everything
 * arrives through the device's tunnel from 127.0.0.1 (android-design.md, "Measured for PR 5b").
 */
import type { RefusedConnections } from '../../shared/api';

/** Distinct hosts kept per device; refusals for further hosts still count. */
export const MAX_REFUSED_HOSTS = 50;

const LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/** The hostname as shown, or '' for none or anything that isn't a hostname (it comes from the device). */
export function cleanHost(host: string | undefined): string {
  const name = (host ?? '').toLowerCase().replace(/\.$/, '');
  return HOSTNAME.test(name) ? name : '';
}

export class Refusals {
  private readonly devices = new Map<string, { count: number; hosts: Map<string, number> }>();

  add(id: string, host: string | undefined): void {
    const name = cleanHost(host);
    let device = this.devices.get(id);
    if (!device) {
      device = { count: 0, hosts: new Map() };
      this.devices.set(id, device);
    }
    device.count += 1;
    const seen = device.hosts.get(name);
    if (seen !== undefined) device.hosts.set(name, seen + 1);
    else if (device.hosts.size < MAX_REFUSED_HOSTS) device.hosts.set(name, 1);
  }

  clear(id: string): void {
    this.devices.delete(id);
  }

  /** This device's refusals, the most frequent hosts first; undefined while there are none. */
  of(id: string): RefusedConnections | undefined {
    const device = this.devices.get(id);
    if (!device) return undefined;
    const hosts = [...device.hosts]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
    return { count: device.count, hosts };
  }
}
