import { doctor } from './acp.js';
import { loadConfig, redactor, VERSION } from './config.js';
import { serve } from './mcp.js';

const [command = '--help', ...extra] = process.argv.slice(2);
try {
  if (['--version', '-v', 'version'].includes(command)) process.stdout.write(`seekwing ${VERSION}\n`);
  else if (['--help', '-h', 'help'].includes(command)) process.stdout.write(`SeekWing ${VERSION} — DeepSeek subagents for Codex\n\nUsage:\n  seekwing mcp       Serve MCP over stdio (stdout is protocol-only)\n  seekwing doctor    Verify the local official Harness ACP handshake\n  seekwing --version\n\nRequires Node.js >=22 and an installed official DeepSeek Harness CLI.\nConfigure SEEKWING_DSH_COMMAND, SEEKWING_DSH_HOME, SEEKWING_STATE_DIR,\nSEEKWING_PROVIDER, SEEKWING_MODEL and DEEPSEEK_API_KEY as needed.\nSee https://github.com/heyzeyu/seekwing for setup and permissions.\n`);
  else {
    if (extra.length || !['mcp', 'doctor'].includes(command)) throw new Error('Unknown command or unexpected arguments. Run seekwing --help.');
    const config = await loadConfig();
    if (command === 'doctor') process.stdout.write(config.redact(JSON.stringify(await doctor(config), null, 2)) + '\n');
    else await serve(config);
  }
} catch (error) {
  process.stderr.write(redactor(process.env)(`SeekWing: ${String(error)}\n`));
  process.exitCode = 1;
}
