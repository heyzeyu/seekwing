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
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Publish a complete record atomically; contenders never observe an empty owner file.
          await link(temp, file);
          return async () => {
            const current = await readFile(file, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return undefined; });
            // Recovery only removes dead owners, so this live owner cannot be replaced during release.
            if (current === content) await unlink(file);
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const observed = await readFile(file, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return undefined; });
        if (observed === undefined) continue;
        const old = JSON.parse(observed);
        if (!Number.isSafeInteger(old.ownerPid) || old.ownerPid <= 0) throw new Error('Invalid session lock owner. Inspect the lock before recovery.');
        if (pidAlive(old.ownerPid)) throw new Error('This Harness session already has an active turn.');
        // Serialize reclamation and re-read after admission. A stale snapshot must never unlink a fresh owner.
        const recoveryFile = file + '.recovery';
        const guard = await open(recoveryFile, 'wx', 0o600).catch((error) => {
          if (error.code === 'EEXIST') throw new Error(`Session lock recovery is already in progress. If its process exited, inspect ${recoveryFile} before removing that recovery marker.`);
          throw error;
        });
        try {
          await guard.writeFile(JSON.stringify({ ownerPid: process.pid, runId }));
          const current = await readFile(file, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return undefined; });
          if (current === observed) await unlink(file);
        } finally {
          await guard.close();
          await unlink(recoveryFile);
        }
      }
      throw new Error('Could not acquire the Harness session lock.');
    } finally { await unlink(temp).catch(() => {}); }
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
