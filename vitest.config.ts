import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import * as path from 'path';

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    // Component tests must execute onMount and the browser Svelte runtime.
    conditions: ['browser'],
    alias: {
      $lib: path.resolve('./src/lib')
    }
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./vitest.setup.ts'],
    silent: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/lib/**/*.{js,ts}'],
      exclude: ['src/lib/**/*.d.ts', 'src/lib/**/*.test.{js,ts}']
    }
  }
});
