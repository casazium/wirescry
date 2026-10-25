/**
 * A small encrypted value per plugin, for state a plugin wants to keep from being edited
 * on disk (Pro's license, for example). The backend can't use Electron's safeStorage:
 * only the main process can. So the main process encrypts and decrypts (`Encryptor`),
 * and this file reads and writes `secure-store.json` in the plugin's own folder.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginSecureStore, SecureValue } from '../plugin-api/backend';
import type { CryptoReply, CryptoRequest } from '../shared/ipc';

/** Encrypts with the OS keychain, through the main process. Text in, base64 out. */
export interface Encryptor {
  encrypt(text: string): Promise<string>;
  decrypt(data: string): Promise<string>;
}

/** The most a plugin may store, as JSON. */
export const SECURE_STORE_LIMIT = 1024 * 1024;
const FILE = 'secure-store.json';

type Saved = { v: 1; encrypted: true; data: string } | { v: 1; encrypted: false; value: unknown };

/**
 * @param encryptor undefined where the OS has no keychain Wirescry can use (some Linux
 *   setups): values are then stored as plain JSON, and read back with `encrypted: false`.
 */
export function createSecureStore(
  dir: string,
  encryptor: Encryptor | undefined,
  log: (message: string) => void = () => {},
): PluginSecureStore {
  const file = path.join(dir, FILE);
  // One change at a time, so a get() never sees half of a set().
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    encrypted: encryptor !== undefined,

    get: () =>
      serial(async (): Promise<SecureValue | undefined> => {
        let saved: Saved;
        try {
          saved = JSON.parse(await readFile(file, 'utf8')) as Saved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          log(`Couldn't read ${FILE}: ${(error as Error).message}`);
          throw new Error(`The saved value can't be read: ${(error as Error).message}`);
        }
        if (saved?.v !== 1) throw new Error('The saved value is in an unknown format.');
        if (saved.encrypted) {
          if (!encryptor || typeof saved.data !== 'string') {
            throw new Error("The saved value is encrypted, and this computer's keychain isn't available.");
          }
          try {
            return { value: JSON.parse(await encryptor.decrypt(saved.data)), encrypted: true };
          } catch (error) {
            // E.g. the keychain was reset or locked, or the file came from another computer.
            log(`Couldn't decrypt ${FILE}: ${(error as Error).message}`);
            throw new Error(`The saved value can't be decrypted: ${(error as Error).message}`);
          }
        }
        return { value: saved.value, encrypted: false };
      }),

    set: (value: unknown) =>
      serial(async () => {
        const json = JSON.stringify(value);
        if (json === undefined) throw new TypeError('secureStore.set needs a value JSON can hold');
        if (json.length > SECURE_STORE_LIMIT) throw new RangeError('secureStore.set: value is over 1 MB');
        const saved: Saved = encryptor
          ? { v: 1, encrypted: true, data: await encryptor.encrypt(json) }
          : { v: 1, encrypted: false, value: JSON.parse(json) as unknown };
        // Write then rename, so a crash leaves the old value or the new one, never half.
        const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
          await rename(temp, file);
        } catch (error) {
          await rm(temp, { force: true });
          throw error;
        }
      }),

    clear: () => serial(() => rm(file, { force: true })),
  };
}

/**
 * An Encryptor that asks the main process over the utility process's parent port.
 * `send` posts a request; call `receive` with each reply.
 */
export function ipcEncryptor(send: (request: CryptoRequest) => void): Encryptor & {
  /** Whether the main process can encrypt with the OS keychain. Asked once, when needed. */
  available(): Promise<boolean>;
  receive(reply: CryptoReply): void;
} {
  let next = 0;
  const pending = new Map<number, { resolve(data: string): void; reject(error: Error): void }>();
  const call = (op: CryptoRequest['op'], data: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, 60_000);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ type: 'crypto', id, op, data });
    });
  return {
    available: () => call('available', '').then((answer) => answer === 'os'),
    encrypt: (text) => call('encrypt', text),
    decrypt: (data) => call('decrypt', data),
    receive(reply) {
      const waiting = pending.get(reply.id);
      if (!waiting) return;
      pending.delete(reply.id);
      if (reply.ok) waiting.resolve(reply.data);
      else waiting.reject(new Error(reply.error));
    },
  };
}
