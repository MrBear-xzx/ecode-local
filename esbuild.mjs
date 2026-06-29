import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
