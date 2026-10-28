import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const VERSION = '0.4.4';
export type Backend = 'deepseek' | 'grok';
export type PermissionMode = 'read-only' | 'workspace-write';
export type SessionMode = 'background' | 'desktop';
export interface Config {
  backend: Backend;
  command: string;
  commandArgs: string[];
  grokCommand: string;
  grokArgs: string[];
  grokHome: string;
  grokModel?: string;
  commandErrors: Partial<Record<Backend, string>>;
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
  const values = Object.entries(env)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE)/i.test(key) && value && value.length >= 8)
    .map(([, value]) => value!);
  // Cover raw strings, serialized task records and native tool evidence embedded as JSON text.
  const secrets = [...new Set(values.flatMap(value => {
    const variants = [value];
    for (let i = 0; i < 2; i++) { value = JSON.stringify(value).slice(1, -1); variants.push(value); }
    return variants;
  }))].sort((a, b) => b.length - a.length);
  return (value) => {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})\b/gi, '[REDACTED]');
  };
}

async function executable(file: string): Promise<boolean> {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; }
}

async function discoverCommand(explicit: string | undefined, preferred: string[], name: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (explicit) return explicit;
  for (const candidate of [...preferred, ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, name))]) {
    if (await executable(candidate)) return candidate;
  }
  return '';
}

export async function requireCommand(config: Config, backend: Backend): Promise<void> {
  if (config.commandErrors[backend]) throw new Error(config.commandErrors[backend]);
  const command = backend === 'grok' ? config.grokCommand : config.command;
  const name = backend === 'grok' ? 'SEEKWING_GROK_COMMAND' : 'SEEKWING_DSH_COMMAND';
  if (!command) throw new Error(`${backend === 'grok' ? 'Official Grok CLI' : 'Official DeepSeek Harness CLI'} not found. Install it or set ${name} to its executable.`);
  if (!path.isAbsolute(command) || !await executable(command)) throw new Error(`${name} must be an absolute executable path.`);
}

export function sessionModeFor(config: Config, backend: Backend, explicit?: SessionMode): SessionMode {
  // A DeepSeek Desktop preference must not redirect an explicitly selected Grok task.
  const mode = explicit ?? (backend === 'grok' ? 'background' : config.sessionMode);
  if (backend === 'grok' && mode === 'desktop') throw new Error('Grok supports background ACP sessions only. Its native persisted history can be resumed in Grok; live Desktop attachment is not supported.');
  return mode;
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
  const command = await discoverCommand(env.SEEKWING_DSH_COMMAND, process.platform === 'darwin' ? [desktop] : [], process.platform === 'win32' ? 'dsh.exe' : 'dsh', env);
  const grokHome = path.resolve(env.SEEKWING_GROK_HOME || env.GROK_HOME || path.join(homedir(), '.grok'));
  const grokCommand = await discoverCommand(env.SEEKWING_GROK_COMMAND, [path.join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')], process.platform === 'win32' ? 'grok.exe' : 'grok', env);
  const commandErrors: Config['commandErrors'] = {};
  const args = (key: string, backend: Backend): string[] => {
    try {
      const value: unknown = JSON.parse(env[key] || '[]');
      if (!Array.isArray(value) || !value.every(arg => typeof arg === 'string')) throw new Error();
      return value;
    } catch { commandErrors[backend] = `${key} must be a JSON array of strings.`; return []; }
  };
  const commandArgs = args('SEEKWING_DSH_ARGS', 'deepseek');
  const grokArgs = args('SEEKWING_GROK_ARGS', 'grok');
  const backend = env.SEEKWING_BACKEND || 'deepseek';
  if (backend !== 'deepseek' && backend !== 'grok') throw new Error('SEEKWING_BACKEND must be deepseek or grok.');
  const maxConcurrent = Number(env.SEEKWING_MAX_CONCURRENT || 2);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('SEEKWING_MAX_CONCURRENT must be 1–8.');
  const sessionMode = env.SEEKWING_SESSION_MODE || 'background';
  if (sessionMode !== 'background' && sessionMode !== 'desktop') throw new Error('SEEKWING_SESSION_MODE must be background or desktop.');
  return {
    backend, command, commandArgs, grokCommand, grokArgs, grokHome, grokModel: env.SEEKWING_GROK_MODEL || undefined, commandErrors, stateDir,
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
