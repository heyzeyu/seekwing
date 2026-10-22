import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDir, requireCommand, type Config } from './config.js';

export async function installDesktop(config: Config) {
  await requireCommand(config, 'deepseek');
  // Keep native entry files outside a versioned Codex cache that plugin upgrades can remove.
  const source = fileURLToPath(new URL('../desktop/', import.meta.url));
  const target = path.join(config.stateDir, 'desktop-plugin');
  // Validate the entire input before replacing any part of an existing installation.
  const files = await Promise.all(['package.json', 'LICENSE', 'index.mjs'].map(async file => ({ file, content: await readFile(path.join(source, file)) })));
  const pkg = JSON.parse(files.find(entry => entry.file === 'package.json')!.content.toString('utf8'));
  files.push({ file: 'cordis.patch.yml', content: Buffer.from(JSON.stringify([{ insert: [{ id: 'seekwing-desktop', name: 'seekwing-desktop',
    config: { stateDir: path.dirname(config.desktopEndpoint), endpointFile: config.desktopEndpoint } }] }], null, 2) + '\n') });
  await privateDir(target);
  for (const { file, content } of files) {
    const temporary = path.join(target, file + '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path.join(target, file));
    } finally { await unlink(temporary).catch(() => {}); }
  }
  const desktopHome = path.resolve(config.env.SEEKWING_DESKTOP_HOME || config.env.DSH_HOME || path.join(homedir(), '.dsh'));
  // Official plugin management preserves the profile's product rows and user overrides.
  const child = spawn(config.command, [...config.commandArgs, 'plugin', '--profile', 'desktop', 'add', target],
    { env: { ...config.env, DSH_HOME: desktopHome }, stdio: 'inherit', windowsHide: true });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Official Harness plugin installer exited with code ${code}. Stable companion files were preserved at ${target}.`);
  return { installed: pkg.version, desktopHome, companionPath: target, nextStep: 'Restart DeepSeek Harness, then run seekwing desktop-doctor. Existing background sessions are not migrated.' };
}
