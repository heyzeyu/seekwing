import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { privateDir, type Config } from './config.js';
import { terminal, type Task } from './types.js';

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const validRunId = (value: string) => /^sw-[0-9a-f-]{36}$/.test(value);

export class Store {
  constructor(readonly config: Config) {}
  async init(): Promise<void> {
    await Promise.all(['runs', 'keys', 'locks', 'controls'].map((dir) => privateDir(path.join(this.config.stateDir, dir))));
  }
  runPath(runId: string): string {
    if (!validRunId(runId)) throw new Error('Invalid SeekWing run ID.');
    return path.join(this.config.stateDir, 'runs', runId + '.json');
  }
  async save(task: Task): Promise<void> {
    task.updatedAt = new Date().toISOString();
    const target = this.runPath(task.runId);
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, this.config.redact(JSON.stringify(task)), { mode: 0o600, flag: 'wx' });
      await rename(temp, target);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async get(runId: string): Promise<Task> {
    const task: Task = JSON.parse(await readFile(this.runPath(runId), 'utf8'));
    if (!terminal(task.status) && !pidAlive(task.ownerPid)) {
      // Read-side recovery never replays an instruction with uncertain admission.
      task.status = 'interrupted';
      task.pendingPermissions = [];
      task.error = 'The owning SeekWing process exited. Execution may have made changes; inspect the workspace before a follow-up.';
    }
    return task;
  }
  async list(limit: number): Promise<Task[]> {
    const files = (await readdir(path.join(this.config.stateDir, 'runs'))).filter((name) => /^sw-[0-9a-f-]{36}\.json$/.test(name));
    const tasks = await Promise.all(files.map((name) => this.get(name.slice(0, -5)).catch(() => undefined)));
    return tasks.filter((task): task is Task => !!task).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async claimKey(key: string, input: unknown, runId: string): Promise<string> {
    const target = path.join(this.config.stateDir, 'keys', digest(key) + '.json');
    const fingerprint = digest(JSON.stringify(input));
    const temp = target + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify({ fingerprint, runId }), { flag: 'wx', mode: 0o600 });
    try { await link(temp, target); return runId; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(target, 'utf8'));
      if (existing.fingerprint !== fingerprint) throw new Error('This idempotencyKey was already used with different task inputs.');
      return existing.runId;
    } finally { await unlink(temp).catch(() => {}); }
  }
  async findKey(key: string, input: unknown): Promise<string | undefined> {
    const file = path.join(this.config.stateDir, 'keys', digest(key) + '.json');
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'));
      if (existing.fingerprint !== digest(JSON.stringify(input))) throw new Error('This idempotencyKey was already used with different task inputs.');
      return existing.runId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async lockSession(sessionId: string, runId: string): Promise<() => Promise<void>> {
    const file = path.join(this.config.stateDir, 'locks', digest(sessionId) + '.json');
    const content = JSON.stringify({ ownerPid: process.pid, runId, token: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(content); } finally { await handle.close(); }
        return async () => { if (await readFile(file, 'utf8').catch(() => '') === content) await unlink(file); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const old = JSON.parse(await readFile(file, 'utf8'));
        if (pidAlive(old.ownerPid)) throw new Error('This Harness session already has an active turn.');
        await unlink(file).catch(() => {});
      }
    }
    throw new Error('Could not acquire the Harness session lock.');
  }
  async writeControl(runId: string, control: unknown): Promise<void> {
    this.runPath(runId);
    const file = path.join(this.config.stateDir, 'controls', `${runId}-${randomUUID()}.json`);
    await writeFile(file, this.config.redact(JSON.stringify(control)), { flag: 'wx', mode: 0o600 });
  }
  async takeControls(runId: string): Promise<unknown[]> {
    const dir = path.join(this.config.stateDir, 'controls');
    const files = (await readdir(dir)).filter((name) => name.startsWith(runId + '-') && name.endsWith('.json'));
    const controls: unknown[] = [];
    for (const file of files) {
      const target = path.join(dir, file);
      try { controls.push(JSON.parse(await readFile(target, 'utf8'))); } finally { await unlink(target).catch(() => {}); }
    }
    return controls;
  }
}
