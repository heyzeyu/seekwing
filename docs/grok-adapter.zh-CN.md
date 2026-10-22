# Grok 适配器：v0.3.0

本版在 SeekWing 中增加 `backend: grok`，保留插件名称、商城入口、DeepSeek 默认行为和既有历史。共享 MCP 任务管理和 ACP 进程生命周期；原生启动、认证、沙箱和会话细节由各自适配器处理。

## 接入方式

- Grok：官方 CLI `--sandbox read-only|workspace --permission-mode default agent --no-leader stdio`。
- ACP：initialize → advertised noninteractive authenticate → session/new 或 session/resume → 核对原生会话元数据 → set_config_option → prompt → close。
- Grok 扩展方法的线协议名称是 `_x.ai/session/state`，用于确认该会话的 ID、工作区和实际 sandbox profile。未确认时不发送 prompt。
- 禁用该进程的自动更新、auto/yolo 和沙箱内自动放行 Bash 的配置。不连接或终止用户已有 leader。
- 模型与 reasoning 使用原生 catalog 值；显式选择返回值不一致时停止，不静默改选。
- CLI/登录只要求所选后端可用；无效的另一个后端配置不会阻止当前后端使用。
- 续聊固定后端、工作区、权限、模型及 sessionMode。旧记录缺少 backend 时归属 DeepSeek；保留旧幂等指纹和 DeepSeek 会话锁名称。
- Grok 会话锁增加后端命名空间，避免两个后端恰有相同 session ID 时互相阻塞。

九个 MCP 工具共用，不为每个模型供应商复制工具。`doctor`、`inspect_models`、`start_task` 可选择 backend；后续工具由持久任务记录确定后端。

## 2026-10-22 本机真实验证

环境：macOS、官方 Grok **1.0.67 (2fe064390d07)**、Grok 原生缓存登录；生成测试使用 **grok-4.7-build-fast / low**。

| 验证 | 结果 |
| --- | --- |
| 真实模型回复 | 返回指定标记，正常 end_turn |
| MCP 关闭、重启并改变默认后端后续聊 | 保留同一 Grok session ID、模型和上下文，正确回忆随机标记 |
| 修改生成的 sum.mjs | 将减法修复为加法，未修改测试文件 |
| 独立验收 | Codex 重新执行 `node --test sum.test.mjs`，退出码 0 |
| 只读写入测试 | 原生 write 工具失败：`Operation not permitted (os error 1)`，目标文件不存在 |
| 另一个 MCP 进程取消任务 | 原生 stopReason/status 均为 cancelled，清理结束 |

可用 `test/native-grok-smoke.mjs` 复现。脚本要求显式提供 scratch 目录，会消耗正常 Grok 额度，输出本机 summary.json；不提交会话记录或用户凭据。

63 项确定性回归全部通过，另覆盖认证失败、仅交互认证、API-key 方法选择、协议版本拒绝、错误沙箱/工作区、无效或被忽略的模型选择、权限转交、禁止永久授权、后端缺失隔离、旧历史兼容、会话锁命名空间和不响应取消的进程清理。DeepSeek 后台和 Desktop 原有回归也保留。

## 当前边界

- 支持 Grok macOS/Linux 原生沙箱；Linux 尚未做真实 Grok 生成测试，Windows 明确拒绝启动 Grok 任务。
- Grok 使用原生 Home 和历史；可以在工作区 `grok --resume <sessionId>` 打开已完成会话。目前不接入运行中的 TUI、不声称 Dashboard 实时同步，不支持 `sessionMode: desktop`。
- 原生 sandbox 会允许运行数据和临时目录写入；workspace 模式额外允许工作区写入。只读不等于没有任何运行状态变化，也不限制所有外部读取。macOS 的子进程网络限制与 Linux 不同，详见官方文档。
- CLI 仍加载用户信任的 Grok 配置、原生权限规则和插件；不修改全局默认配置。插件不自动批准 ACP 请求，原生已经允许的操作仍遵守原生规则和 OS 沙箱。
- 任务完成不等于验收通过，Codex 仍需核对文件、差异、测试和失败的工具调用。

## 官方依据

- [Grok ACP 文档](https://docs.x.ai/build/cli/headless-scripting)
- [本次参考源码快照](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8)
- [原生沙箱说明](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md)

适配代码独立编写，未复制上游实现；通过官方 ACP 协议和 Grok 扩展接口集成。
