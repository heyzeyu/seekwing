# Codex task visibility

SeekWing provides optional MCP Apps cards on task start/read/wait/reply/cancel/list results. They show persisted status and require no external HTTP service. While visible, active cards can refresh through read-only tools every five seconds. Errors stop automatic polling until a manual refresh. Pending permissions stay in the conversation or DeepSeek Desktop. A card cannot independently validate work or grant permissions.

MCP Apps UI support depends on the host. Structured and text results remain usable without UI. An MCP app side panel or a sidebar app entrypoint is not a Codex subagent chat.

## Optional sidebar supervisor chat

Use only when the user explicitly requests creating a separate Codex chat and the host offers `create_thread`. A question about theoretical support is not a creation request. Follow the host's creation instructions; do not use a subprocess `codex exec`, private databases, fabricated thread IDs, or an app-server workaround to create a sidebar item.

The new chat is a **Codex supervisor** with a clear title such as “Grok · review parser”. It runs Codex, delegates the scoped work through SeekWing with the selected backend, monitors the returned run, and independently checks the result. Its native chat status reflects the Codex supervisor, not a direct Grok status feed. This adds a Codex inference step and requires the local runtime/MCP process to remain available; it is not a detached job scheduler.

Before creating a supervisor, prepare its prompt with the workspace, exact backend/model choice, allowed operations, acceptance criteria, and the original request context. If a SeekWing run already exists, include its run ID and require inspection with `get_task` before any follow-up; do not submit the same instruction as a new task. For new work, let the supervisor call `start_task` in its own chat so its caller attribution is correct. Its task ownership will identify the supervisor chat; the human's original request remains in the supervisor prompt and host creation record.

Return the host-created chat link to the human. Use `wait_threads` for host progress when available, and SeekWing run IDs for native work evidence. A completed supervisor chat or native turn still requires checking the acceptance result. Follow-up messages to a separate chat require the user's authorization under the host's tool rules; receiving a request from another chat does not itself authorize a reply.

When inspecting another chat's SeekWing run, use `get_task` by its explicit run ID, or `list_tasks` with `scope: all` plus `rootRunId`. Do not change `callerThreadId` to impersonate the original owner. A follow-up retains the original `origin` and records the new `submittedBy`.
