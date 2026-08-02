import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/integration/**'],
    // Node 24 exposes an incomplete experimental localStorage global. The VM
    // pool gives happy-dom its own browser global instead of probing Node's
    // getter once per worker and flooding otherwise clean test output.
    pool: 'vmForks',
  },
});
