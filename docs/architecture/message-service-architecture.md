# 企微消息服务架构

**最后更新**：2026-04-23

---

## 📖 相关文档

本文档说明 **企业微信消息从回调接入到 Agent 回复投递** 的完整处理流程与架构设计。
Agent 内部运行时（Recall / Compose / Execute / Store）详见 [agent-runtime-architecture.md](./agent-runtime-architecture.md)。

---

## 目录

- [1. 架构概述](#1-架构概述)
- [2. 模块目录与服务清单](#2-模块目录与服务清单)
- [3. 消息处理流程](#3-消息处理流程)
- [4. Debounce 聚合机制](#4-debounce-聚合机制)
- [5. Replay 与副作用保护](#5-replay-与副作用保护)
- [6. 运行时配置与并发控制](#6-运行时配置与并发控制)
- [7. 关键设计约束](#7-关键设计约束)

---

## 1. 架构概述

### 1.1 分层视图

```
企业微信托管平台（Stride Callback）
        ↓  POST /message
┌─────────────────────────────────────────────────────────┐
│ Ingress 层                                              │
│   MessageIngressController                              │
│   MessageCallbackAdapterService (小组级 / 企业级归一化)  │
└───────────────────────┬─────────────────────────────────┘
                        ↓  立即 ACK + 微任务接管
┌─────────────────────────────────────────────────────────┐
│ Application 层（业务管线）                                │
│   MessageService  → MessagePipelineService               │
│     ├─ AcceptInboundMessageService (过滤/去重/写历史)    │
│     ├─ PreAgentRiskInterceptService (前置风险预检)       │
│     ├─ ReplyWorkflowService (Agent 调用 + Replay)        │
│     ├─ ImageDescriptionService (图片同步描述回写)         │
│     └─ MessageProcessingFailureService (失败兜底)         │
└───────────────────────┬─────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ Runtime 层（调度 / 去重 / 配置）                          │
│   SimpleMergeService      (debounce 聚合：Redis + Bull)   │
│   MessageProcessor        (Bull Worker + per-chat 锁)     │
│   MessageDeduplicationService (Redis SET NX EX)          │
│   MessageRuntimeConfigService (hosting_config 快照)      │
│   MessageWorkerManagerService (并发数动态调整)            │
└───────────────────────┬─────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ Delivery 层                                              │
│   MessageDeliveryService  (分段发送 + 打字延迟)           │
│   TypingPolicyService     (段落间隔 / 每字符速率策略)     │
└─────────────────────────────────────────────────────────┘

横切：Telemetry 层
   WecomMessageObservabilityService (链路观测 / trace 持久化)
   MessageTraceStoreService
```

### 1.2 核心设计点

| 关注点 | 现状 | 背景 |
| --- | --- | --- |
| **同步 ACK** | HTTP 立即返回 200，所有处理推到微任务 | 托管平台回调超时会按"超时补发"规则重发（曾出现同一消息被补发 3 次） |
| **聚合策略** | **Debounce**：每条消息注册 `delay=静默窗口` 的 Bull job，Worker 触发时校验是否静默够久 | 旧实现是 `IDLE → WAITING → PROCESSING` 状态机，复杂度高、竞态难控 |
| **去重存储** | Redis `SET NX EX`（TTL 5 min） | 旧实现基于内存 Map，多实例部署会漏去重 |
| **阻塞保护** | `advance_stage` / `invite_to_group` / `duliday_interview_booking` 命中后跳过 replay，直接投递首次回复 | 这三类工具会产生不可逆外部副作用（DB 写、群邀请、外部预约） |
| **per-chat 串行** | Redis 处理锁（`wecom:message:lock:{chatId}`）+ per-chat jobId 幂等 | Bull 并发 Worker 之间可能撞同一个会话，锁保证同一会话同时只有一个 Agent 生成 |

---

## 2. 模块目录与服务清单

```
src/channels/wecom/message/
├── message.module.ts
├── message.service.ts                    # 入口协调器（240 行）
├── ingress/
│   ├── message-ingress.controller.ts     # POST /message 接入点
│   ├── message-ops.controller.ts         # 运维 API
│   ├── message-callback.dto.ts           # 企微回调 DTO
│   ├── message-callback.schema.ts
│   └── callback-adapter.service.ts       # 小组级/企业级回调归一化
├── application/
│   ├── pipeline.service.ts               # 管线编排（仅委托）
│   ├── accept-inbound-message.service.ts # 过滤 → 去重 → 写历史 → 图片预处理
│   ├── reply-workflow.service.ts         # Agent 调用 + Replay 重跑（650 行，核心）
│   ├── filter.service.ts                 # 过滤规则聚合入口
│   ├── filter-rules/message-filter.rules.ts # 8 条规则实现
│   ├── image-description.service.ts      # 非视觉模型下图片同步描述回写
│   ├── pre-agent-risk-intercept.service.ts # 自杀/自残/举报等高置信关键词预检
│   └── message-processing-failure.service.ts # 失败告警 + 降级回复
├── runtime/
│   ├── simple-merge.service.ts           # debounce 聚合（234 行，核心）
│   ├── message.processor.ts              # Bull Worker + per-chat 锁（294 行）
│   ├── deduplication.service.ts          # Redis 原子去重
│   ├── message-runtime-config.service.ts # hosting_config 运行时快照
│   ├── message-worker-manager.service.ts # 并发 slot semaphore
│   └── redis-key.util.ts                 # wecom:message:{type}:{id} 命名规范
├── delivery/
│   ├── delivery.service.ts               # 分段发送 + 失败聚合
│   └── typing-policy.service.ts          # 速率/段落间隔/是否分段
├── telemetry/
│   ├── wecom-message-observability.service.ts  # 阶段打点（660 行）
│   └── message-trace-store.service.ts    # trace 持久化
├── types/
│   ├── index.ts
│   ├── merge.types.ts
│   ├── message.types.ts
│   └── storage-message.types.ts
└── utils/
    ├── message-parser.util.ts
    ├── message-splitter.util.ts
    ├── reply-normalizer.util.ts
    ├── message-sanitizer.util.ts
    └── log-sanitizer.util.ts
```

### 2.1 服务职责速览

| 服务 | 职责 | 关键方法 |
| --- | --- | --- |
| [`MessageService`](../../src/channels/wecom/message/message.service.ts) | 立即 ACK + 分派入口；基于运行时开关决定「聚合 or 直发」 | `handleMessage`, `processMergedMessages` |
| [`MessagePipelineService`](../../src/channels/wecom/message/application/pipeline.service.ts) | 管线薄壳，转发给 `AcceptInboundMessageService` / `ReplyWorkflowService` | `execute`, `processMergedMessages` |
| [`AcceptInboundMessageService`](../../src/channels/wecom/message/application/accept-inbound-message.service.ts) | 自发消息归档、过滤、去重、写历史、图片预处理 | `execute` |
| [`ReplyWorkflowService`](../../src/channels/wecom/message/application/reply-workflow.service.ts) | 调 Agent、replay 重跑、投递回复、失败告警 | `processSingleMessage`, `processMergedMessages`, `callAgent` |
| [`SimpleMergeService`](../../src/channels/wecom/message/runtime/simple-merge.service.ts) | 把消息写入 Redis List + 每条消息注册一个 debounce job | `addMessage`, `getAndClearPendingMessages`, `checkAndProcessNewMessages` |
| [`MessageProcessor`](../../src/channels/wecom/message/runtime/message.processor.ts) | Bull Worker，校验静默窗口 → 取消息 → 调 pipeline → 检查新消息 | `handleProcessJob` |
| [`MessageDeduplicationService`](../../src/channels/wecom/message/runtime/deduplication.service.ts) | Redis `SET NX EX`（默认 TTL 300s）原子标记，支持多实例 | `isMessageProcessedAsync`, `markMessageAsProcessedAsync` |
| [`MessageFilterService`](../../src/channels/wecom/message/application/filter.service.ts) | 按顺序执行 8 条过滤规则，返回第一条命中的结果 | `validate` |
| [`MessageDeliveryService`](../../src/channels/wecom/message/delivery/delivery.service.ts) | 单条 or 分段发送；为每段计算打字延迟；失败抛 `DeliveryFailureError` | `deliverReply` |
| [`PreAgentRiskInterceptService`](../../src/channels/wecom/message/application/pre-agent-risk-intercept.service.ts) | 高置信度风险关键词预检 → 同步暂停托管 + 告警，但不短路 Agent | `precheck` |
| [`MessageRuntimeConfigService`](../../src/channels/wecom/message/runtime/message-runtime-config.service.ts) | `hosting_config` 30s 拉取一次快照；暴露 aiReply/merge/typing/模型选择 | `syncSnapshot`, `getMergeDelayMs`, `resolveWecomChatModelSelection` |
| [`MessageWorkerManagerService`](../../src/channels/wecom/message/runtime/message-worker-manager.service.ts) | `currentConcurrency` semaphore（默认 4，上限 20） | `acquireExecutionSlot`, `setConcurrency` |
| [`WecomMessageObservabilityService`](../../src/channels/wecom/message/telemetry/wecom-message-observability.service.ts) | 请求 trace 从回调入口贯穿到投递完成的阶段打点 | `startRequestTrace`, `markWorkerStart`, `markAiStart`, `markDeliveryEnd` |

### 2.2 过滤规则（8 条，按顺序评估）

位置：[src/channels/wecom/message/application/filter-rules/message-filter.rules.ts](../../src/channels/wecom/message/application/filter-rules/message-filter.rules.ts)

| 顺序 | 规则 | 命中结果 |
| --- | --- | --- |
| 1 | `SelfMessageFilterRule` | 机器人自发消息 → 走 `handleSelfMessage` 归档 |
| 2 | `SourceMessageFilterRule` | 非手机推送来源 |
| 3 | `ContactTypeFilterRule` | 非用户联系人（客服、系统账号等） |
| 4 | `PausedUserFilterRule` | 托管已暂停该用户 |
| 5 | `GroupBlacklistFilterRule` | 群聊黑名单 |
| 6 | `RoomMessageFilterRule` | 群聊消息策略（仅白名单/@触发） |
| 7 | `SupportedMessageTypeFilterRule` | 不支持的消息类型 |
| 8 | `EmptyContentFilterRule` | 空内容（仅有提示、引用等） |

命中规则可能返回三种终态：`pass=false`（直接忽略）、`historyOnly=true`（只写历史不触发 AI）、或通过进入后续流程。

---

## 3. 消息处理流程

### 3.1 端到端链路

```
1. Ingress
   POST /message
   → MessageCallbackAdapterService.normalizeCallback()
   → MessageService.handleMessage()
   → 同步返回 { success: true }
   → 微任务进入 processMessageAsync

2. Runtime Config 同步
   → MessageRuntimeConfigService.syncSnapshot()   // 30s 节流

3. Application Pipeline
   → MessagePipelineService.execute()
     └─ AcceptInboundMessageService.execute():
         ├─ handleSelfMessage (isSelf=true)
         ├─ MessageFilterService.validate()
         ├─ MessageDeduplicationService.isMessageProcessedAsync()
         ├─ startRequestTrace (telemetry)
         ├─ recordUserMessageToHistory (异步写 Supabase + Redis 短期窗口)
         └─ prepareImageIfNeeded (非视觉模型下同步调用 vision)

4. 全局 AI 开关判断
   → runtimeConfig.isAiReplyEnabled()
   → 关闭：记 success metadata + markProcessed，返回
   → 开启：继续

5. 分派
   → isMessageMergeEnabled() === true
     → SimpleMergeService.addMessage():
         a. RPUSH wecom:message:pending:{chatId}
         b. SETEX wecom:message:last-message-at:{chatId}
         c. bull.add('process', { chatId }, { delay: mergeDelayMs, jobId: `{chatId}:{messageId}` })
   → false
     → ReplyWorkflowService.processSingleMessage (直接调用)

6. Bull Worker (MessageProcessor.handleProcessJob)
   a. workerManager.acquireExecutionSlot()            // 并发 semaphore
   b. simpleMergeService.acquireProcessingLock()      // per-chat 锁 (SET NX EX 300s)
   c. simpleMergeService.isQuietWindowElapsed()       // 距最后一条消息是否静默够久
      ├─ 否 → 跳过，等后续消息的 job 接力
      └─ 是 → 继续
   d. simpleMergeService.getAndClearPendingMessages() // LRANGE + LTRIM（只裁掉本次读到的）
   e. ReplyWorkflowService.processMergedMessages()
   f. simpleMergeService.checkAndProcessNewMessages() // 生成期间又收到消息 → 补建 follow-up job
   g. 释放锁 + 释放 slot

7. Agent 调用与 Replay（详见第 5 节）
   → AgentRunnerService.invoke(...)
   → 检查 pending list：
       ├─ 非空 & 未命中阻塞工具 → 丢弃首次回复，合并新消息重跑一次
       └─ 其它 → 采用首次回复

8. Delivery
   → MessageDeliveryService.deliverReply()
     ├─ TypingPolicyService.shouldSplit() → 单条 or 分段
     └─ 每段 sleep(calculateDelay) → messageSenderService.sendMessage()

9. 观测落盘
   → recordSuccess / recordFailure → message_processing_records
   → markMessagesAsProcessed (去重写入 Redis)
```

### 3.2 同步 ACK 的实现细节

```typescript
// MessageService.handleMessage
handleMessage(messageData: EnterpriseMessageCallbackDto) {
  messageData._receivedAtMs = messageData._receivedAtMs ?? Date.now();

  // 立即返回 200，所有 Supabase/Redis/外部调用都进微任务
  void this.processMessageAsync(messageData).catch((error) => {
    this.logger.error(`[异步消息处理] messageId=${messageData.messageId} 失败: ${error}`);
  });

  return { success: true, message: 'Message received' };
}
```

所有同步打点保持轻量；任何抛错被 `.catch` 兜底，不会影响已经给托管平台的 200 响应。

---

## 4. Debounce 聚合机制

聚合目标不再是「窗口收齐 N 条就发」，而是「用户停止打字后再触发 Agent」。

### 4.1 核心思路

1. 每条新消息都 `RPUSH` 到 `wecom:message:pending:{chatId}`。
2. 每条新消息都单独创建一个 `delay = mergeDelayMs` 的 Bull job（jobId 含 messageId，天然幂等）。
3. 记录 `wecom:message:last-message-at:{chatId}`。
4. Worker 被触发时先比对 `now - lastMessageAt >= mergeDelayMs`：
   - 不满足：说明用户又打了新字，本 job 跳过；后续消息注册的 job 会接力检查。
   - 满足：原子 `LRANGE + LTRIM` 取出全部待处理消息，进入处理流程。

```
用户          Redis List (pending)     Bull Delayed Jobs        Worker 动作
────────────────────────────────────────────────────────────────────────────
t=0  "在吗"  → [M1]                    job#M1 @t=2s              (等待 delay)
t=0.5 "有"   → [M1, M2]                job#M2 @t=2.5s            -
t=1  "岗位"  → [M1, M2, M3]            job#M3 @t=3.0s            -
t=2  -        [M1, M2, M3]             job#M1 触发               now-last=1s < 2s，跳过
t=2.5 -       [M1, M2, M3]             job#M2 触发               now-last=1.5s < 2s，跳过
t=3  -        [M1, M2, M3]             job#M3 触发               now-last=2.0s ≥ 2s，执行
                                                                 LRANGE+LTRIM → 3 条
                                                                 调 Agent
```

用户持续打字 → 持续推迟处理，静默窗口内堆多少消息都行，不再需要「最大聚合数」上限。

### 4.2 Agent 执行期间的新消息

Bull Worker 在调 Agent 时仍持有 `per-chat 处理锁`，但消息回调路径不受锁影响，会继续往 pending list 里追加。

```
t=3 取出 [M1,M2,M3]  → Agent 生成中（~5s）
t=5 用户 "急"        → pending list 变成 [M4]（不在本轮 Agent 输入里）
t=8 Agent 生成完毕
    → ReplyWorkflowService.fetchPendingSinceAgentStart(chatId)
        LRANGE+LTRIM → [M4]
    → 走 Replay：丢弃首次回复，把 M4 合进 userMessage 重跑
    → 否则：采纳首次回复，并由 SimpleMergeService.checkAndProcessNewMessages
             按"距最后一条消息的静默窗口"补建 follow-up job（最少 200ms，jobId 用 followup:{now} 避免冲突）
```

### 4.3 关键参数

| 参数 | 存储位置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **静默窗口** `mergeDelayMs` | Supabase `hosting_config.initialMergeWindowMs` | 2000 ms（fallback 2s） | 由 Dashboard 动态调整；每次 `syncSnapshot` 读取 |
| **Pending List TTL** | `SimpleMergeService.PENDING_TTL_SECONDS` | 300 s | 兜底防止 job 丢失时消息永远滞留 |
| **处理锁 TTL** | `SimpleMergeService.PROCESSING_LOCK_TTL_SECONDS` | 300 s | 长于单轮 Agent 最坏耗时，防止锁提前过期导致并发生成 |
| **Follow-up 最小延迟** | `QUIET_WINDOW_FOLLOWUP_DELAY_MS` | 200 ms | 静默窗口已满时，避免 0ms job 打满队列 |
| **去重 TTL** | `MESSAGE_DEDUP_TTL_SECONDS` | 300 s | Redis `SET NX EX`，多实例共享 |

> 旧实现中「首次等待窗口 + 最大聚合数」的参数（`INITIAL_MERGE_WINDOW_MS` / `MAX_MERGED_MESSAGES`）已全部废弃。

### 4.4 Worker 并发控制

`MessageProcessor` 注册时用 `registrationConcurrency = 20`（上限），运行时真正能执行的 job 数受 `MessageWorkerManagerService.currentConcurrency`（默认 4，`hosting_config.workerConcurrency` 动态覆盖）控制——超出的 job 在 `acquireExecutionSlot()` 处等待。

> 为什么不直接按 `currentConcurrency` 注册？Bull 会按注册并发数去拉 delayed job；如果按 4 注册，4 个 slot 被长 Agent 占满后，后到的 delayed job 即使到期也取不出来，造成延迟堆积。用「高注册并发 + 应用层 semaphore」的组合可以既限制真正执行的 job 数，又保证 delayed job 能被及时调度。

同一 `chatId` 的并发由 `acquireProcessingLock` 兜底：后来的 job 拿不到锁就直接 return，依赖 Bull retry 或后续 job 接力。

---

## 5. Replay 与副作用保护

### 5.1 为什么需要 Replay

聚合窗口永远不可能完全覆盖用户打字节奏：

- Agent 已经开始生成后，用户又补了一句关键信息（"工资能不能日结"）。
- 如果不处理，用户会感觉机器人没听到；如果每次都重跑，响应时间失控。

`ReplyWorkflowService.processMessageCore()` 的策略：

1. 首次 `callAgent({ deferTurnEnd: true })`：Agent 生成完不立刻触发 turn-end（记忆写入、事实提取）副作用。
2. `fetchPendingSinceAgentStart(chatId)` 原子取出「Agent 执行期间到达的新消息」。
3. **如果有新消息**：丢弃首次回复 + 丢弃首次 `runTurnEnd` → 把新消息合进 `userMessage` → 第二次 `callAgent`（`deferTurnEnd` 默认 false，turn-end 正常触发）。
4. **如果没新消息**：显式触发首次 `runTurnEnd`（fire-and-forget），采纳首次回复。

只允许重跑一次——第二次生成期间再来的消息由投递后的 follow-up job 处理，避免无限重跑。

### 5.2 不可逆副作用工具

有三类工具一旦在首次 Agent 调用中被命中，**即使后面有新消息也不能丢弃首次回复**：

```typescript
const REPLAY_BLOCKING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'advance_stage',              // procedural memory 直写 currentStage
  'invite_to_group',            // 企微级别 addMember 外部 API + session facts 写 invitedGroups
  'duliday_interview_booking',  // 杜力岱外部预约 API + recruitment_cases 建行
]);
```

这些副作用已经落在外部系统/DB 上，若 replay 把回复丢了会造成严重错乱：
- 阶段推进但 Agent 二次生成以为还在前一阶段；
- 群邀请已发但没解释；
- 面试已预约但二次生成重复尝试。

命中后的处理：
- 跳过 `fetchPendingSinceAgentStart` 的 replay 判定；
- 显式触发首次 `runTurnEnd`；
- 直接投递首次回复；
- Agent 生成期间到达的消息留在 pending list，由 `checkAndProcessNewMessages` 补建 follow-up job 独立处理。

### 5.3 前置风险预检

位置：[pre-agent-risk-intercept.service.ts](../../src/channels/wecom/message/application/pre-agent-risk-intercept.service.ts)

在进入 `callAgent` 前同步跑高置信度关键词检测（自杀/自残/投诉举报等）：

- 命中：**同步**执行「暂停托管 + 飞书告警」副作用，并在 log 里记录。
- 但**不短路** Agent——安抚回复仍由 Agent 以招募者身份自主生成，避免任何预设话术暴露机器人/托管身份。

---

## 6. 运行时配置与并发控制

### 6.1 配置分层

| 层 | 来源 | 变更方式 | 包含项 |
| --- | --- | --- | --- |
| 环境变量 | `.env.local` / `.env.production` | 重启生效 | `ENABLE_AI_REPLY`（默认 true）、`ENABLE_MESSAGE_MERGE`（默认 true）、`MESSAGE_DEDUP_TTL_SECONDS` |
| 托管配置 | Supabase `hosting_config` 表 | Dashboard 实时 / 30s 快照同步 | `initialMergeWindowMs`、`typingSpeedCharsPerSec`、`paragraphGapMs`、`workerConcurrency`、`wecomCallbackModelId`、`wecomCallbackThinkingMode` |
| 硬编码 | Service constructor | 代码变更 | Pending TTL、处理锁 TTL、follow-up 最小延迟 |

`MessageRuntimeConfigService` 在回调入口调用 `syncSnapshot()`（30s 节流）；聚合 Worker 在取消息前也会再 `syncSnapshot()`，保证分钟级的配置生效时延。

### 6.2 Redis Key 命名

统一前缀 `wecom:message:`（`RedisKeyBuilder`），环境隔离由 `RedisService.withPrefix` 注入 `{RUNTIME_ENV|NODE_ENV}:`：

| Key | 内容 | TTL |
| --- | --- | --- |
| `wecom:message:dedup:{messageId}` | 消息已处理标记 | 300 s |
| `wecom:message:pending:{chatId}` | 待处理消息列表（RPUSH/LRANGE/LTRIM） | 300 s |
| `wecom:message:last-message-at:{chatId}` | 最后一条消息到达毫秒时间戳 | 300 s |
| `wecom:message:lock:{chatId}` | 处理锁（per-chat 串行） | 300 s |
| `wecom:message:trace:{messageId}` | 请求 trace 上下文 | 见 observability |
| `wecom:message:history:{chatId}` | 预留 | - |

### 6.3 并发模型

```
Bull registration concurrency = 20（固定，注册上限）
MessageWorkerManagerService.currentConcurrency = 4（hosting_config.workerConcurrency，可动态改）

handleProcessJob:
  await acquireExecutionSlot()          // 应用层 semaphore，控制真正在跑的 job
  lockAcquired = await acquireProcessingLock(chatId, owner)
  if (!lockAcquired) return             // 同一 chatId 已有 job 在跑，让它去处理
  if (!isQuietWindowElapsed(chatId)) return  // 用户还在打字，本 job 无事可做
  ... 正常执行 ...
  finally: releaseProcessingLock + releaseExecutionSlot
```

---

## 7. 关键设计约束

| 约束 | 原因 |
| --- | --- |
| **必须立即 ACK** | 托管平台超时会按"超时"规则补发同内容消息，曾出现同一"六姐"被补发 3 次的流水 |
| **历史写入异步** | `chat_messages` INSERT + Redis 短期窗口总计 500ms-2s，同步写会阻塞 PreDispatch；Agent 在 ≥mergeDelay 静默窗口后才读历史，异步写有充裕时间完成，失败降级为下一轮看不到本轮 user 消息 |
| **阻塞工具跳过 replay** | `advance_stage` / `invite_to_group` / `duliday_interview_booking` 已对外部系统产生不可逆副作用，丢弃回复会导致用户视角错乱 |
| **单次 replay 上限** | 防止"用户一直打字 → Agent 一直重跑"的活锁；第二次生成期间的新消息由 follow-up job 独立处理 |
| **pending list 只裁本次读取** | Worker 消费期间新到的消息必须保留；`LTRIM(key, len, -1)` 精准丢弃本次读走的那段 |
| **per-chat 锁 TTL 300s** | 必须长于单轮 Agent 最坏耗时，锁过早过期会导致同会话并发生成，记忆投影错乱 |
| **图片在非视觉模型下同步描述** | 若用异步描述，Agent 调用时拿到的 content 可能是空的 `[IMAGE]` 占位，产生幻觉 |

---

## 附：文件行数基准

截至 2026-04-23：

| 文件 | 行数 |
| --- | --- |
| `application/reply-workflow.service.ts` | 650 |
| `telemetry/wecom-message-observability.service.ts` | 660 |
| `ingress/message-callback.dto.ts` | 475 |
| `application/message-processing-failure.service.ts` | 381 |
| `runtime/message.processor.ts` | 294 |
| `ingress/callback-adapter.service.ts` | 294 |
| `application/accept-inbound-message.service.ts` | 265 |
| `message.service.ts` | 240 |
| `runtime/simple-merge.service.ts` | 234 |
| `delivery/delivery.service.ts` | 215 |
| `runtime/message-runtime-config.service.ts` | 183 |
| `application/image-description.service.ts` | 172 |
| `runtime/message-worker-manager.service.ts` | 132 |
| `runtime/deduplication.service.ts` | 119 |
| `application/pre-agent-risk-intercept.service.ts` | 119 |
| `application/filter.service.ts` | 89 |
| `runtime/redis-key.util.ts` | 59 |
| `application/pipeline.service.ts` | 57 |
| `delivery/typing-policy.service.ts` | 52 |
