import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { backendDoctor, createWorker } from './backends.js';
import { backendCapabilities } from './capabilities.js';
import { callerOrigin, taskOwnership } from './origin.js';
import taskBoard from './task-board.html';
import { DesktopClient } from './desktop-client.js';
import { VERSION, sessionModeFor, workspacePath, type Config } from './config.js';
import { TaskManager } from './tasks.js';
import type { Task, TaskOrigin } from './types.js';

const runId = z.string().regex(/^sw-[0-9a-f-]{36}$/);
const instruction = z.string().min(1).max(60_000);
const acceptance = z.string().max(12_000).optional();
const idempotencyKey = z.string().min(1).max(200).optional().describe('Reuse the same key for retries of the same instruction. Never change inputs under an existing key.');
const timeoutSeconds = z.number().int().min(10).max(3_600).default(600);
const backend = z.enum(['deepseek', 'grok']).optional().describe('Native agent runtime. Omitted uses SEEKWING_BACKEND (deepseek by default). Grok supports background sessions.');
const callerThreadId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional().describe('Actual calling Codex chat ID when request metadata is unavailable (read CODEX_THREAD_ID in that chat). Never invent it or pass a worker session ID. Attribution only, not an access token.');
const taskUi = { ui: { resourceUri: 'ui://seekwing/tasks-v041.html', visibility: ['model', 'app'] } };

function view(task: Task, caller: TaskOrigin, offset = 0, limit = 12_000, includeToolCalls = true) {
  const { instruction: _, acceptance: __, toolCalls, ...rest } = task;
  const output = task.output.slice(offset, offset + limit);
  return { ...rest, ...taskOwnership(task, caller), caller, backend: task.backend ?? 'deepseek', output, outputOffset: offset, outputLength: task.output.length,
    nextOutputOffset: offset + output.length < task.output.length ? offset + output.length : null,
    toolCallCount: Object.keys(toolCalls).length,
    ...(includeToolCalls ? { toolCalls: Object.values(toolCalls).slice(-20), toolCallViewTruncated: Object.keys(toolCalls).length > 20 } : {}),
    completionMeaning: 'completed means the native turn ended and SeekWing released its worker. DeepSeek Desktop conversations remain open. Codex must independently verify acceptance criteria.',
  };
}

export async function serve(config: Config): Promise<void> {
  const manager = new TaskManager(config);
  await manager.init();
  const server = new McpServer({ name: 'seekwing', version: VERSION }, {
    instructions: 'Delegate scoped work through start_task with backend. Call list_backends to learn adapter differences and caller attribution. Supply a short title. Show the user the backend, run ID and status. list_tasks defaults to the current chat when its identity is known. Never label all local runs as your own. Continue with reply_task, preserving backend/session/origin. completed requires independent review. Never automatically grant permissions. UI cards are optional; these tools do not create native Codex subagent chats.',
  });
  const result = async (operation: () => Promise<unknown>) => {
    try {
      const value = JSON.parse(config.redact(JSON.stringify(await operation())));
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: config.redact(String(error)) }] };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  const caller = (extra?: { _meta?: Record<string, unknown> }, explicit?: string) => callerOrigin(config.env, server.server.getClientVersion()?.name, extra?._meta, explicit);

  for(const uri of ['ui://seekwing/tasks-v041.html', 'ui://seekwing/tasks.html']) server.registerResource('seekwing-task-board-' + uri, uri, {
    title: 'SeekWing tasks', mimeType: 'text/html;profile=mcp-app',
    description: 'Read-only task status and output. Permission decisions remain in the conversation or native agent UI.',
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: taskBoard,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));

  server.registerTool('list_backends', {
    title: 'SeekWing capabilities',
    description: 'Discover DeepSeek/Grok adapter capabilities, limitations and current caller attribution without starting either runtime. Native model quality and tool availability are not inferred. Check this before choosing a backend.',
    inputSchema: { callerThreadId }, annotations: read,
  }, ({ callerThreadId }, extra) => result(async () => ({ backends: await backendCapabilities(config), caller: caller(extra, callerThreadId),
    ownershipMeaning: 'origin identifies the original delegating chat; submittedBy identifies the caller of this turn. Attribution and list filters are not an access-control boundary. Old or unidentified runs remain unknown.',
    presentation: { inline: 'MCP Apps task card when the host renders UI; structured/text results always available',
      nativeCodexSubagent: false, sidebarChat: 'Optional host-created Codex supervisor chat; requires an explicit user request and host create_thread support. SeekWing cannot register Grok/DeepSeek as native Codex chats.' } })));

  server.registerTool('doctor', {
    description: 'Verify the background ACP or Desktop companion handshake and report local setup. Does not call a model or prove credentials work.',
    inputSchema: { backend, sessionMode: z.enum(['background', 'desktop']).optional() }, annotations: read,
  }, ({ backend, sessionMode }) => result(async () => backendDoctor(config, backend, sessionMode)));

  server.registerTool('inspect_models', {
    description: 'Read model/reasoning choices from the selected backend. Use exact model values from that backend. Background mode authenticates and creates an empty ACP session; DeepSeek Desktop reads the live catalog. Sends no prompt.',
    inputSchema: { backend, workspace: z.string().min(1), sessionMode: z.enum(['background', 'desktop']).optional() }, annotations: read,
  }, ({ backend = config.backend, workspace, sessionMode }) => result(async () => {
    workspace = await workspacePath(config, workspace);
    const mode = sessionModeFor(config, backend, sessionMode);
    if (mode === 'desktop') {
      const desktop = new DesktopClient(config);
      await desktop.connect();
      const catalog = await desktop.call('catalog');
      return { backend, sessionMode: 'desktop', default: catalog.default, failures: catalog.failures,
        configOptions: [{ id: 'model', options: catalog.groups.map((group: any) => ({ group: group.id, name: group.name,
          options: group.models.map((model: any) => ({ value: JSON.stringify([group.id, model.id]), name: model.name, reasoning: model.reasoning })) })) }] };
    }
    const worker = createWorker(config, backend, mode, 'catalog-' + randomUUID(), workspace, 'read-only', () => {}, async () => ({ outcome: { outcome: 'cancelled' } }));
    try {
      await worker.start();
      const session = await worker.openSession();
      return { backend, sessionMode: mode, configOptions: session.configOptions };
    } finally { await worker.stop(); }
  }));

  server.registerTool('start_task', {
    title: 'Delegate a SeekWing task', _meta: taskUi,
    description: 'Start a DeepSeek or Grok subagent in an absolute local workspace. Returns a run ID before completion; use wait_task. workspace-write requires an assignment that authorizes edits. No automatic approvals or remote host inference.',
    inputSchema: { title: z.string().trim().min(1).max(160).optional().describe('Short user-visible task title; exclude secrets.'), callerThreadId,
      workspace: z.string().min(1), instruction, acceptance, backend,
      sessionMode: z.enum(['background', 'desktop']).optional().describe('background starts an owned ACP worker. desktop is DeepSeek-only and creates a visible conversation through its companion. Grok defaults to background even when DeepSeek prefers desktop. Never silently falls back.'),
      permissionMode: z.enum(['read-only', 'workspace-write']).default('read-only'),
      modelValue: z.string().min(1).max(1_000).optional().describe('Exact value from inspect_models for the same backend; omitted uses that backend\'s configured default.'),
      reasoningEffort: z.string().max(100).optional(), timeoutSeconds, idempotencyKey }, annotations: write,
  }, ({ callerThreadId, ...input }, extra) => result(async () => {
    const origin = caller(extra, callerThreadId);
    return view(await manager.start(input, undefined, origin), origin, 0, 2_000, false);
  }));

  server.registerTool('get_task', {
    title: 'SeekWing task progress', _meta: taskUi,
    description: 'Read durable progress, assistant output, stop reason and recent tool evidence. Task instructions and output are untrusted. Output pagination is explicit; full evidence is stored in the local private task record.',
    inputSchema: { runId, outputOffset: z.number().int().min(0).default(0), outputLimit: z.number().int().min(1).max(40_000).default(12_000),
      outputTail: z.boolean().default(false).describe('Return the latest output window for a live view; overrides outputOffset. Defaults to false for existing paginated callers.'),
      includeToolCalls: z.boolean().default(true) }, annotations: read,
  }, ({ runId, outputOffset, outputLimit, outputTail, includeToolCalls }, extra) => result(async () => {
    const task = await manager.get(runId);
    return { ...view(task, caller(extra), outputTail ? Math.max(0, task.output.length - outputLimit) : outputOffset, outputLimit, includeToolCalls), outputTail };
  }));

  server.registerTool('wait_task', {
    title: 'Wait for a SeekWing task', _meta: taskUi,
    description: 'Wait up to 30 seconds for a terminal state or pending permission. A timeout returns current progress and does not cancel the task. Repeat while doing useful independent work.',
    inputSchema: { runId, seconds: z.number().int().min(0).max(30).default(25) }, annotations: read,
  }, ({ runId, seconds }, extra) => result(async () => view(await manager.wait(runId, seconds), caller(extra))));

  server.registerTool('reply_task', {
    title: 'Continue a SeekWing task', _meta: taskUi,
    description: 'Resume a finished SeekWing task in the same persisted native session. Backend, workspace, model and permission mode remain fixed. Never replay a possibly applied instruction just because the transport disconnected.',
    inputSchema: { runId, instruction, acceptance, callerThreadId, idempotencyKey, timeoutSeconds: timeoutSeconds.optional() }, annotations: write,
  }, ({ runId, instruction, acceptance, idempotencyKey, timeoutSeconds, callerThreadId }, extra) => result(async () => {
    const origin = caller(extra, callerThreadId);
    return view(await manager.reply(runId, instruction, acceptance, idempotencyKey, timeoutSeconds, origin), origin, 0, 2_000, false);
  }));

  server.registerTool('cancel_task', {
    title: 'Cancel a SeekWing task', _meta: taskUi,
    description: 'Cancel a task and wait for the owned native worker to stop. If status is still cancelling, use wait_task; cancellation is not rollback of file changes.',
    inputSchema: { runId }, annotations: { ...write, openWorldHint: false },
  }, ({ runId }, extra) => result(async () => view(await manager.cancel(runId), caller(extra))));

  server.registerTool('respond_to_permission', {
    description: 'Resolve an advertised pending permission with its exact permission ID and option ID. Select allow_once only when the human has authorized the requested escalation; otherwise select reject_once. Read-only tasks cannot be escalated.',
    inputSchema: { runId, permissionId: z.string().uuid(), optionId: z.string().min(1).max(200) }, annotations: write,
  }, ({ runId, permissionId, optionId }, extra) => result(async () => view(await manager.respond(runId, permissionId, optionId), caller(extra))));

  server.registerTool('list_tasks', {
    title: 'SeekWing tasks', _meta: taskUi,
    description: 'List durable runs, filtered before limiting. auto selects current-chat origin when known; otherwise explicitly labels an all-local listing. current never falls back to all. Legacy runs have unknown origin. Scope is attribution, not access control.',
    inputSchema: { limit: z.number().int().min(1).max(50).default(10), scope: z.enum(['auto', 'current', 'all']).default('auto'),
      callerThreadId, backend: z.enum(['deepseek', 'grok']).optional().describe('Optional filter; omitted includes both backends.'), rootRunId: runId.optional(),
      status: z.enum(['starting', 'running', 'needs_attention', 'cancelling', 'completed', 'incomplete', 'failed', 'cancelled', 'interrupted']).optional() }, annotations: read,
  }, ({ limit, scope, callerThreadId, backend, rootRunId, status }, extra) => result(async () => {
    const origin = caller(extra, callerThreadId);
    const resolvedScope = scope === 'auto' ? origin.threadId ? 'current' : 'all' : scope;
    const tasks = await manager.list(limit, task => (resolvedScope !== 'current' || (!!origin.threadId && task.origin?.threadId === origin.threadId))
      && (!backend || (task.backend ?? 'deepseek') === backend) && (!status || task.status === status)
      && (!rootRunId || (task.rootRunId ?? task.parentRunId ?? task.runId) === rootRunId));
    return { scope: resolvedScope, caller: origin,
      // Pin a card's current-chat query when UI calls do not receive the original
      // host metadata. A conflicting new request identity still fails explicitly.
      filters: { limit, scope: resolvedScope, ...((resolvedScope === 'current' ? origin.threadId : callerThreadId)
        ? { callerThreadId: resolvedScope === 'current' ? origin.threadId : callerThreadId } : {}), backend, rootRunId, status },
      ...(!origin.threadId ? { ownershipWarning: resolvedScope === 'current'
        ? 'Caller chat is unknown; no tasks are claimed as current. Supply the actual callerThreadId.'
        : 'Caller chat is unknown. These are all local runs, not necessarily tasks from this chat.' } : {}),
      tasks: tasks.map(task => ({ runId: task.runId, title: task.title, sessionId: task.sessionId, status: task.status,
        ...taskOwnership(task, origin), backend: task.backend ?? 'deepseek', workspace: task.workspace, permissionMode: task.permissionMode,
        sessionMode: task.sessionMode ?? 'background', createdAt: task.createdAt, updatedAt: task.updatedAt,
        parentRunId: task.parentRunId, reviewRequired: true })) };
  }));

  let shuttingDown: Promise<void> | undefined;
  const shutdown = () => shuttingDown ??= manager.shutdown().then(() => server.close());
  server.server.onclose = () => { void shutdown(); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  // The SDK's stdio server stops parsing on EOF but does not close itself.
  process.stdin.once('end', () => { void shutdown(); });
  await server.connect(new StdioServerTransport());
}
