import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultStateDir, privateDir, VERSION, type PermissionMode } from './config.js';
import { bounded } from './worker.js';
import { DESKTOP_PROTOCOL_VERSION, DESKTOP_MAX_ACTIVE_RUNS, DESKTOP_MAX_REQUEST_BYTES } from './desktop-protocol.js';

/** Structural public Host interfaces keep the companion independent of bundled Cordis copies. */
type NativeContext = {
  connection: { createPeer(options: unknown): { dispose(): Promise<void> } };
  typertGateway: { invoke(request: unknown): Promise<any> };
  sessionController: { resolveAgent(id: string): Promise<any> };
  agents: { get(id: string): { status: string } | undefined };
  on(event: string, listener: (...args: any[]) => void, options: unknown): () => void;
  effect(effect: () => AsyncGenerator<() => unknown>): unknown;
};
type NativeEvent = { type: string; seq: number; data: any };
type Run = { runId: string; sessionId: string; workspace: string; permissionMode: PermissionMode; selection: any; ownerPid: number;
  submitted: boolean; nativeSubmitted: boolean; promptSeen: boolean; updates: { cursor: number; update: unknown }[]; count: number; textLength: number;
  pending: Set<string>; stopReason?: string; error?: string; foreign?: boolean; partial?: boolean; cancelRequested?: boolean;
  controls: Promise<void>; cancellation?: Promise<unknown>; release?: Promise<unknown> };

export const name = 'seekwing-desktop';
export const inject = ['connection', 'typertGateway', 'sessionController', 'workspaceController', 'agents'];

export class DesktopBridge {
  private peer;
  private runs = new Map<string, Run>();
  private locks = new Map<string, string>();
  private opening = new Map<string, { promise: Promise<unknown>; identity: string }>();
  private retired = new Map<string, number>();
  private disposeEvents;
  private disposeQuestions;
  constructor(private ctx: NativeContext, readonly stateDir: string) {
    this.peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    this.disposeEvents = ctx.on('session/event', (session: { id: string }, event: NativeEvent) => this.event(session.id, event), { global: true });
    this.disposeQuestions = ctx.on('user-questions/request', async (request: any, next: () => Promise<unknown>) => {
      const id = this.locks.get(request.agent?.session?.id);
      const run = id && this.runs.get(id);
      if (!run) return next();
      const pendingId = 'question-' + randomUUID();
      run.pending.add(pendingId);
      // Observe the native answerer; the user still answers in Harness.
      try { return await next(); } finally { run.pending.delete(pendingId); }
    }, { prepend: true });
  }
  private invoke(namespace: string, method: string, args: unknown = {}) {
    return this.ctx.typertGateway.invoke({ namespace, method, args, peer: this.peer });
  }
  private requireRun(id: unknown) {
    if (typeof id !== 'string' || !this.runs.has(id)) throw new Error('Unknown Desktop run. Admission may be uncertain after a Host restart; inspect the session before replying.');
    return this.runs.get(id)!;
  }
  private sessionFile(id: string) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid session ID.');
    return path.join(this.stateDir, 'sessions', id + '.json');
  }
  private retire(runId: string) {
    const now = Date.now();
    for (const [id, at] of this.retired) if (now - at > 3_600_000) this.retired.delete(id);
    this.retired.set(runId, now);
    // These fences outlive every bounded HTTP request without retaining unbounded history.
    if (this.retired.size > 4_096) this.retired.delete(this.retired.keys().next().value!);
  }
  private control<T>(run: Run, operation: () => Promise<T>): Promise<T> {
    const result = run.controls.then(operation);
    run.controls = result.then(() => {}, () => {});
    return result;
  }
  private pruneOrphans() {
    for (const [id, run] of this.runs) {
      let dead = false;
      try { process.kill(run.ownerPid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead || this.ctx.agents.get(run.sessionId)?.status === 'running') continue;
      if (this.locks.get(run.sessionId) === id) this.locks.delete(run.sessionId);
      this.runs.delete(id);
      this.opening.delete(id);
      this.retire(id);
    }
  }
  private async cancel(run: Run) {
    if (run.foreign) throw new Error('The conversation received a different prompt. Refusing to cancel another turn.');
    if (!run.cancellation) {
      const cancellation = this.control(run, async () => {
        if (run.foreign) throw new Error('Refusing to cancel a later manual user turn.');
        if (run.nativeSubmitted && !run.stopReason) await this.invoke('session', 'cancel', { request: { sessionId: run.sessionId } });
        return { requested: true };
      });
      run.cancellation = cancellation;
      void cancellation.catch(() => { if (run.cancellation === cancellation) run.cancellation = undefined; });
    }
    return bounded(run.cancellation, 8_000, 'Desktop cancellation is not yet confirmed. Inspect Harness before retrying; the session remains owned.');
  }
  private async release(run: Run) {
    if (!run.release) {
      const release = this.control(run, async () => {
        if (!run.foreign && run.nativeSubmitted && !run.stopReason) await this.invoke('session', 'cancel', { request: { sessionId: run.sessionId } });
        for (let i = 0; i < 20 && !run.foreign && this.ctx.agents.get(run.sessionId)?.status === 'running'; i++) await delay(250);
        if (!run.foreign && this.ctx.agents.get(run.sessionId)?.status === 'running') throw new Error('Desktop turn is still running. Harness remains open; inspect it before retrying.');
        if (this.locks.get(run.sessionId) === run.runId) this.locks.delete(run.sessionId);
        this.runs.delete(run.runId);
        this.opening.delete(run.runId);
        return { released: true, conversationPreserved: true };
      });
      run.release = release;
      void release.catch(() => { if (run.release === release) run.release = undefined; });
    }
    return bounded(run.release, 8_000, 'Desktop cleanup is not yet confirmed. Inspect Harness; no prompt was replayed.');
  }
  async dispatch(action: string, input: any): Promise<unknown> {
    if (action === 'hello') return { version: VERSION, protocolVersion: DESKTOP_PROTOCOL_VERSION, transport: 'desktop', visibleInDesktop: true, approvalSurface: 'DeepSeek Harness', maxActiveRuns: DESKTOP_MAX_ACTIVE_RUNS, pid: process.pid };
    if (action === 'catalog') return this.invoke('session', 'modelCatalog');
    if (typeof input?.runId !== 'string' || !/^sw-[0-9a-f-]{36}$/.test(input.runId)) throw new Error('Invalid run ID.');
    if (action === 'open') {
      this.pruneOrphans();
      if (this.retired.has(input.runId)) throw new Error('This Desktop run was cancelled or released. A late open cannot replay it.');
      const identity = JSON.stringify([input.workspace, input.permissionMode, input.sessionId, input.ownerPid]);
      const existing = this.opening.get(input.runId);
      if (existing && existing.identity !== identity) throw new Error('A Desktop run ID cannot be reused with different inputs.');
      if (!this.opening.has(input.runId)) {
        if (this.opening.size >= DESKTOP_MAX_ACTIVE_RUNS) throw new Error('Desktop concurrency limit reached. Wait for an owned turn to finish.');
        const operation = { promise: this.open(input), identity };
        this.opening.set(input.runId, operation);
        void operation.promise.catch(() => { if (this.opening.get(input.runId) === operation) this.opening.delete(input.runId); });
      }
      return this.opening.get(input.runId)!.promise;
    }
    if (action === 'cancel' || action === 'release') {
      // Fence late arrivals immediately, including an open whose response was lost.
      this.retire(input.runId);
      const opening = this.opening.get(input.runId);
      if (opening) await bounded(opening.promise.catch(() => {}), 8_000, 'Desktop session creation is still settling. Inspect Harness before retrying.');
      const run = this.runs.get(input.runId);
      if (!run) return action === 'cancel' ? { requested: true } : { released: true, conversationPreserved: true };
      if (!run.stopReason) run.cancelRequested = true;
      return action === 'cancel' ? this.cancel(run) : this.release(run);
    }
    const run = this.requireRun(input.runId);
    if (action === 'configure') {
      if (run.submitted || run.cancelRequested) throw new Error('Model selection is fixed after prompt admission or cancellation.');
      return this.control(run, async () => {
        if (run.cancelRequested || run.foreign) throw new Error('Desktop turn was cancelled or received a manual prompt before model configuration.');
        const selection = { ...run.selection };
        if (input.id === 'model') {
          const value: unknown = JSON.parse(input.value);
          if (!Array.isArray(value) || value.length !== 2 || !value.every(x => typeof x === 'string')) throw new Error('modelValue must be an exact value returned by inspect_models.');
          selection.provider = value[0]; selection.model = value[1];
        } else if (input.id === 'reasoning_effort' && typeof input.value === 'string') {
          if (input.value === 'provider-default') delete selection.reasoningEffort;
          else selection.reasoningEffort = input.value;
        } else throw new Error('Unsupported model configuration.');
        if (selection.provider !== run.selection.provider || selection.model !== run.selection.model || selection.reasoningEffort !== run.selection.reasoningEffort) {
          const result = await this.invoke('session', 'selectModel', { request: { sessionId: run.sessionId, ...selection } });
          run.selection = result.selected;
        }
        return { configOptions: configOptions(run.selection) };
      });
    }
    if (action === 'prompt') {
      if (run.submitted) throw new Error('This run already attempted prompt admission. Do not replay it.');
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 80_000) throw new Error('Invalid prompt.');
      run.submitted = true;
      return this.control(run, async () => {
        if (run.cancelRequested || this.retired.has(run.runId)) { run.stopReason = 'cancelled'; return { accepted: false, cancelled: true }; }
        if (run.foreign || this.ctx.agents.get(run.sessionId)?.status === 'running') {
          run.foreign = true;
          throw new Error('The Desktop session received another prompt or is already running.');
        }
        run.nativeSubmitted = true;
        return this.invoke('session', 'prompt', { request: { sessionId: run.sessionId, requestId: run.runId, mode: 'queue', content: [{ type: 'text', text: input.text }] } });
      });
    }
    if (action === 'poll') {
      if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > run.count) throw new Error('Invalid update cursor.');
      return { updates: run.updates.filter(x => x.cursor > input.cursor).slice(0, 100),
        ...(input.cursor + 100 >= run.count ? { stopReason: run.stopReason, error: run.error } : {}),
        attention: run.pending.size ? 'Answer the pending approval or question in DeepSeek Harness.' : undefined };
    }
    throw new Error('Unknown Desktop action.');
  }
  private async open(input: any) {
    if (!['read-only', 'workspace-write'].includes(input.permissionMode) || typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('Invalid workspace or permission mode.');
    const workspace = await realpath(input.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error('workspace must be a directory.');
    let sessionId: string = input.sessionId;
    try {
      if (sessionId) {
        const owned = JSON.parse(await readFile(this.sessionFile(sessionId), 'utf8'));
        if (owned.workspace !== workspace || owned.permissionMode !== input.permissionMode) throw new Error('Desktop continuation must preserve its workspace and permission mode.');
        const owner = this.locks.get(sessionId);
        if (owner) {
          const previous = this.runs.get(owner);
          let alive = true;
          if (previous) try { process.kill(previous.ownerPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
          if (alive || this.ctx.agents.get(sessionId)?.status === 'running') throw new Error('Desktop session is already owned by an active SeekWing task.');
          this.runs.delete(owner);
          this.opening.delete(owner);
          this.locks.delete(sessionId);
        }
        this.locks.set(sessionId, input.runId);
      } else {
        const created = await this.invoke('workspace', 'create', { request: { path: workspace } });
        ({ sessionId } = await this.invoke('session', 'create', { request: { workspaceId: created.workspace.workspaceId } }));
        this.locks.set(sessionId, input.runId);
        await privateDir(path.join(this.stateDir, 'sessions'));
        await writeFile(this.sessionFile(sessionId), JSON.stringify({ workspace, permissionMode: input.permissionMode }), { mode: 0o600, flag: 'wx' });
      }
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) throw new Error(resolved.error.message);
      const agent = resolved.agent;
      if (agent.status === 'running' || agent.session.header.cwd !== workspace) throw new Error('Desktop session is busy or its workspace does not match.');
      // These are the documented, durable Session override events. No product rows or defaults are replaced.
      agent.session.append('sandbox/mode', { mode: input.permissionMode });
      agent.session.append('approval/policy', { policy: input.permissionMode === 'read-only' ? 'never' : 'ask' });
      const catalog = await this.invoke('session', 'modelCatalog');
      const projections = await this.invoke('session', 'projections', { request: { sessionId } });
      const projected = projections.values?.modelSelection;
      const selection = projected?.next ?? projected?.lastUsed ?? catalog.default;
      const run: Run = { runId: input.runId, sessionId, workspace, permissionMode: input.permissionMode, selection,
        ownerPid: Number.isSafeInteger(input.ownerPid) && input.ownerPid > 0 ? input.ownerPid : process.pid,
        submitted: false, nativeSubmitted: false, promptSeen: false, updates: [], count: 0, textLength: 0, pending: new Set(), controls: Promise.resolve() };
      this.runs.set(input.runId, run);
      await this.invoke('session', 'rename', { request: { sessionId, title: `SeekWing · ${path.basename(workspace)}` } }).catch(() => {});
      if (this.retired.has(run.runId)) { run.cancelRequested = true; await this.release(run); }
      return { sessionId, configOptions: configOptions(selection), visibleInDesktop: true };
    } catch (error) {
      if (this.locks.get(sessionId) === input.runId) this.locks.delete(sessionId);
      this.runs.delete(input.runId);
      throw error;
    }
  }
  private event(sessionId: string, event: NativeEvent) {
    const runId = this.locks.get(sessionId);
    const run = runId && this.runs.get(runId);
    if (!run) return;
    const data = event.data;
    if (event.type === 'user/message') {
      if (data.source?.rpcId === run.runId) run.promptSeen = true;
      else if (data.source?.kind === 'user' || typeof data.source?.rpcId === 'string') {
        run.foreign = true;
        if (!run.stopReason) run.error = 'Another prompt entered the Desktop conversation. Inspect Harness; result ownership is uncertain.';
      }
      return;
    }
    if (!run.submitted || !run.promptSeen || run.stopReason || run.error) return;
    const push = (update: unknown) => { if (run.updates.length < 2_000) run.updates.push({ cursor: ++run.count, update }); else run.error = 'Desktop evidence limit exceeded; inspect Harness before continuing.'; };
    if (event.type === 'assistant/message') {
      if (data.interrupted === true || data.message?.interrupted === true) run.partial = true;
      const content = data.message?.content ?? data.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : '';
      if (text) {
        const retained = text.slice(0, Math.max(0, 100_001 - run.textLength));
        run.textLength += retained.length;
        push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: retained + '\n\n' } });
      }
    } else if (event.type === 'tool/call') {
      push({ sessionUpdate: 'tool_call', toolCallId: data.callId, title: data.tool ?? data.name ?? 'Harness tool', status: 'in_progress', rawInput: boundedValue(data.arguments ?? data.args ?? data.input) });
    } else if (event.type === 'tool/result') {
      const toolCallId = data.callId ?? data.message?.toolCallId ?? data.message?.source?.callId;
      if (typeof toolCallId !== 'string') { run.error = 'Harness tool result has no call identity; inspect native evidence.'; return; }
      push({ sessionUpdate: 'tool_call_update', toolCallId, status: data.error || data.isError || data.result?.isError || data.message?.isError ? 'failed' : 'completed', rawOutput: boundedValue(data.result ?? data.message ?? data) });
    } else if (event.type === 'approval/asked' || event.type === 'user-questions/asked') run.pending.add(data.id ?? data.requestId ?? event.type);
    else if (event.type === 'approval/decided' || event.type === 'user-questions/answered') run.pending.delete(data.id ?? data.requestId ?? event.type.replace('decided', 'asked').replace('answered', 'asked'));
    else if (event.type === 'turn/end') {
      const kind = data.reason?.kind;
      run.stopReason = kind === 'completed' ? run.partial ? 'interrupted' : 'end_turn' : kind === 'aborted' ? 'cancelled' : kind === 'max-tokens' ? 'max_tokens' : 'error';
      if (kind === 'error') run.error = `Harness turn failed: ${String(data.reason?.error?.message ?? 'unknown error')}`;
      if (kind === 'aborted' && !run.cancelRequested && data.reason?.reason?.kind !== 'user') run.error = `Harness turn aborted: ${String(data.reason?.reason?.kind ?? 'unknown reason')}`;
      if (!['completed', 'aborted', 'max-tokens', 'error'].includes(kind)) run.error = `Unsupported Harness turn end: ${String(kind)}`;
      run.pending.clear();
    }
  }
  async dispose() { this.disposeEvents(); this.disposeQuestions(); await this.peer.dispose(); }
}
function boundedValue(value: unknown) { return JSON.stringify(value)?.slice(0, 8_000); }
export function configOptions(selection: any) {
  return [{ id: 'model', name: 'Model', type: 'select', currentValue: JSON.stringify([selection.provider, selection.model]), options: [] },
    { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: selection.reasoningEffort ?? 'provider-default', options: [] }];
}

export async function startDesktopServer(ctx: NativeContext, stateDir: string) {
  await privateDir(stateDir);
  await chmod(stateDir, 0o700);
  const bridge = new DesktopBridge(ctx, stateDir);
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  let expectedHost = '';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.headers.authorization || '');
    if (req.method !== 'POST' || req.url !== '/seekwing' || req.headers.host !== expectedHost || req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(403, { error: 'Forbidden' }); return; }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > DESKTOP_MAX_REQUEST_BYTES) { send(413, { error: 'Request too large' }); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (input.instanceId !== instanceId) throw new Error('Stale Desktop instance. Inspect the existing run before resubmitting.');
      send(200, { result: await bridge.dispatch(input.action, input) });
    } catch (error) { send(400, { error: String(error) }); }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port.');
  expectedHost = `127.0.0.1:${address.port}`;
  const endpointFile = path.join(stateDir, 'endpoint.json');
  const temporary = endpointFile + '.' + instanceId;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, version: VERSION, url: `http://${expectedHost}/seekwing`, token, instanceId, pid: process.pid }), { mode: 0o600 });
  await rename(temporary, endpointFile);
  return async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await bridge.dispose();
    const current = JSON.parse(await readFile(endpointFile, 'utf8').catch(() => '{}'));
    if (current.instanceId === instanceId) await unlink(endpointFile).catch(() => {});
  };
}
export function apply(ctx: NativeContext, config: { stateDir?: string } = {}) {
  ctx.effect(async function* () {
    const dispose = await startDesktopServer(ctx, path.resolve(config.stateDir ?? path.join(defaultStateDir(), 'desktop')));
    yield dispose;
  });
}
