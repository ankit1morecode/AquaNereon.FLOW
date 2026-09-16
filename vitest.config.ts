import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The whole measurement chain is pure TypeScript with no DOM or WebGL
    // dependency, which is exactly why it can be tested at all. Only the data
    // sources touch browser globals, and those are injected.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several of these advect thousands of tracers for hundreds of steps, or
    // replay a whole scenario through the full chain. They are slow on purpose
    // — the properties being checked only emerge once the pipes have filled —
    // so the default 5 s would fail them on a loaded machine rather than on a
    // real regression.
    testTimeout: 30000,
  },
});
