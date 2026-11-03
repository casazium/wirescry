import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type {
  ChooseFilePathResult,
  OpenTextFileRequest,
  OpenTextFileResult,
  SaveTextFileRequest,
  SaveTextFileResult,
} from '../shared/ipc';

/** Text files the UI may save or open through a dialog, e.g. exported rules. */
export const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;

const EXTENSION = /^[a-z0-9]{1,10}$/;

/** A suggested file name without folders, control characters or characters Windows forbids. */
function safeFileName(name: string): string {
  // Split on both kinds of slash, so this works the same on every system.
  return [...(name.split(/[\\/]/).pop() ?? '')]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch !== '\x7f' && !'<>:"/\\|?*'.includes(ch))
    .join('')
    .slice(0, 100);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extensionsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) throw new Error('Invalid file types.');
  for (const ext of value)
    if (typeof ext !== 'string' || !EXTENSION.test(ext)) throw new Error('Invalid file type.');
  return value as string[];
}

/**
 * Asks where to save some text, then saves it. The user picks the place in a system
 * dialog, so the UI can't write anywhere on its own.
 */
export async function saveTextFile(
  window: BrowserWindow | undefined,
  request: unknown,
): Promise<SaveTextFileResult> {
  if (!isObject(request)) throw new Error('Invalid request.');
  const { text, defaultName } = request as Partial<SaveTextFileRequest>;
  const extensions = extensionsOf(request.extensions);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_FILE_BYTES)
    throw new Error('The file is too large.');
  const name = typeof defaultName === 'string' ? safeFileName(defaultName) : '';
  const options = {
    defaultPath: path.join(app.getPath('downloads'), name || `export.${extensions[0]}`),
    filters: [{ name: extensions.join(', ').toUpperCase(), extensions }],
  };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return {};
  await writeFile(result.filePath, text, 'utf8');
  return { name: path.basename(result.filePath) };
}

/** Asks the user to pick a text file, then returns its name and contents. */
export async function openTextFile(
  window: BrowserWindow | undefined,
  request: unknown,
): Promise<OpenTextFileResult> {
  if (!isObject(request)) throw new Error('Invalid request.');
  const extensions = extensionsOf((request as Partial<OpenTextFileRequest>).extensions);
  const options = {
    properties: ['openFile' as const],
    filters: [{ name: extensions.join(', ').toUpperCase(), extensions }],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  if (result.canceled || !file) return {};
  if ((await stat(file)).size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`That file is larger than ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB.`);
  }
  return { name: path.basename(file), text: await readFile(file, 'utf8') };
}

/**
 * Asks the user to pick a file and returns its full path, e.g. for a rule that replies
 * with a file. Nothing is read; the user picked the file in a system dialog.
 */
export async function chooseFilePath(
  window: BrowserWindow | undefined,
  request: unknown,
): Promise<ChooseFilePathResult> {
  if (!isObject(request)) throw new Error('Invalid request.');
  const raw = request.extensions;
  // No extensions, or an empty list, means any file.
  const extensions =
    raw === undefined || (Array.isArray(raw) && raw.length === 0) ? undefined : extensionsOf(raw);
  const options = {
    properties: ['openFile' as const],
    filters: extensions ? [{ name: extensions.join(', ').toUpperCase(), extensions }] : [],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  return result.canceled || !file ? {} : { path: file };
}
