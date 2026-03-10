# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DuLiDay 企业微信智能服务中间层 - NestJS-based middleware connecting WeChat Enterprise hosting platform with AI Agent services.

**Tech Stack**: NestJS 10.3 | TypeScript 5.3 | Node.js 20+ | Bull Queue | Redis (Upstash) | Winston

**Core Purpose**:
- Receive message callbacks from WeChat Enterprise hosting platform
- Invoke AI Agent API for intelligent responses
- Send replies back through hosting platform API

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

# Single test file
pnpm run test -- message.service.spec.ts

# Database Migrations (Supabase CLI)
pnpm run db:new <name>  # Create new migration
pnpm run db:push        # Apply migrations to remote
pnpm run db:status      # List migration status
pnpm run db:pull        # Pull remote schema changes
pnpm run db:diff        # Generate diff migration
```

## Architecture

### DDD Layered Architecture (2 Business Domains)

```
supabase/
├── config.toml                     # Supabase project configuration
└── migrations/                     # Database migrations (YYYYMMDDHHMMSS_*.sql)
    └── 20260310000000_baseline.sql # Full schema baseline (12 tables, 19 functions)

src/
├── core/                           # Infrastructure Layer (Horizontal)
│   ├── client-http/                # HTTP client factory (Bearer Token)
│   ├── config/                     # Config management (env validation)
│   ├── redis/                      # Redis cache (Global module)
│   ├── supabase/                   # Supabase database service
│   ├── monitoring/                 # System monitoring & metrics (Dashboard)
│   ├── alert/                      # Alert system (simplified ~300 lines)
│   └── server/response/            # Unified response (Interceptor + Filter)
│
├── agent/                          # AI Agent Domain
│   ├── agent.service.ts            # Agent API invocation layer
│   ├── agent-registry.service.ts   # Model/tool registry
│   ├── services/                   # Agent sub-services
│   │   ├── agent-api-client.service.ts
│   │   ├── agent-fallback.service.ts
│   │   ├── brand-config.service.ts
│   │   └── agent-profile-loader.service.ts
│   └── profiles/                   # Agent context configurations
│
└── wecom/                          # WeChat Enterprise Domain
    ├── message/                    # Message processing (Core business)
    │   ├── message.service.ts      # Main coordinator (~300 lines)
    │   └── services/               # Sub-services (SRP)
    │       ├── message-deduplication.service.ts
    │       ├── message-filter.service.ts
    │       ├── message-history.service.ts
    │       ├── message-merge.service.ts     # Smart aggregation (Bull Queue)
    │       └── message-statistics.service.ts
    ├── message-sender/             # Message sending
    ├── bot/                        # Bot management
    ├── chat/                       # Chat session
    ├── contact/                    # Contact management
    ├── room/                       # Group chat
    └── user/                       # User management
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
      ├── Smart merge (if enabled, 1s window / max 3 messages)
      └── Return 200 OK immediately
  → [Async Queue Processing]
      ├── Aggregate messages
      ├── Call Agent API (AgentService.chat)
      ├── Split response (MessageSplitter: \n\n + ~)
      └── Send reply (with delay)
```

### Path Aliases (tsconfig.json)

```typescript
import { HttpClientFactory } from '@core/http';
import { AgentService } from '@agent';
import { MessageService } from '@wecom/message';
import { MonitoringService } from '@core/monitoring';
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
| `AGENT_API_KEY` | AI Agent API 密钥 | 花卷平台 |
| `AGENT_API_BASE_URL` | AI Agent API 地址 | 花卷平台 |
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
| `PORT` | `8080` | 服务端口 | main.ts |
| `AGENT_API_TIMEOUT` | `600000` | API 超时 (10min) | agent-api-client |
| `MAX_HISTORY_PER_CHAT` | `60` | Redis 消息数限制 | message-history |
| `HISTORY_TTL_MS` | `7200000` | Redis 消息 TTL (2h) | message-history |
| `INITIAL_MERGE_WINDOW_MS` | `1000` | 聚合等待时间 | message-merge |
| `MAX_MERGED_MESSAGES` | `3` | 最大聚合条数 | message-merge |
| `TYPING_DELAY_PER_CHAR_MS` | `100` | 打字延迟/字符 | message-sender |
| `PARAGRAPH_GAP_MS` | `2000` | 段落间隔 | message-sender |

#### Layer 3: 硬编码默认值（无需配置）
**特点**：内置于代码，极少需要修改

| 配置 | 值 | 位置 |
|------|-----|------|
| 告警节流窗口 | 5 分钟 | FeishuAlertService |
| 告警最大次数 | 3 次/类型 | FeishuAlertService |
| 健康检查间隔 | 1 小时 | AgentRegistryService |
| Profile 缓存 TTL | 1 小时 | ProfileLoaderService |

#### 配置文件说明
- **`.env.example`** - 模板文件，列出所有可配置项
- **`.env.local`** - 本地开发配置（不提交 Git）
- **代码默认值** - 在各 Service 的 constructor 中定义

```typescript
// Layer 1: 必填，无默认值
this.apiKey = this.configService.get<string>('AGENT_API_KEY')!;

// Layer 2: 可选，有默认值
this.timeout = parseInt(this.configService.get('AGENT_API_TIMEOUT', '600000'));

// Layer 3: 硬编码
private readonly THROTTLE_WINDOW_MS = 5 * 60 * 1000;
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
AGENT_API_KEY=your-key
AGENT_API_BASE_URL=https://huajune.duliday.com/api/v1
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
DULIDAY_API_TOKEN=your-token
STRIDE_API_BASE_URL=https://stride-bg.dpclouds.com
FEISHU_ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_ALERT_SECRET=your-secret
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key

# === Layer 2: 按需覆盖 ===
# INITIAL_MERGE_WINDOW_MS=3000  # 默认 1000
# MAX_MERGED_MESSAGES=5         # 默认 3
```

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

### 2. Agent API (花卷)
- **Official Docs**: https://docs.wolian.cc/

Key endpoints:
- `POST /api/v1/chat` - Chat with AI
- `GET /api/v1/models` - Available models
- `GET /api/v1/tools` - Available tools

## Testing and Debugging

```bash
# Health check
curl http://localhost:8080/agent/health

# View available models
curl http://localhost:8080/agent/models

# Debug chat (complete raw response)
curl -X POST http://localhost:8080/agent/debug-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"debug-001"}'

# View logs
tail -f logs/combined-$(date +%Y-%m-%d).log

# Monitoring dashboard
open http://localhost:8080/monitoring.html
```

## Troubleshooting

### Agent API Connection Failed
```bash
# Check config
echo $AGENT_API_KEY
curl -H "Authorization: Bearer $AGENT_API_KEY" \
  $AGENT_API_BASE_URL/models

# Health check
curl http://localhost:8080/agent/health
```

### Port Already in Use
```bash
lsof -i :8080
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
