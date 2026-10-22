import { backendDoctor } from './backends.js';
import { loadConfig, redactor, VERSION, type Backend, type SessionMode } from './config.js';
import { serve } from './mcp.js';
import { desktopDoctor } from './desktop-client.js';
import { installDesktop } from './desktop-install.js';

const [command = '--help', ...extra] = process.argv.slice(2);
try {
  if (['--version', '-v', 'version'].includes(command)) process.stdout.write(`seekwing ${VERSION}\n`);
  else if (['--help', '-h', 'help'].includes(command)) process.stdout.write(`SeekWing ${VERSION} — DeepSeek and Grok subagents for Codex\n\nUsage:\n  seekwing mcp       Serve MCP over stdio (stdout is protocol-only)\n  seekwing doctor [--backend deepseek|grok] [--session-mode background|desktop]\n  seekwing desktop-install  Install the native Desktop companion\n  seekwing desktop-doctor   Verify its authenticated loopback handshake\n  seekwing --version\n\nRequires Node.js >=22 and the official CLI for the selected backend.\nConfigure SEEKWING_DSH_COMMAND, SEEKWING_DSH_HOME, SEEKWING_STATE_DIR,\nSEEKWING_PROVIDER, SEEKWING_MODEL and DEEPSEEK_API_KEY for DeepSeek.\nFor Grok: SEEKWING_GROK_COMMAND, SEEKWING_GROK_HOME, SEEKWING_GROK_MODEL.\nRun grok login first. SEEKWING_BACKEND defaults to deepseek.\nSee https://github.com/heyzeyu/seekwing for setup and permissions.\n`);
  else {
    if ((!['doctor'].includes(command) && extra.length) || !['mcp', 'doctor', 'desktop-doctor', 'desktop-install'].includes(command)) throw new Error('Unknown command or unexpected arguments. Run seekwing --help.');
    const config = await loadConfig();
    let backend: Backend = config.backend;
    let sessionMode: SessionMode | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < extra.length; i += 2) {
      const flag = extra[i], value = extra[i + 1];
      if (seen.has(flag)) throw new Error('Duplicate doctor flag: ' + flag);
      seen.add(flag);
      if (flag === '--backend' && (value === 'deepseek' || value === 'grok')) backend = value;
      else if (flag === '--session-mode' && (value === 'background' || value === 'desktop')) sessionMode = value;
      else throw new Error('Unknown doctor option. Use --backend deepseek|grok or --session-mode background|desktop.');
    }
    if (command === 'desktop-install') process.stdout.write(config.redact(JSON.stringify(await installDesktop(config), null, 2)) + '\n');
    else if (command === 'desktop-doctor') process.stdout.write(config.redact(JSON.stringify(await desktopDoctor(config), null, 2)) + '\n');
    else if (command === 'doctor') process.stdout.write(config.redact(JSON.stringify(await backendDoctor(config, backend, sessionMode), null, 2)) + '\n');
    else await serve(config);
  }
} catch (error) {
  process.stderr.write(redactor(process.env)(`SeekWing: ${String(error)}\n`));
  process.exitCode = 1;
}
