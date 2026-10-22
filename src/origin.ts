import type { Task, TaskOrigin } from './types.js';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);

/** Attribution only, never authentication or an authorization boundary. */
export function callerOrigin(env: NodeJS.ProcessEnv, clientName?: string, meta?: Record<string, unknown>, explicit?: string): TaskOrigin {
  const client = (clientName || 'unknown').slice(0, 120);
  const ids = ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']
    .map(key => meta?.[key]).filter(validId);
  const unique = [...new Set(ids)];
  if (unique.length > 1) throw new Error('Conflicting caller thread metadata. Refusing to assign this run to a guessed chat.');
  if (explicit !== undefined && !validId(explicit)) throw new Error('Invalid callerThreadId. Use the actual calling chat ID, never an invented ID.');
  if (unique[0]) {
    if (explicit && explicit !== unique[0]) throw new Error('callerThreadId conflicts with the thread metadata on this request.');
    return { client, threadId: unique[0], source: 'mcp-metadata' };
  }
  if (explicit) return { client, threadId: explicit, source: 'explicit' };
  // Per-request identity takes precedence: a host may share one MCP process across chats.
  const threadId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  return validId(threadId) ? { client, threadId, source: 'environment' } : { client, source: 'unknown' };
}

export const unknownOrigin = (): TaskOrigin => ({ client: 'unknown', source: 'unknown' });

export function taskOwnership(task: Task, caller: TaskOrigin) {
  return {
    origin: task.origin ?? unknownOrigin(),
    submittedBy: task.submittedBy ?? unknownOrigin(),
    rootRunId: task.rootRunId ?? task.parentRunId ?? task.runId,
    belongsToCurrentChat: caller.threadId && task.origin?.threadId ? caller.threadId === task.origin.threadId : null,
    submittedByCurrentChat: caller.threadId && task.submittedBy?.threadId ? caller.threadId === task.submittedBy.threadId : null,
  };
}
