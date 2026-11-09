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
  // Play services: location, Play, device services (measured on API 28 and 37).
  'geomobileservices-pa.googleapis.com',
  'play.googleapis.com',
  'android.googleapis.com',
  'android.apis.google.com',
  'proactivebackend-pa.googleapis.com',
  'voilatile-pa.googleapis.com',
  // Chrome's Safe Browsing and its relay, and its client services.
  'safebrowsing.googleapis.com',
  'ohttp-relay-safebrowsing-android.google.fastly-edge.com',
  'clientservices.googleapis.com',
] as const;

/**
 * The connectivity check's plain-HTTP probe on www.google.com, which serves apps too, while other
 * apps use this path on other hosts: only this exact URL marks the check. (Its probe on
 * play.googleapis.com goes with that host.)
 */
export const ANDROID_PROBE_URLS = ['http://www.google.com/gen_204'] as const;

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
