import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { privateDir, requireCommand, VERSION, type Config } from './config.js';
import { AcpProcessWorker } from './acp-process.js';
export { bounded } from './worker.js';

/** DeepSeek-specific launch configuration; transport and draining are shared. */
export class AcpWorker extends AcpProcessWorker {
  protected readonly label = 'Harness';
  private patchFile?: string;
  protected async launch() {
    await requireCommand(this.config, 'deepseek');
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
    return { command: this.config.command,
      args: [...this.config.commandArgs, '--profile', 'acp', '--patch', this.patchFile],
      env: { ...this.config.env, DSH_HOME: this.config.harnessHome, DSH_PERMISSION_MODE: this.permissionMode } };
  }
  protected validateAgent(info: InitializeResponse): void {
    if (info.agentInfo?.name !== 'deepseek-harness-acp') throw new Error('The executable is not the official DeepSeek Harness ACP agent.');
  }
  protected async cleanup(): Promise<void> {
    if (this.patchFile) await unlink(this.patchFile).catch(() => {});
  }
}

export async function doctor(config: Config) {
  // Plugin upgrades can remove the running server's original working directory.
  // Diagnostics need no project files, so use the stable, private state root.
  const worker = new AcpWorker(config, 'doctor-' + randomUUID(), config.stateDir, 'read-only', () => {}, async () => ({ outcome: { outcome: 'cancelled' } }));
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
