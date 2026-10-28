// Opt-in visual fixture gallery. No model, MCP worker, auth, or task-store reads.
// Run: node test/ui-design-preview.mjs. Rebuilds the real shipped card on reload.
import { createServer } from 'node:http';
import { buildTaskBoard } from '../scripts/task-board.mjs';

const id = 'sw-11111111-1111-4111-8111-111111111111';
const second = 'sw-22222222-2222-4222-8222-222222222222';
const reply = '已整理任务卡片的信息层级，正在检查持续输出时的阅读体验。\n\n### 本轮调整\n\n- **更专注的内容区**：回复与执行过程分区，任务详情按需展开。\n- **不中断的阅读**：刷新保留滚动位置，长回复可以展开阅读。\n- **清晰的状态**：执行中、等待处理和异常分别呈现。\n\n接下来检查窄面板、深色外观与键盘操作。';
const rich = '### 检查范围\n\n| 场景 | 检查项 |\n| --- | --- |\n| 持续输出 | 命令追加、暂停跟随 |\n| 长回复 | Markdown、分页、滚动 |\n| 小尺寸 | 文本换行、操作可达 |\n\n```js\nconst task = await getTask(runId);\nrender(task);\n```\n\n> 此处为界面演示数据，不代表真实任务结果。\n\n';
const call = {toolCallId:'preview-check',title:'检查任务界面',status:'in_progress',rawInput:{command:'npm run check'},rawOutput:'> seekwing · interface check\n\n  Reading task state\n  Checking output rendering\n  Checking disclosure state\n'};
function task(scenario, reads, runId = id) {
  const status = {completed:'completed',failed:'failed',attention:'needs_attention',empty:'starting',long:'completed'}[scenario] || 'running';
  const result = {...call,status:status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'in_progress'};
  result.rawOutput += status === 'failed' ? '\nError: The native process stopped before returning a result.\n退出码：1' : status === 'completed' ? '\n  Finished fixture output\n退出码：0' : `\n  Streaming update ${String(reads).padStart(2,'0')}\n`;
  const output = scenario === 'empty' ? '' : reply + (scenario === 'long' ? '\n\n' + rich.repeat(6) : '');
  return {runId,backend:runId === second ? 'deepseek' : 'grok',title:runId === second ? '核对交互边界与可读性' : '优化任务卡片的阅读与交互体验',status,
    workspace:'/demo/seekwing',permissionMode:'read-only',sessionMode:'background',modelValue:runId === second ? 'demo-deepseek-model' : 'demo-grok-model',
    origin:{threadId:'demo-chat',source:'explicit'},output,outputLength:output.length,outputOffset:0,nextOutputOffset:null,outputTail:true,
    toolCalls:scenario === 'empty' ? [] : [result],toolCallCount:scenario === 'empty' ? 0 : 1,pendingPermissions:[],reviewRequired:true,
    ...(scenario === 'failed' ? {error:'原生进程提前退出。请回到聊天中检查原因，再决定是否继续。'} : {}),
    ...(scenario === 'attention' ? {desktopAttention:'执行方请求额外权限。请回到聊天中核对操作并决定是否允许。'} : {})};
}
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SeekWing · 界面预览</title>
<style>body{margin:0;background:#edf0f4;font:12px system-ui;color:#555b67}aside{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;padding:12px;background:#fff;border-bottom:1px solid #dfe3eb}label{display:flex;gap:6px;align-items:center}select{font:inherit;padding:4px;border:1px solid #dfe3eb;border-radius:5px}iframe{display:block;width:min(760px,100%);height:980px;border:0;margin:24px auto;border-radius:16px;box-shadow:0 12px 40px #28344712}p{text-align:center;font-size:11px}</style>
<aside><span>SeekWing 界面预览 · 演示数据</span><label>场景<select id="scenario"><option value="running">执行中</option><option value="completed">已结束</option><option value="long">长回复</option><option value="attention">等待处理</option><option value="failed">执行失败</option><option value="empty">等待输出</option><option value="list">任务列表</option><option value="none">暂无任务</option></select></label><label>外观<select id="theme"><option value="light">浅色</option><option value="dark">深色</option></select></label><label>宽度<select id="width"><option value="760">常规面板</option><option value="390">窄面板</option><option value="320">最小面板</option></select></label></aside>
<iframe title="SeekWing" src="/card"></iframe><p>仅供界面预览 · 不连接模型，不读取真实任务</p>
<script>
const frame=document.querySelector('iframe');let currentRun=${JSON.stringify(id)};
const select=id=>document.getElementById(id);
function send(value){frame.contentWindow.postMessage({jsonrpc:'2.0',...value},location.origin);}
async function call(params){const response=await fetch('/fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:select('scenario').value,...params})});if(!response.ok)throw Error(await response.text());return response.json();}
function seed(){send({method:'ui/notifications/tool-input',params:{arguments:{runId:currentRun}}});call({name:['list','none'].includes(select('scenario').value)?'list_tasks':'get_task',arguments:{runId:currentRun}}).then(result=>send({method:'ui/notifications/tool-result',params:result}));}
select('scenario').onchange=()=>{currentRun=${JSON.stringify(id)};frame.src='/card';};
select('theme').onchange=()=>send({method:'ui/notifications/host-context-changed',params:{theme:select('theme').value}});
select('width').onchange=()=>{frame.style.width='min('+select('width').value+'px,100%)';};
window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow || event.origin!==location.origin || event.data?.jsonrpc!=='2.0')return;const m=event.data;
if(m.method==='ui/initialize')send({id:m.id,result:{hostContext:{theme:select('theme').value,toolInfo:{tool:{name:'wait_task'}}}}});
if(m.method==='ui/notifications/initialized')seed();
if(m.method==='ui/notifications/size-changed')frame.style.height=Math.min(12000,Math.max(300,m.params.height+2))+'px';
if(m.method==='tools/call'){try{if(m.params.arguments?.runId)currentRun=m.params.arguments.runId;send({id:m.id,result:await call(m.params)});}catch(error){send({id:m.id,error:{code:-32000,message:String(error)}});}}
});</script></html>`;
let reads = 0;
const server = createServer(async (req,res) => {
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    if (req.headers.host !== new URL(origin).host) throw Error('Unexpected Host');
    const url = new URL(req.url,origin);
    if (req.method === 'GET' && url.pathname === '/') {res.setHeader('content-type','text/html;charset=utf-8');res.end(page);return;}
    if (req.method === 'GET' && url.pathname === '/card') {res.setHeader('content-type','text/html;charset=utf-8');res.end((await buildTaskBoard()).html);return;}
    if (req.method === 'POST' && url.pathname === '/fixture') {
      if (req.headers.origin && req.headers.origin !== origin) throw Error('Foreign origin');
      let body = '';for await (const chunk of req) {body += chunk;if(body.length>10000)throw Error('Body too large');}
      const params = JSON.parse(body);if(!['get_task','list_tasks'].includes(params.name))throw Error('Read-only fixture');
      if(params.name === 'get_task' && ![id,second].includes(params.arguments?.runId))throw Error('Unknown fixture');
      const structuredContent = params.name === 'list_tasks' ? {scope:'current',tasks:params.scenario === 'none' ? [] : [task('running',++reads),task('completed',reads,second)]} : task(params.scenario,++reads,params.arguments.runId);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({structuredContent,content:[]}));return;
    }
    res.statusCode=404;res.end('Not found');
  } catch(error) {res.statusCode=400;res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/',mode:'synthetic-design-preview-no-model'}));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();});
process.on('SIGINT',()=>{server.closeAllConnections();server.close();});
