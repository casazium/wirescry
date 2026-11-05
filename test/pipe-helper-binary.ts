/**
 * The Docker pipe helper (native/docker-pipe) for tests, built for this computer. Off Windows it
 * uses Unix sockets in place of named pipes, so the relay with it can be tested anywhere.
 *
 * Built with Go when Go is installed (Go's cache makes that quick when nothing changed). Without
 * Go, a helper built earlier is used, or the tests that need it are skipped, unless
 * WIRESCRY_REQUIRE_PIPE_HELPER=1 (set in CI) makes that a failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const source = path.join(__dirname, '..', 'native', 'docker-pipe');
const name = process.platform === 'win32' ? 'wirescry-docker-pipe.exe' : 'wirescry-docker-pipe';
const file = path.join(source, 'bin', `${process.platform}-${process.arch}`, name);

let built: string | undefined | null = null;

export function pipeHelperForTests(): string | undefined {
  if (built !== null) return built;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-docker-pipe.mjs')], {
      stdio: 'pipe',
    });
    built = file;
  } catch (error) {
    if (process.env.WIRESCRY_REQUIRE_PIPE_HELPER === '1' && !existsSync(file)) throw error;
    built = existsSync(file) ? file : undefined;
  }
  return built;
}
