# Memory

本文只描述当前实现。记忆模块按作用域分为两层：`short-term` 与 `long-term`；`turnHints` 是本轮 sidecar，不是第三层记忆。

## 作用域与三个时间数

| 作用域              | 当前内容                          | 生命周期 / 边界   | 存储                     |
| ------------------- | --------------------------------- | ----------------- | ------------------------ |
| short-term 消息窗口 | 原始对话窗口                      | **7 天**          | `chat_messages` 查询窗口 |
| short-term 会话状态 | facts、工作台、阶段指针           | **3 天**          | Redis                    |
| 咨询段（episode）   | 本次连续咨询的消息切片            | **闲置 3 天**划界 | 无独立存储层             |
| long-term 关系档    | semantic 档案/意向、episodic 摘要 | 持久              | Supabase + Redis 缓存    |

三个对外口径固定为 **7d / 3d / 3d**：消息回看窗口 7 天、会话状态 TTL 3 天、闲置沉淀间隙 3 天。`factsv2:` 的实际 TTL 额外加 12 小时，只是保证 delayed job 先读取再过期的安全余量，不构成新的业务生命周期。

**短期不等于单次咨询。** 代码里的 session 是 `chatId`，即候选人 × bot 的关系，可跨多次咨询长期存在；业务里的 session 是连续咨询段，由闲置 3 天计算得到。消息窗口故意跨段保留 7 天，便于回访重建上下文。episode 只是裁剪与沉淀的计算边界，没有自己的 Redis key、表或目录。

## 当前目录

```text
src/memory/
├── memory.service.ts
├── memory.module.ts
├── memory.config.ts
├── memory.ports.ts
├── lifecycle.service.ts
├── recall.types.ts
├── confidence-rank.ts
├── fact-lines.formatter.ts
├── short-term/
│   ├── short-term.types.ts
│   ├── chat-history-cache.util.ts
│   ├── message-window.service.ts
│   ├── session-state.service.ts
│   ├── facts.service.ts
│   ├── workbench.service.ts
│   ├── brand-state.service.ts
│   ├── extraction.prompt.ts
│   └── session-key.ts
├── long-term/
│   ├── long-term.types.ts
│   ├── long-term.service.ts
│   ├── consolidation.service.ts
│   ├── consolidation-scheduler.service.ts
│   └── consolidation.processor.ts
└── stores/
    ├── redis.store.ts
    ├── deep-merge.util.ts
    ├── store.types.ts
    └── supabase.store.ts
```

`short-term/` 内部平铺：目录表达作用域，`short-term.types.ts` 的类型嵌套表达结构。`SessionStateService` 是结构化会话状态的薄门面；`SessionFactsService` 持有事实与 hash 状态；`SessionWorkbenchService` 持有岗位工作台与阶段指针。阶段仍使用独立 Redis key，但不再拥有独立 service 类。

收资表单不属于记忆系统。它的编排和存储都在：

```text
src/tools/collection/
├── collection-form.service.ts
└── collection-form.store.ts
```

## 归属判据与存储宪法

归属先按四句话判断：

1. 纯判定放 `resolution/`。
2. 只活在工具调用边界内的动作与状态机放 `tools/`。
3. 跨回合持续的记忆与 session hash 管辖状态放 `memory/`。
4. 业务数据所有权放 `biz/`。

域是纵向切片，层是横向网格；同名目录可以是同一域在不同层的切片。例如 `resolution/collection/` 负责零 IO 的纯判定，`tools/collection/` 负责工具流程与单据读写。

存储纪律：

- `resolution/` 永远零 IO。
- `memory/` 只保存记忆系统自己的窗口、session hash 与长期关系档。
- 各域单据自持存储，可直接使用通用 infra Redis 底座，并自持 TTL 配置。
- 收资单据默认 TTL 3 天；它与会话状态时间对齐是业务口径，不依赖 `MemoryConfig`。

`collection-form:` key 是“丢了算事故”的业务单据；移动目录不改变它的 key 形态、整实体快照语义或恢复责任。

## 对外召回契约

`memory.onTurnStart()` 返回 `MemoryRecallContext`：

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

- `shortTerm.sessionState` 是 `factsv2:` hash 的结构化投影。
- `shortTerm.stage` 是会话状态部件；因为仍使用独立 `stage:` key，所以并列注入。
- `turnHints` 只在当前轮生效，必须经过回合末验证与置信度合并后才能成为持久事实。
- episodic 摘要不进默认召回；需要时显式调用 `recall_history`。
- `AgentMemoryContext` 暂时保留为兼容别名，调用方继续收口到 `MemoryRecallContext`。

Prompt 内的 `[会话记忆]`、`[用户档案]`、`[本轮解析线索]` 等标签是模型可见契约，代码字段重排不改变这些文本。

## Short-term

### 消息窗口

`MessageWindowService` 从 `chat_messages` 读取最近 7 天消息，再按条数、字符数与当前时间裁剪。窗口比会话状态存活更久是设计意图：状态过期后，回访仍可利用原文重建上下文。

### 会话状态与工作台

`SessionStateService` 对外提供薄门面，内部职责拆为：

- facts：候选人结构化事实、已邀群、终态与活动水位；
- workbench：候选岗位池、已展示岗位、当前焦点岗位、查询签名；
- stage：下一轮读取的业务阶段指针。

Redis 契约：

- `factsv2:{corpId}:{userId}:{sessionId}`：facts + workbench，基准 3 天，实际带 12 小时沉淀余量；
- `stage:{corpId}:{userId}:{sessionId}`：阶段指针，3 天。

Redis hash 没有字段级 TTL，因此 `factsv2:` 内的 facts 与 workbench 共同享有 12 小时余量。

### facts 与 brand

`SessionFacts` 的字段通常使用带 `value / confidence / source / evidence` 的信封。`facts.brand` 是例外：它原样保存 `PersistedBrandState`，不再套一层事实信封。

品牌写入纪律不变：

- `BrandStateService` reducer 是唯一写者；
- 回合收尾在事实提取之后执行，提取失败也不跳过；
- 旧顶层品牌字段只在读取时懒迁移到 `facts.brand`；
- 观测事件 `brand_state_change` 与 trace 步骤 `apply_brand_state` 保持不变。

## Long-term

长期关系档按 `(corpId, userId, botUserId)` 隔离。`botUserId` 使用托管账号稳定的 `wecomUserId`；轮换的 `imBotId` 只用于渠道调用或血缘排障，不参与长期主键。

存储形态：

- Redis：`long-term:{corpId}:{userId}:{botUserId}`；旧的无 bot key 自然过期；
- Supabase：`agent_long_term_memories` 的 `bot_user_id` 参与唯一关系维；
- `semantic_profile`：身份档案；
- `semantic_job_intent`：长期求职意向；
- `episodic_session_summaries`：裸 `SummaryEntry[]`，保存 7 天消息窗口之外的每段咨询摘要；
- `consolidation_watermarks`：独立工作水位列，不属于记忆内容，也不进入召回契约。

摘要数组按时间从旧到新排列，最多保留 20 段，超限时确定性淘汰最老段；已写入条目
永不再交给 LLM 重写。旧 `{ recent, archive, lastSettled* }` 在读取时懒迁移：recent
反转并入裸数组，archive 文本补为空标识符 `SummaryEntry` 置于头部，旧水位写入独立列。
`episodic_session_summaries` 列名保持不变。

没有可验证 bot 血缘的存量行保持冻结且不参与读取；有可靠血缘的数据才拆到关系行。长期召回不再做跨 bot 来源研判，也不渲染跨咨询泛指横幅。

`semantic_profile` 保留两条写入路径：

1. consolidation 从 session facts 提拔身份字段，通常保留 medium 置信度；
2. booking 成功写入 high，是最高置信来源，不是唯一来源。

两路共用置信度守卫：高置信值粘住，低置信值不能覆盖高置信值。工具侧仍默认只 unwrap high；Prompt 可以展示带置信度的档案供模型判断与追问。

### 沉淀总装图（consolidation：三种产出、三套写法）

```text
┌─ 输入（每段咨询沉淀一次，闲置满 3 天定时触发）────────────────┐
│  A. chat_messages 本段原文（水位之后 → 最新，尾截 120 条）     │
│     ← 摘要的主料；terminal/推过什么岗等信息由摘要 LLM 从原文读  │
│  B. sessionFacts 的 facts 舱                                │
│     （interview_info + preferences + brand.currentBrand）    │
│     ← 档案与意向快照的全部来源；workbench 舱与簿记字段不参与    │
└──────────────────┬─────────────────────────────────────────┘
                   ▼
  ① 档案 semantic_profile      来源 B 的 interview_info（9 键）
     写法【守卫合并】           逐字段写入，置信度一律压 medium；
                              SQL rank 守卫：medium 顶不掉 booking 写的 high
     哲学：档案是累积的——越确认越硬，好值粘住不退

  ② 意向快照 semantic_job_intent  来源 B 的 preferences（11 键）+ brand.currentBrand
     写法【整组覆盖】           不 merge，最新一段全赢；
                              信封内空值 = 显式墓碑（“不要了”清掉旧值，“没提”不动）
     哲学：意向是易变的——只信最新，旧的整组作废

  ③ 经历摘要 episodic_session_summaries  来源 A 的聊天原文（+B 作参考）
     写法【追加淘汰】           LLM 写一条 150 字四节摘要（全管线唯一 LLM 调用），
                              追加进列表；上限 20 段淘汰最老；已写条目永不再改
     哲学：经历是不可变的——只增不改，像日记不像草稿

┌─ 收尾 ─────────────────────────────────────────────────────┐
│  水位推进：①② 同一 RPC 原子写；③ 与水位同一 RPC 原子写；       │
│  顺序 = 先事实后摘要（事实覆盖写幂等，摘要失败 Bull 重试无重复伤害）│
└────────────────────────────────────────────────────────────┘
```

三套写法对应三种数据的天性：**事实越证越硬（合并）、意向喜新厌旧（覆盖）、经历落笔成史（追加）**。

## 回合生命周期

### `onTurnStart`

`MemoryLifecycleService` 并行读取：

1. 7 天消息窗口；
2. `factsv2:` 会话状态；
3. 独立 `stage:` 阶段指针；
4. 当前候选人 × bot 的长期 profile 与 job intent。

返回两层召回契约后，`PreparationService` 才可调用
`SnapshotEnrichmentService` 补齐当轮快照的缺失线索；这是 generator 备料步骤，
不是 memory lifecycle，也不改写记忆存储。复聊使用同一召回入口的投影，不另造记忆层。

### `onTurnEnd`

回合收尾按固定顺序更新工作台和事实，并在结束时注册或刷新同一 chat 的 delayed consolidation job。新队列与 job 标识统一使用 `consolidation` 词根。

任务约 3 天后到点时：

1. 重新读取 DB 最新消息时间并校验确已闲置；未达标则按剩余时间重排；
2. 用 `consolidation_watermarks.bySession[sessionId]` 判断是否已覆盖，做到幂等；
3. 摘要消息片段，写 episodic 摘要；
4. 提拔 profile 与 job intent，写当前 bot 关系档；
5. 单次 DB UPDATE 原子追加摘要并推进独立沉淀水位。

Bull job 失败使用指数退避，最多 3 次；最终失败通过 `IncidentReporterService` 写入可观测告警 `memory.consolidation_failed`，不会只留本地日志。

12 小时 facts TTL 余量保证正常 delayed job 在事实过期前读取；任务的 DB 闲置复核与
`consolidation_watermarks.bySession` 水位分别防止过早执行与重复沉淀。

## 兼容契约

下列名字是兼容边界，不随内部结构改名：

- Redis 前缀：`factsv2:`、`stage:`、`collection-form:`；
- env：`MEMORY_SESSION_TTL_DAYS`、`MEMORY_SETTLEMENT_GAP_DAYS`、`MEMORY_HISTORY_WINDOW_DAYS`；
- DB RPC：包括 `mark_long_term_settled_boundary` 在内的既有同名接口；
- test-suite fixture：`setup.procedural`；
- 全部模型可见 Prompt 标签；
- 观测事件 `brand_state_change` 与 trace 步骤 `apply_brand_state`。

DB RPC 若需要改参数，迁移必须 `DROP FUNCTION` 后以同名重新创建，不能依赖 `CREATE ... IF NOT EXISTS` 改签名。

## CoALA 类型映射

类型词用于理解，不用于顶层目录命名：

| CoALA 类型    | 当前落点                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| episodic 原料 | message window + `chat_messages`                                             |
| semantic      | short-term facts + `longTerm.semantic.{profile, jobIntent}`                  |
| working       | short-term workbench（含阶段指针）+ `agent/generator/preparation/`           |
| episodic 蒸馏 | `episodic_session_summaries`                                                 |
| procedural    | 不在 memory：手册、工具 description、`tools/collection` 状态机；台账只做索引 |

这里的关键是映射可查，而不是把类型词塞进每个目录名。
