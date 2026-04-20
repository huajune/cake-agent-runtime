# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cake Agent Runtime - DuLiDay 旗下的招聘专用 AI Agent 运行时，基于 Vercel AI SDK 多 Provider 架构，通过企业微信渠道为餐饮连锁企业提供智能招聘对话服务。

**Tech Stack**: NestJS 10.3 | TypeScript 5.3 | Node.js 20+ | Vercel AI SDK | Supabase | Redis (Upstash) | Bull Queue | Winston

**Core Capabilities**:
- Agent 编排：Recall → Compose → Execute → Store 闭环，多步工具调用
- 多模型容错：三层 Provider 架构（注册 → 重试/降级 → 角色路由）
- 四层记忆：短期对话 → 会话事实 → 程序性阶段 → 长期用户画像
- 渠道接入：企业微信消息管道（去重、过滤、聚合、拟人化投递）
- 质量评估：LLM 评分的对话测试框架

## Development Commands

```bash
# Development (with hot reload)
pnpm run start:dev

# Build
pnpm run build

# Production
pnpm run start:prod

# Code Quality
pnpm run lint          # ESLint check and auto-fix
pnpm run format        # Prettier formatting
pnpm run test          # Run tests
pnpm run test:cov      # Test coverage

# Single test file (tests are in tests/ directory, mirroring src/ structure)
pnpm run test -- tests/wecom/message/message.service.spec.ts

# Database Migrations (Supabase CLI, 生产/测试已隔离)
pnpm run db:new <name>       # Create new migration
pnpm run db:push:test        # Apply migrations to TEST (gaovfitvetoojkvtalxy)
pnpm run db:push:prod        # Apply migrations to PROD (uvmbxcilpteaiizplcyp)
pnpm run db:status:test      # List TEST migration status
pnpm run db:status:prod      # List PROD migration status
pnpm run db:pull             # Pull remote schema changes
pnpm run db:diff             # Generate diff migration

# 数据变更流程：先测试 → 再生产
# 1. pnpm run db:new add_feature
# 2. 编写 SQL（用 IF NOT EXISTS / ON CONFLICT 保证幂等）
# 3. pnpm run db:push:test   → 验证
# 4. pnpm run db:push:prod   → 上线
```

## Architecture

### Layered Architecture

**Layer placement criteria**: 依赖业务数据（用户、消息等）→ `biz/`；可独立于业务存在 → `infra/`。
`infra/` 禁止 import `biz/`、`wecom/`、`agent/`。

```
supabase/
├── config.toml                     # Supabase project configuration
└── migrations/                     # Database migrations (YYYYMMDDHHMMSS_*.sql)
    └── 20260310000000_baseline.sql # Full schema baseline (12 tables, 19 functions)

src/
├── infra/                          # Infrastructure Layer (业务无关，禁止依赖 biz/)
│   ├── client-http/                # HTTP client factory (Bearer Token)
│   ├── config/                     # Config management (env validation)
│   ├── redis/                      # Redis cache (Global module)
│   ├── supabase/                   # Supabase database service
│   ├── feishu/                     # 飞书集成 (告警通知)
│   ├── alert/                      # Alert system (simplified ~300 lines)
│   └── server/response/            # Unified response (Interceptor + Filter)
│
├── providers/                      # 多模型 Provider 层 (Vercel AI SDK)
│   ├── registry.service.ts         # Layer 1: 纯工厂注册 (createProviderRegistry)
│   ├── reliable.service.ts         # Layer 2: 容错层 (retry + fallback)
│   ├── router.service.ts           # Layer 3: 角色路由 (resolveByRole)
│   └── types.ts                    # Provider 配置与常量
│
├── tools/                          # 工具注册表 + 内置工具
│   ├── tool-registry.service.ts    # 工具注册与构建
│   └── *.tool.ts                   # 各工具实现
│
├── memory/                         # 四层记忆系统
│   ├── memory.service.ts           # 统一读取 API (recallAll)
│   ├── short-term.service.ts       # 短期：对话窗口
│   ├── session-facts.service.ts    # 会话事实：意向/推荐记录
│   ├── procedural.service.ts       # 程序性：阶段追踪
│   ├── long-term.service.ts        # 长期：用户画像 (Supabase)
│   └── settlement.service.ts       # 空闲沉淀 (Session → Profile)
│
├── mcp/                            # MCP 客户端 (动态工具扩展)
├── sponge/                         # 外部数据服务
│
├── agent/                          # AI Agent 编排层
│   ├── runner.service.ts           # 核心编排引擎 (invoke/stream)
│   ├── completion.service.ts       # 简单一次性 LLM 调用
│   ├── context/                    # 动态 Prompt 组装 (Section 体系)
│   ├── fact-extraction.service.ts  # LLM 事实提取
│   └── input-guard.service.ts      # 输入安全检测
│
├── biz/                            # Business Layer (业务领域)
│   ├── monitoring/                 # 业务监控 (tracking + analytics + cleanup)
│   ├── user/                       # 用户管理
│   ├── hosting-config/             # 托管配置
│   ├── message/                    # 消息业务 (chat session + booking)
│   ├── strategy/                   # 业务策略 (persona + redLines + stageGoals)
│   ├── test-suite/                 # Agent 测试套件
│   └── feishu-sync/                # 飞书多维表格双向同步
│
├── evaluation/                     # 对话质量评估框架
│   ├── llm-evaluation.service.ts   # LLM 评分
│   ├── conversation-parser.service.ts  # 对话解析
│   └── services/                   # 执行/对话/飞书同步子服务
│
├── channels/
│   └── wecom/                      # WeChat Enterprise Domain
│       ├── message/                # 消息管道 (去重/过滤/聚合/投递)
│       │   ├── message.service.ts  # Main coordinator
│       │   └── services/           # Sub-services (pipeline, delivery, etc.)
│       ├── message-sender/         # Message sending
│       ├── bot/                    # Bot management
│       ├── chat/                   # Chat session
│       ├── contact/                # Contact management
│       └── room/                   # Group chat
│
└── observability/                  # Observer 可观测性
```

### Message Processing Flow

```
WeChat User Message
  → Hosting Platform Callback → /wecom/message
  → MessageController.handleCallback()
  → MessageService.handleMessage()
      ├── Deduplication check
      ├── Message filtering
      ├── Save to history
      ├── Debounce merge (每条消息注册一个 delay=静默窗口 的 Bull job，
      │                  Worker 触发时若距最后一条消息静默足够久才处理)
      └── Return 200 OK immediately
  → [Async Queue Processing]
      ├── 取出静默窗口内累积的全部消息并合并
      ├── Call Agent (OrchestratorService.run → Provider → generateText)
      ├── Split response (MessageSplitter: \n\n + ~)
      └── Send reply (with delay)
```

### Path Aliases (tsconfig.json)

```typescript
import { HttpClientFactory } from '@infra/http';
import { AgentRunnerService } from '@agent/runner.service';
import { RouterService } from '@providers/router.service';
import { MessageService } from '@channels/wecom/message';
```

## Key Design Patterns

### 1. Service Decomposition (MessageService Case)
Refactored from 1099 lines monolith → 5 sub-services (~300 lines main)
- **Deduplication** - MessageDeduplicationService
- **Filtering** - MessageFilterService
- **History** - MessageHistoryService
- **Merging** - MessageMergeService (Queue-driven)
- **Statistics** - MessageStatisticsService

### 2. Caching Strategy
- **Memory Cache** - Agent config profiles (ProfileLoaderService)
- **Redis Cache** - Message history (MessageHistoryService)
- **Bull Queue** - Message aggregation processing (MessageMergeService)

### 3. Factory Pattern
```typescript
// HttpClientFactory - Create clients with Bearer Token
const client = this.httpClientFactory.createWithBearerAuth(config, token);
```

### 4. Unified Response Handling
- **ResponseInterceptor** - Auto-wrap successful responses
- **HttpExceptionFilter** - Centralized error handling
- **@RawResponse** - Bypass wrapper (for 3rd party callbacks)

Response format:
- Success: `{ success: true, data: {...}, timestamp: '...' }`
- Error: `{ success: false, error: { code, message }, timestamp: '...' }`

### 5. Configuration Strategy

配置分为三层，按变更频率和安全性分类：

#### Layer 1: 必填环境变量（密钥/URL）
**特点**：敏感信息，必须手动配置，不能有默认值

| 变量 | 说明 | 来源 |
|------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | Anthropic |
| `AGENT_CHAT_MODEL` | 主聊天模型 ID | 环境配置 |
| `UPSTASH_REDIS_REST_URL` | Redis REST API URL | Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST Token | Upstash |
| `DULIDAY_API_TOKEN` | 杜力岱 API Token | 内部系统 |
| `STRIDE_API_BASE_URL` | 托管平台 API | Stride |
| `FEISHU_ALERT_WEBHOOK_URL` | 飞书告警 Webhook | 飞书机器人 |
| `FEISHU_ALERT_SECRET` | 飞书签名密钥 | 飞书机器人 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥 | Supabase |

#### Layer 2: 可选环境变量（有默认值）
**特点**：代码中有默认值，按需覆盖

| 变量 | 默认值 | 说明 | 使用位置 |
|------|--------|------|----------|
| `PORT` | `8585` | 服务端口 | main.ts |
| `MAX_HISTORY_PER_CHAT` | `60` | Redis 消息数限制 | message-history |
| `HISTORY_TTL_MS` | `7200000` | Redis 消息 TTL (2h) | message-history |
| `TYPING_DELAY_PER_CHAR_MS` | `100` | 打字延迟/字符 | message-sender |
| `PARAGRAPH_GAP_MS` | `2000` | 段落间隔 | message-sender |

> **消息聚合参数已下沉到托管配置（hosting-config）**：
> - `initialMergeWindowMs`（默认 `3000`）— 距离最后一条用户消息静默多久后才触发 Agent（debounce 窗口）
> - 通过 Dashboard / Supabase `hosting_config` 表动态调整，不再走环境变量
> - 旧的 `INITIAL_MERGE_WINDOW_MS` / `MAX_MERGED_MESSAGES` 已废弃（`MAX_MERGED_MESSAGES` 因改用 debounce 不再需要上限）

#### Layer 3: 硬编码默认值（无需配置）
**特点**：内置于代码，极少需要修改

| 配置 | 值 | 位置 |
|------|-----|------|
| 告警节流窗口 | 5 分钟 | FeishuAlertService |
| 告警最大次数 | 3 次/类型 | FeishuAlertService |
| Profile 缓存 TTL | 1 小时 | ProfileLoaderService |

#### 配置文件说明
- **`.env.example`** - 模板文件，列出所有可配置项
- **`.env.local`** - 本地开发配置（不提交 Git）
- **代码默认值** - 在各 Service 的 constructor 中定义

```typescript
// Layer 1: 必填，无默认值
const model = this.router.resolveByRole('chat'); // AGENT_CHAT_MODEL

// Layer 2: 可选，有默认值
const paragraphGap = parseInt(this.configService.get('PARAGRAPH_GAP_MS', '2000'));

// Layer 3: 硬编码
private readonly THROTTLE_WINDOW_MS = 5 * 60 * 1000;

// 托管配置（Supabase hosting_config 动态读取）
const mergeDelayMs = this.runtimeConfig.getMergeDelayMs(); // initialMergeWindowMs
```

## Code Standards

### TypeScript Strict Mode

```typescript
// ❌ Forbidden
function process(data: any): any { }

// ✅ Required
function process(data: ProcessData): Result { }

// ✅ When uncertain, use unknown
function process(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    return (data as ProcessData).value;
  }
}
```

### NestJS Service Structure

```typescript
@Injectable()
export class ExampleService {
  // 1. Logger (must be first)
  private readonly logger = new Logger(ExampleService.name);

  // 2. Config properties
  private readonly apiUrl: string;

  // 3. Constructor (DI)
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.apiUrl = this.configService.get('API_URL');
  }

  // 4. Public methods
  async publicMethod(): Promise<Result> {
    try {
      // Business logic
    } catch (error) {
      this.logger.error('Error:', error);
      throw new HttpException('Failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // 5. Private helpers
  private privateHelper(): void { }
}
```

### Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| **Files** | kebab-case | `agent-api.service.ts`, `message-sender.controller.ts` |
| **Classes/Interfaces** | PascalCase | `AgentService`, `IAgentProfile` |
| **Variables/Functions** | camelCase | `sendMessage`, `apiKey` |
| **Constants** | UPPER_SNAKE_CASE | `API_TIMEOUT`, `MAX_RETRY_COUNT` |

### Forbidden Practices

```typescript
// ❌ Absolutely Forbidden
const apiKey = 'sk-xxx';              // Hardcoded secrets
console.log('debug');                 // Using console
private service = new Service();      // Manual instantiation
function test(data: any): any { }     // Using any

// ✅ Must Use
const apiKey = this.configService.get('API_KEY');
this.logger.log('debug');
constructor(private readonly service: Service) {}
function test(data: Data): Result { }
```

## Environment Configuration

配置策略详见上方 [Configuration Strategy](#5-configuration-strategy)。

### 快速开始

1. 复制模板：`cp .env.example .env.local`
2. 填写必填项（Layer 1 的密钥/URL）
3. 按需调整可选项（Layer 2 有默认值）

### 最小配置示例

```bash
# === Layer 1: 必填 ===
ANTHROPIC_API_KEY=your-anthropic-key
AGENT_CHAT_MODEL=anthropic/claude-sonnet-4-5-20250929
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
DULIDAY_API_TOKEN=your-token
STRIDE_API_BASE_URL=https://stride-bg.dpclouds.com
FEISHU_ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_ALERT_SECRET=your-secret
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key

# === Layer 2: 按需覆盖 ===
# PARAGRAPH_GAP_MS=2500          # 段落间隔，默认 2000
# TYPING_DELAY_PER_CHAR_MS=120   # 打字延迟/字符，默认 100
```

> 消息聚合的 `initialMergeWindowMs`（debounce 静默窗口）已改为通过 Dashboard 的托管配置调整，不再是环境变量。

完整配置项见 `.env.example`。

## Git Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git commit -m "feat: add broadcast messaging"        # New feature (minor +1)
git commit -m "fix: resolve session timeout issue"   # Bug fix (patch +1)
git commit -m "refactor: simplify message handler"   # Refactoring
git commit -m "docs: update API documentation"       # Documentation
git commit -m "chore: update dependencies"           # Maintenance
```

Auto-versioning: When `develop` merges to `master`, GitHub Actions automatically:
- Analyzes commits and updates version
- Generates CHANGELOG.md
- Creates version tag (e.g., v1.2.3)

## Key APIs

### 1. Hosting Platform API
- **Enterprise-level**: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445
- **Group-level**: https://s.apifox.cn/acec6592-fec1-443b-8563-10c4a10e64c4

Key endpoints:
- `GET /stream-api/chat/list` - Chat list
- `GET /stream-api/message/history` - Message history
- `POST /stream-api/message/send` - Send message

### 2. AI Provider
通过 Vercel AI SDK 直连各厂商 API（Anthropic, OpenAI, DeepSeek 等），
由 `src/providers/` 三层架构管理（Registry → Reliable → Router）。

## Testing and Debugging

```bash
# Health check
curl http://localhost:8585/agent/health

# View available models
curl http://localhost:8585/agent/models

# Debug chat (complete raw response)
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"debug-001"}'

# View logs
tail -f logs/combined-$(date +%Y-%m-%d).log

# Monitoring dashboard
open http://localhost:8585/monitoring.html
```

## Troubleshooting

### Agent API Connection Failed
```bash
# Health check — 查看已注册的 Provider
curl http://localhost:8585/agent/health

# 确认 API Key 已配置
echo $ANTHROPIC_API_KEY
echo $AGENT_CHAT_MODEL
```

### Port Already in Use
```bash
lsof -i :8585
kill -9 <PID>
# Or change PORT in .env
```

### Message Merge Not Working
- Verify `ENABLE_MESSAGE_MERGE=true`
- Check Redis connection
- Verify Bull Queue status
- In dev mode: set `ENABLE_BULL_QUEUE=false` if no Redis

### Dependencies Installation Failed
```bash
pnpm store prune
rm -rf node_modules
pnpm install
```

## Advanced Documentation

For detailed guidelines on specific topics, see the **Claude Code Agents Documentation System**:

📚 **[.claude/agents/README.md](./.claude/agents/README.md)** - Modular documentation hub

**Specialized guides:**
- **[Code Standards](./.claude/agents/code-standards.md)** - In-depth TypeScript & NestJS conventions
- **[Architecture Principles](./.claude/agents/architecture-principles.md)** - SOLID, design patterns, DDD
- **[Development Workflow](./.claude/agents/development-workflow.md)** - Git flow, testing, CI/CD
- **[Performance Optimization](./.claude/agents/performance-optimization.md)** - Caching, monitoring, tuning
- **[Code Quality Guardian](./.claude/agents/code-quality-guardian.md)** - Automated quality checks

**When to use:**
- This file (CLAUDE.md) provides quick overview and essential information
- Agents docs provide deep dives into specific areas
- Use agents docs for complex tasks requiring detailed guidance

## Important References

- **NestJS Docs**: https://docs.nestjs.com/
- **Conventional Commits**: https://www.conventionalcommits.org/
- **Development Guide**: docs/DEVELOPMENT_GUIDE.md (if exists)
- **Cursor Rules**: .cursorrules (comprehensive development standards)

## Best Practices Summary

✅ **Must Follow**:
- Strict type checking (no `any`)
- Dependency injection (no `new Service()`)
- Use Logger (no `console.log`)
- Environment variables (no hardcoding)
- Single responsibility (<500 lines per service)
- Complete error handling (try-catch)
- Comprehensive Swagger docs

❌ **Absolutely Forbidden**:
- Hardcoded secrets or credentials
- Using `console.log`
- Manual service instantiation
- Abusing `any` type
- Unhandled exceptions
- Ignoring TypeScript errors
