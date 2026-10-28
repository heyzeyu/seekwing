import { build } from 'esbuild';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTaskBoard } from './task-board.mjs';

const taskBoard = await buildTaskBoard();

const result = await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/seekwing.mjs',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  loader: { '.html': 'text' },
  plugins: [{ name: 'task-board-markdown', setup(build) {
    build.onLoad({ filter: /task-board\.html$/ }, () => ({ contents: taskBoard.html, loader: 'text' }));
  } }],
  minify: true,
  legalComments: 'eof',
  metafile: true,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await chmod('dist/seekwing.mjs', 0o755);
await build({ entryPoints: ['src/desktop-plugin.ts'], outfile: 'desktop/index.mjs',
  platform: 'node', target: 'node22', format: 'esm', bundle: true, minify: true, legalComments: 'eof' });
await writeFile('desktop/LICENSE', await readFile('LICENSE', 'utf8'));

const packages = new Map();
for (const input of new Set([...Object.keys(result.metafile.inputs), ...Object.keys(taskBoard.metafile.inputs)].filter((file) => file.includes('node_modules/')))) {
  let dir = path.dirname(input);
  while (dir !== '.' && dir !== path.dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.set(pkg.name, { dir, ...pkg }); break; }
    } catch {}
    dir = path.dirname(dir);
  }
}
let notices = 'SeekWing bundles the following third-party software. SeekWing source is MIT licensed.\n';
for (const [name, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices += `\n${'='.repeat(72)}\n${name}@${pkg.version} (${pkg.license || 'see below'})\n`;
  const files = (await readdir(pkg.dir)).filter((file) => /^(LICEN[CS]E|COPYING|NOTICE)(\.|$|-)/i.test(file));
  if (!files.length) throw new Error(`Missing bundled license for ${name}`);
  for (const file of files.sort()) notices += `\n--- ${file} ---\n${await readFile(path.join(pkg.dir, file), 'utf8')}\n`;
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices);
