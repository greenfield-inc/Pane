import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: true, port: Number(process.env.PORT ?? 5173), strictPort: true },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  // The Glassly build unpacks Glassly's own CLI, Bun-only tests included, into glassly/.cache.
  test: { exclude: [...configDefaults.exclude, 'glassly/.cache/**'] },
});
