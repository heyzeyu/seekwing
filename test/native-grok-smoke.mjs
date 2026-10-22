// Opt-in integration test. Uses the real Grok login and consumes normal usage.
// It authorizes only edits to generated sum.mjs and the exact local test command.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect } from './helpers.mjs';

if (!process.env.SEEKWING_NATIVE_TEST_ROOT || !path.isAbsolute(process.env.SEEKWING_NATIVE_TEST_ROOT)) throw new Error('Set SEEKWING_NATIVE_TEST_ROOT to an absolute scratch directory.');
const root = path.join(process.env.SEEKWING_NATIVE_TEST_ROOT, randomUUID());
const workspace = path.join(root, 'workspace'), state = path.join(root, 'state');
await mkdir(workspace, { recursive: true });
const selection = { modelValue: process.env.SEEKWING_NATIVE_MODEL_VALUE || 'grok-4.7-build-fast', reasoningEffort: 'low' };
let c = await connect(state, { native: true, extraEnv: { SEEKWING_BACKEND: 'grok' } });
const summary = { backend: 'grok', root, selection, checks: [] };
const terminal = task => ['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(task.status);
async function finish(run, edits = false) {
  for (let i = 0; i < 80; i++) {
    const task = await c.call('wait_task', { runId: run.runId, seconds: 3 });
    if (terminal(task)) return task;
    for (const permission of task.pendingPermissions) {
      const call = permission.toolCall, raw = call.rawInput || {};
      const editPath = raw.file_path ?? raw.filePath ?? raw.path;
      const command = raw.command ?? raw.cmd;
      const paths = [editPath, ...(call.locations || []).map(l => l.path), ...(call.content || []).filter(c => c.type === 'diff').map(c => c.path)].filter(Boolean);
      const authorizedEdit = edits && call.kind === 'edit' && paths.length > 0 && paths.every(p => path.resolve(workspace, p) === path.join(workspace, 'sum.mjs'));
      const authorizedTest = edits && ['node --test sum.test.mjs', 'node --test ./sum.test.mjs'].includes(command) && (!raw.cwd || raw.cwd === workspace);
      const allow = authorizedEdit || authorizedTest;
      const option = permission.options.find(o => o.kind === (allow ? 'allow_once' : 'reject_once'));
      assert.ok(option, 'Expected a one-shot permission option');
      process.stdout.write(JSON.stringify({ permission: call.title, kind: call.kind, paths, command, decision: option.kind }) + '\n');
      await c.call('respond_to_permission', { runId: run.runId, permissionId: permission.id, optionId: option.optionId });
    }
  }
  throw new Error('Native test exceeded its wait budget');
}
function record(name, task, extra = {}) {
  assert.equal(task.cleanupError, undefined, task.cleanupError);
  assert.equal(task.persistenceError, undefined);
  assert.equal(task.backend, 'grok');
  assert.equal(task.modelValue, selection.modelValue);
  assert.equal(task.reasoningEffort, selection.reasoningEffort);
  const entry = { name, runId: task.runId, sessionId: task.sessionId, status: task.status, stopReason: task.stopReason,
    toolCallCount: task.toolCallCount, permissionDecisions: task.permissionDecisions.length, ...extra };
  summary.checks.push(entry); process.stdout.write(JSON.stringify(entry) + '\n');
}
const start = input => c.call('start_task', { backend: 'grok', workspace, ...selection, timeoutSeconds: 180, ...input });
try {
  const marker = 'WING_' + randomUUID().slice(0, 8);
  const first = await start({ instruction: `Remember ${marker} for a later turn. Reply only GROK_ACP_OK. Do not call tools.` });
  const one = await finish(first);
  assert.equal(one.status, 'completed', JSON.stringify(one));
  assert.match(one.output, /GROK_ACP_OK/); record('real generation', one);
  await c.close();
  // Deliberately change the default runtime: persisted replies must still use Grok.
  c = await connect(state, { native: true, extraEnv: { SEEKWING_BACKEND: 'deepseek' } });
  const follow = await c.call('reply_task', { runId: first.runId, instruction: 'Reply only with the exact WING_ marker I asked you to remember. Do not call tools.' });
  const two = await finish(follow);
  assert.equal(two.status, 'completed', JSON.stringify(two));
  assert.ok(two.output.includes(marker)); assert.equal(two.sessionId, one.sessionId); record('resume after MCP restart', two);

  await writeFile(path.join(workspace, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  const testSource = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('sum', () => { assert.equal(sum(2,3),5); assert.equal(sum(-2,3),1); });\n";
  await writeFile(path.join(workspace, 'sum.test.mjs'), testSource);
  const fix = await start({ permissionMode: 'workspace-write', instruction: 'Fix the addition bug in sum.mjs. Edit only sum.mjs using your file editing tool. Read the existing test and run exactly node --test sum.test.mjs in the current working directory. Do not edit tests. Report the change and test result.', acceptance: 'Both existing test assertions pass; sum.test.mjs is unchanged.' });
  const three = await finish(fix, true);
  assert.equal(three.status, 'completed', JSON.stringify(three));
  assert.equal(await readFile(path.join(workspace, 'sum.test.mjs'), 'utf8'), testSource);
  const verification = spawnSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(verification.status, 0, verification.stdout + verification.stderr);
  record('workspace edit and independent test', three, { independentTestExitCode: verification.status });

  const denied = await start({ instruction: 'This is a test of the read-only boundary. Attempt exactly once to create denied.txt containing SHOULD_NOT_EXIST using your file writing tool, then report the denial. Do not bypass the policy, retry, or ask for escalation.' });
  const four = await finish(denied);
  assert.equal(four.status, 'completed', JSON.stringify(four));
  await assert.rejects(access(path.join(workspace, 'denied.txt')));
  assert.ok(four.toolCalls.some(call => call.status === 'failed') || four.permissionDecisions.length > 0, 'Must observe a denied tool attempt, not just an assistant promise');
  record('read-only write denied', four, { fileAbsent: true });

  const long = await start({ instruction: 'Read sum.mjs, then use your terminal tool to run exactly sleep 30. This task is for cancellation testing. Do not modify any files.' });
  let active;
  for (let i = 0; i < 30; i++) {
    active = await c.call('wait_task', { runId: long.runId, seconds: 1 });
    if (active.pendingPermissions.length || active.toolCallCount || terminal(active)) break;
  }
  assert.ok(!terminal(active), 'The cancellation test must observe an active turn');
  const observer = await connect(state, { native: true });
  try { await observer.call('cancel_task', { runId: long.runId }); } finally { await observer.close(); }
  const five = await finish(long);
  assert.equal(five.status, 'cancelled', JSON.stringify(five)); record('cross-process native cancellation', five);
  summary.passed = true;
} finally {
  await c.close();
  await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write('Summary: ' + path.join(root, 'summary.json') + '\n');
}
