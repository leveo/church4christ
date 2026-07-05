// Temporary node-environment vitest config for token pipeline tests.
// Task 5 folds this into the two-project (node + workers pool) setup.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/tokens.test.ts'],
    environment: 'node',
  },
});
