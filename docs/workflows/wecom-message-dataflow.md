# WeCom 消息处理数据流

> 以"每条消息在各存储位置的状态演化"为视角，梳理 WeCom 路径从入站到落盘的完整数据流。
>
> 涉及模块：[src/channels/wecom/message](../../src/channels/wecom/message)、[src/agent](../../src/agent)、[src/memory](../../src/memory)、[src/biz/monitoring](../../src/biz/monitoring)。

## 涉及的存储位置

| 位置 | 用途 | 关键 key/表 |
|---|---|---|
| **Supabase `chat_messages`** | 长期聊天历史（user/assistant 对话） | by `chatId` |
| **Supabase `message_processing_records`** | 流水 DB，UI「消息处理流水」读的就是它 | by `messageId`（或 `batchId`） |
| **Redis pending list** | debounce 窗口内累积的消息 | `wecom:message:pending:{chatId}` |
| **Redis lastMessageAt** | 本 chat 最后一条消息时间（算静默窗口） | `wecom:message:lastMessageAt:{chatId}` |
| **Redis wecom:trace** | 单条请求的观测快照（timings + agentResult） | `wecom:trace:{messageId}` |
| **Redis session memory** | facts / presentedJobs / currentFocusJob | `memory:session:{corpId}:{userId}:{sessionId}` |
| **Redis 短期消息窗** | Agent 拉历史用的 recent 窗口 | `memory:short:{...}` |
| **Bull queue `message-merge`** | 每条消息一个 delayed job（静默窗口检查） | jobId = `{chatId}:{messageId}` |

## 完整数据流（时序）

### ① Intake：每条入站消息独立做的事

```
WeCom callback → handleMessage → pipelineService.execute
│
├─ 过滤/去重（filterService + deduplicationService）
│  → filter 不过 / 已处理 → 直接 200 OK 返回
│
├─ startRequestTrace(messageId)
│  ├─ 写 Redis trace: acceptedAt
│  └─ 写 DB message_processing_records: status='processing', receivedAt=now
│       ↑ UI「处理中」就是这一行
│
├─ 异步写 chat_messages（role=user）→ markHistoryStored
├─ 异步做图片描述（如有，且模型不支持 vision）→ markImagePrepared
│
└─ simpleMergeService.addMessage
   ├─ RPUSH wecom:message:pending:{chatId}
   ├─ SET wecom:message:lastMessageAt:{chatId} = now
   └─ Queue add delayed job(delay = mergeDelayMs ≈ 3s)
```

### ② Debounce Worker：静默窗口到期后触发

```
message.processor → processMessages
│
├─ acquireProcessingLock(chatId)  ←── per-chat 串行
│  若拿不到 → 其他 worker 正在处理，直接返回
│
├─ isQuietWindowElapsed()  ←── now - lastMessageAt >= mergeDelayMs?
│  不满足 → 跳过；等后续 job 再检查
│
└─ getAndClearPendingMessages(chatId)
   ├─ LRANGE + LTRIM：取出当前所有 pending
   ├─ 生成 batchId = batch_{chatId}_{ts}
   └─ → processMergedMessages(messages, batchId)
```

### ③ 聚合阶段：建 batch trace + 回收源记录

```
reply-workflow.processMergedMessages
│
├─ content = buildMergedRequestContent(messages)  // "消息1\n消息2\n..."
├─ traceId = batchId  ←── 从这里起所有观测以 batch 为单位
│
├─ startRequestTrace(batchId)
│  → 又写了一条 processing 行（但 messageId=batchId）
│
├─ mergePrepTimingsFromSources(batchId, sourceMessageIds)
│  ├─ 合并源 trace 的 timings 到 batch trace（取 max）
│  ├─ 删除源 Redis trace
│  └─ dropMergedSourceRecords → DELETE FROM message_processing_records
│       ↑ ① 里每条 intake 写的 processing 行被回收
│
└─ markWorkerStart(batchId) → processMessageCore
```

### ④ Agent 调用（首次，`deferTurnEnd=true`）

```
callAgent → runner.invoke
│
├─ preparation.prepare
│  ├─ trailingUserContent(messages)  // 末尾连续 user 合并
│  ├─ memory.onTurnStart → 拉四层记忆 + 做高置信事实识别
│  ├─ normalizeConversation → AI SDK ModelMessage[]（注入图片/emotion）
│  ├─ resolveStage + context.compose → finalPrompt
│  └─ toolRegistry.buildForScenario → tools
│
├─ markAiStart(batchId) / recordAgentRequest
├─ llm.generate (stopWhen: maxSteps / skip_reply)
├─ recordAgentResult / markAiEnd
│
└─ 返回 AgentRunResult + runTurnEnd()（未触发）
    ↑ 因为 deferTurnEnd=true，lifecycle 写入被搁置
```

### ⑤ Replay 检测

```
fetchPendingSinceAgentStart(chatId)
│
├─ 无新消息：
│  ├─ await agentResult.runTurnEnd()  // fire-and-forget 触发 lifecycle
│  └─ 进入 ⑥ 投递
│
└─ 有新消息（Agent 生成期间用户又发了）：
   ├─ agentResult.runTurnEnd = undefined  // 彻底丢弃首次的记忆副作用
   ├─ allMessages = [...本轮, ...新消息]
   ├─ mergePrepTimingsFromSources(batchId, newMsgIds)
   │    ↑ 清理新消息的 processing 孤儿行
   ├─ 重新 callAgent（deferTurnEnd 默认 false）
   │    ↑ runner 内部自动 dispatchTurnEndLifecycle
   └─ 进入 ⑥ 投递
```

### ⑥ 投递 & 终态

```
deliveryService.deliverReply
│
├─ markDeliveryStart → 分段发送 → markFirstSegmentSent → markDeliveryEnd
│
├─ skip_reply 分支：markReplySkipped（跳过发送但仍计流水）
│
├─ buildSuccessMetadata(batchId)
│  ├─ 从 Redis trace 里拉 agentResult + timings
│  └─ 清理 Redis trace
│
├─ monitoringService.recordSuccess(batchId, metadata)
│  └─ UPSERT message_processing_records：status='success' + tokens + duration
│       ↑ UI「成功」行最终形态
│
└─ markMessagesAsProcessed([所有 messageIds])  // dedup 标记
```

### ⑦ Turn-end lifecycle（由 ⑤ 触发，fire-and-forget）

```
memory.onTurnEnd
│
├─ 投射到 session memory:
│  ├─ projectAssistantTurn → presentedJobs / currentFocusJob
│  ├─ extractAndSave → facts
│  └─ storeActivity → lastSessionActiveAt
│
├─ 达到沉淀阈值 → settlement: session → long-term profile
│
└─ 写 post_processing_status（UI 右侧流水能看到）
```

### ⑧ assistant 消息写入 chat_messages

> **不是主流程写的！** Agent 回复发出去后，WeCom 会回调 `isSelf=true` 的消息，
> 由 `accept-inbound-message.handleSelfMessage` 把 assistant 内容写入 `chat_messages`。

## 几个容易踩坑的点

### 1. 两种 `messageId` 语义

- Intake 时的 DB 行以**入站 `messageId`** 为 key
- Batch trace 的 DB 行以 **`batchId`** 为 key

合并路径下，前者应该被清理、只留后者。「处理中」孤儿就是前者没清干净的表现。

### 2. turn-end lifecycle 是 fire-and-forget

一旦被触发，就会把 `assistantText` 投影到 session 记忆。这是为什么 **replay 必须在丢弃首次回复时同时阻止 lifecycle 触发**（通过 `deferTurnEnd=true` + 丢弃 `runTurnEnd`）。

### 3. `chat_messages` 的 assistant 写入不走主流程

是发送成功后 WeCom 回调 `isSelf=true` 触发的。如果发送失败（或 skip_reply），`chat_messages` 里就不会有这条 assistant 记录。

### 4. `currentUserMessage` 的语义演变

- 旧：最后一条 user（依赖上层合并）
- 新：末尾连续 user 块 `\n` 合并（上层合不合并都对）

实现：[`trailingUserContent`](../../src/agent/agent-preparation.service.ts)。

### 5. Replay 最多一次

第二次 Agent 生成期间又来消息**不会再 replay**，会交给 `checkAndProcessNewMessages` 补建的 follow-up job，下一轮处理。

### 6. 每条消息都会生成一个 delayed job

Bull 的 `jobId = {chatId}:{messageId}`，去重保证同 messageId 只会有一个 job。真正决定处不处理的是 `isQuietWindowElapsed` + 处理锁，**不是**「第几个 job」。

## 关键代码位置

| 阶段 | 文件 |
|---|---|
| Intake | [`src/channels/wecom/message/application/accept-inbound-message.service.ts`](../../src/channels/wecom/message/application/accept-inbound-message.service.ts) |
| 聚合调度 | [`src/channels/wecom/message/runtime/simple-merge.service.ts`](../../src/channels/wecom/message/runtime/simple-merge.service.ts) |
| Worker | [`src/channels/wecom/message/runtime/message.processor.ts`](../../src/channels/wecom/message/runtime/message.processor.ts) |
| 主编排（含 replay） | [`src/channels/wecom/message/application/reply-workflow.service.ts`](../../src/channels/wecom/message/application/reply-workflow.service.ts) |
| 观测 trace | [`src/channels/wecom/message/telemetry/wecom-message-observability.service.ts`](../../src/channels/wecom/message/telemetry/wecom-message-observability.service.ts) |
| Agent runner（`deferTurnEnd`） | [`src/agent/runner.service.ts`](../../src/agent/runner.service.ts) |
| Agent 预备（`trailingUserContent`） | [`src/agent/agent-preparation.service.ts`](../../src/agent/agent-preparation.service.ts) |
| 流水写入 | [`src/biz/monitoring/services/tracking/message-tracking.service.ts`](../../src/biz/monitoring/services/tracking/message-tracking.service.ts) |
| 记忆 lifecycle | [`src/memory/services/memory-lifecycle.service.ts`](../../src/memory/services/memory-lifecycle.service.ts) |
