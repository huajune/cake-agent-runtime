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

**Last Updated**: 2025-11-05 16:35:00
**Applies To**: All TypeScript/NestJS code in this project
**Project**: DuLiDay WeChat Service

---

## 📋 Table of Contents

- [TypeScript Standards](#typescript-standards)
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

// ✅ Use type for unions, intersections
type Status = 'pending' | 'approved' | 'rejected';
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

---

## 🔗 Related Documents

- **[code-quality-guardian.md](code-quality-guardian.md)** - AI agent quality enforcement checklist
- **[architecture-principles.md](architecture-principles.md)** - System design patterns and SOLID principles
- **[development-workflow.md](development-workflow.md)** - Git workflow and testing practices

---

**Document Purpose**: This is the **authoritative reference** for all coding standards. For quick enforcement checklists, see [code-quality-guardian.md](code-quality-guardian.md).
