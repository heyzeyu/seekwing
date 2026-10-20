import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const VERSION = '0.2.0';
export type PermissionMode = 'read-only' | 'workspace-write';
export type SessionMode = 'background' | 'desktop';
export interface Config {
  command: string;
  commandArgs: string[];
  stateDir: string;
  harnessHome: string;
  desktopEndpoint: string;
  sessionMode: SessionMode;
  provider: string;
  model: string;
  allowedRoots: string[];
  maxConcurrent: number;
  startupTimeoutMs: number;
  cancelGraceMs: number;
  env: NodeJS.ProcessEnv;
  redact: (value: string) => string;
}

export function redactor(env: NodeJS.ProcessEnv): (value: string) => string {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE)/i.test(key) && value && value.length >= 8)
    .map(([, value]) => value!).sort((a, b) => b.length - a.length);
  return (value) => {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})\b/gi, '[REDACTED]');
  };
}

async function executable(file: string): Promise<boolean> {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; }
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'SeekWing')
    : process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'SeekWing')
      : path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'seekwing');
  return path.resolve(env.SEEKWING_STATE_DIR || base);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const stateDir = defaultStateDir(env);
  const desktop = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  // Prefer the actual Desktop CLI: a user-defined `dsh` can be an unrelated SSH wrapper.
  let command = env.SEEKWING_DSH_COMMAND;
  if (!command && process.platform === 'darwin' && await executable(desktop)) command = desktop;
  if (!command) {
    for (const dir of (env.PATH || '').split(path.delimiter)) {
      const candidate = path.resolve(dir, process.platform === 'win32' ? 'dsh.exe' : 'dsh');
      if (await executable(candidate)) { command = candidate; break; }
    }
  }
  if (!command) throw new Error('Official DeepSeek Harness CLI not found. Install Harness or set SEEKWING_DSH_COMMAND to its executable.');
  if (!path.isAbsolute(command) || !await executable(command)) throw new Error('SEEKWING_DSH_COMMAND must be an absolute executable path.');
  const commandArgs: unknown = JSON.parse(env.SEEKWING_DSH_ARGS || '[]');
  if (!Array.isArray(commandArgs) || !commandArgs.every((arg) => typeof arg === 'string')) throw new Error('SEEKWING_DSH_ARGS must be a JSON array of strings.');
  const maxConcurrent = Number(env.SEEKWING_MAX_CONCURRENT || 2);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('SEEKWING_MAX_CONCURRENT must be 1–8.');
  const sessionMode = env.SEEKWING_SESSION_MODE || 'background';
  if (sessionMode !== 'background' && sessionMode !== 'desktop') throw new Error('SEEKWING_SESSION_MODE must be background or desktop.');
  return {
    command, commandArgs, stateDir,
    harnessHome: path.resolve(env.SEEKWING_DSH_HOME || path.join(stateDir, 'harness')),
    desktopEndpoint: path.resolve(env.SEEKWING_DESKTOP_ENDPOINT || path.join(stateDir, 'desktop', 'endpoint.json')),
    sessionMode,
    provider: env.SEEKWING_PROVIDER || 'deepseek-official',
    model: env.SEEKWING_MODEL || 'deepseek-flash',
    allowedRoots: (env.SEEKWING_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean),
    maxConcurrent, startupTimeoutMs: 30_000, cancelGraceMs: 5_000,
    env: { ...env }, redact: redactor(env),
  };
}

export async function workspacePath(config: Config, value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error('workspace must be an absolute directory path.');
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isDirectory()) throw new Error('workspace must be a directory.');
  if (config.allowedRoots.length) {
    const roots = await Promise.all(config.allowedRoots.map((root) => realpath(root)));
    if (!roots.some((root) => { const relative = path.relative(root, resolved); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); })) {
      throw new Error('workspace is outside SEEKWING_ALLOWED_ROOTS.');
    }
  }
  return resolved;
}

export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
