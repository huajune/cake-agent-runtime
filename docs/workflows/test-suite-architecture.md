# 测试套件架构设计

> 本文档描述 DuLiDay 测试套件的整体架构、设计原则和技术实现

## 目录

- [概述](#概述)
- [系统架构](#系统架构)
- [测试类型](#测试类型)
- [核心设计](#核心设计)
- [数据模型](#数据模型)
- [技术选型](#技术选型)
- [性能优化](#性能优化)
- [未来规划](#未来规划)

## 概述

### 系统定位

DuLiDay 测试套件是一个**AI Agent 质量评估平台**,用于系统化地测试和评估 AI 对话 Agent 的回复质量。

**核心价值**:
- **自动化测试**: 从飞书导入测试数据,自动执行批量测试
- **质量评估**: 支持 LLM 自动评分和人工评审两种方式
- **数据闭环**: 测试结果回写飞书,形成反馈闭环
- **可追溯性**: 完整记录测试历史,支持问题回溯

### 设计目标

| 目标 | 说明 | 实现状态 |
|------|------|---------|
| **易用性** | 一键导入、一键执行 | ✅ 已实现 |
| **可扩展性** | 支持多种测试类型 | ✅ 支持 2 种 |
| **高性能** | 批量执行、异步处理 | ✅ Bull Queue |
| **可靠性** | 失败重试、状态追踪 | ✅ 已实现 |
| **可观测性** | 详细日志、统计分析 | ✅ 已实现 |

### 技术栈概览

```
┌─────────────────────────────────────────┐
│           Frontend (Dashboard)          │
│      React + TypeScript + Ant Design    │
└────────────────┬────────────────────────┘
                 │ HTTP API
┌────────────────▼────────────────────────┐
│          Backend (NestJS)               │
│  ┌─────────────────────────────────┐   │
│  │   TestSuiteModule (7100+ LOC)   │   │
│  │                                 │   │
│  │  ┌──────────┐  ┌──────────┐   │   │
│  │  │ Services │  │ Processor│   │   │
│  │  └──────────┘  └──────────┘   │   │
│  └─────────────────────────────────┘   │
└────────────────┬────────────────────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
┌───▼───┐   ┌───▼────┐  ┌───▼────┐
│Supabase│  │ Redis  │  │ Feishu │
│(PG DB) │  │(Queue) │  │  API   │
└────────┘  └────────┘  └────────┘
```

## 系统架构

### 分层架构

```
┌───────────────────────────────────────────────────────┐
│                   Presentation Layer                  │
│              TestSuiteController (HTTP)               │
└─────────────────────────┬─────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────┐
│                  Application Layer                    │
│                 TestSuiteService (门面)                │
│  ┌──────────────────────────────────────────────┐    │
│  │  业务编排、流程协调、子服务组合               │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────┬─────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────┐
│                   Domain Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Execution    │  │ Batch        │  │ Import     │  │
│  │ Service      │  │ Service      │  │ Service    │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Conversation │  │ LLM          │  │ WriteBack  │  │
│  │ Test Service │  │ Evaluation   │  │ Service    │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
└─────────────────────────┬─────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────┐
│                Infrastructure Layer                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Repositories │  │ Bull Queue   │  │ Feishu API │  │
│  │ (Supabase)   │  │ Processor    │  │ Client     │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 模块组织

```
src/test-suite/
├── dto/                              # 数据传输对象
│   ├── test-chat.dto.ts             # 场景测试 DTO
│   └── conversation-test.dto.ts     # 对话验证 DTO
│
├── enums/                            # 枚举定义
│   └── test.enum.ts                 # 统一状态枚举
│
├── repositories/                     # 数据访问层
│   ├── test-batch.repository.ts     # 批次表
│   ├── test-execution.repository.ts # 执行记录表
│   └── conversation-source.repository.ts  # 对话源表
│
├── services/                         # 业务服务层
│   ├── test-execution.service.ts    # 测试执行服务
│   ├── test-batch.service.ts        # 批次管理服务
│   ├── test-import.service.ts       # 飞书导入服务
│   ├── test-write-back.service.ts   # 飞书回写服务
│   ├── conversation-test.service.ts # 对话验证服务
│   ├── llm-evaluation.service.ts    # LLM 评估服务
│   ├── feishu-test-sync.service.ts  # 飞书同步服务
│   └── test-stats.service.ts        # 统计分析服务
│
├── test-suite.module.ts              # 模块定义
├── test-suite.controller.ts          # HTTP 控制器
├── test-suite.service.ts             # 门面服务
├── test-suite.processor.ts           # Bull Queue 处理器
│
└── utils/
    └── sse-stream-handler.ts         # SSE 流式处理
```

**代码规模**: 7100+ 行 TypeScript 代码

## 测试类型

### 类型对比

| 维度 | 场景测试 (Scenario) | 对话验证 (Conversation) |
|------|-------------------|------------------------|
| **数据来源** | 人工编写的测试用例 | 真实客户对话记录 |
| **测试目标** | 验证特定场景处理能力 | 验证整体对话质量 |
| **测试粒度** | 单轮问答 | 多轮对话 |
| **评估方式** | 人工评审 (通过/失败) | LLM 自动评分 (0-100) |
| **评估标准** | 主观判断 + 失败原因分类 | 客观评分 + 评估理由 |
| **典型用途** | 功能回归测试 | 质量基准测试 |
| **执行效率** | 快速 (无评估开销) | 较慢 (需 LLM 评估) |
| **结果处理** | 回写飞书 | 前端展示 + 统计 |
| **数据表** | test_executions | conversation_sources + test_executions |

### 使用场景建议

**使用场景测试 when**:
- ✅ 测试特定功能点 (如岗位咨询、薪资问题)
- ✅ 发版前回归测试
- ✅ 需要人工精准判断
- ✅ 测试用例数量可控 (<100)

**使用对话验证 when**:
- ✅ 评估整体对话能力
- ✅ 建立质量基准线
- ✅ 批量验证真实对话
- ✅ 需要量化评分指标

### 数据流对比

**场景测试流程**:
```
飞书测试集表 → 导入 → 执行 Agent → 人工评审 → 回写飞书
```

**对话验证流程**:
```
飞书对话记录 → 解析 → 拆分轮次 → 执行 Agent → LLM 评估 → 前端展示
```

## 核心设计

### 设计模式

#### 1. 门面模式 (Facade Pattern)

**TestSuiteService** 作为统一入口,隐藏子系统复杂性:

```typescript
// 门面服务
@Injectable()
export class TestSuiteService {
  constructor(
    private readonly executionService: TestExecutionService,
    private readonly batchService: TestBatchService,
    private readonly importService: TestImportService,
    private readonly writeBackService: TestWriteBackService,
  ) {}

  // 统一 API
  async executeTest(request: TestChatRequestDto) {
    return this.executionService.executeTest(request);
  }

  async importFromFeishu(request: ImportFromFeishuRequestDto) {
    return this.importService.importFromFeishu(request);
  }
}
```

**优点**:
- 简化客户端调用
- 解耦控制器和业务逻辑
- 易于维护和扩展

#### 2. 仓储模式 (Repository Pattern)

数据访问层抽象:

```typescript
// 仓储接口
@Injectable()
export class TestExecutionRepository {
  async findById(id: string): Promise<TestExecution | null>;
  async findByBatchId(batchId: string): Promise<TestExecution[]>;
  async create(data: CreateExecutionData): Promise<TestExecution>;
  async update(id: string, data: UpdateExecutionData): Promise<void>;
}
```

**优点**:
- 业务逻辑与数据访问分离
- 易于测试 (可 Mock Repository)
- 数据库切换成本低

#### 3. 策略模式 (Strategy Pattern)

不同评估策略的实现:

```typescript
// 评估策略接口
interface EvaluationStrategy {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

// LLM 评估策略
class LlmEvaluationStrategy implements EvaluationStrategy {
  async evaluate(input) {
    // 调用 LLM API 评分
  }
}

// 人工评审策略
class ManualReviewStrategy implements EvaluationStrategy {
  async evaluate(input) {
    // 人工评审逻辑
  }
}
```

**使用场景**: 对话验证使用 LLM,场景测试使用人工评审

#### 4. 观察者模式 (Observer Pattern)

Bull Queue 事件监听:

```typescript
@Processor('test-suite')
export class TestSuiteProcessor {
  @Process('execute-batch')
  async handleBatchExecution(job: Job) {
    // 执行批次
    await job.progress(50); // 通知进度
  }

  @OnQueueCompleted()
  async onCompleted(job: Job) {
    // 批次完成后通知
  }

  @OnQueueFailed()
  async onFailed(job: Job) {
    // 批次失败后处理
  }
}
```

**优点**:
- 解耦任务执行和状态通知
- 支持实时进度更新
- 易于扩展监听逻辑

### 服务职责划分

| 服务 | 职责 | 核心方法 | 依赖 |
|------|------|---------|------|
| **TestSuiteService** | 门面协调 | executeTest, importFromFeishu | 所有子服务 |
| **TestExecutionService** | 测试执行 | executeTest, executeTestStream | AgentService |
| **TestBatchService** | 批次管理 | createBatch, getBatchStats | ExecutionRepository |
| **TestImportService** | 飞书导入 | importFromFeishu, quickCreateBatch | FeishuAPI |
| **TestWriteBackService** | 飞书回写 | writeBackToFeishu | FeishuAPI |
| **ConversationTestService** | 对话验证 | parseConversation, executeConversation | LlmEvaluationService |
| **LlmEvaluationService** | LLM 评估 | evaluate, getRating | AgentService |
| **FeishuTestSyncService** | 飞书同步 | getTestCases | FeishuBitableAPI |
| **TestStatsService** | 统计分析 | getBatchStats, getCategoryStats | ExecutionRepository |

### 依赖关系图

```
TestSuiteController
        │
        ▼
TestSuiteService (门面)
        │
    ┌───┴────┬─────────┬──────────┬───────────┐
    ▼        ▼         ▼          ▼           ▼
 Execution  Batch   Import    WriteBack  Conversation
  Service  Service  Service    Service     Service
    │        │         │          │           │
    │        │         │          │           ▼
    │        │         │          │      LlmEvaluation
    │        │         │          │         Service
    │        │         │          │           │
    └────────┴─────────┴──────────┴───────────┘
                       │
                 ┌─────┴─────┐
                 ▼           ▼
            Repositories  External APIs
            (Supabase)    (Feishu, Agent)
```

## 数据模型

### 核心实体关系

```
┌─────────────────┐
│  test_batches   │  测试批次
│  ─────────────  │
│  id             │  UUID (PK)
│  name           │  批次名称
│  test_type      │  'scenario' | 'conversation'
│  source         │  'feishu' | 'manual'
│  status         │  批次状态
│  total_cases    │  用例/对话总数
│  executed_count │  已执行数
│  pass_rate      │  通过率/平均分
└────────┬────────┘
         │ 1:N
         ├─────────────────────────┐
         │                         │
         ▼                         ▼
┌──────────────────────┐  ┌────────────────────┐
│conversation_sources  │  │ test_executions    │
│ (对话验证专用)        │  │ (通用执行记录)      │
│ ──────────────────── │  │ ────────────────── │
│ id                   │  │ id                 │
│ batch_id             │  │ batch_id           │
│ conversation_id      │  │ case_id (场景)     │
│ full_conversation    │  │ conversation_source_id (对话) │
│ total_turns          │  │ turn_number (对话) │
│ avg_similarity_score │  │ test_input         │
│ status               │  │ expected_output    │
└─────────┬────────────┘  │ actual_output      │
          │ 1:N           │ similarity_score   │
          └───────────────►│ execution_status   │
                          │ review_status      │
                          └────────────────────┘
```

### 字段复用设计

**test_executions** 表通过可选字段支持两种测试类型:

```typescript
// 场景测试字段
{
  case_id: string;              // 飞书用例ID
  case_name: string;            // 用例名称
  category: string;             // 分类
  conversation_source_id: null; // 不使用
  turn_number: null;            // 不使用
}

// 对话验证字段
{
  case_id: null;                       // 不使用
  case_name: null;                     // 不使用
  category: null;                      // 不使用
  conversation_source_id: string;      // 对话源ID
  turn_number: number;                 // 轮次编号
}

// 共用字段
{
  batch_id: string;             // 所属批次
  test_input: JSONB;            // 测试输入
  expected_output: string;      // 期望输出
  actual_output: string;        // 实际输出
  execution_status: string;     // 执行状态
  review_status: string;        // 评审状态
  similarity_score: number;     // 评分
  tool_calls: JSONB;            // 工具调用
  duration_ms: number;          // 耗时
  token_usage: JSONB;           // Token 用量
}
```

### 状态机设计

#### 批次状态流转

```
created (已创建)
   │
   ├─► running (执行中)
   │      │
   │      ├─► reviewing (评审中)
   │      │      │
   │      │      └─► completed (已完成)
   │      │
   │      └─► cancelled (已取消)
   │
   └─► cancelled (已取消)
```

#### 执行状态

```
pending (待执行)
   │
   ├─► success (成功)
   ├─► failure (失败)
   └─► timeout (超时)
```

#### 评审状态

```
pending (待评审)
   │
   ├─► passed (通过)
   ├─► failed (失败)
   └─► skipped (跳过)
```

## 技术选型

### 后端技术栈

| 技术 | 版本 | 用途 | 选型理由 |
|------|------|------|---------|
| **NestJS** | 10.3 | Web 框架 | TypeScript 原生支持,模块化架构,依赖注入 |
| **Supabase** | - | 数据库 | PostgreSQL + RESTful API,易于集成 |
| **Bull** | 4.x | 任务队列 | 基于 Redis,支持重试、进度追踪 |
| **Redis** | Upstash | 缓存/队列 | 云服务,无需自建 |
| **Axios** | 1.x | HTTP 客户端 | 成熟稳定,拦截器支持 |

### 外部服务集成

| 服务 | 用途 | API 类型 |
|------|------|---------|
| **飞书多维表格** | 测试数据导入/导出 | RESTful API |
| **花卷 Agent API** | AI 对话能力 | RESTful API (SSE) |
| **OpenAI API** | LLM 评估 (via 花卷) | RESTful API |

### 前端技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| **React** | 18.x | UI 框架 |
| **TypeScript** | 5.x | 类型系统 |
| **Ant Design** | 5.x | UI 组件库 |
| **React Query** | - | 数据获取 |

## 性能优化

### 批量执行优化

#### 1. 串行 vs 并行

```typescript
// 串行执行 (推荐,避免 API 限流)
async executeBatchSerial(cases: TestCase[]) {
  for (const testCase of cases) {
    await this.executeTest(testCase);
  }
}

// 并行执行 (谨慎使用,可能触发限流)
async executeBatchParallel(cases: TestCase[], batchSize = 5) {
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    await Promise.all(batch.map(c => this.executeTest(c)));
  }
}
```

**性能数据**:
- 串行: ~3.5s/用例 → 50 用例 ~3 分钟
- 并行 (5 并发): ~3.5s/批次 → 50 用例 ~35 秒

**推荐**: 大批量使用串行,小批量 (<10) 可用并行

#### 2. Bull Queue 异步处理

```typescript
// 提交批次任务到队列
async executeBatch(batchId: string) {
  await this.testQueue.add('execute-batch', { batchId }, {
    attempts: 2,                    // 失败重试 2 次
    backoff: {
      type: 'exponential',
      delay: 5000,                  // 重试延迟 5s
    },
    timeout: 120000,                // 任务超时 2min
  });
}
```

**优点**:
- 不阻塞 HTTP 请求
- 自动失败重试
- 可追踪任务进度

### 数据库查询优化

#### 1. 索引设计

```sql
-- 批次查询索引
CREATE INDEX idx_test_batches_test_type ON test_batches(test_type);
CREATE INDEX idx_test_batches_status ON test_batches(status);

-- 执行记录查询索引
CREATE INDEX idx_test_executions_batch_id ON test_executions(batch_id);
CREATE INDEX idx_test_executions_review_status ON test_executions(review_status);
CREATE INDEX idx_test_executions_conversation_source
  ON test_executions(conversation_source_id, turn_number);
```

#### 2. 分页查询

```typescript
// 避免一次性加载所有记录
async getBatches(limit = 20, offset = 0) {
  return this.supabase
    .from('test_batches')
    .select('*')
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });
}
```

### LLM 评估优化

#### 1. 模型选择

```typescript
// 使用快速便宜的模型
const EVALUATION_MODEL = 'openai/gpt-4o-mini';

// 评估配置
{
  model: EVALUATION_MODEL,
  temperature: 0,          // 稳定输出
  allowedTools: [],        // 禁用工具
  maxTokens: 200,          // 限制输出长度
}
```

**成本优化**: GPT-4o-mini 比 GPT-4 便宜 ~60 倍

#### 2. 批量评估

```typescript
// 对话验证:多轮评估可并行
async evaluateConversation(turns: Turn[]) {
  const evaluations = await Promise.all(
    turns.map(turn => this.llmEvaluationService.evaluate(turn))
  );
}
```

## 未来规划

### Phase 1: 功能增强 (已完成)

- ✅ 场景测试基础功能
- ✅ 对话验证基础功能
- ✅ 飞书导入/回写
- ✅ Bull Queue 异步执行
- ✅ LLM 自动评估

### Phase 2: 体验优化 (当前阶段)

- ⏳ 实时进度推送 (WebSocket/SSE)
- ⏳ 批量操作优化
- ⏳ 评审流程优化
- ⏳ 统计图表可视化

### Phase 3: 评估能力扩展 (规划中)

```
多维度评估系统
├── LLM 评估 (已实现)
│   └── 语义相似度评分
├── 规则评估 (规划)
│   ├── 关键词检查
│   ├── 格式验证
│   └── 敏感信息检测
├── 性能评估 (规划)
│   ├── 响应时间
│   ├── Token 消耗
│   └── 工具调用次数
└── 安全评估 (规划)
    ├── Prompt 注入检测
    ├── 信息泄露检测
    └── 有害内容检测
```

### Phase 4: 自动化流程 (长期)

- 从生产环境自动采样对话
- 定时自动执行评估
- CI/CD 集成 (PR 触发测试)
- 评估结果自动推送 (飞书/邮件)

### Phase 5: 平台化能力 (远期)

- 版本对比 (A/B Testing)
- 趋势分析和预警
- 自动回归测试
- 评估结果 API 化
- 多租户支持

## 架构演进路径

### 当前架构 (v1.x)

```
简易评估系统
├── 2 种测试类型
├── 1 种评估方法 (LLM)
├── 手动导入/执行
└── 基础统计分析
```

**适用场景**: 初期质量验证,定期抽查

### 目标架构 (v2.x)

```
完整评估平台
├── 多种测试类型 (场景/对话/性能/安全)
├── 多种评估方法 (LLM/规则/指标)
├── 自动化流程 (采样/执行/推送)
└── 深度分析 (趋势/预警/对比)
```

**适用场景**: 持续质量保障,自动化测试

### 重构触发条件

**何时需要重构**:
1. 需要支持 3+ 种新测试类型
2. 评估逻辑复杂度显著增加
3. 多人协作时代码结构混乱
4. 性能瓶颈无法通过调优解决

**重构方向**:
- 评估器策略模式抽象
- 测试场景独立模块化
- 数据源适配器模式
- 结果分析器插件化

## 最佳实践

### 1. 测试用例设计

**✅ 推荐**:
- 覆盖常见场景 (80%) + 边界场景 (20%)
- 每个分类至少 5 个用例
- 预期输出具体明确
- 定期更新测试集

**❌ 避免**:
- 只测试正常流程
- 用例名称不清晰
- 预期输出模糊
- 测试集长期不更新

### 2. 执行策略

**批量执行**:
- 大批量 (>20): 串行执行
- 小批量 (<10): 并行执行
- 超大批量 (>100): 使用 Bull Queue

**失败处理**:
- 自动重试 (最多 2 次)
- 记录详细错误信息
- 支持手动重新执行

### 3. 评审规范

**评审时应**:
- 仔细对比实际 vs 预期
- 选择准确的失败原因
- 填写详细的评审评论
- 及时回写飞书

**评审标准**:
- 准确性 (40%)
- 完整性 (30%)
- 相关性 (20%)
- 专业性 (10%)

### 4. 性能监控

**关键指标**:
- 执行耗时 (duration_ms)
- Token 消耗 (token_usage)
- 成功率 (success / total)
- 通过率 (passed / reviewed)

**告警阈值**:
- 平均耗时 > 5s
- Token 消耗 > 1000
- 成功率 < 95%
- 通过率 < 80%

## 相关文档

- [场景测试工作流程](./scenario-test-workflow.md)
- [对话验证工作流程](./conversation-test-workflow.md)
- [飞书 API 集成指南](../integrations/feishu-integration.md)
- [Bull Queue 使用文档](../technical/bull-queue-guide.md)
- [NestJS 最佳实践](../../.claude/agents/code-standards.md)
