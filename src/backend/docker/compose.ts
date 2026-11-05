import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { COMPOSE_DIR_LABEL, COMPOSE_FILES_LABEL, isHostName } from './container';

/** Compose files bigger than this aren't read. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How many files `include:` may pull in, in all. */
const MAX_FILES = 20;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The host names containers in a Compose project can use for each other: service names,
 * container_name and hostname values, and network aliases, from the files Compose names in
 * its labels. Files that can't be read are skipped; this only helps requests between
 * containers skip the proxy, so a miss costs a failed request, not the container.
 */
export async function composeNames(labels: unknown): Promise<string[]> {
  if (!isObject(labels)) return [];
  const files = labels[COMPOSE_FILES_LABEL];
  if (typeof files !== 'string' || !files) return [];
  const workingDir =
    typeof labels[COMPOSE_DIR_LABEL] === 'string' ? (labels[COMPOSE_DIR_LABEL] as string) : '';
  const queue = files
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => (path.isAbsolute(file) || !workingDir ? file : path.join(workingDir, file)));
  const read = new Set<string>();
  const names = new Set<string>();
  while (queue.length > 0 && read.size < MAX_FILES) {
    const file = queue.shift()!;
    if (read.has(file)) continue;
    read.add(file);
    let doc: unknown;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      doc = parse(await readFile(file, 'utf8'), { maxAliasCount: 100 });
    } catch {
      continue;
    }
    if (!isObject(doc)) continue;
    const services = isObject(doc.services) ? doc.services : {};
    for (const [name, service] of Object.entries(services)) {
      names.add(name);
      if (!isObject(service)) continue;
      for (const key of ['container_name', 'hostname'] as const) {
        if (typeof service[key] === 'string') names.add(service[key]);
      }
      if (isObject(service.networks)) {
        for (const network of Object.values(service.networks)) {
          if (!isObject(network) || !Array.isArray(network.aliases)) continue;
          for (const alias of network.aliases) if (typeof alias === 'string') names.add(alias);
        }
      }
    }
    // include: a path, a list of paths, or entries with a `path` (one or a list).
    const includes = Array.isArray(doc.include) ? doc.include : [];
    for (const entry of includes) {
      const paths = typeof entry === 'string' ? [entry] : isObject(entry) ? [entry.path].flat() : [];
      for (const p of paths) {
        if (typeof p === 'string') queue.push(path.isAbsolute(p) ? p : path.join(path.dirname(file), p));
      }
    }
  }
  return [...names].filter(isHostName);
}
