import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopBridge, startDesktopServer } from '../desktop/index.mjs';
import { connect, finished } from './helpers.mjs';

function nativeHost() {
  const events = new EventEmitter();
  const sessions = new Map();
  const calls = [];
  const emit = (id, type, data) => events.emit('session/event', { id }, { type, data, seq: 0 });
  const ctx = {
    connection: { createPeer: () => ({ dispose: async () => {} }) },
    on: (event, listener) => { events.on(event, listener); return () => events.off(event, listener); },
    agents: { get: id => sessions.get(id) },
    sessionController: { resolveAgent: async id => ({ agent: sessions.get(id) }) },
    typertGateway: { invoke: async ({ namespace, method, args }) => {
      calls.push({ namespace, method, args });
      const req = args.request;
      if (namespace === 'workspace' && method === 'create') return { workspace: { workspaceId: req.path } };
      if (method === 'create') {
        const sessionId = 'session-' + randomUUID();
        const overrides = [];
        sessions.set(sessionId, { status: 'idle', overrides,
          session: { header: { cwd: req.workspaceId }, append: (type, data) => overrides.push({ type, data }) } });
        return { sessionId };
      }
      if (method === 'modelCatalog') return { default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
        groups: [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'high' }] } }] }], failures: [] };
      if (method === 'projections') return { values: {} };
      if (method === 'selectModel') return { selected: { provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort } };
      if (method === 'rename') return {};
      if (method === 'prompt') {
        sessions.get(req.sessionId).status = 'running';
        emit(req.sessionId, 'user/message', { source: { rpcId: req.requestId } });
        emit(req.sessionId, 'user/message', { source: { kind: 'runtime-context' }, content: 'private runtime context' });
        emit(req.sessionId, 'user/message', { source: { kind: 'skill-catalog' } });
        if (req.content[0].text.includes('WAIT_FOREVER')) return { accepted: true };
        setTimeout(() => {
          emit(req.sessionId, 'tool/call', { callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' });
          emit(req.sessionId, 'tool/result', { message: { toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'fixture' }], isError: true }, error: { code: 'FIXTURE_DENIED' } });
          emit(req.sessionId, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'PRIVATE_THOUGHT' }, { type: 'text', text: 'DESKTOP_FIXTURE_OK' }] } });
          emit(req.sessionId, 'turn/end', { reason: { kind: 'completed' } });
          sessions.get(req.sessionId).status = 'idle';
        }, 30);
        return { accepted: true };
      }
      if (method === 'cancel') { emit(req.sessionId, 'turn/end', { reason: { kind: 'aborted' } }); sessions.get(req.sessionId).status = 'idle'; return {}; }
      throw new Error(`Unimplemented fixture ${namespace}.${method}`);
    } },
  };
  return { ctx, sessions, calls, emit };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seekwing-desktop-'));
  await mkdir(path.join(root, 'workspace'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace: path.join(root, 'workspace'), ...nativeHost() };
}
const id = () => 'sw-' + randomUUID();
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('Desktop MCP lifecycle uses native workspace/session, preserves mode on reply and keeps conversation', async t => {
  const f = await fixture(t);
  const dispose = await startDesktopServer(f.ctx, path.join(f.root, 'desktop'));
  t.after(dispose);
  const conn = await connect(f.root, { extraEnv: { SEEKWING_DESKTOP_ENDPOINT: path.join(f.root, 'desktop/endpoint.json') } });
  t.after(conn.close);
  const doctor = await conn.call('doctor', { sessionMode: 'desktop' });
  assert.equal(doctor.visibleInDesktop, true);
  assert.ok(!JSON.stringify(doctor).includes('token'));
  const models = await conn.call('inspect_models', { workspace: f.workspace, sessionMode: 'desktop' });
  assert.equal(models.configOptions[0].options[0].options[0].value, '["deepseek-account","deepseek-flash"]');
  const run = await conn.call('start_task', { workspace: f.workspace, instruction: 'small fixture', sessionMode: 'desktop', modelValue: '["deepseek-account","deepseek-flash"]', reasoningEffort: 'high', idempotencyKey: 'desktop-first' });
  const result = await finished(conn, run.runId);
  assert.equal(result.status, 'completed');
  assert.match(result.output, /DESKTOP_FIXTURE_OK/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_THOUGHT'));
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.toolCalls[0].status, 'failed');
  assert.match(result.toolCalls[0].rawInput, /README.md/);
  assert.deepEqual(f.sessions.get(result.sessionId).overrides.slice(-2), [{ type: 'sandbox/mode', data: { mode: 'read-only' } }, { type: 'approval/policy', data: { policy: 'never' } }]);
  const reply = await conn.call('reply_task', { runId: run.runId, instruction: 'follow up' });
  const done = await finished(conn, reply.runId);
  assert.equal(done.sessionId, result.sessionId);
  assert.equal(done.sessionMode, 'desktop');
  assert.equal(f.sessions.size, 1);
  assert.equal((await conn.call('list_tasks')).tasks[0].sessionMode, 'desktop');
});

test('Desktop cancellation stops the owned turn and leaves the native session alive', async t => {
  const f = await fixture(t);
  const dispose = await startDesktopServer(f.ctx, path.join(f.root, 'desktop'));
  t.after(dispose);
  const conn = await connect(f.root, { extraEnv: { SEEKWING_DESKTOP_ENDPOINT: path.join(f.root, 'desktop/endpoint.json') } });
  t.after(conn.close);
  const run = await conn.call('start_task', { workspace: f.workspace, instruction: 'WAIT_FOREVER', sessionMode: 'desktop', permissionMode: 'workspace-write' });
  for (let n = 0; n < 30 && !f.calls.some(c => c.method === 'prompt'); n++) await delay(20);
  const result = await conn.call('cancel_task', { runId: run.runId });
  assert.equal(result.status, 'cancelled');
  assert.equal(f.sessions.get(result.sessionId).status, 'idle');
  assert.deepEqual(f.sessions.get(result.sessionId).overrides.slice(-2), [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }, { type: 'approval/policy', data: { policy: 'ask' } }]);
});

test('Desktop drains an already-completed result when cancellation races with the next poll', async t => {
  const f = await fixture(t);
  const dispose = await startDesktopServer(f.ctx, path.join(f.root, 'desktop'));
  t.after(dispose);
  const c = await connect(f.root, { extraEnv: { SEEKWING_DESKTOP_ENDPOINT: path.join(f.root, 'desktop/endpoint.json') } });
  t.after(c.close);
  const task = await c.call('start_task', { workspace: f.workspace, instruction: 'finish just before next poll', sessionMode: 'desktop' });
  for (let n = 0; n < 30 && !f.calls.some(x => x.method === 'prompt'); n++) await delay(10);
  await delay(70);
  const result = await c.call('cancel_task', { runId: task.runId });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.status, 'completed');
  assert.match(result.output, /DESKTOP_FIXTURE_OK/);
  assert.equal(f.calls.filter(x => x.method === 'cancel').length, 0);
});

test('Desktop bridge rejects foreign sessions, conflicting modes, active sessions and prompt replay', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const runId = id();
  const created = await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'read-only' });
  await assert.rejects(bridge.dispatch('open', { runId: id(), sessionId: created.sessionId, workspace: f.workspace, permissionMode: 'read-only' }), /already owned/);
  await bridge.dispatch('prompt', { runId, text: 'WAIT_FOREVER' });
  await assert.rejects(bridge.dispatch('prompt', { runId, text: 'again' }), /already attempted/);
  f.emit(created.sessionId, 'user/message', { source: { rpcId: 'someone-else' } });
  const polled = await bridge.dispatch('poll', { runId, cursor: 0 });
  assert.match(polled.error, /Another prompt/);
  await assert.rejects(bridge.dispatch('cancel', { runId }), /another turn/);
  await bridge.dispatch('release', { runId });
  await assert.rejects(bridge.dispatch('open', { runId: id(), sessionId: created.sessionId, workspace: f.workspace, permissionMode: 'workspace-write' }), /preserve/);
  await assert.rejects(bridge.dispatch('open', { runId: id(), sessionId: 'unowned', workspace: f.workspace, permissionMode: 'read-only' }), /ENOENT/);
});

test('Desktop endpoint enforces loopback host, bearer, origin, epoch and private permissions', async t => {
  const f = await fixture(t);
  const endpointDir = path.join(f.root, 'desktop');
  const dispose = await startDesktopServer(f.ctx, endpointDir);
  t.after(dispose);
  const ep = JSON.parse(await readFile(path.join(endpointDir, 'endpoint.json'), 'utf8'));
  assert.equal((await stat(path.join(endpointDir, 'endpoint.json'))).mode & 0o077, 0);
  const post = headers => fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'hello', instanceId: ep.instanceId }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await post({ authorization: 'Bearer ' + ep.token, origin: 'https://example.com' })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = request(ep.url, { method: 'POST', headers: { authorization: 'Bearer ' + ep.token, host: 'other.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end('{}');
  });
  assert.equal(hostileHost, 403);
  assert.equal((await post({ authorization: 'Bearer ' + ep.token })).status, 200);
  const stale = await fetch(ep.url, { method: 'POST', headers: { authorization: 'Bearer ' + ep.token }, body: JSON.stringify({ action: 'hello', instanceId: 'stale' }) });
  assert.equal(stale.status, 400);
  assert.ok(!(await stale.text()).includes(ep.token));
});

test('Desktop absence fails explicitly without silently launching background generation', async t => {
  const f = await fixture(t);
  const conn = await connect(f.root, { extraEnv: { SEEKWING_DESKTOP_ENDPOINT: path.join(f.root, 'absent.json') } });
  t.after(conn.close);
  const run = await conn.call('start_task', { workspace: f.workspace, instruction: 'must not fall back', sessionMode: 'desktop' });
  const result = await finished(conn, run.runId);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Desktop companion unavailable/);
  assert.equal(result.sessionId, undefined);
});

test('Desktop approval and question attention stays native and clears after the native answerer', async t => {
  const f = await fixture(t);
  let nativeQuestion;
  const originalOn = f.ctx.on;
  f.ctx.on = (event, listener, options) => {
    if (event === 'user-questions/request') { nativeQuestion = listener; return () => {}; }
    return originalOn(event, listener, options);
  };
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const runId = id();
  const { sessionId } = await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'workspace-write' });
  await bridge.dispatch('prompt', { runId, text: 'WAIT_FOREVER' });
  f.emit(sessionId, 'approval/asked', { id: 'native-approval-1' });
  assert.match((await bridge.dispatch('poll', { runId, cursor: 0 })).attention, /DeepSeek Harness/);
  f.emit(sessionId, 'approval/decided', { id: 'native-approval-1', outcome: 'rejected' });
  assert.equal((await bridge.dispatch('poll', { runId, cursor: 0 })).attention, undefined);
  let answer;
  const pending = nativeQuestion({ agent: { session: { id: sessionId } } }, () => new Promise(resolve => { answer = resolve; }));
  assert.match((await bridge.dispatch('poll', { runId, cursor: 0 })).attention, /DeepSeek Harness/);
  answer({ kind: 'native-answer' });
  assert.deepEqual(await pending, { kind: 'native-answer' });
  assert.equal((await bridge.dispatch('poll', { runId, cursor: 0 })).attention, undefined);
  await bridge.dispatch('cancel', { runId });
  await bridge.dispatch('release', { runId });
});

test('Desktop interrupted assistant output is incomplete, and a dead client cannot leave an idle session locked', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const runId = id();
  const { sessionId } = await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'read-only', ownerPid: 2147483647 });
  await bridge.dispatch('prompt', { runId, text: 'WAIT_FOREVER' });
  f.emit(sessionId, 'assistant/message', { interrupted: true, message: { content: [{ type: 'text', text: 'partial answer' }] } });
  f.emit(sessionId, 'turn/end', { reason: { kind: 'completed' } });
  f.sessions.get(sessionId).status = 'idle';
  assert.equal((await bridge.dispatch('poll', { runId, cursor: 0 })).stopReason, 'interrupted');
  const continued = await bridge.dispatch('open', { runId: id(), workspace: f.workspace, sessionId, permissionMode: 'read-only' });
  assert.equal(continued.sessionId, sessionId);
});

test('Desktop cancellation waits for a pending native prompt admission', async t => {
  const f = await fixture(t);
  const admission = deferred();
  const started = deferred();
  const invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = async request => {
    if (request.method === 'prompt') { started.resolve(); await admission.promise; }
    return invoke(request);
  };
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  const runId = id();
  const { sessionId } = await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'workspace-write' });
  const submitted = bridge.dispatch('prompt', { runId, text: 'WAIT_FOREVER' });
  await started.promise;
  const cancelled = bridge.dispatch('cancel', { runId });
  t.after(async () => { admission.resolve(); await Promise.allSettled([submitted, cancelled]); await bridge.dispose(); });
  await delay(30);
  assert.equal(f.calls.filter(x => x.method === 'cancel').length, 0, 'A cancel sent before admission can miss the actual turn.');
  admission.resolve();
  await Promise.all([submitted, cancelled]);
  await bridge.dispatch('release', { runId });
  assert.equal(f.sessions.get(sessionId).status, 'idle');
  assert.equal(f.calls.filter(x => x.method === 'cancel').length, 1);
});

test('Desktop cleans up an opened session when its HTTP response is lost', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  let openedSession;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const input = JSON.parse(body);
      const result = await bridge.dispatch(input.action, input);
      if (input.action === 'open') { openedSession = result.sessionId; res.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await bridge.dispose(); });
  const endpointFile = path.join(f.root, 'endpoint.json');
  await writeFile(endpointFile, JSON.stringify({ schemaVersion: 1, url: `http://127.0.0.1:${server.address().port}/seekwing`, token: 'a'.repeat(64), instanceId: randomUUID() }), { mode: 0o600 });
  const c = await connect(f.root, { extraEnv: { SEEKWING_DESKTOP_ENDPOINT: endpointFile } });
  t.after(c.close);
  const task = await c.call('start_task', { workspace: f.workspace, instruction: 'must not run', sessionMode: 'desktop' });
  const result = await finished(c, task.runId);
  assert.equal(result.status, 'failed');
  assert.ok(openedSession);
  assert.equal(f.calls.filter(x => x.method === 'prompt').length, 0);
  const resumed = await bridge.dispatch('open', { runId: id(), workspace: f.workspace, permissionMode: 'read-only', sessionId: openedSession });
  assert.equal(resumed.sessionId, openedSession, 'A lost open response must not strand the session lock.');
});

test('Desktop releases a finished turn while preserving a later manual user turn', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const runId = id();
  const { sessionId } = await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'workspace-write' });
  await bridge.dispatch('prompt', { runId, text: 'small task' });
  await delay(60);
  f.emit(sessionId, 'user/message', { source: { kind: 'user', rpcId: 'manual-followup' } });
  f.sessions.get(sessionId).status = 'running';
  assert.equal((await bridge.dispatch('poll', { runId, cursor: 0 })).stopReason, 'end_turn');
  await bridge.dispatch('release', { runId });
  assert.equal(f.sessions.get(sessionId).status, 'running');
  assert.equal(f.calls.filter(x => x.method === 'cancel').length, 0);
});

test('Desktop HTTP preserves split UTF-8 and long Chinese instructions with a bounded body', async t => {
  const f = await fixture(t);
  const observed = [];
  const invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = async req => {
    if (req.method === 'prompt') observed.push(req.args.request.content[0].text);
    return invoke(req);
  };
  const endpointDir = path.join(f.root, 'desktop');
  const dispose = await startDesktopServer(f.ctx, endpointDir);
  t.after(dispose);
  const ep = JSON.parse(await readFile(path.join(endpointDir, 'endpoint.json'), 'utf8'));
  const send = async (input, splitAt) => {
    const body = Buffer.from(JSON.stringify({ ...input, instanceId: ep.instanceId }));
    return new Promise((resolve, reject) => {
      const req = request(ep.url, { method: 'POST', headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' } }, res => {
        let result = ''; res.on('data', chunk => { result += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(result) }));
      });
      req.once('error', reject);
      if (splitAt) { req.write(body.subarray(0, splitAt(body))); setTimeout(() => req.end(body.subarray(splitAt(body))), 15); }
      else req.end(body);
    });
  };
  for (const text of ['WAIT_FOREVER 你好，保持原文', 'WAIT_FOREVER ' + '海'.repeat(40_000)]) {
    const runId = id();
    assert.equal((await send({ action: 'open', runId, workspace: f.workspace, permissionMode: 'read-only' })).status, 200);
    const response = await send({ action: 'prompt', runId, text }, body => body.indexOf(Buffer.from(text.includes('你好') ? '你' : '海')) + 1);
    assert.equal(response.status, 200);
    assert.equal(observed.at(-1), text);
    await send({ action: 'cancel', runId });
    await send({ action: 'release', runId });
  }
  assert.equal((await send({ action: 'hello', padding: 'a'.repeat(512 * 1024) })).status, 413);
});

test('Desktop serializes model controls so a late result cannot overwrite a newer selection', async t => {
  const f = await fixture(t);
  const started = deferred();
  const selectionGate = deferred();
  const invoke = f.ctx.typertGateway.invoke;
  let selections = 0;
  f.ctx.typertGateway.invoke = async req => {
    if (req.method === 'selectModel' && ++selections === 1) { started.resolve(); await selectionGate.promise; }
    return invoke(req);
  };
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  const runId = id();
  await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'read-only' });
  const first = bridge.dispatch('configure', { runId, id: 'model', value: '["deepseek-account","deepseek-v4-pro"]' });
  await started.promise;
  const second = bridge.dispatch('configure', { runId, id: 'reasoning_effort', value: 'low' });
  t.after(async () => { selectionGate.resolve(); await Promise.allSettled([first, second]); await bridge.dispose(); });
  await delay(25);
  assert.equal(selections, 1);
  selectionGate.resolve();
  await first;
  const result = await second;
  assert.equal(result.configOptions[0].currentValue, '["deepseek-account","deepseek-v4-pro"]');
  assert.equal(result.configOptions[1].currentValue, 'low');
  await bridge.dispatch('configure', { runId, id: 'reasoning_effort', value: 'low' });
  assert.equal(selections, 2, 'An unchanged model must not rewrite the Desktop default.');
});

test('Desktop retries failed empty-session setup and enforces Host-wide active capacity', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const missing = path.join(f.root, 'missing');
  const retryId = id();
  await assert.rejects(bridge.dispatch('open', { runId: retryId, workspace: missing, permissionMode: 'read-only' }), /ENOENT/);
  await mkdir(missing);
  await bridge.dispatch('open', { runId: retryId, workspace: missing, permissionMode: 'read-only' });
  await bridge.dispatch('release', { runId: retryId });
  const runIds = Array.from({ length: 8 }, id);
  await Promise.all(runIds.map(runId => bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'read-only' })));
  const overflow = id();
  const before = f.sessions.size;
  await assert.rejects(bridge.dispatch('open', { runId: overflow, workspace: f.workspace, permissionMode: 'read-only' }), /concurrency limit/);
  assert.equal(f.sessions.size, before, 'A refused task must not create another native session.');
  await bridge.dispatch('release', { runId: runIds[0] });
  await bridge.dispatch('open', { runId: overflow, workspace: f.workspace, permissionMode: 'read-only' });
});

test('Desktop cancellation and cleanup fence late open and prompt requests', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const late = id();
  await bridge.dispatch('release', { runId: late });
  await assert.rejects(bridge.dispatch('open', { runId: late, workspace: f.workspace, permissionMode: 'read-only' }), /late open/);
  const runId = id();
  await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'read-only' });
  await bridge.dispatch('cancel', { runId });
  assert.equal((await bridge.dispatch('prompt', { runId, text: 'must never be admitted' })).cancelled, true);
  assert.equal(f.calls.filter(x => x.method === 'prompt').length, 0);
  await bridge.dispatch('release', { runId });
  assert.equal((await bridge.dispatch('release', { runId })).released, true);
});

test('Desktop cleanup never cancels a manual prompt that arrived before delegated admission', async t => {
  const f = await fixture(t);
  const bridge = new DesktopBridge(f.ctx, path.join(f.root, 'desktop'));
  t.after(() => bridge.dispose());
  const runId = id();
  const { sessionId } = await bridge.dispatch('open', { runId, workspace: f.workspace, permissionMode: 'workspace-write' });
  f.emit(sessionId, 'user/message', { source: { kind: 'user', rpcId: 'manual-before-admission' } });
  f.sessions.get(sessionId).status = 'running';
  await assert.rejects(bridge.dispatch('prompt', { runId, text: 'must not run' }), /another prompt|already running/);
  await bridge.dispatch('release', { runId });
  assert.equal(f.sessions.get(sessionId).status, 'running');
  assert.equal(f.calls.filter(x => x.method === 'cancel' || x.method === 'prompt').length, 0);
});

test('Desktop refuses an incompatible companion before session creation', async t => {
  const f = await fixture(t);
  const actions = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    actions.push(JSON.parse(text).action);
    res.end(JSON.stringify({ result: { transport: 'desktop', protocolVersion: 999 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpointFile = path.join(f.root, 'endpoint.json');
  await writeFile(endpointFile, JSON.stringify({ schemaVersion: 1, url: `http://127.0.0.1:${server.address().port}/seekwing`, token: 'a'.repeat(64), instanceId: randomUUID() }), { mode: 0o600 });
  const c = await connect(f.root, { extraEnv: { SEEKWING_DESKTOP_ENDPOINT: endpointFile } });
  t.after(c.close);
  const task = await c.call('start_task', { workspace: f.workspace, instruction: 'must not run', sessionMode: 'desktop' });
  const result = await finished(c, task.runId);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Incompatible Desktop companion protocol/);
  assert.deepEqual(actions, ['hello']);
});
