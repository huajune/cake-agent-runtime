# 测试套件架构设计

> 本文档描述 Cake Agent Runtime 测试套件的整体架构、设计原则和技术实现
>
> 最后更新：2026-04-23

## 目录

- [概述](#概述)
- [系统架构](#系统架构)
- [测试类型](#测试类型)
- [核心设计](#核心设计)
- [数据模型](#数据模型)
- [可观测性与血缘](#可观测性与血缘)
- [技术选型](#技术选型)
- [性能优化](#性能优化)
- [未来规划](#未来规划)

## 概述

### 系统定位

Cake Agent Runtime 测试套件是一个 **AI Agent 质量评估平台**，用于系统化地测试和评估 AI 对话 Agent 的回复质量。

**核心价值**：
- **自动化测试**：从飞书多维表格导入 / 回写，批量执行
- **质量评估**：支持 LLM 自动评分和人工评审
- **数据闭环**：测试结果回写飞书，结合资产血缘表联动用例/验证集
- **可观测性**：AI 流式追踪 (`AiStreamTrace`) 记录首字节、工具调用、token 消耗等关键指标
- **可追溯性**：批次 / 快照 / 执行记录三级结构，支持问题回溯

### 设计目标

| 目标 | 说明 | 实现状态 |
|------|------|---------|
| **易用性** | 一键导入、一键执行 | ✅ 已实现 |
| **可扩展性** | 支持多种测试类型 | ✅ 用例 + 回归 2 种 |
| **高性能** | 批量执行、异步处理 | ✅ Bull Queue（并发 3） |
| **可靠性** | 失败重试、状态追踪 | ✅ 重试 2 次 + 指数退避 |
| **可观测性** | 流式追踪、阶段耗时、Token 统计 | ✅ AiStreamTrace |
| **血缘追踪** | 测试资产（用例 / 验证集 / badcase）关系 | ✅ LineageSync |

### 技术栈概览

```
┌─────────────────────────────────────────┐
│           Frontend (Dashboard)          │
│      React + TypeScript + Ant Design    │
└────────────────┬────────────────────────┘
                 │ HTTP / SSE
┌────────────────▼────────────────────────┐
│          Backend (NestJS)               │
│  ┌─────────────────────────────────┐   │
│  │   TestSuiteModule (~9260 LOC)   │   │
│  │                                 │   │
│  │  Controller / 8 Services /      │   │
│  │  3 Repositories / Processor     │   │
│  └─────────────────────────────────┘   │
└────────────────┬────────────────────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
┌───▼───┐   ┌───▼────┐  ┌────▼────┐
│Supabase│  │ Redis  │  │ Feishu  │
│(PG DB) │  │(Queue) │  │ Bitable │
└────────┘  └────────┘  └─────────┘
```

## 系统架构

### 分层架构

```
┌───────────────────────────────────────────────────────┐
│                   Presentation Layer                  │
│    TestSuiteController  (HTTP + SSE + AI UIMessage)    │
└─────────────────────────┬─────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────┐
│                     Service Layer                     │
│                 （扁平化，无统一门面）                  │
│  ┌────────────────────┐  ┌──────────────────────────┐ │
│  │ TestExecutionSvc   │  │ TestBatchService         │ │
│  │ ConversationTestSvc│  │ TestImportService        │ │
│  │ TestWriteBackSvc   │  │ CuratedDatasetImportSvc  │ │
│  │ LineageSyncService │  │ CuratedDatasetPayload    │ │
│  │ AiStreamObservSvc  │  │                          │ │
│  └────────────────────┘  └──────────────────────────┘ │
└─────────────────────────┬─────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────┐
│                Infrastructure Layer                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Repositories │  │ Bull Queue   │  │ Feishu API │  │
│  │ (Supabase)   │  │  Processor   │  │ (Bitable)  │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
│  ┌──────────────────────────────────────────────┐    │
│  │ AgentRunner / LlmEvaluation / Observer       │    │
│  │ （跨模块依赖：@agent @evaluation @observability）│  │
│  └──────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

> **注意**：早期版本存在 `TestSuiteService` 门面，当前已下线。控制器直接依赖各子服务，职责划分靠模块内约定。

### 模块组织

```
src/biz/test-suite/
├── dto/
│   ├── test-chat.dto.ts               # 用例测试 / 批次 / curated dataset 请求
│   └── conversation-test.dto.ts       # 回归验证 DTO
│
├── entities/                          # DB 行结构（snake_case 原样）
│   ├── test-batch.entity.ts
│   ├── test-execution.entity.ts
│   └── conversation-snapshot.entity.ts
│
├── enums/
│   └── test.enum.ts                   # 执行/评审/批次/相似度等枚举
│
├── types/
│   └── test-suite.types.ts            # Service 层的 Create/Update 入参类型
│
├── repositories/                      # Supabase 数据访问
│   ├── test-batch.repository.ts
│   ├── test-execution.repository.ts
│   └── conversation-snapshot.repository.ts
│
├── services/
│   ├── test-execution.service.ts             # 执行单条测试（同步 / SSE）
│   ├── test-batch.service.ts                 # 批次管理 + 统计聚合
│   ├── test-import.service.ts                # 飞书多维表格导入
│   ├── test-write-back.service.ts            # 结果回写飞书
│   ├── conversation-test.service.ts          # 回归验证编排
│   ├── curated-dataset-import.service.ts     # 精选数据集 upsert
│   ├── curated-dataset-payload-builder.service.ts
│   ├── curated-dataset-import.helpers.ts
│   ├── lineage-sync.service.ts               # 资产血缘（assetRelation）同步
│   ├── lineage-sync.types.ts
│   ├── ai-stream-observability.service.ts    # AI 流追踪入口
│   ├── ai-stream-trace.ts                    # 流追踪主类
│   ├── ai-stream-trace-content-store.ts      # Text / Tool / Reasoning 聚合
│   └── ai-stream-trace-timing.ts             # 时间戳与阶段耗时
│
├── test-suite.module.ts               # 模块定义
├── test-suite.controller.ts           # HTTP / SSE 控制器
├── test-suite.processor.ts            # Bull Queue 处理器（execute-test）
│
└── utils/
    └── sse-stream-handler.ts          # 非 Vercel AI 风格 SSE 流包装
```

**代码规模**：约 9,260 行 TypeScript（含 entities / types / repositories / services / 支撑文件）。

### HTTP 接口一览（节选）

| 类别 | 路由 | 说明 |
|------|------|------|
| 单条测试 | `POST /test-suite/chat`<br>`POST /test-suite/chat/stream`<br>`POST /test-suite/chat/ai-stream`<br>`POST /test-suite/chat/reset-session` | 同步 / SSE / Vercel AI UIMessage / 会话重置 |
| 批次管理 | `POST /test-suite/batch`<br>`POST /test-suite/batches`<br>`POST /test-suite/batches/quick-create`<br>`POST /test-suite/batches/import-from-feishu` | 执行单条并归属批次 / 创建批次 / 快速建并执行 / 从飞书导入 |
| 批次查询 | `GET /test-suite/batches`<br>`GET /test-suite/batches/:id`<br>`GET /test-suite/batches/:id/stats`<br>`GET /test-suite/batches/:id/progress`<br>`GET /test-suite/batches/:id/category-stats`<br>`GET /test-suite/batches/:id/failure-stats`<br>`GET /test-suite/batches/:id/executions`<br>`POST /test-suite/batches/:id/cancel` | 列表 / 详情 / 分类统计 / 失败原因统计 / 进度 / 取消 |
| 执行记录 | `GET /test-suite/executions`<br>`GET /test-suite/executions/:id`<br>`PATCH /test-suite/executions/:id/review`<br>`PATCH /test-suite/executions/batch-review`<br>`POST /test-suite/executions/:id/write-back`<br>`POST /test-suite/executions/batch-write-back` | 查询 / 评审 / 回写飞书 |
| 数据集 | `POST /test-suite/datasets/scenario/import-curated`<br>`POST /test-suite/datasets/conversation/import-curated` | 精选 dataset upsert + 血缘同步 |
| 回归验证 | `POST /test-suite/conversations/sync`<br>`GET /test-suite/conversations`<br>`GET /test-suite/conversations/:sourceId/turns`<br>`POST /test-suite/conversations/:sourceId/execute`<br>`POST /test-suite/conversations/batch/:batchId/execute`<br>`PATCH /test-suite/conversations/turns/:executionId/review` | 飞书同步 / 列表 / 轮次 / 单对话执行 / 批次执行 / 轮次评审 |
| 反馈 | `POST /test-suite/feedback` | 提交 badcase / goodcase 反馈 |
| 队列 | `GET /test-suite/queue/status`<br>`POST /test-suite/queue/clean-failed` | Bull Queue 状态 / 清理失败 |

### 消息 / 执行流程

```
User Action (Dashboard / API)
  → TestSuiteController
  → TestExecutionService / TestBatchService / ConversationTestService
      ├── AgentRunnerService (Provider Router → generateText / stream)
      ├── AiStreamObservabilityService.startTrace() → AiStreamTrace
      │     （记录首字节、工具调用、Reasoning、Token、阶段耗时）
      ├── LlmEvaluationService（仅回归验证）
      └── Repositories → Supabase
  → Bull Queue (test-suite) → TestSuiteProcessor
      ├── execute-test job
      ├── 并发 3，attempts 2，timeout 120s，指数退避 5s
      └── 完成后更新批次进度缓存 (Redis)
  → TestWriteBackService → 飞书 Bitable 回写
  → CuratedDatasetImportService + LineageSyncService → 精选数据集与血缘同步
```

## 测试类型

### 类型对比

| 维度 | 用例测试 (Scenario) | 回归验证 (Conversation) |
|------|--------------------|------------------------|
| **数据来源** | 人工编写的测试用例 | 真实客户对话记录 |
| **飞书数据表** | testSuite 表 | validationSet 表（独立） |
| **测试目标** | 验证特定场景处理能力 | 验证整体对话质量 |
| **测试粒度** | 单轮问答 | 多轮对话（按 turn 拆分） |
| **评估方式** | 人工评审（通过 / 失败） | LLM 自动评分（0–100） |
| **评估标准** | 主观判断 + FailureReason 分类 | 客观评分 + 评估理由（EvaluationDimensions） |
| **持久化** | `test_executions` | `test_conversation_snapshots` + `test_executions`（每轮一条） |
| **典型用途** | 发版前场景回归 | 质量基线、真实对话回放 |
| **执行效率** | 快（无 LLM 评估开销） | 慢（每轮 LLM 评分） |
| **回写飞书** | ✅ | ✅ |

### 使用场景建议

**使用用例测试 when**：
- ✅ 测试特定功能点（岗位咨询、薪资问题）
- ✅ 发版前回归测试
- ✅ 需要人工精准判断
- ✅ 测试用例数量可控（<100）

**使用回归验证 when**：
- ✅ 评估整体对话能力
- ✅ 建立质量基准线
- ✅ 批量验证真实对话
- ✅ 需要量化评分指标

### 数据流对比

**用例测试流程**：
```
飞书 testSuite → TestImportService 解析
  → TestBatchService 建批次 + 创建 pending 执行记录
  → Bull Queue (execute-test, concurrency 3)
  → TestExecutionService → AgentRunner
  → 更新执行记录 → 人工评审
  → TestWriteBackService 回写飞书
```

**回归验证流程**：
```
飞书 validationSet → TestImportService / ConversationTestService
  → ConversationParserService 解析 → splitIntoTurns 拆轮
  → 保存 test_conversation_snapshots + pending 轮次
  → 逐轮 AgentRunner 执行 → LlmEvaluationService 评分
  → 汇总 avg / min 相似度 → 状态流转（pending → running → completed）
  → 回写飞书 + 前端展示
```

> **注意**：用例测试和回归验证使用独立飞书表格，内部通过 `TestType` 枚举 + `test_batches.test_type` 字段区分。

## 核心设计

### 设计模式

#### 1. 扁平服务 + 职责切分

当前放弃统一门面，控制器直连 8 个服务，每个服务职责单一：

| 服务 | 关键方法 | 跨模块依赖 |
|------|---------|-----------|
| `TestExecutionService` | `executeTest` / `executeStream` / `updateExecutionByBatchAndCase` | `AgentRunnerService`、`ChatSessionService` |
| `TestBatchService` | `createBatch` / `getBatchStats` / `getCategoryStats` / `getFailureStats` | `TestWriteBackService`、`TestExecutionService` |
| `TestImportService` | `importFromFeishu` / `quickCreateBatch` | `FeishuBitableApiService`、`ConversationParserService` |
| `TestWriteBackService` | `writeBackToFeishu` | `FeishuBitableApiService` |
| `ConversationTestService` | `parseConversation` / `splitIntoTurns` / `executeConversation` | `LlmEvaluationService`、`ConversationParserService` |
| `CuratedDatasetImportService` | `importScenarioDataset` / `importConversationDataset` | `FeishuBitableApiService`、`LineageSyncService` |
| `CuratedDatasetPayloadBuilderService` | 字段别名解析、payload 构造 | - |
| `LineageSyncService` | `loadLineageTableContext` / `syncScenarioLineageRelations` | `FeishuBitableApiService` |
| `AiStreamObservabilityService` | `startTrace` → `AiStreamTrace` | `MessageTrackingService`、`Observer` |

#### 2. 仓储模式 (Repository Pattern)

Supabase 访问收敛在三个 Repository，其他服务只处理业务对象（Entity）：

```typescript
@Injectable()
export class TestExecutionRepository {
  async findById(id: string): Promise<TestExecution | null>;
  async findByBatchId(batchId: string): Promise<TestExecution[]>;
  async create(data: CreateExecutionData): Promise<TestExecution>;
  async updateByBatchAndCase(batchId: string, caseId: string, data: UpdateExecutionResultData): Promise<void>;
  // ...回归验证专用查询
}
```

#### 3. Bull Queue 异步处理

`TestSuiteProcessor` 非装饰器式，采用手动注册 Worker（更好的启动顺序控制）：

```typescript
async onModuleInit() {
  await this.waitForQueueReady();        // 等 Redis ready
  this.registerWorkers();                 // 注册 execute-test handler
  this.setupQueueEventListeners();        // completed / failed / active / stalled
}

private readonly CONCURRENCY = 3;
private readonly JOB_TIMEOUT_MS = 120_000;
// defaultJobOptions：attempts=2, backoff=exponential 5s, removeOnComplete
```

批次进度缓存在 Redis（`test-suite:progress:<batchId>`，TTL 1h），供前端轮询。

#### 4. AI 流追踪（Tracing）

`AiStreamTrace` 将 UIMessageChunk 解析成阶段时间戳、工具调用、文本/推理聚合，最后写入 `MessageTrackingService` 和 `Observer`。支持 `source: 'production' | 'testing'`，测试数据不会污染线上观测表。

#### 5. 资产血缘（Lineage）

`LineageSyncService` 维护 `assetRelation` 表——用例/验证集与 badcase、测试批次之间的关系：

```
scenario case ↔ source badcase
conversation case ↔ source badcase
validation set ↔ chat id
```

每次通过 `CuratedDatasetImportService` upsert 数据集时同步更新，保证关系一致。

### 依赖关系图

```
TestSuiteController
   │
   ├── TestExecutionService ── AgentRunnerService (@agent)
   ├── TestBatchService ── TestWriteBackService
   ├── TestImportService ── ConversationParserService (@evaluation)
   ├── ConversationTestService ── LlmEvaluationService (@evaluation)
   ├── CuratedDatasetImportService ── CuratedDatasetPayloadBuilderService
   │                              └── LineageSyncService
   ├── AiStreamObservabilityService ── Observer (@observability)
   │                              └── MessageTrackingService (@biz/monitoring)
   └── TestSuiteProcessor (Bull) ── TestBatchService + TestExecutionService + Redis

All Services
   └── Repositories (TestBatch / TestExecution / ConversationSnapshot)
         └── Supabase
```

## 数据模型

### 数据库表概览

| 表 | 作用 |
|----|------|
| `test_batches` | 批次元信息（名称、状态、统计聚合） |
| `test_executions` | 执行记录（同时承载用例测试和回归验证的每一轮） |
| `test_conversation_snapshots` | 回归验证的对话快照（整段对话、参与者、平均相似度等） |

### 核心实体关系

```
┌────────────────────┐
│  test_batches      │  测试批次
│  ────────────────  │
│  id (PK)           │
│  name              │
│  source            │  'manual' | 'feishu'
│  test_type         │  'scenario' | 'conversation'
│  feishu_table_id   │
│  total_cases       │
│  executed_count    │
│  passed_count      │
│  failed_count      │
│  pending_review_count │
│  pass_rate         │
│  avg_duration_ms   │
│  avg_token_usage   │
│  status            │
└─────────┬──────────┘
          │ 1:N
          ├───────────────────────────┐
          ▼                           ▼
┌─────────────────────────────┐  ┌────────────────────────────┐
│ test_conversation_snapshots │  │ test_executions            │
│ (仅回归验证)                 │  │ (通用执行记录)              │
│ ───────────────────────     │  │ ─────────────────────      │
│ id                          │  │ id                         │
│ batch_id                    │  │ batch_id                   │
│ feishu_record_id            │  │ case_id / case_name (场景) │
│ conversation_id             │  │ conversation_snapshot_id   │
│ participant_name            │  │ turn_number (回归)         │
│ full_conversation (jsonb)   │  │ test_input                 │
│ raw_text                    │  │ expected_output            │
│ total_turns                 │  │ actual_output              │
│ avg_similarity_score        │  │ similarity_score           │
│ min_similarity_score        │  │ evaluation_reason          │
│ status                      │  │ execution_status           │
└──────────┬──────────────────┘  │ review_status              │
           │ 1:N                 │ tool_calls                 │
           └────────────────────▶│ token_usage                │
                                 │ duration_ms                │
                                 │ failure_reason             │
                                 └────────────────────────────┘
```

### 字段复用设计

`test_executions` 通过可选字段同时承载两种测试类型：

```typescript
// 用例测试字段
{
  case_id: 'feishu-case-123',
  case_name: '岗位咨询',
  category: '岗位',
  conversation_snapshot_id: null,
  turn_number: null,
  // ...
}

// 回归验证字段
{
  case_id: null,
  case_name: null,
  category: null,
  conversation_snapshot_id: '<uuid>',
  turn_number: 3,
  similarity_score: 82,
  evaluation_reason: '…',
  // ...
}

// 共用字段
{
  batch_id, test_input, expected_output, actual_output,
  agent_request, agent_response, tool_calls,
  execution_status, review_status, review_comment, reviewed_by, reviewed_at,
  failure_reason, duration_ms, token_usage, error_message,
  test_scenario, input_message, created_at,
}
```

### 状态机

#### 批次状态 (`BatchStatus`)

```
CREATED ──► RUNNING ──► REVIEWING ──► COMPLETED
   │           │            │
   └───► CANCELLED ◄────────┘
```

#### 执行状态 (`ExecutionStatus`)

```
PENDING ──► SUCCESS / FAILURE / TIMEOUT
```

#### 评审状态 (`ReviewStatus`)

```
PENDING ──► PASSED / FAILED / SKIPPED
```

#### 对话源状态 (`ConversationSourceStatus`)

```
PENDING ──► RUNNING ──► COMPLETED
                  │
                  └─► FAILED
```

#### 相似度评级 (`SimilarityRating`)

| 评级 | 分数 | 含义 |
|------|------|------|
| `EXCELLENT` | 80–100 | 与真人高度一致 |
| `GOOD` | 60–79 | 主要信息覆盖，表述有差异 |
| `FAIR` | 40–59 | 部分信息一致，需要关注 |
| `POOR` | 0–39 | 差异较大，需人工复核（及格线 60） |

## 可观测性与血缘

### AiStreamTrace

每次 `chat/ai-stream` 请求会启动一次 trace，内部维护：

- **时间戳**：`receivedAt / aiStartAt / streamReadyAt / firstChunkAt / firstReasoningDeltaAt / firstTextDeltaAt / finishChunkAt / completedAt`
- **阶段耗时**：`requestToFirstTextDeltaMs`、`aiStartToStreamReadyMs` 等派生字段
- **内容聚合**：`AiStreamTraceContentStore` 按 Text / Tool / Reasoning 三路聚合
- **工具统计**：`computeToolCallStatus` + `computeResultCount`
- **数据归属**：`source: 'testing'` 时**不**写入生产观测表（`message_processing_records` / `user_activity` / Redis 计数器），避免污染"今日托管"看板

最终数据通过 `MessageTrackingService` 和 `Observer`（`@observability`）落盘。

### 资产血缘（assetRelation）

由 `LineageSyncService` 维护，记录以下关系：

- Scenario case ↔ 来源 BadCase
- Conversation case ↔ 来源 BadCase / 原始 chat_id
- 用例 / 验证集 ↔ 所属测试批次

`CuratedDatasetImportService` 每次 upsert 时调用 `syncScenarioLineageRelations` / `syncConversationLineageRelations`，保证关系一致并支持反向溯源（badcase → 对应用例）。

## 技术选型

### 后端技术栈

| 技术 | 版本 | 用途 | 选型理由 |
|------|------|------|---------|
| **NestJS** | 10.3 | Web 框架 | TypeScript 原生、模块化、DI |
| **Supabase** | - | 数据库 | PostgreSQL + RESTful，易集成 |
| **Bull** | 4.x | 任务队列 | 基于 Redis，重试 / 进度追踪 |
| **Redis** | Upstash | 缓存 / 队列 | 云服务，免自建 |
| **Vercel AI SDK** | latest | LLM 调用与流式协议 | 多 Provider，`UIMessageChunk` |

### 外部服务集成

| 服务 | 用途 | API 类型 |
|------|------|---------|
| **飞书多维表格** | 测试用例 / 验证集 / 结果双向同步 | Bitable REST |
| **多 Provider（Anthropic / OpenAI / DeepSeek）** | Agent 对话能力 | 通过 `@providers` 三层架构 |
| **LLM 评估模型（GPT-4o-mini 为主）** | 回归验证打分 | OpenAI REST（via Vercel AI SDK） |

### 前端技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| **React** | 18.x | UI 框架 |
| **TypeScript** | 5.x | 类型系统 |
| **Ant Design** | 5.x | 组件库 |
| **React Query** | - | 数据获取 / 缓存 |
| **Vercel AI UI** | - | AI 流式消息渲染（`useChat`） |

## 性能优化

### Bull Queue 并发与重试

```typescript
BullModule.registerQueueAsync({
  name: 'test-suite',
  useFactory: () => ({
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 120_000,
      removeOnComplete: true,
      removeOnFail: false,
    },
  }),
});

// Worker
testQueue.process('execute-test', /* concurrency */ 3, handleTestJob);
```

**性能数据（参考）**：
- 并发 3 × 单任务 ~3.5 s → 50 用例 ~60 s
- 单任务硬超时 120 s，失败重试 2 次，指数退避 5 s 起

### 批次进度缓存

```
key:   test-suite:progress:<batchId>
value: { completedCases, successCount, failureCount, avgDurationMs, ... }
ttl:   3600s (1h)
```

Worker 完成/失败回调实时更新，前端轮询 `GET /batches/:id/progress` 读取。

### 数据库索引

```sql
-- 批次
CREATE INDEX idx_test_batches_test_type ON test_batches(test_type);
CREATE INDEX idx_test_batches_status    ON test_batches(status);

-- 执行记录
CREATE INDEX idx_test_executions_batch_id      ON test_executions(batch_id);
CREATE INDEX idx_test_executions_review_status ON test_executions(review_status);
CREATE INDEX idx_test_executions_conv_turn
  ON test_executions(conversation_snapshot_id, turn_number);

-- 对话快照
CREATE INDEX idx_conversation_snapshots_batch_id ON test_conversation_snapshots(batch_id);
```

### LLM 评估优化

- **模型**：默认 `openai/gpt-4o-mini`（比 GPT-4 便宜 ~60 倍，足够评分稳定）
- **温度**：`temperature: 0`，禁用工具，限制输出长度
- **并发**：对单条对话的多轮评估可以 `Promise.all` 并行；跨对话仍走 Bull Queue

## 未来规划

### Phase 1：功能完善（已完成）

- ✅ 用例测试 / 回归验证基础流程
- ✅ 飞书导入 / 回写
- ✅ Bull Queue 异步执行 + 进度缓存
- ✅ LLM 自动评估（相似度 + 评估理由）
- ✅ AI 流追踪（AiStreamTrace）
- ✅ 资产血缘同步（LineageSync）
- ✅ Curated Dataset upsert

### Phase 2：体验优化（当前阶段）

- ⏳ 实时进度 SSE / WebSocket 推送（目前靠轮询）
- ⏳ 批量评审体验
- ⏳ 统计图表可视化（category / failure-reason / 趋势）
- ⏳ AiStreamTrace 数据的查询视图

### Phase 3：评估能力扩展（规划中）

```
多维度评估系统
├── LLM 评估 (已实现)
│   └── 语义相似度 + 评估理由（EvaluationDimensions）
├── 规则评估 (规划)
│   ├── 关键词检查
│   ├── 格式验证
│   └── 敏感信息检测
├── 性能评估 (规划)
│   ├── 首字节 / 尾字节延迟
│   ├── Token 消耗
│   └── 工具调用次数 / 错误率
└── 安全评估 (规划)
    ├── Prompt 注入检测
    ├── 信息泄露检测
    └── 有害内容检测
```

### Phase 4：自动化流程（长期）

- 从生产 badcase 自动沉淀测试用例 / 验证集
- 定时自动执行评估，趋势告警
- CI/CD 集成（PR 触发回归）
- 评估结果自动推送（飞书 / 邮件）

### Phase 5：平台化能力（远期）

- 版本对比（A/B Testing、多 Prompt/模型 对照）
- 跨租户支持
- 评估 API 对外开放
- 血缘图谱可视化

## 架构演进路径

### 当前架构 (v1.x)

```
评估平台 MVP
├── 2 种测试类型（场景 / 回归）
├── 1 种评估方法（LLM 相似度）
├── 半自动化（飞书导入 + 手动执行 + 回写）
├── 血缘追踪 + AI 流追踪
└── 基础统计
```

**适用场景**：初期质量验证、定期抽查、badcase 回归。

### 目标架构 (v2.x)

```
完整评估平台
├── 多种测试类型（场景 / 对话 / 性能 / 安全）
├── 多种评估方法（LLM / 规则 / 指标）
├── 自动化流程（采样 / 执行 / 推送）
└── 深度分析（趋势 / 预警 / 对比）
```

**适用场景**：持续质量保障、自动化回归、版本对比。

### 重构触发条件

**何时需要重构**：
1. 需要支持 3+ 种新测试类型
2. 评估逻辑复杂度显著增加
3. 多人协作时代码结构混乱
4. 性能瓶颈无法通过调优解决

**重构方向**：
- 评估器策略模式抽象
- 测试场景独立模块化
- 数据源适配器模式
- 结果分析器插件化

## 最佳实践

### 1. 测试用例设计

**✅ 推荐**：
- 覆盖常见场景 (80%) + 边界场景 (20%)
- 每个分类至少 5 个用例
- 预期输出具体明确（便于 LLM / 人工评估）
- 定期更新测试 / 验证集，同步 badcase

**❌ 避免**：
- 只测试正常流程
- 用例名称不清晰
- 预期输出模糊
- 测试 / 验证集长期不更新

### 2. 执行策略

**批量执行**：
- 走 Bull Queue（默认并发 3）
- 超大批量（>100）分批导入，避免 Redis / DB 峰值

**失败处理**：
- Queue 自动重试（attempts = 2，指数退避 5 s）
- 失败记录保留（`removeOnFail: false`），可通过 `/queue/clean-failed` 清理
- 支持手动重新执行

### 3. 评审规范

**评审应**：
- 对比实际 vs 预期
- 选择准确的 `FailureReason`
- 填写评审评论
- 及时回写飞书（`POST /executions/:id/write-back`）

**评审质量维度参考**：
- 准确性 (40%)
- 完整性 (30%)
- 相关性 (20%)
- 专业性 (10%)

### 4. 性能监控

**关键指标**（由 `AiStreamTrace` + Repository 产出）：
- `duration_ms`（首字节、总耗时）
- `token_usage`（input / output / total）
- 成功率 = success / total
- 通过率 = passed / reviewed
- 工具调用成功率

**建议告警阈值**：
- 平均耗时 > 5 s
- 单用例 Token > 2000
- 成功率 < 95%
- 通过率 < 80%

## 相关文档

- [用例测试工作流程](../workflows/scenario-test-workflow.md)
- [回归验证工作流程](../workflows/conversation-test-workflow.md)
- [Bull Queue 使用指南](../technical/bull-queue-guide.md)
- [NestJS 最佳实践](../../.claude/agents/code-standards.md)
