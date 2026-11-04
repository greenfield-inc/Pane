import { build } from 'esbuild';
import path from 'node:path';

// The repo root may hoist the native app's React; fixtures render with the frontend's.
const react = { react: path.resolve('frontend/node_modules/react'), 'react-dom': path.resolve('frontend/node_modules/react-dom') };

export async function bundleFixture(name: string, alias: Record<string, string> = {}): Promise<string> {
  const { outputFiles } = await build({
    entryPoints: [path.resolve(`tests/fixtures/${name}.tsx`)],
    alias: { ...react, ...alias },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
  });
  return outputFiles[0].text;
}
