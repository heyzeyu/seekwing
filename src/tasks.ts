import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { createWorker, sessionLockKey } from './backends.js';
import type { Worker } from './worker.js';
import { sessionModeFor, workspacePath, type Config } from './config.js';
import { Store } from './store.js';
import { unknownOrigin } from './origin.js';
import { terminal, type Task, type TaskInput, type TaskOrigin } from './types.js';

interface Job {
  task: Task;
  admitted: boolean;
  worker?: Worker;
  done: Promise<void>;
  writes: Promise<void>;
  permissions: Map<string, (response: RequestPermissionResponse) => void>;
  forceTimer?: NodeJS.Timeout;
}

export class TaskManager {
  readonly store: Store;
  private jobs = new Map<string, Job>();
  private unpersisted = new Map<string, Task>();
  private storageFailure?: string;
  private closed = false;
  constructor(readonly config: Config) { this.store = new Store(config); }
  async init(): Promise<void> { await this.store.init(); }

  private save(job: Job): Promise<void> {
    if (!job.admitted) return job.writes;
    // A single failed write must not poison every later attempt to record cleanup.
    job.writes = job.writes.catch(() => {}).then(() => this.store.save(job.task));
    void job.writes.catch((error) => {
      if (job.task.persistenceError) return;
      job.task.persistenceError = this.config.redact(String(error));
      this.storageFailure ??= job.task.persistenceError;
      job.task.error = 'Task evidence could not be persisted. Inspect the execution result and workspace before continuing.';
      if (!terminal(job.task.status)) void this.cancelJob(job, 'persistence').catch(() => {});
    });
    return job.writes;
  }

  private async saveFinal(job: Job): Promise<void> {
    try { await this.save(job); }
    catch {
      if (job.task.status !== 'interrupted') job.task.status = 'failed';
      // One bounded retry records transient failures. Persistent loss remains visible in this process.
      try { await this.save(job); }
      catch {
        this.storageFailure = job.task.persistenceError;
        this.unpersisted.set(job.task.runId, this.snapshot(job.task));
      }
    }
    if (!this.unpersisted.size && ![...this.jobs.values()].some(other => other !== job && other.task.persistenceError)) this.storageFailure = undefined;
  }

  async start(input: TaskInput, parent?: Task, caller: TaskOrigin = unknownOrigin()): Promise<Task> {
    if (this.closed) throw new Error('SeekWing is shutting down.');
    const workspace = await workspacePath(this.config, input.workspace);
    if (!input.instruction.trim()) throw new Error('instruction must not be empty.');
    const backend = input.backend ?? this.config.backend;
    const sessionMode = sessionModeFor(this.config, backend, input.sessionMode);
    const runId = 'sw-' + randomUUID();
    const now = new Date().toISOString();
    const task: Task = {
      schemaVersion: 1, runId, parentRunId: parent?.runId, ownerPid: process.pid, sessionId: parent?.sessionId,
      title: input.title ?? parent?.title ?? `${backend === 'grok' ? 'Grok' : 'DeepSeek'} task`,
      rootRunId: parent?.rootRunId ?? parent?.runId ?? runId,
      origin: parent ? parent.origin ?? unknownOrigin() : caller, submittedBy: caller,
      backend, sessionMode,
      workspace, permissionMode: input.permissionMode, configuredDefaultRoute: backend === 'grok'
        ? { provider: 'grok-cli', model: this.config.grokModel ?? 'native-default' }
        : { provider: this.config.provider, model: this.config.model },
      modelValue: input.modelValue ?? (backend === 'grok' ? this.config.grokModel : undefined), reasoningEffort: input.reasoningEffort,
      status: 'starting', createdAt: now, updatedAt: now, instruction: input.instruction, acceptance: input.acceptance,
      timeoutSeconds: input.timeoutSeconds, output: '', outputTruncated: false, toolCalls: {},
      pendingPermissions: [], permissionDecisions: [], reviewRequired: true,
    };
    const { idempotencyKey: _, backend: __, ...identity } = input;
    // Keep the legacy DeepSeek fingerprint byte-for-byte; Grok always adds its discriminator.
    const submission = { ...identity, sessionMode: task.sessionMode, workspace, parentRunId: parent?.runId, ...(backend === 'grok' ? { backend } : {}) };
    if (input.idempotencyKey) {
      const existing = await this.store.findKey(input.idempotencyKey, submission);
      if (existing) return this.idempotentResult(existing, caller);
    }
    if (this.closed) throw new Error('SeekWing is shutting down.');
    if (this.storageFailure) throw new Error('SeekWing task storage is unavailable. Restore storage and restart this MCP before starting another task. ' + this.storageFailure);
    // Reserve capacity before any asynchronous persistence so concurrent MCP calls cannot oversubscribe.
    if (this.jobs.size >= this.config.maxConcurrent) throw new Error('SeekWing concurrency limit reached. Wait for an active task to finish.');
    const job: Job = { task, admitted: !input.idempotencyKey, done: Promise.resolve(), writes: Promise.resolve(), permissions: new Map() };
    this.jobs.set(runId, job);
    let release: (() => Promise<void>) | undefined;
    try {
      if (input.idempotencyKey) {
        const claimed = await this.store.claimKey(input.idempotencyKey, submission, runId);
        if (claimed !== runId) {
          this.jobs.delete(runId);
          // This caller did not admit a task. Keep lookup rejection outside the creator's failure handler.
          return this.idempotentResult(claimed, caller);
        }
        job.admitted = true;
      }
      if (parent?.sessionId) release = await this.store.lockSession(sessionLockKey(backend, parent.sessionId), runId);
      await this.save(job);
      job.done = this.execute(job, release).catch((error) => {
        // Only disk/cleanup failures should reach here; keep stdout protocol-clean.
        process.stderr.write(this.config.redact(`SeekWing task ${runId}: ${String(error)}\n`));
      });
      return this.snapshot(task);
    } catch (error) {
      if (job.forceTimer) clearTimeout(job.forceTimer);
      if (!job.admitted) { this.jobs.delete(runId); throw error; }
      await release?.().catch((cleanup) => { task.cleanupError = this.config.redact(String(cleanup)); });
      task.status = 'failed';
      task.error ??= this.config.redact(String(error));
      task.finishedAt = new Date().toISOString();
      try { await this.saveFinal(job); } finally { this.jobs.delete(runId); }
      throw error;
    }
  }

  private async idempotentResult(runId: string, caller: TaskOrigin): Promise<Task> {
    const task = await this.get(runId).catch(() => { throw new Error(`Idempotent task ${runId} has uncertain admission. Inspect state; do not automatically resubmit.`); });
    if (caller.threadId && task.submittedBy?.threadId && caller.threadId !== task.submittedBy.threadId) {
      throw new Error('This idempotencyKey belongs to a different calling chat. Use a distinct key for a separate assignment.');
    }
    return task;
  }

  async reply(runId: string, instruction: string, acceptance?: string, idempotencyKey?: string, timeoutSeconds?: number, caller: TaskOrigin = unknownOrigin()): Promise<Task> {
    const parent = await this.get(runId);
    if (!terminal(parent.status)) throw new Error('Wait for the current turn to finish before replying.');
    if (!parent.sessionId) throw new Error('This task has no resumable native session.');
    return this.start({ backend: parent.backend ?? 'deepseek', workspace: parent.workspace, permissionMode: parent.permissionMode,
      sessionMode: parent.sessionMode ?? 'background',
      modelValue: parent.modelValue, reasoningEffort: parent.reasoningEffort,
      instruction, acceptance, idempotencyKey, timeoutSeconds: timeoutSeconds ?? parent.timeoutSeconds }, parent, caller);
  }

  private snapshot(task: Task): Task {
    return JSON.parse(this.config.redact(JSON.stringify(task)));
  }

  private liveSnapshot(job: Job): Task {
    const task = this.snapshot(job.task);
    // The durable terminal write can still fail. Do not publish success before finalization settles.
    if (terminal(task.status)) task.status = task.cancellation ? 'cancelling' : 'running';
    return task;
  }

  async get(runId: string): Promise<Task> {
    const job = this.jobs.get(runId);
    if (job) return this.liveSnapshot(job);
    const task = this.unpersisted.get(runId);
    return task ? this.snapshot(task) : this.store.get(runId);
  }

  async list(limit: number, matches: (task: Task) => boolean = () => true): Promise<Task[]> {
    const saved = await this.store.list(limit, matches).catch((error) => { if (!this.unpersisted.size) throw error; return []; });
    const tasks = new Map(saved.map(task => [task.runId, task]));
    for (const task of this.unpersisted.values()) tasks.set(task.runId, task);
    for (const job of this.jobs.values()) if (job.admitted) tasks.set(job.task.runId, this.liveSnapshot(job));
    return [...tasks.values()].filter(matches).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(task => this.snapshot(task));
  }

  async wait(runId: string, seconds: number): Promise<Task> {
    const deadline = Date.now() + seconds * 1_000;
    while (true) {
      const task = await this.get(runId);
      if (terminal(task.status) || task.status === 'needs_attention' || Date.now() >= deadline) return task;
      await delay(Math.min(200, deadline - Date.now()));
    }
  }

  async cancel(runId: string): Promise<Task> {
    const job = this.jobs.get(runId);
    if (job) await this.cancelJob(job, 'user');
    else {
      const task = await this.get(runId);
      if (!terminal(task.status)) await this.store.writeControl(runId, { action: 'cancel' });
    }
    return this.wait(runId, Math.ceil(this.config.cancelGraceMs * 2 / 1_000) + 4);
  }

  async respond(runId: string, permissionId: string, optionId: string): Promise<Task> {
    const task = await this.get(runId);
    const permission = task.pendingPermissions.find((item) => item.id === permissionId);
    if (!permission) throw new Error('This permission request is no longer pending.');
    const option = permission.options.find((item) => item.optionId === optionId);
    if (!option || !['allow_once', 'reject_once'].includes(option.kind)) throw new Error('Only an advertised allow_once or reject_once option can be selected.');
    if (task.permissionMode === 'read-only' && option.kind === 'allow_once') throw new Error('SeekWing never escalates a read-only task. Reject this request; start a new workspace-write task if authorized.');
    const job = this.jobs.get(runId);
    if (job) await this.resolvePermission(job, permissionId, optionId);
    else await this.store.writeControl(runId, { action: 'permission', permissionId, optionId });
    return this.get(runId);
  }

  private async resolvePermission(job: Job, id: string, optionId: string): Promise<void> {
    const resolve = job.permissions.get(id);
    if (!resolve) throw new Error('Permission request has already settled.');
    const permission = job.task.pendingPermissions.find((item) => item.id === id)!;
    const option = permission.options.find((item) => item.optionId === optionId);
    if (!option || !['allow_once', 'reject_once'].includes(option.kind) || (option.kind === 'allow_once' && job.task.permissionMode === 'read-only')) throw new Error('Permission escalation is not allowed.');
    job.permissions.delete(id);
    job.task.pendingPermissions = job.task.pendingPermissions.filter((item) => item.id !== id);
    job.task.permissionDecisions.push({ id, optionId, at: new Date().toISOString() });
    if (!job.task.pendingPermissions.length && !job.task.cancellation) job.task.status = 'running';
    await this.save(job);
    resolve({ outcome: { outcome: 'selected', optionId } });
  }

  private permission(job: Job, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (job.task.cancellation) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const id = randomUUID();
    const promise = new Promise<RequestPermissionResponse>((resolve) => { job.permissions.set(id, resolve); });
    const callId = request.toolCall.toolCallId;
    job.task.pendingPermissions.push({ id, toolCall: { ...job.task.toolCalls[callId], ...request.toolCall },
      options: request.options, requestedAt: new Date().toISOString() });
    job.task.status = 'needs_attention';
    void this.save(job).catch(() => {});
    return promise;
  }

  private update(job: Job, notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          const remaining = 100_000 - job.task.output.length;
          job.task.output += update.content.text.slice(0, remaining);
          if (update.content.text.length > remaining) job.task.outputTruncated = true;
        }
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = update.toolCallId;
        // Keep following new calls in long sessions instead of freezing the log
        // forever after its first 100 calls. Prefer evicting finished calls.
        if (!Object.hasOwn(job.task.toolCalls, id) && Object.keys(job.task.toolCalls).length >= 100) {
          const oldest = Object.keys(job.task.toolCalls).find(key => !['pending', 'in_progress'].includes(String(job.task.toolCalls[key].status)))
            ?? Object.keys(job.task.toolCalls)[0];
          delete job.task.toolCalls[oldest];
          job.task.toolCallsTruncated = true;
        }
        if (Object.hasOwn(job.task.toolCalls, id) || Object.keys(job.task.toolCalls).length < 100) {
          const bounded = JSON.parse(this.config.redact(JSON.stringify(update)), (_key, value) => typeof value === 'string' && value.length > 8_000 ? value.slice(0, 8_000) + '\n[TRUNCATED]' : value);
          Object.defineProperty(job.task.toolCalls, id, { value: { status: 'pending', ...(Object.hasOwn(job.task.toolCalls, id) ? job.task.toolCalls[id] : {}), ...bounded }, enumerable: true, configurable: true, writable: true });
        } else job.task.toolCallsTruncated = true;
        break;
      }
      case 'config_option_update': job.task.configOptions = update.configOptions; break;
      case 'usage_update': job.task.usage = update; break;
      // Thought chunks are deliberately neither retained nor returned.
    }
    if (update.sessionUpdate !== 'agent_thought_chunk') void this.save(job).catch(() => {});
  }

  private async cancelJob(job: Job, reason: NonNullable<Task['cancellation']>): Promise<void> {
    if (terminal(job.task.status) || job.task.cancellation) return;
    job.task.cancellation = reason;
    job.task.status = 'cancelling';
    for (const resolve of job.permissions.values()) resolve({ outcome: { outcome: 'cancelled' } });
    job.permissions.clear();
    job.task.pendingPermissions = [];
    // Install the stop deadline and send cancellation even when persistence itself is broken.
    job.forceTimer = setTimeout(() => { void job.worker?.stop().catch(() => {}); }, this.config.cancelGraceMs);
    await Promise.all([this.save(job), job.worker?.cancel()]);
  }

  private async execute(job: Job, release?: () => Promise<void>): Promise<void> {
    const task = job.task;
    const worker = job.worker = createWorker(this.config, task.backend ?? 'deepseek', task.sessionMode ?? 'background',
      task.runId, task.workspace, task.permissionMode, (update) => this.update(job, update), (request) => this.permission(job, request), (message) => {
        if (task.desktopAttention === message) return;
        task.desktopAttention = message;
        if (!task.cancellation) task.status = message ? 'needs_attention' : 'running';
        void this.save(job).catch(() => {});
      });
    const timeout = setTimeout(() => { void this.cancelJob(job, 'timeout').catch(() => {}); }, task.timeoutSeconds * 1_000);
    let readingControls = false;
    const controls = setInterval(() => {
      if (readingControls) return;
      readingControls = true;
      void this.store.takeControls(task.runId).then(async (messages) => {
        for (const message of messages as { action?: string; permissionId: string; optionId: string }[]) {
          if (message.action === 'cancel') await this.cancelJob(job, 'user');
          if (message.action === 'permission') await this.resolvePermission(job, message.permissionId, message.optionId).catch(() => {});
        }
      }).catch(() => {}).finally(() => { readingControls = false; });
    }, 250);
    let outcome: Task['status'] = 'failed';
    try {
      if (task.cancellation) throw new Error('Task cancelled before launch.');
      await worker.start();
      if (task.cancellation) throw new Error('Task cancelled during startup.');
      const session = await worker.openSession(task.sessionId);
      task.sessionId = worker.sessionId;
      task.configOptions = session.configOptions;
      if (!release) release = await this.store.lockSession(sessionLockKey(task.backend ?? 'deepseek', task.sessionId!), task.runId);
      await this.save(job);
      if (task.modelValue !== undefined) task.configOptions = (await worker.setOption('model', task.modelValue)).configOptions;
      if (task.reasoningEffort !== undefined) task.configOptions = (await worker.setOption('reasoning_effort', task.reasoningEffort)).configOptions;
      const options = task.configOptions as { id: string; currentValue?: string }[] | undefined;
      task.modelValue = options?.find((option) => option.id === 'model')?.currentValue ?? task.modelValue;
      task.reasoningEffort = options?.find((option) => option.id === 'reasoning_effort')?.currentValue ?? task.reasoningEffort;
      if (task.cancellation) throw new Error('Task cancelled before prompt admission.');
      task.status = 'running';
      await this.save(job);
      const prompt = [task.instruction, task.acceptance && `Acceptance criteria:\n${task.acceptance}`,
        `Working directory: ${task.workspace}\nPermission mode: ${task.permissionMode}. Stay within the assigned scope. Report changed files, checks actually run and any unresolved limitations.`].filter(Boolean).join('\n\n');
      const result = await worker.prompt(prompt);
      task.stopReason = result.stopReason;
      outcome = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'cancelled' : 'incomplete';
    } catch (error) {
      if (!task.cancellation) task.error = this.config.redact(String(error));
    } finally {
      clearTimeout(timeout);
      clearInterval(controls);
      if (job.forceTimer) clearTimeout(job.forceTimer);
      for (const resolve of job.permissions.values()) resolve({ outcome: { outcome: 'cancelled' } });
      job.permissions.clear();
      task.pendingPermissions = [];
      delete task.desktopAttention;
      try {
        await worker.stop();
        if (task.cancellation && (task.cancellation === 'timeout' || outcome !== 'completed')) {
          outcome = task.cancellation === 'timeout' ? 'failed' : 'cancelled';
          if (task.cancellation === 'timeout') task.error = 'Task deadline exceeded; the owned native turn has stopped.';
        }
        if (worker.cleanupWarning) {
          task.cleanupError = worker.cleanupWarning;
          if (outcome === 'completed') outcome = 'incomplete';
        }
        if (task.persistenceError) outcome = 'failed';
      } catch (error) {
        outcome = 'interrupted';
        task.cleanupError = this.config.redact(String(error));
      }
      task.stderr = worker.stderr || undefined;
      await release?.().catch((error) => { task.cleanupError = String(error); outcome = 'interrupted'; });
      task.status = outcome;
      task.finishedAt = new Date().toISOString();
      try { await this.saveFinal(job); } finally { this.jobs.delete(task.runId); }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    await Promise.allSettled(jobs.map((job) => this.cancelJob(job, 'shutdown')));
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}
