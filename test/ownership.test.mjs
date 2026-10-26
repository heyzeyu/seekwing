import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { connect, finished } from './helpers.mjs';

async function setup(t, extraEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'seekwing-ownership-'));
  const state = path.join(dir, 'state'), workspace = path.join(dir, 'workspace');
  await mkdir(workspace);
  const env = { CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', SEEKWING_GROK_COMMAND: '/not-installed/grok', ...extraEnv };
  const c = await connect(state, { extraEnv: env });
  t.after(async () => { await c.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...c, state, workspace, env };
}

test('capability discovery does not open native sessions and distinguishes adapter from native abilities', async t => {
  const c = await setup(t);
  const info = await c.call('list_backends');
  assert.equal(info.backends.length, 2);
  assert.equal(info.backends[0].commandAvailable, true);
  assert.equal(info.backends[1].commandAvailable, false);
  assert.deepEqual(info.backends[1].sessionModes, ['background']);
  assert.deepEqual(info.backends[0].sessionModes, ['background', 'desktop']);
  assert.ok(info.backends.every(b => !b.imageInput && b.promptContentTypes.join() === 'text'));
  assert.equal(info.caller.source, 'unknown');
  assert.equal(info.presentation.nativeCodexSubagent, false);
  assert.deepEqual(await readdir(path.join(c.state, 'runs')), []);
});

test('per-call metadata takes precedence over server environment and preserves only allowlisted attribution', async t => {
  const c = await setup(t, { CODEX_THREAD_ID: 'server-chat' });
  const meta = { 'openai/threadId': 'actual-chat', arbitrarySecret: 'must-not-be-saved' };
  const start = await c.call('start_task', { workspace: c.workspace, title: '检查归属', instruction: 'HELLO' }, { meta });
  const done = await finished(c, start.runId);
  assert.equal(done.origin.threadId, 'actual-chat');
  assert.equal(done.origin.source, 'mcp-metadata');
  assert.equal(done.rootRunId, start.runId);
  assert.equal(done.title, '检查归属');
  const own = await c.call('list_tasks', {}, { meta });
  assert.equal(own.scope, 'current');
  assert.equal(own.tasks[0].belongsToCurrentChat, true);
  assert.equal(own.filters.callerThreadId, 'actual-chat');
  assert.equal((await c.call('list_tasks', own.filters)).tasks[0].runId, start.runId, 'UI refresh must retain the original scope if its request lacks host metadata');
  assert.equal((await c.call('list_tasks')).tasks.length, 0);
  assert.ok(!(await readFile(path.join(c.state, 'runs', start.runId + '.json'), 'utf8')).includes('must-not-be-saved'));
});

test('explicit attribution is a fallback; conflicting request metadata is rejected before starting', async t => {
  const c = await setup(t, { CODEX_THREAD_ID: 'server-chat' });
  assert.equal((await c.call('list_backends', { callerThreadId: 'explicit-chat' })).caller.source, 'explicit');
  const bad = await c.call('start_task', { workspace: c.workspace, instruction: 'HELLO', callerThreadId: 'wrong-chat' },
    { meta: { 'openai/threadId': 'actual-chat' }, allowError: true });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /conflicts/);
  const ambiguous = await c.call('list_backends', {}, { meta: { 'openai/threadId': 'one', 'codexThreadId': 'two' }, allowError: true });
  assert.equal(ambiguous.isError, true);
  assert.deepEqual(await readdir(path.join(c.state, 'runs')), []);
});

test('unknown and legacy runs are never claimed by a current chat', async t => {
  const c = await setup(t);
  const start = await c.call('start_task', { workspace: c.workspace, instruction: 'HELLO' });
  await finished(c, start.runId);
  const file = path.join(c.state, 'runs', start.runId + '.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  delete legacy.origin; delete legacy.submittedBy; delete legacy.rootRunId; delete legacy.title;
  await writeFile(file, JSON.stringify(legacy));
  const all = await c.call('list_tasks');
  assert.equal(all.scope, 'all');
  assert.match(all.ownershipWarning, /not necessarily/);
  assert.equal(all.tasks[0].origin.source, 'unknown');
  assert.equal(all.tasks[0].belongsToCurrentChat, null);
  assert.equal((await c.call('list_tasks', { scope: 'current' })).tasks.length, 0);
  assert.equal((await c.call('list_tasks', { callerThreadId: 'new-chat' })).tasks.length, 0);
  const follow = await c.call('reply_task', { runId: start.runId, instruction: 'FOLLOW_UP', callerThreadId: 'new-chat' });
  const done = await finished(c, follow.runId);
  assert.equal(done.origin.source, 'unknown');
  assert.equal(done.submittedBy.threadId, 'new-chat');
});

test('origin and follow-up submitter persist across MCP restart and changed calling chat', async t => {
  const c = await setup(t, { CODEX_THREAD_ID: 'original-chat' });
  const start = await c.call('start_task', { workspace: c.workspace, instruction: 'HELLO', title: '持续复核' });
  const first = await finished(c, start.runId); await c.close();
  const other = await connect(c.state, { extraEnv: { ...c.env, CODEX_THREAD_ID: 'supervisor-chat' } });
  try {
    const follow = await other.call('reply_task', { runId: start.runId, instruction: 'FOLLOW_UP' });
    const second = await finished(other, follow.runId);
    assert.equal(second.origin.threadId, 'original-chat');
    assert.equal(second.submittedBy.threadId, 'supervisor-chat');
    assert.equal(second.belongsToCurrentChat, false);
    assert.equal(second.submittedByCurrentChat, true);
    assert.equal(second.title, '持续复核');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.rootRunId, start.runId);
    const third = await other.call('reply_task', { runId: second.runId, instruction: 'FOLLOW_UP' });
    assert.equal((await finished(other, third.runId)).rootRunId, start.runId);
    assert.equal((await other.call('list_tasks')).tasks.length, 0);
    assert.equal((await other.call('list_tasks', { scope: 'all', rootRunId: start.runId })).tasks.length, 3);
  } finally { await other.close(); }
});

test('current-chat/backend/status filters are applied before the recent-run limit', async t => {
  const c = await setup(t, { CODEX_THREAD_ID: 'mine' });
  const start = await c.call('start_task', { workspace: c.workspace, instruction: 'HELLO' });
  await finished(c, start.runId);
  const sample = JSON.parse(await readFile(path.join(c.state, 'runs', start.runId + '.json'), 'utf8'));
  const expected = [];
  for(let i = 0; i < 20; i++) {
    const runId = 'sw-' + randomUUID();
    const own = i < 4;
    const backend = i % 2 ? 'grok' : 'deepseek';
    await writeFile(path.join(c.state, 'runs', runId + '.json'), JSON.stringify({ ...sample, runId, rootRunId: runId,
      backend, origin: { ...sample.origin, threadId: own ? 'mine' : 'other' }, createdAt: new Date(Date.UTC(2099, 0, 1, 0, i)).toISOString() }));
    if(own && backend === 'grok') expected.unshift(runId);
  }
  const listed = await c.call('list_tasks', { limit: 2, backend: 'grok', status: 'completed' });
  assert.deepEqual(listed.tasks.map(x => x.runId), expected);
  assert.equal((await c.call('list_tasks', { status: 'running' })).tasks.length, 0);
});

test('an idempotency collision in another chat cannot misattribute or duplicate an admitted run', async t => {
  const c = await setup(t);
  const input = { workspace: c.workspace, instruction: 'HELLO', idempotencyKey: 'same' };
  const first = await c.call('start_task', { ...input, callerThreadId: 'one' });
  await finished(c, first.runId);
  const collision = await c.call('start_task', { ...input, callerThreadId: 'two' }, { allowError: true });
  assert.equal(collision.isError, true);
  assert.match(collision.content[0].text, /different calling chat/);
  assert.equal((await c.call('list_tasks', { scope: 'all' })).tasks.length, 1);
  assert.equal((await c.call('start_task', { ...input, callerThreadId: 'one' })).runId, first.runId);
});

test('MCP task tools expose a self-contained read-only Apps resource with text fallback', async t => {
  const c = await setup(t);
  const tools = (await c.client.listTools()).tools;
  const resourceUri = tools.find(t => t.name === 'start_task')._meta.ui.resourceUri;
  assert.equal(resourceUri, 'ui://seekwing/tasks-v041.html');
  for(const name of ['list_tasks', 'get_task', 'wait_task', 'reply_task', 'cancel_task'])
    assert.equal(tools.find(t => t.name === name)._meta.ui.resourceUri, resourceUri);
  const resource = (await c.client.readResource({ uri: resourceUri })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
  assert.match(resource.text, /ui\/initialize/);
  assert.ok(!resource.text.includes('respond_to_permission'));
  const result = await c.client.callTool({ name: 'list_tasks', arguments: {} });
  assert.equal(result.content[0].type, 'text');
  assert.ok(Array.isArray(result.structuredContent.tasks));
});

test('live output tails follow new text after the first page while ordinary pagination stays compatible',async t=>{
  const c=await setup(t);
  const start=await c.call('start_task',{workspace:c.workspace,instruction:'LONG'});await finished(c,start.runId);
  const first=await c.call('get_task',{runId:start.runId,outputLimit:20});
  assert.equal(first.outputOffset,0);assert.equal(first.nextOutputOffset,20);
  const tail=await c.call('get_task',{runId:start.runId,outputTail:true,outputOffset:10,outputLimit:20});
  assert.equal(tail.outputOffset,tail.outputLength-20);assert.equal(tail.nextOutputOffset,null);assert.equal(tail.output.length,20);
  const file=path.join(c.state,'runs',start.runId+'.json');const saved=JSON.parse(await readFile(file,'utf8'));saved.output+='new tail';await writeFile(file,JSON.stringify(saved));
  const next=await c.call('get_task',{runId:start.runId,outputTail:true,outputLimit:20});
  assert.match(next.output,/new tail$/);assert.equal(next.outputOffset,next.outputLength-20);
});
