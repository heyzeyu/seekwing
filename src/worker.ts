import type { SessionNotification } from '@agentclientprotocol/sdk';

/** Common lifecycle; a Desktop worker owns one turn, never the Desktop process. */
export interface Worker {
  sessionId?: string;
  stderr: string;
  cleanupWarning?: string;
  start(): Promise<unknown>;
  openSession(sessionId?: string): Promise<{ configOptions?: unknown }>;
  setOption(id: string, value: string): Promise<{ configOptions?: unknown }>;
  prompt(text: string): Promise<{ stopReason: string }>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
}
export type Update = (notification: SessionNotification) => void;
