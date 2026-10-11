import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Deno-style import used by the Base44 functions; tests supply a fake client instead.
      'npm:@base44/sdk@0.8.40': fileURLToPath(new URL('./tests/stubs/base44-sdk.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
