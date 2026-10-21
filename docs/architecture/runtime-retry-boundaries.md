# 运行时八层重试边界

阶段四统一上限入口：`src/infra/config/constants/runtime-retry.constants.ts`。这张表约束既有重试机会，不创建任何新重试；attempts 包含首次，retries/replays 不包含首次。模型调用者可缩小上限，不能超过每模型 3 次。

| 层 | 既有上限 | 允许条件 / 失败出口 |
| --- | --- | --- |
| 崩溃 / Bull batch | 3 次尝试，stalled 恢复上限 2 | 复用持久逻辑回合；执行档由 action journal 防跨进程重复派发。进程崩溃后的未知交核实恢复。|
| pending input replay | 3 次重放 | 首版无不可重放动作；成功、未知、在途、blocked/cancelled 不吸收旧轮重做。后来的 staleInput 不抹掉先前动作。|
| 图片兼容降级 | 1 次重跑 | 错误上没有 replayBlockedBy 动作证据；生成、审查、格式化、遥测失败均保留该证据。|
| 出站 repair/replan | 1 次修复 | 存在动作围栏时只能无工具 rewrite；blocked/unknown 不进入“已成功执行”清单。|
| 文本化工具 / 零工具空响应 | 各 1 次 | 首版零工具；重试内产生动作后发生异常必须保留证据上抛，不能回退成旧的零工具结果。|
| 模型 retry + fallback | 每模型 3 次尝试 | 已完成工具步骤整体续接；缺少完整工具结果的在途动作终止模型重试并交恢复。跨模型继续使用同一执行围栏。|
| 同名工具调用 | 3 次，precheck 2 次 | 明确无副作用失败可在旧上限内纠正。成功/未知/在途/blocked 不再调用；SDK 同步并发调用也先占本轮围栏。|
| 消息分片发送 | 原上限 1 次重试 | 上限不是发送许可。真实外发由阶段三入口裁决，未知不盲重发；只有已验证协议允许的明确无副作用失败才考虑重试。|

## 结果证据

统一读取顶层 `actionStatus` 和 `groupInvite.actionStatus`，不会解析自然语言。报名成功但拉群未知时，报名事实保留，拉群继续核实。`succeeded + localSync: pending` 仍是成功，只补本地记录；`unknown/executing` 不变成业务失败；`blocked` 不变成成功，也不能通过通用兜底重新获得执行权限。

LLM 错误上的 `agentMeta.replayBlockedBy` 只携带工具名、toolCallId、状态，不携带工具参数、候选人资料、token 或原始响应。它是当前进程的安全证据，不代替持久动作记录。真实 SDK 测试使用本地假 provider，不发生网络或业务外发。

## 观察档与执行档

ActionExecutor 的 observe 保留旧派发行为并记录 would-block；阶段四的同轮/模型/图片/重放安全围栏独立生效。明确未知不可为了“保持观察档旧行为”而再发。observe 并不提供崩溃后或另一进程里的 exactly-once 保证；跨进程保障依赖执行档、可靠逻辑回合身份、动作仓储和统一恢复。观察数据不能自动升级为新的执行授权。

## 故障验收索引

- `tests/llm/runtime-action-sdk.spec.ts`：真实 AI SDK，本地 fake provider；并发重复、成功/未知后 provider 超时、补账 pending 后模型链耗尽、结果序列化失败。
- `tests/llm/tool-replay-fence.spec.ts`：并发执行窗口、发送后响应丢失、明确无副作用的参数纠正。
- `tests/agent/generator/action-replay-matrix.spec.ts`：5 种外部工具 × 5 种异常回执，stale-input 顺序、真实成功与未知分离。
- 既有 generator/runner/reply-workflow/failure-service 测试扩展：图片兼容、pending replay、修复和空响应兜底不得重做或误报。
- 崩溃重入和分片发送的持久执行故障矩阵由阶段三 ActionExecutor / delivery 测试共同验收；上限常量测试不替代这些集成验证。
