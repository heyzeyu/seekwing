import { randomUUID } from 'node:crypto';
import type { InitializeResponse, NewSessionResponse, ResumeSessionResponse } from '@agentclientprotocol/sdk';
import { methods } from '@agentclientprotocol/sdk';
import { AcpProcessWorker } from './acp-process.js';
import { privateDir, requireCommand, VERSION, type Config } from './config.js';
import { bounded } from './worker.js';

/** Grok owns auth, tools and session storage. SeekWing never reads its credentials. */
export class GrokWorker extends AcpProcessWorker {
  protected readonly label = 'Grok';
  private authenticated = false;
  private get sandbox(): string { return this.permissionMode === 'read-only' ? 'read-only' : 'workspace'; }

  protected async launch() {
    await requireCommand(this.config, 'grok');
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('Grok sandbox enforcement requires macOS or Linux. SeekWing will not launch an unrestricted worker.');
    }
    return { command: this.config.grokCommand,
      // No shared leader: cancellation only owns this process and its descendants.
      args: [...this.config.grokArgs, '--sandbox', this.sandbox, '--permission-mode', 'default', 'agent', '--no-leader', 'stdio'],
      env: { ...this.config.env, GROK_HOME: this.config.grokHome, GROK_SANDBOX: this.sandbox,
        GROK_SANDBOX_AUTO_ALLOW_BASH: 'false', GROK_DISABLE_AUTOUPDATER: '1' } };
  }

  protected validateAgent(info: InitializeResponse): void {
    // Released Grok may omit agentInfo. Check the features actually used, not a guessed name.
    if (!info.agentCapabilities?.sessionCapabilities?.resume || !info.agentCapabilities?.sessionCapabilities?.close) {
      throw new Error('This Grok ACP runtime must support session resume and close. Upgrade the official Grok CLI.');
    }
  }

  protected sessionMeta(): Record<string, unknown> {
    return { clientIdentifier: 'seekwing', sessionKind: 'headless', yoloMode: false, autoMode: false };
  }

  async openSession(sessionId?: string): Promise<NewSessionResponse | ResumeSessionResponse> {
    if (!this.authenticated) {
      const methodsAvailable = new Set(this.agentInfo?.authMethods?.map(method => method.id));
      const methodId = this.config.env.XAI_API_KEY && methodsAvailable.has('xai.api_key') ? 'xai.api_key'
        : methodsAvailable.has('cached_token') ? 'cached_token' : undefined;
      if (!methodId) throw new Error('Grok has no noninteractive authentication method. Run grok login first, or configure a supported XAI_API_KEY.');
      await bounded(this.connection!.agent.request(methods.agent.authenticate, { methodId, _meta: { headless: true } }),
        this.config.startupTimeoutMs, 'Grok authentication timed out. Run grok login and retry.');
      this.authenticated = true;
    }
    const result = await super.openSession(sessionId);
    // Managed requirements can override environment/CLI settings. Confirm the native
    // session's applied profile before sending any instruction, including after resume.
    const state = await bounded(this.connection!.agent.request<{ summary?: { sandbox_profile?: string; info?: { id?: string; cwd?: string } } }>(
      '_x.ai/session/state', { sessionId: this.sessionId!, cwd: this.workspace }), this.config.startupTimeoutMs, 'Grok sandbox verification timed out.');
    if (state.summary?.sandbox_profile !== this.sandbox || state.summary?.info?.cwd !== this.workspace || state.summary?.info?.id !== this.sessionId) {
      throw new Error('Grok did not confirm the requested sandbox and workspace. No prompt was sent. Check Grok version and managed sandbox policy.');
    }
    return result;
  }

  async setOption(id: string, value: string) {
    const result = await super.setOption(id, value);
    const option = result.configOptions.find(option => option.id === id);
    if (!option || !('currentValue' in option) || option.currentValue !== value) {
      throw new Error(`Grok did not accept the requested ${id}; refusing to silently use another value.`);
    }
    return result;
  }
}

export async function grokDoctor(config: Config) {
  await privateDir(config.stateDir);
  const worker = new GrokWorker(config, 'doctor-' + randomUUID(), config.stateDir, 'read-only', () => {}, async () => ({ outcome: { outcome: 'cancelled' } }));
  try {
    const protocol = await worker.start();
    await worker.stop();
    return { version: VERSION, backend: 'grok', sessionMode: 'background', command: config.grokCommand,
      stateDir: config.stateDir, grokHome: config.grokHome, defaultRoute: { provider: 'grok-cli', model: config.grokModel ?? 'native-default' },
      apiKeyPresent: Boolean(config.env.XAI_API_KEY), protocol, warnings: worker.stderr ? [worker.stderr] : [],
      note: 'ACP handshake verified. Login, session sandbox and generation are checked when a task opens its session. Native history is stored in Grok home; this does not attach to an open TUI.' };
  } catch (error) {
    throw new Error(config.redact(`${String(error)}${worker.stderr ? '\nGrok stderr: ' + worker.stderr : ''}`));
  } finally { await worker.stop(); }
}
