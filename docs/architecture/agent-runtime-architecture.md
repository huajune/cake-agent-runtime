# Agent 运行时架构

**最后更新**：2026-04-23
**面向**：研发同学
**运营/产品视角**：[agent-runtime-architecture-product-view.md](agent-runtime-architecture-product-view.md)

---

## 1. 总览

Cake Agent Runtime 是一个**自主 AI Agent 编排引擎**，基于 Vercel AI SDK 构建，通过企业微信渠道为招聘场景提供智能对话服务。

核心回合模型（turn lifecycle）：

```
onTurnStart → Compose → Execute (LLM + Tools) → onTurnEnd
   ↑ 读记忆       组装 prompt       多步工具循环       写记忆 / 沉淀
```


## 2. 分层架构

```
┌──────────────────────────────────────────┐
│   WeChat 托管平台回调 / 其它入口         │
└──────────────────┬───────────────────────┘
                   ↓
┌──────────────────────────────────────────┐
│  Channels 渠道层                          │
│  Ingress → Pipeline → ReplyWorkflow      │
│  Delivery / Merge / Dedup / Observability│
└──────────────────┬───────────────────────┘
                   ↓
┌──────────────────────────────────────────┐
│  Agent 编排层                             │
│  AgentRunnerService                      │
│   ├─ AgentPreparationService  (prepare)  │
│   ├─ ContextService           (compose)  │
│   └─ LlmExecutorService       (execute)  │
└──────────────────┬───────────────────────┘
                   ↓
┌────────────┐ ┌────────┐ ┌──────────┐ ┌────────────┐
│ Memory     │ │ Tools  │ │ Evaluation│ │ Providers  │
│ Lifecycle  │ │ Registry│ │ TestSuite│ │ Registry   │
└────────────┘ └────────┘ └──────────┘ │ Reliable   │
                                       │ Router     │
                                       └────────────┘
                   ↓
┌──────────────────────────────────────────┐
│  Infrastructure 层                        │
│  Redis / Supabase / HTTP / Feishu / etc. │
└──────────────────────────────────────────┘
```

**层间依赖规则**：

- `infra/` 禁止依赖 `biz/`、`channels/`、`agent/`、`memory/`
- `agent/` 不依赖 `channels/`，通过参数接收上下文（含回调）
- `channels/` 通过 `AgentRunnerService` 接口调用 Agent
- `memory/`、`tools/`、`evaluation/` 通过 `llm/` 使用模型能力，不直接依赖 `providers/` 内部实现

更聚焦的调用关系图：[LLM Executor 依赖图](./llm-executor-dependency-diagram.md)

---

## 3. Agent 编排层

入口：[src/agent/runner.service.ts](src/agent/runner.service.ts)

`AgentRunnerService` 只做两件事：**调 LLM**、**收尾**。所有准备工作下放到独立的 `AgentPreparationService`，所有 LLM 请求统一走 `LlmExecutorService`。

### 3.1 调用链

```
invoke(params) / stream(params)
 │
 ├─ AgentPreparationService.prepare(params, mode, { enableVision })
 │     返回 PreparedAgentContext
 │
 ├─ LlmExecutorService.generate() / stream()
 │     system  = ctx.finalPrompt
 │     messages = ctx.normalizedMessages
 │     tools    = ctx.tools
 │     stopWhen = [stepCountIs(ctx.maxSteps), hasToolCall('skip_reply')]
 │     prepareStep = buildPrepareStep(ctx)   // 工具黑名单动态注入
 │
 ├─ recoverEmptyTextResult(...)            // 空文本无工具恢复（兜底一次）
 │
 └─ attachTurnEnd(...)
       ├─ deferTurnEnd=false → fire-and-forget 触发 memory.onTurnEnd
       └─ deferTurnEnd=true  → 挂一个 runTurnEnd dispatcher 给调用方
```

### 3.2 AgentPreparationService.prepare()

[src/agent/agent-preparation.service.ts](src/agent/agent-preparation.service.ts)

单次 prepare 内部步骤：

1. **入参归一化** — 按字符预算裁剪 `messages[]`，从末尾取连续 user 块合并出 `currentUserMessage`（覆盖 WeCom replay / test-suite 多条连发场景）
2. **并行拉取本轮依赖**：
   - `MemoryService.onTurnStart(corpId, userId, sessionId, currentUserMessage, options)` — 记忆快照
   - `RecruitmentCaseService.getActiveOnboardFollowupCase()` — 在跟进中的面试/入职 case
3. **消息归一化** — 按 `callerKind` 选择消息源（WECOM 用 memory 历史，其它直传），转 AI SDK `ModelMessage[]`，启用 vision 时注入顶层图片 parts
4. **输入安全检查** — `InputGuardService.detectMessages()` 扫 prompt injection，命中时异步告警并返回 `GUARD_SUFFIX`
5. **Context 组装** — 先用 `RecruitmentStageResolverService` 解析入口阶段（procedural > case > 当前消息），再调用 `ContextService.compose()` 产出 `systemPrompt + stageGoals + thresholds`
6. **工具构建** — `ToolRegistryService.buildForScenario(scenario, toolContext)`，挂 `onJobsFetched` 回调把候选池写入 `turnState`
7. **记忆观测快照** — 基于本轮 recall 构造 `memorySnapshot`（入口阶段 / 已展示岗位 IDs / sessionFacts 扁平化 / profile keys）

返回的 `PreparedAgentContext` 包含 `finalPrompt / normalizedMessages / tools / entryStage / turnState / memorySnapshot / memoryLoadWarning`。

### 3.3 AgentInvokeParams（主要字段）

```typescript
interface AgentInvokeParams {
  callerKind: CallerKind;              // WECOM | TEST_SUITE | DEBUG
  messages: AgentInputMessage[];
  userId: string;
  corpId: string;
  sessionId: string;
  messageId?: string;                  // trace id，用于 turn-end 观测
  scenario?: string;                   // 默认 candidate-consultation
  maxSteps?: number;                   // 默认 5

  // 模型控制
  modelId?: string;                    // 覆盖角色路由
  disableFallbacks?: boolean;          // 测试保真用
  thinking?: AgentThinkingConfig;      // extended thinking

  // 多模态
  imageUrls?: string[];
  imageMessageIds?: string[];
  visualMessageTypes?: Record<string, IMAGE | EMOTION>;

  // 策略版本
  strategySource?: 'released' | 'testing';

  // WeCom 链路身份（供工具使用）
  botUserId?: string;
  botImId?: string;
  externalUserId?: string;
  contactName?: string;
  token?: string;
  imContactId?: string;
  imRoomId?: string;
  apiType?: 'enterprise' | 'group';

  // 回合控制
  shortTermEndTimeInclusive?: number;  // 短期记忆读取上界（replay/merge 用）
  deferTurnEnd?: boolean;              // 由调用方显式触发 turn-end
  onPreparedRequest?: (request) => void; // LLM 请求快照观测
}
```

### 3.4 AgentRunResult（主要字段）

```typescript
interface AgentRunResult {
  text: string;
  reasoning?: string;
  responseMessages?: Array<Record<string, unknown>>;
  steps: number;
  agentSteps: AgentStepDetail[];      // 每步详情（text / toolCalls / usage / durationMs）
  toolCalls: AgentToolCall[];         // 扁平工具调用序列（含 status / resultCount）
  usage: { inputTokens; outputTokens; totalTokens };
  agentRequest?: Record<string, unknown>;
  memorySnapshot?: AgentMemorySnapshot;
  runTurnEnd?: () => Promise<void>;    // deferTurnEnd=true 时可用
}
```

### 3.5 三条调用路径

`callerKind` 是调用方身份的显式声明，控制"是否从 memory 读取历史"等运行时行为：

| callerKind   | messages[] 含义           | 短期记忆                | 调用方                                   |
| ------------ | ------------------------- | ----------------------- | ---------------------------------------- |
| `WECOM`      | 只含当前 user 消息        | 从 Redis/DB 加载完整历史 | ReplyWorkflowService                     |
| `TEST_SUITE` | 完整历史 + 当前消息       | 不加载                  | TestExecutionService / ConversationTest  |
| `DEBUG`      | 完整历史 + 当前消息       | 不加载                  | AgentController.debugChat                |

`callerKind` 与 `strategySource` 正交：test-suite 可覆盖 `strategySource: 'released'` 跑联调。

### 3.6 prepareStep 动态工具屏蔽

[runner.service.ts:241](src/agent/runner.service.ts#L241) `buildPrepareStep()` 在每一步开始前基于历史 steps 收紧 `activeTools`：

- **同名工具超限**：单轮同一工具 ≥ `MAX_SAME_TOOL_CALLS_PER_TURN` 次 → 屏蔽后续调用（典型场景：`duliday_job_list` 不断换参扩面）
- **skip_reply 互斥**：本轮已有任一业务工具调用 → 屏蔽 `skip_reply`（沉默只允许在无业务动作的轮次）

屏蔽同时在 system 末尾拼上说明，避免直接 stopWhen 导致整轮无回复。

### 3.7 空文本恢复

工具链偶发以"有 reasoning、有 tool results，但最终文本为空"结束。[runner.service.ts:476](src/agent/runner.service.ts#L476) `recoverEmptyTextResult()` 在这种情况下关闭工具、把已执行工具结果压缩成 transcript，让模型再补一条候选人可见回复。恢复失败则保留原空结果交上层兜底。

### 3.8 LlmExecutorService — 共享 LLM 入口

[src/llm/llm-executor.service.ts](src/llm/llm-executor.service.ts) 是所有 LLM 调用的统一入口：

```typescript
generate(options: LlmGenerateOptions)
generateStructured(options: LlmGenerateStructuredOptions)
stream(options: LlmStreamOptions)
supportsVisionInput(options): boolean
```

消费方包括：`AgentRunnerService`、`SessionService.extractAndSave`（事实提取）、`MemoryEnrichmentService`（外部画像补全）、`LlmEvaluationService`、`InputGuardService`（注入分析）等。所有请求都经由 `RouterService → ReliableService → RegistryService` 三层处理。

---

## 4. Context System — Prompt 组装

入口：[src/agent/context/context.service.ts](src/agent/context/context.service.ts)

`ContextService.compose()` 输出 `{ systemPrompt, stageGoals, thresholds }`。

### 4.1 PromptSection 接口

```typescript
interface PromptSection {
  readonly name: string;
  build(ctx: PromptContext): Promise<string> | string;
}
```

`PromptContext` 由 prepare 阶段装配：`strategyConfig / currentStage / memoryBlock / sessionFacts / highConfidenceFacts / groupInventoryBlock / currentTimeText / channelType`。

### 4.2 场景注册表

[src/agent/context/scenarios/scenario.registry.ts](src/agent/context/scenarios/scenario.registry.ts)

```typescript
SCENARIO_SECTIONS = {
  'candidate-consultation': [
    'identity',          // 角色定义、沟通风格（IdentitySection）
    'base-manual',       // 从 candidate-consultation.md 加载的业务手册（StaticSection）
    'policy',            // red-lines + thresholds 聚合
    'runtime-context',   // stage-strategy + memory + turn-hints + hard-constraints + datetime + channel
    'group-inventory',   // 候选人意向城市的兼职群资源概览（GroupInventorySection）
    'final-check',       // 从 candidate-consultation-final-check.md 加载的出规校验清单
  ],
  'group-operations': ['identity', 'datetime', 'channel'],
  evaluation: ['identity'],
};
```

### 4.3 Section 清单

[src/agent/context/sections/](src/agent/context/sections/)

**顶层结构（candidate-consultation 使用）**：

| Section           | 职责                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `identity`        | 角色、沟通风格、工作流程                                                  |
| `base-manual`     | `candidate-consultation.md` 业务手册（StaticSection）                     |
| `policy`          | 聚合 `red-lines` + `thresholds`                                           |
| `runtime-context` | 聚合 `stage-strategy` → `memory` → `turn-hints` → `hard-constraints` → `datetime` → `channel` |
| `group-inventory` | 按候选人意向城市预渲染兼职群库存（行业、可用容量）                        |
| `final-check`     | `candidate-consultation-final-check.md` 出规校验清单                      |

**叶子 section（被上面聚合，也可独立使用）**：`red-lines / thresholds / stage-strategy / memory / turn-hints / hard-constraints / datetime / channel`。

### 4.4 策略配置来源

`strategyConfig` 由 [StrategyConfigService](src/biz/strategy/services/strategy-config.service.ts) 从 Supabase 读取。`strategySource` 决定版本：

- `released`（默认，WeCom 走这里）
- `testing`（测试套件、dashboard 调试）

### 4.5 Compose 最终结构

```
[identity]
[base-manual]
[policy]                  ← red-lines + thresholds
[runtime-context]         ← 本轮会变动的全部内容
  ├─ stage-strategy
  ├─ memory               ← 来自 memoryBlock: [用户档案] + [会话记忆] + [当前预约信息]
  ├─ turn-hints
  ├─ hard-constraints
  ├─ datetime
  └─ channel
[group-inventory]
[final-check]
```

`memoryBlock` 的三段由 `AgentPreparationService.buildMemoryBlock()` 组装，来源：长期档案 + `WeworkSessionState` + `RecruitmentCaseRecord`。

---

## 5. Provider 层 — 三层模型架构

```
┌────────────────────────────────────────────────┐
│ Layer 3: RouterService — 角色/路由             │
│  resolveRoute({ role, overrideModelId, ... })  │
│  AGENT_CHAT_MODEL / AGENT_EXTRACT_MODEL / ...  │
├────────────────────────────────────────────────┤
│ Layer 2: ReliableService — 容错                │
│  retry（指数退避）+ fallback 链降级             │
│  错误分类：retryable / rate_limited / non_retryable │
├────────────────────────────────────────────────┤
│ Layer 1: RegistryService — 工厂注册            │
│  "provider/model" → LanguageModel 实例         │
└────────────────────────────────────────────────┘
```

[src/providers/](src/providers/)

### 5.1 角色枚举

[src/llm/llm.types.ts](src/llm/llm.types.ts) 定义 `ModelRole`：`Chat / Fast / Classify / Extract / Reasoning / Vision` 等。每个角色通过 `AGENT_{ROLE}_MODEL` 映射到具体 modelId，`AGENT_{ROLE}_FALLBACKS` 定义降级链。

### 5.2 Provider 注册

[registry.service.ts](src/providers/registry.service.ts) 启动时按环境变量按需注册：

| 分类           | Provider     | SDK                        | 注册条件                  |
| -------------- | ------------ | -------------------------- | ------------------------- |
| 原生           | `anthropic`  | @ai-sdk/anthropic          | ANTHROPIC_API_KEY         |
| 原生           | `google`     | @ai-sdk/google             | GEMINI_API_KEY            |
| 原生           | `deepseek`   | @ai-sdk/deepseek           | DEEPSEEK_API_KEY          |
| 自定义         | `openai`     | custom-openai.provider     | ANTHROPIC_API_KEY（代理） |
| 自定义         | `openrouter` | custom-openrouter.provider | OPENROUTER_API_KEY        |
| OAI-compatible | `qwen`       | @ai-sdk/openai-compatible  | DASHSCOPE_API_KEY         |
| OAI-compatible | `moonshotai` | @ai-sdk/openai-compatible  | MOONSHOT_API_KEY          |
| OAI-compatible | `gateway`    | @ai-sdk/openai-compatible  | GATEWAY_API_KEY + URL     |

### 5.3 容错策略

[reliable.service.ts](src/providers/reliable.service.ts)

```
请求 → 主模型重试 → fallback 模型 1 → fallback 模型 2 → 抛出
```

错误分类：

| 类别            | 触发条件                           | 行为                           |
| --------------- | ---------------------------------- | ------------------------------ |
| `non_retryable` | 401/403/404、invalid key、余额不足 | 跳过重试，直接降级             |
| `rate_limited`  | 429、rate limit                    | 指数退避，尊重 Retry-After     |
| `retryable`     | 5xx、timeout、网络错误             | 标准指数退避                   |

默认 `maxRetries=3, baseBackoff=100ms, maxBackoff=10s`。

---

## 6. 记忆系统

> 完整设计详见 [memory-system-architecture.md](memory-system-architecture.md)

### 6.1 四类记忆

```
短期记忆   chat_messages → 窗口裁剪 → messages[]        读/写：ShortTermService
会话记忆   Redis SESSION_TTL                            读/写：SessionService
  ├─ facts（interview_info + preferences）
  ├─ lastCandidatePool / presentedJobs / currentFocusJob
  ├─ invitedGroups
  └─ lastSessionActiveAt
程序记忆   Redis SESSION_TTL → currentStage             读/写：ProceduralService
长期记忆   Supabase（+Redis 2h 缓存）                   读/写：LongTermService
  ├─ profile（姓名、电话、性别、年龄、学生、学历、健康证 ...）
  └─ summary（对话摘要）
```

### 6.2 统一生命周期：onTurnStart / onTurnEnd

[src/memory/memory.service.ts](src/memory/memory.service.ts) 是唯一对外 facade，背后由 [MemoryLifecycleService](src/memory/services/memory-lifecycle.service.ts) 统一编排：

```typescript
// 回合开始：并行读取四类记忆 + 前置高置信识别 + 可选外部画像补全
await memoryService.onTurnStart(corpId, userId, sessionId, currentUserMessage, {
  includeShortTerm: callerKind === CallerKind.WECOM,
  shortTermEndTimeInclusive,
  enrichmentIdentity,   // 触发 MemoryEnrichmentService 向外部系统补全
});

// 回合结束：按步骤写回 + 观测埋点
await memoryService.onTurnEnd({
  corpId, userId, sessionId, messageId,
  normalizedMessages,
  candidatePool,        // 本轮 duliday_job_list 工具产出的候选池
}, assistantText);
```

### 6.3 onTurnEnd 的执行步骤

每一步在 `message_processing_records.post_processing_status` 中留下 `success / failure / skipped + durationMs`，串行 + 分支并行混合执行：

```
load_previous_state (串行)
  ↓
┌─ 分支 A (可能 skip):
│    settlement  ─ 会话超 SESSION_TTL 未活跃 → 沉淀到 profile + summary
│
└─ 分支 B (串行，因为共享 session state):
     save_candidate_pool     ─ 写入 lastCandidatePool
     store_activity          ─ 刷新 lastSessionActiveAt
     project_assistant_turn  ─ 从 assistant 文本投影 presentedJobs / currentFocusJob
     extract_facts           ─ LLM 提取 facts（preferences / interview_info）
```

### 6.4 高置信识别（前置）

[src/memory/facts/high-confidence-facts.ts](src/memory/facts/high-confidence-facts.ts) 在 `onTurnStart` 里对当前 user 文本做规则匹配（品牌别名、城市、年龄、labor_form 等），产出 `highConfidenceFacts` 注入到 Context 的 `turn-hints` section，让模型优先消费本轮可靠信号。

新增文件 [src/memory/facts/labor-form.ts](src/memory/facts/labor-form.ts)：识别用工形式（兼职+/小时工/寒假工/暑假工），与平台仅兼职岗位的业务约束对齐。

### 6.5 外部画像补全

[MemoryEnrichmentService](src/memory/services/memory-enrichment.service.ts) 当 `onTurnStart` 传入 `enrichmentIdentity`（token + imBotId + externalUserId 等）时，向外部杜力岱系统补全缺失的 profile 字段（如性别），并更新快照。仅 `candidate-consultation` 场景 + 有 token 时触发。

### 6.6 设计原则

- **LLM 不直接持有记忆读写权**：所有记忆读取 / 写入由编排层在 `onTurnStart` / `onTurnEnd` 统一调度
- **工具仅保留两个触达记忆**：`advance_stage`（写程序记忆）、`recall_history`（读长期摘要）
- **会话记忆是结构化的**：`SessionService` 拆分成 store / projection / extraction 三块，外部不应直接拼 Redis key

---

## 7. 工具系统

入口：[src/tools/tool-registry.service.ts](src/tools/tool-registry.service.ts)

### 7.1 内置工具清单

| 工具                          | 职责                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `advance_stage`               | 推进程序记忆阶段                                                           |
| `recall_history`              | 查询用户历史求职记录摘要                                                   |
| `duliday_job_list`            | 查询在招岗位（含 geocode + 距离排序 + 业务阈值过滤）；回调写入候选池       |
| `duliday_interview_precheck`  | 面试前置校验（可约日期 / 时段 / 备注字段）；不真正提交预约                 |
| `duliday_interview_booking`   | 面试预约提交（副作用：创建 recruitment_case、失败侧暂停托管）              |
| `geocode`                     | 地名 → 标准化地址 + 经纬度                                                 |
| `send_store_location`         | 向候选人发送门店企微位置消息                                               |
| `invite_to_group`             | 邀请加入企微兼职群（副作用：addMember 外部 API + session facts 写入）       |
| `raise_risk_alert`            | 候选人投诉/辱骂/情绪升级时触发人工介入（暂停托管 + 飞书告警）               |
| `request_handoff`             | 面试/入职跟进阻塞时申请人工接管（case 标记 handoff + 暂停托管 + 告警）      |
| `skip_reply`                  | 主动沉默本轮（仅候选人发纯确认词且上轮已推进时使用）                       |

**动态注入**：本轮 `imageMessageIds` 非空时，运行时注入 `save_image_description` 工具（让模型把图片/表情内容写回 DB 供后续检索）。

**MCP 扩展**：`registerMcpTool(name, tool, mcpServer)` 可运行时注册 MCP 工具，自动叠加到所有场景。

### 7.2 场景 → 工具映射

```typescript
scenarioToolMap = {
  'candidate-consultation': [
    'advance_stage', 'recall_history',
    'duliday_job_list', 'duliday_interview_precheck', 'duliday_interview_booking',
    'geocode', 'send_store_location',
    'invite_to_group',
    'raise_risk_alert', 'request_handoff',
    'skip_reply',
  ],
  'group-operations': [],
  evaluation: [],
};
```

### 7.3 工具构建上下文

`ToolBuildContext` 由 `AgentPreparationService.buildToolContext()` 装配，含 `userId / corpId / sessionId / messages / currentStage / stageGoals / thresholds / profile / sessionFacts / currentFocusJob / onJobsFetched / token / botUserId / botImId / imContactId / imRoomId / apiType ...`。

### 7.4 不可逆工具与 Replay 保护

WeCom 链路识别以下工具为"触发后不可撤销"：

```typescript
REPLAY_BLOCKING_TOOL_NAMES = ['advance_stage', 'invite_to_group', 'duliday_interview_booking']
```

首次 Agent 调用若命中其中任意一个，即便生成期间有新消息到达也不 replay —— 直接投递首次回复（详见 §8.3）。

---

## 8. 消息管线 — WeCom 渠道

[src/channels/wecom/message/](src/channels/wecom/message/)

```
ingress/             回调入口（Controller + DTO + Schema）
application/         业务逻辑
  ├─ accept-inbound-message.service.ts   管线入口（去重/过滤/写历史/监控）
  ├─ reply-workflow.service.ts           Agent 调用 + Replay + 投递
  ├─ pre-agent-risk-intercept.service.ts 前置风险同步预检
  ├─ image-description.service.ts        图片/表情描述处理
  ├─ message-processing-failure.service.ts 错误分类 + 飞书告警
  ├─ pipeline.service.ts                 薄门面，转发到 accept/reply
  └─ filter/                             过滤规则
delivery/            打字延迟 + 分段发送
runtime/             dedup / merge / processor / worker / redis-keys
telemetry/           observability / trace store
```

### 8.1 回调处理流程

```
POST /wecom/message
  │
  ├─ AcceptInboundMessageService.execute()
  │   ├─ 自发消息处理（bot 自己发 → 存 assistant 历史）
  │   ├─ 过滤（消息类型 / 来源校验）
  │   ├─ 去重（Redis 24h）
  │   ├─ 写历史（Supabase chat_messages）
  │   └─ 记录入站流水（message_processing_records）
  │   → 返回 200 OK
  │
  ├─ AI 开关检查 → 分发决策
  │   ├─ 聚合：SimpleMergeService（debounce 静默窗口）
  │   └─ 直发：processSingleMessage
  │
  └─ ReplyWorkflowService.processMessageCore()
      ├─ 前置风险预检（命中则同步暂停+告警，不短路 Agent）
      ├─ 首次 callAgent(deferTurnEnd=true)
      ├─ 不可逆工具检查 → 若命中，立即投递（跳过 replay）
      ├─ 否则 Replay 检测（见 §8.3）
      ├─ 降级响应 → 飞书告警
      ├─ 主动沉默（skip_reply）→ 跳过发送
      └─ DeliveryService 分段发送 + 打字延迟
```

### 8.2 消息聚合（debounce）

静默窗口机制，处理用户快速连发场景：

```
消息 1  → pending list，注册 delay=3s 的 job A
消息 2  → 追加 list，注册 delay=3s 的 job B
消息 3  → 追加 list，注册 delay=3s 的 job C

t=3s    job A 触发 → 距最后消息未静默够 → 跳过
...
job C   距最后消息 3s → 静默够了 → 取出全部消息交给 Agent
```

| 参数                | 默认   | 配置位置                                       |
| ------------------- | ------ | ---------------------------------------------- |
| `initialMergeWindowMs` | 3000ms | Supabase `hosting_config`（Dashboard 动态调整） |

> 不再有 "最大聚合数" 上限 —— debounce 天然会在用户停顿后触发。

### 8.3 Replay 保护

Agent 生成期间若用户又发了新消息，默认行为：

```
首次 callAgent(deferTurnEnd=true)
  ↓
检测 pending list 有新消息？
  ├─ 否 → 投递首次回复，显式触发 turn-end lifecycle
  └─ 是
      ↓
    首次 toolCalls 命中 REPLAY_BLOCKING_TOOL_NAMES？
      ├─ 是 → 投递首次回复，触发 turn-end（副作用已固化，不能丢弃）
      └─ 否
          ↓
        丢弃首次回复 + runTurnEnd（记忆副作用一并丢弃，避免污染 session）
        合并新消息重跑一次（不再二次 replay，避免无限循环）
        第二次 runner 内部 fire-and-forget 触发 turn-end
```

设计原因：首次生成的回复若被丢弃，它所投影的 `presentedJobs / facts` 若写入 session 会污染下一轮 recall。`deferTurnEnd=true` 让调用方控制"采纳后才触发"。

### 8.4 降级策略

Agent 抛错时，[MessageProcessingFailureService](src/channels/wecom/message/application/message-processing-failure.service.ts) 统一处理：

- 发送降级回复（环境变量 `AGENT_FALLBACK_MESSAGE` 自定义，或内置 6 条随机话术）
- 分级飞书告警（WARNING / ERROR / CRITICAL）
- 记录失败流水（`message_processing_records.status = failed`）

---

## 9. 评估模块

Agent 质量保障被拆在两处：

- [src/evaluation/](src/evaluation/) — 通用评估能力（`LlmEvaluationService` 打分、`ConversationParserService` 对话解析）
- [src/biz/test-suite/](src/biz/test-suite/) — 测试套件业务层（编排、执行、数据导入、写回、lineage 同步、AI 流观测）

```
biz/test-suite/
├── TestExecutionService       单条测试执行（通过 AgentRunnerService.invoke callerKind=TEST_SUITE）
├── TestBatchService           批量管理 + 统计
├── ConversationTestService    多轮对话测试
├── TestImportService          测试用例导入
├── TestWriteBackService       结果回写
├── CuratedDatasetImportService 精选数据集导入
├── LineageSyncService         飞书 lineage 同步
├── AiStreamObservabilityService + trace store / timing   AI 流观测
└── TestSuiteProcessor         Bull 队列异步执行

evaluation/
├── LlmEvaluationService       LLM-based 意图等价性打分
└── ConversationParserService  对话文本解析
```

评估返回 `{ score: 0-100, passed: score >= 60, reason }`，通过 `LlmExecutorService.generateStructured()` 走 classify/extract 角色。

---

## 10. 模块依赖图

```
AppModule
├── InfraModule
│   ├── ConfigModule         env 校验
│   ├── RedisModule          Upstash REST (Global)
│   ├── SupabaseModule       数据库
│   ├── HttpClientModule     HTTP 工厂
│   ├── FeishuModule         飞书
│   └── GeocodingModule      地理编码
│
├── ProvidersModule
│   ├── RegistryService      Layer 1
│   ├── ReliableService      Layer 2
│   └── RouterService        Layer 3
│
├── LlmModule
│   └── LlmExecutorService   共享 LLM 入口
│
├── MemoryModule
│   ├── MemoryService        facade
│   ├── MemoryLifecycleService  onTurnStart / onTurnEnd 编排
│   ├── ShortTermService     短期窗口
│   ├── SessionService       会话记忆（store + projection + extraction）
│   ├── ProceduralService    程序阶段
│   ├── LongTermService      用户档案 + 摘要
│   ├── SettlementService    Session → Profile 沉淀
│   ├── MemoryEnrichmentService  外部画像补全
│   ├── RedisStore / SupabaseStore
│   └── MemoryConfig
│
├── ToolModule
│   └── ToolRegistryService  内置 + 动态 + MCP
│
├── AgentModule
│   ├── AgentRunnerService         编排引擎
│   ├── AgentPreparationService    prepare 流程
│   ├── ContextService             prompt 组装
│   ├── AgentController / AgentHealthService
│   └── InputGuardService          prompt injection 检测
│
├── ChannelsModule
│   └── WecomModule
│       └── MessageModule
│           ├── AcceptInboundMessageService
│           ├── ReplyWorkflowService
│           ├── PreAgentRiskInterceptService
│           ├── MessageProcessingFailureService
│           ├── MessageDeliveryService
│           ├── MessageDeduplicationService
│           ├── SimpleMergeService
│           └── WecomMessageObservabilityService
│
├── BizModule
│   ├── StrategyConfigService       策略版本（released / testing）
│   ├── RecruitmentCaseService      面试/入职跟进 case
│   ├── RecruitmentStageResolverService  阶段推导
│   ├── MessageTrackingService      监控
│   ├── HostingConfigService        托管配置
│   ├── UserHostingService          托管状态
│   ├── InterventionService         人工介入
│   ├── GroupResolverService        企微兼职群解析
│   ├── FeishuSyncService           飞书双向同步
│   └── ChatSessionService          会话持久化
│
├── NotificationModule
│   ├── OpsNotifierService          运营飞书群
│   └── PrivateChatMonitorNotifierService  私聊监听飞书群
│
├── ObservabilityModule
│   └── 观察者接口 + incidents + runtime 观测
│
├── EvaluationModule
│   ├── LlmEvaluationService
│   └── ConversationParserService
│
└── (BizModule → TestSuiteModule)
    ├── TestExecutionService / TestBatchService / ConversationTestService
    ├── TestImportService / TestWriteBackService
    ├── CuratedDatasetImportService / LineageSyncService
    ├── AiStreamObservabilityService + trace store / timing
    └── TestSuiteProcessor
```

---

## 11. 完整请求生命周期

以用户发送"你们招收银员吗？工资多少？"为例：

```
1. POST /wecom/message
   │
2. AcceptInboundMessageService.execute()
   ├─ 通过过滤 / 非重复 / 写 chat_messages / 记录入站流水
   └─ shouldDispatch=true
   │
3. SimpleMergeService: debounce 静默 3s
   └─ 超时触发 processMergedMessages(batchId)
   │
4. ReplyWorkflowService.processMessageCore()
   │
5. PreAgentRiskInterceptService.precheck()
   └─ 不命中，继续
   │
6. callAgent({ deferTurnEnd: true })
   │
   └─ AgentRunnerService.invoke(params)
       │
       ├─ AgentPreparationService.prepare()
       │   ├─ 入参归一化 → currentUserMessage
       │   ├─ MemoryService.onTurnStart() 并行读：
       │   │   ├─ 短期：最近 60 条对话（WECOM 启用）
       │   │   ├─ 会话记忆：{ preferences: { city:'上海' }, lastCandidatePool: [...] }
       │   │   ├─ 程序阶段：'needs_collection'
       │   │   ├─ 长期档案：{ name: '张三', phone: '138xxxx' }
       │   │   └─ 高置信识别：{ preferences: { jobIntent: '收银员' } }
       │   ├─ RecruitmentCaseService 查活跃 case（无）
       │   ├─ InputGuard 扫注入 → safe
       │   ├─ RecruitmentStageResolver.resolve → entryStage='recommend'
       │   ├─ ContextService.compose()
       │   │   → systemPrompt (identity + base-manual + policy + runtime-context + group-inventory + final-check)
       │   ├─ ToolRegistryService.buildForScenario('candidate-consultation', toolContext)
       │   │   → 11 个内置工具
       │   └─ memorySnapshot 快照构造
       │
       ├─ LlmExecutorService.generate()
       │   │ role=Chat → AGENT_CHAT_MODEL
       │   │ prepareStep 钩子 + stopWhen
       │   │
       │   ├─ Step 1: 调用 duliday_job_list(position='收银员', location='上海')
       │   │   ↓
       │   │   onJobsFetched 回调 → turnState.candidatePool = 3 个岗位
       │   │
       │   └─ Step 2: 组织自然语言回复
       │
       ├─ recoverEmptyTextResult() → text 非空，跳过
       │
       └─ attachTurnEnd(deferTurnEnd=true)
           → result.runTurnEnd 暴露给调用方
   │
7. ReplyWorkflowService 检查 blockingTools
   └─ toolCalls 只含 duliday_job_list → 非不可逆
   │
8. fetchPendingSinceAgentStart
   └─ 无新消息 → 显式触发 result.runTurnEnd()
       │
       └─ MemoryLifecycleService.onTurnEnd()
           ├─ load_previous_state
           ├─ 分支 A: settlement（未超阈值 → skipped）
           └─ 分支 B（串行）：
               ├─ save_candidate_pool（3 个岗位写入 session）
               ├─ store_activity（刷新 lastSessionActiveAt）
               ├─ project_assistant_turn（从回复投影 presentedJobs）
               └─ extract_facts（LLM 提取 preferences.salary、interview_info 等）
   │
9. MessageDeliveryService
   ├─ 回复分段: ["我们确实招收银员！...", "时薪大概..."]
   ├─ 段 1 打字延迟 ~400ms
   ├─ 段间隔 2000ms
   └─ 段 2 打字延迟 ~400ms
   │
10. markMessagesAsProcessed + recordSuccess
```

---

## 12. 扩展点

### 12.1 新增 Provider
1. 配置环境变量 API Key
2. `RegistryService.onModuleInit()` 自动检测并注册（原生 SDK）或追加到 `providers/types.ts` OAI-compatible 表
3. 使用 `provider/model` 格式引用

### 12.2 新增工具
1. 创建 `src/tools/my-tool.ts`，导出 `buildMyTool()` 工厂函数
2. 在 `ToolRegistryService` 构造函数的 `registry` 映射中注册
3. 在 `scenarioToolMap` 中添加到目标场景
4. 若副作用不可逆，同步更新 [reply-workflow.service.ts](src/channels/wecom/message/application/reply-workflow.service.ts) 的 `REPLAY_BLOCKING_TOOL_NAMES`

### 12.3 新增 Prompt Section
1. 实现 `PromptSection` 接口
2. 在 `ContextService.registerSections()` 注册
3. 在 `SCENARIO_SECTIONS` 中加入目标场景

### 12.4 新增场景
1. `SCENARIO_SECTIONS` 定义 section 列表
2. `scenarioToolMap` 定义工具列表
3. 调用时传入 `scenario` 参数

### 12.5 新增渠道
1. `src/channels/` 下新建渠道模块
2. 实现"消息接收 → 构造 AgentInvokeParams（callerKind） → 调用 `AgentRunnerService.invoke()` → 发送回复"
3. Agent 层完全复用

---

## 13. 关键配置

### 必填（无默认值）

| 变量                        | 说明                                   |
| --------------------------- | -------------------------------------- |
| `ANTHROPIC_API_KEY`         | Anthropic API 密钥                     |
| `AGENT_CHAT_MODEL`          | 主对话模型（`provider/model` 格式）    |
| `UPSTASH_REDIS_REST_URL`    | Redis REST API                         |
| `UPSTASH_REDIS_REST_TOKEN`  | Redis Token                            |
| `NEXT_PUBLIC_SUPABASE_URL`  | Supabase URL                           |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥                          |
| `DULIDAY_API_TOKEN`         | 杜力岱 API Token                       |
| `STRIDE_API_BASE_URL`       | 托管平台 API                           |

### Agent 行为（有默认值）

| 变量                                         | 默认值   | 说明                                       |
| -------------------------------------------- | -------- | ------------------------------------------ |
| `AGENT_MAX_OUTPUT_TOKENS`                    | 4096     | 单次输出 token 上限                        |
| `AGENT_THINKING_BUDGET_TOKENS`               | 0 (关闭) | Extended thinking 预算                     |
| `AGENT_MAX_INPUT_CHARS`                      | 8000     | 输入字符上限（用于窗口裁剪）               |
| `MAX_HISTORY_PER_CHAT`                       | 60       | 短期记忆单轮最多消息数                     |
| `MEMORY_SESSION_TTL_DAYS`                    | 1        | 会话记忆 TTL（天），超期触发 settlement    |
| `SESSION_EXTRACTION_INCREMENTAL_MESSAGES`    | 10       | 已有 facts 时事实提取的增量窗口            |
| `GROUP_MEMBER_LIMIT`                         | 200      | 企微兼职群人数上限                         |
| `AGENT_{ROLE}_MODEL` / `AGENT_{ROLE}_FALLBACKS` | —     | 各角色模型与降级链                         |

### 由托管配置（Supabase `hosting_config`）下发

| 键                     | 默认值 | 说明                   |
| ---------------------- | ------ | ---------------------- |
| `initialMergeWindowMs` | 3000   | 消息聚合 debounce 窗口 |

> 旧环境变量 `INITIAL_MERGE_WINDOW_MS` / `MAX_MERGED_MESSAGES` 已废弃。

---

## 相关文档

- [记忆系统架构](memory-system-architecture.md) — 四类记忆完整设计
- [LLM Executor 依赖图](llm-executor-dependency-diagram.md) — LLM 调用关系图
- [消息服务架构](message-service-architecture.md) — 消息管线详细设计
- [告警系统架构](alert-system-architecture.md) — 飞书告警分级
- [监控系统架构](monitoring-system-architecture.md) — 消息追踪与分析
- [测试套件架构](test-suite-architecture.md) — Agent 评估体系
- [安全防护](security-guardrails.md) — Prompt injection 防护
- [Group Task Pipeline](group-task-pipeline.md) — 群任务流程

## 相关代码

| 模块       | 入口                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| Agent 编排 | [src/agent/runner.service.ts](src/agent/runner.service.ts)                 |
| Prepare    | [src/agent/agent-preparation.service.ts](src/agent/agent-preparation.service.ts) |
| Context    | [src/agent/context/context.service.ts](src/agent/context/context.service.ts) |
| LLM        | [src/llm/llm-executor.service.ts](src/llm/llm-executor.service.ts)         |
| Providers  | [src/providers/router.service.ts](src/providers/router.service.ts)         |
| Memory     | [src/memory/memory.service.ts](src/memory/memory.service.ts)               |
| Lifecycle  | [src/memory/services/memory-lifecycle.service.ts](src/memory/services/memory-lifecycle.service.ts) |
| Tools      | [src/tools/tool-registry.service.ts](src/tools/tool-registry.service.ts)   |
| WeCom 回复 | [src/channels/wecom/message/application/reply-workflow.service.ts](src/channels/wecom/message/application/reply-workflow.service.ts) |
| Evaluation | [src/evaluation/llm-evaluation.service.ts](src/evaluation/llm-evaluation.service.ts) |
| TestSuite  | [src/biz/test-suite/services/test-execution.service.ts](src/biz/test-suite/services/test-execution.service.ts) |
