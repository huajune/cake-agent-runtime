# Memory Module

`src/memory/` 负责 Agent 的记忆读取、写回、沉淀，以及和 Redis / Supabase 的存储边界。

这份 README 只描述当前真实生效的实现，不描述历史方案，也不描述尚未接入主链路的设想。

## 当前结论

现在真正进入 Agent 主链路的记忆，只有 4 类：

- 短期记忆：最近消息窗口（Redis 优先，DB 兜底）
- 会话记忆：当前 session 的结构化状态
- 程序记忆：当前业务阶段
- 长期记忆：跨 session 的 profile / summary

另外还有一个旁路能力：

- `highConfidenceFacts`
  这是基于“当前轮新消息”的前置高置信识别结果。
  它当前会在 `memory.onTurnStart()` 中被计算出来并返回，但：
  - 会作为 prompt sidecar 注入 Agent
  - 不写入 Redis / Supabase
  - 不参与 `extractAndSave()` 的后置事实提取落库

所以它目前不是正式记忆层，更像当前轮的 sidecar 解析结果。

## 模块目标

memory 模块的职责不是“帮模型记住一切”，而是把记忆相关工作拆成 3 个稳定动作：

1. 回合开始时，统一读取本轮需要的记忆
2. 回合结束时，统一写回本轮产生的状态
3. 会话闲置结束后，把可沉淀的信息写入长期记忆

这样 Agent 编排层不需要直接操作 Redis key，也不需要自己决定何时沉淀。

## 对外入口

外部模块只应该通过 [memory.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/memory.service.ts) 使用记忆能力。

当前 facade 只有 4 个入口：

- `onTurnStart(corpId, userId, sessionId, currentMessages?)`
- `onTurnEnd(ctx, assistantText?)`
- `getSummaryData(corpId, userId)`
- `setStage(corpId, userId, sessionId, state)`

其中：

- `onTurnStart` / `onTurnEnd` 是 Agent 主链路入口
- `getSummaryData` 供 `recall_history` 等按需读取长期摘要
- `setStage` 供 `advance_stage` 写程序记忆

## 记忆分层

### 1. 短期记忆

实现服务：[short-term.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/short-term.service.ts)

含义：

- 当前会话最近一段消息窗口
- 直接作为模型对话上下文使用

来源：

- 热路径：Redis 窗口缓存
- 兜底来源：`chat_messages` 业务消息表

读取逻辑：

1. 先从 Redis 短期窗口读取最近消息
2. Redis miss 时，回退到 `ChatSessionService.getChatHistory(chatId, maxMessages)`
3. DB fallback 的时间边界与 `sessionTtl` 对齐，而不是固定天数
4. miss 回退后会把 DB 结果回填到 Redis
5. 给每条消息注入时间上下文
6. 再按字符上限裁剪

写入逻辑：

1. 业务消息先正常写入 `chat_messages`
2. `ChatSessionService.saveMessage()` / `saveMessagesBatch()` 同步镜像到 Redis 窗口
3. `updateMessageContent()` 也会同步更新 Redis，避免图片描述回写后窗口脏读

配置来源：[memory.config.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/memory.config.ts)

- `sessionWindowMaxMessages`
- `sessionWindowMaxChars`

注意：

- Redis 窗口是短期记忆的热缓存，不是最终真相源
- 最终真相源仍然是 `chat_messages`
- 这层缓存的目标是避免“每轮都只靠 DB 回查最近窗口”

### 2. 会话记忆

实现服务：[session.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/session.service.ts)

类型定义：[session-facts.types.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/types/session-facts.types.ts)

含义：

- 当前这次求职会话的结构化状态
- 它是 session 级，不是 user 级

当前字段：

- `facts`
- `lastCandidatePool`
- `presentedJobs`
- `currentFocusJob`
- `lastSessionActiveAt`

存储位置：

- Redis
- key: `facts:{corpId}:{userId}:{sessionId}`

这层是 Agent prompt 中 `[会话记忆]` 的主要来源。

### 3. 程序记忆

实现服务：[procedural.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/procedural.service.ts)

类型定义：[procedural.types.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/types/procedural.types.ts)

含义：

- 当前对话主任务所在阶段
- 最近一次显式推进阶段的来源、时间和原因

字段：

- `currentStage`
- `fromStage`
- `advancedAt`
- `reason`

存储位置：

- Redis
- key: `stage:{corpId}:{userId}:{sessionId}`

这层只负责存状态，不负责判断阶段是否合法。阶段合法性在 `advance_stage` 工具层校验。

### 4. 长期记忆

实现服务：[long-term.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/long-term.service.ts)

类型定义：[long-term.types.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/types/long-term.types.ts)

含义：

- 跨 session 复用的用户稳定信息和历史摘要

拆成两部分：

- `profile`
  - 姓名、电话、性别、年龄、学历、学生身份、健康证
- `summary`
  - `recent[]`
  - `archive`
  - `lastSettledMessageAt`

存储位置：

- Supabase `agent_memories`

## 回合开始：onTurnStart

实际编排在 [memory-lifecycle.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/memory-lifecycle.service.ts)。

流程如下：

1. 读取短期记忆（Redis 优先，DB 兜底）
2. 读取会话记忆
3. 读取程序记忆
4. 读取长期 profile
5. 如提供了 `currentMessages`，对“当前轮新消息”做一次前置高置信识别
6. 返回统一的 `MemoryRecallContext`

返回结构定义在 [memory-runtime.types.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/types/memory-runtime.types.ts)：

- `shortTerm.messageWindow`
- `sessionMemory`
- `highConfidenceFacts`
- `procedural`
- `longTerm.profile`

注意：

- `highConfidenceFacts` 只看当前轮新消息
- 没拿到当前轮消息时，不会 fallback 到历史窗口
- 当前实现里，它会进入 prompt sidecar，但不属于持久化记忆

## Agent 如何消费 onTurnStart 的结果

[agent-preparation.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/agent/agent-preparation.service.ts) 会消费 `onTurnStart()` 返回值。

当前实际使用的是：

- `shortTerm.messageWindow`
- `sessionMemory`
- `highConfidenceFacts`
- `procedural.currentStage`
- `longTerm.profile`

这意味着当前 prompt 中会出现：

- `[用户档案]`
- `[会话记忆]`
- `[本轮高置信线索]`
- `[本轮待确认线索]`

## 回合结束：onTurnEnd

实际编排也在 [memory-lifecycle.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/memory-lifecycle.service.ts)。

流程顺序很重要：

1. 取最后一条 user 消息
2. 读取旧的 `sessionState`
3. 在写新的 `lastSessionActiveAt` 之前，先判断旧会话是否应该沉淀
4. 把本轮工具查到的 `candidatePool` 落到 `lastCandidatePool`
5. 更新 `lastSessionActiveAt`
6. 如果本轮有 assistant 回复，做岗位投影
7. 对完整对话做后置结构化事实提取并写回

## 会话记忆里的两类核心推导

### 1. 岗位投影

入口：[SessionService.projectAssistantTurn()](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/session.service.ts)

内部依赖：[session-job-matching.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/session-job-matching.ts)

做两件事：

- 从 assistant 回复中识别“这轮真正展示了哪些岗位”
- 从用户最新一句话里判断“当前焦点岗位”

写回字段：

- `presentedJobs`
- `currentFocusJob`

### 2. 后置结构化事实提取

入口：[SessionService.extractAndSave()](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/session.service.ts)

流程：

1. 把本轮消息拆成：
   - `conversationHistory`
   - `currentMessage`
2. 读取旧的 `facts`
3. 如果已有 `facts`，只重看最近 `sessionExtractionIncrementalMessages` 条历史
4. 重新拉品牌表
5. 基于当前轮 user 文本做品牌 alias hints
6. 构造 extraction prompt
7. 调 extract 模型输出结构化对象
8. 用 `mergeDetectedBrands()` 做品牌 alias 兜底合并
9. `saveFacts()` 深度合并回 Redis

这里的关键点：

- 后置提取是事实落库主路径
- 它不会直接拿 `highConfidenceFacts` 来落库
- 当前只复用了品牌 alias hints 这部分辅助逻辑

## 沉淀：Settlement

实现服务：[settlement.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/settlement.service.ts)

触发条件：

- `lastSessionActiveAt` 距今超过 `sessionTtl`

执行内容：

1. 判断这段旧会话是否已经沉淀过
2. 从 `facts` 里抽身份字段，写入长期 `profile`
3. 读取 `lastSettledMessageAt` 之后到 `lastSessionActiveAt` 之间的消息
4. 调 LLM 生成一条摘要
5. 追加到长期 `summary.recent`
6. 如有溢出，压缩进 `archive`
7. 更新 `lastSettledMessageAt`

这层不会反写 Redis 会话态，只负责写长期记忆。

## 深度合并规则

会话 facts 的合并使用 [deep-merge.util.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/stores/deep-merge.util.ts)。

语义是：

- `null / undefined / ''` 不覆盖旧值
- 对象递归合并
- 数组去重后合并

这意味着：

- “这轮没提到”不等于“要删掉旧值”
- 新事实通常是增量补充，不是全量重写

## 配置项

定义在 [memory.config.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/memory.config.ts)：

- `sessionTtl`
- `sessionWindowMaxMessages`
- `sessionWindowMaxChars`
- `sessionExtractionIncrementalMessages`
- `longTermCacheTtl`

其中：

- `sessionTtl` 决定 Redis 会话态的过期时间
- `sessionTtlDays` 供 settlement 按天数复用

## 当前真实的文件职责

- `memory.service.ts`
  - facade

- `services/memory-lifecycle.service.ts`
  - turn start / turn end 编排

- `services/short-term.service.ts`
  - 从 `chat_messages` 构造消息窗口

- `services/session.service.ts`
  - 会话态读写
  - 岗位投影
  - 后置事实提取

- `services/procedural.service.ts`
  - 阶段状态读写

- `services/long-term.service.ts`
  - profile / summary 持久化

- `services/settlement.service.ts`
  - 会话结束后的长期沉淀

- `services/high-confidence-facts.ts`
  - 当前轮文本的前置高置信识别
  - 当前不属于主记忆读写链路

## 设计边界

- Agent orchestration 不直接操作 Redis / Supabase
- prompt 格式化放在 agent 模块，不放在 memory facade
- memory store 不做业务判断
- `advance_stage` 仍是程序记忆的唯一显式写入口
- `recall_history` 仍是长期摘要的按需读入口

## 一句话总结

当前记忆系统的主线是：

- 回合开始：读取四类正式记忆
- 回合结束：写回会话态并触发后置提取
- 会话闲置结束：沉淀到长期记忆

而 `highConfidenceFacts` 目前只是“当前轮前置解析 sidecar”，不是正式记忆层；它会辅助 prompt 理解，但不进入后置事实提取落库链路。
