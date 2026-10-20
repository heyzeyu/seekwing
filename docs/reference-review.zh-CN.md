# v0.2.1 开源对照与自检

日期：2026-10-20。基线：SeekWing `598f260`（v0.2.0）。参考仓库仅拉取和阅读源码，没有执行其安装脚本或运行其代理。

## 拉取与检查的仓库

| 仓库 | 固定提交 / 许可证 | 检查位置与借鉴点 |
| --- | --- | --- |
| [openclaw/acpx](https://github.com/openclaw/acpx/tree/40ecc17ec17cd8abf4eb311bbc13ba635657f798) | `40ecc17`，MIT | `src/session/queue/owner-turn-controller.ts`、`control-admission.ts`、`docs/shared-sessions.md`：区分开始、提交和执行；取消按请求归属；取消与提交交错时不能遗漏真正的轮次；已确认完成的响应保持真实结果。 |
| [tonytanglab/deepseek-harness-relay-mcp](https://github.com/tonytanglab/deepseek-harness-relay-mcp/tree/5a2c9f5f1d47cb2bbaa64337cfddafe9c2363473) | `5a2c9f5`，MIT | `src/relay-broker/prompt-admission-controller.ts`、`src/mcp-http/request-policy.ts`、`src/authority/registry-guard.ts`：提交结果不确定时禁止自动重放；保留会话所有权；限制本地入口及请求资源。该项目的 Harness 版本约束与本机不同，接口仍以本机官方运行时实测为准。 |
| [agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk/tree/c2b1a8633745dd859a2732b4e17d5ed61e869bb6) | `c2b1a86`，Apache-2.0 | `src/examples/client.ts`、`src/examples/dual-version-agent.ts`、README：稳定 v1 与实验 v2 显式区分，先协商协议再开会话。继续使用已验证的 SDK 1.4.0 / stable ACP 1，并增加不兼容拒绝。 |

本次借鉴生命周期和边界处理设计，由 SeekWing 自行实现；未复制这些项目的实现代码，也未增加新的运行时依赖。已有 SDK 的分发许可证继续包含在 `dist/THIRD_PARTY_NOTICES.txt`。

## 已证实并修复的问题

1. **提交中取消可能错过真实任务**：旧版在原生提交结束前就发送取消。新增串行控制和立即取消标记；指令尚未提交时直接终止，已经进入原生提交时等待其结束后取消。
2. **创建响应丢失可能遗留会话锁**：旧版只有收到创建响应才清理。现在按 run ID 清理未确认创建的任务，禁止迟到的创建重新执行；失败创建不会永久占用缓存或容量。
3. **手工聊天的归属错误**：旧版停止观察完成后的用户消息；清理可能把后来手工运行的会话当成原任务未结束。现在持续识别用户新轮次，保留手工会话，也保护提交前已经出现的手工消息。
4. **中文 HTTP 分块解码**：旧版对每个 Buffer 隐式独立解码，可能截断多字节字符；100 KB 的入口也小于 MCP 所允许的长中文指令。现在按字节限额收集后一次解码，上限 512 KiB。
5. **控制操作并发与状态准确性**：模型控制排队；失败选择不覆盖原值，相同选择不改写默认模型。已确认完成的原生结果不会被交界处的用户取消改成取消状态。
6. **兼容性与资源回收**：ACP 协议及桌面伴随协议在派发前检查；Host 同时最多持有 8 个任务；只回收已退出客户端且原生已经空闲的记录，仍在运行的任务保留。

## 验证

修复前三项新增复现测试均失败；同一测试在修复后通过。总回归扩充至 **29 项**，包括旧功能、鉴权、工作区、幂等、协议拒绝、中文分块、长输入、取消竞态、响应丢失、手工轮次隔离和容量恢复。真实模型验证也已通过：macOS / Harness Desktop 0.2.1-rc.2 上，后台和桌面均完成生成、原会话续聊、实际改代码及独立 `node --test` 验证、原生只读拒写。桌面额外验证了取消一个正在执行的 `sleep 30`，随后在同一会话继续对话。执行标识和本地截图另存为本机验收证据，不随开源源码分发。

仍保留的边界：Host 重启后不自动重放或自动把未知结果当作成功；不自动迁移后台旧会话；桌面审批保留原生 UI；P330/SSH、其他 Harness 版本及 Windows 仍需单独验证。
