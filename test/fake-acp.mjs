// A wire-level fixture, deliberately independent of the ACP SDK implementation.
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, result) => send({ id, result });
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const options = [{ id: 'model', name: 'Model', type: 'select', currentValue: '["deepseek-official","fake"]', options: [{ value: '["deepseek-official","fake"]', name: 'Fake' }] }];
const patch = JSON.parse(await readFile(process.argv[process.argv.indexOf('--patch') + 1], 'utf8'));
const permissionConfig = patch.find((entry) => entry.id === 'permission')?.config || {};
// Model the upstream config boundary that caused a real activation failure:
// overlays replace config, and the native fallback catalog has no read-only preset.
const presets = permissionConfig.presets || {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};
let sessionId;
let prompt;
let permission;
let hanging = false;
let completeOnCancel = false;
const finish = (stopReason = 'end_turn') => { if (prompt) result(prompt.id, { stopReason }); prompt = undefined; };
const lines = createInterface({ input: process.stdin });
process.stdin.on('end', () => process.exit(0));

lines.on('line', async (line) => {
  try {
    const message = JSON.parse(line);
    if (message.id === 'permission' && !message.method) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result) } });
      permission = undefined;
      finish();
      return;
    }
    switch (message.method) {
      case 'initialize':
        if (process.env.SEEKWING_FIXTURE_WARNING) process.stderr.write(`fixture startup warning ${process.env.TEST_API_KEY}\n`);
        if (!presets[permissionConfig.defaultPreset]) {
          send({ id: message.id, error: { code: -32603, message: 'permission: unknown default preset' } }); break;
        }
        result(message.id, { protocolVersion: Number(process.env.SEEKWING_FIXTURE_PROTOCOL || 1), agentInfo: { name: 'deepseek-harness-acp', version: 'fixture' }, agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } }, authMethods: [] }); break;
      case 'session/new':
        sessionId = randomUUID();
        await writeFile(path.join(process.env.DSH_HOME, sessionId + '.json'), JSON.stringify({ turns: 0 }));
        result(message.id, { sessionId, configOptions: options }); break;
      case 'session/resume':
        sessionId = message.params.sessionId;
        await readFile(path.join(process.env.DSH_HOME, sessionId + '.json'), 'utf8');
        result(message.id, { configOptions: options }); break;
      case 'session/set_config_option':
        if (message.params.value === 'invalid') send({ id: message.id, error: { code: -32602, message: 'Unknown model option' } });
        else result(message.id, { configOptions: options });
        break;
      case 'session/prompt': {
        prompt = message;
        const text = message.params.prompt[0].text;
        hanging = text.includes('HANG');
        completeOnCancel = text.includes('COMPLETE_ON_CANCEL');
        const stateFile = path.join(process.env.DSH_HOME, sessionId + '.json');
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        state.turns++;
        await writeFile(stateFile, JSON.stringify(state));
        update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_THOUGHT_DO_NOT_RETAIN' } });
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'fixture-check', status: 'in_progress', rawInput: { mode: process.env.DSH_PERMISSION_MODE } });
        if (text.includes('PERMISSION')) {
          permission = 'permission';
          send({ id: permission, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-1' }, options: [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
          ] } });
          break;
        }
        if (text.includes('ERROR')) { send({ id: message.id, error: { code: -32603, message: 'fixture failure ' + process.env.TEST_API_KEY } }); prompt = undefined; break; }
        if (text.includes('SLOW') || hanging) {
          update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } }); break;
        }
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [] });
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.includes('LONG') ? 'x'.repeat(110_000) : `TURN_${state.turns} ${process.env.DSH_PERMISSION_MODE} ${process.env.TEST_API_KEY || ''}` } });
        finish(text.includes('MAX_TOKENS') ? 'max_tokens' : 'end_turn');
        break;
      }
      case 'session/cancel': if (!hanging) finish(completeOnCancel ? 'end_turn' : 'cancelled'); break;
      case 'session/close': if (!hanging) { finish('cancelled'); result(message.id, {}); } break;
    }
  } catch (error) { process.stderr.write(String(error) + '\n'); }
});
