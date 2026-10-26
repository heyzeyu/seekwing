// Wire fixture for the released Grok ACP dialect, independent of the ACP SDK.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const home = process.env.GROK_HOME;
await mkdir(home, { recursive: true });
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const fail = (id, message) => send({ id, error: { code: -32602, message } });
const options = () => [
  { id: 'model', name: 'Model', type: 'select', currentValue: state.model, options: [{ value: 'grok-test', name: 'Test' }, { value: 'grok-other', name: 'Other' }] },
  { id: 'reasoning_effort', name: 'Reasoning Effort', type: 'select', currentValue: state.effort, options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] },
];
let authenticated = false, sessionId, state, prompt, permission, hanging = false;
const file = () => path.join(home, sessionId + '.json');
const save = () => writeFile(file(), JSON.stringify(state));
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const finish = reason => { if (prompt) result(prompt.id, { stopReason: reason }); prompt = undefined; };
process.stdin.on('end', () => process.exit(0));
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  try {
    if (process.env.SEEKWING_GROK_FIXTURE_TRACE) await appendFile(process.env.SEEKWING_GROK_FIXTURE_TRACE,
      JSON.stringify({ method: message.method, params: message.params, result: message.result, argv: process.argv.slice(2), sandbox: process.env.GROK_SANDBOX, autoBash: process.env.GROK_SANDBOX_AUTO_ALLOW_BASH }) + '\n');
    if (message.id === 'permission' && !message.method) {
      permission = undefined;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result) } });
      finish('end_turn'); return;
    }
    switch (message.method) {
      case 'initialize':
        result(message.id, { protocolVersion: Number(process.env.SEEKWING_GROK_FIXTURE_PROTOCOL || 1), agentInfo: null,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
          authMethods: (process.env.SEEKWING_GROK_FIXTURE_AUTH === 'interactive' ? ['grok.com']
            : process.env.SEEKWING_GROK_FIXTURE_AUTH === 'key' ? ['cached_token', 'xai.api_key'] : ['cached_token', 'grok.com']).map(id => ({ id, name: id })) }); break;
      case 'authenticate':
        if (process.env.SEEKWING_GROK_FIXTURE_AUTH === 'fail') { fail(message.id, 'Run grok login; ' + process.env.XAI_API_KEY); break; }
        authenticated = true; result(message.id, {}); break;
      case 'session/new':
      case 'session/resume': {
        if (!authenticated) { fail(message.id, 'authenticate before opening a session'); break; }
        if (message.params._meta?.yoloMode !== false || message.params._meta?.autoMode !== false) { fail(message.id, 'unsafe permission defaults'); break; }
        sessionId = message.params.sessionId || process.env.SEEKWING_GROK_FIXTURE_SESSION_ID || randomUUID();
        state = message.method === 'session/new' ? { turns: 0, cwd: message.params.cwd, model: 'grok-test', effort: 'high' } : JSON.parse(await readFile(file(), 'utf8'));
        await save();
        result(message.id, { ...(message.method === 'session/new' ? { sessionId } : {}), configOptions: options() }); break;
      }
      case '_x.ai/session/state':
        result(message.id, { summary: { info: { id: sessionId, cwd: process.env.SEEKWING_GROK_FIXTURE_BAD_CWD ? '/wrong/workspace' : state.cwd }, sandbox_profile: process.env.SEEKWING_GROK_FIXTURE_BAD_SANDBOX ? 'off' : process.env.GROK_SANDBOX } }); break;
      case 'session/set_config_option': {
        const { configId, value } = message.params;
        if (!options().find(o => o.id === configId)?.options.some(o => o.value === value)) { fail(message.id, 'Unknown model/reasoning option'); break; }
        if (!process.env.SEEKWING_GROK_FIXTURE_IGNORE_OPTION) state[configId === 'model' ? 'model' : 'effort'] = value;
        await save(); result(message.id, { configOptions: options() }); break;
      }
      case 'session/prompt': {
        prompt = message;
        const text = message.params.prompt[0].text;
        state.turns++; await save(); hanging = text.includes('HANG');
        update({ sessionUpdate: 'tool_call', toolCallId: 'grok-call', title: 'fixture', status: 'in_progress', rawInput: { cwd: state.cwd } });
        if (text.includes('PERMISSION')) {
          permission = 'permission';
          send({ id: permission, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'grok-call' }, options: [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          ] } }); break;
        }
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `GROK_TURN_${state.turns} ${state.model} ${state.effort}` } });
        if(text.includes('MANY_TOOLS'))for(let i=0;i<125;i++){
          update({sessionUpdate:'tool_call',toolCallId:'call-'+i,title:'call '+i,status:'completed',rawInput:{command:'echo '+i},content:[{type:'content',content:{type:'text',text:'result '+i}}]});
        }
        if (text.includes('SLOW') || hanging) break;
        finish(text.includes('MAX_TOKENS') ? 'max_tokens' : 'end_turn'); break;
      }
      case 'session/cancel': if (!hanging) finish('cancelled'); break;
      case 'session/close': if (!hanging) { finish('cancelled'); result(message.id, {}); } break;
      default: fail(message.id, 'Unknown method');
    }
  } catch (error) { fail(message.id, String(error)); }
});
