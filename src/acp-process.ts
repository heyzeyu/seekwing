import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type InitializeResponse, type NewSessionResponse, type ResumeSessionResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk';
import { VERSION, type Config, type PermissionMode } from './config.js';
import { bounded } from './worker.js';
export { bounded } from './worker.js';

export abstract class AcpProcessWorker {
  protected abstract readonly label: string;
  protected abstract launch(): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
  protected abstract validateAgent(info: InitializeResponse): void;
  protected async cleanup(): Promise<void> {}
  protected sessionMeta(): Record<string, unknown> | undefined { return undefined; }
  private child?: ChildProcessWithoutNullStreams;
  protected connection?: ClientConnection;
  private exited?: Promise<void>;
  private stderrText = '';
  private spawnError?: Error;
  protected stopped = false;
  private stopping?: Promise<void>;
  sessionId?: string;
  agentInfo?: InitializeResponse;
  cleanupWarning?: string;

  constructor(
    readonly config: Config,
    readonly runId: string,
    readonly workspace: string,
    readonly permissionMode: PermissionMode,
    readonly onUpdate: (notification: SessionNotification) => void,
    readonly onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ) {}

  get stderr(): string { return this.config.redact(this.stderrText); }

  async start(): Promise<InitializeResponse> {
    if (this.stopped) throw new Error('Worker was cancelled before startup.');
    const launch = await this.launch();
    if (this.stopped) { await this.cleanup(); throw new Error('Worker was cancelled before launch.'); }
    const child = this.child = spawn(launch.command, launch.args, {
      cwd: this.workspace, env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    this.exited = new Promise<void>((resolve) => {
      child.once('error', (error) => { this.spawnError = error; resolve(); });
      child.once('close', () => resolve());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderrText = (this.stderrText + chunk).slice(-16_000); });
    // Stream failures are also observed through ACP; prevent a late EPIPE from escaping shutdown.
    child.stdin.on('error', () => {});
    this.connection = client({ name: 'seekwing' })
      .onNotification(methods.client.session.update, ({ params }) => { this.onUpdate(params); })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.onPermission(params))
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>));
    void this.connection.closed.catch(() => {});
    this.agentInfo = await bounded(this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'seekwing', version: VERSION },
      clientCapabilities: {},
    }), this.config.startupTimeoutMs, `${this.label} ACP initialization timed out.`);
    if (this.spawnError) throw this.spawnError;
    this.validateAgent(this.agentInfo);
    if (this.agentInfo.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ${this.label} ACP protocol ${this.agentInfo.protocolVersion}; SeekWing requires stable ACP ${PROTOCOL_VERSION}. Update compatible runtime/SeekWing versions before sending a task.`);
    return this.agentInfo;
  }

  async openSession(sessionId?: string): Promise<NewSessionResponse | ResumeSessionResponse> {
    if (!this.connection || this.stopped) throw new Error(`${this.label} worker is not available.`);
    const params = { cwd: this.workspace, mcpServers: [], ...(this.sessionMeta() ? { _meta: this.sessionMeta() } : {}) };
    if (sessionId) {
      const result = await bounded(this.connection.agent.request<ResumeSessionResponse>(methods.agent.session.resume, { ...params, sessionId }), this.config.startupTimeoutMs, `${this.label} session resume timed out.`);
      this.sessionId = sessionId;
      return result;
    }
    const result = await bounded(this.connection.agent.request<NewSessionResponse>(methods.agent.session.new, params), this.config.startupTimeoutMs, `${this.label} session creation timed out.`);
    this.sessionId = result.sessionId;
    return result;
  }

  async setOption(configId: string, value: string) {
    return bounded(this.connection!.agent.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId!, configId, value }), this.config.startupTimeoutMs, `${this.label} model configuration timed out.`);
  }

  prompt(text: string) {
    if (!this.connection || !this.sessionId || this.stopped) throw new Error(`${this.label} worker is not available.`);
    return this.connection.agent.request(methods.agent.session.prompt, { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
  }

  async cancel(): Promise<void> {
    this.stopped = true;
    if (this.sessionId && this.connection && !this.connection.signal.aborted) {
      await bounded(this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId }), 1_000, 'ACP cancel notification timed out.').catch(() => {});
    }
  }

  private kill(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  async stop(): Promise<void> {
    return this.stopping ??= this.stopOnce();
  }
  private async stopOnce(): Promise<void> {
    this.stopped = true;
    try {
      if (this.sessionId && this.connection && !this.connection.signal.aborted) {
        await bounded(this.connection.agent.request(methods.agent.session.close, { sessionId: this.sessionId }), this.config.cancelGraceMs, `${this.label} session close timed out.`)
          .catch((error) => { this.cleanupWarning = this.config.redact(String(error)); });
      }
    } finally {
      try {
        this.child?.stdin.end();
        if (this.exited) {
          try { await bounded(this.exited, this.config.cancelGraceMs, `${this.label} exit timed out.`); }
          catch {
            this.kill('SIGTERM');
            try { await bounded(this.exited, 1_000, `${this.label} termination timed out.`); }
            catch { this.kill('SIGKILL'); await bounded(this.exited, 2_000, `Could not confirm ${this.label} process exit.`); }
          }
        }
      } finally {
        this.connection?.close();
        await this.cleanup();
      }
    }
  }
}
