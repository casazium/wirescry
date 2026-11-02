import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { MAX_HAR_IMPORT_BYTES } from '../backend/har';
import type { HarExportResult, HarImportResult, SaveBodyRequest, SaveBodyResult } from '../shared/ipc';
import type { BackendSupervisor } from './backend-supervisor';

/** At most this many exchanges per export (the traffic list keeps 10,000). */
const MAX_EXPORT_IDS = 10_000;
const EXCHANGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HAR_FILTERS = [{ name: 'HAR (HTTP Archive)', extensions: ['har'] }];

/** A file name for today's export, e.g. `wirescry-2026-10-26.har`. */
function defaultName(): string {
  return `wirescry-${new Date().toISOString().slice(0, 10)}.har`;
}

/**
 * A scratch file in Wirescry's own data folder. The backend reads and writes HAR files
 * only there: macOS lets the app reach a file the user picked in a dialog, but not other
 * files beside it, and only the process that showed the dialog. So the main process
 * copies between the user's file and the scratch one.
 */
const scratchDir = (): string => path.join(app.getPath('userData'), 'har-transfer');

async function scratchFile(): Promise<string> {
  const dir = scratchDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${randomBytes(8).toString('hex')}.har`);
}

/** Removes scratch files left by a crash or a job that took too long. Call once at startup. */
export async function clearScratch(): Promise<void> {
  await rm(scratchDir(), { recursive: true, force: true });
}

/**
 * Asks where to save, has the backend write the exchanges to a scratch file, then copies
 * it into place. The user picks the place in a system dialog, so the UI can't write
 * anywhere on its own, and large captures never pass through the UI.
 */
export async function exportHar(
  window: BrowserWindow | undefined,
  backend: BackendSupervisor,
  request: unknown,
): Promise<HarExportResult> {
  if (
    !Array.isArray(request) ||
    request.length === 0 ||
    request.length > MAX_EXPORT_IDS ||
    !request.every((id) => typeof id === 'string' && EXCHANGE_ID.test(id))
  ) {
    throw new Error('Nothing to export.');
  }
  const options = {
    defaultPath: path.join(app.getPath('downloads'), defaultName()),
    filters: HAR_FILTERS,
  };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return {};
  const scratch = await scratchFile();
  try {
    const { count } = (await backend.har({ op: 'export', file: scratch, exchangeIds: request })) as {
      count: number;
    };
    // Copied beside the target and renamed into place, so a full disk never leaves half a
    // file, or spoils a file the user chose to replace.
    const temp = `${result.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await copyFile(scratch, temp);
      await rename(temp, result.filePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { name: path.basename(result.filePath), count };
  } finally {
    await rm(scratch, { force: true });
  }
}

/** Asks the user to pick a HAR file, then has the backend add its exchanges. */
export async function importHar(
  window: BrowserWindow | undefined,
  backend: BackendSupervisor,
): Promise<HarImportResult> {
  const options = {
    properties: ['openFile' as const],
    filters: [...HAR_FILTERS, { name: 'JSON', extensions: ['json'] }],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  if (result.canceled || !file) return {};
  const info = await stat(file);
  if (!info.isFile()) throw new Error("That isn't a file.");
  if (info.size > MAX_HAR_IMPORT_BYTES) {
    throw new Error(`That file is larger than ${MAX_HAR_IMPORT_BYTES / 1024 / 1024} MB.`);
  }
  const scratch = await scratchFile();
  try {
    await copyFile(file, scratch);
    const value = (await backend.har({ op: 'import', file: scratch, name: path.basename(file) })) as Required<
      Omit<HarImportResult, 'name'>
    >;
    return { name: path.basename(file), ...value };
  } finally {
    await rm(scratch, { force: true });
  }
}

/** A safe file name from the UI's suggestion, e.g. `users.json`, or `body` if there's nothing usable. */
export function bodyFileName(suggested: unknown): string {
  const name = typeof suggested === 'string' ? path.basename(suggested) : '';
  const clean = name
    .split('')
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '<>:"/\\|?*'.includes(c) ? '_' : c))
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return clean || 'body';
}

/**
 * Asks where to save one body of an exchange, has the backend write all of it (decoded
 * where possible) to a scratch file, then copies it into place. The UI only holds the
 * first few megabytes of a body, so the backend writes it.
 */
export async function saveBody(
  window: BrowserWindow | undefined,
  backend: BackendSupervisor,
  request: unknown,
): Promise<SaveBodyResult> {
  const r = request as Partial<SaveBodyRequest> | null;
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof r.exchangeId !== 'string' ||
    !EXCHANGE_ID.test(r.exchangeId) ||
    (r.side !== 'request' && r.side !== 'response')
  ) {
    throw new Error('Nothing to save.');
  }
  const options = { defaultPath: path.join(app.getPath('downloads'), bodyFileName(r.name)) };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return {};
  const scratch = await scratchFile();
  try {
    const written = (await backend.har({
      op: 'body',
      file: scratch,
      exchangeId: r.exchangeId,
      side: r.side,
    })) as { size: number; decoded: boolean; decodeError?: string };
    const temp = `${result.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await copyFile(scratch, temp);
      await rename(temp, result.filePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return {
      name: path.basename(result.filePath),
      size: written.size,
      ...(written.decodeError ? { decodeError: written.decodeError } : {}),
    };
  } finally {
    await rm(scratch, { force: true });
  }
}
