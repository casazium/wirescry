import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { normalizePath, type Plugin } from 'vite';

/**
 * Wirescry Pro lives in a separate private repo. Set WIRESCRY_PRO_DIR to its
 * checkout to build with Pro; otherwise the free build uses the stubs in src/pro-stub.
 */
const proDir = process.env.WIRESCRY_PRO_DIR ? resolve(process.env.WIRESCRY_PRO_DIR) : undefined;
if (proDir && !existsSync(resolve(proDir, 'src/backend/index.ts'))) {
  throw new Error(`WIRESCRY_PRO_DIR is set, but ${proDir} doesn't look like a wirescry-pro checkout.`);
}
const pluginApi = resolve(__dirname, 'src/plugin-api');
const v8Flags = resolve(__dirname, 'src/backend/v8-flags.ts');
const proBackend = proDir
  ? resolve(proDir, 'src/backend/index.ts')
  : resolve(__dirname, 'src/pro-stub/backend.ts');
const proUi = proDir ? resolve(proDir, 'src/ui/index.ts') : resolve(__dirname, 'src/pro-stub/ui.ts');

/**
 * Module ids as the bundler sees them: real paths (symlinks resolved), forward slashes.
 * Lowercased on Windows, where paths ignore case and drive letters vary.
 */
const idKey = (file: string): string => {
  const key = normalizePath(file.replace(/^\0/, '').split('?')[0] ?? '');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};
const proRoot = proDir ? idKey(realpathSync(proDir)) + '/' : undefined;
const v8FlagsKey = idKey(realpathSync(v8Flags));
const isProModule = (id: string): boolean => proRoot !== undefined && idKey(id).startsWith(proRoot);

/**
 * A second opinion for checkProChunk: resolves the module's file on disk, so a Pro file
 * whose id is spelled differently (another symlink, a Windows short name) still counts.
 */
const nativeProRoot = proDir ? idKey(realpathSync.native(proDir)) + '/' : undefined;
const isProFile = (id: string): boolean => {
  if (!nativeProRoot) return false;
  const file = id.replace(/^\0/, '').split('?')[0] ?? '';
  try {
    return idKey(realpathSync.native(file)).startsWith(nativeProRoot);
  } catch {
    return false; // Virtual modules and the like aren't files.
  }
};

/**
 * Fails the build if any of Pro's backend code would ship outside chunks/pro-*.js,
 * which scripts/pro-bytecode/compile.mjs turns into bytecode. With Pro, also leaves
 * out/main/.pro-build, so electron-builder.cjs knows Pro must be there as bytecode.
 */
function checkProChunk(): Plugin {
  return {
    name: 'wirescry:check-pro-chunk',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (!proRoot) return;
      let found = false;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const pro = Object.keys(chunk.modules).filter((id) => isProModule(id) || isProFile(id));
        if (chunk.name === 'pro') found = true;
        else if (pro.length > 0) {
          this.error(`Pro code would ship readable in ${chunk.fileName}: ${pro.slice(0, 3).join(', ')}`);
        }
      }
      if (!found) this.error('WIRESCRY_PRO_DIR is set, but no Pro chunk was made.');
      this.emitFile({ type: 'asset', fileName: '.pro-build', source: 'Pro is in this build.\n' });
    },
  };
}

/**
 * Lists the npm packages bundled into this part of the app, as .bundled-packages.json
 * next to its output, for scripts/third-party-notices.mjs (which then deletes the file).
 */
function recordBundledPackages(): Plugin {
  return {
    name: 'wirescry:record-bundled-packages',
    apply: 'build',
    generateBundle() {
      const dirs = new Set<string>();
      for (const id of this.getModuleIds()) {
        const file = normalizePath(id.replace(/^\0/, '').split('?')[0] ?? '');
        const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file);
        if (match?.[1]) dirs.add(match[1]);
      }
      this.emitFile({
        type: 'asset',
        fileName: '.bundled-packages.json',
        source: JSON.stringify([...dirs].sort(), null, 2),
      });
    },
  };
}

const releaseDate = process.env.WIRESCRY_RELEASE_DATE ?? new Date().toISOString();
if (Number.isNaN(Date.parse(releaseDate)))
  throw new Error(`WIRESCRY_RELEASE_DATE isn't a date: ${releaseDate}`);

export default defineConfig(() => {
  return {
    main: {
      plugins: [recordBundledPackages(), checkProChunk()],
      define: {
        // Plugins compare it with a license's paid-up date (Pro's perpetual fallback).
        // Releases set WIRESCRY_RELEASE_DATE; other builds use the time of the build.
        'import.meta.env.WIRESCRY_RELEASE_DATE': JSON.stringify(releaseDate),
      },
      resolve: {
        alias: {
          '@wirescry/pro/backend': proBackend,
          '@wirescry/plugin-api': pluginApi,
        },
        // Pro's files sit outside this repo; make sure they use this app's Mockttp.
        dedupe: ['mockttp', '@casazium/license-sdk'],
      },
      build: {
        rolldownOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            // The backend runs in its own utility process; see src/main/backend-supervisor.ts.
            backend: resolve(__dirname, 'src/backend/index.ts'),
            // Formats bodies in a worker thread of the backend; see src/backend/formatter.ts.
            'format-worker': resolve(__dirname, 'src/backend/format-worker.mts'),
          },
          // With Pro, put all of Pro's backend code in one chunk (chunks/pro-*.js), so that
          // scripts/pro-bytecode/compile.mjs can swap it for V8 bytecode before packaging.
          // electron-builder.cjs refuses to package a build where that hasn't happened.
          // v8-flags gets its own chunk too, so it still runs before Pro's code loads.
          output: proDir
            ? {
                codeSplitting: {
                  groups: [
                    { name: 'v8-flags', test: (id: string) => idKey(id) === v8FlagsKey, priority: 2 },
                    { name: 'pro', test: isProModule, priority: 1 },
                  ],
                },
              }
            : undefined,
        },
      },
    },
    preload: {
      plugins: [recordBundledPackages()],
      build: {
        // Sandboxed preloads can only `require('electron')`, so bundle everything else in.
        externalizeDeps: false,
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react(), recordBundledPackages()],
      resolve: {
        alias: {
          '@wirescry/pro/ui': proUi,
          '@wirescry/plugin-api': pluginApi,
        },
        // Pro's files sit outside this repo; make sure they use this app's React.
        dedupe: ['react', 'react-dom'],
      },
      server: proDir ? { fs: { allow: [resolve(__dirname), proDir] } } : undefined,
      build: {
        rolldownOptions: {
          input: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  };
});
