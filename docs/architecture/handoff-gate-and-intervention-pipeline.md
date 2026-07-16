# Gate 拒绝与人工介入流水线

**最后更新**：2026-07-16

> 本文说明高风险业务工具如何在确定性 gate 拒绝后停止 LLM loop，并由 Runner 将本轮收敛为人工介入；同时说明转人工底账、暂停托管、飞书告警和幂等控制的职责边界。

---

## 1. 设计目标

当 Agent 准备执行不可逆或高风险动作时，仅靠 Prompt 或让模型“失败后自行调用 `request_handoff`”不够可靠。模型可能重试错误工具、改变转人工原因、生成误导回复，或者根本没有调用转人工工具。

本机制解决以下问题：

- 工具基于真实数据做安全校验，拒绝越权或来源不可信的操作；
- gate 拒绝后立即停止 LLM loop，不再给模型二次发挥空间；
- Runner 确定性地把特定 gate 拒绝分类为 `handoff`；
- 底账、暂停托管、告警统一从最终副作用出口执行；
- Bull 重试、重复消费或并发处理不会重复计数、暂停和告警；
- 工具失败的业务上下文（工单号、原因、建议动作）能够完整传给人工。

当前典型场景是改约工单归属保护：手机号实时查询得到的工单不在当前微信联系人的 `active_booking` 中时，禁止跨联系人自助修改并直接触发人工介入。

---

## 2. 分层职责

| 层                   | 负责什么                                                       | 不负责什么                             |
| -------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Tool                 | 校验业务事实和动作权限，返回结构化结果                         | 不直接暂停托管，不直接发送告警         |
| Generator            | 执行 LLM 多步工具循环；识别 `shortCircuited` 并停止 loop       | 不决定 gate 拒绝最终属于静默还是转人工 |
| Runner / Outcome     | 根据完整工具轨迹决定本轮终态，统一生成转人工幂等键和副作用意图 | 不直接操作托管状态或通知渠道           |
| Outcome Intervention | 先写转人工底账并判重，再提交人工介入动作                       | 不重新判断业务是否应该转人工           |
| Intervention         | 执行暂停托管和飞书告警                                         | 不生成回合幂等键，不写转人工分析底账   |

核心原则：

> LLM 负责理解自然语言，Tool 负责守住业务动作边界，Runner 负责确定性收口，Intervention 负责执行外部副作用。

---

## 3. 工具结果协议

### 3.1 `shortCircuited` 与 `gateRejected` 不是同一个信号

```ts
{
  success: false,
  shortCircuited: true,
  gateRejected: true,
  reasonCode: 'modify_appointment',
  workOrderId: 450643,
  handoffReason: '工单不属于当前微信联系人',
  actionAdvice: '核实联系人和工单关系后人工处理'
}
```

两个字段分别服务不同层：

| 字段                   | 消费者    | 含义                                                 |
| ---------------------- | --------- | ---------------------------------------------------- |
| `shortCircuited: true` | Generator | 立即结束 LLM loop，不再生成文本或调用其他工具        |
| `gateRejected: true`   | Runner    | 该短路是必须人工介入的安全拒绝，不能只按普通静默处理 |

常见结果组合：

| 工具结果                                                                      | LLM loop | Outcome                |
| ----------------------------------------------------------------------------- | -------- | ---------------------- |
| 普通成功                                                                      | 可继续   | 通常为 `reply`         |
| 普通失败，无 `shortCircuited`                                                 | 可继续   | 模型可以追问或修正参数 |
| `shortCircuited: true`                                                        | 立即停止 | 默认 `skipped`         |
| `shortCircuited: true` + `gateRejected: true`，且工具在 handoff gate 白名单中 | 立即停止 | `handoff`              |

`gateRejected` 不能单独停止 loop；需要人工介入的 gate 必须同时返回 `shortCircuited: true`。

### 3.2 为什么不用异常

工单归属不匹配是可预期的业务拒绝，不是基础设施异常。抛异常会丢失以下结构化语义：

- 是否应该静默或转人工；
- 关联的工单号；
- 人工介入原因；
- 建议动作；
- 是否应该停止模型继续执行。

因此这类结果使用 `buildToolError()` 返回业务错误，而不是 `throw`。

---

## 4. 端到端数据流

```text
候选人明确提出修改工单信息
  ↓
LLM 调用高风险业务工具
  ↓
Tool 查询当前联系人的真实记忆/权限数据
  ↓
归属或 provenance gate 拒绝
  ├─ 不调用真正的外部修改接口
  └─ 返回 shortCircuited=true + gateRejected=true + 人工处理上下文
  ↓
Generator.stopWhen 识别 shortCircuited=true
  ├─ 结束 LLM loop
  ├─ 不做空文本恢复
  └─ 保留工具调用与完整 tool result
  ↓
AgentRunner.invokeReviewed 发现本轮已短路
  └─ 不做出站文本审核/repair，原样进入 outcome 分类
  ↓
classifyReviewedOutcome 识别 handoff gate
  ├─ 生成统一 idempotencyKey
  ├─ 构造 GeneralHandoffSideEffectIntent
  └─ 返回 kind=handoff
  ↓
渠道确认当前 outcome 是最终回合
  ↓
TurnOutcomeInterventionService.commit
  ├─ 写 handoff_events
  ├─ 写 ops_events(handoff.triggered)
  ├─ duplicate → 停止，不重复派发
  └─ inserted/failed → InterventionService.dispatch
       ├─ 检查是否已经暂停
       ├─ UserHostingService.pauseUser
       └─ GeneralHandoffNotifierService.notify
            ├─ 渲染飞书人工介入卡片
            └─ 发送到对应招募负责人/告警渠道
```

注意顺序：Runner 不是在 LLM loop 运行时识别 `gateRejected`。首先由已有的 `shortCircuited` 机制停止 loop；Generator 返回后，Runner 才读取保留下来的 `gateRejected` 并决定终态。

---

## 5. 两类 handoff 来源

Runner 当前统一处理两类来源：

### 5.1 模型显式调用 `request_handoff`

`request_handoff` 只返回结构化的 `general_handoff` 副作用意图，并设置 `shortCircuited: true`。工具本身不直接暂停托管、发告警或生成幂等键。

### 5.2 业务工具 gate hard-reject

受支持的业务工具返回 `shortCircuited: true + gateRejected: true`。`isHandoffGateRejectedToolCall()` 只识别明确纳入白名单的工具，避免任意工具随意返回一个布尔值就触发人工介入。

目前包括：

- `duliday_interview_booking` 的 booking provenance/runtime gate；
- `duliday_modify_interview_time` 的工单归属 gate。

Runner 的分类优先级为：

```text
出站 block
  → committed request_handoff / handoff gate reject
  → 普通短路或空文本
  → 正常回复
```

因此 handoff gate 不会被后面的通用 `skipped` 分支吞掉。

---

## 6. 幂等边界

### 6.1 为什么由 Runner 生成 key

`idempotencyKey` 保护的是“写底账 + 统计 + 暂停托管 + 发送告警”这一整次人工介入，而不只是 `handoff_events` 的一次数据库插入。

Runner 掌握稳定的回合身份：

- `chatId`：哪一个会话；
- `turnId`：哪一条入站消息或哪一次主动调度回合；
- `scope`：普通 handoff 或出站守卫 handoff。

因此统一生成方法位于：

```text
src/agent/runner/handoff-idempotency.ts
```

标准格式：

```ts
buildHandoffIdempotencyKey({ chatId, turnId });
// `${chatId}:handoff:${turnId}`

buildHandoffIdempotencyKey({
  chatId,
  turnId,
  scope: 'output_guard',
});
// `${chatId}:handoff:${turnId}:output_guard`
```

`request_handoff` 不再自行决定 key。`classifyReviewedOutcome()` 会用最终的 `chatId + turnId` 生成标准 key，并覆盖工具副作用意图中可能存在的旧值。

### 6.2 稳定身份要求

同一逻辑回合的重试必须复用同一个 `turnId`：

- 被动企微消息使用消息 ID / 聚合批次 ID；
- 主动复聊使用稳定的调度回合 ID；
- 不应在生产重试路径使用 `Date.now()` 重新生成身份。

生成方法会拒绝空 `chatId` 或空 `turnId`，但不会替调用方猜测稳定身份。

### 6.3 数据库判重

`handoff_events` 使用复合唯一约束：

```sql
UNIQUE (corp_id, idempotency_key)
```

仓储使用：

```ts
.upsert(payload, {
  onConflict: 'corp_id,idempotency_key',
  ignoreDuplicates: true,
})
```

返回三态结果：

| 结果        | 含义                             | 后续动作                    |
| ----------- | -------------------------------- | --------------------------- |
| `inserted`  | 本企业下第一次处理该逻辑 handoff | 执行暂停和告警              |
| `duplicate` | 已有相同 key                     | 立即返回，不重复派发        |
| `failed`    | 无法确认是否已写入               | fail-safe：仍执行暂停和告警 |

`ops_events(handoff.triggered)` 使用同一个 key，并通过自身唯一约束避免日报中的转人工次数重复累加。

数据库唯一约束而不是“先查再写”负责并发判重。这样两个并发 worker 同时处理时，只会有一个获得 `inserted`。

---

## 7. 人工介入提交链

### 7.1 最终提交时机

渠道只有在 replay 判断完成、确认当前 outcome 是最终回合后，才调用：

```ts
TurnOutcomeInterventionService.commit(outcome, context);
```

这避免首版回合随后被新消息 replay 丢弃时，提前暂停托管或发送无效告警。

### 7.2 底账

`HandoffRecorderService.record()` 同时写入：

1. `handoff_events`：原因、建议动作、阶段、工单号等人工介入分析底账；
2. `ops_events(handoff.triggered)`：运营统计及日报投影来源。

### 7.3 暂停托管

`InterventionService.dispatch()` 先调用 `UserHostingService.isUserPaused()`：

- 已暂停：返回 `already_paused`，不重复告警；
- 未暂停：调用 `pauseUser()`，默认暂停三天并同步缓存与数据库。

### 7.4 飞书告警

暂停成功后调用 `GeneralHandoffNotifierService.notify()`：

- 根据 `botImId` 查找对应飞书接收人；
- 渲染命中原因、建议动作、当前消息、最近十条上下文和候选人信息；
- 生产环境发送私聊卡片，无法解析负责人时使用兜底提醒策略；
- 卡片提示人工处理后到 Web 托管后台手动恢复托管。

---

## 8. 为什么不采用其他方案

### 8.1 不让模型在工具失败后再次调用 `request_handoff`

这种方案依赖模型确定性，可能出现改 reasonCode、重复调用工具、错误回复“没有预约”或只口头承诺转人工等问题。安全 gate 必须由 runtime 确定性收口。

### 8.2 不让业务工具直接暂停和告警

否则每个工具都要重复实现底账、去重、暂停、告警和失败处理，并可能产生“暂停成功但告警失败”等分散的半完成状态。工具只声明意图，统一出口提交副作用。

### 8.3 不创建“未确认修改却尝试转人工”专用错误类型

是否确认改约由改约工具的意图 gate 负责；是否人工介入由归属/provenance gate 负责。额外增加 handoff 专用错误类型会重复表达同一状态并扩大分支数量。

---

## 9. 已知边界

当前链路采用：

```text
先写 handoff_events
  → 再暂停托管和发送告警
```

因此仍有一个很小的原子性窗口：底账插入成功后，如果进程在调用 `InterventionService.dispatch()` 前崩溃，重试会因为 key 已存在而判断 `duplicate`，可能不再发送告警。

若未来需要严格保证最终派发，应引入 transactional outbox：在同一数据库事务中写入 handoff 底账和待派发任务，由可重试 worker 消费任务并单独记录派发状态。当前实现优先解决重复消费、并发执行和重复统计问题。

此外，`TurnOutcomeInterventionService` 在数据库写入失败时采用 fail-safe 策略继续调用 `InterventionService`。这意味着数据库不可用期间可能出现重复告警，但不会因为分析底账故障而漏掉需要人工处理的候选人。

---

## 10. 扩展新的 handoff gate

新增高风险工具 gate 时，应完成以下事项：

1. 工具在调用外部副作用前完成真实数据校验；
2. gate 拒绝返回 `shortCircuited: true` 和 `gateRejected: true`；
3. 返回稳定的 `reasonCode`、人工可读原因和建议动作；有工单时返回 `workOrderId`；
4. 在 `isHandoffGateRejectedToolCall()` 中显式登记工具，而不是接受所有 `gateRejected`；
5. 在 `classifyReviewedOutcome()` 中确认告警标签和字段映射；
6. 补充 Generator 短路、Outcome 分类、底账判重和渠道不发文本的测试；
7. 不在工具中直接调用暂停、告警或生成 handoff 幂等键。

---

## 11. 代码索引

| 职责                        | 代码位置                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| 改约归属 gate               | `src/tools/duliday-modify-interview-time.tool.ts`                  |
| 通用工具短路判断            | `src/agent/generator/tool-call-analysis.ts`                        |
| LLM loop `stopWhen`         | `src/agent/generator/generator.agent.ts`                           |
| Outcome 分类与 handoff 意图 | `src/agent/runner/turn-outcome.ts`                                 |
| handoff 幂等键              | `src/agent/runner/handoff-idempotency.ts`                          |
| 最终副作用提交              | `src/agent/runner/turn-outcome-intervention.service.ts`            |
| 转人工底账入口              | `src/biz/handoff-events/handoff-recorder.service.ts`               |
| handoff 数据库判重          | `src/biz/handoff-events/handoff-events.repository.ts`              |
| 暂停与告警编排              | `src/biz/intervention/intervention.service.ts`                     |
| 托管暂停                    | `src/biz/user/services/user-hosting.service.ts`                    |
| 飞书人工介入通知            | `src/notification/services/general-handoff-notifier.service.ts`    |
| 飞书卡片渲染                | `src/notification/renderers/general-handoff-card.renderer.ts`      |
| 企微最终提交入口            | `src/channels/wecom/message/application/reply-workflow.service.ts` |

主要回归测试：

- `tests/tools/duliday-modify-interview-time.tool.spec.ts`
- `tests/tools/request-handoff.tool.spec.ts`
- `tests/agent/runner/handoff-idempotency.spec.ts`
- `tests/agent/runner/agent-runner.service.spec.ts`
- `tests/channels/wecom/message/application/reply-workflow.service.spec.ts`
