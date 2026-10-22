import { requireCommand, type Config } from './config.js';

/** Adapter contracts, not claims about model quality or every tool in the native runtime. */
export async function backendCapabilities(config: Config) {
  return Promise.all((['deepseek', 'grok'] as const).map(async backend => {
    let commandAvailable = true;
    let setupError: string | undefined;
    try { await requireCommand(config, backend); } catch (error) { commandAvailable = false; setupError = config.redact(String(error)); }
    const grok = backend === 'grok';
    return {
      backend, default: config.backend === backend, commandAvailable, setupError,
      availabilityMeaning: 'Executable discovery only. Use doctor for handshake; login and generation require a task. Desktop companion readiness is separate.',
      sessionModes: grok ? ['background'] : ['background', 'desktop'],
      permissionModes: ['read-only', 'workspace-write'],
      promptContentTypes: ['text'], imageInput: false, audioInput: false,
      modelSelection: 'inspect_models returns exact model and reasoning values for this backend/mode',
      resume: true, cancel: true, durableRuns: true,
      permissionUI: grok ? { background: 'SeekWing pendingPermissions' }
        : { background: 'SeekWing pendingPermissions', desktop: 'DeepSeek Harness approval/question UI' },
      nativeVisibility: grok ? { liveAttachment: false, history: 'Native Grok history; resume a finished session in its workspace with grok --resume <sessionId>' }
        : { liveAttachment: 'desktop mode through companion', history: 'background uses a separate Harness home; desktop uses native history' },
      sandbox: grok ? { platforms: ['darwin', 'linux'], verification: 'Native session sandbox profile, workspace and session ID checked before prompt' }
        : { verification: 'Background policy overlay; Desktop companion permission preset' },
      nativeTools: 'Owned by the runtime and its configuration. Web/X search, native plugins and subagents are not separately exposed or guaranteed by this adapter.',
      limitations: ['Local workspaces only; no implicit remote routing', 'Completion requires independent Codex review',
        ...(grok ? ['No live connection to an already open Grok TUI'] : ['Desktop needs the companion; explicit model selection may update the native default'])],
    };
  }));
}
