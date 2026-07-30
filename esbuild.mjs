import * as esbuild from 'esbuild';
import * as fs from 'fs/promises';
import * as path from 'path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const babelRuntime = path.join('node_modules', '@babel', 'standalone', 'babel.min.js');
const bundledBabelRuntime = path.join('out', 'babel.min.js');

await fs.mkdir('out', { recursive: true });
await fs.copyFile(babelRuntime, bundledBabelRuntime);

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outdir: 'out',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  loader: {
    '.wasm': 'file',
  },
  minify: production,
  keepNames: true,
});

if (watch) {
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await ctx.rebuild();
  console.log('[esbuild] build complete');
  await ctx.dispose();
}
