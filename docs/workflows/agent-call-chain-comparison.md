# Agent 调用链路对比

本文档对比系统中四种 Agent 调用场景的完整链路差异。

## 核心设计要点

### callerKind：调用方身份的显式声明

`AgentInvokeParams.callerKind`（`CallerKind` 枚举，必填）用于替代早期基于 `userMessage !== undefined` / `corpId === 'test' | 'debug'` 的隐式分叉。agent / memory 层据此决定是否加载短期记忆、默认 strategySource 等行为。

| callerKind | 含义 | 对应本文场景 |
|---|---|---|
| `WECOM` | 企微生产链路，只传本轮 userMessage，历史由 memory 加载 | 生产链路 |
| `DEBUG` | Controller 调试端点（`/agent/debug-chat`），直传 messages[]，默认 `strategySource: 'testing'` | 对话调试 |
| `TEST_SUITE` | 测试套件链路，直传 messages[]，`strategySource` 可由调用方指定（`testing` 或 `released` 联调） | 用例测试 / 回归验证 |

`callerKind` 与 `strategySource` **正交**：test-suite 可通过 `strategySource: 'released'` 跑联调模式。

### userId + sessionId：会话记忆的组合 key

Agent 端使用 `userId + sessionId` 作为会话级记忆的组合 key。两者**缺一不可**，否则 Agent 无法正确管理上下文记忆。

- **userId**：标识"谁在对话"，Agent 可据此查询该用户的候选人岗位、面试等业务数据
- **sessionId**：标识"哪次对话"，同一用户可能同时有多个会话
- **组合 key**：`userId + sessionId` 唯一确定一个会话记忆空间，不同组合互不干扰

`OrchestratorService.run()` 作为最后一道防线，缺少任一字段直接抛出 400 错误。

### userId/sessionId 各场景来源

| 场景 | userId 来源 | sessionId 来源 | 唯一性保障 |
|------|------------|---------------|-----------|
| **生产链路** | `imContactId`（微信联系人 ID） | `chatId`（微信会话 ID，跨消息复用） | 平台保障 |
| **对话调试** | `'dashboard-test-user'`（前端硬编码） | `crypto.randomUUID()`（清空聊天时重置） | UUID 保障 |
| **用例测试** | `scenario-test-${batchId}`（自动生成） | `test-${caseId}`（自动生成） | batchId + caseId 组合保障 |
| **回归验证** | `source.participant_name`（飞书对话数据） | `source.conversation_id`（飞书对话数据） | 飞书数据保障 |

**用例测试设计说明**：userId 按批次自动生成，同批次各 case 的 sessionId（`test-${caseId}`）各不相同，组合 key 天然唯一。不同批次 batchId 不同，因此跨批次也不会互相污染。

### Extended Thinking：测试场景统一开启

所有 3 种测试场景（对话调试、用例测试、回归验证）均默认开启 extended thinking（`budgetTokens: 10000`），用于回归测试时查看模型思考过程。生产链路不启用 thinking，避免增加延迟和 token 消耗。

| 场景 | thinking 配置 | 来源 |
|------|-------------|------|
| **生产链路** | 未启用 | — |
| **对话调试** | `{ type: 'enabled', budgetTokens: 10000 }` | 前端 `useChatTest.ts` 传入 |
| **用例测试** | `{ type: 'enabled', budgetTokens: 10000 }` | `DEFAULT_TEST_THINKING` 常量兜底 |
| **回归验证** | `{ type: 'enabled', budgetTokens: 10000 }` | `DEFAULT_TEST_THINKING` 常量兜底 |

### 必填校验：三层防线

1. **调用方层**：Processor 自动生成 / 前端传入 / 飞书数据提取
2. **Service 层**：`executeTest()` / `executeTurn()` 校验 userId 非空，否则 throw Error
3. **Facade 层**：`prepareRequestParams()` 校验 userId + sessionId 非空，否则 throw HttpException(400)

## 四种场景概览

| 场景 | 页面/入口 | 用途 |
|------|----------|------|
| 生产链路 | 微信回调 → `/wecom/message` | 真实用户对话，自动回复 |
| 对话调试 | `/dashboard/agent-test` | 单条对话调试，实时流式 |
| 用例测试 | `/dashboard/test-suite` Tab1 | 批量场景用例测试 + 评审 |
| 回归验证 | `/dashboard/test-suite` Tab2 | 多轮回归验证 + 相似度评分 |

## 完整对比表

| 维度 | 生产链路 (WeChat) | 对话调试 (agent-test) | 用例测试 (test-suite Tab1) | 回归验证 (test-suite Tab2) |
|------|-------------------|----------------------|--------------------------|--------------------------|
| **callerKind** | `WECOM` | `DEBUG` | `TEST_SUITE` | `TEST_SUITE` |
| **触发方式** | 微信用户发消息 | 手动输入 + 发送 | quick-create → Bull Queue | conversations/:id/execute |
| **调度机制** | SimpleMergeService (2s聚合) | 无，直接请求 | TestSuiteProcessor (并发3) | 同步逐轮执行 |
| **后端接口** | `/wecom/message` (回调) | `POST /test-suite/chat/ai-stream` | `POST /test-suite/chat` (内部调用) | 内部调用 agentFacade |
| **流式/非流式** | 非流式 `stream: false` | **流式 `stream: true`** | 非流式 `stream: false` | 非流式 `stream: false` |
| **Agent 调用** | `agentFacade.chatWithScenario()` | `agentFacade.chatStreamWithScenario()` | `agentFacade.chatWithScenario()` | `agentFacade.chatWithScenario()` |
| **Vercel AI SDK** | `generateText / streamText` |`POST /api/v1/chat` (stream) | `POST /api/v1/chat` | `POST /api/v1/chat` |
| **userId** | `imContactId` (真实微信ID) | `'dashboard-test-user'` (硬编码) | `scenario-test-${batchId}` (自动生成) | `source.participant_name` (飞书数据) |
| **sessionId** | `chatId` (微信会话ID，复用) | `crypto.randomUUID()` (清空时重置) | `test-${caseId}` (自动生成) | `source.conversation_id` (飞书数据) |
| **thinking** | 未启用 | **启用** (budgetTokens: 10000) | **启用** (DEFAULT_TEST_THINKING) | **启用** (DEFAULT_TEST_THINKING) |
| **history 来源** | Redis (最多60条, TTL 2h) | useChat 自动管理 (内存) | 飞书用例自带, `slice(0,-2)` | 按轮次逐步累积 |
| **history 截断** | 无需 (Redis 已限制) | `skipHistoryTrim: true` (不截断) | `slice(0, -2)` 去最后一轮 | 无需 |
| **systemPrompt** | Profile + StrategyConfig | 同左 | 同左 | 同左 |
| **消息聚合** | 有 (2s窗口, 最多5条) | 无 | 无 | 无 |
| **回复处理** | 分段 + 打字延迟 → 微信发送 | SSE 透传 → 前端实时渲染 | 存 Supabase 执行记录 | 存 Supabase + 计算相似度 |
| **保存记录** | 不保存到 test_executions | `saveExecution: false` | `saveExecution: false` (Queue中更新) | 保存到 test_executions |
| **错误处理** | fallback 消息 + 飞书告警 | 前端 toast 展示错误 | 标记 FAILURE 状态 | 标记失败 + errorMessage |

## 调用链路详情

### 1. 生产链路 (WeChat)

```
微信用户发消息
  → 托管平台回调 → POST /wecom/message
  → MessageController.receiveMessage()  (立即返回 200)
  → MessageService.handleMessage()
      ├── 过滤 (自身消息/类型/黑名单)
      ├── 去重 (Redis)
      ├── 记录历史 (Redis)
      └── dispatchMessage()
           ├── [聚合模式] SimpleMergeService.addMessage()
           │     → Redis List 暂存 + Bull Queue 延迟任务 (2s)
           │     → MessageProcessor.handleProcessJob()
           │       → processMessageCore()
           └── [直接模式] processSingleMessage()
                 → processMessageCore()
                      ├── historyService.getHistoryForContext() (Redis)
                      ├── agentGateway.invoke()
                      │     → agentFacade.chatWithScenario()
                      │       → prepareRequestParams()
                      │         → context: { userId: imContactId, sessionId: chatId }
                      │       → agentService.chat() (stream: false)
                      │         → orchestrator.run() → Vercel AI SDK generateText
                      ├── deliveryService.deliverReply()
                      │     → MessageSplitter 分段
                      │     → 打字延迟
                      │     → messageSenderService.sendMessage() → 托管平台 API
                      └── 标记已处理 + 监控打点
```

### 2. 对话调试 (agent-test)

```
用户在 ChatTester 输入消息
  → useChat hook (DefaultChatTransport)
      body: { userId: 'dashboard-test-user', chatId: UUID, thinking: { type: 'enabled', budgetTokens: 10000 } }
  → POST /test-suite/chat/ai-stream
  → TestSuiteController.testChatAIStream()
      ├── 解析 UIMessage → TestChatRequestDto { userId, chatId, thinking }
      ├── VercelAIStreamHandler.flushSSEHeaders() (立即flush)
      ├── testService.executeTestStreamWithMeta()
      │     → 校验 userId 非空 ✅
      │     → TestExecutionService.executeTestStreamWithMeta()
      │       → agentFacade.chatStreamWithScenario()
      │         → prepareRequestParams()
      │           → context: { userId: 'dashboard-test-user', sessionId: UUID }
      │         → agentService.chatStreamWithProfile()
      │           → agentService.chatStream() (stream: true, thinking: enabled)
      │             → orchestrator.run() → Vercel AI SDK streamText
      ├── stream.on('data') → VercelAIStreamHandler.processChunk()
      │     → 透传 chunk + 提取 tokenUsage
      └── stream.on('end') → sendUsageAndEnd()
            → 前端 useChat 实时渲染 MessagePartsAdapter
```

### 3. 用例测试 (test-suite Tab1)

```
用户点击"一键创建"
  → POST /test-suite/batches/quick-create
  → TestSuiteService.quickCreateBatch()
      ├── 从飞书导入测试用例
      ├── 创建批次 + 执行记录 (Supabase)
      └── TestSuiteProcessor.addBatchTestJobs() → Bull Queue
            → handleTestJob() (并发3)
              → 自动生成: userId = `scenario-test-${batchId}`
              → 自动生成: chatId = `test-${caseId}`
              → testSuiteService.executeTest({ userId, chatId, ... })
                → 校验 userId 非空 ✅
                → TestExecutionService.executeTest()
                  ├── history.slice(0, -2) (去掉最后一轮)
                  ├── ScenarioOptions { userId, thinking: DEFAULT_TEST_THINKING }
                  ├── agentFacade.chatWithScenario()
                  │     → prepareRequestParams()
                  │       → context: { userId: 'scenario-test-{batchId}', sessionId: 'test-{caseId}' }
                  │     → agentService.chat() (stream: false, thinking: enabled)
                  │       → orchestrator.run() → Vercel AI SDK generateText
                  ├── extractResult() (文本/工具/token)
                  └── 更新执行记录 (Supabase)
            → checkBatchCompletion()
              → 更新批次统计 + 状态 → reviewing
```

### 4. 回归验证 (test-suite Tab2)

```
用户点击"执行回归验证"
  → POST /test-suite/conversations/:sourceId/execute
  → ConversationTestService.executeConversation()
      → 获取对话源 (含 participant_name, conversation_id)
      → 拆解对话为测试轮次
      → 逐轮执行:
          ├── userId = source.participant_name, 校验非空 ✅
          ├── sessionId = source.conversation_id
          ├── 构建当前轮 history (前几轮的 user+assistant)
          ├── ScenarioOptions { userId, thinking: DEFAULT_TEST_THINKING }
          ├── agentFacade.chatWithScenario()
          │     → prepareRequestParams()
          │       → context: { userId: '张三', sessionId: 'conv-xxx' }
          │     → agentService.chat() (stream: false, thinking: enabled)
          │       → orchestrator.run() → Vercel AI SDK generateText
          ├── LLM 评估相似度 (actualOutput vs expectedOutput)
          └── 保存轮次执行记录 (Supabase)
      → 更新对话源统计 (平均/最低相似度)
      → 更新批次统计
```

## 关键差异点

### 1. 流式 vs 非流式

只有**对话调试**走流式（`chatStreamWithScenario`），其他三种都走非流式（`chatWithScenario`）。原因：对话调试需要实时渲染思考块、工具调用等中间状态；生产和批量测试只需最终结果。

### 2. sessionId 连续性

| 场景 | sessionId | 会话记忆 |
|------|-----------|---------|
| 生产 | 微信 chatId (跨消息复用) | 有，Agent 端维护会话上下文 |
| 对话调试 | UUID (清空时重置) | 有，同一会话内连续 |
| 用例测试 | `test-${caseId}` | 无，每个 case 独立 |
| 回归验证 | `source.conversation_id` | 无，依赖手动构建 history |

### 3. 消息聚合

仅生产链路有消息聚合（SimpleMergeService），2s 窗口内最多合并 5 条消息为一次 Agent 调用。测试场景均为一对一调用。

## 相关代码位置

| 模块 | 路径 |
|------|------|
| 生产入口 | `src/channels/wecom/message/message.controller.ts` |
| 生产管道 | `src/channels/wecom/message/services/message-pipeline.service.ts` |
| 生产 Agent 网关 | `src/channels/wecom/message/services/message-agent-gateway.service.ts` |
| 消息聚合 | `src/channels/wecom/message/services/simple-merge.service.ts` |
| 消息投递 | `src/channels/wecom/message/services/message-delivery.service.ts` |
| 测试控制器 | `src/biz/test-suite/test-suite.controller.ts` |
| 测试执行 | `src/biz/test-suite/services/test-execution.service.ts` |
| 批次处理 | `src/biz/test-suite/test-suite.processor.ts` |
| 回归验证 | `src/biz/test-suite/services/conversation-test.service.ts` |
| Agent 编排 | `src/agent/services/orchestrator.service.ts` |
| SSE 流处理 | `src/biz/test-suite/utils/sse-stream-handler.ts` |
| 前端对话调试 | `web/src/view/agent-test/list/hooks/useChatTest.ts` |
| 前端测试套件 | `web/src/view/test-suite/list/index.tsx` |
