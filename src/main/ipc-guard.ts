/**
 * Every IPC handler goes through `guarded`, so only Wirescry's own UI can call it: never a
 * page that somehow ended up in a window. No Electron imports, so it's testable.
 */

/** Whether `url` is on `origin`, e.g. wirescry://app. Not URL.origin: Node gives "null" for custom schemes. */
export function isOnOrigin(url: string, origin: string): boolean {
  try {
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}` === origin;
  } catch {
    return false;
  }
}

/** What Electron passes an IPC handler, as far as the guard needs. */
export interface IpcSender {
  senderFrame?: { url: string } | null;
}

/** Wraps an IPC handler so it refuses calls from anywhere but `origin`. */
export function guarded<E extends IpcSender, A extends unknown[], R>(
  origin: string,
  handler: (event: E, ...args: A) => R,
): (event: E, ...args: A) => R {
  return (event, ...args) => {
    if (!isOnOrigin(event.senderFrame?.url ?? '', origin)) throw new Error('Not allowed');
    return handler(event, ...args);
  };
}
