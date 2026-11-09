/**
 * Guards for two things that fail only in the packaged app, under Electron's BoringSSL, where the
 * Node test runs can't see them:
 *
 * - Mockttp's relaxed upstream TLS (ignoreHostHttpsErrors) adds `@SECLEVEL=0` to its ciphers,
 *   which BoringSSL refuses, and Wirescry never ignores a server's certificate errors anyway.
 *   mirrorTlsFingerprint needs tls-impersonate, which isn't shipped.
 * - tls-impersonate is OpenSSL-only native code: loaded under Electron it crashes the app. It's
 *   left out of the package, and nothing native is rebuilt for Electron (npmRebuild: false), so
 *   no other shipped package may need native code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.join(import.meta.dirname, '..');

/** The Mockttp options that must not appear in Wirescry's code (the last is their serialized name). */
const RELAXED_TLS = ['ignoreHostHttpsErrors', 'mirrorTlsFingerprint', 'ignoreHostCertificateErrors'];

/**
 * The names and strings in the code: identifiers, property names and string literals, as
 * TypeScript parses them. Comments aren't part of the code, so one that names an option doesn't
 * count, and strings, templates or regular expressions that hold `//` or `/*` don't hide anything.
 */
function namesIn(file: string, source: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX));
  return names;
}

/** Each use of a relaxed TLS option in `files` (name → source), as "file: option". */
function relaxedTlsUses(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([name, source]) => {
    const names = namesIn(name, source);
    return RELAXED_TLS.filter((option) => names.has(option)).map((option) => `${name}: ${option}`);
  });
}

function sourcesIn(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const file = path.join(dir, entry);
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && statSync(file).isFile()) {
      files[path.relative(root, file)] = readFileSync(file, 'utf8');
    }
  }
  return files;
}

interface LockEntry {
  dev?: boolean;
  optional?: boolean;
  hasInstallScript?: boolean;
  gypfile?: boolean;
  /** Set on platform-specific packages, which is how prebuilt native binaries are published. */
  os?: string[];
  cpu?: string[];
}

/** Whether an installed package holds a compiled Node addon (a `.node` file, not a folder). */
function hasAddon(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).some(
    (entry) => entry.endsWith('.node') && statSync(path.join(dir, entry)).isFile(),
  );
}

/**
 * The shipped (not dev-only) packages in a package-lock that need native code: an install script,
 * a binding.gyp, a platform-specific package, or prebuilt binaries. `exists` says whether a file
 * is in the installed package, `addon` whether it holds a compiled addon.
 */
function shippedNativePackages(
  packages: Record<string, LockEntry>,
  exists: (file: string) => boolean,
  addon: (location: string) => boolean,
): string[] {
  return Object.entries(packages)
    .filter(([location, entry]) => location !== '' && !entry.dev)
    .filter(
      ([location, entry]) =>
        entry.hasInstallScript ||
        entry.gypfile ||
        entry.os !== undefined ||
        entry.cpu !== undefined ||
        exists(path.posix.join(location, 'binding.gyp')) ||
        exists(path.posix.join(location, 'prebuilds')) ||
        addon(location),
    )
    .map(([location]) => location.replace(/^.*node_modules\//, ''));
}

describe('Relaxed upstream TLS', () => {
  it('isn’t used anywhere in the app’s code', () => {
    const files = sourcesIn(path.join(root, 'src'));
    expect(Object.keys(files).length).toBeGreaterThan(50);
    expect(relaxedTlsUses(files)).toEqual([]);
  });

  it('is found in code that uses it, however it’s written', () => {
    expect(
      relaxedTlsUses({
        'a.ts': 'getLocal({ https, ignoreHostHttpsErrors: true })',
        'b.ts': "rule.thenPassThrough({ ignoreHostHttpsErrors: ['example.com'] })",
        'c.ts': "const options = { ['mirrorTlsFingerprint']: true };",
        'd.ts': 'const o = {\n  // fine\n  ignoreHostHttpsErrors,\n};',
        'e.ts': 'const url = "https://example.com"; passThrough({ ignoreHostHttpsErrors: true })',
        // Strings, templates and regular expressions that look like comments don't hide it.
        'f.ts': "const accept = '*/*';\nconst o = { ignoreHostHttpsErrors: true };\n/** doc */",
        'g.ts': 'const u = `${a}//${b}`; const o = { ignoreHostHttpsErrors: true };',
        'h.ts': "const glob = 'src/*';\nconst o = { mirrorTlsFingerprint: true };\n/** x */",
        'i.ts': 'const re = /a\\/\\//; const o = { ignoreHostHttpsErrors: true };',
        'j.ts': 'const rule = { type: "passthrough", ignoreHostCertificateErrors: ["example.com"] };',
      }),
    ).toEqual([
      'a.ts: ignoreHostHttpsErrors',
      'b.ts: ignoreHostHttpsErrors',
      'c.ts: mirrorTlsFingerprint',
      'd.ts: ignoreHostHttpsErrors',
      'e.ts: ignoreHostHttpsErrors',
      'f.ts: ignoreHostHttpsErrors',
      'g.ts: ignoreHostHttpsErrors',
      'h.ts: mirrorTlsFingerprint',
      'i.ts: ignoreHostHttpsErrors',
      'j.ts: ignoreHostCertificateErrors',
    ]);
  });

  it('isn’t found in comments, or in longer names', () => {
    expect(
      relaxedTlsUses({
        'a.ts': '// never set ignoreHostHttpsErrors\nconst x = 1;',
        'b.ts': '/* mirrorTlsFingerprint needs tls-impersonate */ const y = 2;',
        'c.ts': 'const ignoreHostHttpsErrorsCount = 0;',
      }),
    ).toEqual([]);
  });
});

describe('The package', () => {
  const require = createRequire(import.meta.url);
  const config = require(path.join(root, 'electron-builder.cjs')) as {
    files: string[];
    npmRebuild?: boolean;
  };

  it('leaves out tls-impersonate, and rebuilds nothing for Electron', () => {
    expect(config.files).toContain('!node_modules/tls-impersonate/**');
    expect(config.npmRebuild).toBe(false);
  });

  it('ships no package that needs native code, other than the one it leaves out', () => {
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, LockEntry>;
    };
    const native = shippedNativePackages(
      lock.packages,
      (file) => existsSync(path.join(root, file)),
      (location) => hasAddon(path.join(root, location)),
    );
    expect(native).toEqual(['tls-impersonate']);
  });

  it('spots a shipped package with native code, but not a dev-only one', () => {
    const files = new Set(['node_modules/gyp-thing/binding.gyp', 'node_modules/prebuilt/prebuilds']);
    const addons = new Set(['node_modules/@scope/napi-darwin-arm64-loose']);
    expect(
      shippedNativePackages(
        {
          '': {},
          'node_modules/plain': {},
          'node_modules/installs': { hasInstallScript: true },
          'node_modules/gyp-thing': {},
          'node_modules/prebuilt': {},
          'node_modules/a/node_modules/nested': { hasInstallScript: true },
          'node_modules/dev-native': { dev: true, hasInstallScript: true },
          'node_modules/gypfile': { gypfile: true },
          'node_modules/@scope/napi-darwin-arm64': { os: ['darwin'], cpu: ['arm64'], optional: true },
          'node_modules/@scope/napi-darwin-arm64-loose': {},
          'node_modules/dev-platform': { dev: true, os: ['win32'] },
        },
        (file) => files.has(file),
        (location) => addons.has(location),
      ),
    ).toEqual([
      'installs',
      'gyp-thing',
      'prebuilt',
      'nested',
      'gypfile',
      '@scope/napi-darwin-arm64',
      '@scope/napi-darwin-arm64-loose',
    ]);
  });

  it('counts a .node file as an addon, but not a folder named that way', () => {
    const modules = path.join(root, 'node_modules');
    // tls-impersonate's prebuilt binaries; brotli-wasm has a folder called pkg.node, no native code.
    expect(hasAddon(path.join(modules, 'tls-impersonate'))).toBe(true);
    expect(existsSync(path.join(modules, 'brotli-wasm/pkg.node'))).toBe(true);
    expect(hasAddon(path.join(modules, 'brotli-wasm'))).toBe(false);
    expect(hasAddon(path.join(modules, 'no-such-package'))).toBe(false);
  });
});
