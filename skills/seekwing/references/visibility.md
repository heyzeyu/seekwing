# Codex task visibility

SeekWing provides optional MCP Apps cards on task start/read/wait/reply/cancel/list results. They show persisted status and require no external HTTP service. While visible, active cards can refresh through read-only tools every second. Errors stop automatic polling until a manual refresh. Pending permissions stay in the conversation or DeepSeek Desktop. A card cannot independently validate work or grant permissions.

MCP Apps UI support depends on the host. Structured and text results remain usable without UI. An MCP app side panel or a sidebar app entrypoint is not a Codex subagent chat.

## Optional sidebar supervisor chat

Use only when the user explicitly requests creating a separate Codex chat and the host offers `create_thread`. A question about theoretical support is not a creation request. Follow the host's creation instructions; do not use a subprocess `codex exec`, private databases, fabricated thread IDs, or an app-server workaround to create a sidebar item.

The new chat is a **Codex supervisor** with a clear title such as “Grok · review parser”. It runs Codex, delegates the scoped work through SeekWing with the selected backend, monitors the returned run, and independently checks the result. Its native chat status reflects the Codex supervisor, not a direct Grok status feed. This adds a Codex inference step and requires the local runtime/MCP process to remain available; it is not a detached job scheduler.

Before creating a supervisor, prepare its prompt with the workspace, exact backend/model choice, allowed operations, acceptance criteria, and the original request context. If a SeekWing run already exists, include its run ID and require inspection with `get_task` before any follow-up; do not submit the same instruction as a new task. For new work, let the supervisor call `start_task` in its own chat so its caller attribution is correct. Its task ownership will identify the supervisor chat; the human's original request remains in the supervisor prompt and host creation record.

Return the host-created chat link to the human. Use `wait_threads` for host progress when available, and SeekWing run IDs for native work evidence. A completed supervisor chat or native turn still requires checking the acceptance result. Follow-up messages to a separate chat require the user's authorization under the host's tool rules; receiving a request from another chat does not itself authorize a reply.

When inspecting another chat's SeekWing run, use `get_task` by its explicit run ID, or `list_tasks` with `scope: all` plus `rootRunId`. Do not change `callerThreadId` to impersonate the original owner. A follow-up retains the original `origin` and records the new `submittedBy`.

In v0.4.1, cards bind from `ui/notifications/tool-input` before a waiting tool returns, and accept structured/text results and preloaded host globals. `get_task(outputTail: true)` follows the latest window after output exceeds a page. The manual run selector and refresh/current-chat fallback avoid an endless unbound loading state. UI calls remain read-only; no extra model inference is used for refreshing. The versioned resource URI avoids reusing the old cached card.

In v0.4.2, public replies remain visible while commands, tool status and text results are shown in an expanded live execution log. Tool results update in place; raw JSON remains optional evidence. Only emitted public content is shown. A background launch tool returning does not necessarily mean its process has exited. Recent tool storage rolls over after 100 entries so long tasks keep showing new results.
