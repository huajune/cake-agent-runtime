---
name: code-standards
role: system
model: sonnet
visibility: global
description: >
  TypeScript编码规范、NestJS最佳实践、Prettier与ESLint风格约束。
  编写或修改代码时必须遵循本文档。

tags:
  - coding-style
  - typescript
  - nestjs
  - prettier
  - eslint

priority: high
---

# Code Standards & Best Practices

> **Complete reference manual** for TypeScript, NestJS, and code style conventions
>
> **FOR HUMAN DEVELOPERS**: Detailed examples and explanations
> **FOR AI AGENTS**: See [code-quality-guardian.md](code-quality-guardian.md) for enforcement checklist

**Last Updated**: 2026-11-04
**Applies To**: All TypeScript/NestJS code in this project
**Project**: Cake Agent Runtime

---

## 📋 Table of Contents

- [TypeScript Standards](#typescript-standards)
- [Protocol Contracts and Refactor Completion](#protocol-contracts-and-refactor-completion)
- [NestJS Best Practices](#nestjs-best-practices)
- [Code Style & Formatting](#code-style--formatting)
- [Naming Conventions](#naming-conventions)
- [File Organization](#file-organization)
- [Error Handling](#error-handling)
- [LLM Guardrail Standards](#llm-guardrail-standards)
- [Forbidden Practices](#forbidden-practices)

---

## TypeScript Standards

### Type Safety

```typescript
// ❌ NEVER use 'any'
function process(data: any): any {
  return data.value;
}

// ✅ Use specific types
interface ProcessData {
  value: string;
  timestamp: number;
}

function process(data: ProcessData): string {
  return data.value;
}

// ✅ Use generics when needed
function process<T>(data: T): T {
  return data;
}

// ✅ Use 'unknown' if truly uncertain
function process(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'value' in data) {
    return (data as ProcessData).value;
  }
  throw new Error('Invalid data');
}
```

### Interfaces vs Type Aliases

```typescript
// ✅ Use interface for object shapes
interface User {
  id: string;
  name: string;
  email: string;
}

// ✅ Derive closed protocol types from their runtime definition
const REVIEW_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];

// ✅ Use type for unions, intersections
type Result = Success | Error;

// ✅ Extend interfaces
interface AdminUser extends User {
  permissions: string[];
}
```

### Function Types

```typescript
// ✅ Always specify parameter and return types
async function sendMessage(token: string, content: string, toWxid: string): Promise<SendResult> {
  // implementation
}

// ✅ Optional parameters
function fetchData(
  id: string,
  options?: {
    timeout?: number;
    retry?: boolean;
  },
): Promise<Data> {
  // implementation
}

// ✅ Destructured parameters with types
async function process({
  token,
  content,
  toWxid,
}: {
  token: string;
  content: string;
  toWxid: string;
}): Promise<Result> {
  // implementation
}
```

---

## Protocol Contracts and Refactor Completion

适用于新增或修改协议、状态机、工具契约、队列、恢复和兼容逻辑。2026-11-04 用户要求将本次运行时改造的教训纳入后续编码与自审；以下是实施要求，不表示存量代码已全部通过审计。

### 唯一定义与领域归属

1. **封闭值域必须有运行时定义。** 状态、模式、动作类别、协议操作、门禁标识和受控原因码由所属领域统一提供 `enum` 或 `as const` 对象。优先沿用该领域风格；类型从同一对象派生，不另写一份字符串联合。调用、分支、持久化参数、回调、通知渲染均引用定义，不能只在声明处加类型后继续散写字面量。
2. **编译期与运行时共用值域。** DTO、配置、动态注册、JSON 和外部输入用同一定义构建 schema 或类型守卫；类型断言不等于校验。未知值按契约拒绝或明确保留为 unknown，不能静默当默认成功。数据库保留独立约束，并验证它与应用协议一致。
3. **常量按领域归属，不能按字符串长相归并。** 不同状态机恰好同名的 `pending`、`failed` 等不能互相借用；共享协议放零依赖类型/契约层，不为复用常量制造反向依赖。开放注册键、自由文本、供应商开放值不强行封闭成枚举；边界适配后再进入内部协议。

### 重构范围与兼容收口

4. **修一处必须核查本次改造的同类问题。** 沿“定义 → 写入/调用 → 读取/分支 → 校验 → 恢复/回调 → 日志/通知 → 测试/文档”检查完整调用链，并用检索核对残留。不能只修用户截图所在文件。交付说明须列清覆盖范围和有意保留项及原因；避免全库机械替换把不同语义合并。
5. **符号重构保持线协议不变。** 提取常量不能顺带更改数据库值、JSON、Redis/Lua、队列参数、RPC 操作、事件名、幂等键或请求号。确需改值时单独设计迁移与新旧版本兼容。验证应保留独立的旧协议样本、序列化快照或 SQL fixture，不能让实现和期望值同时引用新常量而掩盖协议漂移。
6. **兼容分支必须有生命周期。** 标明服务的旧数据/旧版本、进入条件和可核验的删除条件；替代实现接管职责时同步回收失效入口、重复分支和过期注释。旧输入、群任务及回滚义务未完结时保留必要适配；禁止把旧 observe 记录升级为 execute 授权。业务时间窗口不是技术兼容垃圾，改变窗口需遵循业务规则维护流程。

### 执行语义与验收依据

7. **分别表达请求受理、外部结果和本地补账。** 按实际接口契约定义成功；普通回复 API 明确受理可继续发送，不额外发明逐段回调门槛。超时/unknown 不等于失败，更不构成重发许可；外部成功后仅补本地状态。原动作、输入归属、回复原文和执行身份须能跨重启保持；并发派发前先取得执行权，回退模式也不能丢弃既有 execute 义务。
8. **重试预算必须解释计数与依据。** 明确 attempts 是否含首次、retries 是否含首次，以及按模型、工具、生成流程还是队列计数；区分推理步骤、参数纠正与网络重试。调参核对触顶样本、业务结局和延迟，不能凭固定数值断言“不影响模型”，也不能用放宽次数绕过动作权限。
9. **验收覆盖真实边界，不制造无关门槛。** 独立审查实现与接口契约；协议值变更检查序列化和持久化兼容，执行/恢复变更覆盖并发、未知结果、补账、重启及回滚。涉及 SQL 事务、索引、权限或 Redis Lua/CAS 时验证实际实现，不能仅凭 mock 通过。缺失普通回复回调、历史 unknown 未清零、没有生产故障样本，不自动判为不合格；无流量、零错误或观察固定时长也不能算通过。不要求在真实候选人上制造故障。

提交前按 [Code Quality Guardian](code-quality-guardian.md#step-3-self-validate) 逐项自查；变更范围、测试证据和未验证部分必须对应最终代码。代码与文档同步，发版说明依据实际用户影响整理，不以行数或最近一个提交代替完整范围。

---

## NestJS Best Practices

### Service Structure

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Message handling service
 * Responsible for processing incoming messages
 */
@Injectable()
export class MessageService {
  // 1. Logger always first
  private readonly logger = new Logger(MessageService.name);

  // 2. Configuration properties
  private readonly apiBaseUrl: string;

  // 3. Constructor with dependency injection
  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: AgentService,
    private readonly senderService: MessageSenderService,
  ) {
    // 4. Initialize configuration in constructor
    this.apiBaseUrl = this.configService.get<string>('API_BASE_URL', 'https://api.example.com');
    this.logger.log('MessageService initialized');
  }

  // 5. Public methods first
  async handleMessage(data: IncomingMessageData): Promise<Result> {
    this.logger.log(`Processing message from ${data.fromUser}`);
    try {
      const result = await this.processInternal(data);
      return { success: true, data: result };
    } catch (error) {
      this.logger.error('Message processing failed:', error);
      throw error;
    }
  }

  // 6. Private methods last
  private async processInternal(data: IncomingMessageData): Promise<any> {
    // implementation
  }
}
```

### Controller Structure

```typescript
import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

/**
 * Message controller
 * Handles HTTP requests for message operations
 */
@Controller('messages')
@ApiTags('消息管理')
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  /**
   * Receive incoming message webhook
   */
  @Post()
  @ApiOperation({ summary: '接收消息回调' })
  @ApiResponse({ status: 200, description: '处理成功' })
  @ApiResponse({ status: 400, description: '参数错误' })
  async receiveMessage(@Body() dto: IncomingMessageDto) {
    return this.messageService.handleMessage(dto);
  }

  /**
   * Get message list
   */
  @Get()
  @ApiOperation({ summary: '获取消息列表' })
  async getMessages(@Query('page') page: number = 1) {
    return this.messageService.getMessages(page);
  }
}
```

### Module Structure

```typescript
import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [AgentModule], // Dependencies
  controllers: [MessageController], // Controllers
  providers: [MessageService], // Services
  exports: [MessageService], // Exported services
})
export class MessageModule {}
```

### DTO Structure

```typescript
import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for sending messages
 */
export class SendMessageDto {
  @ApiProperty({ description: '小组Token', example: 'token_123' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ description: '消息内容', example: '你好' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({ description: '接收者ID', example: 'wxid_123' })
  @IsString()
  @IsNotEmpty()
  toWxid: string;

  @ApiPropertyOptional({ description: '消息类型', enum: MessageType })
  @IsEnum(MessageType)
  @IsOptional()
  msgType?: MessageType = MessageType.TEXT;
}

enum MessageType {
  TEXT = 1,
  IMAGE = 3,
  VOICE = 34,
}
```

### Logger Usage

```typescript
// ✅ Correct logging
this.logger.log('Normal operation');
this.logger.log(`User action: ${userId}`);
this.logger.log('Complex object:', JSON.stringify(data, null, 2));
this.logger.warn('Warning message');
this.logger.error('Error occurred:', error.stack || error);
this.logger.debug('Debug info (dev only)');

// ❌ NEVER use console
console.log('Do not use console.log'); // FORBIDDEN
```

### Async/Await Patterns

```typescript
// ✅ Use async/await
async fetchData(id: string): Promise<Data> {
  try {
    const result = await this.httpService.get(`/api/data/${id}`);
    return result.data;
  } catch (error) {
    this.logger.error('Failed to fetch data:', error);
    throw new HttpException(
      'Data fetch failed',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

// ❌ Avoid .then/.catch
fetchData(id: string): Promise<Data> {
  return this.httpService
    .get(`/api/data/${id}`)
    .then((result) => result.data)
    .catch((error) => {
      // Not recommended
    });
}
```

---

## Code Style & Formatting

### Prettier Configuration

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "arrowParens": "always"
}
```

### Formatting Examples

```typescript
// ✅ Correct formatting
const data = {
  name: 'test',
  value: 123,
  items: ['a', 'b', 'c'],
};

const result = await this.service.process({
  param1: 'value1',
  param2: 'value2',
  param3: 'value3',
});

// ✅ Long function calls auto-wrap
const response = await this.httpService.post('https://api.example.com/endpoint', {
  token: 'xxx',
  content: 'message',
  type: 1,
});
```

### Import Organization

```typescript
// 1. Node.js built-in modules
import * as path from 'path';
import * as fs from 'fs';

// 2. Third-party dependencies
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// 3. Project internal modules (by layer)
import { ApiConfigService } from '../../core/config';
import { HttpService } from '../../core/http';
import { ConversationService } from '../../common/conversation';

// 4. Current module relative imports
import { CreateMessageDto } from './dto/create-message.dto';
import { MessageType } from './message.types';

// 5. Type imports (optional: last)
import type { AxiosInstance } from 'axios';
```

### Class Member Order

```typescript
@Injectable()
export class ExampleService {
  // 1. Static properties
  static readonly VERSION = '1.0.0';

  // 2. Instance properties (private readonly first)
  private readonly logger = new Logger(ExampleService.name);
  private readonly config: Config;

  // 3. Instance properties (private)
  private cache = new Map<string, any>();

  // 4. Constructor
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.config = this.loadConfig();
  }

  // 5. Lifecycle hooks (if any)
  onModuleInit() {
    this.logger.log('Module initialized');
  }

  // 6. Public methods
  async publicMethod(): Promise<Result> {
    // implementation
  }

  // 7. Protected methods
  protected protectedMethod(): void {
    // implementation
  }

  // 8. Private methods
  private privateMethod(): void {
    // implementation
  }
}
```

---

## Naming Conventions

### File Naming

```bash
# ✅ Use kebab-case
agent.service.ts
message-sender.service.ts
create-message.dto.ts
agent-profile.interface.ts

# ❌ Wrong
AgentService.ts          # Don't use PascalCase
agent_service.ts         # Don't use snake_case
agentService.ts          # Don't use camelCase
```

### Class & Interface Naming

```typescript
// ✅ PascalCase
class AgentService {}
class MessageSenderService {}
interface IAgentProfile {}
interface CreateMessageDto {}
enum MessageType {}

// ❌ Wrong
class agentService {} // Don't use camelCase
class agent_service {} // Don't use snake_case
```

### Variable & Function Naming

```typescript
// ✅ camelCase
const apiKey = 'xxx';
const maxRetryCount = 3;
const isEnabled = true;

function sendMessage() {}
function getUserById() {}
async function processData() {}

// ❌ Wrong
const api_key = 'xxx'; // Don't use snake_case
const MaxRetryCount = 3; // Don't use PascalCase
function SendMessage() {} // Don't use PascalCase
```

### Constant Naming

```typescript
// ✅ UPPER_SNAKE_CASE
const API_TIMEOUT = 30000;
const MAX_RETRY_COUNT = 3;
const DEFAULT_PAGE_SIZE = 20;

// ✅ Enum values
enum MessageType {
  TEXT = 1,
  IMAGE = 3,
  VOICE = 34,
}
```

---

## File Organization

### Module Structure

```
feature-module/
├── feature.module.ts        # Module definition (required)
├── feature.service.ts       # Business logic (required)
├── feature.controller.ts    # API endpoints (if exposing APIs)
├── dto/                     # Data transfer objects
│   ├── create-feature.dto.ts
│   └── update-feature.dto.ts
├── interfaces/              # Type definitions
│   └── feature.interface.ts
└── feature.types.ts         # Enums and constants
```

### Barrel Exports

```typescript
// index.ts - Export public API
export * from './feature.module';
export * from './feature.service';
export * from './dto';
export * from './interfaces';
```

---

## Error Handling

### Exception Handling

```typescript
import { HttpException, HttpStatus } from '@nestjs/common';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// ✅ Use NestJS built-in exceptions
throw new HttpException('Resource not found', HttpStatus.NOT_FOUND);
throw new NotFoundException('User does not exist');
throw new BadRequestException('Invalid parameters');

// ✅ Service-level error handling pattern
async processData(id: string): Promise<Result> {
  try {
    const data = await this.fetchData(id);
    return { success: true, data };
  } catch (error) {
    this.logger.error('Failed to process data:', error);

    if (error.response?.status === 404) {
      throw new NotFoundException('Data not found');
    }

    throw new HttpException(
      'Processing failed',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
```

---

## LLM Guardrail Standards

### Open-language verdict freeze (P11)

- Do not add a new regex or keyword branch that interprets open natural language and then rejects,
  overwrites, or marks a candidate fact missing.
- A proposed open-language detector must first run as a shadow diff with reviewable observations;
  enforcement requires a separate, data-backed decision.
- Deterministic verdict sites are limited to `structural_gate`, `closed_form`, `notary`, and `hint`,
  and must be registered in `VERDICT_SITE_REGISTRY`.

### Prompt example discipline

- Any new fictional person name, store name, or phone number shown to the model must come from
  `src/agent/guardrail/prompt/example-registry.ts`.
- Prefer real runtime values or placeholders (`X`, `Y`, `N`, `A`, `B`) when an example does not need
  a concrete canary value.
- Do not copy the placeholder phone list; the prompt registry reuses
  `@resolution/candidate/phone` as its single source.

## Forbidden Practices

### Absolutely Forbidden

```typescript
// ❌ NEVER hardcode sensitive information
const apiKey = 'sk-1234567890abcdef'; // FORBIDDEN
const password = 'admin123'; // FORBIDDEN

// ✅ Use environment variables
const apiKey = this.configService.get<string>('API_KEY');

// ❌ NEVER use console.log
console.log('debug info'); // FORBIDDEN

// ✅ Use Logger
this.logger.log('debug info');

// ❌ NEVER instantiate dependencies directly
class MyService {
  private otherService = new OtherService(); // FORBIDDEN
}

// ✅ Use dependency injection
@Injectable()
class MyService {
  constructor(private readonly otherService: OtherService) {}
}

// ❌ NEVER abuse 'any' type
function process(data: any): any {
  // FORBIDDEN
  return data;
}

// ✅ Use specific types
function process(data: ProcessData): Result {
  return { success: true, data };
}
```

### Strongly Discouraged

```typescript
// ⚠️ Avoid synchronous blocking operations
const data = fs.readFileSync('file.txt'); // Discouraged

// ✅ Use async operations
const data = await fs.promises.readFile('file.txt');

// ⚠️ Avoid overly long functions (>50 lines)
async function processMessage(data) {
  // 100 lines of code...  // Discouraged
}

// ✅ Split into smaller functions
async function processMessage(data) {
  const parsed = this.parseData(data);
  const validated = this.validateData(parsed);
  const result = await this.process(validated);
  return this.formatResult(result);
}
```

---

## Code Comments

### Documentation Comments

```typescript
/**
 * Message sender service
 * Handles sending messages via the hosting platform API
 */
@Injectable()
export class MessageSenderService {
  /**
   * Send a single message
   *
   * @param dto - Message data
   * @returns Send result
   * @throws HttpException when send fails
   */
  async sendMessage(dto: SendMessageDto): Promise<SendResult> {
    // implementation
  }
}
```

### Inline Comments

```typescript
// ✅ Explain complex logic
// Skip messages from the bot itself to avoid infinite loops
if (isSelf) {
  return;
}

// Limit message history to prevent memory overflow
if (messages.length > this.maxMessagesPerConversation) {
  messages = messages.slice(-this.maxMessagesPerConversation);
}

// ❌ Don't comment obvious code
// Create variable
const name = 'test'; // Unnecessary

// Call function
this.service.process(); // Unnecessary
```

### TODO Comments

```typescript
// TODO: Migrate to Redis storage
// TODO: Add retry mechanism
// FIXME: Fix race condition in concurrent scenarios
// NOTE: This logic depends on specific API behavior
```

---

## Quality Checklist

Before committing code, verify:

- [ ] Code compiles without errors
- [ ] No TypeScript 'any' types (unless justified)
- [ ] All functions have type annotations
- [ ] Proper error handling with try-catch
- [ ] Logger used (no console.log)
- [ ] Code formatted with Prettier
- [ ] ESLint passes with no warnings
- [ ] Meaningful variable/function names
- [ ] Comments explain WHY, not WHAT
- [ ] No sensitive information in code
- [ ] No new open-language regex verdict branch without a shadow-diff decision
- [ ] New fictional prompt values come from `prompt/example-registry.ts`
- [ ] Protocol changes satisfy [Protocol Contracts and Refactor Completion](#protocol-contracts-and-refactor-completion) and the linked self-review checklist

---

## 🔗 Related Documents

- **[code-quality-guardian.md](code-quality-guardian.md)** - AI agent quality enforcement checklist
- **[architecture-principles.md](architecture-principles.md)** - System design patterns and SOLID principles
- **[development-workflow.md](development-workflow.md)** - Git workflow and testing practices

---

**Document Purpose**: This is the **authoritative reference** for all coding standards. For quick enforcement checklists, see [code-quality-guardian.md](code-quality-guardian.md).
