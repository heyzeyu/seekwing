import { createTerminal } from './task-terminal.mjs';

export const taskStatuses = { starting:'启动中', running:'执行中', needs_attention:'等待处理', cancelling:'取消中', completed:'已结束 · 待核验', incomplete:'未完成', failed:'执行失败', cancelled:'已取消', interrupted:'已中断' };
export const isActive = task => ['starting','running','needs_attention','cancelling'].includes(task.status);

// Keep interactive nodes mounted across snapshots. Polling must not replace a
// focused control, reset an open disclosure, or disturb a reader's selection.
export function createTaskView(document, { list = false, renderMarkdown, load, liveQuery }) {
  const node = (tag, text, cls) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (cls) element.className = cls;
    return element;
  };
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const button = (label, action, cls = 'quiet-button') => {
    const element = node('button', label, cls);element.type = 'button';element.onclick = action;return element;
  };
  const element = node('article', undefined, list ? 'card task-list-item' : 'card');
  const head = node('div', undefined, 'task-head'), title = node('h2'), badge = node('span', undefined, 'badge');
  head.append(title, badge);element.append(head);
  const details = node('details', undefined, 'task-details'), facts = node('dl', undefined, 'facts');
  details.append(node('summary','任务详情'), facts);element.append(details);
  let task, query, lastFacts, lastOutput, lastEvidence, lastNotices, lastPage;
  if (list) {
    const open = button('查看输出', () => load(liveQuery(task.runId)), 'open-task');element.append(open);
  }
  const notices = node('div', undefined, 'notices');
  const reply = node('section', undefined, 'reply-section'), replyHead = node('div', undefined, 'section-head');
  replyHead.append(node('h3','回复'));
  const expand = button('展开阅读', () => {
    const expanded = output.dataset.expanded !== 'true';output.dataset.expanded = String(expanded);
    expand.setAttribute('aria-expanded', String(expanded));expand.textContent = expanded ? '收起阅读' : '展开阅读';
  });
  expand.setAttribute('aria-expanded','false');replyHead.append(expand);
  const output = node('div', undefined, 'markdown');output.setAttribute('aria-label','代理输出（未经独立核验）');output.tabIndex = 0;
  const paging = node('nav', undefined, 'paging');paging.setAttribute('aria-label','回复分页');
  const previous = button('上一页', () => load({name:'get_task',arguments:{runId:task.runId,outputOffset:Math.max(0,task.outputOffset-12000)}}));
  const first = button('回到开头', () => load({name:'get_task',arguments:{runId:task.runId}}));
  const next = button('下一页', () => load({name:'get_task',arguments:{runId:task.runId,outputOffset:task.nextOutputOffset}}));
  const latest = button('跟随最新', () => load(liveQuery(task.runId)));
  paging.append(previous, first, next, latest);reply.append(replyHead, output, paging);
  const stream = node('section', undefined, 'stream-section'), streamHead = node('div', undefined, 'section-head');
  const count = node('span', undefined, 'section-meta');streamHead.append(node('h3','执行过程'), count);
  const terminal = createTerminal(document);stream.append(streamHead, terminal.element);
  const truncation = node('p',undefined,'muted');stream.append(truncation);
  const evidence = node('details',undefined,'tool-evidence'), evidenceTitle = node('summary','原始工具记录'), raw = node('pre');
  evidence.append(evidenceTitle,raw);stream.append(evidence);
  if (!list) element.append(notices,reply,stream);
  return { element, update(value, selectedQuery) {
    task = value;query = selectedQuery;
    setText(title,task.title || `${task.backend === 'grok' ? 'Grok' : 'DeepSeek'} 任务`);
    setText(badge,taskStatuses[task.status] || task.status || '未知状态');badge.dataset.status = task.status;
    details.dataset.runId = task.runId;evidence.dataset.runId = task.runId;
    const fields = [
      ['执行方',`${task.backend === 'grok' ? 'Grok' : 'DeepSeek'} · ${task.sessionMode || 'background'}`],
      ['权限',task.permissionMode === 'workspace-write' ? '可编辑工作目录' : '只读'],
      ['运行编号',task.runId],['来源聊天',task.origin?.threadId || '未知（旧任务或宿主未提供）'],
      ...(task.submittedBy?.threadId && task.submittedBy.threadId !== task.origin?.threadId ? [['本轮发起',task.submittedBy.threadId]] : []),
      ['工作目录',task.workspace],...(task.sessionId ? [['原生会话',task.sessionId]] : []),...(task.modelValue ? [['模型',task.modelValue]] : []),
    ];
    const factsKey = JSON.stringify(fields);
    if (factsKey !== lastFacts) { facts.replaceChildren();for (const [key,text] of fields) facts.append(node('dt',key),node('dd',text || '未知'));lastFacts = factsKey; }
    if (list) return;
    const messages = [];
    if (task.status === 'needs_attention') messages.push(['等待你处理',task.desktopAttention || '请回到聊天中查看并处理权限请求。任务会在这里等待。','attention']);
    for (const key of ['error','cleanupError','persistenceError']) if (task[key]) messages.push(['执行遇到问题',task[key],'error']);
    if (task.outputTruncated) messages.push(['输出已达保存上限','请结合文件及工具记录核查完整结果。','attention']);
    const noticesKey = JSON.stringify(messages);
    if (noticesKey !== lastNotices) {
      notices.replaceChildren();for (const [heading,text,tone] of messages) { const note = node('div',undefined,'notice');note.dataset.tone = tone;note.append(node('strong',heading),node('p',text));notices.append(note); }lastNotices = noticesKey;
    }
    notices.hidden = !messages.length;
    const text = task.output || '';
    const page = query?.arguments.outputTail ? 'tail' : query?.arguments.outputOffset || 0;
    const pageChanged = lastPage !== undefined && lastPage !== page;lastPage = page;
    const initialOutput = lastOutput === undefined;
    const scroll = output.scrollTop, atEnd = lastOutput === undefined || output.scrollHeight - output.clientHeight - scroll < 40;
    if (lastOutput !== text) {
      if (text) {
        const parsed = node('div');parsed.innerHTML = renderMarkdown(text);
        const next = [...parsed.childNodes], old = [...output.childNodes];
        for (let i = 0; i < next.length; i++) {
          if (!old[i]) output.append(next[i]);
          else if (!old[i].isEqualNode(next[i])) output.replaceChild(next[i],old[i]);
        }
        while(output.childNodes.length > next.length)output.lastChild.remove();
      }
      else output.textContent = isActive(task) ? '等待代理回复…' : '本轮没有文字回复。';
      lastOutput = text;
      if (output.dataset.expanded !== 'true') output.scrollTop = pageChanged ? (page === 'tail' ? output.scrollHeight : 0) : query?.arguments.outputTail && atEnd && (isActive(task) || !initialOutput) ? output.scrollHeight : scroll;
    } else if (!text) setText(output,isActive(task) ? '等待代理回复…' : '本轮没有文字回复。');
    if(pageChanged && output.dataset.expanded !== 'true')output.scrollTop = page === 'tail' ? output.scrollHeight : 0;
    output.dataset.empty = String(!text);
    expand.hidden = output.dataset.expanded !== 'true' && output.scrollHeight <= output.clientHeight;
    previous.hidden = first.hidden = !(task.outputOffset > 0);next.hidden = task.nextOutputOffset == null;
    latest.hidden = !!query?.arguments.outputTail || (!(task.outputOffset > 0) && task.nextOutputOffset == null);
    paging.hidden = [...paging.children].every(control => control.hidden);
    const calls = Array.isArray(task.toolCalls) ? task.toolCalls : [];
    setText(count,`${task.toolCallCount ?? calls.length} 次工具调用`);
    terminal.update(task);
    truncation.hidden = !task.toolCallsTruncated;setText(truncation,'仅显示近期工具记录，新输出会继续显示。');
    evidence.hidden = !calls.length;
    // Serialise only when evidence is visible; keep the disclosure itself stable.
    const updateEvidence = () => { const text = JSON.stringify(calls,null,2);if(text !== lastEvidence){raw.textContent = text;lastEvidence = text;} };
    evidence.ontoggle = () => { if (evidence.open) updateEvidence(); };
    if (evidence.open) updateEvidence();
  } };
}
