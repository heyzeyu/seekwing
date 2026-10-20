import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { Config, PermissionMode } from './config.js';
import type { Update, Worker } from './worker.js';

interface Endpoint { schemaVersion: 1; version: string; url: string; token: string; instanceId: string }
export class DesktopClient {
  private endpoint?: Endpoint;
  constructor(private readonly config: Config) {}
  async connect() {
    try {
      const info = await stat(this.config.desktopEndpoint);
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Desktop endpoint must be private (mode 0600).');
      const endpoint: Endpoint = JSON.parse(await readFile(this.config.desktopEndpoint, 'utf8'));
      const url = new URL(endpoint.url);
      if (endpoint.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/seekwing' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid Desktop endpoint descriptor.');
      this.endpoint = endpoint;
      return await this.call('hello');
    } catch (error) {
      throw new Error(`Desktop companion unavailable. Run seekwing desktop-install, then restart DeepSeek Harness. ${String(error)}`);
    }
  }
  async call(action: string, input: Record<string, unknown> = {}): Promise<any> {
    if (!this.endpoint) throw new Error('Desktop client is not connected.');
    const response = await fetch(this.endpoint.url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.endpoint.token}` },
      body: JSON.stringify({ action, instanceId: this.endpoint.instanceId, ...input }), signal: AbortSignal.timeout(15_000) });
    const value = await response.json() as { result?: unknown; error?: string };
    if (!response.ok || value.error) throw new Error(value.error || `Desktop bridge HTTP ${response.status}`);
    return value.result;
  }
}

export class DesktopWorker implements Worker {
  private client: DesktopClient;
  private closed = false;
  private opened = false;
  private cursor = 0;
  private stopping?: Promise<void>;
  sessionId?: string;
  stderr = '';
  cleanupWarning?: string;
  constructor(readonly config: Config, readonly runId: string, readonly workspace: string, readonly permissionMode: PermissionMode,
    readonly onUpdate: Update, readonly onAttention: (message?: string) => void = () => {}) { this.client = new DesktopClient(config); }
  start() { return this.client.connect(); }
  async openSession(sessionId?: string) {
    if (this.closed) throw new Error('Desktop turn was cancelled before startup.');
    const result = await this.client.call('open', { runId: this.runId, workspace: this.workspace, permissionMode: this.permissionMode, sessionId, ownerPid: process.pid });
    this.sessionId = result.sessionId;
    this.opened = true;
    return result;
  }
  setOption(id: string, value: string) { return this.client.call('configure', { runId: this.runId, id, value }); }
  async prompt(text: string): Promise<{ stopReason: string }> {
    if (this.closed) throw new Error('Desktop turn cancelled before prompt admission.');
    // Admission errors are never retried: the native Host may already have accepted the instruction.
    await this.client.call('prompt', { runId: this.runId, text });
    while (!this.closed) {
      const result = await this.client.call('poll', { runId: this.runId, cursor: this.cursor });
      for (const entry of result.updates as { cursor: number; update: SessionNotification['update'] }[]) {
        if (entry.cursor <= this.cursor) continue;
        this.onUpdate({ sessionId: this.sessionId!, update: entry.update });
        this.cursor = entry.cursor;
      }
      this.onAttention(result.attention);
      if (result.error) throw new Error(result.error);
      if (result.stopReason) return { stopReason: result.stopReason };
      await delay(250);
    }
    return { stopReason: 'cancelled' };
  }
  async cancel() {
    this.closed = true;
    if (this.opened) await this.client.call('cancel', { runId: this.runId });
  }
  stop(): Promise<void> { return this.stopping ??= this.stopOnce(); }
  private async stopOnce() {
    this.closed = true;
    if (!this.opened) return;
    // Release never stops the Harness app or closes its user-visible conversation.
    await this.client.call('release', { runId: this.runId });
    this.opened = false;
  }
}

export async function desktopDoctor(config: Config) {
  const client = new DesktopClient(config);
  return { ...(await client.connect()), endpointFile: config.desktopEndpoint,
    note: 'Desktop companion handshake verified. No prompt was sent; generation is not yet verified.' };
}
