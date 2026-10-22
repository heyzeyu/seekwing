import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const repo = fileURLToPath(new URL('../', import.meta.url));
export async function connect(stateDir, { native = false, extraEnv = {}, serverCwd = repo } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'dist/seekwing.mjs'), 'mcp'], cwd: serverCwd,
    env: { ...env, SEEKWING_STATE_DIR: stateDir,
      ...(!native ? { SEEKWING_DSH_COMMAND: process.execPath, SEEKWING_DSH_ARGS: JSON.stringify([path.join(repo, 'test/fake-acp.mjs')]), TEST_API_KEY: 'fake-sensitive-value-123456789' } : {}), ...extraEnv }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'seekwing-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr,
    call: async (name, args = {}, { allowError = false, meta } = {}) => {
      const response = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: 55_000 });
      if (response.isError && !allowError) throw new Error(JSON.stringify(response.content));
      return response.isError ? response : response.structuredContent ?? JSON.parse(response.content[0].text);
    }, close: () => client.close() };
}

export async function finished(connection, runId, { permissions = 'reject', attempts = 12 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const task = await connection.call('wait_task', { runId, seconds: 2 });
    if (task.status === 'needs_attention') {
      for (const permission of task.pendingPermissions) {
        const option = permission.options.find((item) => item.kind === (permissions === 'allow' ? 'allow_once' : 'reject_once'));
        await connection.call('respond_to_permission', { runId, permissionId: permission.id, optionId: option.optionId });
      }
      continue;
    }
    if (['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task;
  }
  throw new Error('Task did not finish within the test deadline: ' + runId);
}
