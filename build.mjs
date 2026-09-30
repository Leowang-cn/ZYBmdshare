import { build } from 'esbuild-wasm';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, splitting: true, format: 'esm', outdir: 'public', minify: true, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]' });
await copyFile('web/index.html', 'public/index.html');