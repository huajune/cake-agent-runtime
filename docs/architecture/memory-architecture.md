# 记忆系统架构与数据流

> 本文只描述当前实现。两层结构、存储契约和生命周期以
> [`src/memory/README.md`](../../src/memory/README.md) 为权威；本文补充跨模块读写时序、
> Prompt / 工具消费矩阵和排障路径。

## 1. 终态边界

记忆系统只有 `short-term` 与 `long-term` 两层。`turnHints` 是当前轮 sidecar，
episode 是连续咨询段的计算边界，二者都不是额外记忆层。

| 作用域              | 内容                         | 生命周期 / 边界                                                                   | 权威存储                            |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| short-term 消息窗口 | 候选人与助手原始对话         | 取最近 N 条并套滚动 7 天窗（锚点 = 本批之前候选人最后一次开口），再受字符预算裁剪 | `chat_messages`；Redis 仅作窗口缓存 |
| short-term 会话状态 | facts、岗位工作台、阶段指针  | 业务口径 3 天                                                                     | Redis                               |
| episode             | 一段连续咨询的消息切片       | 闲置 3 天划界                                                                     | 无独立 key、表或目录                |
| long-term 关系档    | 身份档案、求职意向、咨询摘要 | 持久                                                                              | Supabase；Redis 作 2 小时缓存       |

对外时间口径固定为 **7d / 3d / 3d**：消息回看窗口滚动 7 天、会话状态 3 天、
咨询段闲置划界 3 天。`factsv2:` 实际比 3 天多保留 12 小时，只为保证延迟任务先读取事实再过期，
不构成第四个业务时间口径。

代码里的 `sessionId` 是 `chatId`，代表候选人和 bot 的聊天关系；一条聊天关系可以包含多段咨询。
长期关系档则显式使用 `(corpId, userId, botUserId)`：`botUserId` 是托管账号稳定的
`wecomUserId`，轮换的 `imBotId` 只用于渠道调用与血缘排障，不能进入长期主键。

```text
候选人输入
  │
  ├─ short-term：滚动 7 天消息窗口 + 3 天会话状态
  │       │
  │       └─ preparation：快照补料 → 共享裁决 → Prompt / 工具投影
  │
  └─ 闲置满 3 天形成 episode 边界
          │
          └─ consolidation
               ├─ semantic_profile
               ├─ semantic_job_intent
               └─ episodic_session_summaries（最多 20 段）
                    │
                    └─ long-term：候选人 × bot 关系档
```

收资表单不是记忆。它是工具域内“丢失即事故”的业务单据，由
`src/tools/collection/` 自持整实体快照、定位指针与 3 天 TTL；迁入工具域后不再经过
`MemoryService`。

## 2. 两层数据模型

### 2.1 Short-term：原文窗口与会话状态

`MemoryLifecycleService.onTurnStart()` 读取三项 short-term 部件：

1. `MessageWindowService` 先读 `memory:short_term:chat:{chatId}` 热缓存；缓存缺失或
   provenance 版本过旧时，回退 `chat_messages` 最近 N 条原文并回填；两条路径都在内存里套滚动 7 天窗口。
2. `SessionStateService` 从 `factsv2:{corpId}:{userId}:{sessionId}` 读取 facts 与 workbench。
3. `SessionWorkbenchService` 从独立的 `stage:{corpId}:{userId}:{sessionId}` 读取阶段指针。

硬上限默认 300 条（物理封顶，生产 7 天内 p99≈90）、字符预算 24,000；超限时从最早消息开始裁剪。Redis 窗口缓存的 3 天 TTL
不改变 7 天源数据窗口：缓存失效后仍可从数据库重建。

`factsv2:` 是 Redis hash，主要分为两类数据：

- facts：候选人结构化事实、偏好、已邀群、终态与活动水位；
- workbench：候选岗位池、已展示岗位、当前焦点岗位、查询签名与推店过程状态。

Redis hash 没有字段级 TTL，因此 facts 与 workbench 共同享有 3 天加 12 小时的实际 TTL。
阶段指针保持独立 key，严格按 3 天过期。

大多数候选人事实使用 `value / confidence / source / evidence` 信封。`facts.brand` 是明确例外：
它直接保存 `PersistedBrandState`，由 `BrandStateService` reducer 唯一写入，不再套事实信封。
品牌 reducer 在回合收尾的事实提取之后运行，即使事实提取失败也不会跳过；规则轨、图片轨和
LLM 轨的品牌解析会在这里汇总。

### 2.2 Long-term：候选人 × bot 关系档

长期关系档的 Supabase 表为 `agent_long_term_memories`，唯一关系维包含
`(corp_id, user_id, bot_user_id)`；Redis 缓存为
`long-term:{corpId}:{userId}:{botUserId}`，默认 2 小时。

| 列                           | 语义                             | 默认召回                         |
| ---------------------------- | -------------------------------- | -------------------------------- |
| `semantic_profile`           | 身份档案，逐字段携带置信度与来源 | 是                               |
| `semantic_job_intent`        | 最近一段咨询的求职意向快照       | 是                               |
| `episodic_session_summaries` | 按时间从旧到新的咨询摘要数组     | 否，仅 `recall_history` 显式读取 |
| `consolidation_watermarks`   | 各聊天关系已处理到的消息水位     | 否，独立工作列                   |

`semantic_profile` 当前由 9 个身份字段组成：`name`、`phone`、`gender`、`age`、
`is_student`、`education`、`has_health_certificate`、`height`、`weight`。
它有两条写入路径：consolidation 从会话事实提拔为 medium，报名成功写入 high。
共享置信度守卫保证 lower rank 不能覆盖 high；Prompt 可展示待确认档案，工具默认只解包 high。

`semantic_job_intent` 当前覆盖 11 个意向键：`city`、`district`、`location`、`brands`、
`position`、`schedule`、`salary`、`labor_form`、`schedule_constraint`、`delayed_intent`、
`available_after`。品牌意向从 `facts.brand.currentBrand` 进入同一快照。

`episodic_session_summaries` 是单层 `SummaryEntry[]`：每段咨询追加一条，最多 20 段，
超限时确定性淘汰最老条目。LLM 只生成本次新增摘要；已经写入的摘要永不交给 LLM 重写。

无可靠 bot 血缘的存量行保持冻结且不参与读取。跨会话来源研判已经退役：召回只读取当前
`botUserId` 的关系档，不拼接其他 bot 的信息，也不向模型渲染泛化来源横幅。

## 3. 默认召回契约

`memory.onTurnStart()` 返回运行时投影，而不是存储原样：

```ts
interface MemoryRecallContext {
  shortTerm: {
    messageWindow: ShortTermMessage[];
    sessionState: WeworkSessionState | null;
    stage: StageState;
  };
  turnHints: TurnHints | null;
  longTerm: {
    semantic: SemanticMemory;
  };
  _warnings?: string[];
}
```

约束如下：

- `turnHints` 只对当前轮有效；经过回合末验证与合并后，采信结果才可能成为 session facts。
- episodic 摘要不进入默认召回，避免每轮无条件膨胀上下文。
- `[会话记忆]`、`[用户档案]`、`[本轮解析线索]` 等模型可见标签是契约，不随内部字段重排改名。
- `AgentMemoryContext` 只是兼容别名，新调用方应使用 `MemoryRecallContext`。

## 4. 回合读时序：召回到 preparation 备料

### 4.1 `onTurnStart()` 并行读取

```text
MemoryLifecycleService.onTurnStart(corpId, userId, sessionId, botUserId)
  ├─ 7 天 messageWindow
  ├─ factsv2 sessionState
  ├─ stage 指针
  ├─ 当前候选人 × bot 的 semantic_profile
  └─ 当前候选人 × bot 的 semantic_job_intent
       ↓
MemoryRecallContext
```

任一可降级读取失败时，生命周期返回可用的其余部分，并把诊断信息放进 `_warnings`；调用方不能把
“空值”直接解释为“用户从未提供”。

### 4.2 `PreparationService.prepare()` 备料链

Memory 只负责召回；模型可见呈现与工具投影在 generator preparation 完成：

```text
提取本轮连续 user 文本并生成 turnHints
  → TurnDataLoaderService.load()
      → memory.onTurnStart()
      → SnapshotEnrichmentService.enrich()（有身份锚时）
      → 预约 / 群 / 身份 / 策略 / 视觉 / 地理等源并发读取
  → normalizeConversationWithCorpus()
  → resolveTurnContext()
      → adjudicatePromptMemory()（一次生成共享裁决视图）
      → PromptModel + ToolContextModel + ledgerSeed
  → ContextService.compose()（typed sections + manifest/slot compiler）
  → ToolRuntimeBuilderService.build()
  → WorkingMemory
```

`SnapshotEnrichmentService` 紧接召回，用外部候选人详情补齐当轮快照中缺失的可靠线索；当前主要是
身份锚存在时的 gender 补料。它只返回 enriched snapshot / turnHints，不写 Redis 或 Supabase，
也不属于 memory lifecycle。

`adjudicatePromptMemory()` 只计算一次共享视图，再分别投影到 `MemoryPromptView` 与
`TurnHintsPromptView`：

- 权威链：本轮 accepted > 当前会话 accepted > 历史档案 historical_unconfirmed；
- 置信度与归一后的 `updatedAt / extractedAt` 只在同一作用域内比较；
- 同值只在权威位置呈现一次；异值保留胜者并给出冲突提示；
- 本轮线索与既有事实异值时标记“待确认更新”，不能直接改写存储。

所有动态记忆仍处于 system 语义，只进入 `promptBlocks` / `finalPrompt`，不会被搬入
`normalizedMessages`。

## 5. Prompt 与工具消费矩阵

### 5.1 Prompt 消费

| 消费处                     | short-term                    | long-term                            | 本轮数据               | 关键约束                               |
| -------------------------- | ----------------------------- | ------------------------------------ | ---------------------- | -------------------------------------- |
| `normalizedMessages`       | 7 天消息窗口                  | 不使用                               | 调用方本轮消息         | 只承载真实 user / assistant 语义       |
| `memory` section           | session facts、workbench 投影 | profile、job intent                  | 预约与实时群状态等备料 | 消费共享裁决视图；保留模型可见内层标签 |
| `turn-hints` section       | 只用于同字段 diff             | 只用于同字段 diff                    | turnHints              | 同值去重，异值进入待确认块             |
| `hard-constraints` section | 已采信会话约束                | 不直接使用                           | 当前轮约束、品牌状态   | 只呈现本轮岗位查询需要的硬约束         |
| `group-inventory` section  | 高置信城市                    | 不直接使用                           | 实时群库结果           | 无可靠城市或无群数据时省略             |
| `stage-strategy` section   | 独立 stage 指针               | profile 仅用于阶段过期后的老用户兜底 | 当前策略配置           | 只渲染当前阶段策略                     |
| `recall_history` 工具结果  | 不使用                        | episodic 摘要                        | 显式工具调用           | 摘要不在每轮默认 system 中出现         |

`memory` section 可以展示 medium 的历史档案供模型追问，但不能因此让工具绕过 high 门槛。
当前预约信息由 `active_booking` 无 bot 兼容行中的工单指针结合业务系统实时状态备料；
它是待迁移的业务指针与 Prompt 上下文，不属于三维长期关系档，也不是新增记忆层。

### 5.2 工具消费

| 工具侧用途                       | 数据来源                                                   | 读写纪律                                                            |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| 岗位查询、预检、报名的候选人事实 | high session facts + 本轮已采信规则线索                    | 本轮值可覆盖工具投影，持久化仍等 `onTurnEnd()`                      |
| 身份档案预填                     | long-term profile                                          | 默认只解包 high；medium 只能形成带值求证提示                        |
| 岗位 provenance 与防复读         | candidate pool、presented jobs、focus job、query signature | 从 workbench 读取；工具结果写回 turn ledger                         |
| 品牌查询口径                     | `facts.brand` + 本轮品牌上下文                             | reducer 是唯一持久写者                                              |
| 阶段推进                         | stage 指针 + 策略可用阶段                                  | `advance_stage` 校验目标后直接覆盖写 `stage:`                       |
| 群邀请                           | 已邀群 + 当前城市/群状态                                   | `GroupInviteService` 在确认已入群或邀请成功后立即写 `invitedGroups` |
| 历史回顾                         | episodic 摘要                                              | 只能通过 `recall_history` 显式读取                                  |
| 收资与报名表单                   | `tools/collection` 的表单实体与定位指针                    | 独立存储、独立 TTL，不读写 memory hash                              |

`TurnLedger` 是回合内写缓冲：工具把岗位查询、失效岗位、地理确权、图片事实与品牌解析等结果
记录在 ledger，runner 在成功完成回合后把它交给 `onTurnEnd()`。阶段推进和已邀群有各自的工具期
即时写路径，不经过 ledger。被更新消息淘汰的旧回复不能投影进会话状态。

## 6. 回合写时序

### 6.1 `onTurnEnd()`：会话状态收尾

回合结束时，生命周期并行启动两条分支：刷新该聊天关系的 delayed consolidation job，
以及按依赖顺序更新 session state。会话状态分支顺序为：

1. `save_candidate_pool`：保存本轮候选岗位池；
2. `save_job_list_query`：保存查询签名；
3. `project_assistant_turn`：投影已实际采用的助手回复与岗位呈现；
4. `drop_invalidated_jobs`：在新投影之后剔除失效岗位，防止死岗位被写回；
5. `save_attested_city`：保存工具确权城市；
6. `extract_facts`：结合本轮 turnHints 做结构化提取与置信度合并；
7. `apply_brand_state`：汇总三条品牌解析轨并运行 reducer。

每一步写入 `message_processing_records.post_processing_status`。单个 hash 字段由各服务原子写入，
串行顺序表达数据依赖，不依赖整对象回写来保证并发安全。

### 6.2 consolidation：三种产出、三种写法

任务到点后先重新读取数据库最新消息时间。若尚未连续闲置 3 天，按剩余时间重排；达到边界后，
按 `consolidation_watermarks.bySession[sessionId]` 从上次已处理消息之后扫描本段原文。
扫描最多 10 页、每页 500 条；首次接管会裁到最后一段连续咨询，摘要输入只取尾部最多 120 条。

输入分为两组：

- A：当前 episode 的聊天原文，是摘要的主料；
- B：当前 session facts 的 `interview_info`、`preferences` 与 `facts.brand.currentBrand`，
  workbench 和簿记字段不参与长期事实生成。

| 产出                         | 来源                                  | 写法                                                                   | 语义           |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `semantic_profile`           | B 的 `interview_info` 9 字段          | 逐字段守卫合并；输入按 medium 写入，SQL rank 阻止覆盖 high             | 档案越确认越硬 |
| `semantic_job_intent`        | B 的 `preferences` 11 字段 + 当前品牌 | 最新咨询整组快照覆盖；信封内空值是显式清除，外层缺失表示保持旧值       | 意向以最新为准 |
| `episodic_session_summaries` | A 原文，B 仅作参考                    | LLM 生成一条不超过 150 字的四节摘要后追加；20 段上限确定性淘汰最老条目 | 经历只增不改   |

写入分两步：profile 与 job intent 在同一 RPC / 行锁内先写；新增摘要与本次
`consolidation_watermarks` 在另一原子更新中一起写。水位是独立工作列，不是摘要内容、
不进默认召回，也不因摘要数组淘汰而丢失。

事实写是幂等覆盖；摘要写失败时 Bull 使用指数退避重试，最多 3 次。最终失败通过
`memory.consolidation_failed` 上报，不能只留本地日志。

## 7. 存储所有权

| 数据                          | 唯一所有者                              | 禁止事项                                     |
| ----------------------------- | --------------------------------------- | -------------------------------------------- |
| 原始聊天消息                  | chat message / session 基础设施         | memory 不复制一份长期原文库                  |
| short-term facts 与 workbench | `src/memory/short-term/`                | sections 与 tools 不直接写 Redis             |
| `facts.brand`                 | `BrandStateService` reducer             | 其他路径不得旁路写品牌状态                   |
| long-term 关系档              | `src/memory/long-term/`                 | 不按 `imBotId` 建关系，不跨 bot 混读         |
| 候选人事实采信规则            | `src/resolution/`                       | memory 不另写一套判定逻辑                    |
| 模型可见记忆呈现              | `src/agent/generator/context/sections/` | memory formatter 不决定 system 排布          |
| 收资表单                      | `src/tools/collection/`                 | 不塞进 `factsv2:`，不复用 `MemoryConfig` TTL |

判断新状态放在哪里时，依次问：它是纯判定、工具调用期业务动作、跨回合记忆，还是业务域数据。
纯判定归 `resolution/`，工具状态机归 `tools/`，记忆与 session hash 归 `memory/`，业务数据归
对应 `biz/` 域。

## 8. 排障路径

### 8.1 Prompt 看不到应该存在的信息

1. 先查 MPR 的 `promptBlocks`、`memorySnapshot` 与 `memoryLoadWarning`，确认是召回空、裁决隐藏，
   还是 section 条件省略。
2. 核对 `corpId / userId / sessionId / botUserId`。长期数据“存在但读不到”时，优先检查稳定
   `botUserId` 是否错用了轮换 `imBotId`。
3. 确认 `memory` / `turn-hints` 是否消费同一份 `adjudicatePromptMemory()` 结果；不要在渲染层
   重算裁决。
4. 若补料只出现在当轮，检查 `SnapshotEnrichmentService` 输出；它本来就不会写回存储。

### 8.2 7 天内原文缺失

1. 检查 Redis list `memory:short_term:chat:{chatId}` 是否含 provenance v2 条目。
2. 缓存异常时检查 `chat_messages` 的 `chatId`、查询时间边界与消息来源元数据。
3. 区分缓存 3 天 TTL 与滚动 7 天窗口（锚点是上次开口，不是当前时间）；缓存过期不应导致回查窗口缩短。
4. 再核对 300 条硬上限 / 24,000 字符裁剪是否符合预期。

### 8.3 会话事实、岗位工作台或阶段丢失

1. 分别查 `factsv2:{corpId}:{userId}:{sessionId}` 与 `stage:{corpId}:{userId}:{sessionId}`，
   不要把阶段当成 hash 字段查。
2. 查 `message_processing_records.post_processing_status`，定位具体失败步骤。
3. facts 缺失但 brand 存在或相反时，检查字段级原子写和 `apply_brand_state` trace；
   Redis hash 没有字段 TTL，不应从“单字段提前过期”解释问题。
4. 岗位反复出现时，沿 `save_candidate_pool → project_assistant_turn → drop_invalidated_jobs`
   核对写入顺序与 ledger。

### 8.4 长期档案或意向不正确

1. 查 `long-term:{corpId}:{userId}:{botUserId}`，再查 Supabase 同三维关系行，排除缓存旧值。
2. profile 未更新时比较字段 confidence rank；medium 不能覆盖报名写入的 high 是预期行为。
3. job intent 残留时区分“本段未提”与“明确清除”：前者保持旧值，后者应生成信封内空值。
4. 若数据只存在于无可靠 bot 血缘的存量行，冻结且不召回是预期安全策略。

### 8.5 摘要或水位异常

1. 查 delayed job 是否被每个成功回合刷新，以及到点时数据库最新消息是否真的已闲置 3 天。
2. 查 `consolidation_watermarks.bySession[sessionId]`，确认扫描起点没有越过或重复覆盖消息。
3. 查消息分页数量、首次接管的连续段裁剪与尾部 120 条摘要输入。
4. 对比三类写入：profile / intent 成功不代表摘要成功；摘要成功也不能替代独立水位。
5. 查 Bull 三次重试与 `memory.consolidation_failed` 事件。

### 8.6 收资进度缺失

直接检查 `src/tools/collection/`、`collection-form:` 实体 key 与
`collection-form-current:` 定位 key。该问题属于工具业务单据恢复，不应从 memory hash 或
consolidation 路径补救。

## 9. 不变量与沿革

- 记忆只分 short-term / long-term；episode 与 turnHints 不升级为层。
- 消息窗口、会话状态、咨询段边界分别遵守 7d / 3d / 3d。
- 长期关系档必须包含稳定 bot 维；不同托管账号默认隔离。
- summaries 保持单层数组、20 段上限、确定性淘汰、零 LLM 重写。
- consolidation 水位独立存储，永不伪装成用户记忆。
- 动态记忆保持 system 语义；Prompt 展示与工具采信使用各自明确的信任门。
- collection form 是 tools 单据，不属于记忆。

沿革：早期文档曾以“四层”、recent/archive 分级摘要和 settlement 命名描述实现；这些概念现已退役，当前统一为两层记忆、单层 episodes 与 consolidation。

## 相关文档

- [Memory 当前实现权威](../../src/memory/README.md)
- [记忆与状态全局视图](./memory-and-state.md)
- [候选人档案域架构](./candidate-profile-domain.md)
- [Agent 运行时架构](./agent-runtime-architecture.md)
- [最终 Prompt 装配示例](../../src/agent/generator/context/final-prompt-example.md)
