import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
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
