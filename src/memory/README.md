# Memory Module

`src/memory/` 负责 Agent 的记忆读取、写回、沉淀，以及和 Redis / Supabase 的存储边界。

这份 README 只描述当前真实生效的实现，不描述历史方案，也不描述尚未接入主链路的设想。

## 当前结论

现在真正进入 Agent 主链路的记忆，只有 4 类：

- 短期记忆：最近消息窗口（Redis 优先，DB 兜底）
- 会话记忆：当前 session 的结构化状态
- 程序记忆：当前业务阶段
- 长期记忆：跨 session 的 profile_facts / summary

另外还有一个旁路能力：

- `highConfidenceFacts`
  这是基于“当前轮新消息”的前置高置信识别结果。
  它当前会在 `memory.onTurnStart()` 中被计算出来并返回，但：
  - 会作为 prompt sidecar 注入 Agent
  - 不写入 Redis / Supabase
  - 不参与 `extractAndSave()` 的后置事实提取落库

所以它目前不是正式记忆层，更像当前轮的 sidecar 解析结果。

完整端到端数据流见：[记忆与线索数据流](../../docs/architecture/memory-and-hints-data-flow.md)。

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
3. DB fallback 的时间边界与 `historyWindowSeconds` 对齐，而不是 Redis TTL
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
- `invitedGroups`

存储位置：

- Redis
- key: `facts:{corpId}:{userId}:{sessionId}`

这层是 Agent prompt 中 `[会话记忆]` 的主要来源。

每个 fact 字段额外带 `extractedAt` 时间锚（提取时间），时间敏感字段注入时带记录日期、超 24h 失效告警。

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

- 跨 session 复用的用户稳定信息、历史求职意向和历史摘要

拆成三部分：

- `profile_facts`
  - 姓名、电话、性别、年龄、学历、学生身份、健康证
  - 每个字段统一为 `{ value, confidence, source, evidence, updatedAt } | null`
  - 沉淀写入的字段额外带数据血缘 `originSessionId`（=chatId，bot 维度）、`originBotId`（imBotId）；booking/enrichment 路径与存量数据缺失即 undefined
- `preference_facts`（长期求职意向，列 `preference_facts`）
  - `LONG_TERM_PREFERENCE_FIELD_KEYS`：城市/区域/地点/品牌/岗位/班次/薪资/用工形式/排班硬约束/推迟意向/最早可面日期
  - 排除单次 episode 的临时态（`short_term` / `time_windows` / `open_position`）
  - 由 settlement 唯一写入，语义是**快照式整组覆盖**（最新一段会话的意向赢），不像 session facts 那样累积
- `summary`
  - `recent[]`
  - `archive`
  - `lastSettledMessageAt`
  - `lastSettledBySession`（按会话隔离的沉淀边界，`Record<sessionId, messageAt>`）

存储位置：

- Supabase `agent_long_term_memories`
- Redis 缓存 key: `long-term:{corpId}:{userId}`

消费规则：

- 注入瘦身：给大模型的 `[用户档案]` 只带字段值、置信度、来源、更新日期，**不带 evidence 全文**（evidence 是排障字段）；`fact-lines.formatter.ts` 的 `includeEvidence` 仅供事实提取 prompt 的 `[规则模式匹配线索]` 用
- 工具上下文只 unwrap 高置信字段，低/中/未知置信字段留给大模型自行判断和追问
- `preference_facts` 注入为 prompt 的 `[历史求职意向]` 段（`formatLongTermPreferences`），带更新日期与“本次优先”指引，过期 `available_after` 不渲染；不进工具预填

## 字段置信度与来源

`highConfidenceFacts`、`sessionFacts`、长期 `profile_facts` 都使用字段级 fact wrapper。字段值本身必须解释“有多可信”和“从哪里来”。

置信度：

| 值 | 含义 | 程序化消费 |
|----|------|------------|
| `high` | 可程序化采用。来自确定性规则、明确结构化输入，或经过强校验的事实 | 工具可自动消费 |
| `medium` | 可给模型参考。通常来自 LLM 结构化提取、会话沉淀或外部补全 | 工具默认不消费 |
| `low` | 弱参考。来自系统兜底、弱规则或补充接口 | 工具不消费 |
| `unknown` | 旧数据或缺少元数据的兼容值 | 工具不消费 |

来源：

| 值 | 含义 |
|----|------|
| `candidate` | 候选人直接明示的结构化输入，且写入链路保留了候选人来源 |
| `llm` | LLM 根据对话做的结构化提取 |
| `rule` | 确定性规则、正则、白名单或别名表匹配得到 |
| `system` | 外部系统或平台接口补充得到 |
| `memory` | 历史记忆或旧结构兼容迁移得到 |
| `derived` | 由其他字段推导得到，例如由区/地标白名单反推出城市 |
| `booking` | 预约/报名成功后写入长期档案，是长期画像的最高质量来源 |
| `extraction` | 会话沉淀时从 sessionFacts 抽取后写入长期档案；原 sessionFact 来源会记录在 evidence 中 |
| `enrichment` | 外部画像补全链路写入，例如客户详情接口补充性别 |

注意：

- `source` 说明字段产生路径，不等同于置信度；最终能否进入工具判断看 `confidence`
- `highConfidenceFacts` 当前只会出现 `source=rule/system`，且不持久化
- `sessionFacts` 主要出现 `source=llm/rule/system/memory/derived`
- 长期 `profile_facts` 主要出现 `source=booking/extraction/enrichment`

来源声明置信度升级：LLM 可输出 `explicit_provenance{field, quote}`，quote 经候选人原文验证（phone 还加格式校验）后，把 medium 升为 high/candidate；仅限白名单 `EXPLICIT_UPGRADE_FIELDS`（排除 `name` 与 `applied_store`/`interview_time` 等事务字段）。

## 回合开始：onTurnStart

实际编排在 [memory-lifecycle.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/memory-lifecycle.service.ts)。

流程如下：

1. 读取短期记忆（Redis 优先，DB 兜底）
2. 读取会话记忆
3. 读取程序记忆
4. 读取长期 `profile_facts` / `preference_facts` / `summary_data`
5. 如提供了 `currentMessages`，对“当前轮新消息”做一次前置高置信识别
6. 跨会话来源研判：全新 chat 首聊且长期记忆来自别的会话时，置 `longTerm.origin.fromOtherConversation`
7. 返回统一的 `MemoryRecallContext`

返回结构定义在 [memory-runtime.types.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/types/memory-runtime.types.ts)：

- `shortTerm.messageWindow`
- `sessionMemory`
- `highConfidenceFacts`
- `procedural`
- `longTerm.profile` / `longTerm.preferences`
- `longTerm.origin`（可选；`{ fromOtherConversation: true }` 时渲染层加"来自此前会话"口径）

注意：

- `highConfidenceFacts` 只看当前轮新消息
- 没拿到当前轮消息时，不会 fallback 到历史窗口
- 当前实现里，它会进入 prompt sidecar，但不属于持久化记忆

### 跨会话来源研判（cross-conversation origin）

长期记忆按 `(corpId, userId)` 跨 bot 共享。同一候选人在同一 corp 下添加多位招募经理（多个 bot）时，每个 (候选人, bot) 是独立 chat（`sessionId=chatId`）。`detectCrossConversationOrigin()` 在 `onTurnStart` 研判本轮注入的长期记忆是否来自候选人此前在**另一段会话**的沉淀，满足下列全部条件时置 `longTerm.origin.fromOtherConversation=true`：

1. 仅全新 chat 首聊：当前会话还没有自有会话记忆（`hasStructuredSessionMemoryState=false`）
2. 长期 `profile_facts` / `preference_facts` 非空
3. 长期记忆来自别的会话：优先看逐字段血缘 `originSessionId !== 当前 sessionId`；存量无血缘时回退 `summary_data.lastSettledBySession` / `recent[].sessionId` 去掉当前会话后仍有其它会话

渲染由 `generator/preparation.service.ts` 的 `formatCrossConversationNotice()` 处理，置真时在档案/意向前插一段泛指口径（不点名具体招募经理、不假装是本会话聊过）。粒度上：数据血缘逐字段精确记录，展示口径是会话级泛指。

## Agent 如何消费 onTurnStart 的结果

[preparation.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/agent/generator/preparation.service.ts) 会消费 `onTurnStart()` 返回值。

当前实际使用的是：

- `shortTerm.messageWindow`
- `sessionMemory`
- `highConfidenceFacts`
- `procedural.currentStage`
- `longTerm.profile` / `longTerm.preferences`
- `longTerm.origin`

这意味着当前 prompt 中会出现：

- `[历史背景｜来自候选人此前在本平台的咨询]`（仅当 `longTerm.origin.fromOtherConversation` 为真）
- `[用户档案]`
- `[历史求职意向]`（来自 `longTerm.preferences`）
- `[会话记忆]`
- `[本轮高置信线索]`
- `[本轮待确认线索]`

其中 `longTerm.profile` 在内存中是 `profile_facts` 结构。Prompt 会展示所有字段及其置信度；进入工具上下文时会统一 unwrap，只让高置信字段参与程序化判断。

老用户回访阶段兜底：`resolveReturningUserStage()` 在长期画像有姓名/电话、且程序性阶段已过期时，把 `entryStage` 兜底为 `job_consultation`。

## 回合结束：onTurnEnd

实际编排也在 [memory-lifecycle.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/memory-lifecycle.service.ts)。

流程顺序很重要：

1. 取最后一条 user 消息
2. 读取旧的 `sessionState`
3. 用旧 `sessionState.facts` 启动 settlement 检测（同时把 `ctx.botImId` 传下去作为沉淀字段的 bot 血缘）
4. 把本轮工具查到的 `candidatePool` 落到 `lastCandidatePool`
5. 如果本轮有 assistant 回复，做岗位投影
6. 对完整对话做后置结构化事实提取并写回

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
2. 用 `trimToCurrentSessionSegment()` 按消息间隙（≥`settlementGapSeconds`）截到最近连续会话段，避免跨会话串味
3. 读取旧的 `facts`
4. 如果已有 `facts`，只重看最近 `sessionExtractionIncrementalMessages` 条历史
5. 纯应答闸门：若 `isPureAcknowledgment()` 命中且当前消息规则零命中，跳过 LLM 提取直接复用旧 facts
6. 重新拉品牌表（命中品牌带别名、其余仅名称）
7. 基于 user 文本重新做品牌 alias hints 和规则高置信识别
8. 构造 extraction prompt（注入 `[当前时间]` 要求绝对日期、`[已确认事实]`，提取原则为增量式而非累积式）
9. 调 extract 模型输出结构化对象
10. 用 `mergeDetectedBrands()` 做品牌 alias 兜底合并
11. 用 `mergeRuleAndLlmFacts()` 单遍合并规则与 LLM 事实（替代原两层合并），共享原语在 `facts/fact-merge.util.ts`
12. `saveFacts()` 经 `mergeFactsWithConfidenceGuard()` 深度合并回 Redis：跨轮低置信不覆盖高置信

这里的关键点：

- 后置提取是事实落库主路径
- `onTurnStart` 的 `highConfidenceFacts` 对象本身不落库
- `onTurnEnd` 会重新跑同类规则抽取，并把可保存的结果写入 `sessionFacts`
- 每个字段写入时打 `extractedAt` 时间锚；evidence 入库经 `truncateEvidence()` 截断 `MAX_FACT_EVIDENCE_CHARS=200` 字

## 沉淀：Settlement

实现服务：[settlement.service.ts](/Users/jiezhu/workSpace/DuLiDay/cake-agent-runtime/src/memory/services/settlement.service.ts)

触发条件：

- `chat_messages` 中连续两条消息的时间差达到 `settlementGapSeconds`

执行内容：

1. 判断这段旧会话是否已经沉淀过（边界取 `summary_data.lastSettledBySession[sessionId]`，缺失再回退 `lastSettledMessageAt`）
2. 分页扫描边界之后到旧会话断点之间的消息片段（每页 `SETTLEMENT_FETCH_LIMIT=500`，最多 `MAX_PAGES=10` 页）
3. 使用当前 Redis `sessionFacts` 作为已校验/清洗过的结构化事实参考
4. 摘要输入截尾最近 `SUMMARY_MAX_MESSAGES=120` 条
5. 调 LLM 生成一条摘要
6. 通过 RPC `append_long_term_summary_atomic`（行锁内）追加到长期 `summary.recent`，溢出压缩进 `archive`；新增 `p_session_id` 参数同步写 `lastSettledBySession[sessionId]`
7. 从 `sessionFacts.interview_info` 抽身份字段写入长期 `profile_facts`，每条字段打 `originSessionId`(=sessionId/chatId) + `originBotId`(=botImId) 数据血缘
8. 从 `LONG_TERM_PREFERENCE_FIELD_KEYS` 抽稳定意向，整组覆盖写入 `preference_facts`（同样打血缘）
9. 通过 RPC `mark_long_term_settled_boundary`（带 `p_session_id`）原子更新沉淀边界

这层不会反写 Redis 会话态，只负责写长期记忆。

注意：

- Summary 的文本来源是 `chat_messages` 中待沉淀的旧消息片段
- Profile facts 的结构化来源是 Redis `sessionFacts.interview_info`
- 如果 Redis `sessionFacts` 已过期，summary 仍可沉淀，但长期画像字段不会从过期 facts 中恢复
- 沉淀边界按会话隔离：双 bot 服务同一候选人时不再互相推进彼此的边界
- 沉淀字段带 `originSessionId/originBotId` 血缘：长期记忆跨 bot 共享，但能追溯每条字段由哪次会话沉淀，并支撑全新 chat 首聊时的跨会话来源口径

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
- `settlementGapSeconds`
- `historyWindowSeconds`
- `sessionWindowMaxMessages`
- `sessionWindowMaxChars`
- `sessionExtractionIncrementalMessages`
- `longTermCacheTtl`

其中：

- `sessionTtl` 决定 Redis 会话态的过期时间
- `settlementGapSeconds` 决定多长消息间隔算一段旧会话结束
- `historyWindowSeconds` 决定短期窗口 Redis miss 后从 DB 回看多远

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
  - profile_facts / preference_facts / summary 持久化

- `services/settlement.service.ts`
  - 会话结束后的长期沉淀

- `facts/high-confidence-facts.ts`
  - 当前轮文本的前置高置信识别（规则层）
  - 当前不属于主记忆读写链路

- `facts/fact-merge.util.ts`
  - 规则事实与 LLM 事实合并、跨轮置信度守卫的共享原语

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

而 `highConfidenceFacts` 目前只是“当前轮前置解析 sidecar”，不是正式记忆层；它会辅助 prompt 理解。回合结束时系统会重新跑规则识别，把可保存的字段经 `sessionFacts` 链路落到 Redis。
