# Cake Agent Runtime — 系统宣讲说明书

> **一句话定位**：DuLiDay 旗下专为餐饮连锁招聘场景打造的 AI Agent 运行时，
> 通过企业微信渠道，把"招呼-咨询-推荐-面试-入职"的全链路服务交给 AI 自动完成。

**最后更新**：2026-04-23 ｜ **维护者**：DuLiDay Team

---

## 0. 阅读指引

本文整合了下列 9 份架构源文档，按"先看全景、再看模块、最后看落地"的顺序编排：

| # | 来源文档 | 章节映射 |
| - | --- | --- |
| 1 | [agent-runtime-architecture.md](./architecture/agent-runtime-architecture.md) | §2 §3 §4 §5 §10 |
| 2 | [memory-system-architecture.md](./architecture/memory-system-architecture.md) | §6 |
| 3 | [message-service-architecture.md](./architecture/message-service-architecture.md) | §7 |
| 4 | [monitoring-system-architecture.md](./architecture/monitoring-system-architecture.md) | §8 |
| 5 | [alert-system-architecture.md](./architecture/alert-system-architecture.md) | §8 |
| 6 | [test-suite-architecture.md](./architecture/test-suite-architecture.md) | §9 |
| 7 | [security-guardrails.md](./architecture/security-guardrails.md) | §11 |
| 8 | [group-task-pipeline.md](./architecture/group-task-pipeline.md) | §12 |
| 9 | [llm-executor-dependency-diagram.md](./architecture/llm-executor-dependency-diagram.md) | §3 §5 |

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

| 目标 | 指标 | 现状 |
| --- | --- | --- |
| **接得住** | 高峰期 99% 消息在 10s 内首字回复 | 平均 ~5s（含 Debounce 等待） |
| **答得对** | 端到端测试套件通过率 ≥ 80% | 见 §9 测试套件 |
| **不闯祸** | 不可逆操作（面试预约/群邀请/阶段推进）有 Replay 保护 | 见 §7.3 Replay 保护 |

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
│   ├─ AgentPreparationService  prepare（拉记忆 / 装 prompt / 建工具） │
│   ├─ ContextService           Section 化 Prompt 组装                │
│   └─ LlmExecutorService       共享 LLM 入口                          │
└─────────┬───────────┬───────────┬────────────┬───────────────────────┘
          ▼           ▼           ▼            ▼
     ┌────────┐ ┌─────────┐ ┌──────────┐ ┌────────────┐
     │ Memory │ │  Tools  │ │ TestSuite│ │ Providers  │
     │ 4 layer│ │ 11 内置 │ │  评估    │ │ Registry   │
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
- `agent/` 不依赖 `channels/`，通过参数接收上下文
- `memory/`、`tools/`、`evaluation/` 通过 `LlmExecutorService` 间接使用模型，不直连 `providers/`

> **金句**：所有 LLM 调用都收口到 **一个执行入口**（LlmExecutorService），
> 所有记忆读写都收口到 **一对生命周期方法**（onTurnStart / onTurnEnd），
> 所有不可逆动作都收口到 **一个工具白名单**（REPLAY_BLOCKING_TOOL_NAMES）。

---

## 3. Agent 编排层 — 一回合（Turn）的解剖

入口：[`src/agent/runner.service.ts`](../src/agent/runner.service.ts)

```
onTurnStart → Compose → Execute (LLM + Tools) → onTurnEnd
   ↑ 读记忆       组装 prompt       多步工具循环       写记忆 / 沉淀
```

`AgentRunnerService` 只做两件事：**调 LLM** + **收尾**。其它全部下放：

| 职责 | 服务 | 说明 |
| --- | --- | --- |
| 准备 | `AgentPreparationService` | 入参归一化、并行拉记忆、入参检查、Context 组装、工具构建、记忆快照 |
| Prompt 组装 | `ContextService` | Section 体系按场景注册（见 §4） |
| LLM 执行 | `LlmExecutorService` | 唯一调用 Vercel AI SDK 的地方 |

### 3.1 三种调用身份（callerKind）

| `callerKind` | `messages[]` 含义 | 短期记忆 | 调用方 |
| --- | --- | --- | --- |
| `WECOM` | 只含当前 user 消息 | 从 Redis/DB 加载完整历史 | ReplyWorkflow |
| `TEST_SUITE` | 完整历史 + 当前消息 | 不加载 | 测试套件 |
| `DEBUG` | 完整历史 + 当前消息 | 不加载 | Dashboard |

`callerKind` 与 `strategySource (released | testing)` 正交 —— 测试套件可以跑生产策略做联调。

### 3.2 两个安全阀

- **prepareStep 动态屏蔽**：单轮内同一工具调用 ≥ N 次 → 屏蔽后续；命中业务工具后 → 屏蔽 `skip_reply`。
- **空文本恢复**：工具链产出"有 reasoning 无文本"时，关闭工具让模型再补一条候选人可见回复。

### 3.3 LlmExecutorService — 唯一 LLM 入口

所有 LLM 消费方（Agent、记忆事实抽取、外部画像补全、评估打分、注入检测）都走它，
背后是 `RouterService → ReliableService → RegistryService` 三层处理。

> **延伸阅读**：[agent-runtime-architecture.md §3](./architecture/agent-runtime-architecture.md#3-agent-编排层) ·
> [llm-executor-dependency-diagram.md](./architecture/llm-executor-dependency-diagram.md)

---

## 4. Context System — Prompt 组装的 Section 化

入口：[`src/agent/context/context.service.ts`](../src/agent/context/context.service.ts)

我们把 Prompt 拆成可注册的 `PromptSection`，按场景组装：

```
[identity]              ← 角色 / 沟通风格 / 工作流程
[base-manual]           ← 业务手册（StaticSection）
[policy]                ← red-lines + thresholds
[runtime-context]       ← 本轮会变动的全部内容（聚合 6 个叶子 section）
  ├─ stage-strategy     · 当前阶段策略
  ├─ memory             · 用户档案 + 会话记忆 + 当前预约信息
  ├─ turn-hints         · 本轮高置信线索
  ├─ hard-constraints   · 当下硬约束
  ├─ datetime           · 当前时间
  └─ channel            · 渠道上下文
[group-inventory]       ← 候选人意向城市的兼职群库存
[final-check]           ← 出规校验清单
```

**关键决策**：

- `runtime-context` 聚合所有"每轮都会变"的内容，便于缓存其它 Section。
- `strategy_config` 来自 Supabase `strategy` 表，支持 `released` / `testing` 双版本。
- 新增场景只需在 `SCENARIO_SECTIONS` 与 `scenarioToolMap` 中各加一行。

> **延伸阅读**：[agent-runtime-architecture.md §4](./architecture/agent-runtime-architecture.md#4-context-system--prompt-组装)

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

| 错误类别 | 触发条件 | 行为 |
| --- | --- | --- |
| `non_retryable` | 401/403/404 / 余额不足 | 跳过重试，直接降级 |
| `rate_limited` | 429 | 指数退避，尊重 Retry-After |
| `retryable` | 5xx / timeout / 网络 | 标准指数退避 |

> **延伸阅读**：[agent-runtime-architecture.md §5](./architecture/agent-runtime-architecture.md#5-provider-层--三层模型架构)

---

## 6. Memory System — 四层记忆 + 一路旁路

> 灵感来自认知科学的 CoALA 框架：让 Agent 像人一样有"工作记忆 / 短期记忆 / 程序记忆 / 长期记忆"。

```
┌──────────────────── Agent Loop（编排层）─────────────────────┐
│  onTurnStart  → 一次性读取四类记忆 + 当轮高置信识别 → 注入 prompt │
│  onTurnEnd    → 写会话态 + 触发后置事实提取                    │
└──────────────────────────────────────────────────────────────┘

┌── 短期 Working ─── chat_messages + Redis 窗口热缓存 ───────┐
│   读 Redis 优先，DB 兜底；按 sessionTtl 对齐窗口             │
└──────────────────────────────────────────────────────────────┘

┌── 会话 Session ─── Redis  facts:{corp}:{user}:{session} ───┐
│   facts / lastCandidatePool / presentedJobs /                │
│   currentFocusJob / invitedGroups / lastSessionActiveAt     │
└──────────────────────────────────────────────────────────────┘

┌── 程序 Procedural ── Redis  stage:{corp}:{user}:{session} ──┐
│   currentStage = trust_building → needs_collection →        │
│                  job_recommendation → interview_arrangement │
│   唯一写入口：advance_stage 工具                              │
└──────────────────────────────────────────────────────────────┘

┌── 长期 Long-term ── Supabase agent_memories + Redis 2h 缓存 ┐
│   profile：姓名/电话/性别/年龄/学生/学历/健康证                 │
│   summary：recent[5] + archive（LLM 分层压缩）                  │
└──────────────────────────────────────────────────────────────┘

┌── 旁路 highConfidenceFacts（不持久化） ────────────────────┐
│   规则 + 别名识别（品牌、城市、用工形式）                     │
│   只注入本轮 prompt，不入库                                  │
└──────────────────────────────────────────────────────────────┘
```

### 6.1 三大设计原则

1. **编排层固定读写**：LLM 不持有记忆读写权，由 `MemoryService.onTurnStart/onTurnEnd` 统一调度。
2. **工具仅保留两个触达**：`advance_stage`（写程序记忆）、`recall_history`（读长期摘要）。
3. **会话沉淀单向搬运**：`SessionService → SettlementService → LongTerm`，超 `sessionTtl` 闲置触发，
   Redis key 自然过期。

### 6.2 时间常量

`sessionTtl`（默认 1 天）一个参数同时决定：
(1) Redis 会话态过期 (2) 沉淀阈值 (3) 短期窗口 DB fallback 时间边界。

> **延伸阅读**：[memory-system-architecture.md](./architecture/memory-system-architecture.md)

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

```
首次 callAgent({ deferTurnEnd: true })   ← turn-end 副作用先挂起
  │
  ├─ 检查：生成期间到达的 pending 是否非空？
  │    ├─ 否 → 投递首次回复，触发 turn-end
  │    └─ 是 → 看首次 toolCalls 是否命中 REPLAY_BLOCKING：
  │         ├─ 命中（advance_stage / invite_to_group / duliday_interview_booking）
  │         │     副作用已落，不能丢弃 → 投递首次回复 + 触发 turn-end
  │         └─ 未命中
  │             丢弃首次回复 + 丢弃 runTurnEnd
  │             合并新消息重跑一次（最多一次，避免活锁）
```

**为什么需要 deferTurnEnd**：首次回复若被丢弃，它写入的 `presentedJobs / facts` 会污染下一轮 recall。
延后触发 turn-end 让"采纳后才落地"成为默认。

### 7.4 关键容量

| 维度 | 配置 | 说明 |
| --- | --- | --- |
| Bull 注册并发 | 20（固定） | 保证 delayed job 能被及时调度 |
| 真正执行并发 | 4（动态） | 应用层 semaphore，hosting_config 可调 |
| per-chat 处理锁 | 300s TTL | 长于单轮 Agent 最坏耗时 |
| 去重 TTL | 300s | Redis SET NX EX，多实例共享 |

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

| 任务 | 周期 | 时区 |
| --- | --- | --- |
| 小时聚合（cron 回填 14d） | `5 * * * *` | Asia/Shanghai |
| 日聚合（cron 回填 30d） | `10 0 * * *` | Asia/Shanghai |
| 业务指标告警评估 | `*/5 * * * *` | 默认 |
| 数据清理 + stuck → timeout | `0 3 * * *` | 默认 |

### 8.3 告警系统 — 编排器模式

```
sendAlert(context)
  → 全局开关 → 严重程度判断 → 静默检查 → 故障状态记录
  → 限流聚合 → 飞书 Webhook
```

**核心机制**：
- **限流聚合**：同类型告警 5 分钟窗口内只发 1 次，窗口期结束发聚合告警（"5 分钟内 300 次，分布：超时 189 / 限流 111"）。
- **恢复检测**：连续成功 5 次 → 自动发送恢复通知（"故障时长 33 分钟，期间失败 127 次"）。
- **静默管理**：API `/alert/silence` 支持临时屏蔽（计划维护场景）。
- **配置热加载**：`config/alert-rules.json` 修改即时生效。

**业务指标告警阈值**：

| 指标 | WARNING | CRITICAL |
| --- | --- | --- |
| 成功率 | < 90% | < 80% |
| 平均响应时间 | > 5s | > 10s |
| 队列积压 | > 50 条 | > 100 条 |
| 错误率 | > 10/分钟 | > 20/分钟 |

> **延伸阅读**：[monitoring-system-architecture.md](./architecture/monitoring-system-architecture.md) ·
> [alert-system-architecture.md](./architecture/alert-system-architecture.md)

---

## 9. 测试套件 — 让 AI 给 AI 打分

入口：[`src/biz/test-suite/`](../src/biz/test-suite/)

### 9.1 两种测试类型

| 维度 | 用例测试 (Scenario) | 回归验证 (Conversation) |
| --- | --- | --- |
| 数据来源 | 人工编写的测试用例 | 真实客户对话记录 |
| 飞书数据表 | testSuite | validationSet |
| 测试粒度 | 单轮问答 | 多轮对话（按 turn 拆） |
| 评估方式 | 人工评审（通过/失败） | LLM 自动评分（0-100） |
| 典型用途 | 发版前场景回归 | 质量基线、对话回放 |

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

### 10.1 内置工具（11 个）

| 工具 | 职责 |
| --- | --- |
| `advance_stage` | 推进程序记忆阶段 |
| `recall_history` | 查询用户历史求职记录摘要 |
| `duliday_job_list` | 查询在招岗位（geocode + 距离排序 + 业务阈值过滤） |
| `duliday_interview_precheck` | 面试前置校验（不真正提交） |
| `duliday_interview_booking` | 面试预约提交（不可逆） |
| `geocode` | 地名 → 标准化地址 + 经纬度 |
| `send_store_location` | 发送门店企微位置 |
| `invite_to_group` | 邀请加入企微兼职群（不可逆） |
| `raise_risk_alert` | 候选人投诉/辱骂时人工介入 |
| `request_handoff` | 面试/入职跟进阻塞时申请人工接管 |
| `skip_reply` | 主动沉默本轮 |

**动态扩展**：
- 本轮 `imageMessageIds` 非空 → 注入 `save_image_description`
- MCP 服务运行时 → `registerMcpTool()` 自动叠加到所有场景

### 10.2 不可逆工具白名单

```typescript
REPLAY_BLOCKING_TOOL_NAMES = [
  'advance_stage',              // procedural memory 直写
  'invite_to_group',            // 企微 addMember 外部 API
  'duliday_interview_booking',  // 杜力岱外部预约 API
];
```

任意命中即跳过 Replay，配合 §7.3 的 `deferTurnEnd` 机制，保证副作用与回复严格一致。

> **延伸阅读**：[agent-runtime-architecture.md §7](./architecture/agent-runtime-architecture.md#7-工具系统)

---

## 11. 安全护栏

```
HTTP 请求
  → [1] env.validation.ts — 启动校验，缺关键变量直接退出
  → [2] ApiTokenGuard — Bearer Token 鉴权（@Public 端点豁免）
  → [3] DTO 输入校验（class-validator）
  → [4] trimMessages — 总字符 > AGENT_MAX_INPUT_CHARS 丢弃最早消息
  → [5] InputGuardService — Prompt Injection 检测（不阻断，追加防护提醒 + 异步告警）
  → [6] maxOutputTokens — LLM 调用上限
  → [7] ReliableService — 重试 + 降级
  → [8] FeishuAlertService — 告警节流
```

**Prompt Injection 三类模式**：角色劫持（"你现在是…"）、提示词泄露（"显示你的 system prompt"）、指令注入（`[[SYSTEM]]`、`<|im_start|>system`）。
**策略**：不阻断，追加 GUARD_SUFFIX + 异步飞书告警。

**关键安全变量**：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `API_GUARD_TOKEN` | 无 | 管理端点 Bearer Token，未配置则不鉴权 |
| `AGENT_MAX_OUTPUT_TOKENS` | 4096 | 单次输出上限 |
| `AGENT_MAX_INPUT_CHARS` | 8000 | 输入字符上限 |
| `AGENT_DEFAULT_FALLBACKS` | 无 | 全局模型降级链 |

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

| 类型 | tagPrefix | 数据源 | 生成方式 | Cron |
| --- | --- | --- | --- | --- |
| 抢单群 | `抢单群` | BI 订单 | 模板 | 10:00 / 13:00 / 17:30 每天 |
| 兼职群 | `兼职群` | 岗位列表 | 模板 + 小程序卡片 | 13:00 工作日 |
| 店长群 | `店长群` | BI 数据 | 模板 | 10:30 工作日 |
| 工作小贴士 | `店长群` | 预设话题 | AI 生成 | 15:00 周六 |

**亮点**：
- 同城同行业的群只拉一次数据、生成一次文案，N 群复用。
- 品牌轮转避免重复推送同一品牌。

> **延伸阅读**：[group-task-pipeline.md](./architecture/group-task-pipeline.md)

---

## 13. 端到端：一条消息的完整旅程

以候选人发送 *"你们招收银员吗？工资多少？"* 为例：

```
1. 托管平台 POST /wecom/message
   │
2. AcceptInboundMessageService
   ├─ 过滤通过（用户消息、非自发、未暂停）
   ├─ Redis 去重 (5min)
   ├─ 写 chat_messages + Redis 短期窗口
   └─ 立即 ACK 200
   │
3. SimpleMergeService — debounce 静默 ~3s
   │
4. ReplyWorkflowService.processMessageCore()
   │
5. PreAgentRiskInterceptService.precheck()  → 安全
   │
6. callAgent({ deferTurnEnd: true })
   │
   └─ AgentRunnerService.invoke
       │
       ├─ AgentPreparationService.prepare()
       │   ├─ MemoryService.onTurnStart() 并行读：
       │   │   ├─ 短期：最近 60 条对话
       │   │   ├─ 会话：{ preferences: { city: '上海' }, lastCandidatePool }
       │   │   ├─ 程序阶段：'needs_collection'
       │   │   ├─ 长期档案：{ name: '张三', phone: '138****' }
       │   │   └─ 高置信识别：{ jobIntent: '收银员' }
       │   ├─ RecruitmentCaseService 查活跃 case → 无
       │   ├─ InputGuard 扫注入 → safe
       │   ├─ ContextService.compose() → systemPrompt
       │   └─ ToolRegistryService.buildForScenario() → 11 工具
       │
       ├─ LlmExecutorService.generate()  role=Chat
       │   ├─ Step 1: 调用 duliday_job_list → onJobsFetched 写入 candidatePool
       │   └─ Step 2: 组织自然语言回复
       │
       └─ attachTurnEnd(deferTurnEnd=true)  → result.runTurnEnd 暴露
   │
7. ReplyWorkflowService 检查：
   ├─ toolCalls 只含 duliday_job_list → 非不可逆
   └─ fetchPendingSinceAgentStart → 无新消息
   │
8. 显式触发 result.runTurnEnd()
   │
   └─ MemoryLifecycleService.onTurnEnd()
       ├─ load_previous_state
       ├─ 分支 A：settlement（未超阈值 → skipped）
       └─ 分支 B（串行）：
           ├─ save_candidate_pool（3 个岗位 → session）
           ├─ store_activity（刷新 lastSessionActiveAt）
           ├─ project_assistant_turn（投影 presentedJobs）
           └─ extract_facts（LLM 提取 preferences.salary）
   │
9. MessageDeliveryService
   ├─ 分段：["我们确实招收银员！...", "时薪大概..."]
   ├─ 段 1 打字延迟 ~400ms
   ├─ 段间隔 2000ms
   └─ 段 2 打字延迟 ~400ms
   │
10. markMessagesAsProcessed + recordSuccess → message_processing_records
```

---

## 14. 核心能力总结 — 一张表带走

| 能力 | 实现 | 价值 |
| --- | --- | --- |
| **多模型容错** | Provider 三层（Registry → Reliable → Router） | 单家 API 故障自动降级，业务零感知 |
| **四层记忆** | onTurnStart 并行读 + onTurnEnd 串行写 + 沉淀 | Agent 像人一样有"现在/昨天/上周"的认知层次 |
| **Debounce 聚合** | 每条消息注册 delay=2s 的 Bull job | 用户连发不抢答，停止打字才回 |
| **Replay 保护** | REPLAY_BLOCKING 白名单 + deferTurnEnd | 不可逆操作绝不被丢弃，记忆与回复一致 |
| **per-chat 串行** | Redis 处理锁 (300s) | 同一会话同时只有一个 Agent 在生成 |
| **Section 化 Prompt** | 场景注册表 + PromptSection 接口 | 新场景 / 新护栏接入只改一处 |
| **AI 流追踪** | AiStreamTrace 解析 UIMessageChunk | 测试与生产隔离观测，时间线粒度到首字节 |
| **告警限流聚合** | 5min 窗口 + 恢复检测 | 一次故障一条告警，不刷屏 |
| **数据三段式** | Supabase SoT + 投影表 + Redis 实时 | 重启不丢数据，热路径走原表，长期趋势走投影 |
| **测试 + 血缘** | Bull Queue 异步执行 + LineageSync | 真实 badcase 反向溯源到对应用例 |

---

## 15. 关键配置速查

### 15.1 必填环境变量（缺失即启动失败）

| 变量 | 说明 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `AGENT_CHAT_MODEL` | 主对话模型（`provider/model` 格式） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis 接入 |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase 接入 |
| `DULIDAY_API_TOKEN` | 杜力岱 API |
| `STRIDE_API_BASE_URL` | 托管平台 API |
| `FEISHU_ALERT_WEBHOOK_URL` / `FEISHU_ALERT_SECRET` | 飞书告警 |

### 15.2 由 Supabase `hosting_config` 动态下发

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `initialMergeWindowMs` | 3000 | 消息聚合 debounce 窗口 |
| `typingSpeedCharsPerSec` / `paragraphGapMs` | - | 拟人化打字策略 |
| `workerConcurrency` | 4 | 实际执行并发 |
| `wecomCallbackModelId` / `wecomCallbackThinkingMode` | - | 渠道侧模型选择 |

### 15.3 关键 Agent 行为变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_MAX_OUTPUT_TOKENS` | 4096 | 单次输出上限 |
| `AGENT_MAX_INPUT_CHARS` | 8000 | 输入字符上限 |
| `AGENT_THINKING_BUDGET_TOKENS` | 0 | Extended thinking 预算 |
| `MAX_HISTORY_PER_CHAT` | 60 | 短期窗口最大消息数 |
| `MEMORY_SESSION_TTL_DAYS` | 1 | 会话级 TTL + 沉淀阈值 |
| `MESSAGE_DEDUP_TTL_SECONDS` | 300 | 去重 TTL |

---

## 16. 可扩展点

| 想做的事 | 入口 |
| --- | --- |
| 新增 Provider | `RegistryService.onModuleInit()` 自动检测 / OAI-compatible 表 |
| 新增工具 | `src/tools/my-tool.ts` + `ToolRegistryService` 注册 + `scenarioToolMap` |
| 新增不可逆工具 | 同上 + 加入 `REPLAY_BLOCKING_TOOL_NAMES` |
| 新增 Prompt Section | 实现 `PromptSection` + `ContextService.registerSections()` |
| 新增场景 | `SCENARIO_SECTIONS` + `scenarioToolMap` 各加一行 |
| 新增渠道 | `src/channels/` 新建模块，构造 `AgentInvokeParams` 调 `AgentRunnerService` |
| 新增告警渠道 | 仿 `FeiShuAlertService` 实现，注册到 `AlertOrchestratorService` |
| 新增评估维度 | `LlmEvaluationService.generateStructured` + 自定义 schema |

---

## 17. 演进路线

### 已完成（v1.x）

- ✅ Agent 编排引擎（Recall → Compose → Execute → Store）
- ✅ 三层模型容错（Registry / Reliable / Router）
- ✅ 四层记忆系统 + 后置事实提取 + 闲置沉淀
- ✅ 企微消息 Debounce 聚合 + Replay 保护
- ✅ 监控数据三段式 + 飞书告警限流聚合
- ✅ 测试套件（用例 + 回归 + LLM 评分 + 飞书双向同步）
- ✅ AI 流追踪 + 资产血缘
- ✅ 群任务流水线（4 种策略）

### 进行中（v2.x）

- ⏳ Dashboard 实时进度 SSE/WebSocket（目前轮询）
- ⏳ 测试套件统计图表可视化
- ⏳ 多维评估（规则 + 性能 + 安全）

### 规划中

- 🔜 用户级限流 + 成本预算控制
- 🔜 Provider 熔断器（Circuit Breaker）
- 🔜 从生产 badcase 自动沉淀测试用例
- 🔜 CI/CD 集成（PR 触发回归 + 评估推送）
- 🔜 版本对比（A/B Testing、Prompt/模型对照）

---

## 18. 团队与文档维护

- **维护团队**：DuLiDay
- **架构文档目录**：[`docs/architecture/`](./architecture/)
- **开发规范目录**：[`.claude/agents/`](../.claude/agents/)
- **数据库迁移**：[`supabase/migrations/`](../supabase/migrations/)
- **Dashboard 前端**：`web/`（独立仓库目录）

> 本说明书为整合材料，单一 Source of Truth 仍以 `docs/architecture/` 下的各专题文档为准。
> 当任意架构发生重大变化时，请同步更新对应专题文档与本说明书的相关章节。
