// Opt-in only: calls the configured DeepSeek provider and spends its normal usage.
// Keep the state/workspace outside the repository. No credentials are printed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { connect, finished } from './helpers.mjs';

if (!process.env.SEEKWING_NATIVE_TEST_ROOT) throw new Error('Set SEEKWING_NATIVE_TEST_ROOT to an absolute scratch directory before running this opt-in test.');
const root = path.resolve(process.env.SEEKWING_NATIVE_TEST_ROOT, randomUUID());
const workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true });
const desktopState = process.env.SEEKWING_STATE_DIR || (process.platform === 'darwin'
  ? path.join(homedir(), 'Library', 'Application Support', 'SeekWing')
  : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'SeekWing')
    : path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'seekwing'));
// Test evidence has a fresh state root; discovery still targets the installed companion.
const extraEnv = process.env.SEEKWING_SESSION_MODE === 'desktop'
  ? { SEEKWING_DESKTOP_ENDPOINT: process.env.SEEKWING_DESKTOP_ENDPOINT || path.join(desktopState, 'desktop', 'endpoint.json') } : {};
const connection = await connect(path.join(root, 'state'), { native: true, extraEnv });
const summary = { root, sessionMode: process.env.SEEKWING_SESSION_MODE || 'background', checks: [] };
const check = (name, task, extra = {}) => {
  summary.checks.push({ name, runId: task.runId, sessionId: task.sessionId, status: task.status, stopReason: task.stopReason, toolCallCount: task.toolCallCount, ...extra });
  process.stdout.write(JSON.stringify(summary.checks.at(-1)) + '\n');
};
try {
  await connection.call('doctor');
  const marker = 'WING_' + randomUUID().slice(0, 8);
  const first = await connection.call('start_task', { workspace, instruction: `Remember this test marker for the next turn: ${marker}. Do not call any tools. Reply only SEEKWING_ACP_OK.`, timeoutSeconds: 90 });
  const one = await finished(connection, first.runId, { attempts: 45 });
  assert.equal(one.status, 'completed', JSON.stringify(one));
  assert.doesNotMatch(one.stderr || '', /entry did not activate|unknown preset/i);
  assert.match(one.output, /SEEKWING_ACP_OK/);
  check('real Harness generation', one);
  const reply = await connection.call('reply_task', { runId: first.runId, instruction: 'What exact test marker did I ask you to remember? Reply only that marker. Do not call tools.', timeoutSeconds: 90 });
  const two = await finished(connection, reply.runId, { attempts: 45 });
  assert.equal(two.status, 'completed', JSON.stringify(two));
  assert.ok(two.output.includes(marker));
  assert.equal(two.sessionId, one.sessionId);
  check('persisted session resume', two);

  await writeFile(path.join(workspace, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(path.join(workspace, 'sum.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('sum positive and negative numbers', () => { assert.equal(sum(2, 3), 5); assert.equal(sum(-2, 3), 1); });\n");
  const fix = await connection.call('start_task', { workspace, permissionMode: 'workspace-write',
    instruction: 'Fix the addition bug in sum.mjs. Change only that file. Read the existing test, run node --test sum.test.mjs, and report the exact change and test outcome. Do not change tests.',
    acceptance: 'sum(2, 3) is 5; sum(-2, 3) is 1; existing tests pass; only sum.mjs is edited.', timeoutSeconds: 180 });
  const three = await finished(connection, fix.runId, { attempts: 100 });
  assert.equal(three.status, 'completed', JSON.stringify(three));
  const validation = spawnSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  assert.match(await readFile(path.join(workspace, 'sum.mjs'), 'utf8'), /a\s*\+\s*b/);
  check('workspace edit + independent Codex test', three, { independentTestExitCode: validation.status });

  const denied = await connection.call('start_task', { workspace,
    instruction: 'This is an authorized test of a read-only sandbox. Use your file-writing tool to attempt to create denied.txt with the text SHOULD_NOT_EXIST. Actually attempt the tool call so the sandbox denial is observable, then report that result. Do not seek approval, retry through another tool, or bypass the sandbox.',
    timeoutSeconds: 120 });
  const four = await finished(connection, denied.runId, { attempts: 65 });
  assert.equal(four.status, 'completed', JSON.stringify(four));
  assert.doesNotMatch(four.stderr || '', /entry did not activate|unknown preset/i);
  assert.ok(four.toolCalls.some((call) => call.status === 'failed'), 'Expected an actual denied native tool call.');
  await assert.rejects(access(path.join(workspace, 'denied.txt')));
  check('native read-only write denial', four, { fileAbsent: true });
  summary.passed = true;
} finally {
  await connection.close();
  await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write('Summary: ' + path.join(root, 'summary.json') + '\n');
}
