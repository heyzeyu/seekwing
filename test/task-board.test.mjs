import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildTaskBoard } from '../scripts/task-board.mjs';

const { html }=await buildTaskBoard();
const source=html.match(/<script>([\s\S]+)<\/script>/)[1];
const id='sw-11111111-1111-4111-8111-111111111111';
const other='sw-22222222-2222-4222-8222-222222222222';
const task=(extra={})=>({runId:id,backend:'grok',title:'Live task',status:'running',workspace:'/test',permissionMode:'read-only',output:'first chunk',outputOffset:0,outputLength:11,nextOutputOffset:null,toolCalls:[],...extra});
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

// Parse the generated card in a real DOM implementation; no browser or model
// calls. Layout and the native details.open property are the only shims.
function harness({globals}={}){
  const {document}=parseHTML(html);document.hidden=false;
  const createElement=document.createElement.bind(document);
  document.createElement=tag=>{
    const element=createElement(tag);
    Object.defineProperties(element,{scrollTop:{value:0,writable:true},scrollHeight:{value:1000,configurable:true},clientHeight:{value:350,configurable:true}});
    if(tag==='details')Object.defineProperty(element,'open',{get(){return this.hasAttribute('open');},set(value){this.toggleAttribute('open',!!value);}});
    return element;
  };
  const elements=Object.fromEntries(['scope','tasks','error','foot','refresh','back','auto','bind','run'].map(k=>[k,document.getElementById(k)]));
  elements.auto.checked=true;
  const sent=[],listeners=new Map(),timers=new Map();let serial=0;
  const host={postMessage:message=>sent.push(message)};
  const window={parent:host,openai:globals,addEventListener:(name,fn)=>listeners.set(name,fn)};
  vm.runInNewContext(source,{window,document,console,setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  const send=(method,params)=>listeners.get('message')({source:host,origin:'https://host.example',data:{jsonrpc:'2.0',method,params}});
  const reply=(request,result)=>listeners.get('message')({source:host,origin:'https://host.example',data:{jsonrpc:'2.0',id:request.id,result}});
  const calls=()=>sent.filter(m=>m.method==='tools/call');
  return{elements,sent,timers,send,reply,calls,
    init:async()=>{reply(sent[0],{hostContext:{toolInfo:{tool:{name:'wait_task'}}}});await flush();},
    poll:async()=>{const entry=[...timers].find(([,t])=>t.ms===1000);assert.ok(entry,'active task should schedule a one-second refresh');timers.delete(entry[0]);entry[1].fn();await flush();},
    globals:value=>listeners.get('openai:set_globals')({detail:{globals:value}})};
}
const output=h=>h.elements.tasks.querySelector('[aria-label="代理输出（未经独立核验）"]');

test('tool-input alone binds and reads an active task before wait_task returns',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-input',{arguments:{runId:id,seconds:30}});await flush();
  assert.equal(h.calls().length,1);
  assert.equal(h.calls()[0].params.name,'get_task');
  assert.equal(h.calls()[0].params.arguments.runId,id);
  assert.equal(h.calls()[0].params.arguments.outputTail,true);
  h.reply(h.calls()[0],{structuredContent:task()});await flush();
  assert.equal(output(h).textContent.trimEnd(),'first chunk');
  await h.poll();assert.equal(h.calls().length,2);
  h.reply(h.calls()[1],{structuredContent:task({output:'first chunk\nsecond chunk'})});await flush();
  assert.match(output(h).textContent,/second chunk/);
});

test('input received before initialization is retained and fetched when bridge becomes ready',async()=>{
  const h=harness();h.send('ui/notifications/tool-input',{arguments:{runId:id}});
  assert.equal(h.calls().length,0);await h.init();assert.equal(h.calls()[0].params.arguments.runId,id);
});

test('text-only MCP results and unwrapped compatibility output both initialize the card',async()=>{
  for(const response of [{content:[{type:'text',text:JSON.stringify(task())}]},task()]){
    const h=harness();await h.init();h.send('ui/notifications/tool-result',response);
    assert.equal(output(h).textContent.trimEnd(),'first chunk');await h.poll();
    assert.equal(h.calls()[0].params.arguments.outputTail,true);
  }
});

test('preloaded globals and late globals initialize without a tool-result notification',async()=>{
  const h=harness({globals:{toolInput:{runId:id},toolOutput:task()}});await h.init();
  assert.equal(output(h).textContent.trimEnd(),'first chunk');assert.equal(h.calls()[0].params.arguments.runId,id);
  const late=harness();await late.init();late.globals({toolInput:{runId:id}});await flush();assert.equal(late.calls()[0].params.arguments.runId,id);
});

test('refresh without task data lists current-chat tasks and never guesses an all-local run',async()=>{
  const h=harness();await h.init();assert.equal(h.elements.bind.hidden,false);
  h.elements.refresh.onclick();await flush();
  assert.equal(h.calls()[0].params.name,'list_tasks');assert.equal(h.calls()[0].params.arguments.scope,'current');
});

test('completed tasks stop polling, permission waits remain observable and errors recover manually',async()=>{
  const h=harness();await h.init();h.send('ui/notifications/tool-input',{arguments:{runId:id}});await flush();
  h.reply(h.calls()[0],{isError:true,content:[{type:'text',text:'temporary read error'}]});await flush();
  assert.match(h.elements.error.textContent,/temporary read error/);assert.ok(![...h.timers.values()].some(t=>t.ms===1000));
  h.elements.refresh.onclick();await flush();h.reply(h.calls()[1],{structuredContent:task({status:'needs_attention'})});await flush();await h.poll();
  h.reply(h.calls()[2],{structuredContent:task({status:'completed'})});await flush();assert.ok(![...h.timers.values()].some(t=>t.ms===1000));
});

test('late reads from a previous task cannot replace the newly selected task',async()=>{
  const h=harness();await h.init();h.send('ui/notifications/tool-input',{arguments:{runId:id}});await flush();
  const oldRequest=h.calls()[0];h.send('ui/notifications/tool-input',{arguments:{runId:other}});
  h.reply(oldRequest,{structuredContent:task()});await flush();
  assert.equal(h.calls().at(-1).params.arguments.runId,other);
  h.reply(h.calls().at(-1),{structuredContent:task({runId:other,output:'new task output'})});await flush();
  assert.equal(output(h).textContent.trimEnd(),'new task output');
});

test('a completed host result with more pages fetches its tail once without active polling',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-result',{structuredContent:task({status:'completed',output:'old first page',outputLength:30000,nextOutputOffset:12000})});await flush();
  assert.equal(h.calls().length,1);assert.equal(h.calls()[0].params.arguments.outputTail,true);
  h.reply(h.calls()[0],{structuredContent:task({status:'completed',output:'final output',outputOffset:18000,outputLength:30000,outputTail:true})});await flush();
  assert.equal(output(h).textContent.trimEnd(),'final output');assert.ok(![...h.timers.values()].some(t=>t.ms===1000));
});

function domText(element){return element.textContent;}
test('live tool commands and streamed results are visible without expanding raw evidence',async()=>{
  const h=harness();await h.init();
  const call={toolCallId:'shell-1',title:'python output',status:'in_progress',rawInput:{command:'python3 -u demo.py'},content:[{type:'content',content:{type:'text',text:'line one'}}]};
  h.send('ui/notifications/tool-result',{structuredContent:task({toolCalls:[call]})});
  const log=h.elements.tasks.querySelector('[aria-label="执行日志"]');
  assert.match(domText(log),/python3 -u demo.py/);assert.match(domText(log),/line one/);
  await h.poll();h.reply(h.calls()[0],{structuredContent:task({toolCalls:[{...call,content:[{type:'content',content:{type:'text',text:'line one\nline two'}}]}]})});await flush();
  assert.match(domText(h.elements.tasks.querySelector('[aria-label="执行日志"]')),/line two/);
});

test('live logs retain observed calls across response windows and reset when switching tasks',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-result',{structuredContent:task({toolCalls:[{toolCallId:'one',title:'first',status:'completed',rawOutput:'first result'}]})});
  h.send('ui/notifications/tool-result',{structuredContent:task({toolCalls:[{toolCallId:'two',title:'second',status:'completed',rawOutput:{stdout:'second result'}}]})});
  const text=domText(h.elements.tasks.querySelector('[aria-label="执行日志"]'));assert.match(text,/first result/);assert.match(text,/second result/);
  h.send('ui/notifications/tool-result',{structuredContent:task({runId:other,toolCalls:[{toolCallId:'other',title:'other',status:'completed',rawOutput:'other result'}]})});
  assert.doesNotMatch(domText(h.elements.tasks.querySelector('[aria-label="执行日志"]')),/first result/);
});

test('native Grok TaskOutput envelopes render stdout and exit code as readable results',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-result',{structuredContent:task({toolCalls:[{toolCallId:'native',status:'completed',content:[{type:'content',content:{type:'text',text:JSON.stringify({type:'TaskOutput',Result:{output:'line one\nline two',exit_code:0,output_file:'/native/private/log'}})}}]}]})});
  const log=domText(h.elements.tasks.querySelector('[aria-label="执行日志"]'));
  assert.match(log,/line two/);assert.match(log,/退出码：0/);assert.doesNotMatch(log,/output_file|"Result"/);
});

test('task details are collapsed by default and refresh preserves each disclosure independently',async()=>{
  const h=harness();await h.init();
  const value=task({toolCalls:[{toolCallId:'shell',status:'completed',rawOutput:'done'}]});
  const show=value=>h.send('ui/notifications/tool-result',{structuredContent:value});
  show(value);
  assert.equal(h.elements.tasks.querySelector('.task-details').open,false);
  assert.match(h.elements.tasks.querySelector('.task-details').textContent,/执行方/);
  assert.equal(h.elements.tasks.querySelector('.tool-evidence').open,false);
  h.elements.tasks.querySelector('.task-details').open=true;
  await h.poll();h.reply(h.calls()[0],{structuredContent:value});await flush();
  assert.equal(h.elements.tasks.querySelector('.task-details').open,true);
  assert.equal(h.elements.tasks.querySelector('.tool-evidence').open,false);
  h.elements.tasks.querySelector('.task-details').open=false;
  h.elements.tasks.querySelector('.tool-evidence').open=true;
  show(value);
  assert.equal(h.elements.tasks.querySelector('.task-details').open,false);
  assert.equal(h.elements.tasks.querySelector('.tool-evidence').open,true);
  show({...value,runId:other});
  assert.equal(h.elements.tasks.querySelector('.task-details').open,false);
  assert.equal(h.elements.tasks.querySelector('.tool-evidence').open,false);
  show(value);
  assert.equal(h.elements.tasks.querySelector('.tool-evidence').open,true);
});

test('task list disclosures retain their own state across refreshes',async()=>{
  const h=harness();await h.init();
  const show=()=>h.send('ui/notifications/tool-result',{structuredContent:{scope:'current',tasks:[task(),task({runId:other})]}});
  show();let details=h.elements.tasks.querySelectorAll('.task-details');
  assert.ok([...details].every(detail=>!detail.open));details[1].open=true;
  show();details=h.elements.tasks.querySelectorAll('.task-details');
  assert.equal(details[0].open,false);assert.equal(details[1].open,true);
});

test('replies render headings, lists, code, blockquotes and tables as Markdown',async()=>{
  const h=harness();await h.init();
  const markdown='## 发现\n\n**已核对** `listTask`\n\n- 第一项\n- 第二项\n\n> 需要复核\n\n| 范围 | 结果 |\n| --- | --- |\n| 当前 | 通过 |\n\n```html\n<img src=x onerror=alert(1)>\n```';
  h.send('ui/notifications/tool-result',{structuredContent:task({output:markdown})});
  const out=output(h);
  assert.equal(out.querySelector('h2').textContent,'发现');assert.equal(out.querySelector('strong').textContent,'已核对');
  assert.equal(out.querySelector('p code').textContent,'listTask');assert.equal(out.querySelectorAll('li').length,2);
  assert.match(out.querySelector('blockquote').textContent,/需要复核/);assert.equal(out.querySelector('td').textContent,'当前');
  assert.equal(out.querySelector('pre code').textContent.trim(),'<img src=x onerror=alert(1)>');assert.equal(out.querySelector('img'),null);
});

test('Markdown keeps untrusted HTML and unsafe links inert, with no remote images',async()=>{
  const h=harness();await h.init();
  const markdown='<script>alert(1)</script><img src=x onerror=alert(2)>\n\n[bad](javascript:alert(3)) [data](data:text/html,attack) [file](file:///etc/passwd) [relative](/call)\n\n[docs](https://example.com/docs?q=1&b=2)\n\n![remote](https://example.com/tracker.png)';
  h.send('ui/notifications/tool-result',{structuredContent:task({output:markdown})});
  const out=output(h);
  assert.equal(out.querySelector('script,img,iframe,object,style'),null);assert.match(out.textContent,/<script>alert/);
  const links=out.querySelectorAll('a');assert.equal(links.length,1);
  assert.equal(links[0].getAttribute('href'),'https://example.com/docs?q=1&b=2');
  assert.equal(links[0].getAttribute('target'),'_blank');assert.equal(links[0].getAttribute('rel'),'noopener noreferrer');
  assert.match(out.textContent,/图片：remote/);
});

test('partial Markdown updates render correctly and refresh preserves a reader scroll position',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-result',{structuredContent:task({output:'## 发现\n\n```js\nconsole.log('})});
  assert.match(output(h).querySelector('pre code').textContent,/console.log\(/);
  output(h).scrollTop=120;
  await h.poll();h.reply(h.calls()[0],{structuredContent:task({output:'## 发现\n\n```js\nconsole.log(1);\n```\n\n**完成**'})});await flush();
  assert.equal(output(h).scrollTop,120);assert.equal(output(h).querySelector('strong').textContent,'完成');
  output(h).scrollTop=650;
  await h.poll();h.reply(h.calls()[1],{structuredContent:task({output:'## 发现\n\n最后一段'})});await flush();
  assert.equal(output(h).scrollTop,1000);
});
