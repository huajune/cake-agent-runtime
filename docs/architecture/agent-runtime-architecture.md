# Agent 运行时架构

**最后更新**：2026-03-23

---

## 1. 总览

Cake Agent Runtime 是一个**自主 AI Agent 编排引擎**，基于 Vercel AI SDK 构建，通过企业微信渠道为招聘场景提供智能对话服务。

核心编排循环：**Recall → Compose → Execute → Store**

```
┌─────────────────────────────────────────────────────────┐
│                   Agent Runtime                         │
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌───────────┐  │
│  │ Recall  │→ │ Compose │→ │ Execute │→ │  Store    │  │
│  │ 记忆读取 │  │ Prompt  │  │ LLM +   │  │ 事实提取   │  │
│  │         │  │ 组装    │  │ Tools   │  │ 记忆写入   │  │
│  └─────────┘  └─────────┘  └─────────┘  └───────────┘  │
│       ↑                                       │         │
│       └───────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────┘
```

**技术选型**：

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时框架 | NestJS 10.3 | 依赖注入、模块化 |
| AI SDK | Vercel AI SDK | generateText / streamText / tool calling |
| 模型接入 | 多 Provider | Anthropic、OpenAI、DeepSeek、Qwen 等 |
| 会话存储 | Redis (Upstash) | 会话事实、程序记忆 |
| 持久存储 | Supabase (PostgreSQL) | 对话历史、用户档案 |

---

## 2. 分层架构

```
                          ┌──────────────────────┐
                          │   WeChat Callback     │  ← 托管平台回调
                          └──────────┬───────────┘
                                     ↓
                ┌────────────────────────────────────────┐
                │         Channels 渠道层                  │
                │  MessageService → Pipeline → Merge      │
                └────────────────────┬───────────────────┘
                                     ↓
                ┌────────────────────────────────────────┐
                │         Agent 编排层                     │
                │  AgentRunnerService + ContextService            │
                │  CompletionService (一次性调用)           │
                └──┬──────────┬──────────┬───────────────┘
                   ↓          ↓          ↓
          ┌────────────┐ ┌────────┐ ┌─────────┐
          │ Providers  │ │ Memory │ │  Tools  │
          │ 模型层      │ │ 记忆层  │ │ 工具层   │
          └────────────┘ └────────┘ └─────────┘
                   ↓          ↓          ↓
          ┌────────────────────────────────────────┐
          │         Infrastructure 基础设施层         │
          │  Redis / Supabase / HTTP / Feishu Alert │
          └────────────────────────────────────────┘
```

**层间依赖规则**：

- `infra/` 禁止依赖 `biz/`、`channels/`、`agent/`
- `agent/` 不依赖 `channels/`，通过参数接收上下文
- `channels/` 通过 `AgentRunnerService` 接口调用 Agent

---

## 3. Agent Loop — 编排引擎

**入口**：[runner.service.ts](src/agent/runner.service.ts)

AgentRunnerService 是整个运行时的核心，`invoke()` 和 `stream()` 共享完整的 `prepare()` 编排流程。

### 3.1 执行流程

```
invoke(params) / stream(params)
  │
  ├─ prepare()  ─ 共享准备流程
  │   │
  │   ├─ 0. 空闲检测 → SettlementService.checkAndSettle()  [fire-and-forget]
  │   │   └─ 超过 SESSION_TTL → 触发记忆沉淀（Session Facts → Profile + Summary）
  │   │
  │   ├─ 1. Recall — MemoryService.recallAll()
  │   │   ├─ shortTerm:    chat_messages → 窗口裁剪 → messages[]
  │   │   ├─ sessionFacts:  Redis → 本次求职意向
  │   │   ├─ procedural:    Redis → 当前流程阶段
  │   │   └─ longTerm:      Supabase/Redis → 用户档案
  │   │
  │   ├─ 2. 消息选择
  │   │   ├─ userMessage 路径（WeChat）：ShortTermService 内部读取历史
  │   │   └─ messages 路径（API/测试）：直接使用传入列表，字符上限裁剪
  │   │
  │   ├─ 3. Compose — ContextService.compose()
  │   │   └─ 按场景组合 section → systemPrompt
  │   │
  │   ├─ 4. 注入记忆块
  │   │   ├─ [用户档案] ← LongTermService.formatProfileForPrompt()
  │   │   └─ [会话记忆] ← SessionFactsService.formatForPrompt()
  │   │
  │   ├─ 5. Prompt injection 检测 → InputGuardService
  │   │
  │   └─ 6. 构建工具 → ToolRegistryService.buildForScenario()
  │
  ├─ Execute — generateText / streamText
  │   ├─ model:      RouterService.resolveByRole('chat')
  │   ├─ system:     finalPrompt
  │   ├─ messages:   typedMessages
  │   ├─ tools:      scenario 工具集
  │   ├─ stopWhen:   stepCountIs(maxSteps)  [默认 5]
  │   └─ providerOptions: extended thinking（可选）
  │
  └─ Store — storePostMemory()  [异步]
      ├─ 更新 lastInteraction / lastTopic
      └─ FactExtractionService.extractAndSave()  [fire-and-forget]
```

### 3.2 公开接口

```typescript
interface AgentInvokeParams {
  messages?: { role: string; content: string }[];  // API/测试 路径
  userMessage?: string;                             // WeChat 渠道路径
  userId: string;
  corpId: string;
  sessionId: string;
  scenario?: string;     // 默认 'candidate-consultation'
  maxSteps?: number;     // 默认 5
}

interface AgentRunResult {
  text: string;
  reasoning?: string;    // 需启用 AGENT_THINKING_BUDGET_TOKENS
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}
```

### 3.3 两条执行路径

| 路径 | 入参 | 历史消息来源 | 调用方 |
|------|------|------------|--------|
| WeChat 渠道 | `userMessage` | ShortTermService 从 Supabase 读取 | MessagePipelineService |
| API / 测试 | `messages[]` | 直接传入，trimMessages 裁剪 | Controller、TestSuite |

### 3.4 CompletionService — 一次性 LLM 调用

[completion.service.ts](src/agent/completion.service.ts) 用于不需要记忆/工具/循环的简单场景：

- 事实提取（FactExtractionService）
- LLM 评估（LlmEvaluationService）
- Prompt injection 分析
- 群消息生成

```typescript
async generate(params: CompletionParams): Promise<CompletionResult>
async generateSimple(systemPrompt: string, userMessage: string): Promise<string>
```

---

## 4. Context System — Prompt 组装

**入口**：[context.service.ts](src/agent/context/context.service.ts)

将 system prompt 拆分为可组合的 **PromptSection**，按场景动态拼装。

### 4.1 Section 体系

```typescript
interface PromptSection {
  name: string;
  build(ctx: PromptContext): Promise<string> | string;
}
```

**已注册 Section**：

| Section | 内容 | 数据来源 |
|---------|------|---------|
| `identity` | 角色定义、沟通风格、工作流程 | `candidate-consultation.md` 文件 |
| `red-lines` | 禁止行为、合规约束 | StrategyConfigRecord |
| `risk-scenarios` | 敏感场景处理指南 | StrategyConfigRecord |
| `stage-strategy` | 当前阶段目标、CTA 策略、成功标准 | StrategyConfigRecord + currentStage |
| `datetime` | 当前时间（Asia/Shanghai） | 系统时钟 |
| `channel` | 私聊/群聊上下文 | channelType 参数 |

### 4.2 场景注册表

[scenario.registry.ts](src/agent/context/scenarios/scenario.registry.ts)

```typescript
const SCENARIO_SECTIONS = {
  'candidate-consultation': ['identity', 'red-lines', 'risk-scenarios',
                             'stage-strategy', 'datetime', 'channel'],
  'group-operations':       ['identity', 'datetime', 'channel'],
  'evaluation':             ['identity'],
};
```

### 4.3 最终 Prompt 结构

```
[identity section]          ← 角色定义与工作流程
[red-lines section]         ← 禁止行为
[risk-scenarios section]    ← 敏感场景
[stage-strategy section]    ← 当前阶段策略
[datetime section]          ← 当前时间
[channel section]           ← 渠道信息

[用户档案]                   ← Profile（姓名、电话、学历...）
  - 姓名: 张三
  - 联系方式: 138xxxx
  ...

[会话记忆]                   ← Session Facts（本次求职意向）
  - 意向品牌: KFC, 麦当劳
  - 已推荐岗位: ...
  ...
```

---

## 5. Provider 层 — 三层模型架构

借鉴 ZeroClaw Rust Provider 架构，适配 Node.js + Vercel AI SDK。

```
┌─────────────────────────────────────────────────┐
│  Layer 3: RouterService  — 角色路由              │
│  resolveByRole('chat') → AGENT_CHAT_MODEL       │
│  resolveByRole('fast') → AGENT_FAST_MODEL       │
├─────────────────────────────────────────────────┤
│  Layer 2: ReliableService — 容错                 │
│  retry（指数退避）→ fallback（模型降级）           │
├─────────────────────────────────────────────────┤
│  Layer 1: RegistryService — 工厂注册             │
│  "provider/model" → LanguageModel 实例           │
└─────────────────────────────────────────────────┘
```

### 5.1 Layer 1: RegistryService — 纯工厂注册

[registry.service.ts](src/providers/registry.service.ts)

启动时根据环境变量中的 API Key 按需注册 Provider：

| 分类 | Provider | SDK | 注册条件 |
|------|----------|-----|---------|
| 原生 SDK | `anthropic` | @ai-sdk/anthropic | ANTHROPIC_API_KEY |
| 原生 SDK | `google` | @ai-sdk/google | GEMINI_API_KEY |
| 原生 SDK | `deepseek` | @ai-sdk/deepseek | DEEPSEEK_API_KEY |
| 自定义 | `openai` | custom-openai.provider | ANTHROPIC_API_KEY（代理） |
| 自定义 | `openrouter` | custom-openrouter.provider | OPENROUTER_API_KEY |
| OAI-compatible | `qwen` | @ai-sdk/openai-compatible | DASHSCOPE_API_KEY |
| OAI-compatible | `moonshotai` | @ai-sdk/openai-compatible | MOONSHOT_API_KEY |
| OAI-compatible | `gateway` | @ai-sdk/openai-compatible | GATEWAY_API_KEY + URL |

```typescript
resolve(modelId: string): LanguageModel  // "anthropic/claude-sonnet-4-6" → LanguageModel
```

### 5.2 Layer 2: ReliableService — 容错

[reliable.service.ts](src/providers/reliable.service.ts)

```
请求 → 主模型重试（最多 3 次，指数退避）→ fallback 模型 1 → fallback 模型 2 → 抛出
```

**错误分类**：

| 类别 | 触发条件 | 行为 |
|------|---------|------|
| `non_retryable` | 401/403/404、invalid API key、余额不足 | 跳过重试，直接降级 |
| `rate_limited` | 429、rate limit | 指数退避重试，尊重 Retry-After |
| `retryable` | 5xx、timeout、网络错误 | 标准指数退避重试 |

**退避策略**：`backoff = min(100ms × 2^(attempt-1), 10s)`

### 5.3 Layer 3: RouterService — 角色路由

[router.service.ts](src/providers/router.service.ts)

通过环境变量将语义角色映射到具体模型：

```typescript
enum ModelRole {
  Chat = 'chat',         // 主对话 — AGENT_CHAT_MODEL
  Fast = 'fast',         // 快速响应 — AGENT_FAST_MODEL
  Classify = 'classify', // 分类 — AGENT_CLASSIFY_MODEL
  Extract = 'extract',   // 提取 — AGENT_EXTRACT_MODEL
  Reasoning = 'reasoning', // 推理 — AGENT_REASONING_MODEL
}
```

每个角色支持独立的 fallback 链：`AGENT_CHAT_FALLBACKS=openai/gpt-4o,deepseek/deepseek-chat`

---

## 6. 记忆系统

> 完整设计详见 [memory-system-architecture.md](memory-system-architecture.md)

### 6.1 三层模型概览

```
┌── 固定注入（每轮都读）─────────────────────────────┐
│                                                   │
│  短期记忆     chat_messages → 窗口裁剪 → messages[] │
│  会话事实     Redis SESSION_TTL → 求职意向           │
│  程序记忆     Redis SESSION_TTL → 流程阶段           │
│  用户档案     Supabase 永久 → 身份信息               │
│                                                   │
├── 工具按需检索 ────────────────────────────────────┤
│                                                   │
│  对话摘要     Supabase 永久 → recall_history 工具   │
│                                                   │
└───────────────────────────────────────────────────┘
```

### 6.2 统一读取接口

```typescript
// MemoryService.recallAll() — 并行读取所有记忆
const memory = await this.memoryService.recallAll(corpId, userId, sessionId);

interface AgentMemoryContext {
  shortTerm: SimpleMessage[];                        // 对话窗口
  longTerm: { profile: UserProfile | null };         // 用户档案
  procedural: { currentStage, advancedAt, reason };  // 流程阶段
  sessionFacts: SessionFacts | null;                 // 求职意向
}
```

### 6.3 读写时序

| 时机 | 操作 | 执行方式 |
|------|------|---------|
| Agent 请求前 | `recallAll()` — 一次性并行读取 | 同步等待 |
| Agent 完成后 | `storeInteraction()` — 更新交互时间 | 异步 |
| Agent 完成后 | `extractAndSave()` — LLM 事实提取 | fire-and-forget |
| LLM 调用工具 | `advance_stage` — 推进流程阶段 | 工具内同步 |
| LLM 调用工具 | `recall_history` — 检索历史摘要 | 工具内同步 |
| 空闲超时 | Settlement — 沉淀到 Profile + Summary | fire-and-forget |

### 6.4 设计原则

- **编排层固定读写**：记忆的读/存是 Agent Loop 的固定步骤，不由 LLM 自主决定
- **工具仅保留两个**：`advance_stage`（LLM 判断推进时机）、`recall_history`（按需翻阅历史）
- **已删除工具**：`memory_recall`（编排层已注入）、`memory_store`（与 FactExtraction 冲突）

---

## 7. 工具系统

**入口**：[tool-registry.service.ts](src/tools/tool-registry.service.ts)

### 7.1 内置工具

| 工具 | 功能 | 记忆交互 |
|------|------|---------|
| `advance_stage` | 推进招聘流程阶段 | 写入程序记忆 |
| `recall_history` | 查询用户历史求职记录 | 读取长期记忆 |
| `duliday_job_list` | 查询在招岗位（6 个布尔开关控制返回字段） | 通过 `onJobsFetched` 回调保存推荐岗位 |
| `duliday_interview_booking` | 面试预约 | — |

### 7.2 场景工具映射

```typescript
const scenarioToolMap = {
  'candidate-consultation': ['advance_stage', 'recall_history',
                             'duliday_job_list', 'duliday_interview_booking'],
  'group-operations': [],
  'evaluation': [],
};
```

### 7.3 MCP 动态扩展

```typescript
registerMcpTool(name, tool, mcpServer)   // 运行时注册
removeByMcpServer(serverName)            // 按 server 批量移除
```

MCP 工具自动叠加到所有场景的工具集中。

### 7.4 工具构建上下文

```typescript
interface ToolBuildContext {
  userId: string;
  corpId: string;
  sessionId: string;
  messages: ModelMessage[];
  onJobsFetched?: (jobs: RecommendedJobSummary[]) => Promise<void>;
}
```

---

## 8. 消息管线 — WeChat 渠道

```
企微用户发消息
  │
  ├─ 托管平台回调 → POST /wecom/message
  │
  ├─ MessageController.handleCallback()
  │   └─ MessageService.handleMessage(dto)
  │
  ├─ Pipeline.execute(dto)  ─ 快速处理（无 AI）
  │   ├─ step 0: 自发消息处理（bot 自己发的，存为 assistant 历史）
  │   ├─ step 1: 过滤（消息类型、来源校验）
  │   ├─ step 2: 去重（Redis 24h）
  │   ├─ step 3: 写历史（Supabase chat_messages）
  │   └─ step 4: 记录监控
  │   → 返回 200 OK
  │
  ├─ AI 开关检查
  │
  ├─ 分发决策
  │   ├─ 聚合路径：SimpleMergeService 缓冲 1s / 最多 3 条
  │   └─ 直发路径：立即处理
  │
  ├─ processMessageCore()  ─ AI 处理
  │   ├─ 1. AgentRunnerService.invoke()  → Agent 编排
  │   ├─ 2. 检测降级响应 → 飞书告警
  │   ├─ 3. 预约检测（异步，不阻塞）
  │   ├─ 4. 发送回复 → DeliveryService
  │   │   ├─ 消息分段（\n\n + ~ 分隔）
  │   │   ├─ 打字延迟（~100ms/字符）
  │   │   └─ 段落间隔（~2000ms）
  │   └─ 5. 标记已处理 + 记录成功
  │
  └─ 错误处理
      ├─ 发送降级回复（随机选一条友好话术）
      ├─ 飞书告警（分级：WARNING / ERROR / CRITICAL）
      └─ 标记失败
```

### 8.1 消息聚合

处理用户快速连发多条消息的场景：

```
用户消息 1 → [1s 缓冲窗口]
用户消息 2 → [合并]
用户消息 3 → 触发聚合处理（达到上限 3 条）

聚合后 Agent 一次性看到所有消息的上下文
```

| 配置 | 默认值 | 环境变量 |
|------|--------|---------|
| 聚合窗口 | 1000ms | `INITIAL_MERGE_WINDOW_MS` |
| 最大聚合数 | 3 条 | `MAX_MERGED_MESSAGES` |

### 8.2 降级策略

当 Agent 调用失败时，管线确保用户始终能收到回复：

```
Agent 失败
  ├─ 已有部分回复送达？→ 跳过降级（避免重复）
  └─ 无回复送达 → 发送降级消息
      ├─ 环境变量自定义：AGENT_FALLBACK_MESSAGE
      └─ 内置随机话术："我确认下哈，马上回你~" 等 6 条
```

降级同时触发飞书告警，通知相关人员人工介入。

---

## 9. 评估模块

[src/evaluation/](src/evaluation/) — Agent 质量保障

```
TestSuiteService（编排器）
├── TestExecutionService        — 单条测试执行
├── TestBatchService            — 批量管理 + 统计
├── ConversationTestService     — 多轮对话测试
├── ConversationParserService   — 对话文本解析
├── LlmEvaluationService       — LLM 评估（意图等价性）
├── FeishuTestSyncService       — 飞书双向同步
└── TestSuiteProcessor          — Bull 队列异步执行
```

**评估方式**：LLM-based（非语义相似度），理解意图等价性。

```typescript
evaluate(input): Promise<{ score: number; passed: boolean; reason: string }>
// score: 0-100, passed: score >= 60
```

---

## 10. 模块依赖图

```
AppModule
├── InfraModule
│   ├── ConfigModule         — 环境变量校验
│   ├── RedisModule          — Upstash REST (Global)
│   ├── SupabaseModule       — 数据库
│   ├── HttpClientModule     — HTTP 工厂
│   └── FeishuModule         — 告警通知
│
├── ProvidersModule
│   ├── RegistryService      — Layer 1: 工厂
│   ├── ReliableService      — Layer 2: 容错
│   └── RouterService        — Layer 3: 路由
│
├── MemoryModule
│   ├── ShortTermService     — 对话窗口
│   ├── SessionFactsService  — 会话事实
│   ├── ProceduralService    — 流程阶段
│   ├── LongTermService      — 用户档案 + 摘要
│   ├── SettlementService    — 沉淀服务
│   └── MemoryConfig         — 时间常量
│
├── ToolModule
│   └── ToolRegistryService  — 工具注册 + 场景构建
│
├── AgentModule
│   ├── AgentRunnerService          — 编排引擎
│   ├── CompletionService    — 一次性调用
│   ├── ContextService       — Prompt 组装
│   ├── FactExtractionService — 事实提取
│   └── InputGuardService    — 注入检测
│
├── ChannelsModule
│   └── WecomModule
│       └── MessageModule
│           ├── MessageService         — 入口协调
│           ├── MessagePipelineService — 处理管线
│           ├── SimpleMergeService     — 消息聚合
│           ├── MessageDeliveryService — 发送
│           └── MessageDeduplicationService — 去重
│
├── BizModule
│   ├── StrategyConfigService — 策略配置
│   ├── MessageTrackingService — 消息监控
│   └── HostingConfigService   — 托管配置
│
└── EvaluationModule
    ├── TestSuiteService       — 测试编排
    ├── LlmEvaluationService   — LLM 评估
    └── ConversationParserService — 对话解析
```

---

## 11. 完整请求生命周期

以用户发送"你们招收银员吗？工资多少？"为例：

```
1. WeChat 回调 → POST /wecom/message
   │
2. Pipeline.execute(dto)
   ├─ 非自发消息 ✓
   ├─ 通过过滤 ✓
   ├─ 非重复消息 ✓
   ├─ 写入 chat_messages ✓
   └─ 返回 shouldDispatch=true
   │
3. SimpleMergeService: 启动 1s 缓冲
   └─ 无后续消息，超时触发
   │
4. processMessageCore()
   │
5. AgentRunnerService.invoke()
   │
   ├─ 5a. Settlement 检测（fire-and-forget）
   │
   ├─ 5b. recallAll() — 并行读取
   │   ├─ 短期: 最近 60 条对话
   │   ├─ 事实: { brands: ['KFC'], city: '上海' }
   │   ├─ 阶段: 'needs_collection'
   │   └─ 档案: { name: '张三', phone: '138xxxx' }
   │
   ├─ 5c. compose('candidate-consultation')
   │   └─ [identity + red-lines + risk-scenarios + stage-strategy + datetime + channel]
   │
   ├─ 5d. 注入 [用户档案] + [会话记忆]
   │
   ├─ 5e. Prompt injection 检测 → safe ✓
   │
   ├─ 5f. 构建工具: [advance_stage, recall_history, duliday_job_list, duliday_interview_booking]
   │
   ├─ 5g. RouterService.resolveByRole('chat')
   │   └─ anthropic/claude-sonnet-4-5-20250929 (fallback: openai/gpt-4o)
   │
   └─ 5h. generateText() — 多步工具循环
       │
       ├─ Step 1: LLM 分析问题 → 调用 duliday_job_list(position='收银员')
       │   └─ 工具执行: 查询海绵 API → 返回 3 个岗位
       │   └─ onJobsFetched 回调 → 保存推荐岗位到 SessionFacts
       │
       └─ Step 2: LLM 组织回复 → 生成自然语言回答
   │
6. storePostMemory() [异步]
   ├─ storeInteraction(lastInteraction, lastTopic)
   └─ extractAndSave() → LLM 提取: position=['收银员'], salary 需求等
   │
7. 回复处理
   ├─ 消息分段: ["我们确实招收银员！...", "时薪大概..."]
   ├─ 发送段 1（打字延迟 ~400ms）
   ├─ 段落间隔 2000ms
   └─ 发送段 2（打字延迟 ~400ms）
   │
8. 标记消息已处理 + 记录成功监控
```

---

## 12. 扩展点

### 12.1 新增 Provider

1. 配置环境变量 API Key
2. `RegistryService.onModuleInit()` 自动检测并注册
3. 使用 `provider/model` 格式引用

### 12.2 新增工具

1. 创建 `src/tools/my-tool.ts`，导出 `buildMyTool()` 工厂函数
2. 在 `ToolRegistryService.registry` 注册
3. 在 `scenarioToolMap` 中添加到目标场景

### 12.3 新增 Prompt Section

1. 实现 `PromptSection` 接口
2. 在 `ContextService.registerSections()` 注册
3. 在 `SCENARIO_SECTIONS` 中添加到目标场景

### 12.4 新增场景

1. 在 `SCENARIO_SECTIONS` 定义 section 列表
2. 在 `scenarioToolMap` 定义工具列表
3. 调用时传入 `scenario` 参数，自动选择 prompt 和工具

### 12.5 新增渠道

1. 在 `src/channels/` 下新建渠道模块
2. 实现消息接收 → 调用 `AgentRunnerService.invoke()` → 消息发送
3. Agent 层完全复用，无需改动

---

## 13. 关键配置

### 必填（无默认值）

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `AGENT_CHAT_MODEL` | 主对话模型（如 `anthropic/claude-sonnet-4-5-20250929`） |
| `UPSTASH_REDIS_REST_URL` | Redis REST API |
| `UPSTASH_REDIS_REST_TOKEN` | Redis Token |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥 |

### Agent 行为（有默认值）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_MAX_OUTPUT_TOKENS` | 4096 | 输出 token 上限 |
| `AGENT_THINKING_BUDGET_TOKENS` | 0（关闭） | Extended thinking 预算 |
| `AGENT_MAX_INPUT_CHARS` | 8000 | 输入字符上限 |
| `MAX_HISTORY_PER_CHAT` | 60 | 短期记忆最大消息条数 |
| `MEMORY_SESSION_TTL_DAYS` | 1 | 会话记忆 TTL（天） |
| `AGENT_CHAT_FALLBACKS` | — | 对话模型降级链 |
| `AGENT_FAST_MODEL` | — | 快速模型 |
| `ENABLE_MESSAGE_MERGE` | true | 消息聚合开关 |
| `INITIAL_MERGE_WINDOW_MS` | 1000 | 聚合窗口 |
| `MAX_MERGED_MESSAGES` | 3 | 最大聚合条数 |

---

## 相关文档

- [记忆系统架构](memory-system-architecture.md) — 三层记忆模型完整设计
- [消息服务架构](message-service-architecture.md) — 消息处理管线详细设计
- [告警系统架构](alert-system-architecture.md) — 飞书告警分级机制
- [监控系统架构](monitoring-system-architecture.md) — 消息追踪与分析
- [测试套件架构](test-suite-architecture.md) — Agent 评估体系
- [安全防护](security-guardrails.md) — Prompt injection 防护

## 相关代码

| 模块 | 入口文件 |
|------|---------|
| Agent Loop | `src/agent/runner.service.ts` |
| Context | `src/agent/context/context.service.ts` |
| Providers | `src/providers/router.service.ts` |
| Memory | `src/memory/memory.service.ts` |
| Tools | `src/tools/tool-registry.service.ts` |
| Pipeline | `src/channels/wecom/message/services/pipeline.service.ts` |
| Evaluation | `src/evaluation/test-suite.service.ts` |
