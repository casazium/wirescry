#!/usr/bin/env node
// Builds Wirescry's Docker pipe helper (native/docker-pipe, Go) into
// native/docker-pipe/bin/<platform>-<arch>/.
//
//   node scripts/build-docker-pipe.mjs            this computer's, for tests
//   node scripts/build-docker-pipe.mjs --windows  Windows x64 and arm64, which the app ships
//
// Needs Go 1.21 or later, which fetches the exact version in go.mod's toolchain line if it's not
// that one. Go cross-compiles, so any computer can build the Windows ones. Builds are
// reproducible: no paths, build IDs or VCS stamps.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const source = path.join(root, 'native', 'docker-pipe');

const GOARCH = { x64: 'amd64', arm64: 'arm64' };

/** Where the helper for `platform`/`arch` (Node's names) is built. */
export function helperPath(platform = process.platform, arch = process.arch) {
  const name = platform === 'win32' ? 'wirescry-docker-pipe.exe' : 'wirescry-docker-pipe';
  return path.join(source, 'bin', `${platform}-${arch}`, name);
}

/**
 * The Go that builds it, from go.mod's toolchain line: the notices name that version, and Go
 * fetches it (checked against Go's checksum database) when the one installed is different.
 */
const toolchain = /^toolchain (go\S+)$/m.exec(readFileSync(path.join(source, 'go.mod'), 'utf8'))?.[1];
if (!toolchain) throw new Error('native/docker-pipe/go.mod has no toolchain line');

/** Builds the helper for each [platform, arch] (Node's names). Returns the files. */
export function buildDockerPipe(targets = [[process.platform, process.arch]]) {
  return targets.map(([platform, arch]) => {
    const goarch = GOARCH[arch];
    if (!goarch) throw new Error(`No Go architecture for ${arch}`);
    const out = helperPath(platform, arch);
    execFileSync(
      'go',
      ['build', '-trimpath', '-buildvcs=false', '-mod=readonly', '-ldflags=-s -w -buildid=', '-o', out, '.'],
      {
        cwd: source,
        stdio: 'inherit',
        env: {
          ...process.env,
          CGO_ENABLED: '0',
          GOTOOLCHAIN: toolchain,
          GOOS: platform === 'win32' ? 'windows' : platform,
          GOARCH: goarch,
        },
      },
    );
    return out;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const windows = process.argv.includes('--windows');
  const targets = windows
    ? [
        ['win32', 'x64'],
        ['win32', 'arm64'],
      ]
    : [[process.platform, process.arch]];
  for (const file of buildDockerPipe(targets)) console.log(`Built ${path.relative(root, file)}`);
}
