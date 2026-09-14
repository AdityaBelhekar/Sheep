import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const here = import.meta.dirname;

// Workspace packages ship TypeScript source, so they must be bundled rather
// than externalised like ordinary npm dependencies.
const manifest = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) =>
  name.startsWith('@sheep/'),
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
      rollupOptions: {
        // Two entries, both main-process bundles: `index` is Electron's main,
        // and `orchestrator` is the utility process it forks. They are emitted
        // side by side so main can resolve the child by path at runtime.
        input: {
          index: resolve(here, 'src/main/index.ts'),
          orchestrator: resolve(here, 'src/orchestrator/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
      rollupOptions: {
        input: resolve(here, 'src/preload/index.ts'),
        // The renderer runs with `sandbox: true`, and a sandboxed preload
        // script must be CommonJS.
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(here, 'src/renderer/src'),
        '@shared': resolve(here, 'src/shared'),
        '@resources': resolve(here, 'resources'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(here, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
  },
});
