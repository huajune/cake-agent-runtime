# Agent 调用链路对比

> 对比生产企微、单条/流式测试、批量用例与多轮回归当前如何进入 Agent。所有链路共享 Preparation 和 Generator，但入口、历史来源、守卫覆盖与 turn-end 责任不同。

## 1. 当前入口

| 场景           | 入口                                              | callerKind   | 主要执行路径                                                  |
| -------------- | ------------------------------------------------- | ------------ | ------------------------------------------------------------- |
| 企微生产       | WeCom callback                                    | `WECOM`      | `ReplyWorkflowService → AgentRunner.runTurn()`                |
| Agent 调试接口 | `POST /agent/debug-chat`                          | `DEBUG`      | `AgentRunner.invokeReviewed()`                                |
| 单条测试       | `POST /test-suite/chat`                           | `TEST_SUITE` | `TestExecutionService.executeTest() → invokeReviewed()`       |
| 流式测试       | `POST /test-suite/chat/stream` / `chat/ai-stream` | `TEST_SUITE` | `TestExecutionService.executeTestStreamWithMeta() → stream()` |
| 批量用例       | test-suite batch / Bull                           | `TEST_SUITE` | 每条调用 `executeTest()`                                      |
| 多轮回归       | conversation execute                              | `TEST_SUITE` | 逐轮 `ConversationTestService.executeTurn() → invoke()`       |

`AgentFacadeService`、`chatWithScenario()` 和旧的 message-agent-gateway 已不在当前链路中。

## 2. 共享的核心

除生产入口前后的渠道编排外，各链路最终都复用：

```text
PreparationService.prepare
  → 两层记忆/fixture 输入
  → conversation normalization
  → snapshot enrichment + 共享事实裁决
  → Prompt sections + tools
GeneratorAgent.invoke / stream
  → 模型多步工具循环（默认最多 5 steps）
AgentRunner.invokeReviewed（非流式审查链）
  → Output Guard
  → 最多一次 ReplyRepairAgent
```

Prompt section 终序、复合 `final-check` 和工具注册规则在所有场景中共用；`callerKind` 只决定历史来源、策略源、图片/外部补料等场景差异。

## 3. 关键差异

| 维度          | 企微生产                                               | 单条/批量测试                            | 流式测试                                                | 多轮回归                     |
| ------------- | ------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| 历史来源      | `MessageWindowService`：7 天、最多 120 条、24,000 字符 | 请求 history + 可选 memory fixture       | 请求 messages，由前端会话维护                           | 数据集逐轮累积的 history     |
| 策略源        | released                                               | 默认 testing，可显式选择                 | testing                                                 | testing                      |
| 模型 fallback | 按生产角色路由                                         | `disableFallbacks: true`，让失败可见     | `disableFallbacks: true`                                | `disableFallbacks: true`     |
| Output Guard  | `runTurn()` 内完整执行                                 | `invokeReviewed()` 完整执行              | stream 只走生成流；适合交互调试，不作为出站守卫验收替代 | 当前 `invoke()` 完整执行审查 |
| Replay        | 有，最多 3 次                                          | 无                                       | 无                                                      | 无                           |
| 投递          | 企微分段与拟人延迟                                     | 返回 JSON / 写测试记录                   | SSE / AI SDK UI stream                                  | 写执行记录并评分             |
| turn-end      | `TurnFinalizer` 按真实投递结局结算                     | 测试服务显式执行并读取 post-turn fixture | stream 完成时由 generator 自触发                        | 每轮显式执行                 |

## 4. 生产链路的额外编排

只有企微生产链路包含：

1. intake 去重、消息历史落库与图片准备；
2. debounce 静默窗口、pending list、chat 级处理锁和 worker 并发槽；
3. `TurnOutcome` 分类、最多 3 次 replay 与最终副作用提交；
4. 分段投递、拟人延迟、托管状态复核；
5. `TurnFinalizer.settle({ delivered })` 与锁释放前等待记忆落盘。

完整时序见 [WeCom 消息处理数据流](./wecom-message-dataflow.md)。

## 5. 测试链的真实性边界

- memory fixture 会先 reset/seed 指定的 `(corpId, userId, sessionId, botUserId)`，运行后再读回状态；它不是生产记忆的复制品。
- 单条测试为图片合成 `imageMessageIds`，确保 `save_image_description` 的注册条件与生产一致。
- 流式测试的首要目标是展示增量文本、工具与 reasoning；需要验证最终守卫 outcome 时应使用非流式单条/批量路径。
- 多轮回归按数据集显式 history 重放，不依赖生产的 7 天消息窗口。
- 测试默认关闭模型 fallback，避免主模型失败被备用模型掩盖；这与生产可用性策略不同。

## 6. 身份与隔离

| 场景          | userId / sessionId                                           |
| ------------- | ------------------------------------------------------------ |
| 企微          | 渠道稳定用户标识 + `chatId`                                  |
| Agent debug   | 请求 userId 或 `debug-user` + 请求 sessionId 或临时 debug id |
| 单条/批量测试 | 必填 userId + 请求 sessionId 或临时 test id                  |
| 多轮回归      | 数据源派生的稳定 test userId + `source.conversation_id`      |

`userId` 不能为空；单条测试和多轮回归都应使用可重复且互不污染的标识。长期档案还包含 `botUserId` 关系维，fixture 涉及长期记忆时必须显式处理这一维。

## 7. 关键代码

| 职责          | 文件                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| 生产主编排    | [reply-workflow.service.ts](../../src/channels/wecom/message/application/reply-workflow.service.ts) |
| Runner        | [agent-runner.service.ts](../../src/agent/runner/agent-runner.service.ts)                           |
| Preparation   | [preparation.service.ts](../../src/agent/generator/preparation/preparation.service.ts)              |
| Generator     | [generator.agent.ts](../../src/agent/generator/generator.agent.ts)                                  |
| 单条/流式测试 | [test-execution.service.ts](../../src/biz/test-suite/services/test-execution.service.ts)            |
| 多轮回归      | [conversation-test.service.ts](../../src/biz/test-suite/services/conversation-test.service.ts)      |
| 测试控制器    | [test-suite.controller.ts](../../src/biz/test-suite/test-suite.controller.ts)                       |
