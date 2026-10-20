import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, finished } from './helpers.mjs';

async function setup(t, extraEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'seekwing-test-'));
  const state = path.join(dir, 'state');
  const workspace = path.join(dir, 'workspace');
  await mkdir(workspace);
  const connection = await connect(state, { extraEnv });
  t.after(async () => { await connection.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...connection, dir, state, workspace };
}

test('MCP discovery, actual completion, redaction, persisted context and idempotent retry', async (t) => {
  const c = await setup(t);
  assert.equal((await c.client.listTools()).tools.length, 9);
  assert.equal((await c.call('doctor')).protocol.agentInfo.version, 'fixture');
  const input = { workspace: c.workspace, instruction: 'HELLO', idempotencyKey: 'first' };
  const first = await c.call('start_task', input);
  const duplicate = await c.call('start_task', input);
  assert.equal(first.runId, duplicate.runId);
  const done = await finished(c, first.runId);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /TURN_1 read-only \[REDACTED\]/);
  assert.equal(done.toolCalls[0].status, 'completed');
  assert.equal(done.reviewRequired, true);
  const raw = await readFile(path.join(c.state, 'runs', first.runId + '.json'), 'utf8');
  assert.ok(!raw.includes('PRIVATE_THOUGHT'));
  assert.ok(!raw.includes('fake-sensitive-value'));
  const mismatch = await c.call('start_task', { ...input, instruction: 'DIFFERENT' }, { allowError: true });
  assert.equal(mismatch.isError, true);
  const follow = await c.call('reply_task', { runId: first.runId, instruction: 'FOLLOW_UP' });
  const second = await finished(c, follow.runId);
  assert.equal(second.sessionId, done.sessionId);
  assert.equal(second.permissionMode, 'read-only');
  assert.match(second.output, /TURN_2/);
  await c.close();
  const next = await connect(c.state);
  try {
    assert.equal((await next.call('get_task', { runId: first.runId })).status, 'completed');
    assert.equal((await next.call('list_tasks')).tasks.length, 2);
  } finally { await next.close(); }
});

test('permission forwarding, read-only escalation refusal, and explicit workspace-write approval', async (t) => {
  const c = await setup(t);
  const first = await c.call('start_task', { workspace: c.workspace, instruction: 'PERMISSION' });
  const pending = await c.call('wait_task', { runId: first.runId, seconds: 10 });
  assert.equal(pending.status, 'needs_attention');
  assert.equal(pending.pendingPermissions[0].toolCall.rawInput.mode, 'read-only');
  const noEscalation = await c.call('respond_to_permission', { runId: first.runId, permissionId: pending.pendingPermissions[0].id, optionId: 'yes' }, { allowError: true });
  assert.equal(noEscalation.isError, true);
  assert.match((await finished(c, first.runId)).output, /"optionId":"no"/);
  const writable = await c.call('start_task', { workspace: c.workspace, instruction: 'PERMISSION', permissionMode: 'workspace-write' });
  const allowed = await finished(c, writable.runId, { permissions: 'allow' });
  assert.match(allowed.output, /"optionId":"yes"/);
  assert.equal(allowed.permissionDecisions.length, 1);
});

test('cancel, cross-process control, and serialization of session follow-ups', async (t) => {
  const c = await setup(t);
  const first = await c.call('start_task', { workspace: c.workspace, instruction: 'SLOW' });
  const running = await c.call('wait_task', { runId: first.runId, seconds: 1 });
  assert.equal(running.status, 'running');
  const other = await connect(c.state);
  try {
    assert.equal((await other.call('cancel_task', { runId: first.runId })).status, 'cancelled');
  } finally { await other.close(); }
  const a = await c.call('reply_task', { runId: first.runId, instruction: 'SLOW' });
  const busy = await c.call('reply_task', { runId: first.runId, instruction: 'OTHER' }, { allowError: true });
  assert.equal(busy.isError, true);
  assert.equal((await c.call('cancel_task', { runId: a.runId })).status, 'cancelled');
});

test('an idempotent retry works when the worker concurrency limit is full', async (t) => {
  const c = await setup(t, { SEEKWING_MAX_CONCURRENT: '1' });
  const input = { workspace: c.workspace, instruction: 'SLOW', idempotencyKey: 'capacity' };
  const first = await c.call('start_task', input);
  assert.equal((await c.call('start_task', input)).runId, first.runId);
  assert.equal((await c.call('start_task', { workspace: c.workspace, instruction: 'OTHER' }, { allowError: true })).isError, true);
  await c.call('cancel_task', { runId: first.runId });
});

test('uncooperative worker is terminated and deadline is reported as a failure', async (t) => {
  const c = await setup(t);
  const first = await c.call('start_task', { workspace: c.workspace, instruction: 'HANG', timeoutSeconds: 10 });
  const done = await finished(c, first.runId, { attempts: 16 });
  assert.equal(done.status, 'failed');
  assert.equal(done.cancellation, 'timeout');
  assert.match(done.error, /deadline exceeded/);
});

test('partial output is paginated, capped, and never confused with completed work', async (t) => {
  const c = await setup(t);
  const first = await c.call('start_task', { workspace: c.workspace, instruction: 'LONG MAX_TOKENS' });
  const done = await finished(c, first.runId);
  assert.equal(done.status, 'incomplete');
  assert.equal(done.outputTruncated, true);
  assert.equal(done.outputLength, 100_000);
  assert.equal(done.nextOutputOffset, 12_000);
  const tail = await c.call('get_task', { runId: first.runId, outputOffset: 99_990, outputLimit: 20 });
  assert.equal(tail.output.length, 10);
  assert.equal(tail.nextOutputOffset, null);
  const bad = await c.call('start_task', { workspace: c.workspace, instruction: 'ERROR' });
  const failed = await finished(c, bad.runId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /fixture failure \[REDACTED\]/);
});

test('allowed workspace roots resolve symlinks before validating scope', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seekwing-scope-'));
  const allowed = path.join(dir, 'allowed');
  const outside = path.join(dir, 'outside');
  await mkdir(allowed); await mkdir(outside);
  await symlink(outside, path.join(allowed, 'escape'), 'dir');
  const c = await connect(path.join(dir, 'state'), { extraEnv: { SEEKWING_ALLOWED_ROOTS: allowed } });
  t.after(async () => { await c.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await c.call('start_task', { workspace: path.join(allowed, 'escape'), instruction: 'HELLO' }, { allowError: true });
  assert.equal(response.isError, true);
  assert.equal((await c.call('list_tasks')).tasks.length, 0);
});

test('a killed server leaves interrupted evidence and never automatically replays the prompt', async (t) => {
  const c = await setup(t);
  const first = await c.call('start_task', { workspace: c.workspace, instruction: 'SLOW', idempotencyKey: 'crash' });
  await c.call('wait_task', { runId: first.runId, seconds: 1 });
  process.kill(c.transport.pid, 'SIGKILL');
  await delay(250);
  const next = await connect(c.state);
  try {
    const recovered = await next.call('get_task', { runId: first.runId });
    assert.equal(recovered.status, 'interrupted');
    const duplicate = await next.call('start_task', { workspace: c.workspace, instruction: 'SLOW', idempotencyKey: 'crash' });
    assert.equal(duplicate.runId, first.runId);
    assert.equal(duplicate.status, 'interrupted');
    assert.equal((await next.call('list_tasks')).tasks.length, 1);
  } finally { await next.close(); }
});
