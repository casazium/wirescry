/**
 * Android's own traffic while a device is captured: hosts its system services and Google's apps
 * contacted, and the connectivity check's paths. Measured on the API 37 emulator
 * (android-design.md, "Measured for PR 5b"). Used to group refused connections and for a
 * one-click filter that hides this traffic.
 */

/** Hosts contacted by Android's services, Play services and Chrome's background features. */
export const ANDROID_SYSTEM_HOSTS = [
  // The connectivity check (AOSP NetworkMonitor).
  'connectivitycheck.gstatic.com',
  // Play services' location.
  'geomobileservices-pa.googleapis.com',
  // Chrome's Safe Browsing and its relay, and its client services.
  'safebrowsing.googleapis.com',
  'ohttp-relay-safebrowsing-android.google.fastly-edge.com',
  'clientservices.googleapis.com',
] as const;

/**
 * The connectivity check's other plain-HTTP probes. Those hosts serve apps too, and other apps
 * use these paths on other hosts, so only these exact URLs mark the check.
 */
export const ANDROID_PROBE_URLS = [
  'http://www.google.com/gen_204',
  'http://play.googleapis.com/generate_204',
] as const;

/**
 * Hosts whose refused connections come from Android itself. Refusals carry only a hostname,
 * and the connectivity check's HTTPS probe goes to www.google.com.
 */
const REFUSING_SYSTEM_HOSTS = new Set<string>([...ANDROID_SYSTEM_HOSTS, 'www.google.com']);

export function isAndroidSystemHost(host: string): boolean {
  return REFUSING_SYSTEM_HOSTS.has(host.toLowerCase());
}

/** A Traffic search that hides Android's background traffic (from any source: it goes by host). */
export const HIDE_ANDROID_SYSTEM_QUERY = [
  ...ANDROID_SYSTEM_HOSTS.map((host) => `-host=${host}`),
  ...ANDROID_PROBE_URLS.map((url) => `-url=${url}`),
].join(' ');
