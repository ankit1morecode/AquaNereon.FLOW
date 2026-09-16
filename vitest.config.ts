import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // The whole measurement chain is pure TypeScript with no DOM or WebGL
    // dependency, which is exactly why it can be tested at all. Only the data
    // sources touch browser globals, and those are injected.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Node by default so the physics suite stays fast; component files
    // opt into jsdom with a @vitest-environment docblock.
    // Several of these advect thousands of tracers for hundreds of steps, or
    // replay a whole scenario through the full chain. They are slow on purpose
    // — the properties being checked only emerge once the pipes have filled —
    // so the default 5 s would fail them on a loaded machine rather than on a
    // real regression.
    testTimeout: 30000,
  },
});
