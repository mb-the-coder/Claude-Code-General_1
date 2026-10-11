import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [react()],
  resolve: {
    alias: {
      // In a real Base44 app this is the app's generated client; here it is an in-memory fake backend.
      '@/api/base44Client': here('./stubs/base44Client.ts'),
    },
  },
  css: { postcss: here('.') },
  server: { port: 5173, fs: { allow: [here('..')] } },
});
