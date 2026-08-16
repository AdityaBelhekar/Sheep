import { join } from 'node:path';
import { app } from 'electron';

/**
 * Absolute path to a bundled resource.
 *
 * In development and unpackaged builds the main bundle lives at
 * `out/main/index.js`, so resources sit two levels up. Packaged builds copy the
 * same folder into `process.resourcesPath`.
 */
export function resourcePath(...segments: string[]): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...segments)
    : join(import.meta.dirname, '../../resources', ...segments);
}

/** Absolute path to a file emitted next to the main bundle in `out/`. */
export function bundlePath(...segments: string[]): string {
  return join(import.meta.dirname, '..', ...segments);
}
