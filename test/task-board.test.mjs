import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../src/task-board.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]+)<\/script>/)[1];
const id='sw-11111111-1111-4111-8111-111111111111';
const other='sw-22222222-2222-4222-8222-222222222222';
const task=(extra={})=>({runId:id,backend:'grok',title:'Live task',status:'running',workspace:'/test',permissionMode:'read-only',output:'first chunk',outputOffset:0,outputLength:11,nextOutputOffset:null,toolCalls:[],...extra});
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

// Exercise the shipped browser script's lifecycle without a browser dependency.
// The small DOM implements only the operations used by this card.
class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.style={};this.textContent='';this.scrollTop=0;this.scrollHeight=1000;this.value='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  get firstElementChild(){return this.children[0];}
  setAttribute(k,v){this.attrs[k]=v;}
  querySelector(selector){for(const child of this.children){if(selector==='details'?child.tag==='details':selector==='[aria-label="执行日志"]'?child.attrs['aria-label']==='执行日志':child.attrs['aria-label']==='代理输出（未经独立核验）')return child;const nested=child.querySelector(selector);if(nested)return nested;}return null;}
  getBoundingClientRect(){return{height:700};}
}
function harness({globals}={}){
  const elements=Object.fromEntries(['scope','tasks','error','foot','refresh','back','auto','bind','run'].map(k=>[k,new Element()]));
  elements.tasks.append(new Element('p'));elements.auto.checked=true;
  const sent=[],listeners=new Map(),timers=new Map();let serial=0;
  const host={postMessage:message=>sent.push(message)};
  const window={parent:host,openai:globals,addEventListener:(name,fn)=>listeners.set(name,fn)};
  const document={body:new Element('body'),hidden:false,getElementById:id=>elements[id],createElement:tag=>new Element(tag),addEventListener(){}};
  vm.runInNewContext(source,{window,document,console,setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  const send=(method,params)=>listeners.get('message')({source:host,origin:'https://host.example',data:{jsonrpc:'2.0',method,params}});
  const reply=(request,result)=>listeners.get('message')({source:host,origin:'https://host.example',data:{jsonrpc:'2.0',id:request.id,result}});
  const calls=()=>sent.filter(m=>m.method==='tools/call');
  return{elements,sent,timers,send,reply,calls,
    init:async()=>{reply(sent[0],{hostContext:{toolInfo:{tool:{name:'wait_task'}}}});await flush();},
    poll:async()=>{const entry=[...timers].find(([,t])=>t.ms===1000);assert.ok(entry,'active task should schedule a one-second refresh');timers.delete(entry[0]);entry[1].fn();await flush();},
    globals:value=>listeners.get('openai:set_globals')({detail:{globals:value}})};
}

test('tool-input alone binds and reads an active task before wait_task returns',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-input',{arguments:{runId:id,seconds:30}});await flush();
  assert.equal(h.calls().length,1);
  assert.equal(h.calls()[0].params.name,'get_task');
  assert.equal(h.calls()[0].params.arguments.runId,id);
  assert.equal(h.calls()[0].params.arguments.outputTail,true);
  h.reply(h.calls()[0],{structuredContent:task()});await flush();
  assert.equal(h.elements.tasks.querySelector('pre').textContent,'first chunk');
  await h.poll();assert.equal(h.calls().length,2);
  h.reply(h.calls()[1],{structuredContent:task({output:'first chunk\nsecond chunk'})});await flush();
  assert.match(h.elements.tasks.querySelector('pre').textContent,/second chunk/);
});

test('input received before initialization is retained and fetched when bridge becomes ready',async()=>{
  const h=harness();h.send('ui/notifications/tool-input',{arguments:{runId:id}});
  assert.equal(h.calls().length,0);await h.init();assert.equal(h.calls()[0].params.arguments.runId,id);
});

test('text-only MCP results and unwrapped compatibility output both initialize the card',async()=>{
  for(const response of [{content:[{type:'text',text:JSON.stringify(task())}]},task()]){
    const h=harness();await h.init();h.send('ui/notifications/tool-result',response);
    assert.equal(h.elements.tasks.querySelector('pre').textContent,'first chunk');await h.poll();
    assert.equal(h.calls()[0].params.arguments.outputTail,true);
  }
});

test('preloaded globals and late globals initialize without a tool-result notification',async()=>{
  const h=harness({globals:{toolInput:{runId:id},toolOutput:task()}});await h.init();
  assert.equal(h.elements.tasks.querySelector('pre').textContent,'first chunk');assert.equal(h.calls()[0].params.arguments.runId,id);
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
  assert.equal(h.elements.tasks.querySelector('pre').textContent,'new task output');
});

test('a completed host result with more pages fetches its tail once without active polling',async()=>{
  const h=harness();await h.init();
  h.send('ui/notifications/tool-result',{structuredContent:task({status:'completed',output:'old first page',outputLength:30000,nextOutputOffset:12000})});await flush();
  assert.equal(h.calls().length,1);assert.equal(h.calls()[0].params.arguments.outputTail,true);
  h.reply(h.calls()[0],{structuredContent:task({status:'completed',output:'final output',outputOffset:18000,outputLength:30000,outputTail:true})});await flush();
  assert.equal(h.elements.tasks.querySelector('pre').textContent,'final output');assert.ok(![...h.timers.values()].some(t=>t.ms===1000));
});

function domText(element){return[element.textContent,...element.children.map(domText)].join('\n');}
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
