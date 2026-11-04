/**
 * Entry point of Pro's API spec checker, run by Pro in a worker thread of the backend.
 * All it does is load Pro's worker module, which starts itself when it's in that worker:
 * the module is built into Pro's bytecode chunk, so this file is the only readable part.
 */
import '@wirescry/pro/check-worker';
