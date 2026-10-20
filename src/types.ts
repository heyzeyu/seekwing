import type { PermissionMode } from './config.js';

export type TaskStatus = 'starting' | 'running' | 'needs_attention' | 'cancelling' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'interrupted';
export const terminal = (status: TaskStatus): boolean => ['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(status);

export interface TaskInput {
  workspace: string;
  instruction: string;
  acceptance?: string;
  permissionMode: PermissionMode;
  modelValue?: string;
  reasoningEffort?: string;
  timeoutSeconds: number;
  idempotencyKey?: string;
}

export interface Permission {
  id: string;
  toolCall: Record<string, unknown>;
  options: { optionId: string; name: string; kind: string }[];
  requestedAt: string;
}

export interface Task {
  schemaVersion: 1;
  runId: string;
  parentRunId?: string;
  ownerPid: number;
  sessionId?: string;
  workspace: string;
  permissionMode: PermissionMode;
  configuredDefaultRoute: { provider: string; model: string };
  modelValue?: string;
  reasoningEffort?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  instruction: string;
  acceptance?: string;
  timeoutSeconds: number;
  stopReason?: string;
  output: string;
  outputTruncated: boolean;
  toolCalls: Record<string, Record<string, unknown>>;
  toolCallsTruncated?: boolean;
  pendingPermissions: Permission[];
  permissionDecisions: { id: string; optionId: string; at: string }[];
  configOptions?: unknown;
  usage?: unknown;
  error?: string;
  stderr?: string;
  cleanupError?: string;
  cancellation?: 'user' | 'timeout' | 'shutdown';
  reviewRequired: true;
}
