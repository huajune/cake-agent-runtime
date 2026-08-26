# Cake Agent Runtime — 系统宣讲说明书

> **一句话定位**：DuLiDay 旗下专为餐饮连锁招聘场景打造的 AI Agent 运行时，
> 通过企业微信渠道，把"招呼-咨询-推荐-面试-入职"的全链路服务交给 AI 自动完成。

**最后更新**：2026-08-26 ｜ **维护者**：DuLiDay Team

> 本文是**工程视角**的系统宣讲（怎么构建）。产品视角（做什么、给谁、价值）见 [产品定义](product/product-definition.md)。

---

## 0. 阅读指引

本文整合了下列 7 份架构源文档，按"先看全景、再看模块、最后看落地"的顺序编排：

| #   | 来源文档                                                                              | 章节映射        |
| --- | ------------------------------------------------------------------------------------- | --------------- |
| 1   | [agent-runtime-architecture.md](./architecture/agent-runtime-architecture.md)         | §2 §3 §4 §5 §10 |
| 2   | [memory-architecture.md](./architecture/memory-architecture.md)                       | §6              |
| 3   | [message-service-architecture.md](./architecture/message-service-architecture.md)     | §7              |
| 4   | [monitoring-system-architecture.md](./architecture/monitoring-system-architecture.md) | §8              |
| 5   | [test-suite-architecture.md](./architecture/test-suite-architecture.md)               | §9              |
| 6   | [security-guardrails.md](./architecture/security-guardrails.md)                       | §11             |
| 7   | [group-task-pipeline.md](./architecture/group-task-pipeline.md)                       | §12             |

需要进一步深入某个领域时，按章节末尾的"延伸阅读"跳到原文档。

---

## 1. 我们要解决的问题

餐饮连锁招聘的痛点：

- **量大且高峰集中**：兼职岗位需求每天上千条，候选人集中在午晚高峰投递。
- **沟通同质化**：80% 的对话围绕"哪些岗位/工资多少/在哪里/怎么面试"。
- **流程固化**：从打招呼到入职是一条标准链路，但需要分支判断（异地、学生、健康证…）。
- **人工成本高**：招聘官 70% 时间花在重复问答，真正的判断只占 30%。

**Cake Agent Runtime 的承诺**：

> 让 AI 在企业微信里，以"线下招聘官"的方式接住 80% 的对话流量，把人留给真正需要判断的环节，
> 同时把每一次对话沉淀成可观测、可评估、可回放的数据资产。

### 1.1 三个度量目标

| 目标       | 指标                                                 | 现状                         |
| ---------- | ---------------------------------------------------- | ---------------------------- |
| **接得住** | 高峰期 99% 消息在 10s 内首字回复                     | 平均 ~5s（含 Debounce 等待） |
| **答得对** | 端到端测试套件通过率 ≥ 80%                           | 见 §9 测试套件               |
| **不闯祸** | 不可逆操作（面试预约/群邀请/阶段推进）有 Replay 保护 | 见 §7.3 Replay 保护          |

---

## 2. 系统全景

```
┌─────────────────────────────────────────────────────────────────────┐
│  入口层    企微托管平台回调 / Dashboard / 测试套件 / 群任务 Cron      │
└──────────────────────────┬──────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  渠道层    Channels (WeCom)                                         │
│            Ingress → Filter → Dedup → Debounce 聚合 → Replay 保护  │
│            Delivery：分段发送 + 打字延迟                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Agent 编排层  AgentRunnerService                                   │
│   ├─ PreparationService       prepare（拉记忆 / 装 prompt / 建工具） │
│   ├─ ContextService           Section 化 Prompt 组装                │
│   └─ LlmExecutorService       共享 LLM 入口                          │
└─────────┬───────────┬───────────┬────────────┬───────────────────────┘
          ▼           ▼           ▼            ▼
     ┌────────┐ ┌─────────┐ ┌──────────┐ ┌────────────┐
     │ Memory │ │  Tools  │ │ TestSuite│ │ Providers  │
     │ 2 layer│ │ 13 内置 │ │  评估    │ │ Registry   │
     │+enrich │ │ +MCP 扩 │ │ +AI Trace│ │ Reliable   │
     └────────┘ └─────────┘ └──────────┘ │ Router     │
                                         └────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Infrastructure   Redis(Upstash) / Supabase / HTTP / Feishu / Bull  │
└──────────────────────────┬──────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  横切能力   Observability（监控） · Alert（告警） · Security（护栏）  │
└─────────────────────────────────────────────────────────────────────┘
```

**关键分层规则**：

- `infra/` 不依赖 `biz/`、`channels/`、`agent/`、`memory/`
- Runner 的输入输出契约不含企微类型；当前 Nest 模块仍保留 `agent/` 与渠道/工具模块的物理依赖
- `memory/`、`tools/`、`evaluation/` 通过 `LlmExecutorService` 间接使用模型，不直连 `providers/`

> **金句**：所有 LLM 调用都收口到 **一个执行入口**（LlmExecutorService），
> 记忆主生命周期收口到 **一对方法**（onTurnStart / onTurnEnd），
> Replay 是否可以丢弃当前结果则由 **outcome + 已固化工具副作用**共同裁决。

---

## 3. Agent 编排层 — 一回合（Turn）的解剖

入口：[`src/agent/runner/agent-runner.service.ts`](../src/agent/runner/agent-runner.service.ts)

```
入站预检 → prepare → LLM / Tools → 出站审核与一次有界 repair → TurnOutcome
         ↑ 读记忆 / 组装 system / 建工具                         │
渠道：Replay → 副作用提交或回复投递 → TurnFinalizer → onTurnEnd ─┘
```

| 职责        | 服务/对象              | 说明                                                                        |
| ----------- | ---------------------- | --------------------------------------------------------------------------- |
| 回合裁决    | `AgentRunnerService`   | Input/Output guard、生成/repair 编排与 `TurnOutcome` 分类；不负责渠道投递   |
| 准备        | `PreparationService`   | 入参归一化、记忆备料、共享裁决视图、Context 组装、工具构建与记忆快照        |
| Prompt 组装 | `ContextService`       | 按 `SCENARIO_SECTIONS` 顺序构建 system blocks（见 §4）                      |
| LLM 执行    | `LlmExecutorService`   | 唯一调用 Vercel AI SDK 的入口                                               |
| 采纳与收尾  | 渠道 + `TurnFinalizer` | 最多三次 Replay；按投递结局只触发一次 `onTurnEnd`，丢弃版本不写助手轮次记忆 |

### 3.1 三种调用身份（callerKind）

| `callerKind` | `messages[]` 含义   | 短期记忆                 | 调用方        |
| ------------ | ------------------- | ------------------------ | ------------- |
| `WECOM`      | 只含当前 user 消息  | 从 Redis/DB 加载完整历史 | ReplyWorkflow |
| `TEST_SUITE` | 完整历史 + 当前消息 | 不加载                   | 测试套件      |
| `DEBUG`      | 完整历史 + 当前消息 | 不加载                   | Dashboard     |

`callerKind` 与 `strategySource (released | testing)` 正交 —— 测试套件可以跑生产策略做联调。

### 3.2 两个安全阀

- **prepareStep 动态屏蔽**：单轮内同一工具调用 ≥ N 次 → 屏蔽后续；命中业务工具后 → 屏蔽 `skip_reply`。
- **空文本恢复**：工具链产出"有 reasoning 无文本"时，关闭工具让模型再补一条候选人可见回复。

### 3.3 LlmExecutorService — 唯一 LLM 入口

所有 LLM 消费方（Agent、记忆事实抽取、外部画像补全、评估打分、注入检测）都走它，
背后是 `RouterService → ReliableService → RegistryService` 三层处理。

> **延伸阅读**：[agent-runtime-architecture.md §8.1](./architecture/agent-runtime-architecture.md#81-统一执行入口)

---

## 4. Context System — Prompt 组装的 Section 化

入口：[`src/agent/generator/context/context.service.ts`](../src/agent/generator/context/context.service.ts)

我们把 Prompt 拆成可注册的 `PromptSection`，按场景组装：

```text
identity → base-manual → channel → stage-overview → red-lines → thresholds
→ memory → turn-hints → hard-constraints → datetime → group-inventory
→ stage-strategy → final-check
```

`final-check` 是复合 section：每轮固定产出同名的发送前自检块；本轮命中规则时，
再在其后追加 block id 为 `critical-turn-guard` 的动态硬禁令。两者不是两个注册 section。

**关键决策**：

- 动态内容仍全部进入 system；不会为缓存目的下沉到 `messages`。
- 静态/低频内容前置，记忆、本轮线索、当前阶段策略与动态硬禁令靠近 system 尾部。
- `strategy_config` 来自 Supabase `strategy` 表，支持 `released` / `testing` 双版本。
- 新增场景只需在 `SCENARIO_SECTIONS` 与 `scenarioToolMap` 中各加一行。

> **延伸阅读**：[agent-runtime-architecture.md §5](./architecture/agent-runtime-architecture.md#5-preparation单轮备料编译器)

---

## 5. Provider 层 — 多模型三层架构

```
┌────────────────────────────────────────┐
│ Layer 3 RouterService — 角色/路由       │
│   resolveByRole('chat' | 'fast' | ...)  │
├────────────────────────────────────────┤
│ Layer 2 ReliableService — 容错           │
│   retry（指数退避） + fallback 链         │
│   错误分类：retryable / rate / non       │
├────────────────────────────────────────┤
│ Layer 1 RegistryService — 工厂注册       │
│   "provider/model" → LanguageModel      │
└────────────────────────────────────────┘
```

**已接入的 Provider**：Anthropic / OpenAI / Google / DeepSeek / Qwen / Moonshot / OpenRouter / Gateway。
启动时按 `*_API_KEY` 是否存在按需注册，缺 Key 不报错。

**容错策略**：

| 错误类别        | 触发条件               | 行为                       |
| --------------- | ---------------------- | -------------------------- |
| `non_retryable` | 401/403/404 / 余额不足 | 跳过重试，直接降级         |
| `rate_limited`  | 429                    | 指数退避，尊重 Retry-After |
| `retryable`     | 5xx / timeout / 网络   | 标准指数退避               |

> **延伸阅读**：[agent-runtime-architecture.md §8](./architecture/agent-runtime-architecture.md#8-llm-与-provider)

---

## 6. Memory System — 两层存储 + 类型化组装

CoALA 在本项目中用于解释内容类型，不等于建立四套存储。运行时只有两层持久状态：

```text
短期（Redis + chat_messages）
├─ 7 天消息窗口：最近最多 120 条、最多 24000 字符，Redis 缺失时由 DB 回填
├─ 3 天会话事实：factsv2:{corp}:{user}:{session} Hash
└─ 3 天阶段状态：stage:{corp}:{user}:{session}

长期（Supabase agent_long_term_memories）
├─ 主键维度：(corpId, userId, botUserId)
├─ semantic_profile / semantic_job_intent
├─ episodic_session_summaries：单层数组，最多 20 段，FIFO 淘汰
└─ consolidation_watermarks：独立水位，不混入摘要正文
```

Prompt 组装时再按 procedural / semantic / episodic / working 类型组织信息；
`WorkingMemory` 是单次 prepare 的进程内工作台，不是第三个存储层。

### 6.1 三大设计原则

1. **编排层固定读写**：LLM 不直接操作存储，由 `MemoryService.onTurnStart/onTurnEnd` 统一调度主生命周期。
2. **工具仅保留两个触达**：`advance_stage`（写阶段状态）、`recall_history`（读长期摘要）。
3. **Consolidation 三路独立写入**：画像 patch、求职意向 patch、会话摘要 append 分别落库；摘要不再做 recent/archive 分级压缩。

### 6.2 时间常量

记忆系统现在拆成三个时间参数：

- `sessionTtl`：Redis 会话事实与阶段状态，当前环境按 3 天配置
- `consolidationGapSeconds`：当前环境按 3 天配置；水位单独记录已处理边界
- `historyWindowSeconds`：短期窗口 DB fallback 回查范围，默认 7 天

> **延伸阅读**：[memory-architecture.md](./architecture/memory-architecture.md)

---

## 7. 消息管线 — 企业微信渠道

入口：[`src/channels/wecom/message/`](../src/channels/wecom/message/)

### 7.1 端到端链路

```
托管平台回调 POST /message
  │
  ├─ Ingress：立即 ACK 200，所有处理推到微任务
  │
  ├─ Application Pipeline
  │   ├─ AcceptInboundMessage   过滤 → 去重 → 写历史 → 图片预处理
  │   ├─ PreAgentRiskIntercept  自杀/自残/投诉 同步暂停 + 告警（不短路 Agent）
  │   ├─ ReplyWorkflow          Agent 调用 + Replay 重跑 + 投递
  │   └─ MessageProcessingFailure  失败兜底 + 飞书告警 + 降级回复
  │
  ├─ Runtime
  │   ├─ SimpleMerge             Debounce 聚合（Redis + Bull）
  │   ├─ MessageProcessor        Bull Worker + per-chat 锁
  │   ├─ Deduplication           Redis SET NX EX (300s)
  │   └─ WorkerManager           应用层 semaphore (默认 4，上限 20)
  │
  └─ Delivery
      ├─ TypingPolicy            段落间隔 + 每字符速率
      └─ DeliveryService         分段发送
```

### 7.2 Debounce 聚合 — 等用户停下来再回

聚合目标不是"窗口收齐 N 条"，而是"用户停止打字后再触发 Agent"：

```
t=0   "在吗"  → pending [M1]   注册 job#M1 @t=2s
t=0.5 "有"   → pending [M1,M2] 注册 job#M2 @t=2.5s
t=1   "岗位" → pending [...M3] 注册 job#M3 @t=3.0s
t=2   job#M1 触发 → now-last=1s < 2s → 跳过
t=3   job#M3 触发 → now-last=2.0s ≥ 2s → 取出全部消息，调 Agent
```

**关键参数**：`mergeDelayMs` 默认 2000ms，由 Supabase `hosting_config` 动态下发。
**好处**：用户持续打字 → 持续推迟处理，无需"最大聚合数"上限。

### 7.3 Replay 保护 — 不可逆动作的护身符

Agent 生成期间用户又发了新消息，怎么办？

```text
Agent 产出 TurnOutcome + TurnFinalizer
  ├─ 非 reply outcome，或工具已产生不可丢弃副作用 → 采用当前结果，不 replay
  └─ 普通 reply 且生成期间收到新消息
       → discard 当前 TurnFinalizer
       → 合并新消息后重跑（最多 3 次）

最终采用结果
  ├─ reply：先投递，再 settle({ delivered })
  └─ skipped / blocked / handoff：提交相应副作用，再 settle({ delivered: false })
```

`TurnFinalizer` 把“采纳后才落地”固化为一次性契约，避免被 Replay 丢弃、被出站守卫拦截
或投递失败的文本污染下一轮 `presentedJobs / facts`。

### 7.4 关键容量

| 维度            | 配置       | 说明                                  |
| --------------- | ---------- | ------------------------------------- |
| Bull 注册并发   | 20（固定） | 保证 delayed job 能被及时调度         |
| 真正执行并发    | 4（动态）  | 应用层 semaphore，hosting_config 可调 |
| per-chat 处理锁 | 300s TTL   | 长于单轮 Agent 最坏耗时               |
| 去重 TTL        | 300s       | Redis SET NX EX，多实例共享           |

> **延伸阅读**：[message-service-architecture.md](./architecture/message-service-architecture.md)

---

## 8. 可观测性、监控与告警

### 8.1 监控数据三段式

```
事实层（SoT）  Supabase message_processing_records / monitoring_error_logs
      │ cron 投影
投影层        monitoring_hourly_stats / monitoring_daily_stats（永久保留）
      │
实时层        Redis monitoring:active_requests / :peak_active_requests
```

**为什么不用纯内存快照**：

- 重启不丢数据
- 多实例共享真相
- SQL/RPC 直接支持分位数 / 窗口切片
- TOAST 治理：>7 天的 `agent_invocation` JSONB 置 NULL，行级保留

**热路径分流**：`today` 走原始表直查 + Redis；`week / month` 走小时/日投影表。

### 8.2 关键 cron

| 任务                       | 周期          | 时区          |
| -------------------------- | ------------- | ------------- |
| 小时聚合（cron 回填 14d）  | `5 * * * *`   | Asia/Shanghai |
| 日聚合（cron 回填 30d）    | `10 0 * * *`  | Asia/Shanghai |
| 业务指标告警评估           | `*/5 * * * *` | 默认          |
| 数据清理 + stuck → timeout | `0 3 * * *`   | 默认          |

### 8.3 告警系统 — 当前实现

当前告警不再经过旧的 `AlertOrchestratorService`。不同告警由领域服务直接编排并复用通知渠道：

- 消息/模型异常：`IncidentReporterService`、`AlertNotifierService`；
- 业务指标：`AnalyticsAlertService` 每 5 分钟读取 Dashboard 快照并经 `BusinessMetricRuleEngine` 判断；
- 人工介入：Runner 最终 outcome → `TurnOutcomeInterventionService` → `InterventionService`，统一写底账、暂停托管并发送飞书卡片；
- 接收人和 Webhook：由通知模块与托管账号配置解析。

业务指标配置从 Supabase `hosting_config.agent_reply_config` 动态读取，同一指标默认 30 分钟内不重复发送。

**业务指标告警阈值**：

| 指标         | WARNING | CRITICAL |
| ------------ | ------- | -------- |
| 成功率       | < 90%   | < 80%    |
| 平均响应时间 | > 42s   | > 60s    |
| 在途请求     | > 10 条 | > 20 条  |
| 近 1h 错误数 | > 7     | > 10     |

> **延伸阅读**：[monitoring-system-architecture.md](./architecture/monitoring-system-architecture.md) ·
> [飞书通知系统](./infrastructure/feishu-alert-system.md) ·
> [人工告警触发清单](./infrastructure/human-alert-triggers.md)

---

## 9. 测试套件 — 让 AI 给 AI 打分

入口：[`src/biz/test-suite/`](../src/biz/test-suite/)

### 9.1 两种测试类型

| 维度       | 用例测试 (Scenario)   | 回归验证 (Conversation) |
| ---------- | --------------------- | ----------------------- |
| 数据来源   | 人工编写的测试用例    | 真实客户对话记录        |
| 飞书数据表 | testSuite             | validationSet           |
| 测试粒度   | 单轮问答              | 多轮对话（按 turn 拆）  |
| 评估方式   | 人工评审（通过/失败） | LLM 自动评分（0-100）   |
| 典型用途   | 发版前场景回归        | 质量基线、对话回放      |

### 9.2 执行链路

```
飞书 testSuite / validationSet
  → TestImportService 导入
  → TestBatchService 建批次 + pending 执行记录
  → Bull Queue (concurrency=3, attempts=2, timeout=120s)
  → TestExecutionService → AgentRunnerService(callerKind=TEST_SUITE)
  → AiStreamObservabilityService.startTrace() → AiStreamTrace
  → LlmEvaluationService（仅回归验证打分）
  → TestWriteBackService → 飞书回写
  → CuratedDatasetImportService + LineageSyncService
```

### 9.3 AI 流追踪（AiStreamTrace）

每次 `chat/ai-stream` 启动一次 trace，按 UIMessageChunk 解析：

- **时间戳**：receivedAt / aiStartAt / streamReadyAt / firstChunkAt / firstReasoningDeltaAt / firstTextDeltaAt / finishChunkAt / completedAt
- **内容聚合**：Text / Tool / Reasoning 三路独立聚合
- **数据归属**：`source: 'testing'` 时 **不** 写入生产观测表，避免污染"今日托管"看板

### 9.4 资产血缘（LineageSync）

`assetRelation` 表维护：

- Scenario case ↔ 来源 BadCase
- Conversation case ↔ 来源 BadCase / 原始 chat_id
- 用例 / 验证集 ↔ 所属测试批次

支持反向溯源（badcase → 对应用例）。

> **延伸阅读**：[test-suite-architecture.md](./architecture/test-suite-architecture.md)

---

## 10. 工具系统

入口：[`src/tools/tool-registry.service.ts`](../src/tools/tool-registry.service.ts)

### 10.1 候选人咨询场景工具（13 个）

| 工具                            | 职责                                                                     |
| ------------------------------- | ------------------------------------------------------------------------ |
| `advance_stage`                 | 推进阶段状态阶段                                                         |
| `recall_history`                | 查询用户历史求职记录摘要                                                 |
| `duliday_job_list`              | 查询在招岗位（geocode + 距离排序 + 业务阈值过滤）                        |
| `duliday_interview_precheck`    | 面试前置校验（不真正提交）                                               |
| `duliday_interview_booking`     | 面试预约提交（不可逆）                                                   |
| `duliday_cancel_work_order`     | 取消符合前置条件的面试工单                                               |
| `duliday_modify_interview_time` | 修改符合前置条件的面试时间                                               |
| `geocode`                       | 地名 → 标准化地址 + 经纬度                                               |
| `send_store_location`           | 按面试形式发送面试地点或工作门店的企微位置；进行中预约默认核对面试目的地 |
| `invite_to_group`               | 邀请加入企微兼职群（不可逆）                                             |
| `raise_risk_alert`              | 候选人投诉/辱骂时人工介入                                                |
| `request_handoff`               | 面试/入职跟进阻塞时申请人工接管                                          |
| `skip_reply`                    | 主动沉默本轮                                                             |

**动态扩展**：

- 本轮 `imageMessageIds` 非空 → 注入 `save_image_description`
- 本轮包含附件 → 注入 `read_resume_attachment`
- MCP 服务运行时 → `registerMcpTool()` 自动叠加到所有场景

### 10.2 Replay 阻断判定

```typescript
REPLAY_BLOCKING_TOOLS = new Set([
  'invite_to_group', // 企微 addMember 外部 API
  'duliday_interview_booking', // 杜力岱外部预约 API
]);
```

除此之外，非 reply outcome 与已声明、已提交的工具副作用也会阻断 Replay；
`advance_stage` 不在该集合中。

> **延伸阅读**：[agent-runtime-architecture.md §6](./architecture/agent-runtime-architecture.md#6-工具系统)

---

## 11. 安全护栏

```
HTTP 请求
  → [基础设施] 启动校验 / Token / DTO / 输入输出预算 / Provider 重试降级
  → [Input]      高危入站短路为 guardrail_blocked；Prompt Injection 检测
  → [Prompt]     system sections + final-check；注入命中时追加防护 suffix
  → [Tool]       jobId、precheck、身份、拉群城市/时机等动作门禁
  → [Output]     确定性规则 + 可选语义 reviewer + 一次有界修复 + 最终清洗
```

这是 **Input / Prompt / Tool / Output 四个防线作用位**。Prompt 负责生成前预防，不拥有最终 veto；
Input / Tool / Output 才负责运行时短路、动作拒绝与出站验收。Prompt Injection 检测不直接阻断，
而是追加 system 防护 suffix 并异步告警。

**关键安全变量**：

| 变量                      | 默认值 | 说明                                  |
| ------------------------- | ------ | ------------------------------------- |
| `API_GUARD_TOKEN`         | 无     | 管理端点 Bearer Token，未配置则不鉴权 |
| `AGENT_MAX_OUTPUT_TOKENS` | 4096   | 单次输出上限                          |
| `AGENT_MAX_INPUT_CHARS`   | 24000  | 输入字符上限                          |
| `AGENT_DEFAULT_FALLBACKS` | 无     | 全局模型降级链                        |

> **延伸阅读**：[security-guardrails.md](./architecture/security-guardrails.md)

---

## 12. 群任务流水线 — 主动触达能力

入口：[`src/biz/group-task/`](../src/biz/group-task/)

```
Cron 触发 → GroupTaskScheduler.executeTask()
  ├─ 前置：enabled 开关 / Redis 分布式锁 / 非生产跳过 Cron
  ├─ GroupResolver.resolveGroups(tagPrefix)
  │   遍历小组 token → /room/simpleList → 按 tagPrefix 筛选
  │   10min 内存缓存 + stampede 防护
  ├─ 按 (城市 + 行业) 分组
  │   ├─ strategy.fetchData (代表群)        外部 BI / 岗位
  │   ├─ buildMessage (模板) 或 buildPrompt + LlmExecutor (AI)
  │   ├─ 同组所有群发送相同消息（人类化随机延时）
  │   └─ 兼职群记录品牌轮转（避免重复）
  └─ 飞书卡片汇报：成功/失败/跳过 + 分组详情
      └─ dryRun 模式：只发飞书预览，不发企微
```

**四种策略**：

| 类型       | tagPrefix | 数据源   | 生成方式          | Cron                       |
| ---------- | --------- | -------- | ----------------- | -------------------------- |
| 抢单群     | `抢单群`  | BI 订单  | 模板              | 10:00 / 13:00 / 17:30 每天 |
| 兼职群     | `兼职群`  | 岗位列表 | 模板 + 小程序卡片 | 13:00 工作日               |
| 店长群     | `店长群`  | BI 数据  | 模板              | 10:30 工作日               |
| 工作小贴士 | `店长群`  | 预设话题 | AI 生成           | 15:00 周六                 |

**亮点**：

- 同城同行业的群只拉一次数据、生成一次文案，N 群复用。
- 品牌轮转避免重复推送同一品牌。

> **延伸阅读**：[group-task-pipeline.md](./architecture/group-task-pipeline.md)

---

## 13. 端到端：一条消息的完整旅程

以候选人发送 _"你们招收银员吗？工资多少？"_ 为例：

```text
1. 托管平台回调
   → AcceptInboundMessageService：过滤、去重、持久化、入队并立即 ACK

2. SimpleMergeService / MessageProcessor
   → debounce 聚合 → 获取 per-chat 锁 → ReplyWorkflowService

3. 入站防线
   → PreAgentRiskInterceptService 处理需暂停/告警的业务风险
   → AgentRunnerService 执行 input guard；阻断时直接产出 guardrail_blocked

4. PreparationService.prepare()
   → MemoryService.onTurnStart() 拉取短期窗口、会话事实、阶段与长期档案
   → snapshot-enrichment 补全档案来源
   → prompt-memory-adjudicator 生成共享裁决视图
   → ContextService 按 section 顺序构建 system prompt
   → ToolRegistryService.buildForScenario() 构建 13 个场景工具并叠加动态工具

5. GeneratorAgent / LlmExecutorService
   → AI SDK 多步工具循环，例如 duliday_job_list
   → Runner 执行出站确定性审查、可选语义 reviewer 与最多一次 repair
   → 归一化为 reply / skipped / guardrail_blocked / handoff

6. ReplyWorkflowService
   → 普通 reply 生成期间若有新消息，丢弃当前 finalizer 后合并 Replay（最多 3 次）
   → 非 reply 或已有不可丢弃副作用时采用当前结果

7. 最终结局
   → reply：MessageDeliveryService 分段投递，提交回复关联副作用
   → non-reply：提交暂停、告警或沉默等结局副作用
   → TurnFinalizer.settle({ delivered }) 只执行一次 onTurnEnd
   → 等待收尾后记录 MPR 并释放 per-chat 锁
```

---

## 14. 核心能力总结 — 一张表带走

| 能力                  | 实现                                             | 价值                                       |
| --------------------- | ------------------------------------------------ | ------------------------------------------ |
| **多模型容错**        | Provider 三层（Registry → Reliable → Router）    | 单家 API 故障自动降级，业务零感知          |
| **两层记忆**          | 短期会话态 + 长期候选人×bot 档案 + consolidation | 跨轮连续，同时保持存储边界清晰             |
| **Debounce 聚合**     | 每条消息注册 delay=2s 的 Bull job                | 用户连发不抢答，停止打字才回               |
| **Replay 保护**       | outcome/副作用门禁 + `TurnFinalizer`             | 丢弃版本不污染记忆，投递结局与收尾一致     |
| **per-chat 串行**     | Redis 处理锁 (300s)                              | 同一会话同时只有一个 Agent 在生成          |
| **Section 化 Prompt** | 场景注册表 + PromptSection 接口                  | 新场景 / 新护栏接入只改一处                |
| **AI 流追踪**         | AiStreamTrace 解析 UIMessageChunk                | 测试与生产隔离观测，时间线粒度到首字节     |
| **告警限流聚合**      | 5min 窗口 + 恢复检测                             | 一次故障一条告警，不刷屏                   |
| **数据三段式**        | Supabase SoT + 投影表 + Redis 实时               | 重启不丢数据，热路径走原表，长期趋势走投影 |
| **测试 + 血缘**       | Bull Queue 异步执行 + LineageSync                | 真实 badcase 反向溯源到对应用例            |

---

## 15. 关键配置速查

### 15.1 必填环境变量（缺失即启动失败）

| 变量                                                     | 说明                                |
| -------------------------------------------------------- | ----------------------------------- |
| `ANTHROPIC_API_KEY`                                      | Anthropic API 密钥                  |
| `AGENT_CHAT_MODEL`                                       | 主对话模型（`provider/model` 格式） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`    | Redis 接入                          |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase 接入                       |
| `DULIDAY_API_TOKEN`                                      | 杜力岱 API                          |
| `STRIDE_API_BASE_URL`                                    | 托管平台 API                        |
| `FEISHU_ALERT_WEBHOOK_URL` / `FEISHU_ALERT_SECRET`       | 飞书告警                            |

### 15.2 由 Supabase `hosting_config` 动态下发

| 键                                                   | 默认值 | 说明                   |
| ---------------------------------------------------- | ------ | ---------------------- |
| `initialMergeWindowMs`                               | 3000   | 消息聚合 debounce 窗口 |
| `typingSpeedCharsPerSec` / `paragraphGapMs`          | -      | 拟人化打字策略         |
| `workerConcurrency`                                  | 4      | 实际执行并发           |
| `wecomCallbackModelId` / `wecomCallbackThinkingMode` | -      | 渠道侧模型选择         |

### 15.3 关键 Agent 行为变量

| 变量                           | 默认值 | 说明                          |
| ------------------------------ | ------ | ----------------------------- |
| `AGENT_MAX_OUTPUT_TOKENS`      | 4096   | 单次输出上限                  |
| `AGENT_MAX_INPUT_CHARS`        | 24000  | 输入字符上限                  |
| `AGENT_THINKING_BUDGET_TOKENS` | 0      | Extended thinking 预算        |
| `MAX_HISTORY_PER_CHAT`         | 120    | 短期窗口最大消息数            |
| `MEMORY_SESSION_TTL_DAYS`      | 3      | 会话级 Redis TTL              |
| `MEMORY_SETTLEMENT_GAP_DAYS`   | 3      | 跨会话 consolidation 间隔阈值 |
| `MEMORY_HISTORY_WINDOW_DAYS`   | 7      | 短期记忆 DB fallback 回查窗口 |
| `MESSAGE_DEDUP_TTL_SECONDS`    | 300    | 去重 TTL                      |

---

## 16. 可扩展点

| 想做的事             | 入口                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| 新增 Provider        | `RegistryService.onModuleInit()` 自动检测 / OAI-compatible 表                  |
| 新增工具             | `src/tools/my-tool.ts` + `ToolRegistryService` 注册 + `scenarioToolMap`        |
| 新增 Replay 阻断工具 | 同上，并仅在确有不可丢弃外部副作用时加入 `REPLAY_BLOCKING_TOOLS`               |
| 新增 Prompt Section  | 实现 `PromptSection`，在 `ContextService` 注册，并加入目标 `SCENARIO_SECTIONS` |
| 新增场景             | `SCENARIO_SECTIONS` + `scenarioToolMap` 各加一行                               |
| 新增渠道             | `src/channels/` 新建适配，构造 `TurnRequest` 调 `AgentRunnerService.runTurn()` |
| 新增告警渠道         | 扩展 notification 模块，由 `AlertNotifierService` 统一路由                     |
| 新增评估维度         | `LlmEvaluationService.generateStructured` + 自定义 schema                      |

---

## 17. 演进与未完成事项

本文件只陈述已经落地的能力，不再维护未经代码或任务单确认的路线图。当前工程、外部协作与
上线后验证事项统一收口到 [`docs/todo/README.md`](./todo/README.md)；已完成方案保留在 Git 历史，
不继续占用 todo 目录。

---

## 18. 团队与文档维护

- **维护团队**：DuLiDay
- **架构文档目录**：[`docs/architecture/`](./architecture/)
- **开发规范目录**：[`.claude/agents/`](../.claude/agents/)
- **数据库迁移**：[`supabase/migrations/`](../supabase/migrations/)
- **Dashboard 前端**：`web/`（独立仓库目录）

> 本说明书为整合材料，单一 Source of Truth 仍以 `docs/architecture/` 下的各专题文档为准。
> 当任意架构发生重大变化时，请同步更新对应专题文档与本说明书的相关章节。
