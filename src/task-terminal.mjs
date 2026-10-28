export function commandText(call) {
  const value = call.rawInput?.command ?? call.rawInput?.cmd ?? call.rawInput?.argv;
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(String).join(' ') : '';
}

export function readableOutput(value) {
  let parsed = value;
  if (typeof value === 'string') try { parsed = JSON.parse(value); } catch { return value; }
  const result = parsed?.Result && typeof parsed.Result === 'object' ? parsed.Result : parsed;
  if (result && typeof result === 'object') {
    const text = ['stdout', 'stderr', 'output'].filter(key => typeof result[key] === 'string').map(key => result[key]);
    if (text.length) {
      if (typeof result.exit_code === 'number') text.push(`退出码：${result.exit_code}`);
      return text.join('\n');
    }
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function resultText(call) {
  const parts = [];
  for (const entry of Array.isArray(call.content) ? call.content : []) {
    const content = entry?.type === 'content' ? entry.content : entry;
    if (content?.type === 'text' && typeof content.text === 'string') parts.push(readableOutput(content.text));
    else if (entry?.type === 'diff') parts.push(`文件变更：${entry.path || ''}\n${entry.newText || ''}`);
  }
  return parts.length ? parts.join('\n') : call.rawOutput != null ? readableOutput(call.rawOutput) : '';
}

// A display of ACP-reported tool activity, not a PTY or a second executor.
// Keep DOM nodes stable: a native snapshot grows/updates its existing text node,
// rather than replaying old output or rebuilding the terminal on each read.
export function createTerminal(document) {
  const node = (tag, text, cls) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (cls) element.className = cls;
    return element;
  };
  const element = node('section', undefined, 'terminal');
  const bar = node('div', undefined, 'terminal-bar');
  const state = node('span'), follow = node('button');
  follow.type = 'button';
  const viewport = node('div', undefined, 'terminal-viewport');
  viewport.setAttribute('aria-label', '执行日志');viewport.tabIndex = 0;
  const empty = node('div', '等待 CLI 返回命令和输出…', 'terminal-empty');
  bar.append(state, follow);element.append(bar, viewport);viewport.append(empty);
  let following = true;
  const entries = new Map();
  const label = () => {
    follow.textContent = following ? '暂停跟随' : '跟随最新';
    follow.setAttribute('aria-pressed', String(following));
  };
  viewport.onscroll = () => {
    following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 40;
    label();
  };
  follow.onclick = () => {
    following = !following;label();
    if (following) viewport.scrollTop = viewport.scrollHeight;
  };
  label();
  return { element, update(task) {
    const status = { starting:'启动中', running:'执行中', needs_attention:'等待处理', cancelling:'取消中', completed:'已结束 · 待核验', incomplete:'未完成', failed:'失败', cancelled:'已取消', interrupted:'已中断' }[task.status] || task.status;
    state.textContent = `${task.backend === 'grok' ? 'Grok' : 'DeepSeek'} CLI · ${status}`;
    element.dataset.active = String(['starting','running','needs_attention','cancelling'].includes(task.status));
    const scroll = viewport.scrollTop;
    for (const call of Array.isArray(task.toolCalls) ? task.toolCalls : []) {
      if (!call.toolCallId) continue;
      let entry = entries.get(call.toolCallId);
      if (!entry) {
        empty.remove();
        const block = node('div', undefined, 'terminal-entry');block.dataset.toolCallId = call.toolCallId;
        const title = node('div', undefined, 'terminal-tool');
        const command = node('pre', undefined, 'terminal-command');
        const output = node('pre', undefined, 'terminal-output');
        block.append(title, command, output);viewport.append(block);
        entry = { block, title, command, output, call: {} };entries.set(call.toolCallId, entry);
      }
      entry.call = { ...entry.call, ...call };
      const value = entry.call;
      const status = { pending:'等待执行', in_progress:'执行中', completed:'工具已返回', failed:'执行失败' }[value.status] || value.status || '等待执行';
      // Native titles sometimes contain an entire file result. The full command
      // and output remain below; keep the terminal's status line short.
      const title = String(value.title || value.toolCallId).split('\n')[0];
      entry.title.textContent = `[${status}] ${title.length > 180 ? title.slice(0,180) + '…' : title}`;
      entry.block.dataset.status = value.status || 'pending';
      const command = commandText(value);
      if (entry.command.textContent !== '$ ' + command) entry.command.textContent = '$ ' + command;
      entry.command.hidden = !command;
      const result = resultText(value).slice(-16000);
      const text = result || (['pending','in_progress'].includes(value.status) ? '等待输出…' : '');
      const previous = entry.output.textContent;
      if (previous !== text) {
        if (entry.hadOutput && result && text.startsWith(previous)) entry.output.append(document.createTextNode(text.slice(previous.length)));
        else entry.output.textContent = text;
      }
      entry.hadOutput = !!result;
      entry.output.hidden = !text;
    }
    while (entries.size > 100) {
      const key = [...entries].find(([,e]) => !['pending','in_progress'].includes(e.call.status))?.[0] ?? entries.keys().next().value;
      entries.get(key).block.remove();entries.delete(key);
    }
    if (!entries.size) empty.textContent = ['completed','failed','cancelled','incomplete','interrupted'].includes(task.status) ? '本轮没有可显示的 CLI 工具输出。' : '等待 CLI 返回命令和输出…';
    viewport.scrollTop = following ? viewport.scrollHeight : scroll;
    label();
  } };
}
