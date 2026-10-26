import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { connect, finished, repo } from './helpers.mjs';

async function setup(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'seekwing-grok-'));
  const workspace = path.join(root, 'workspace'), state = path.join(root, 'state'), trace = path.join(root, 'trace.jsonl');
  await mkdir(workspace);
  const extraEnv = { SEEKWING_GROK_COMMAND: process.execPath, SEEKWING_GROK_ARGS: JSON.stringify([path.join(repo, 'test/fake-grok.mjs')]),
    SEEKWING_GROK_HOME: path.join(root, 'grok'), SEEKWING_GROK_FIXTURE_TRACE: trace, ...extra };
  const c = await connect(state, { extraEnv });
  t.after(async () => { await c.close(); await rm(root, { recursive: true, force: true }); });
  return { ...c, root, state, workspace, extraEnv, trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('long-running sessions continue retaining new tool results after the first hundred calls',async t=>{
  const c=await setup(t);
  const run=await c.call('start_task',{backend:'grok',workspace:c.workspace,instruction:'MANY_TOOLS'});
  const done=await finished(c,run.runId);
  assert.equal(done.status,'completed');assert.equal(done.toolCallCount,100);assert.equal(done.toolCallsTruncated,true);
  assert.ok(done.toolCalls.some(call=>call.toolCallId==='call-124'));
  assert.ok(!done.toolCalls.some(call=>call.toolCallId==='call-0'));
  const saved=JSON.parse(await readFile(path.join(c.state,'runs',run.runId+'.json'),'utf8'));
  assert.equal(Object.keys(saved.toolCalls).length,100);assert.equal(saved.toolCalls['call-124'].content[0].content.text,'result 124');
});

test('Grok discovery, auth, exact model/reasoning, native sandbox and persisted resume through MCP', async t => {
  const c = await setup(t);
  const diagnostic = await c.call('doctor', { backend: 'grok' });
  assert.equal(diagnostic.backend, 'grok');
  assert.ok(!(await c.trace()).some(r => r.method === 'authenticate'), 'doctor must not authenticate or create a session');
  const catalog = await c.call('inspect_models', { backend: 'grok', workspace: c.workspace });
  assert.equal(catalog.configOptions[0].currentValue, 'grok-test');
  const input = { backend: 'grok', workspace: c.workspace, instruction: 'HELLO', modelValue: 'grok-other', reasoningEffort: 'low', idempotencyKey: 'grok-first' };
  const run = await c.call('start_task', input);
  const first = await finished(c, run.runId);
  assert.equal(first.status, 'completed');
  assert.equal(first.backend, 'grok');
  assert.equal(first.configuredDefaultRoute.provider, 'grok-cli');
  assert.match(first.output, /GROK_TURN_1 grok-other low/);
  assert.equal((await c.call('start_task', input)).runId, run.runId);
  assert.equal((await c.call('start_task', { ...input, backend: 'deepseek' }, { allowError: true })).isError, true);
  await c.close();
  const next = await connect(c.state, { extraEnv: { ...c.extraEnv, SEEKWING_BACKEND: 'deepseek', SEEKWING_GROK_MODEL: 'grok-test' } });
  try {
    const follow = await next.call('reply_task', { runId: run.runId, instruction: 'FOLLOW_UP' });
    const second = await finished(next, follow.runId);
    assert.equal(second.status, 'completed');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.backend, 'grok');
    assert.match(second.output, /GROK_TURN_2 grok-other low/);
  } finally { await next.close(); }
  const records = await c.trace();
  const launches = records.filter(r => r.method === 'initialize');
  assert.ok(launches.every(r => r.argv.includes('--no-leader') && r.argv.includes('read-only') && r.autoBash === 'false'));
  assert.ok(records.filter(r => r.method === 'authenticate').every(r => r.params.methodId === 'cached_token' && r.params._meta.headless));
  assert.ok(records.some(r => r.method === 'session/resume'));
});

test('only the selected backend is required; Grok defaults to background despite DeepSeek Desktop preference', async t => {
  const c = await setup(t, { SEEKWING_BACKEND: 'grok', SEEKWING_SESSION_MODE: 'desktop', SEEKWING_DSH_COMMAND: '/not-installed/dsh', SEEKWING_DSH_ARGS: '{invalid' });
  assert.equal((await c.call('doctor')).backend, 'grok');
  const run = await c.call('start_task', { workspace: c.workspace, instruction: 'HELLO' });
  assert.equal((await finished(c, run.runId)).sessionMode, 'background');
  const invalid = await c.call('start_task', { backend: 'grok', sessionMode: 'desktop', workspace: c.workspace, instruction: 'NO' }, { allowError: true });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /background ACP/);
  assert.equal((await c.call('list_tasks')).tasks.length, 1);
});

test('unavailable Grok does not break DeepSeek and legacy runs resume as DeepSeek after default changes', async t => {
  const c = await setup(t, { SEEKWING_GROK_COMMAND: '/not-installed/grok' });
  const input = { workspace: c.workspace, instruction: 'HELLO', idempotencyKey: 'legacy' };
  const run = await c.call('start_task', input);
  assert.equal((await finished(c, run.runId)).status, 'completed');
  const file = path.join(c.state, 'runs', run.runId + '.json');
  const old = JSON.parse(await readFile(file, 'utf8')); delete old.backend;
  await writeFile(file, JSON.stringify(old));
  await c.close();
  const next = await connect(c.state, { extraEnv: { ...c.extraEnv, SEEKWING_BACKEND: 'grok' } });
  try {
    assert.equal((await next.call('start_task', { ...input, backend: 'deepseek' })).runId, run.runId);
    const follow = await next.call('reply_task', { runId: run.runId, instruction: 'FOLLOW_UP' });
    const done = await finished(next, follow.runId);
    assert.equal(done.backend, 'deepseek');
    assert.match(done.output, /TURN_2/);
    assert.equal((await next.call('doctor', { backend: 'grok' }, { allowError: true })).isError, true);
  } finally { await next.close(); }
});

test('Grok permissions stay pending, refuse read-only or persistent grants, and accept explicit once decisions', async t => {
  const c = await setup(t);
  for (const permissionMode of ['read-only', 'workspace-write']) {
    const run = await c.call('start_task', { backend: 'grok', workspace: c.workspace, permissionMode, instruction: 'PERMISSION' });
    const pending = await c.call('wait_task', { runId: run.runId, seconds: 5 });
    assert.equal(pending.status, 'needs_attention');
    const permissionId = pending.pendingPermissions[0].id;
    assert.equal((await c.call('respond_to_permission', { runId: run.runId, permissionId, optionId: 'always' }, { allowError: true })).isError, true);
    if (permissionMode === 'read-only') assert.equal((await c.call('respond_to_permission', { runId: run.runId, permissionId, optionId: 'yes' }, { allowError: true })).isError, true);
    const done = await finished(c, run.runId, { permissions: permissionMode === 'workspace-write' ? 'allow' : 'reject' });
    assert.equal(done.status, 'completed');
    assert.match(done.output, new RegExp(`"optionId":"${permissionMode === 'workspace-write' ? 'yes' : 'no'}"`));
  }
});

for (const [name, env, selection, error] of [
  ['missing login', { SEEKWING_GROK_FIXTURE_AUTH: 'fail', XAI_API_KEY: 'xai-fixture-sensitive-12345678' }, {}, /grok login/],
  ['interactive auth only', { SEEKWING_GROK_FIXTURE_AUTH: 'interactive' }, {}, /noninteractive authentication/],
  ['wrong sandbox', { SEEKWING_GROK_FIXTURE_BAD_SANDBOX: '1' }, {}, /requested sandbox/],
  ['wrong workspace', { SEEKWING_GROK_FIXTURE_BAD_CWD: '1' }, {}, /requested sandbox/],
  ['unsupported protocol', { SEEKWING_GROK_FIXTURE_PROTOCOL: '2' }, {}, /Unsupported Grok ACP protocol/],
  ['invalid model', {}, { modelValue: 'invalid' }, /Unknown model/],
  ['silently ignored model', { SEEKWING_GROK_FIXTURE_IGNORE_OPTION: '1' }, { modelValue: 'grok-other' }, /did not accept/],
]) test(`Grok fails before prompt for ${name}`, async t => {
  const c = await setup(t, env);
  const run = await c.call('start_task', { backend: 'grok', workspace: c.workspace, instruction: 'MUST_NOT_RUN', ...selection });
  const done = await finished(c, run.runId);
  assert.equal(done.status, 'failed');
  assert.match(done.error, error);
  assert.ok(!JSON.stringify(done).includes('xai-fixture-sensitive-12345678'));
  assert.ok(!(await c.trace()).some(r => r.method === 'session/prompt'));
});

test('Grok selects advertised API-key auth without sending the key in protocol params', async t => {
  const c = await setup(t, { SEEKWING_GROK_FIXTURE_AUTH: 'key', XAI_API_KEY: 'xai-fixture-sensitive-12345678' });
  await c.call('inspect_models', { backend: 'grok', workspace: c.workspace });
  const auth = (await c.trace()).find(r => r.method === 'authenticate');
  assert.equal(auth.params.methodId, 'xai.api_key');
  assert.ok(!JSON.stringify(auth).includes('xai-fixture-sensitive-12345678'));
});

test('Grok cancellation works across MCP processes and keeps its resumable session', async t => {
  const c = await setup(t);
  const run = await c.call('start_task', { backend: 'grok', workspace: c.workspace, instruction: 'SLOW' });
  const pending = await c.call('wait_task', { runId: run.runId, seconds: 1 });
  assert.equal(pending.status, 'running');
  const other = await connect(c.state, { extraEnv: c.extraEnv });
  try { assert.equal((await other.call('cancel_task', { runId: run.runId })).status, 'cancelled'); }
  finally { await other.close(); }
  const follow = await c.call('reply_task', { runId: run.runId, instruction: 'FOLLOW_UP' });
  const done = await finished(c, follow.runId);
  assert.equal(done.sessionId, pending.sessionId);
  assert.equal(done.status, 'completed');
});
