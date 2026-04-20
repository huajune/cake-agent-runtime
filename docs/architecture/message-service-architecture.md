# 消息服务架构文档

---

## 📖 相关文档

本文档说明**企业微信消息的处理流程和架构设计**。

---

## 目录
- [1. 架构概述](#1-架构概述)
- [2. 核心服务](#2-核心服务)
- [3. 消息处理流程](#3-消息处理流程)
- [4. 智能消息聚合](#4-智能消息聚合)

---

## 1. 架构概述

### 1.1 三层架构

```
企业微信服务器 (回调通知)
        ↓
应用层: MessageController (HTTP 接收)
        ↓
业务层: MessageService (协调器) + 5 个子服务
        ↓
基础层: AgentModule | MessageSender | Bull Queue
```

### 1.2 文件结构

```
src/channels/wecom/message/
├── message.service.ts                   # 核心协调服务（643行）
├── message.processor.ts                 # Bull 队列处理器
├── services/
│   ├── message-filter.service.ts        # 消息过滤验证（129行）
│   ├── message-deduplication.service.ts # 消息去重（108行）
│   ├── message-history.service.ts       # 消息历史管理（234行）
│   ├── message-merge.service.ts         # 智能消息聚合（516行）★
│   └── message-statistics.service.ts    # 统计监控
└── dto/message-callback.dto.ts          # 企微回调数据结构
```

---

## 2. 核心服务

### 2.1 MessageService (协调器)

**位置**: [src/channels/wecom/message/message.service.ts](../src/channels/wecom/message/message.service.ts)
**角色**: 核心协调者

#### 核心职责
1. **流程编排** - 协调 5 个子服务的调用顺序
2. **异常处理** - 捕获并处理各环节的异常
3. **异步控制** - 确保企微回调快速返回（< 100ms）

#### 关键方法
```typescript
async handleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void>
private async processMessages(messages: EnterpriseMessageCallbackDto[], chatId: string): Promise<void>
```

---

### 2.2 MessageFilterService (过滤验证)

**位置**: [src/channels/wecom/message/services/message-filter.service.ts](../src/channels/wecom/message/services/message-filter.service.ts)

#### 5级过滤规则

| 级别 | 规则 | 原因 |
|------|------|------|
| Level 1 | 非文本消息 | 暂不支持图片/文件 |
| Level 2 | 机器人自己发送 | 避免循环回复 |
| Level 3 | 黑名单群聊 | 未授权的群聊 |
| Level 4 | 未在白名单 | 仅处理特定群聊 |
| Level 5 | 缺少触发词 | 群聊中需要 @机器人 |

---

### 2.3 MessageDeduplicationService (去重)

**位置**: [src/channels/wecom/message/services/message-deduplication.service.ts](../src/channels/wecom/message/services/message-deduplication.service.ts)

#### 去重策略
- **数据结构**: `Map<messageId, timestamp>`
- **TTL**: 5 分钟内重复视为去重
- **容量管理**: LRU 策略，最大 10,000 条
- **性能**: O(1) 查询，定期清理过期记录

```typescript
isDuplicate(messageId: string): boolean {
  const existingTimestamp = this.messageCache.get(messageId);
  if (existingTimestamp && (Date.now() - existingTimestamp) < this.ttl) {
    return true; // 重复消息
  }
  this.messageCache.set(messageId, Date.now());
  return false;
}
```

---

### 2.4 MessageHistoryService (历史管理)

**位置**: [src/channels/wecom/message/services/message-history.service.ts](../src/channels/wecom/message/services/message-history.service.ts)

#### 核心职责
1. **历史存储** - 按 chatId 分组存储消息历史
2. **自动裁剪** - 只保留最近 N 条消息（默认 20 条）
3. **格式转换** - 将企微消息转换为 Agent API 格式
4. **AI 标记** - 标记哪些回复是 AI 生成的

#### 数据结构
```typescript
private readonly conversationHistory = new Map<string, Message[]>();

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  messageId: string;
  isAiGenerated?: boolean;
}
```

#### 关键方法
```typescript
addUserMessage(chatId: string, message: Message): void
addAssistantMessage(chatId: string, content: string): void
getHistory(chatId: string): Message[]
```

---

### 2.5 MessageMergeService (智能聚合) ★★★

**位置**: [src/channels/wecom/message/services/message-merge.service.ts](../src/channels/wecom/message/services/message-merge.service.ts)
**重要性**: ⭐⭐⭐⭐⭐ (最核心)

#### 核心职责
1. **消息聚合** - 智能合并用户快速连发的消息
2. **状态机管理** - 三阶段状态转换 (IDLE → WAITING → PROCESSING)
3. **异步收集** - 在 Agent 处理期间继续收集新消息
4. **智能重试** - Agent 响应后检查是否有新消息需要重新处理

#### 三阶段状态转换

```
     ┌──────┐
     │ IDLE │ (空闲)
     └───┬──┘
         │ 收到消息
         ↓
   ┌──────────┐
   │ WAITING  │ (等待聚合，1秒窗口)
   └────┬─────┘
        │ 定时器到期 或 达到3条
        ↓
 ┌─────────────┐
 │ PROCESSING  │ (Agent处理中，~5秒)
 └──────┬──────┘
        │ Agent响应完成
        ↓
    ┌───────┐
    │ 检查  │ 有新消息？
    └───┬───┘
        │
   是   ↓      否
   重试(1次) → 发送回复 → IDLE
```

#### 核心数据结构

```typescript
interface ConversationState {
  chatId: string;
  status: ConversationStatus; // IDLE | WAITING | PROCESSING
  firstMessageTime: number;
  pendingMessages: PendingMessage[];
  currentRequest?: {
    startTime: number;
    retryCount: number;
    messageCount: number;
  };
  initialTimer?: NodeJS.Timeout;
}
```

#### 配置参数

| 参数 | 配置位置 | 默认值 | 说明 |
|------|---------|--------|------|
| **静默窗口** | Supabase `hosting_config.initialMergeWindowMs` | `3000` | 距最后一条消息静默多久后才触发 Agent（debounce 窗口，毫秒） |
| **最大重试次数** | `MAX_RETRY_COUNT`（硬编码） | `1` | Agent 响应后最多重试次数 |
| **最小消息长度** | `MIN_MESSAGE_LENGTH_TO_RETRY`（硬编码） | `2` | 触发重试的最小消息长度 |

> 早期设计使用「首次等待窗口 + 最大聚合数」的固定窗口方案；现已改为 debounce：每条消息注册 `delay=静默窗口` 的 Bull job，Worker 触发时校验"距最后一条消息是否静默够久"——不够则跳过，让后续消息注册的 job 接力。用户持续打字则持续推迟处理，不再需要条数上限。

#### 重试策略

```typescript
async onAgentResponseReceived(chatId: string, processor: MessageProcessor): Promise<boolean> {
  const state = this.conversations.get(chatId);

  // 检查重试条件
  if (state.pendingMessages.length === 0) return false;
  if (state.currentRequest.retryCount >= this.maxRetryCount) return false;

  const validMessages = state.pendingMessages.filter(
    (pm) => MessageParser.extractContent(pm.messageData).length >= 2
  );

  if (validMessages.length === 0) return false;

  // 重新处理
  await this.processMessages(state, processor);
  return true;
}
```

---

## 3. 消息处理流程

### 3.1 完整处理链路

```
1. 接收企微回调 (MessageController)
   POST /message/callback
        ↓
2. AI 回复检查 (MessageService)
   检查是否启用 AI 自动回复
        ↓
3. 消息过滤 (MessageFilterService)
   5 级过滤规则
        ↓
4. 消息去重 (MessageDeduplicationService)
   检查 messageId 是否在 5 分钟内重复
        ↓
5. 消息聚合 (MessageMergeService)
   根据当前状态处理消息（IDLE/WAITING/PROCESSING）
        ↓
6. 异步处理 (MessageService.processMessages)
   合并消息 → 获取历史 → 调用 Agent API → 更新历史
        ↓
7. 响应后检查 (MessageMergeService)
   检查是否有新消息 → 决定是否重试
        ↓
8. 发送回复 (MessageSenderService)
   调用企微 API 发送消息
        ↓
9. 清理状态 (MessageMergeService)
   重置会话状态为 IDLE
```

### 3.2 异步处理保证

#### HTTP 快速返回
```typescript
// MessageController.ts
@Post('callback')
async handleCallback(@Body() dto: EnterpriseMessageCallbackDto) {
  // 异步处理，不阻塞响应
  this.messageService.handleMessage(dto).catch((error) => {
    this.logger.error('消息处理异步失败:', error);
  });

  // 立即返回 200 OK（< 100ms）
  return { success: true };
}
```

---

## 4. 智能消息聚合

### 4.1 设计目标

**问题**: 用户快速连发多条消息 → 机器人多次回复 → 体验差 + API 成本高

**解决方案**: 智能聚合 + 异步收集 + 有限重试

```
❌ 不聚合:
用户: "有什么" → Agent 回复: "请问您想了解什么？"
用户: "岗位" → Agent 回复: "我们有多个岗位..."
用户: "推荐吗？" → Agent 回复: "可以推荐..."
结果: 3 次 API 调用，3 条回复

✅ 聚合:
用户: "有什么" + "岗位" + "推荐吗？"
→ 聚合 1 秒后调用 Agent: "有什么岗位推荐吗？"
→ Agent 回复: "根据您的情况，推荐以下岗位..."
结果: 1 次 API 调用，1 条回复
```

### 4.2 三阶段聚合策略

#### Phase 1: WAITING (首次聚合)
- 收到第一条消息 → 启动定时器（1秒）
- 收集快速连发的消息（最多3条）
- 定时器到期 或 达到最大数量 → 触发 Phase 2

#### Phase 2: PROCESSING (Agent 处理中)
- 调用 Agent API
- 在等待 Agent 响应期间（~5秒）被动收集新消息到待处理队列
- Agent 响应完成 → 触发 Phase 3

#### Phase 3: 响应后检查
- 检查待处理队列
- 有新消息（且有效）→ 重新请求 Agent（最多1次）
- 无新消息 → 直接发送回复，回到 IDLE

### 4.3 时间线示例

```
单条消息场景:
0s  → 用户发送消息 "你好"，进入 WAITING
1s  → 定时器到期，进入 PROCESSING，调用 Agent
6s  → Agent 响应完成，无新消息，发送回复，回到 IDLE
总耗时: 6 秒 ✅

多条消息场景（有重试）:
0s   → 用户发送 "有什么"，进入 WAITING
0.5s → 用户补充 "岗位"
1s   → 定时器到期，聚合完成（2条），进入 PROCESSING
3s   → 用户补充 "推荐吗？"（Agent 处理中收集）
6s   → Agent 响应完成，检查到 1 条新消息
6s   → 重新请求 Agent（重试 1/1，3条消息）
11s  → Agent 响应完成，无新消息（已达重试上限），发送回复
总耗时: 11 秒 ✅
```

### 4.4 关键设计决策

| 决策 | 原因 |
|------|------|
| **1秒聚合窗口** | 平衡响应速度和聚合效果 |
| **最多聚合3条** | 避免等待时间过长 |
| **最多重试1次** | 控制响应时间，避免无限循环 |
| **最小消息长度2** | 过滤 "嗯"、"好" 等无意义消息 |
| **异步收集** | 充分利用 Agent 处理时间 |

---

## 5. 性能指标

| 指标 | 目标值 | 当前值 |
|------|--------|--------|
| **HTTP 响应时间** | < 100ms | ~50ms |
| **单条消息处理** | < 10s | ~6s |
| **多条消息处理** | < 15s | ~11s |
| **去重查询时间** | < 1ms | O(1) |

---

## 6. 总结

消息处理服务通过**服务化拆分**和**智能聚合**实现了高效的企微消息处理：

| 服务 | 代码量 | 核心职责 |
|------|--------|---------|
| `MessageService` | 643 行 | 流程协调、异常处理 |
| `MessageFilterService` | 129 行 | 5 级过滤规则 |
| `MessageDeduplicationService` | 108 行 | LRU 去重 |
| `MessageHistoryService` | 234 行 | 历史管理、格式转换 |
| **MessageMergeService** | **516 行** | **智能聚合** ⭐ |

总计约 **1,600 行**核心业务代码，实现：
- ✅ 异步非阻塞处理（< 100ms HTTP 响应）
- ✅ 智能消息聚合（节省 API 成本）
- ✅ 完整的去重和历史管理
- ✅ 三阶段状态机（IDLE → WAITING → PROCESSING）
- ✅ 响应后检查和智能重试

---

**最后更新**: 2025-11-04
