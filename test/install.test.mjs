import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repo } from './helpers.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seekwing-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'installer.mjs');
  const capture = path.join(root, 'invocation.json');
  await writeFile(launcher, 'import { writeFile } from "node:fs/promises"; await writeFile(process.env.SEEKWING_INSTALL_CAPTURE, JSON.stringify({ args: process.argv.slice(2), home: process.env.DSH_HOME }));');
  const stateDir = path.join(root, 'state');
  const endpointFile = path.join(root, 'custom', 'my-endpoint.json');
  const desktopHome = path.join(root, 'desktop-home');
  const env = { ...process.env, SEEKWING_DSH_COMMAND: process.execPath, SEEKWING_DSH_ARGS: JSON.stringify([launcher]),
    SEEKWING_STATE_DIR: stateDir, SEEKWING_DESKTOP_ENDPOINT: endpointFile,
    SEEKWING_DESKTOP_HOME: desktopHome, SEEKWING_INSTALL_CAPTURE: capture };
  return { root, stateDir, endpointFile, desktopHome, env, capture };
}

test('Desktop installer registers the complete companion with the exact configured discovery path', async t => {
  const f = await fixture(t);
  const { stdout } = await exec(process.execPath, [path.join(repo, 'dist/seekwing.mjs'), 'desktop-install'], { env: f.env });
  const result = JSON.parse(stdout);
  assert.equal(result.desktopHome, f.desktopHome);
  const invocation = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.deepEqual(invocation.args, ['plugin', '--profile', 'desktop', 'add', result.companionPath]);
  assert.equal(invocation.home, f.desktopHome);
  const patch = JSON.parse(await readFile(path.join(result.companionPath, 'cordis.patch.yml'), 'utf8'));
  assert.equal(patch[0].insert[0].config.endpointFile, f.endpointFile);
  assert.equal(patch[0].insert[0].config.stateDir, path.dirname(f.endpointFile));
  for (const file of ['index.mjs', 'package.json', 'LICENSE']) {
    assert.equal(await readFile(path.join(result.companionPath, file), 'utf8'), await readFile(path.join(repo, 'desktop', file), 'utf8'));
  }
  assert.deepEqual((await readdir(result.companionPath)).sort(), ['LICENSE', 'cordis.patch.yml', 'index.mjs', 'package.json']);
});

test('an incomplete update package leaves all previously installed companion files untouched', async t => {
  const f = await fixture(t);
  const target = path.join(f.stateDir, 'desktop-plugin');
  await mkdir(target, { recursive: true });
  const files = ['index.mjs', 'package.json', 'LICENSE', 'cordis.patch.yml'];
  for (const file of files) await writeFile(path.join(target, file), 'previous-' + file);
  const incomplete = path.join(f.root, 'incomplete-package');
  await mkdir(path.join(incomplete, 'desktop'), { recursive: true });
  await mkdir(path.join(incomplete, 'dist'));
  await copyFile(path.join(repo, 'dist/seekwing.mjs'), path.join(incomplete, 'dist/seekwing.mjs'));
  for (const file of ['index.mjs', 'package.json']) await copyFile(path.join(repo, 'desktop', file), path.join(incomplete, 'desktop', file));
  await assert.rejects(exec(process.execPath, [path.join(incomplete, 'dist/seekwing.mjs'), 'desktop-install'], { env: f.env }), /ENOENT/);
  for (const file of files) assert.ok(await readFile(path.join(target, file), 'utf8') === 'previous-' + file, `${file} was changed by an incomplete update`);
  await assert.rejects(readFile(f.capture), /ENOENT/);
});
