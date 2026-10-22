import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpWorker, doctor } from './acp.js';
import { DesktopWorker, desktopDoctor } from './desktop-client.js';
import { GrokWorker, grokDoctor } from './grok.js';
import { sessionModeFor, type Backend, type Config, type PermissionMode, type SessionMode } from './config.js';
import type { Worker } from './worker.js';

export function createWorker(config: Config, backend: Backend, sessionMode: SessionMode, runId: string, workspace: string,
  permissionMode: PermissionMode, update: (notification: SessionNotification) => void,
  permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>, attention: (message?: string) => void = () => {}): Worker {
  sessionModeFor(config, backend, sessionMode);
  if (backend === 'grok') return new GrokWorker(config, runId, workspace, permissionMode, update, permission);
  if (sessionMode === 'desktop') return new DesktopWorker(config, runId, workspace, permissionMode, update, attention);
  return new AcpWorker(config, runId, workspace, permissionMode, update, permission);
}

export async function backendDoctor(config: Config, backend = config.backend, mode?: SessionMode) {
  const sessionMode = sessionModeFor(config, backend, mode);
  const result = await (backend === 'grok' ? grokDoctor(config) : sessionMode === 'desktop' ? desktopDoctor(config) : doctor(config));
  return { ...result, backend, sessionMode };
}

// Preserve existing DeepSeek locks so old and new servers still serialize its turns.
export const sessionLockKey = (backend: Backend, sessionId: string) => backend === 'grok' ? `grok:${sessionId}` : sessionId;
