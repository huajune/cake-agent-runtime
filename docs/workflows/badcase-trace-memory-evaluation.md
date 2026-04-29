# BadCase Trace 与记忆评测改造说明

使用时间：2026-04-29 起

## 目标

这次改造要把 BadCase 从“人工描述的问题样本”升级成可排障、可复现、可回归、可评测记忆能力的正式证据链。

核心要求：

- 生产新提交的 BadCase / GoodCase 必须带 `chatId / messageId / traceId / sourceTrace` 等排障字段。
- 从 BadCase 策展出的 `测试集 / 验证集` 必须保留来源链路，并补齐 `memorySetup / memoryAssertions`。
- 测试执行时必须隔离测试记忆、跑完 turn-end，并保存 `executionTrace / memoryTrace`。
- 存量策展数据要回填缺失字段，回填后重新导入、重新跑测试。

## 14 个任务清单

1. 为 `test_executions` 增加 `source_trace / execution_trace / memory_setup / memory_assertions / memory_trace`。
2. 为 `test_conversation_snapshots` 增加 `source_trace / memory_setup / memory_assertions`。
3. 导入测试集时解析 Feishu 的来源字段、`SourceTrace`、`MemorySetup`、`MemoryAssertions`。
4. 导入验证集时解析同一套来源字段与记忆字段。
5. 策展写回 Feishu 时输出来源 ID、排障 JSON、记忆 JSON。
6. 测试执行前用 `MemoryFixtureService` 重置并种入测试记忆。
7. 测试执行时使用独立 `userId / sessionId / messageId`，避免污染生产记忆。
8. 测试执行后显式跑 turn-end，并保存执行 trace 和记忆 trace。
9. 对话验证每个 conversation 使用独立测试 session，并逐 turn 保存 trace。
10. 批量执行与重跑链路透传 `sourceTrace / memorySetup / memoryAssertions`。
11. 生产反馈提交链路补齐 `messageId / traceId / sourceTrace`，并写入 BadCase / GoodCase 表。
12. 前端反馈入口上报现有处理流水上下文，不要求 Agent 主链路做破坏性改造。
13. 存量 BadCase 策展 payload 用脚本回填排障字段与记忆 fixture 草案。
14. 回填后重新策展、重新导入、重新跑测试，并用覆盖率报告拦截字段缺失。

## 字段契约

### sourceTrace

`sourceTrace` 是排障证据链，至少应尽量包含：

```json
{
  "badcaseIds": ["xd75o9py"],
  "badcaseRecordIds": ["recvhY6viWlIh4"],
  "chatIds": ["69e9ddb6536c96540229922e"],
  "anchorMessageIds": ["43b5a957364863cf2a61ddcbe7988b5e"],
  "relatedMessageIds": [],
  "messageProcessingIds": [],
  "traceIds": [],
  "batchIds": [],
  "raw": {
    "anchor": {},
    "processingSummary": []
  }
}
```

生产反馈链路会在提交时 best-effort 富化：

- 有 `messageId` 时，回查 `message_processing_records` 详情。
- 没有 `messageId` 但有 `chatId` 时，取该会话最近处理流水并按 `userMessage` 做弱匹配。
- 飞书表存在独立字段时写独立字段；不存在时把关键 ID 追加到 `备注`，保证不丢证据。

### memorySetup

`memorySetup` 是测试前置记忆 fixture，只在测试链路使用，不进入生产 Agent 主链路。

可包含：

- `sessionFacts / facts`
- `currentStage / procedural.currentStage`
- `presentedJobs`
- `lastCandidatePool`
- `currentFocusJob`
- `profile`

### memoryAssertions

`memoryAssertions` 是记忆能力评测断言。当前先保存结构化断言，后续可接 LLM judge 或规则 judge。

建议至少包含：

- `sourceTraceRequired: true`
- `shouldPreserve: ["currentStage", "sessionFacts", "presentedJobs"]`
- `sourceBadcaseIds`
- `sourceAnchorMessageIds`

## 存量回填

默认回填命令：

```bash
node scripts/backfill-badcase-trace-memory.js --check
```

默认输入：

- `tmp/badcases-20260427-20260428-context.json`
- `tmp/curated-badcase-dataset-draft-20260428.json`

默认输出：

- `tmp/curated-badcase-dataset-draft-20260428-trace-enriched.json`
- `tmp/badcase-trace-memory-coverage-20260429.json`

本次回填结果：

- trace 覆盖：25/25
- memory fixture 草案覆盖：25/25
- 缺失 trace：0
- 缺失 memory：0

## 重策展规则

回填不等于自动合格。回填只解决“证据链和记忆草案缺失”，仍需要重新审计测试资产质量：

- `scenarioCase` 必须有清晰的最后用户输入、核心检查点、期望行为、失败判定。
- `conversationCase` 必须确实依赖跨轮状态、历史事实、已展示岗位、预约流程或报名字段，不能只是单轮问答拉长。
- 动态岗位、薪资、距离、库存、预约结果必须以本轮工具结果为准，不能复刻历史真人回复。
- 缺少 `chatId / messageId / traceId` 的资产可以保留，但必须在 `remark` 或 `sourceTrace.raw` 标明证据边界。
- 有完整来源链路但 `memorySetup` 只是草案时，导入前要人工确认关键记忆事实是否准确。

## 重新运行

建议顺序：

1. 用回填后的 payload 重新导入测试集和验证集。
2. 导入后检查 Feishu 与 Supabase 中 `source_trace / memory_setup / memory_assertions` 是否非空。
3. 重新跑 scenario batch。
4. 重新跑 conversation batch。
5. 抽查执行记录里的 `execution_trace / memory_trace`。
6. 对失败项优先判断是 Agent 回归、工具动态事实、记忆 fixture 草案错误，还是测试资产建模问题。

## 生产链路边界

这次改造不要求 Agent 在生产执行路径里分支判断“是否测试”。生产链路保持干净：

- 生产 Agent 正常处理消息、写入 tracking、写入记忆。
- 反馈提交只是读取已存在的处理流水上下文，组装 `sourceTrace` 后写飞书。
- 测试链路在执行前独立构造 `userId / sessionId / messageId`，用 fixture 种入测试记忆。
- 测试链路运行 turn-end 是为了验证记忆写入能力，不改变生产 turn-end 语义。
