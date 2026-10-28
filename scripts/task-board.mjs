import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function buildTaskBoard() {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/task-markdown.mjs'],
    platform: 'browser', target: 'es2022', format: 'iife', globalName: 'seekwingMarkdown',
    bundle: true, write: false, minify: true, legalComments: 'eof', metafile: true,
  });
  const source = await readFile(new URL('../src/task-board.html', import.meta.url), 'utf8');
  const marker = '/* SEEKWING_MARKDOWN */';
  if (!source.includes(marker)) throw new Error('Task card Markdown bundle marker is missing');
  // A literal closing script tag must not terminate the inline bundle early.
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  return { html: source.replace(marker, () => script), metafile: result.metafile };
}
