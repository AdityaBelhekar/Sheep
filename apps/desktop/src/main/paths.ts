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

/**
 * The bundled Python runtime.
 *
 * A packaged build carries it under resources; a checkout runs the one
 * `npm run fetch-runtime` installed in the sandbox package.
 */
export function runtimePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'python')
    : join(import.meta.dirname, '../../../../packages/sandbox/runtime');
}

/** The bundled rendering tools: Graphviz and Tectonic. Fetched by `npm run fetch-tools`. */
export function toolsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tools')
    : join(import.meta.dirname, '../../../../packages/artifacts/tools');
}

/** Absolute path to a file emitted next to the main bundle in `out/`. */
export function bundlePath(...segments: string[]): string {
  return join(import.meta.dirname, '..', ...segments);
}
