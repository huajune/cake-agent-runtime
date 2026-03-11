---
name: architecture-principles
role: system
model: sonnet
visibility: global
description: >
  系统架构设计原则、分层架构、SOLID原则、设计模式指导。
  用于指导模块划分、依赖管理和架构决策。

tags:
  - architecture
  - design-patterns
  - solid-principles
  - layering

priority: high
---

# Architecture Principles & Design Patterns

> System architecture guidelines and design patterns for the DuLiDay WeChat Service

**Last Updated**: 2026-03-11
**Scope**: System design, module structure, and architectural decisions

---

## 📋 Table of Contents

- [Architectural Philosophy](#architectural-philosophy)
- [Layered Architecture](#layered-architecture)
- [SOLID Principles](#solid-principles)
- [Design Patterns](#design-patterns)
- [Module Organization](#module-organization)
- [Dependency Management](#dependency-management)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

---

## Architectural Philosophy

### Core Principles

#### 🎯 Simplicity Over Complexity

```
"A complex system that works is invariably found to have evolved from
a simple system that worked." — John Gall
```

**Guidelines:**

- Start simple, add complexity only when needed
- Don't build for imaginary future requirements (YAGNI)
- Prefer proven solutions over new experiments
- Refactor as you grow, don't over-architect upfront

**Example:**

```typescript
// ❌ Over-engineered for current needs
interface IMessageProcessor {
  process(message: Message): Promise<void>;
}
interface IMessageValidator {
  validate(message: Message): boolean;
}
interface IMessageRouter {
  route(message: Message): Destination;
}
interface IMessageTransformer {
  transform(message: Message): Message;
}
// ... 10+ interfaces for simple message handling

// ✅ Simple and practical for current needs
@Injectable()
export class MessageService {
  async handleMessage(message: IncomingMessageData): Promise<void> {
    // Direct implementation, refactor when complexity grows
  }
}
```

#### 🏗️ Do One Thing Well (Unix Philosophy)

Each service should have a single, well-defined responsibility.

```typescript
// ❌ God object - does everything
@Injectable()
export class MessageService {
  async handleMessage(data: IncomingMessageData) {
    // 1. Parse message
    // 2. Validate permissions
    // 3. Call AI
    // 4. Translate reply
    // 5. Moderate content
    // 6. Send message
    // 7. Log analytics
    // 8. Update user profile
    // ... 100+ lines of mixed responsibilities
  }
}

// ✅ Single responsibility - orchestrates workflow
@Injectable()
export class MessageService {
  constructor(
    private readonly agentService: AgentService,
    private readonly senderService: MessageSenderService,
    private readonly conversationService: ConversationService,
  ) {}

  async handleMessage(data: IncomingMessageData) {
    // Only orchestrates the workflow
    const conversationId = this.conversationService.generateId(
      data.contactId,
      data.roomId,
      data.isRoom,
    );

    const reply = await this.agentService.chat({
      conversationId,
      userMessage: data.content,
    });

    await this.senderService.sendMessage({
      token: data.token,
      content: reply,
      toWxid: data.contactId,
    });
  }
}
```

---

## Layered Architecture

### Three-Layer Architecture

```
┌─────────────────────────────────────────┐
│  Presentation Layer (Controllers)       │  ← HTTP/API
│  - Request validation                   │
│  - Response formatting                  │
└───────────────┬─────────────────────────┘
                │
┌───────────────▼─────────────────────────┐
│  Business Layer (biz/ + wecom/ + agent/) │  ← Core Logic
│  - Business rules & domain logic        │
│  - Workflow orchestration                │
│  - Domain-specific repositories          │
└───────────────┬─────────────────────────┘
                │
┌───────────────▼─────────────────────────┐
│  Infrastructure Layer (core/)           │  ← Foundation
│  - HTTP client, Config, Redis, Supabase │
│  - Alert system, Server response        │
│  - Generic, reusable, business-agnostic │
└─────────────────────────────────────────┘
```

### Layer Rules

**Dependency Direction:**

- ✅ Higher layers can depend on lower layers
- ❌ Lower layers NEVER depend on higher layers
- ❌ `core/` NEVER imports from `biz/`, `wecom/`, or `agent/`
- ❌ NO circular dependencies at any level

**Layer Placement Criteria:**

判断一个模块应放 `core/` 还是 `biz/`：
- **依赖业务数据**（用户、消息、订单等）→ `biz/`
- **可独立于业务存在**（HTTP、Redis、配置）→ `core/`
- 如果 `core/` 中的模块需要 import `biz/` 的代码，说明它放错了位置

**Project Structure:**

```
src/
├── core/                    # Infrastructure Layer (业务无关)
│   ├── config/             # 配置管理 (env validation)
│   ├── client-http/        # HTTP 客户端工厂
│   ├── redis/              # Redis 缓存 (Global)
│   ├── supabase/           # Supabase 数据库基础服务
│   ├── alert/              # 告警系统 (飞书通知)
│   └── server/response/    # 统一响应 (Interceptor + Filter)
│
├── agent/                   # AI Agent 领域
│   ├── agent.service.ts
│   ├── services/
│   └── profiles/
│
├── biz/                     # 业务领域层
│   ├── monitoring/         # 监控 (tracking + analytics + cleanup)
│   ├── user/               # 用户管理
│   ├── hosting-config/     # 托管配置
│   └── message/            # 消息业务
│
└── wecom/                   # 企业微信领域
    ├── message/            # 消息处理 (核心业务)
    ├── message-sender/     # 消息发送
    ├── bot/                # 机器人管理
    ├── chat/               # 会话管理
    ├── contact/            # 联系人
    └── room/              # 群聊
```

**Validation:**

```bash
# Check for circular dependencies
npx madge --circular --extensions ts src/
```

---

## SOLID Principles

### Single Responsibility Principle (SRP)

Each class should have one reason to change.

```typescript
// ✅ Correct: Separate responsibilities
@Injectable()
export class MessageService {
  // Only handles message processing logic
  async handleMessage(data: IncomingMessageData) {
    // Processing only
  }
}

@Injectable()
export class MessageSenderService {
  // Only handles message sending
  async sendMessage(dto: SendMessageDto) {
    // Sending only
  }
}

// ❌ Wrong: Too many responsibilities
@Injectable()
export class MessageService {
  async handleMessage(data: IncomingMessageData) {
    // Process, validate, send, log, analyze...
    // Too many reasons to change
  }
}
```

### Open/Closed Principle (OCP)

Open for extension, closed for modification.

```typescript
// ✅ Extensible through interfaces
interface IConversationStorage {
  get(conversationId: string): Promise<Message[]>;
  set(conversationId: string, messages: Message[]): Promise<void>;
}

// Implementation 1: Memory (v1.0)
@Injectable()
export class MemoryConversationStorage implements IConversationStorage {
  private store = new Map<string, Message[]>();

  async get(conversationId: string): Promise<Message[]> {
    return this.store.get(conversationId) || [];
  }

  async set(conversationId: string, messages: Message[]): Promise<void> {
    this.store.set(conversationId, messages);
  }
}

// Implementation 2: Redis (v1.1) - extends without modifying interface
@Injectable()
export class RedisConversationStorage implements IConversationStorage {
  constructor(private readonly redis: RedisService) {}

  async get(conversationId: string): Promise<Message[]> {
    const data = await this.redis.get(conversationId);
    return JSON.parse(data || '[]');
  }

  async set(conversationId: string, messages: Message[]): Promise<void> {
    await this.redis.set(conversationId, JSON.stringify(messages));
  }
}
```

### Liskov Substitution Principle (LSP)

Subtypes must be substitutable for their base types.

```typescript
// ✅ Correct: All implementations honor the contract
interface IMessageSender {
  send(message: string, recipient: string): Promise<void>;
}

class WeChatSender implements IMessageSender {
  async send(message: string, recipient: string): Promise<void> {
    // Always sends the message
  }
}

class EmailSender implements IMessageSender {
  async send(message: string, recipient: string): Promise<void> {
    // Always sends the message
  }
}

// ❌ Wrong: Violates LSP
class LoggingOnlySender implements IMessageSender {
  async send(message: string, recipient: string): Promise<void> {
    // Only logs, doesn't actually send - violates contract!
    console.log(`Would send: ${message}`);
  }
}
```

### Interface Segregation Principle (ISP)

Clients should not depend on interfaces they don't use.

```typescript
// ❌ Wrong: Fat interface
interface IMessage {
  send(): Promise<void>;
  receive(): Promise<void>;
  forward(): Promise<void>;
  delete(): Promise<void>;
  archive(): Promise<void>;
  // ... many methods
}

// ✅ Correct: Segregated interfaces
interface IMessageSender {
  send(): Promise<void>;
}

interface IMessageReceiver {
  receive(): Promise<void>;
}

interface IMessageManager {
  delete(): Promise<void>;
  archive(): Promise<void>;
}

// Use only what you need
class SimpleSender implements IMessageSender {
  async send(): Promise<void> {
    // Only implements send
  }
}
```

### Dependency Inversion Principle (DIP)

Depend on abstractions, not concretions.

```typescript
// ❌ Wrong: Depends on concrete implementation
@Injectable()
export class MessageService {
  async handleMessage(data: IncomingMessageData) {
    // Direct dependency on axios
    const response = await axios.post('https://api.ai.com/chat', data);
  }
}

// ✅ Correct: Depends on abstraction
@Injectable()
export class MessageService {
  constructor(
    private readonly agentService: AgentService, // Abstraction
  ) {}

  async handleMessage(data: IncomingMessageData) {
    const response = await this.agentService.chat({
      conversationId: data.fromUser,
      userMessage: data.content,
    });
  }
}
```

---

## Design Patterns

### Strategy Pattern

Use when you need to switch between different algorithms.

```typescript
// Strategy interface
interface IMessageProcessor {
  process(message: IncomingMessageData): Promise<void>;
}

// Concrete strategies
@Injectable()
export class TextMessageProcessor implements IMessageProcessor {
  async process(message: IncomingMessageData): Promise<void> {
    // Handle text messages
  }
}

@Injectable()
export class ImageMessageProcessor implements IMessageProcessor {
  async process(message: IncomingMessageData): Promise<void> {
    // Handle image messages
  }
}

// Context
@Injectable()
export class MessageService {
  private processors = new Map<string, IMessageProcessor>();

  constructor(
    private readonly textProcessor: TextMessageProcessor,
    private readonly imageProcessor: ImageMessageProcessor,
  ) {
    this.processors.set('text', textProcessor);
    this.processors.set('image', imageProcessor);
  }

  async handleMessage(message: IncomingMessageData): Promise<void> {
    const processor = this.processors.get(message.type);
    if (processor) {
      await processor.process(message);
    }
  }
}
```

### Factory Pattern

Use for creating objects with complex initialization.

```typescript
@Injectable()
export class ConversationFactory {
  create(type: 'user' | 'room', id: string): string {
    switch (type) {
      case 'user':
        return `user_${id}`;
      case 'room':
        return `room_${id}`;
      default:
        throw new Error('Unknown conversation type');
    }
  }
}

// Usage
const conversationId = this.conversationFactory.create('user', 'wxid_123');
```

### Decorator Pattern (NestJS Built-in)

```typescript
// Custom decorator for performance monitoring
export function Monitor(metricName: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const start = Date.now();

      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - start;
        console.log(`${metricName} took ${duration}ms`);
        return result;
      } catch (error) {
        console.error(`${metricName} failed:`, error);
        throw error;
      }
    };

    return descriptor;
  };
}

// Usage
@Injectable()
export class AgentService {
  @Monitor('agent_chat')
  async chat(params: ChatParams): Promise<string> {
    // Automatically monitored
  }
}
```

---

## Module Organization

### Biz 模块目录规范

业务领域模块统一使用以下结构：

```
src/biz/<domain>/
├── <domain>.module.ts          # 模块定义（单文件）
├── <domain>.controller.ts      # 控制器（合并为单文件，多 prefix 用多 class）
├── services/                   # 按子域分目录，禁止铺平
│   ├── <subdomain-a>/
│   │   ├── foo.service.ts
│   │   └── bar.service.ts
│   ├── <subdomain-b>/
│   │   └── baz.service.ts
│   └── ...
├── repositories/               # 数据访问层（直接使用 Supabase BaseRepository）
│   └── <domain>-xxx.repository.ts
└── types/                      # 类型定义，按消费者域拆分
    ├── <consumer-a>.types.ts
    ├── <consumer-b>.types.ts
    └── ...
```

**实际示例 — monitoring 模块：**

```
src/biz/monitoring/
├── monitoring.module.ts
├── monitoring.controller.ts        # AnalyticsController + DashboardController
├── services/
│   ├── tracking/                   # 采集写入
│   │   ├── message-tracking.service.ts
│   │   └── monitoring-cache.service.ts
│   ├── analytics/                  # 聚合分析
│   │   ├── analytics.service.ts
│   │   ├── analytics-alert.service.ts
│   │   └── hourly-stats-aggregator.service.ts
│   └── cleanup/                    # 数据清理
│       └── data-cleanup.service.ts
├── repositories/
│   ├── monitoring.repository.ts
│   ├── monitoring-hourly-stats.repository.ts
│   └── monitoring-error-log.repository.ts
└── types/
    ├── tracking.types.ts           # tracking 服务消费的类型
    ├── analytics.types.ts          # analytics 服务消费的类型
    └── repository.types.ts         # DB 记录格式 + 应用层映射
```

### 核心约束

| 规则 | 要求 |
|------|------|
| **禁止 barrel 导出** | 不使用 `index.ts`，所有导入直接指向具体文件路径 |
| **services 按域分组** | 子目录按职责域划分（如 `tracking/`、`analytics/`），不铺平到同一目录 |
| **controller 合并** | 同一模块的多个 controller 合并到一个 `.controller.ts` 文件，不单独建目录 |
| **types 按消费者拆分** | 不搞大杂烩，按使用方/子域划分 `.types.ts` 文件 |
| **DB 类型与业务类型分离** | `repository.types.ts` 放 `XxxDbRecord`（snake_case 字段），业务类型放各自 `.types.ts` |
| **禁止无用 facade** | 如果 Service 只是纯委托转发，直接删除，让调用方使用底层服务 |
| **单一职责** | 每个 service 文件 < 500 行 |
| **禁止死代码** | 定义但无消费者的类型/代码必须删除 |

### 类型文件规范

```typescript
// ✅ 文件命名：<domain>.types.ts（不用 .interface.ts）
// tracking.types.ts — tracking 服务消费的类型
// analytics.types.ts — analytics 服务消费的类型
// repository.types.ts — DB 记录格式

// ✅ DB 记录类型：XxxDbRecord（snake_case 字段，对应数据库列名）
interface ErrorLogDbRecord {
  message_id: string;
  timestamp: number;
  error: string;
  alert_type?: string;
}

// ✅ 应用层记录类型：XxxRecord（camelCase 字段）
interface ErrorLogRecord {
  messageId: string;
  timestamp: number;
  error: string;
  alertType?: AlertErrorType;
}

// ❌ 禁止重复类型：如 ErrorLogAlertType ≈ AlertErrorType，统一为一个
// ❌ 禁止跨层定义：Agent 领域类型不应定义在 monitoring 的 types 中
```

### 模块定义

```typescript
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    forwardRef(() => MessageModule),  // 必要时使用 forwardRef 解决循环依赖
    FeishuModule,
  ],
  controllers: [AnalyticsController, DashboardController],
  providers: [
    // Repositories
    MonitoringRepository,
    // Services（按子域分组注册）
    MonitoringCacheService,
    MessageTrackingService,
    AnalyticsService,
  ],
  exports: [MessageTrackingService, AnalyticsService],  // 只导出外部需要的
})
export class MonitoringModule {}
```

---

## Dependency Management

### Dependency Injection

```typescript
// ✅ Always use constructor injection
@Injectable()
export class MessageService {
  constructor(
    private readonly agentService: AgentService,
    private readonly senderService: MessageSenderService,
    private readonly logger: Logger,
  ) {}
}

// ❌ NEVER instantiate dependencies manually
@Injectable()
export class MessageService {
  private agentService = new AgentService(); // WRONG!
}
```

### Circular Dependency Prevention

```typescript
// ❌ Circular dependency
// message.service.ts
@Injectable()
export class MessageService {
  constructor(private readonly agentService: AgentService) {}
}

// agent.service.ts
@Injectable()
export class AgentService {
  constructor(private readonly messageService: MessageService) {} // Circular!
}

// ✅ Solution: Introduce intermediate layer
// conversation.service.ts
@Injectable()
export class ConversationService {
  // Shared logic, no dependency on Message or Agent
}

// message.service.ts
@Injectable()
export class MessageService {
  constructor(
    private readonly agentService: AgentService,
    private readonly conversationService: ConversationService,
  ) {}
}

// agent.service.ts
@Injectable()
export class AgentService {
  constructor(private readonly conversationService: ConversationService) {}
}
```

---

## Anti-Patterns to Avoid

### God Object

```typescript
// ❌ Anti-pattern: One class doing everything
@Injectable()
export class MessageService {
  // 50+ methods, 500+ lines
  async handleMessage() {}
  async parseMessage() {}
  async validatePermission() {}
  async callAI() {}
  async translateReply() {}
  async sendMessage() {}
  async logAnalytics() {}
  async updateUserProfile() {}
  // ... many more
}

// ✅ Correct: Separate responsibilities
@Injectable()
export class MessageService {
  constructor(
    private readonly agentService: AgentService,
    private readonly senderService: MessageSenderService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async handleMessage(data: IncomingMessageData) {
    // Only orchestrates, delegates to specialized services
  }
}
```

### Leaky Abstraction

```typescript
// ❌ Abstraction leaks implementation details
interface IConversationStorage {
  redis: RedisClient; // Leaks Redis implementation!
  get(key: string): Promise<string>;
}

// ✅ Pure abstraction
interface IConversationStorage {
  get(conversationId: string): Promise<Message[]>;
  set(conversationId: string, messages: Message[]): Promise<void>;
  delete(conversationId: string): Promise<void>;
  // No implementation details exposed
}
```

### Premature Optimization

```typescript
// ❌ Over-optimized before needed
@Injectable()
export class MessageService {
  // Complex 3-tier cache before proving it's needed
  private l1Cache = new Map();
  private l2Cache: RedisClient;
  private l3Cache: Database;

  async getMessage(id: string) {
    // Complex cache logic...
  }
}

// ✅ Start simple, optimize when needed
@Injectable()
export class MessageService {
  async getMessage(id: string) {
    // Simple implementation first
    return this.database.findById(id);
  }

  // Add cache later when performance becomes an issue
}
```

### Magic Numbers

```typescript
// ❌ Magic numbers
if (messageType === 7) {
  // What is 7?
  // Handle text message
}

// ✅ Named constants
enum MessageType {
  TEXT = 7,
  IMAGE = 3,
  VOICE = 34,
}

if (messageType === MessageType.TEXT) {
  // Clear intent
}
```

---

## Architecture Decision Records (ADR)

### ADR Template

```markdown
# ADR-001: Choose NestJS as Backend Framework

## Context

Need to build an enterprise WeChat intelligent reply service that is modular, scalable, and maintainable.

## Decision

Use NestJS instead of Express/Koa/Fastify.

## Rationale

- ✅ Built-in dependency injection (IoC container)
- ✅ Native TypeScript support
- ✅ Modular architecture (like Spring Boot)
- ✅ Rich ecosystem (Swagger, testing, validation)
- ✅ Best choice for enterprise projects

## Consequences

- Learning curve (decorators, DI concepts)
- Heavier framework (acceptable for enterprise use)

## Status

Accepted
```

---

## Evolution Strategy

### Current State (v1.0)

```
Single Application
- Memory storage
- Synchronous processing
- Single instance
```

### Future State (v1.1+)

```
Scalable Application
- Redis storage
- Message queue (Bull)
- Multiple instances
- Monitoring (Prometheus)
```

### Migration Approach

**Gradual Evolution:**

1. Keep interfaces stable
2. Implement new features behind feature flags
3. Dual-write during migration
4. Validate before full cutover
5. Remove old code only after validation

---

## Best Practices Summary

✅ **DO:**

- Keep services focused (single responsibility)
- Use dependency injection
- Depend on abstractions, not concretions
- Design for testability
- Use feature flags for gradual rollout
- Document architectural decisions (ADRs)

❌ **DON'T:**

- Create god objects
- Hard-code dependencies
- Create circular dependencies
- Over-engineer for unknown future needs
- Expose implementation details in interfaces
- Optimize prematurely

---

**Next Steps:**

- Review [code-standards.md](code-standards.md) for coding conventions
- Check [development-workflow.md](development-workflow.md) for development practices
- See [performance-optimization.md](performance-optimization.md) for performance tuning
