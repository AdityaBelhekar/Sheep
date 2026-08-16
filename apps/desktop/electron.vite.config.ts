import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const here = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(here, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
