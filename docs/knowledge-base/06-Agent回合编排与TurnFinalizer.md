---
tags: [agent编排, 架构, 学习]
source: src/agent/runner/
---

# Agent 回合编排与 TurnFinalizer 统一副作用出口

## 回合闭环（`agent-runner.service.ts` runInboundTurn）

```
Recall（记忆召回+上下文准备 preparation）
  → Compose（Section 体系拼 prompt）
  → Execute（LLM 多步工具调用循环）
  → Review（出站守卫审查，见 [[07-出站守卫裁决链]]）
  → Repair（不通过则修复，hard cap = 1 次）
  → Finalize（TurnFinalizer 统一沉淀副作用）
```

Repair **只允许一次**（防止修复循环烧钱烧时延），方式由规则 action 派生：rewrite 走**独立的
ReplyRepairAgent**（`src/agent/reply-repair/reply-repair.agent.ts`），按违规项 + 已知事实重写文本，
不重新跑 Agent、不给工具；replan 档（当前只有两条零工具编造岗位事实的规则）用完全相同的参数
重跑一次 generator，不注入反馈、不裁工具。

> `replan` 2026-07 的旧实现是"带守卫反馈 + 只读工具白名单"重进 generator，07-27 退役（三期
> 审计里全部"已投递伤害"都出自该路径），2026-09-09 以原意（同参重生成）重新占位。具体规则是
> observe、revise、replan 还是 block 只看 output catalog——见
> [Guardrail 质量体系 §3](../architecture/guardrail-quality-system.md#3-修复边界)。

修复后还有兜底检查：重写产物为空、或产出"悬空检查话术"（dangling reply，比如"我确认一下"这种没有下文的话）时按 revise_empty / revise_dangling 处置，不会把半成品发给用户。

## TurnFinalizer：为什么需要"统一副作用出口"（`turn-finalizer.ts`）

一个回合产生的副作用很多：写 session facts、推进阶段、记录已推荐岗位、更新已邀群……早期这些散落在各处，出现一个隐蔽 bug：**回复没发出去，但记忆已经写了**——Agent 记得"我推荐过 A 岗位"，用户却从没收到，下一轮对话鬼打墙。

方案：所有副作用收敛到 TurnFinalizer，并且**等投递结局已知后才结算**：

```ts
finalizer.settle({ delivered }); // delivered=false 时只记用户侧记忆，
// Agent 侧的"我说过什么"全部丢弃
```

丢弃后 settle/whenSettled 都变成空操作（幂等）。这保证了**记忆与真实世界一致**：没送达的回复不污染 session 记忆。

## 学习要点

- 这是把数据库事务的"两阶段"思想用在 Agent 副作用上：执行阶段只**收集**副作用意图，投递确认后才**提交**。
- "repair hard cap 1"是生产 LLM 系统的典型纪律：任何 LLM 修 LLM 的回路必须有确定性上界，否则最坏情况成本无界。
- revise 用独立轻链路而非重跑 Agent，是**成本分级**：文本问题不值得再付一次全量工具调用的钱。
