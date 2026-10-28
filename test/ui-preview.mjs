// Local, read-only browser harness for MCP Apps lifecycle debugging.
// node test/ui-preview.mjs [existing-run-id | --live-grok]
// Without an ID it uses synthetic output and never launches a native model.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repo } from './helpers.mjs';

const live=process.argv[2]==='--live-grok';
const existing=live?undefined:process.argv[2];
if(existing && !/^sw-[0-9a-f-]{36}$/.test(existing))throw Error('Expected a SeekWing run ID.');
let runId=existing || 'sw-'+randomUUID();
const state=existing?null:await mkdtemp(path.join(tmpdir(),'seekwing-ui-preview-'));
const client=new Client({name:'seekwing-ui-preview',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(repo,'dist/seekwing.mjs'),'mcp'],
  env:{...process.env,...(state?{SEEKWING_STATE_DIR:state}:{})},stderr:'pipe'}));
if(live){
  const workspace=path.join(state,'workspace');await import('node:fs/promises').then(fs=>fs.mkdir(workspace));
  const started=await client.callTool({name:'start_task',arguments:{backend:'grok',workspace,title:'Grok 连续回复、命令与结果实测',permissionMode:'read-only',
    modelValue:'grok-4.7-build-fast',reasoningEffort:'low',timeoutSeconds:180,idempotencyKey:'live-card-'+randomUUID(),
    instruction:'只做实时输出测试，不读其他文件、不写文件、不联网。先发送可见回复 SW_LIVE_REPLY_BEGIN。然后只运行一条终端命令 python3 -u -c \'import time; [(print("SW_LIVE_STDOUT_%d" % i, flush=True), time.sleep(8)) for i in range(1, 6)]\'。使用短 yield 让进程在后台继续，再用原生等待工具取得后续输出。不要运行别的命令。命令结束后发可见回复 SW_LIVE_REPLY_END 并结束。'}});
  if(started.isError)throw Error(JSON.stringify(started.content));runId=started.structuredContent.runId;
}
const html=(await client.readResource({uri:'ui://seekwing/tasks.html'})).contents[0].text;
let reads=0;
const seed={schemaVersion:1,runId,title:'Grok 实时输出验证',backend:'grok',permissionMode:'read-only',sessionMode:'background',status:'running',
  workspace:'/local/test-workspace',origin:{threadId:'preview-chat',source:'explicit'},submittedBy:{threadId:'preview-chat',source:'explicit'},
  output:'',outputLength:0,toolCallCount:1,toolCalls:[{toolCallId:'read-1',title:'读取源文件',status:'in_progress'}],pendingPermissions:[],reviewRequired:true};
function mock(args){
  reads++;
  const output=('早期输出\n'.repeat(3000))+`最新输出 #${reads}：Grok 正在逐步返回内容。`;
  const offset=args.outputTail?Math.max(0,output.length-12000):(args.outputOffset || 0);
  return{...seed,output:output.slice(offset,offset+12000),outputLength:output.length,outputOffset:offset,outputTail:!!args.outputTail,
    nextOutputOffset:offset+12000<output.length?offset+12000:null,updatedAt:new Date().toISOString()};
}
const page=`<!doctype html><html><head><meta charset="utf-8"><title>SeekWing live lifecycle check</title></head><body style="margin:0"><iframe title="SeekWing" src="/card" style="width:100%;height:1100px;border:0"></iframe><script>
const frame=document.querySelector('iframe'),mode=new URLSearchParams(location.search).get('mode') || 'input';
async function call(params){const r=await fetch('/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});if(!r.ok)throw Error(await r.text());return r.json();}
function send(value){frame.contentWindow.postMessage({jsonrpc:'2.0',...value},location.origin);}
window.addEventListener('message',async e=>{if(e.source!==frame.contentWindow || e.origin!==location.origin || e.data?.jsonrpc!=='2.0')return;const m=e.data;
if(m.method==='ui/initialize'){send({id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'local-lifecycle-test',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{toolInfo:{tool:{name:'wait_task'}}}}});}
if(m.method==='ui/notifications/initialized'){
if(mode==='input')send({method:'ui/notifications/tool-input',params:{arguments:{runId:${JSON.stringify(runId)},seconds:30}}});
if(mode==='text')send({method:'ui/notifications/tool-result',params:{content:[{type:'text',text:JSON.stringify((await call({name:'get_task',arguments:{runId:${JSON.stringify(runId)}}})).structuredContent)}]}});
if(mode==='globals')frame.contentWindow.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{toolInput:{runId:${JSON.stringify(runId)}}}}}));
}
if(m.method==='tools/call'){try{send({id:m.id,result:await call(m.params)});}catch(error){send({id:m.id,error:{code:-32000,message:String(error)}});}}
});</script></body></html>`;
const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${server.address().port}`)throw Error('Unexpected Host');
    const target=new URL(req.url,'http://'+req.headers.host);
    if(target.pathname==='/card'){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return;}
    if(req.method==='GET' && target.pathname==='/'){res.setHeader('content-type','text/html;charset=utf-8');res.end(page);return;}
    if(req.method==='POST' && target.pathname==='/call'){
      if(req.headers.origin && req.headers.origin!=='http://'+req.headers.host)throw Error('Foreign origin');
      let body='';for await(const part of req){body+=part;if(body.length>10000)throw Error('Body too large');}
      const params=JSON.parse(body);
      if(params.name!=='get_task' || params.arguments?.runId!==runId)throw Error('This harness only reads its selected run');
      const result=existing||live?await client.callTool(params):{content:[],structuredContent:mock(params.arguments)};
      res.setHeader('content-type','application/json');res.end(JSON.stringify(result));return;
    }
    res.statusCode=404;res.end('Not found');
  }catch(error){res.statusCode=400;res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,runId,mode:live?'real-grok-read-only':existing?'existing-run-read-only':'synthetic-stream-no-model-call'}));
let observation;
if(live){
  let checking=false,last='';const observations=[];
  observation=setInterval(async()=>{
    if(checking)return;checking=true;
    try{
      const result=await client.callTool({name:'get_task',arguments:{runId,outputTail:true,outputLimit:2000}});const t=result.structuredContent;
      const markers=[...new Set(JSON.stringify(t.toolCalls).match(/SW_LIVE_STDOUT_[1-5]/g)||[])];
      const value={at:new Date().toISOString(),status:t.status,outputLength:t.outputLength,markers,toolStatuses:t.toolCalls.map(c=>c.status)};
      const key=JSON.stringify({...value,at:undefined});if(key!==last){console.log(JSON.stringify(value));observations.push(value);last=key;}
      if(['completed','failed','cancelled','incomplete'].includes(t.status)){
        clearInterval(observation);
        const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()).replaceAll('-','');
        await import('node:fs/promises').then(fs=>fs.writeFile(path.join(repo,`../../work/seekwing-live-card-observation-${day}.json`),JSON.stringify({runId,observations},null,2)));
      }
    }catch(error){console.error(String(error));}finally{checking=false;}
  },500);
}
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(observation);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await client.close();if(state)await rm(state,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
