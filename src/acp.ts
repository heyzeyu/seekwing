import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type InitializeResponse, type NewSessionResponse, type ResumeSessionResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk';
import { privateDir, VERSION, type Config, type PermissionMode } from './config.js';

export async function bounded<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer!); }
}

export class AcpWorker {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private exited?: Promise<void>;
  private patchFile?: string;
  private stderrText = '';
  private spawnError?: Error;
  private stopped = false;
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
    const dir = path.join(this.config.stateDir, 'patches');
    await privateDir(dir);
    await privateDir(this.config.harnessHome);
    this.patchFile = path.join(dir, this.runId + '.json');
    // Last overlay enforces the chosen native sandbox even when a custom Harness home has overrides.
    await writeFile(this.patchFile, JSON.stringify([
      { id: 'acp', config: { provider: this.config.provider, model: this.config.model } },
      { id: 'sandbox-policy', config: { mode: this.permissionMode, workspaceRoot: this.workspace } },
      // A Cordis overlay replaces this plugin's config; keeping only defaultPreset
      // falls back to the upstream catalog, which does not include read-only.
      { id: 'permission', config: {
        defaultPreset: this.permissionMode,
        presets: {
          'read-only': { sandbox: 'read-only', approval: 'ask' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        },
      } },
      { id: 'approval', config: { policy: 'ask' } },
    ]), { mode: 0o600 });
    if (this.stopped) throw new Error('Worker was cancelled before launch.');
    const child = this.child = spawn(this.config.command, [...this.config.commandArgs, '--profile', 'acp', '--patch', this.patchFile], {
      cwd: this.workspace,
      env: { ...this.config.env, DSH_HOME: this.config.harnessHome, DSH_PERMISSION_MODE: this.permissionMode },
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
    }), this.config.startupTimeoutMs, 'Harness ACP initialization timed out.');
    if (this.spawnError) throw this.spawnError;
    if (this.agentInfo.agentInfo?.name !== 'deepseek-harness-acp') throw new Error('The executable is not the official DeepSeek Harness ACP agent.');
    return this.agentInfo;
  }

  async openSession(sessionId?: string): Promise<NewSessionResponse | ResumeSessionResponse> {
    if (!this.connection || this.stopped) throw new Error('Harness worker is not available.');
    const params = { cwd: this.workspace, mcpServers: [] };
    if (sessionId) {
      const result = await bounded(this.connection.agent.request<ResumeSessionResponse>(methods.agent.session.resume, { ...params, sessionId }), this.config.startupTimeoutMs, 'Harness session resume timed out.');
      this.sessionId = sessionId;
      return result;
    }
    const result = await bounded(this.connection.agent.request<NewSessionResponse>(methods.agent.session.new, params), this.config.startupTimeoutMs, 'Harness session creation timed out.');
    this.sessionId = result.sessionId;
    return result;
  }

  async setOption(configId: string, value: string) {
    return bounded(this.connection!.agent.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId!, configId, value }), this.config.startupTimeoutMs, 'Harness model configuration timed out.');
  }

  prompt(text: string) {
    if (!this.connection || !this.sessionId || this.stopped) throw new Error('Harness worker is not available.');
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
        await bounded(this.connection.agent.request(methods.agent.session.close, { sessionId: this.sessionId }), this.config.cancelGraceMs, 'Harness session close timed out.')
          .catch((error) => { this.cleanupWarning = this.config.redact(String(error)); });
      }
    } finally {
      try {
        this.child?.stdin.end();
        if (this.exited) {
          try { await bounded(this.exited, this.config.cancelGraceMs, 'Harness exit timed out.'); }
          catch {
            this.kill('SIGTERM');
            try { await bounded(this.exited, 1_000, 'Harness termination timed out.'); }
            catch { this.kill('SIGKILL'); await bounded(this.exited, 2_000, 'Could not confirm Harness process exit.'); }
          }
        }
      } finally {
        this.connection?.close();
        if (this.patchFile) await unlink(this.patchFile).catch(() => {});
      }
    }
  }
}

export async function doctor(config: Config) {
  // Plugin upgrades can remove the running server's original working directory.
  // Diagnostics need no project files, so use the stable, private state root.
  const worker = new AcpWorker(config, 'doctor-' + process.pid, config.stateDir, 'read-only', () => {}, async () => ({ outcome: { outcome: 'cancelled' } }));
  try {
    const protocol = await worker.start();
    await worker.stop();
    return { version: VERSION, command: config.command, stateDir: config.stateDir, harnessHome: config.harnessHome,
      defaultRoute: { provider: config.provider, model: config.model },
      apiKeyPresent: Boolean(config.env.DEEPSEEK_API_KEY), protocol,
      warnings: worker.stderr ? [worker.stderr] : [],
      note: 'ACP handshake verified. No model request was made; credentials and generation are not yet verified.' };
  } catch (error) {
    throw new Error(config.redact(`${String(error)}${worker.stderr ? '\nHarness stderr: ' + worker.stderr : ''}`));
  } finally { await worker.stop(); }
}
