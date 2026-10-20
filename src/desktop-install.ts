import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDir, type Config } from './config.js';

export async function installDesktop(config: Config) {
  // Keep native entry files outside a versioned Codex cache that plugin upgrades can remove.
  const source = fileURLToPath(new URL('../desktop/', import.meta.url));
  const target = path.join(config.stateDir, 'desktop-plugin');
  await privateDir(target);
  for (const file of ['index.mjs', 'package.json', 'LICENSE']) await copyFile(path.join(source, file), path.join(target, file));
  await writeFile(path.join(target, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'seekwing-desktop', name: 'seekwing-desktop', config: { stateDir: path.dirname(config.desktopEndpoint) } }] }], null, 2) + '\n');
  const desktopHome = path.resolve(config.env.SEEKWING_DESKTOP_HOME || config.env.DSH_HOME || path.join(homedir(), '.dsh'));
  // Official plugin management preserves the profile's product rows and user overrides.
  const child = spawn(config.command, [...config.commandArgs, 'plugin', '--profile', 'desktop', 'add', target],
    { env: { ...config.env, DSH_HOME: desktopHome }, stdio: 'inherit', windowsHide: true });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Official Harness plugin installer exited with code ${code}. Stable companion files were preserved at ${target}.`);
  const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  return { installed: pkg.version, desktopHome, companionPath: target, nextStep: 'Restart DeepSeek Harness, then run seekwing desktop-doctor. Existing background sessions are not migrated.' };
}
