// Spawned via `node --import <this file> <entry>` to record every module
// the entry point resolves. Used by lazyImports.test.mjs.
import { register } from 'node:module';

register('./import-hooks.mjs', import.meta.url);
