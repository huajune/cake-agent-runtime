# Agent 可靠性重构 + 复聊 —— 实施路线图（逐块落地）

> 状态：历史施工记录（2026-07-16 归档口径，不再作为当前实现说明）
> 日期：2026-06-24
> 父文档：
> - [agent-reliability-refactor-2026-06.md](../../architecture/reliability/agent-reliability-refactor-2026-06.md)（总架构，§10 落地路线）
> - [agent-reliability-hc-runtime-mechanisms.md](../../architecture/reliability/agent-reliability-hc-runtime-mechanisms.md)（HC-1/2/3 runtime 机制）
> - [agent-reengagement-design.md](../../architecture/reliability/agent-reengagement-design.md)（复聊实现级设计）
>
> 本文把三份设计拆成**可独立提交、可独立验证、有依赖序**的 PR 块，作为「逐块做」的施工底图。每块标注：依赖、改动面、验证点、回滚边界。
>
> 当前运行时真相请以 [Agent 运行时架构](../../architecture/agent-runtime-architecture.md)、[安全护栏说明](../../architecture/security-guardrails.md) 和 [Gate 拒绝与人工介入流水线](../../architecture/handoff-gate-and-intervention-pipeline.md) 为准。本文中的“迁移期”“尚未落地”和旧文件名保留为当时施工语境，不再持续校准。

---

## 实施进展（2026-06-24，本分支已落地）

逐块已落地（每块独立 commit，全量 298 suites / 4082 tests 绿）：

| 块 | commit | 落地内容 | 显式延后 |
|---|---|---|---|
| PR-A | `fc0219c0` | `isToolSuccess`(正向信号)/`hasCommittedSideEffect` + `reviseFeedback`/`committedSideEffects` + preparation 注入 | revise **orchestration**（decide→loop≤1）随 output-guard-in-runner 后续 |
| PR-B | `395731f7` | `candidate-field-parser`(parser+normalizer 对齐 Sponge) + `getAuthoritativeState` 填 collectedFields(user_text) | — |
| PR-B2 | `7b79a892` | `precheck-core` 共享原语 + booking 姓名**负向证据**闸门(只补 checkRealName 拦不住的打招呼昵称缺口) | 完整 `evaluatePrecheck` 抽离 + 模型 `prechecked` 废弃（耦合直连预约路径，风险高） |
| PR-C | `81b51227` | `types/guardrail.contract` 中立契约 + `agent/guardrail/catalog`(exogenousSignal 审计) | input-guard/reply-fact-guard/risk-intercept **物理目录归并**（纯搬家，低风险窗口做） |
| PR-D | `3d37a799` | output rule `candidate_name_echo`/`distance_missing`(warn) + `ModelRole.Review` | `LlmReviewer` 完整服务 + wiring（需延迟预算与灰度，§9） |
| PR-E | `1fa5c0f2` | `TurnOutcome`/`TurnRequest` + `runTurn`(inbound/proactive) + `proactiveDirective` 注入 | output-guard/revise 编排移入 runner（被动路径仍走 invoke，零行为变化） |
| PR-F | `0c975d34` | reengagement 全模块: scenario-registry(7场景+computeFireAt+shouldStop) + touch-ledger(outbox) + scheduler + processor + **shadow 默认开** | — |
| PR-G | `ceb23ddd` | scheduler 接入 `agent.opening_sent` 锚点（opening_no_reply shadow 端到端激活） | `store_presented`/`collection_started` 新 ops_events + `booking.succeeded` 接入 + **真发**（阻塞：平台主动发消息配额核实） |

**真发前剩余阻塞**（与 reengagement §8 一致）：① 平台主动发消息配额/时间窗核实；② 补 `store_presented`/`booking_incomplete` 锚点事件 + booking.succeeded 接入；③ shadow 命中/停止/拦截观测验证通过后按场景灰度关 shadow。

---

## 0. 当前已落地基线（开工前对账）

按代码实测（非文档声明），以下已在 `codex/agent-reliability-runtime-on-precheck` 分支落地：

| 能力 | 现状 | 位点 |
|---|---|---|
| `runner` seam | `TurnRunnerService` 已下线，回合编排收口 `AgentRunnerService`，行为不变 | [agent-runner.service.ts](../../../src/agent/runner/agent-runner.service.ts) |
| `ChannelDeliveryPort` | 历史接口，当前已经移除 | `channel-delivery.port.ts` |
| `toolMode` 接缝 | `AgentInvokeParams.toolMode: scenario\|readonly\|none`，preparation 物理过滤工具 | [generator.types.ts:27](../../../src/agent/generator/generator.types.ts#L27)、agent-preparation.service.ts |
| 权威状态骨架 | `AuthoritativeSessionState` 类型 + `SessionService.getAuthoritativeState()`（派生只读） | [authoritative-session-state.types.ts](../../../src/memory/types/authoritative-session-state.types.ts)、session.service.ts:131 |
| HC-2 jobId 闸门 | `recalledJobIds:Set` 成员判定 `isRecalledJobId`，booking 无召回出处 → `{shortCircuited,gateRejected,reasonCode:'job_id_not_recalled'}` | precheck/booking tool、tool.types.ts |
| HC-3 booking-gate handoff | runner any-tool 短路 + outcome 层 `dispatchBookingGateHandoffIfNeeded`（先写底账→duplicate跳过→failed仍fail-safe dispatch） | [reply-workflow.service.ts:548](../../../src/channels/wecom/message/application/reply-workflow.service.ts#L548) |
| handoff 底账三态 | `HandoffRecorderService.record()` → `inserted\|duplicate\|failed`（upsert ignoreDuplicates） | handoff-recorder.service.ts、handoff-events.repository.ts |
| output rule 新规则（部分） | `proactive_insurance_policy_mention`（兼职提保险）已加 | reply-fact-guard.service.ts:336 |

**尚未落地**（本路线图覆盖）：HC-1 revise 回路、HC-2 候选人原文 parser/normalizer + BookingGuard 准入、`guardrail/` 物理归并目录、`precheck-core` 抽纯函数、output llm reviewer（`ModelRole.Review`）、output rule 余两规则、阶段2 渲染、阶段3 权威状态补全、**reengagement 整模块**。

---

## 1. 依赖图（决定施工序）

```
[已落地: runner seam + toolMode + 权威骨架 + jobId闸门 + handoff三态]
        │
        ├── PR-A  HC-1 revise 回路（副作用判定 + no-tool 文本重写）         ← 仅依赖 runner/toolMode
        │
        ├── PR-B  HC-2 候选人原文 parser + BookingGuard 准入                ← 依赖权威骨架；与 PR-A 独立
        │         └── PR-B2  precheck-core 抽纯函数 + 模型 prechecked 废弃   ← 依赖 PR-B
        │
        ├── PR-C  guardrail/ 目录归并（纯搬家，行为等价）                    ← 独立，但建议在 PR-D 前
        │         └── PR-D  output llm reviewer + rule 补两规则             ← 依赖 PR-C + ModelRole.Review
        │
        ├── PR-E  TurnOutcome 类型抽象 + runner 收口 handoff/blocked/revise  ← 依赖 PR-A；为 reengagement 复用接缝
        │
        └── PR-F  reengagement 模块（shadow）                              ← 依赖 PR-E（proactive trigger）+ 权威停止条件
                  ├── F1 ScenarioRegistry + FollowUpScenario 配置
                  ├── F2 Scheduler（锚点 hook + computeFireAt + Bull delayed）
                  ├── F3 TouchLedger（outbox 状态机 + 频控）
                  ├── F4 Processor（shouldStop → 频控 → 窗口 → runner.runTurn(readonly) → deliver）
                  └── F5 Shadow 开关 + 命中/停止/拦截观测
        │
        └── PR-G  补锚点事件（store_presented / booking_incomplete ops_events） ← reengagement 真发前
```

**关键洞察**：reengagement（新需求 headline）依赖 `runner.runTurn` 支持 **proactive trigger**（从 directive 而非 user message 起一个回合）。当前 `AgentRunnerService` 只透传 `invoke(AgentInvokeParams)`，没有 proactive 入口 —— 这是 PR-E 必须先补的接缝。故 **reengagement 不能跳过 PR-E 直接做**。

---

## 2. 逐块施工卡

### PR-A — HC-1 副作用后 revise → 无工具文本重写

- **依赖**：runner seam + toolMode（已落地）。
- **改动面**：
  - `runner.service.ts`：新增纯函数 `isToolSuccess`（正向信号 `success===true || dispatched===true || workOrderId!=null`，**禁用 `'errorType' in r`**，成功带 `errorType:null`）+ `hasCommittedSideEffect`（覆盖 `invite_to_group / duliday_interview_booking / duliday_modify_interview_time / duliday_cancel_work_order`）。
  - `AgentInvokeParams`：新增 `reviseFeedback?: GuardViolation[]`、`committedSideEffects?: string`。
  - runner revise 分支：有副作用 → `toolMode:'none'` 文本重写（≤1）；无副作用 → 全量重跑（≤1）；`afterRewrite` 用 `draft.toolCalls ∪ rewritten.toolCalls` 过 output 守卫。
- **验证点**：单测 —— ① 成功 booking（`errorType:null`）判为已提交副作用 → 走文本重写、不重复 booking；② 无副作用 revise 走全量重跑；③ 重写后仍 revise → block。
- **回滚边界**：纯 runner 内逻辑，不碰渠道；revise 未触发时行为等价。

### PR-B — HC-2 候选人原文 parser + BookingGuard 准入

- **依赖**：权威状态骨架（已落地）。
- **改动面**：
  - 新增 `tools/shared/candidate-field-parser.ts`：对**当前轮 user 原文**确定性解析（真名排昵称/「我是X」、11位手机、户籍省、健康证有/无/可办、性别、学历…）+ normalizer 对齐 Sponge 枚举（健康证 **1/2/3**、户籍 `householdRegisterProvinceId` **数字ID**、性别 **1/2**）→ 写 `user_text` provenance。
  - `AUTHORITATIVE = {user_text, booking_writeback}`；BookingGuard 算 missingFields 时 `provenance ∉ AUTHORITATIVE` 视为未提供。
  - parser **落点**：preparation 解析 + gate 首步再校一次（推荐②兜底①），保证 guard 看到最新 evidence。
  - precheck `applyCandidateFieldOverride` 降级为 `model_arg` 草稿，**不再写权威态**。
- **验证点**：① 模型入参 candidateName=「小王」但 user 原文无真名 → missing；② user 原文「我叫王建国 电话139…」→ name/phone 落 user_text；③ 户籍省名→数字ID normalizer 正确；④ 健康证 1/2/3 映射。
- **回滚边界**：BookingGuard 准入收紧可能提升拒绝率 → 配 `reject_collect`（可重试）兜底，灰度观测误拒率。

### PR-B2 — precheck-core 抽纯函数 + 废弃模型 prechecked

- **依赖**：PR-B。
- **改动面**：`tools/shared/precheck-core.ts` 抽 `evaluatePrecheck(job, candidate)` 纯函数，precheck 工具与 BookingGuard 共用；booking 内调 `evaluatePrecheck` 重算，**废弃模型传的 `prechecked.nextAction`**。
- **验证点**：precheck 工具行为等价 + booking 不再信任模型 prechecked（构造伪造 prechecked 入参，gate 仍按权威重算拒绝）。

### PR-C — guardrail/ 目录归并（纯搬家）

- **依赖**：无（建议早做，给 PR-D 腾位）。
- **改动面**：建 `types/guardrail.contract.ts` 中立契约；`agent/guardrail/{input,output,catalog}`；迁 `input-guard`→input、`reply-fact-guard`→output/rule、`pre-agent-risk-intercept`→input/risk，并把原 `conversation-risk` 收敛进 `agent/guardrail/input/risk-intercept.service.ts` 高置信关键词风险拦截。**tool guardrail 物理留 tools/**（分层防环），仅登 catalog。
- **验证点**：行为等价 —— 全量跑现有 guard 相关测试，断言无行为差异（纯 import 路径 + DI 迁移）。
- **回滚边界**：纯结构迁移，易回滚；与语义变更分开提交。

### PR-D — output llm reviewer + rule 补两规则

- **依赖**：PR-C；`ModelRole.Review`（+ `.env AGENT_REVIEW_MODEL`）。
- **改动面**：`llm-reviewer.service.ts`（隔离上下文、强模型、只读、输入带 grounding=`toolCalls.result`+岗位数据+memory+redLines）；rule 补 `candidate_name_echo`、`distance_missing`；`OutputGuardrailService` 聚合 rule→llm→`pass|revise|block`+`severity`。
- **验证点**：reviewer 故障降级（高风险 block+转人工 / 低风险 fail-open）；触发条件（仅承诺/事实陈述/紧跟副作用工具才跑 llm 档）。

### PR-E — TurnOutcome 抽象 + runner 收口 + proactive 入口

- **依赖**：PR-A。
- **改动面**：
  - `TurnOutcome { kind: 'reply'|'skipped'|'blocked'|'handoff'; reply?; toolCalls; guardDecision?; runTurnEnd?; handoff?{reasonCode,sourceToolCall,idempotencyKey,alreadyDispatched} }`。
  - `AgentRunnerService.runTurn(TurnRequest)`：`trigger: {kind:'inbound', userMessage} | {kind:'proactive', directive, scenarioCode}`；proactive 把 directive 合成为输入起回合，透传 `toolMode`。
  - reply-workflow 改调 `runTurn`，把现有 `block/handoff` 映射收口进 outcome（`block` 带 `severity` → `blocked` vs `handoff`）。当时采用 `alreadyDispatched` 兼容工具内 dispatch；当前已进一步收敛到统一 outcome 副作用出口，见 handoff 真相文档。
- **验证点**：被动路径行为等价（现有 reply-workflow 测试全绿）；proactive 入口能起一个 readonly 回合产出 outcome（不投递）。
- **回滚边界**：被动路径必须零行为差异；proactive 是纯新增路径。

### PR-F — reengagement 模块（shadow mode）

- **依赖**：PR-E（proactive trigger + outcome）+ 权威停止条件（`lastCandidateMessageAt/terminal`，已在骨架；按需在 PR-B/阶段3 补写入时机）。
- **改动面**：新建 `agent/reengagement/`：
  - **F1** `scenario-registry.ts` —— `FollowUpScenario[]`：7 场景锚点/延迟/`stopUnless`（§5 表），先落事件锚点明确的 `opening_no_reply / booking_incomplete / interview_reminder`。
  - **F2** `follow-up-scheduler.ts` —— 锚点事件 hook（turn-end / ops-events 写入点）→ `queue.add('follow-up', payload, {jobId:'${sessionId}:${scenarioCode}:${anchorEventId}', delay:max(0,fireAt-now), attempts:2, backoff:fixed 30s})`；`computeFireAt`（绝对时间戳，9-21 窗口对齐，`Asia/Shanghai`）。⚠️ **Bull delay 是相对 ms，不是绝对 fireAt**。
  - **F3** `touch-ledger.*` —— outbox 状态机 `reserved → delivery_attempted → sent/failed/unknown`；频控 `countIn24h` **只数 sent**；`reserve` 命中 `sent` 跳过 / `reserved` 可重试 / `delivery_attempted` 不盲重投（靠渠道 idempotencyKey）。
  - **F4** `follow-up.processor.ts` —— `@Processor`：`shouldStop`(terminal/已回`lastCandidateMessageAt>anchorAt`/拒绝/场景特定) → 频控24h≤2 → `inWindow(now)` 二次确认 → `runner.runTurn({trigger:proactive, toolMode:'readonly', directive})` → outcome=reply 时 outbox deliver。
  - **F5** shadow 开关（`REENGAGEMENT_SHADOW=true`）：走完 shouldStop + runner.runTurn 但**不 deliver**，记「本应发X/命中场景Y/停止原因Z」。⚠️ shadow ≠ 无副作用：`toolMode:'readonly'` 物理禁副作用工具 + 不投递，**两者缺一不可**。
  - module：`BullModule.registerQueue(REENGAGEMENT_QUEUE)`（仿 group-task.module）。
- **验证点**（shadow）：① 触发命中率（该发的排程了吗）；② 停止条件正确（尤其「候选人已回」拦住）；③ guardrail 对主动话术拦截率；④ outbox 幂等（同锚点不重复、重投不误算频控）。
- **回滚边界**：shadow 默认开，不投递 → 零对外副作用；删 module import 即下线。

### PR-G — 补锚点事件 + 真发灰度

- **依赖**：PR-F shadow 验证通过；**[阻塞] 平台主动发消息限制核实**（企微外部联系人时间窗/配额，见 reengagement §8）。
- **改动面**：岗位展示工具 / 收资流程补 `store_presented` / `booking_incomplete` ops_events；按场景灰度关 shadow 开真发（先 `opening_no_reply/booking_incomplete/interview_reminder`，`new_job_for_waiting` 最后）。

---

## 3. 建议提交顺序与里程碑

| 里程碑 | 包含 PR | 价值 |
|---|---|---|
| M1 自证闸门收口 | PR-A + PR-B + PR-B2 | 解 P1 违规报名（51条最重）：副作用后不重复 + 候选人字段须 evidence + booking 不信模型 prechecked |
| M2 守卫归并 + 出站裁决 | PR-C + PR-D | output 从「告警」升级「裁决」，目录可审计 |
| M3 复聊接缝 | PR-E | runner 收口 outcome + proactive 入口（reengagement 前置） |
| M4 复聊 shadow | PR-F | 新需求 headline 上线（只排程不发，验证触发/停止） |
| M5 复聊真发 | PR-G | 灰度真发（依赖平台限制核实） |

> 并行性：PR-A / PR-B / PR-C 三者互不依赖，可并行开三条分支。PR-E 依赖 PR-A，PR-F 依赖 PR-E。

## 4. 全局风险与红线对账

- **[阻塞·真发前]** 企微/托管平台主动发消息配额与时间窗未核实 → 仅影响 PR-G，shadow 不受限。
- **状态并发**：写权威状态必须在处理锁内（现 turnEnd await 模式），杜绝跨 job 覆盖（reengagement processor 与被动回合可能并发同一 session）。
- **品牌口径**：复聊话术经 runner → 继承 red-lines/guardrail；真名/拉群/不夸大红线由 guardrail 强制，不靠 prompt。
- **测试基线**：每块上线前后跑 51 条忠实重放 + qwen3.7-plus 裁判，量化「未修复→已修复」。
```
