/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { apiShim } from './dev/api-shim';

export default defineConfig(({ mode }) => {
  // Server side env for the local /api shim only. Nothing here is exposed to
  // the browser bundle (Vite only exposes VITE_ prefixed keys, and we use none).
  const env = loadEnv(mode, process.cwd(), '');
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return {
    plugins: [react(), tailwindcss(), apiShim()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    test: { include: ['engine/**/*.test.ts', 'src/**/*.test.ts', 'api/**/*.test.ts'] },
  };
});
