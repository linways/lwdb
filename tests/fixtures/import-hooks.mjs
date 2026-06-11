// Resolution hook (runs on the loader thread): append each requested
// specifier to the file named by LWDB_IMPORT_LOG.
import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  if (process.env.LWDB_IMPORT_LOG) {
    try { appendFileSync(process.env.LWDB_IMPORT_LOG, specifier + '\n'); } catch { /* best effort */ }
  }
  return nextResolve(specifier, context);
}
