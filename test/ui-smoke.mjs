// Opt-in browser verification against the actual MCP server and fixture ACP.
// SEEKWING_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/ui-smoke.mjs
// Optional: SEEKWING_CHROME, SEEKWING_UI_SCREENSHOT. No native model call is made.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, finished } from './helpers.mjs';

const { chromium } = await import(process.env.SEEKWING_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.SEEKWING_PLAYWRIGHT_MODULE).href : 'playwright');
const root = await mkdtemp(path.join(tmpdir(), 'seekwing-ui-'));
const workspace = path.join(root, 'workspace'); await mkdir(workspace);
const c = await connect(path.join(root, 'state'), { extraEnv: { CODEX_THREAD_ID: 'ui-fixture-chat' } });
let browser;
try {
  const run = await c.call('start_task', { title: '界面测试 <img src=x onerror="window.injected=1">', workspace, instruction: 'SLOW' });
  await c.call('wait_task', { runId: run.runId, seconds: 1 });
  const resource = (await c.client.readResource({ uri: 'ui://seekwing/tasks.html' })).contents[0];
  browser = await chromium.launch({ headless: true, ...(process.env.SEEKWING_CHROME ? { executablePath: process.env.SEEKWING_CHROME } : {}) });
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  const errors = [], called = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('mcpCall', async params => {
    assert.ok(['get_task', 'list_tasks'].includes(params.name), 'UI must call read-only tools only');
    called.push(params.name);
    return c.client.callTool(params);
  });
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe title="SeekWing task board" style="width:100%;height:980px;border:0"></iframe></body></html>');
  await page.evaluate(({ html }) => {
    const frame = document.querySelector('iframe');
    window.addEventListener('message', async e => {
      if(e.source !== frame.contentWindow || e.data?.jsonrpc !== '2.0') return;
      const m = e.data;
      if(m.method === 'ui/initialize') e.source.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'test-host',version:'1'},hostCapabilities:{serverTools:{}}}}, '*');
      if(m.method === 'ui/notifications/initialized') window.bridgeReady = true;
      if(m.method === 'tools/call') {
        try {e.source.postMessage({jsonrpc:'2.0',id:m.id,result:await window.mcpCall(m.params)}, '*');}
        catch(error){e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:String(error)}}, '*');}
      }
    });
    frame.srcdoc=html;
  }, { html: resource.text });
  await page.waitForFunction(() => window.bridgeReady === true);
  const send = async response => page.evaluate(result => document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result}, '*'), response);
  await send(await c.client.callTool({ name: 'list_tasks', arguments: {} }));
  const frame = page.frameLocator('iframe');
  await frame.getByText('本聊天派发的任务', { exact: true }).waitFor();
  assert.equal(await frame.locator('#tasks img').count(), 0, 'Worker text must never become HTML');
  await frame.getByRole('button', { name: '查看进度和输出' }).click();
  await frame.getByText('单个运行记录', { exact: true }).waitFor();
  const before = called.length;
  await c.call('cancel_task', { runId: run.runId });
  await frame.getByText('已取消', { exact: true }).waitFor({ timeout: 12000 });
  assert.ok(called.length > before, 'Active card must refresh its terminal status');
  await frame.getByRole('button', { name: '任务列表', exact: true }).click();
  await frame.getByText('本聊天派发的任务', { exact: true }).waitFor();
  const large = await c.call('start_task', { title: '翻页与复核状态测试', workspace, instruction: 'LONG' });
  await finished(c, large.runId);
  await send(await c.client.callTool({ name: 'get_task', arguments: { runId: large.runId } }));
  await frame.getByRole('button', { name: '返回输出开头' }).click();
  await frame.getByRole('button', { name: '下一页输出' }).click();
  await frame.getByRole('button', { name: '返回输出开头' }).waitFor();
  assert.match(await frame.locator('.badge').innerText(), /待核验/);
  assert.equal(await frame.locator('#error').innerText(), '');
  if(process.env.SEEKWING_UI_SCREENSHOT) await page.screenshot({ path: process.env.SEEKWING_UI_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['MCP resource and bridge handshake', 'attribution', 'escaped untrusted text', 'read-only details', 'automatic terminal refresh', 'return to list', 'output pagination', 'review label'], calls: called.length, nativeModelCalls: 0 }));
} finally { await browser?.close(); await c.close(); await rm(root, { recursive: true, force: true }); }
