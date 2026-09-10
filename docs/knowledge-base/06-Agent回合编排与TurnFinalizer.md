---
tags: [agent编排, 架构, 学习]
source: src/agent/runner/
---

# Agent 回合编排与 TurnFinalizer 记忆收尾

## 回合闭环（`agent-runner.service.ts` runInboundTurn）

```
Recall（记忆召回+上下文准备 preparation）
  → Compose（Section 体系拼 prompt）
  → Execute（LLM 多步工具调用循环）
  → Review（出站守卫审查，见 [[07-出站守卫裁决链]]）
  → Repair（不通过则修复，hard cap = 1 次）
  → Outcome（终态与人工介入意图）
  → Replay 定局 → 投递 / TurnOutcomeInterventionService.commit
  → Finalize（TurnFinalizer 按投递结局收尾记忆）
```

Repair **只允许一次**（防止修复循环烧钱烧时延），方式由规则 action 派生：rewrite 走**独立的
ReplyRepairAgent**（`src/agent/reply-repair/reply-repair.agent.ts`），按违规项 + 已知事实重写文本，
封闭泄漏形态优先确定性剥离/拆封。rewrite 不重新跑 Agent、不给工具；replan 档（当前只有
两条零工具查询/岗位事实规则）用完全相同的参数重跑一次 Generator，不注入反馈、不裁工具。
首版已有已提交副作用时，Runner 禁止重进 Generator、降级 rewrite 并告警。

`RepairEvidenceBuilder` 与 `ReplyRepairContextProvider` 都由 `AgentModule` 注册，归
`reply-repair/`。前者构建工具事实与策略的 `RepairEvidencePacket`，后者提供记忆、岗位等
修复上下文；它们供修复模型生成文本，Output 的确定性审查仍由独立规则链完成。

> `replan` 2026-07 的旧实现是"带守卫反馈 + 只读工具白名单"重进 generator，07-27 退役（三期
> 审计里全部"已投递伤害"都出自该路径），2026-09-09 以原意（同参重生成）重新占位。具体规则是
> observe、repair 还是 replan 只看 output catalog——见
> [Guardrail 质量体系 §3](../architecture/guardrail-quality-system.md#3-修复边界)。

重生成若由真实工具明确短路为 `handoff/skipped`，优先保留工具终态，不伪造二审；纯无工具空产物仍按修复失败处理。

修复后还有兜底检查：重写产物为空、或产出"悬空检查话术"（dangling reply，比如"我确认一下"这种没有下文的话）时按 revise_empty / revise_dangling 处置，不会把半成品发给用户。

Runner 用 `resolution` 单列最终 reply / handoff / skipped；真实审查保持原样，Trace 以
`finalOutcome` 记录处置，advisory 不提供最终处置。严格规则以 `allowFailOpen: false` 禁止违规放行；
无法安全收敛则转人工，元叙述旁白跳过且不新增介入，纯推理/工具残文直接转人工。Input 审查为 pass / handoff，风险命中同样形成 handoff，以 guardrail.phase=inbound/source=input_guardrail 区分来源，保留既有 conversation_risk 意图。

## TurnFinalizer：按投递结局收尾记忆（`turn-finalizer.ts`）

一个回合需要将候选人事实、已推荐岗位、助手回复等投影进记忆。若生成后直接收尾，就会出现
**回复没发出去，但记忆已经写了**：Agent 记得"我推荐过 A 岗位"，用户却从没收到。

`TurnFinalizer` 包装 Generator 的 `runTurnEnd` 闭包，**等投递结局已知后才结算记忆**：

```ts
finalizer.settle({ delivered }); // delivered=false 时只记用户侧记忆，
// Agent 侧的"我说过什么"全部丢弃
```

Replay 丢弃首版时调用 `discard()`，丢弃后 settle/whenSettled 都变成空操作。正常结算后在
释放聊天处理锁前等待 `whenSettled()`，避免相邻回合覆盖记忆。

人工介入有独立出口：渠道在 Replay 定局后调用 `TurnOutcomeInterventionService.commit()`，
执行暂停托管、handoff 与告警。报名、拉群等业务工具动作在工具执行期就可能已经提交；
Finalizer 不执行或回滚这些动作，repair 也不得重复执行。

## 学习要点

- 记忆收尾、人工介入意图提交、业务工具执行是不同边界；投递结局决定助手记忆，Replay 定局决定哪版 outcome 的人工介入可以提交。
- "repair hard cap 1"是生产 LLM 系统的典型纪律：任何 LLM 修 LLM 的回路必须有确定性上界，否则最坏情况成本无界。
- repair 的 rewrite 用独立轻链路而非重跑 Agent，是**成本分级**：文本问题不值得再付一次全量工具调用的钱。
