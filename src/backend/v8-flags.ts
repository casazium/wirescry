/**
 * Lets the backend (and plugins) compile regular expressions with the `l` flag, which V8
 * runs in linear time and refuses for patterns that could backtrack catastrophically.
 * Imported first by ./index.ts, so it runs before any other module's code.
 */
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--enable-experimental-regexp-engine');
