import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', '{apps,packages}/*/test/**/*.test.ts'],
    environment: 'node',
    // Stage 0 starts with zero tests; the suite must still exit green.
    passWithNoTests: true,
    restoreMocks: true,
  },
});
