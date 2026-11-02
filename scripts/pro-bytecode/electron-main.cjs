// Electron entry point for compile.mjs: runs compile-worker.cjs in a utility process and
// exits 0 if it succeeded. Arguments: <source.js> <out.jsc>
'use strict';
const path = require('node:path');
const { app, utilityProcess } = require('electron');
// The backend's V8 flags, given at launch as the backend gets them (src/main/backend-supervisor.ts).
const v8Flags = require('../../src/shared/backend-v8-flags.json');

if (process.platform === 'darwin') app.dock?.hide();

const [source, out] = process.argv.slice(-2);

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'compile-worker.cjs'), [source, out], {
    stdio: 'inherit',
    execArgv: [`--js-flags=${v8Flags.join(' ')}`],
  });
  let answered = false;
  child.on('message', (result) => {
    answered = true;
    if (result?.ok) {
      console.log(`compiled for ${result.arch}: ${result.bytes} bytes`);
      app.exit(0);
    } else {
      console.error(result?.error ?? 'the compiler sent an unexpected message');
      app.exit(1);
    }
  });
  child.on('exit', (code) => {
    if (answered) return;
    console.error(`the compiler process exited (code ${code}) without an answer`);
    app.exit(1);
  });
});
