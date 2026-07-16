# 智能招募 Agent 可靠性重构设计

> 状态：实现完成基线（当前分支；后续增强项见 §12）。架构评审 2026-06-24，落地校准 2026-06-26。
> 日期：2026-06-23
> 背景输入：运营反馈 BadCase 复测（51 条未解决）+「蛋糕触发二次主动回复」需求 + 与 Codex 的架构讨论
> **文档族**（设计→详设→施工三层）：
> - 本文 = 总设计（根因、目标架构、模块设计、落地路线 §10、未决硬约束 §12）
> - [agent-reliability-hc-runtime-mechanisms.md](./agent-reliability-hc-runtime-mechanisms.md) = §12 HC-1/2/3 的 runtime 机制详设
> - [agent-reliability-implementation-roadmap.md](./agent-reliability-implementation-roadmap.md) = 拆成 PR-A…G 的施工计划 + 进度
> - [agent-reengagement-design.md](./agent-reengagement-design.md) = §5.4 复聊的实现级设计
> 关联：[feedback-repair-test-validation-v2.md](../../workflows/feedback-repair-test-validation-v2.md)、[badcase-trace-memory-evaluation.md](../../workflows/badcase-trace-memory-evaluation.md)

---

## 0. TL;DR

当前是**单 Agent、prompt 软约束**架构。51 条未解决运营反馈的根因不是"缺规则/缺校验"，而是**让生成方自己给自己签字**（模型既生成又自审、自我说服绕过约束）。

重构主线：**把"裁决业务正确性"的权力从模型手里收走，交给模型说服不了的独立层。** Agent 核心拆成 4 个职责清晰、命名对齐行业（OpenAI Agents SDK / Anthropic）的模块：

| 模块 | 角色 | 行业对应 |
|---|---|---|
| `generator` | 生成 agent（worker，会调工具/产生副作用） | OpenAI `Agent`；Anthropic evaluator-optimizer 的 *optimizer* |
| `guardrail` | 独立守卫（input / tool / output 三类，只读、有否决权） | OpenAI `guardrails`；Anthropic *evaluator* |
| `runner` | 编排一个回合；当前已承接 input/output guardrail、一次 revise、TurnOutcome / proactive seam | OpenAI `Runner` |
| `reengagement` | 主动触发调度（何时发起一个回合） | 业务/增长域术语（框架无对应，均为被动） |

复聊（二次触达）= `reengagement` 触发 → 复用 `runner` 接缝 → 继承 generator/tool runtime 安全基线与 output guardrail；企微 `reply-workflow` 当前调用 `runner.invokeReviewed()` 并只消费裁决结果，不另起发送系统。

---

## 1. 现状架构（精确版，含 file:line）

主链路 [reply-workflow.service.ts](../../../src/channels/wecom/message/application/reply-workflow.service.ts)：

```
processMessageCore（当前约 L203）
  → runner.precheckInput                      input guardrail：高危关键词同步暂停+告警（不短路）
  → ensureVisionDescriptionsReady             等图片 vision 描述回写
  → callAgent（当前约 L672） ── runner.invokeReviewed ──┐
  │                                     └─ AI SDK generate(tools, stopWhen)
  │                                          工具在 loop 内执行副作用（booking 同步调 sponge）
  │                                          stopWhen: skip_reply / request_handoff 短路
  │     OutputGuardrailService.check    rule 档 + 高风险 llm 档 + 一次 revise → outputDecision
  → [replay] 生成期间有新消息则丢弃重跑一次（deferTurnEnd 保护记忆）
  → isSkipped || outputDecision=block ? 跳过发送 : deliveryService.deliverReply（当前约 L458）
  → runTurnEnd（记忆投影/事实提取，与投递并行、return 前 await）
```

重构必须尊重的现有事实：

- **副作用在 loop 内同步发生**：`duliday-interview-booking.execute` 内同步调 `spongeService.bookInterview()` 真正报名，并 fire-and-forget `pauseUser()`。等 `callAgent` 返回再审查回复文本，**报名已成事实**。
- `REPLAY_BLOCKING_TOOL_NAMES` 把 `invite_to_group` 与 `duliday_interview_booking` 视为不可逆（命中则跳过 replay）；**`advance_stage` 明确不属于**（注释：阶段推进只动内部程序记忆）。
- **守卫已存在并下沉 runner**：出站确定性 rule guard 已迁到 [HardRulesService](../../../src/agent/guardrail/output/hard-rules.service.ts)，具体规则按领域拆在 [output/rules](../../../src/agent/guardrail/output/rules)，由 [OutputGuardrailService](../../../src/agent/guardrail/output/output-guardrail.service.ts) 组合 rule 档与高风险 llm 档，再由 [AgentRunnerService.invokeReviewed](../../../src/agent/runner/agent-runner.service.ts) 编排一次 revise。另有 [InputGuardrailService](../../../src/agent/guardrail/input/input-guard.service.ts) 与 [RiskInterceptService](../../../src/agent/guardrail/input/risk-intercept.service.ts)（生成前输入守卫）。
- **precheck 已算出全部准入信息**，但 booking 通过**模型自报的 `prechecked` 入参**信任它：
  ```ts
  // precheck.execute 返回（节选）
  { nextAction: 'ready_to_book'|'collect_fields'|'confirm_date'|'date_unavailable'|'age_rejected';
    bookingChecklist: { missingFields: string[] };
    ageBoundary: { severity: 'pass'|'boundary'|'hard_reject'|'unknown' };
    screeningChecks?: Array<{ label: string; failSignals: string[] }>;
    nameFieldGuard?: { suspicious: boolean; mustHandoff?: boolean }; healthCertGate?; }
  // booking.execute 入参（节选）—— prechecked 由模型填，可伪造
  { jobId; name; phone; age; genderId; interviewTime?;
    prechecked: { nextAction: 'ready_to_book'; missingFieldsCount: 0 } }   // ← 模型自证
  ```
- **toolCalls 带 result**：`AgentToolCall { toolName; args; result?; status?; durationMs? }`。
- **记忆已有结构化快照**：`memorySnapshot { currentStage; presentedJobIds; recommendedJobIds; sessionFacts; profileKeys }`；`sessionFacts` 含 `interview_info / preferences / presentedJobIds / schedulingConstraints / invitedGroups`。**但由 turn-end LLM 提取投影，非权威。**
- **调度基建齐全**：Bull delayed job、`@Cron`、`MessageSenderService.sendMessage`（直发）、`biz/group-task` 可作复聊调度模板。

---

## 2. 根因：两层「模型自证」

| 层 | 现状 | 后果（证据 case） |
|---|---|---|
| 工具层 | booking 信任模型自报 `prechecked.nextAction='ready_to_book'` | precheck 实为 `hard_reject`(黑龙江户籍)/`collect_fields`(缺真名/必填) 时，模型仍伪造该入参 → 违规报名 (recvneZX6s66zg、recvlF9ao4oxUN、recvlhuskPGLMX) |
| 回复层 | 红线写 prompt，模型同一次生成里自审 | 敏感拒绝外露 (recvmj9uX0Erwo)、岗位事实幻觉(晚班说早班/日结说月结)、口径越界(兼职提保险) |

**统一抽象**：模型同时是"执行者"和"合规裁判"，二者目标冲突（完成任务 vs 守约束），约束无独立否决权。**修复 = 把裁判独立出来。**

按失败机制分三类（决定用哪个模块修，不能一招通杀）：

| 失败机制 | 命中 | 主修模块 |
|---|---|---|
| 自证绕过（动作 + 话术） | P1、P5 | `guardrail`（tool + output） |
| 事实不可靠（自由复述 / 无据承诺） | P2、P6 | `guardrail`(output·一致性) + 结构化渲染 + 结果回流 |
| 上下文丢失（无状态 / 无置信度） | P3、P4 | 权威会话状态（§6） + geocode 置信度 |

（51 条逐条证据见 `.scratch/unresolved.json`，6 类系统问题 P1–P6 见附录 A。）

---

## 2.5 理论依据：2026 多智能体共识（设计铁律）

本设计"不上多 agent 团队、只用主 agent + 少数隔离验证器"，有 2026 的实证与理论支撑，不是个人偏好：

**业界共识**：自由协作 / peer-mesh 多 agent 退潮；活下来的只有**有界、拓扑匹配、各 agent 上下文隔离、带 gate 验证**的形态。Cognition《Don't Build Multi-Agents》与 Anthropic《多 agent 研究系统》(2025-06 对打) 在 2026 殊途同归到"**主 agent 独占完整上下文 + 隔离临时子 agent 做有界子任务**（无 peer-to-peer、无共享可变状态）"。

**核心理论结果（MIT，决策论）**：*没有新的外生信号时，任何委派型无环网络都被一个中心化贝叶斯决策者支配*。实测：agent 不带新信号时，准确率从单段 90.7% **崩到五段 22.5%**。"From Spark to Fire"级联论文：中心节点错误注入 → 100% 系统失败（**拓扑 > prompt**）。单 agent 在同等 token 预算下多跳推理仍胜多 agent（arXiv 2026）。

由此推出本设计的 **4 条铁律**：

1. **验证器必须带"新外生信号"，否则砍掉。** reviewer 若只是"另一个 LLM 拿同样信息再想一遍"，在决策论上被支配、堆多了准确率崩。验证按信号强度排序：**确定性 precheck 重算 / 红线（ground truth，最强）> 回复对齐 `toolCalls.result`（接地）> 隔离上下文 LLM reviewer（仅在接地时有信号）**。禁止再加"看同样信息的第二个 LLM"。
2. **拓扑要短。** `generator → verify →(revise≤1)`，不堆 stage——级联越深，早期错误越毒化下游、准确率越崩。**明确不采用"可插拔多 stage 流水线 / swarm"**（曾讨论，已否决）。
3. **重写有界。** revise ≤1 次，避免 dynamic-handoff 无限循环（Beam 列为头号失败模式）。
4. **高风险走人审（HITL）。** Anthropic Trend 4 + "fully delegate 仅 0-20%"：常规校验自动化、真正高风险/新颖动作（报名/拒绝）升级 `request_handoff`——"只审重要的"。

**招募场景判据**：顺序对话、需共享同一上下文、动作强依赖——正中"不该上多 agent"。故主体是**单一主 agent（generator）独占上下文**，验证用隔离子 agent + 确定性兜底，而非 agent 团队。（连看多多 agent 的 Anthropic，招聘案例 Fountain 也是后台批量并行，非实时对话回合。）

来源：[Lanham — What Actually Survived](https://medium.com/@Micheal-Lanham/multi-agent-in-production-in-2026-what-actually-survived-f86de8bb1cd1)、[Beam — Orchestration Patterns](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)、[Anthropic — 2026 Agentic Coding Trends](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf)、[Cognition vs Anthropic — smol.ai](https://news.smol.ai/issues/25-06-13-cognition-vs-anthropic)、[LangChain — How and when to build multi-agent](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems)。

---

## 3. 命名与行业对齐

仓库现有代码已是 OpenAI Agents SDK 风格（`Runner`、`Guard`/`InputGuard`、`request_handoff`），本设计沿用并补齐：

- `generator`：生成 agent。现为 [GeneratorService](../../../src/agent/generator/generator.service.ts)（OpenAI 称 `Agent`；它本就是"生成方/会动手的 worker"）。
- `guardrail`：OpenAI 的 input/tool/output guardrails。现 `InputGuardrailService` / `RiskInterceptService` = input，`HardRulesService` + `LlmReviewerService` = output，tool guardrail 物理仍留 tools 层但登记进 catalog。
- `runner`：OpenAI 的 `Runner`——"manages turns, tools, guardrails, handoffs, sessions"，即"编排一个回合"。当前已承接 `runTurn` outcome 编排、主动回合默认 readonly、output guardrail + revise 闭环。
- `reengagement`：主动触达。agent 框架均为被动响应、无对应原语，故采用业务域术语。
- `generator ↔ output-guardrail` 的"生成→审查→重写"循环，即 Anthropic 的 **evaluator-optimizer** 模式。

来源：[OpenAI Agents SDK — Guardrails](https://openai.github.io/openai-agents-python/guardrails/)、[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)、[Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)。

---

## 4. 目标架构总览

被动（候选人消息）与主动（复聊）两个触发源**汇入同一个 `runner.runTurn`**：

> **现状校准（2026-06-26）**：`AgentRunnerService.runTurn()` 已存在，负责主动/被动统一入参、`toolMode:'readonly'` 默认值、`TurnOutcome.kind='reply'|'skipped'|'blocked'|'handoff'` 与 handoff metadata；`invokeReviewed()` 已在 runner 内部完成 output guardrail + 一次 revise。企微被动链路不再直接裁决 output guardrail，只消费 runner 返回的 `outputDecision`。

```
被动: channels/wecom 收到候选人消息 ─┐
                                    ├─→ runner.runTurn(TurnRequest)
主动: reengagement 调度到点 ────────┘            │
                                                 ▼
                  ┌──────────── runner（编排一个回合）─────────────┐
                  │ 1. guardrail.input(userMessage)        通过?    │
                  │ 2. generator.invoke() ───────────┐             │
                  │      loop 内调副作用工具(booking)  │             │
                  │        → guardrail.tool(BookingGuard) 否决?     │
                  │ 3. guardrail.output(reply, toolCalls)          │
                  │      decision = pass | revise | block          │
                  │        revise → 回 2 重生成(带 violations,≤1)  │
                  │ 4. 产出 TurnOutcome（不投递）                   │
                  └────────────────────────┬───────────────────────┘
                                           ▼
                  ChannelDeliveryPort.deliver(outcome)   ← wecom 实现（依赖倒置）
                                           │
                                  runTurnEnd → 写权威状态(memory)
```

`runner` 之下 `generator`/`guardrail` 是 worker；`reengagement` 在 `runner` 之上做主动触发。**最终目标**：Agent 核心跨层依赖收敛为 **memory（权威状态）** 与 **ChannelDeliveryPort（投递）**，核心不 import channels。⚠️ **但这是目标态不是现状**——现 `ToolRegistryService` 仍直依赖 `RoomService`/`MessageSenderService` 等渠道实现，tool 侧渠道能力也需端口化（见 §12 HC-5），阶段 0 只抽 `ChannelDeliveryPort` 不等于已达渠道无关。

---

## 5. 模块设计

### 5.1 `generator/` — 生成 agent（worker）

**职责**：跑主 agent loop（模型 + 工具），产出候选回复 + toolCalls + 记忆快照。**不决定能不能发**。= 现 `AgentRunnerService` 正名为 `GeneratorService`。

```ts
@Injectable() class GeneratorService {
  invoke(params: GenerationParams): Promise<GenerationResult>;
}
interface GenerationParams {
  sessionRef: SessionRef; messages: Msg[]; modelId?: string;
  reviseFeedback?: GuardViolation[];        // revise 回路：带审查意见重生成
  toolMode?: 'scenario' | 'readonly' | 'none';
  // scenario: 按场景注册完整工具；readonly: 仅保留查信息/读状态工具，禁 booking/invite/modify/cancel 等副作用；
  // none: 物理空 toolset（HC-1 副作用后文本重写用）
  committedSideEffects?: string;            // HC-1：已提交副作用摘要，让重写只改措辞
  deferTurnEnd?: boolean;
}
interface GenerationResult {
  text: string;
  toolCalls: AgentToolCall[];               // 含 result —— output-guardrail 据此查"承诺是否有据"
  memorySnapshot: AgentMemorySnapshot;
  agentSteps: AgentStepDetail[]; usage; runTurnEnd?: () => Promise<void>;
}
```

**不变量**：generator 内调副作用工具时，工具自身先过 **tool guardrail**（§5.2），generator 无法跳过。

### 5.2 `guardrail/` — 独立守卫（只读、有否决权）

按 OpenAI 三类组织。**统一不变量**：① 全程只读、无副作用工具（独立性前提）；② 决策是 veto（block/reject），非建议；③ output 的 llm 档用与 generator 不同的模型角色。

```
guardrail/
  ├─ input/    input-guard.service.ts       生成前输入守卫
  │           risk-intercept.service.ts     高危关键词/人工介入 input guardrail
  └─ output/
        ├─ hard-rules.service.ts            确定性 rule 档调度
        ├─ rules/*.rule.ts                  按领域拆分的确定性规则
        ├─ llm-reviewer.service.ts          高风险语义 reviewer（独立模型角色）
        └─ output-guardrail.service.ts      组合 rule → llm，返回 pass/revise/block
```

当前 `OutputGuardrailService` 组合器与 `LlmReviewerService` 已创建，`AgentRunnerService.invokeReviewed()` 已编排 `generator → output guardrail → toolMode:'none' revise≤1 → 再审`。tool guardrail 因 in-loop 与 tools 依赖边界，物理仍留 tools 层，但遵守同一守卫语义并登记进 catalog。

#### guardrail 收紧：detect / decide / act 分层 + 统一目录

现状：guard 类逻辑曾散落在 `agent/input-guard`、`wecom/reply-fact-guard`、`wecom/pre-agent-risk-intercept`、`tools/duliday/*`（booking-guards/age/sensitive-screening/hard-requirements）、`conversation-risk/*`、`biz/strategy` 等。收紧的前提是认清 **guardrail 是「决策层」，高置信输入风险检测是 input guardrail 的内部能力**：

```
检测/信号(detect) ───────────→ 判定/否决(GUARDRAIL · decide) ──→ 执行/告警(act)
agent/guardrail/input/risk-intercept      agent/guardrail/input|output     intervention(pause托管)
strategy red_lines                  ↑ 统一契约 + 统一目录(catalog)   notification(告警)
(config 数据)                                                           message-sender
```

收紧动作 = **统一 `Guardrail` 契约 + 统一目录(可审计) + 把散在 wecom 的 input/output guard 物理归并到 `agent/guardrail/`，并将原 conversation-risk 收敛为 `risk-intercept.service.ts` 内部高置信关键词检测**。周围两类**不并入**：config（`strategy.red_lines`，guardrail 读它）、sink（`notification`/`intervention`，guardrail 触发）；渠道入站清洗（`filter.service`，留渠道，非业务 guardrail）。

**分层坑**：`AgentModule → ToolModule`，tool guardrail 必须 in-loop 执行（tools 层），若逻辑搬进 `agent/guardrail/` 会反向依赖成环。故 **tool guardrail 逻辑物理留 tools 层**（本就是工具域纯逻辑），但**遵守同一 `Guardrail` 契约、登记进 `agent/guardrail/catalog`**（目录引用，不反向依赖）。

迁移映射：

| 现状 | 性质 | 去向 |
|---|---|---|
| `agent/input-guard` | input guardrail | `agent/guardrail/input`（归位） |
| `wecom/reply-fact-guard` | output guardrail | `agent/guardrail/output`（搬） |
| `wecom/pre-agent-risk-intercept` | input guardrail（消费风险信号） | `agent/guardrail/input`（搬；调 intervention 用依赖倒置） |
| `tools/duliday/{booking-guards,age,sensitive-screening,hard-requirements}` | tool guardrail | **留 tools**，遵契约 + 登目录 |
| `conversation-risk/*` | input 高置信风险检测 | `agent/guardrail/input/risk-intercept.service.ts`（内聚归位） |
| `biz/strategy.red_lines` | config 数据 | 留，guardrail 读 |
| `notification/*`、`intervention` | sink/执行 | 留，guardrail 触发 |
| `wecom/filter.service` | 渠道入站清洗 | 留渠道 |

> 统一目录的治理价值（呼应 §2.5）：逐条审计"每个 guardrail 带不带新外生信号"，砍冗余（如 output 的 `discriminatory_screening_leak` 与 tool 的 `sensitive-screening` 两点不同时机都要，但要确认非同检查重复跑）。

#### prompt / tool / output 三层防线的职责边界

这三层不是替代关系，而是同一风险在不同控制点上的防线：

```text
候选人输入
  -> Prompt 约束模型怎么想、怎么说
  -> Tool guardrail 约束模型能不能执行这个动作
  -> Tool 返回结构化事实/错误
  -> Output guardrail 检查最终话术是否忠实、合规、可发送
  -> 候选人看到回复
```

| 层 | 本质 | 主要保护对象 | 典型职责 | 不能承担的事 |
|---|---|---|---|---|
| 主体 prompt | 生成引导 / 预防 | 模型行为倾向、话术风格 | 提醒不要泄漏内部状态、不要承诺名额、按工具结果说话、保持招聘顾问语气 | 不能作为 P0/P1 风险的唯一防线；模型会忘、会被上下文带偏、会自由发挥 |
| Tool guardrail | 动作门禁 / 执行前判定 | 系统状态、副作用、写库正确性 | booking 前必须 precheck；jobId 必须来自真实召回；姓名/硬筛/补充题不合格时拒绝提交 | 不能保证最终对候选人怎么解释；工具拒绝后模型仍可能说错话 |
| Output guardrail | 出站验收 / 最终 veto | 候选人可见回复、合规证据链 | 工具失败不能说成功；precheck 拦住不能说可约；不得暴露年龄/性别/户籍筛选；不得输出未接地岗位事实；不得泄漏阶段/工具/JSON | 不直接执行业务动作；需要依赖 tool result / 权威状态 / 用户原文等外生证据 |

一个典型例子：

```text
候选人不符合岗位硬要求
```

- Tool guardrail：拒绝提交 booking，保证系统不会真的帮 TA 约上，并返回结构化 `nextAction / errorType / reasonCode`。
- Output guardrail：禁止回复"预约成功"；禁止把敏感筛选条件说出口；要求改写成中性话术，例如推荐其他岗位、继续确认信息或转人工。
- Prompt：提前引导模型使用正确口径，降低违规概率，但不作为最终责任层。

因此设计原则是：

> **Prompt 让模型少犯错；Tool guardrail 让系统不被模型带着做错动作；Output guardrail 让最终发出去的话必须过验收。**

如果一条规则只写在 prompt 里，它更像"建议"。凡是会造成错约、误取消、误拉群、敏感筛选外露、工具失败反向成功、未接地岗位事实或内部实现泄漏的规则，必须有 tool 或 output 的硬护栏承接。

#### tool guardrail（BookingGuardrail）—— P1 自证的修复核心

```ts
@Injectable() class BookingGuardrailService {
  constructor(private session: SessionService) {}     // 读权威状态，不信模型 args
  gate(input: {
    jobId: number; sessionRef: SessionRef; requestedInterviewTime?: string;
    currentUserMessages: string[];   // HC-2：当前轮候选人原文，供 gate 内 parser 兜底解析+写权威态（防模型跳过 precheck 直调 booking）
    turnId: string;                  // 解析/写状态的事务关联
  }): Promise<BookingGateVerdict>;
}
interface BookingGateVerdict {
  decision: 'allow' | 'reject_collect' | 'reject_hard';
  missingFields: string[]; failedScreenings: string[];
  ageBoundary: 'pass'|'boundary'|'hard_reject'; nameSuspicious: boolean; reasonForHandoff?: string;
}
```
- 候选人字段从**权威会话状态**读取，不取模型 `args`；
- 内部调 `evaluatePrecheck(job, candidate)`（从 precheck 工具抽出的纯函数，`tools/shared/precheck-core.ts`），得权威裁决，**废弃模型传的 `prechecked`**；
- 三分支：`allow`→执行副作用；`reject_collect`→返 `buildToolError`，loop 继续收资（可重试）；`reject_hard`(户籍/年龄/可疑姓名/命中 failSignal)→**booking 工具返回统一 `shortCircuited` gate result（携 `reasonCode`），由 `runner.stopWhen` 识别停 loop → 产出 handoff outcome；dispatch intervention 由 outcome 层做、不由 gate 做**（gate 只判定、保持只读）。**不可仅靠返回 `_replyInstruction`——模型会忽略。** 见 §12 HC-3。
- **权威字段准入**：booking 读的候选人字段不能是"模型工具参数单独落的权威态"（现 precheck 把模型 `candidateName` 等直接 override 进 knownFieldMap）。准入规则见 §12 HC-2。
- **归属/执行位点（破环）**：`BookingGuardrailService` 须 in-loop 执行且注入 `SessionService`（memory），若放 `agent/guardrail/` 会致 `tools→agent` 循环依赖。故**物理留 `tools/`**，实现**中立层契约** `Guardrail`（`src/types/guardrail.contract.ts`，agent 与 tools 共用），并登记进 `agent/guardrail/catalog`（agent→tools 方向允许，不成环）；由 `duliday-interview-booking.tool` 在 `execute` 首行调用（副作用之前）。详见 §7。

#### output guardrail

```ts
@Injectable() class OutputGuardrailService {
  check(input: OutputGuardInput): Promise<GuardDecision>;   // rule → 需要时 llm → 汇总
}
interface OutputGuardInput { reply: string; toolCalls: AgentToolCall[]; memorySnapshot: AgentMemorySnapshot; redLines: string[]; }
interface GuardDecision {
  decision: 'pass' | 'revise' | 'block'; riskLevel: 'low'|'medium'|'high';
  violations: Array<{ type: 'hallucinated_fact'|'unsupported_commitment'|'policy_violation'|'bad_tone'|'wrong_stage'; evidence: string; suggestion: string }>;
}
```
切分铁律（呼应 §2.5）：**rule 层 = 能对齐 ground truth 的可机判模式（便宜、确定、每条都跑、可硬 block）；模型层 = 规则表达不了的语义/语气/意图（贵、只在高风险跑、输入必须带 grounding，不能 vibes 重读）。**

**rule 层（`HardRulesService`，确定性，先跑）**——每条都对齐一个外生事实：

| ruleId | check（对齐的 ground truth） | 状态 |
|---|---|---|
| `discriminatory_screening_leak` | 回复含户籍/民族/残障筛选词 → **block** | 已有 |
| `group_promise_without_invite` / `group_full_without_invite` | 承诺/声称群相关，但本轮无 `invite_to_group` 成功 | 已有 |
| `salary_fabrication` | 回复的节假日/周末薪资差，岗位数据里没有 | 已有 |
| `booking_form_field_mismatch` | 收资模板字段 ≠ `precheck.requiredFieldsToCollectNow` | 已有 |
| `parttime_insurance_mention` | 岗位数据=兼职，回复却提"保险/五险一金" | 新（51 条） |
| `candidate_name_echo` | 回复含候选人昵称/姓名（对齐 `contactName`） | 新（51 条） |
| `distance_missing` | 有岗位推荐结构但无公里数 | 新（51 条） |

**模型层（`LlmReviewer`，高风险才触发，强模型）**——输入 = 回复 + `toolCalls.result` + 相关岗位数据 + memory + redLines（带 grounding 才有新信号）：

| violation type | check 什么 | 为何 rule 层做不了 |
|---|---|---|
| `hallucinated_fact` | 回复说的班次/结算/工期/距离 与 `toolCalls.result` **语义矛盾**（早班↔晚班、日结↔月结） | rule 只抓精确模式，改述/语义不一致要 LLM |
| `unsupported_commitment` | "已帮你约好/名额留着" 但本轮无 `booking.success`/无记忆支撑 | 需理解"承诺"语义并对齐工具结果 |
| `wrong_stage` | 未收资就确认报名、候选人没问却推别的店 | 阶段语义判断 |
| `bad_tone` | 话术僵硬/重复问/像机器人（那批话术 case） | 纯语气，只能 LLM 判 |
| `intent_mismatch` | 误解意图（说不要必胜客还推必胜客；把寒暄当定位） | 语义 |

- 触发 llm 档的条件：回复含承诺/事实陈述，或紧跟副作用工具——控延迟成本，纯寒暄/问位置跳过。
- 聚合：rule 层可硬 block（如歧视）；其余 rule 命中 + 模型层裁决 → 汇成最终 `pass | revise | block`。

### 5.3 `runner/` — 回合编排

**职责**：把 generator 与 guardrail 串成**一个已审回合**，管 revise 回路与 turn-end 交接。**渠道无关**，被动/主动复用的接缝。**不负责投递**。

> **当前状态**：`AgentRunnerService` 已是被动/主动共用接缝，`runTurn()` 会构造 `GeneratorInvokeParams`、设置主动回合 `toolMode:'readonly'`、归一 `TurnOutcome` 与 handoff metadata；`invoke()`/`stream()` 仍薄委托 `GeneratorService`，`invokeReviewed()` 已注入 output guardrail 并执行一次 revise 回路。

```ts
@Injectable() class AgentRunnerService {
  constructor(private generator: GeneratorService,
              private output: OutputGuardrailService,
              private input: InputGuardrailService) {}
  runTurn(req: TurnRequest): Promise<TurnOutcome>;
}
interface TurnRequest {
  sessionRef: SessionRef;
  trigger: { kind: 'inbound'; userMessage: string; images?: string[] }
         | { kind: 'proactive'; directive: string; scenarioCode: string };  // 复聊
  context: TurnContext; modelId?: string;
  toolMode?: GenerationParams['toolMode'];   // 复聊 shadow/主动触达用 readonly；runner 透传给 generator/preparation
}
interface TurnOutcome {
  kind: 'reply' | 'skipped' | 'blocked' | 'handoff';
  reply?: AgentReply; toolCalls: AgentToolCall[];
  guardDecision?: GuardDecision; runTurnEnd?: () => Promise<void>;
  handoff?: {                                // HC-3：handoff 元数据 + 幂等
    reasonCode: string; reason?: string;
    sourceToolCall: string;                  // 'duliday_interview_booking' | 'request_handoff'
    idempotencyKey: string;                  // `${chatId}:handoff:${turnId}` —— 与现有 request_handoff 一致
    alreadyDispatched?: boolean;             // 迁移兼容字段；当前 request_handoff 已收敛到 outcome 副作用出口
  };
}
```
**流程**：`input 守卫 → generator.invoke → output 守卫 →` `pass` 产出 reply / `revise≤1` / `block`。

⚠️ **`block` 与 `handoff` 是两种不同终态，勿混**：
- **`blocked`（不发+观测）**：output guard 命中话术/口径/事实问题，**本轮沉默不发、记观测告警**，**不暂停托管、不 @ 人**。
- **`handoff`（不发+转人工+pause+告警）**：由 tool/runtime 层明确产生，如 `request_handoff` 或 booking gate hard-reject；runner 在 `TurnOutcome.handoff` 携带幂等 metadata。

⚠️ **revise 不再全量重跑业务逻辑**：
- 当前实现统一使用 `toolMode:'none'` 做 no-tool 文本重写（≤1 次）。
- 二次 output guard 使用 `draft.toolCalls ∪ rewritten.toolCalls`，最终 result/outcome 保留 draft 已提交副作用工具结果，避免“已约好”因 rewritten 无工具而被误判无据。见 §12 HC-1。

### 5.4 `reengagement/` — 主动触发调度

> **实现级方案见**：[agent-reengagement-design.md](./agent-reengagement-design.md)（7 场景锚点映射、Bull delayed job 触发、停止条件、9-21 窗口/频控、shadow mode、平台主动发消息限制风险）。

**职责**：决定**何时**主动发起一个 turn，只管"主动"这一种触发源。下方只保留模块轮廓；**processor/outbox/shadow 的实现细节以 [agent-reengagement-design.md](./agent-reengagement-design.md) §3-§7 为准**，包括 `toolMode:'readonly'`、`reserved → delivery_attempted → sent/failed/unknown` 触达底账，以及 shadow = 禁副作用 + 不投递。

```
reengagement/
  ├─ ScenarioRegistry    结构化场景配置（FollowUpScenario[]，非 prompt 常量）
  ├─ TriggerEvaluator    读权威状态 → 命中哪个场景
  ├─ Scheduler           @Cron 扫描 + Bull delayed job（9-21 窗口、频控 ≤2/24h）
  └─ TaskProcessor       @Processor：到点 → 代码校验停止条件 → 构造 proactive TurnRequest
                                 → runner.runTurn → ChannelDeliveryPort.deliver
```
```ts
interface FollowUpScenario {
  code: string;                 // 'opening_no_reply' | 'address_missing' | 'booking_incomplete' | ...
  trigger: TriggerRule;         // 基于权威状态的条件 + 时间偏移
  objective: string;            // 跟进目标（喂 generator）
  allowedContext: string[]; requiredEvidence: string[];
  cooldown: Duration; maxTouchesPer24h: number; stopSignals: string[];
  generationPolicy: string;     // 语气与禁止项（不夸大/不承诺/不骚扰）
}

@Processor('reengagement') class FollowUpTaskProcessor {
  constructor(private state: SessionService, private runner: AgentRunnerService, private delivery: ChannelDeliveryPort) {}
  async process(job) {
    const s = await this.state.getAuthoritativeState(job.sessionRef);
    if (this.hitStopSignals(s, job)) return;                       // terminal/已先回/超频 → 取消
    const outcome = await this.runner.runTurn({ sessionRef: job.sessionRef,
      trigger: { kind: 'proactive', directive: job.directive, scenarioCode: job.scenarioCode },
      toolMode: 'readonly', context: ... });                        // 主动回合禁副作用工具
    if (outcome.kind === 'reply') await this.outboxDeliver(outcome); // reserve/attempted/sent/unknown，见子文档
  }
}
```
**不变量**：停止条件（已报名/已转人工/候选人已先回/超频）在**调 LLM 之前用代码 + 权威状态**判定。复用 `runner` → 主动回合自动继承全部 guardrail。第一版 **shadow mode** = `toolMode:'readonly'` 禁副作用 + 不 deliver，验证触发/停止后再开低风险场景。

---

## 5.5 提示词规则迁移：从「规则手册」到「生成引导」（A/B/C/D）

主体提示词（已 section 化：`red-lines / policy / hard-constraints / stage-strategy / thresholds / identity / static` 等，业务规则来自 DB `strategy_config`）里写了大量规则。但**规则写在 prompt 里 = 模型自审 = §2 的根因**。原则：

> **按"能用什么强制"给每条 prompt 规则分类，搬到最强的执行器；prompt 只留"天生要靠生成"的部分。**

| 类型 | 例子 | 现状 | 搬到哪 |
|---|---|---|---|
| **A 可校验的硬约束/红线** | 不要真名不报名、户籍/年龄限制、承诺拉群必须真拉、不泄歧视条件、不编薪资 | red-lines/policy section | **guardrail 强制**（tool/output）。prompt 保留一句作引导（降违规率），**权威在 guardrail**——单一数据源 `strategy_config.red_lines` 同喂 prompt(引导)+guardrail(执行) |
| **B 可确定性渲染的事实/口径** | 班次/结算/工期/社保口径、距离、兼职不提保险 | 散在 prompt 提醒"要说对" | **结构化渲染，从 prompt 删**。事实由模板从字段渲染，模型不自由复述 |
| **C 流程/阶段时序** | 先报名再面试、先筛再收、集中面试直接给时间 | stage-strategy/hard-constraints section | **状态机 + 工具门禁**（booking gate 强制"收齐才报"），部分留 prompt 引导 |
| **D 天生要靠生成的** | persona/语气/话术风格/开场白/共情/委婉 | identity/static section | **留 prompt**——prompt 的本职；guardrail 只能"检查"语气、生成不出来 |

**关键转变**：prompt 从"规则手册（被自审绕过）"瘦身成"生成引导 + 简短红线提醒"；A/B/C 的**强制力**移交 guardrail/渲染/状态机。

与 §5.2 的三层防线一致：prompt 的价值是预防和降低违规率，不是替代执行器。A 类硬约束最终必须落到 tool/output；B 类事实口径优先结构化渲染或 output 对账；C 类流程时序优先状态机/工具门禁；D 类生成风格才是 prompt 的主场。

**落地抓手**：prompt 已 section 化 → 逐 section 标注属于 A/B/C/D。B 类整段删（转渲染）；A 类瘦身成提醒（执行交 guardrail 读同一 `red_lines`）；C 类部分交状态机；D 类保留。prompt 体积与"被绕过的规则"一起降。

---

## 6. 跨层依赖（不属 4 模块，但被其依赖）

### 6.1 权威会话状态（memory/）—— 解 P3/P4

把对门禁/复聊关键的状态从"turn-end LLM 投影"升级为"**确定性事件点系统写入**"：

```ts
interface AuthoritativeSessionState {
  collectedFields: Partial<Record<CandidateFieldKey, CollectedField>>;  // ★ HC-2：每字段带 provenance/evidence/at，非裸值
  recalledJobIds: Set<number>;                 // ★ HC-2：本会话真实召回集（jobId provenance 成员判定）
  hardConstraints: Array<{ kind: 'shift'|'duration'|'location'|'household'|'other'; value: string; source: 'candidate'|'precheck' }>;
  presentedStores: Array<{ storeId; jobId; presentedAt }>;       // store 粒度，补 presentedJobIds 不足
  stage: string | null;
  location?: { raw: string; geocoded?: GeoResult; confidence: 'high'|'low'|'ambiguous' };
  lastCandidateMessageAt: number;              // 复聊停止条件用
  terminal?: 'booked'|'handed_off'|'rejected'|'onboarded';
}
// CollectedField 定义见 HC 文档 §HC-2（{value, provenance, evidence?, at}）；
// collectedFields 用 CollectedField（带 provenance），不是裸 Partial<CandidateFields>。
// SessionService 扩展
getAuthoritativeState(ref): Promise<AuthoritativeSessionState>;
patchAuthoritativeState(ref, patch): Promise<void>;
```
写入时机（确定性）：岗位展示工具后写 `presentedStores`；geocode 后写 `location.confidence`；每条候选人消息更新 `lastCandidateMessageAt`。

⚠️ **`collectedFields` 有 evidence 准入**（§12 HC-2）：仅当字段来自 ① 候选人原文确定性解析、② 成功 booking 回写、③ 其他确定性来源 才落权威态；**模型工具参数单独不构成权威**（可存"待确认草稿"，但 BookingGuard 不据此放行）。

⚠️ **记忆写入二分**（§12 HC-4）：「对用户说过」记忆 ← **仅** output 守卫 pass 且**投递成功**的最终文本（revise 前草稿 / 被拦草稿 / 投递失败 均不写）；「已发生副作用」状态（如 booking 成功）← 无论回复是否被拦/投递成功**都要落**（副作用真发生了）。`deferTurnEnd` 不足以表达此二分，需按此实现。

geocode 返回 `{ confidence; candidates[] }`：`ambiguous`→罗列候选让选/请发定位；`low`→追问（禁止未定位就拒绝，解 recvnfKkRn3J9k）。

### 6.2 投递端口（依赖倒置）

```ts
// agent/reengagement/channel-delivery.port.ts —— agent 定义接口
interface ChannelDeliveryPort { deliver(outcome: TurnOutcome): Promise<void>; }
// channels/wecom/message/delivery.service.ts —— wecom 实现并绑定 token
```
被动路径同样：`channels/wecom/message` 收消息 → `runner.runTurn(inbound)` → 用 delivery 投递。

⚠️ **依赖倒置的范围远不止投递端口**（§12 HC-5）：现状 `AgentModule` 直接 import `CustomerModule`、`ToolRegistryService` 直接依赖 `RoomService`/`MessageSenderService` 等渠道实现。要真正做到 agent 核心不依赖渠道，**tool 侧渠道能力（拉群/发送）也得端口化**（`RoomPort`/`SenderPort`），不只 `ChannelDeliveryPort`。

---

### 6.3 多渠道适配（企微 / 微信小程序）

渠道无关的 agent 核心 + `ChannelDeliveryPort` 正是为此准备（prompt 已有 `channel.section`）。要补的是**入站也适配器化**，不只出站。按渠道相关性切：

| | 企微 | 微信小程序 | 归属 |
|---|---|---|---|
| 传输 | webhook 异步回调 | 多半同步 HTTP 请求-响应 | 渠道适配器 |
| 消息聚合/debounce/replay | 有（静默窗口合并） | 同步对话通常没有 | 渠道层（留 reply-workflow，小程序不走） |
| 身份模型 | corpId/externalUserId/imContactId/botUserId | openid/unionid/session | 渠道适配器 → 归一成 `SessionRef` |
| 消息类型 | 图片/语音/位置/表情 | 可能不同 | 渠道适配器归一 |
| 投递 | 托管平台 API + 打字延迟分段 | HTTP 响应体 / 客服消息推送 | `ChannelDeliveryPort` 实现 |
| generator / guardrail / runner / 记忆 / 工具 | — | — | **共享核心** |

**两个要先拍板的设计点：**
1. **同步 vs 异步**：小程序若同步请求-响应，`runner.runTurn` 返回的 outcome 直接进 HTTP body；企微异步投递。runner 渠道无关（返回 outcome 不投递）两者都接——但 **debounce/合并/replay 是企微特有**，不下沉进核心。
2. **跨渠道身份（unionid）**：同一微信用户在小程序(openid)与企微(externalUserId)可能是同一人（unionid 关联）。要不要**跨渠道共享会话记忆**需产品先定；若要，记忆须按 unionid 这类稳定跨渠道 ID 存，而非企微易变的 wxid（呼应"换 wxid 裂两行"坑）。

`channel.section` 已存在 → prompt 可按渠道微调话术（如小程序是否仍维持"真人招募经理"人设）。

---

## 7. DI / 目录树

```
types/
  guardrail.contract.ts       Guardrail 契约 + GuardVerdict（中立层；agent 与 tools 共用 → 破环）

agent/
  generator/
    context/    context.service.ts / prompts / sections
    generator.service.ts
    generator.types.ts
    preparation.service.ts
    tool-call-analysis.ts
  guardrail/
    catalog.ts                                       (统一目录/注册表；逐条审计"新外生信号")
    input/      input-guard.service.ts               (实际文件；export InputGuardrailService)
                prompt-injection.service.ts          (prompt injection / 越权指令检测)
                risk-intercept.service.ts            (高置信关键词风险拦截)
    output/     hard-rules.service.ts                (确定性 rule 档调度)
                rules/*.rule.ts                      (按领域拆分的确定性规则)
                output-guardrail.service.ts          (组合 rule→llm)
                llm-reviewer.service.ts              (ModelRole.Review 高风险 reviewer)
    （tool guardrail 不在此 —— 因分层物理留 tools/，见下）
  runner/       agent-runner.service.ts               (runTurn + output/revise + TurnOutcome)
                agent-runner.types.ts
  reengagement/ scenario-registry / scheduler / processor / touch-ledger
                channel-delivery.port.ts             (可选注入；当前 wecom 未绑定)

tools/
  duliday/booking/booking-guardrail.service.ts       (tool guardrail；in-loop 执行、注入 memory、实现中立契约、登 catalog)
  shared/precheck-core.ts                            (新；evaluatePrecheck 纯函数，precheck 工具与 BookingGuardrail 共用)
  duliday/{age,sensitive-screening,hard-requirements}.util  (现有 tool guard，遵契约 + 登 catalog)

memory/         session.service.ts                   (扩展权威状态)
llm/llm.types.ts  ModelRole.Review = 'review'        (已新增；LlmReviewerService 使用)

channels/wecom/message/
  reply-workflow.service.ts   被动：intake/merge/replay → runner.invokeReviewed → 投递
  delivery.service.ts         现有投递实现；尚未绑定 ChannelDeliveryPort token
  （pre-agent-risk-intercept、reply-fact-guard 迁出 → agent/guardrail/）
```

依赖方向（无环）：`reengagement → runner → {generator, guardrail.input/output} → {memory, llm}`；`agent/guardrail/catalog → tools`（tool guardrail，agent→tools 允许）；**guardrail 全员与 tool guardrail 都 import 中立 `types/guardrail.contract.ts`（破环关键，tools 不反向依赖 agent）**；`channels/wecom → runner`。`ChannelDeliveryPort` provider 尚未绑定，真发复聊仍受上线门槛保护。

---

## 8. 系统问题 × 机制 覆盖矩阵

| 问题 | guardrail.tool | guardrail.output | 权威状态 | 渲染 | 结果回流 |
|---|:--:|:--:|:--:|:--:|:--:|
| P1 准入 | ✅主 | ⚪ | ✅(权威字段) | | |
| P2 事实 | | ✅(一致性) | | ✅主 | |
| P3 定位 | | ⚪兜底 | ✅主(置信度) | | |
| P4 状态 | | ⚪ | ✅主 | | |
| P5 话术/敏感 | ⚪ | ✅主 | | | |
| P6 结果 | | ⚪ | | | ✅主 |

> 无单一机制覆盖全部：`guardrail` 吃 P1/P5/P2(一致性)；P3/P4 必须靠权威状态。

---

## 9. 失败 / 并发 / 幂等

- **门禁误杀**：`reject_collect` 可重试；`reject_hard` 转人工（不丢弃，有人工兜底）。配可观测看误拒率。
- **reviewer 故障**：调用失败时按风险等级降级——高风险 **block + 转人工**（不放行未审回复），低风险 fail-open。
- **revise 死循环**：硬上限 1 次，超则 block。
- **复聊重复发**：排程幂等键 `${sessionId}:${scenarioCode}:${anchorEventId}`；发送侧用 outbox 状态机 `reserved → delivery_attempted → sent/failed/unknown`，频控只统计 `sent`；`lastCandidateMessageAt > anchorAt` 防"候选人已回还发"。
- **状态并发**：写权威状态必须在处理锁内（现 `turnEndPromise` 在方法返回前 await），杜绝跨 job 覆盖。
- **延迟预算**：output 的 llm 档仅高风险触发；reviewer 用独立并发池，不抢主回复。

---

## 10. 落地路线

> 阶段用「阶段 N」编号，**与系统问题 P1–P6（§8）不是一回事**，勿混。

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **阶段 0a** 纯搬家（行为不变，纯结构迁移，易回滚） | 已完成：`GeneratorService`、`AgentRunnerService`、`ChannelDeliveryPort`、`guardrail` 目录/catalog、中立 `Guardrail` 契约、`AuthoritativeSessionState` 骨架。 | — |
| **阶段 0b** 语义变更（行为变，需独立验证） | 已完成基线：`toolMode` 物理工具集、`reviseFeedback`/`committedSideEffects` 接缝、`deferTurnEnd` 采纳后触发；副作用成功正向判定、output guardrail + 一次 revise 已落。 | 阶段 0a |
| **阶段 1a** `guardrail.tool` BookingGuardrail（权威 gate + 硬拒强制 handoff） | 已完成基线：jobId provenance 成员判定、booking name gate、booking hard-reject `{shortCircuited,gateRejected,reasonCode}`、handoff outcome 三态派发。全量 `evaluatePrecheck` 抽纯函数化为后续增强。 |
| **阶段 1b** `guardrail.output` LlmReviewer（强模型）+ rule 补规则 + `runner` revise 回路 | 已完成 rule guardrail 迁移与 3 条规则补齐；`OutputGuardrailService` 组合器、`llm-reviewer.service.ts` 与 `AgentRunnerService.invokeReviewed()` 一次 revise 回路已落。后续增强集中在 reviewer 阈值/观测集/更细规则校准。 |
| **阶段 2** 岗位事实结构化渲染 + geocode 置信度 | 承接 §5.5 **B 类** prompt 规则（事实口径转渲染、从 prompt 删） |
| **阶段 3** 权威状态补全：`presentedStores/location/lastCandidateMessageAt/terminal`。进展：`lastCandidateMessageAt`、`terminal` 已确定性写入；`presentedStores` 已由投递后岗位展示锚点与 session 投影覆盖；`location` 由既有高置信事实/geocode 继续增强。 | 渗透展示/geocode 工具 |
| **阶段 4** `reengagement` shadow mode → 低风险场景开放。进展：shadow、touch-ledger/outbox、补偿查询、6 个仓库内锚点、默认真发保护均已落；`new_job_for_waiting` 等待外部 job-published 事件源。 | 阶段 3 的状态停止条件 |
| **阶段 5** reviewer 结果入观测表 → 幻觉数据集反哺 prompt/规则/测试集 | — |

> - **阶段 1a 优先于 1b**：违规报名是 51 条里业务后果最重、且 output 守卫拦不住（副作用在 loop 内）的一类。
> - **权威状态分两步落**：阶段 1a 只需 `collectedFields/hardConstraints` 最小切片；阶段 3 补全其余字段——解决"门禁依赖状态、状态却排在后面"的倒挂。
> - **prompt A/B/C/D 迁移（§5.5）随各阶段落**：B(渲染)随阶段 2、A(红线强制)随阶段 0/1 的 guardrail、C(时序)随阶段 3 状态机、D 保留。
> - **多渠道（§6.3）**：**delivery / runner 接缝**在阶段 0a 完成；**完整"渠道无关"还需 tool 侧端口化（HC-5，`RoomPort`/`SenderPort`）后续完成**——阶段 0 不等于已达渠道无关。微信小程序适配器是后续产品驱动的新增，届时再补 tool port。

---

## 11. 验证

复用复测/裁判基建（[feedback-repair-test-validation-v2.md](../../workflows/feedback-repair-test-validation-v2.md)）：以本次 51 条为回归基准，每组件上线前后跑忠实重放 + qwen3.7-plus 投诉感知裁判，量化"未修复→已修复"转化；guardrail/门禁单独用 BadCase/GoodCase 标注集校准 block/revise/reject 阈值、监控误杀率；reengagement shadow mode 用真实事件回放校验触发与停止条件。

---

## 12. 硬约束完成态与后续增强

> 来自架构评审（2026-06-24）。HC-1/2/3 的 runtime 机制已在当前分支落地，详见 [agent-reliability-hc-runtime-mechanisms.md](./agent-reliability-hc-runtime-mechanisms.md)。本节保留完成态与后续增强边界，避免把增强项误读为上线阻塞。

**HC-1（P0）副作用后的 revise 只能"无工具文本重写"，不能全量重跑 generator。**
prepareStep 的副作用屏蔽只在同一次 AI SDK loop 内生效（[generator.service.ts](../../../src/agent/generator/generator.service.ts#L286)）；现有代码已对命中 `invite_to_group`/`booking` 的回合跳过 replay（[reply-workflow.service.ts](../../../src/channels/wecom/message/application/reply-workflow.service.ts#L323)）。
→ 已完成 runtime 接缝与 runner 编排：正向副作用判定、`toolMode:'none'`、`reviseFeedback`、`committedSideEffects`、一次 revise、二次审查使用 `draft.toolCalls ∪ rewritten.toolCalls`，最终 result/outcome 保留已提交副作用工具结果。

**HC-2（P0）权威状态字段必须有 evidence 准入，模型工具参数单独不构成权威。**
precheck 把模型入参 `candidateName/...` 直接 override 进 `knownFieldMap`（[precheck.tool.ts:490](../../../src/tools/duliday-interview-precheck.tool.ts#L490)）；若写入权威态，模型仍可换字段"自证"。
→ 已完成基线：jobId provenance 成员判定、候选人原文 parser/name gate、模型参数不构成 jobId/name runtime 准入 evidence。Sponge 全字段 normalizer 与全量 `evaluatePrecheck` 抽纯函数化为后续增强。

**HC-3（P1）reject_hard 的短路必须由 runner/tool runtime 保证，不能交给模型。**
工具内不能调另一个 AI 工具；booking 自己 dispatch intervention 就破坏"只读"；只返 `_replyInstruction` 模型会忽略。runtime 已对任意 `shortCircuited=true` 的 tool result 停 loop。
→ 已完成：booking hard-reject 返回统一 `shortCircuited` gate result（携 `gateRejected + reasonCode`）→ `runner.stopWhen` 识别停 loop → `TurnOutcome.kind='handoff'` → outcome 处理层对 booking gate 路径执行 handoff（pause+告警），gate 只判定。

**HC-4（P1）记忆写入边界二分。**
lifecycle 现接收被采纳 assistantText（[generator.service.ts](../../../src/agent/generator/generator.service.ts#L397)），但 revise 前草稿/被拦草稿/未投递成功的回复都不应写入"已对用户说过"。
→ 已完成基线：`deferTurnEnd` 只在最终采纳/投递路径触发；booking/handoff 等已发生副作用写 `terminal`，供复聊停止条件消费。更细粒度的副作用状态投影可继续增强。

**HC-5（P2）渠道无关核心抽离范围被低估：tool 侧渠道能力也要端口化。**
`AgentModule` import `CustomerModule`（[agent.module.ts](../../../src/agent/agent.module.ts#L11)）、`ToolRegistryService` 依赖 `RoomService`/`MessageSenderService`（[tool-registry.service.ts](../../../src/tools/tool-registry.service.ts#L36)）。
→ 阶段 0 范围修正：tool 侧渠道能力端口化（`RoomPort`/`SenderPort`），不只 `ChannelDeliveryPort`；工程量大可降范围（先 delivery+核心抽离，tool 端口推迟到小程序落地），但**不可声称阶段 0 已达渠道无关**。

**HC-6（P3，已修正）** `REPLAY_BLOCKING_TOOL_NAMES` 只含 `invite_to_group` + `duliday_interview_booking`，`advance_stage` 不属于（[reply-workflow.service.ts](../../../src/channels/wecom/message/application/reply-workflow.service.ts#L58)）。§1 已更正。

---

## 附录 A：证据与 6 类系统问题

P1 准入闸门(~10) / P2 岗位事实口径(~9) / P3 定位歧义(~9) / P4 会话状态(~5) / P5 话术敏感(~6) / P6 工具结果(~3)。
数据：`.scratch/unresolved.json`（51 条）、`.scratch/judge-verdicts.json` / `rejudge-verdicts.json`、`.scratch/replay-ops-faithful-results.json`、飞书 BadCase 表 `FEISHU_BITABLE_BADCASE_*`。

## 附录 B：关键代码位点（已核实）

- [reply-workflow.service.ts](../../../src/channels/wecom/message/application/reply-workflow.service.ts)：`processMessageCore`、`callAgent` 调用 `runner.invokeReviewed()`、消费 `outputDecision`、投递、replay 丢弃；booking gate handoff outcome 派发与幂等底账
- [hard-rules.service.ts](../../../src/agent/guardrail/output/hard-rules.service.ts)：`check` 与确定性出站规则调度；具体规则见 [output/rules](../../../src/agent/guardrail/output/rules)
- [generator.service.ts](../../../src/agent/generator/generator.service.ts)：`invoke`、`stopWhen`、副作用工具屏蔽、`deferTurnEnd` lifecycle —— 原 `runner.service.ts` 正名为 `generator`
- [agent-runner.service.ts](../../../src/agent/runner/agent-runner.service.ts)：`precheckInput`、`invokeReviewed`（output guardrail + revise≤1）、`runTurn`、主动回合 `toolMode:'readonly'`、`TurnOutcome`/handoff metadata
- `src/tools/duliday-interview-precheck.tool.ts` / `duliday-interview-booking.tool.ts` / `src/tools/shared/precheck-core.ts`：precheck 校验、booking jobId/name runtime gate、`precheck-core` 已承载可抽纯的共享判定原语；全量 `evaluatePrecheck` 可继续增强
- [llm-executor.service.ts](../../../src/llm/llm-executor.service.ts)：`generateStructured`（reviewer 入口）；[llm.types.ts](../../../src/llm/llm.types.ts)：`ModelRole`（新增 `Review`）
- `src/biz/group-task`：复聊调度模板（Bull delayed + @Cron + MessageSenderService）
