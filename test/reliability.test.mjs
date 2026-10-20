import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { repo } from './helpers.mjs';

// Import the source managers without exposing test-only commands in the shipped CLI.
const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seekwing-core-'));
await build({ stdin: { contents: 'export { Store } from "./src/store.ts"; export { TaskManager } from "./src/tasks.ts"; export { loadConfig } from "./src/config.ts";', resolveDir: repo },
  outfile: path.join(bundleDir, 'core.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
const { Store, TaskManager, loadConfig } = await import(pathToFileURL(path.join(bundleDir, 'core.mjs')).href);
test.after(() => fs.rm(bundleDir, { recursive: true, force: true }));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seekwing-storage-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const config = await loadConfig({ ...process.env, SEEKWING_STATE_DIR: path.join(root, 'state'),
    SEEKWING_DSH_COMMAND: process.execPath, SEEKWING_DSH_ARGS: JSON.stringify([path.join(repo, 'test/fake-acp.mjs')]) });
  config.cancelGraceMs = 40;
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace, config };
}

test('concurrent stale-lock recovery cannot remove a new live owner', async t => {
  const { config } = await fixture(t);
  const store = new Store(config);
  await store.init();
  const sessionId = 'stale-recovery-race';
  const file = path.join(config.stateDir, 'locks', createHash('sha256').update(sessionId).digest('hex') + '.json');
  const stale = JSON.stringify({ ownerPid: 2147483647, runId: 'old', token: randomUUID() });
  await fs.writeFile(file, stale, { mode: 0o600 });
  const originalRead = fs.readFile;
  const originalUnlink = fs.unlink;
  let reads = 0;
  let unlinks = 0;
  let bothRead;
  const readBarrier = new Promise(resolve => { bothRead = resolve; });
  let firstAcquired;
  const acquireBarrier = new Promise(resolve => { firstAcquired = resolve; });
  fs.readFile = async (...args) => {
    const value = await originalRead(...args);
    if (args[0] === file && value === stale && ++reads <= 2) {
      if (reads === 2) bothRead();
      await readBarrier;
    }
    return value;
  };
  fs.unlink = async (...args) => {
    if (args[0] === file && ++unlinks === 2) await acquireBarrier;
    return originalUnlink(...args);
  };
  syncBuiltinESMExports();
  let results;
  try {
    results = await Promise.allSettled(['first', 'second'].map(run => store.lockSession(sessionId, run).then(release => { firstAcquired(); return release; })));
  } finally {
    fs.readFile = originalRead;
    fs.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
  t.after(async () => { for (const result of results ?? []) if (result.status === 'fulfilled') await result.value(); });
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'Only one contender may own this session');
  const live = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(live.ownerPid, process.pid);
});

test('an interrupted recovery marker fails closed until explicitly inspected and removed', async t => {
  const { config } = await fixture(t);
  const store = new Store(config);
  await store.init();
  const sessionId = 'interrupted-recovery';
  const file = path.join(config.stateDir, 'locks', createHash('sha256').update(sessionId).digest('hex') + '.json');
  const stale = JSON.stringify({ ownerPid: 2147483647, runId: 'old', token: randomUUID() });
  await fs.writeFile(file, stale, { mode: 0o600 });
  await fs.writeFile(file + '.recovery', JSON.stringify({ ownerPid: 2147483647 }), { mode: 0o600 });
  await assert.rejects(store.lockSession(sessionId, 'new'), /inspect.*recovery marker/i);
  assert.equal(await fs.readFile(file, 'utf8'), stale);
  await fs.unlink(file + '.recovery');
  const release = await store.lockSession(sessionId, 'new');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).ownerPid, process.pid);
  await release();
});

test('shutdown during workspace resolution prevents late task admission', async t => {
  const f = await fixture(t);
  const manager = new TaskManager(f.config);
  await manager.init();
  t.after(() => manager.shutdown());
  const original = fs.realpath;
  let entered;
  const resolving = new Promise(resolve => { entered = resolve; });
  let resume;
  const barrier = new Promise(resolve => { resume = resolve; });
  fs.realpath = async (...args) => {
    if (args[0] === f.workspace) { entered(); await barrier; }
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    const start = manager.start({ workspace: f.workspace, instruction: 'HELLO', permissionMode: 'read-only', timeoutSeconds: 60 });
    await resolving;
    await manager.shutdown();
    resume();
    await assert.rejects(start, /shutting down/i);
    assert.equal((await manager.list(10)).length, 0);
  } finally {
    resume();
    fs.realpath = original;
    syncBuiltinESMExports();
  }
});

async function storageFailure(t, permanent) {
  const f = await fixture(t);
  const manager = new TaskManager(f.config);
  await manager.init();
  // Ensure the deliberately uncooperative fixture is reaped even on the old broken implementation.
  t.after(async () => {
    await Promise.allSettled([...manager.jobs.values()].map(job => job.worker?.stop()));
    await manager.shutdown();
  });
  const save = manager.store.save.bind(manager.store);
  let failures = 0;
  manager.store.save = async task => {
    if (Object.keys(task.toolCalls).length && (!failures || permanent)) {
      failures++;
      throw Object.assign(new Error('fixture disk I/O failure'), { code: 'EIO' });
    }
    return save(task);
  };
  const run = await manager.start({ workspace: f.workspace, instruction: 'HANG', permissionMode: 'read-only', timeoutSeconds: 60 });
  let result;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    result = await manager.get(run.runId);
    if (['failed', 'interrupted'].includes(result.status)) break;
    await delay(20);
  }
  assert.ok(failures > 0);
  assert.equal(result.status, 'failed', 'Losing persistence must stop even a worker that ignores cancellation: ' + JSON.stringify({ error: result.error, cleanupError: result.cleanupError }));
  assert.match(result.persistenceError, /fixture disk I\/O failure/);
  assert.match(result.error, /persist/i);
  if (permanent) {
    assert.equal((await manager.list(10)).find(task => task.runId === run.runId).status, 'failed');
    await assert.rejects(manager.start({ workspace: f.workspace, instruction: 'HELLO', permissionMode: 'read-only', timeoutSeconds: 60 }), /storage|persist/i);
  } else {
    assert.equal((await manager.store.get(run.runId)).status, 'failed');
  }
}

test('a transient persistence failure stops a hanging worker and durably records failure', t => storageFailure(t, false));
test('persistent storage loss keeps a truthful in-memory result and refuses more execution', t => storageFailure(t, true));

test('a failed final write never exposes premature completion and recovery permits a new task', async t => {
  const f = await fixture(t);
  const manager = new TaskManager(f.config);
  await manager.init();
  const save = manager.store.save.bind(manager.store);
  let finishing;
  const entered = new Promise(resolve => { finishing = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  t.after(async () => { resume(); await manager.shutdown(); });
  let failed = false;
  manager.store.save = async task => {
    if (task.status === 'completed' && !failed) {
      failed = true; finishing(); await gate;
      throw new Error('fixture final write failure');
    }
    return save(task);
  };
  const task = await manager.start({ workspace: f.workspace, instruction: 'HELLO', permissionMode: 'read-only', timeoutSeconds: 60 });
  await entered;
  assert.equal((await manager.get(task.runId)).status, 'running');
  assert.equal((await manager.list(10)).find(item => item.runId === task.runId).status, 'running');
  resume();
  const result = await manager.wait(task.runId, 3);
  assert.equal(result.status, 'failed');
  assert.match(result.persistenceError, /fixture final write failure/);
  assert.equal((await manager.store.get(task.runId)).status, 'failed');
  const next = await manager.start({ workspace: f.workspace, instruction: 'HELLO', permissionMode: 'read-only', timeoutSeconds: 60 });
  assert.equal((await manager.wait(next.runId, 3)).status, 'completed');
});
