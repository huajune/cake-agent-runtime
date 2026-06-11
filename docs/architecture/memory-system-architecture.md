# Agent 记忆系统架构

**最后更新**：2026-06-11

> 这份文档描述当前主链路中真正生效的实现。模块内部的详细职责分解参见
> [`src/memory/README.md`](../../src/memory/README.md)。
> 端到端数据流参见 [`memory-and-hints-data-flow.md`](./memory-and-hints-data-flow.md)。

---

## 1. 设计理念

基于认知科学的记忆分类模型（CoALA 框架），把 Agent 记忆分为四类正式层 + 一类旁路。核心原则：

- **编排层固定读写**：记忆的读取 / 回写是 Agent Loop 的固定前置/后置步骤，不由 LLM 自主决定
- **按需工具补充**：大体量、非每轮必需的记忆（如历史摘要）通过工具按需检索
- **语义命名**：代码命名体现"这是什么记忆"，而非"存在哪里"
- **facade 单入口**：编排层只通过 `MemoryService` 读写，不直接操作 Redis / Supabase

---

## 2. 四层记忆 + 旁路解析

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Agent Loop（编排层）                              │
│                                                                     │
│  onTurnStart:  一次性读取四类记忆 + 当轮高置信识别 → 注入 prompt        │
│  onTurnEnd:    Agent 完成后 → 写会话态 + 触发后置事实提取              │
│                                                                     │
├──────────── 正式记忆（持久化）────────────────────────────────────────┤
│                                                                     │
│  ┌── 短期记忆 (Short-term / Working Memory) ──────────────────────┐  │
│  │  chat_messages（Supabase 永久） + Redis 窗口热缓存               │  │
│  │  → 读：Redis 优先，DB 兜底；DB 回查边界与 historyWindow 对齐      │  │
│  │  → 写：业务写 chat_messages 后同步镜像到 Redis                   │  │
│  │  → 最终裁剪为 ShortTermMessage[] 注入 LLM context                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌── 会话记忆 (Session Memory) ───────────────────────────────────┐  │
│  │  本次求职会话的结构化业务状态：                                   │  │
│  │    facts / lastCandidatePool / presentedJobs /                 │  │
│  │    currentFocusJob / invitedGroups                             │  │
│  │  → Redis，key: facts:{corpId}:{userId}:{sessionId}，TTL 见 §5   │  │
│  │  → 回合结束异步更新；闲置超时后关键字段沉淀到长期记忆              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌── 程序记忆 (Procedural Memory) ────────────────────────────────┐  │
│  │  STAGE = 招聘流程阶段 + 最近一次推进来源/时间/原因                │  │
│  │  → Redis，key: stage:{corpId}:{userId}:{sessionId}              │  │
│  │  → 唯一写入口：advance_stage 工具                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌── 长期记忆 (Long-term Memory) ─────────────────────────────────┐  │
│  │  profile_facts：跨会话稳定身份，字段级携带置信度/来源/证据          │  │
│  │  preference_facts：跨会话稳定求职意向（快照式整组覆盖）            │  │
│  │  summary：recent[] + archive（分层压缩）+ lastSettledMessageAt   │  │
│  │           + lastSettledBySession（按会话隔离的沉淀边界）          │  │
│  │  → Supabase agent_long_term_memories 每用户一行 + Redis 2h 缓存   │  │
│  │  → 来源：SettlementService 在空闲超时触发时写入                   │  │
│  │  → 读取：profile_facts + preference_facts 固定注入；               │  │
│  │         summary 通过 recall_history 按需读                       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
├──────────── 旁路解析（非持久化）──────────────────────────────────────┤
│                                                                     │
│  ┌── 本轮高置信线索 (highConfidenceFacts) ───────────────────────┐    │
│  │  对"本轮 user 最新消息"做一次规则 + 别名识别                     │    │
│  │  → 每个字段统一携带 value / confidence / source / evidence       │    │
│  │  → 注入本轮 prompt，不落库；工具侧只消费 high 字段                │    │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 短期记忆 (Short-term / Working Memory)

**定义**：当前对话窗口内容，直接作为模型对话上下文。

**真相源**：`chat_messages` 表（Supabase 永久存储）。业务消息先写该表，memory 模块读取并镜像到 Redis 窗口做热缓存。

**读取逻辑**（[`short-term.service.ts`](../../src/memory/services/short-term.service.ts)）：

1. 先从 Redis 窗口缓存读取最近消息
2. Redis miss 时，回退到 `ChatSessionService.getChatHistory(chatId, maxMessages)`
3. DB fallback 的时间边界与 `historyWindowSeconds` 对齐
4. miss 回退后把 DB 结果回填到 Redis
5. 给每条消息注入时间上下文
6. 按字符上限裁剪，最终输出 `ShortTermMessage[]`

**窗口策略**：

| 限制维度 | 默认值 | 环境变量 |
|---------|--------|---------|
| 最大消息条数 | 60 条 | `MAX_HISTORY_PER_CHAT` |
| 时间窗口 | 7 天 | `MEMORY_HISTORY_WINDOW_DAYS` |
| 总字符上限 | 12000 | `AGENT_MAX_INPUT_CHARS` |

**空兜底**：WeCom 聚合/重跑时如果 Redis/DB 都为空，`memory-lifecycle` 会用调用方提供的 `currentUserMessage` 构造一条 user fallback，避免 `messages=[]` 直接抛错。

### 2.2 会话记忆 (Session Memory)

**定义**：本次求职会话的结构化业务状态（session 级，非 user 级）。

**存储**：Redis，key `facts:{corpId}:{userId}:{sessionId}`，TTL = `sessionTtl`。

**字段**（[`session-facts.types.ts`](../../src/memory/types/session-facts.types.ts)）：

```typescript
interface WeworkSessionState {
  /** 结构化事实（LLM 后置提取） */
  facts: SessionFacts | null;
  /** 每轮覆盖：最后一次 duliday_job_list 返回的候选岗位池 */
  lastCandidatePool: RecommendedJobSummary[] | null;
  /** 最近几轮真正发给候选人的岗位 */
  presentedJobs: RecommendedJobSummary[] | null;
  /** 候选人当前明确在聊或准备报名的岗位 */
  currentFocusJob: RecommendedJobSummary | null;
  /** 本会话中已邀入的兼职群 */
  invitedGroups: InvitedGroupRecord[] | null;
}

interface EntityExtractionResult {
  interview_info: {
    name | phone | gender | age | applied_store | applied_position |
    interview_time | is_student | education | has_health_certificate
  };
  preferences: {
    brands: string[] | null;
    salary: string | null;
    position: string[] | null;
    schedule: string | null;
    city: CityFact | null;     // { value, confidence, evidence }
    district: string[] | null;
    location: string[] | null;
    labor_form: string | null;
  };
  reasoning: string;
}
```

**city 字段**：现在是 `CityFact = { value, confidence, evidence }`，evidence 枚举：`municipality_compact | explicit_city | unique_district_alias | hotspot_alias`。兼容旧字符串数据，自动归一化。

**读写时机**：
- 读取：每回合 `onTurnStart` 固定拉取
- 写入：每回合 `onTurnEnd` 串行写候选池 / 岗位投影 / 后置事实提取
- 提取范围：`trimToCurrentSessionSegment()` 按消息间隙（≥`settlementGapSeconds`）截到最近连续会话段，避免跨会话串味
- 合并策略：`deep-merge.util` —— null/undefined/空串不覆盖旧值，对象递归合并，数组去重合并；`saveFacts` 经 `mergeFactsWithConfidenceGuard`，跨轮低置信不覆盖高置信
- 时间锚：每个字段写入时打 `extractedAt`；evidence 入库经 `truncateEvidence()` 截断 `MAX_FACT_EVIDENCE_CHARS=200` 字
- 沉淀：`chat_messages` 中出现消息间隔 ≥ `settlementGapSeconds` 时，上一段旧会话沉淀到 Summary；画像字段从当前 Redis `sessionFacts` 抽取

### 2.3 程序记忆 (Procedural Memory)

**定义**：招聘流程的当前阶段，控制 Agent "怎么做事"。

**存储**：Redis，key `stage:{corpId}:{userId}:{sessionId}`，TTL = `sessionTtl`。

**字段**（[`procedural.types.ts`](../../src/memory/types/procedural.types.ts)）：

```typescript
interface ProceduralState {
  currentStage: string | null;  // 当前阶段
  fromStage: string | null;     // 上一阶段（推进前）
  advancedAt: string | null;    // 推进时间
  reason: string | null;        // 推进原因（审计用）
}
```

**阶段流转**：
```
trust_building → needs_collection → job_recommendation → interview_arrangement
  (信任建立)      (需求收集)         (岗位推荐)           (面试安排)
```

**读写时机**：
- 读取：每回合 `onTurnStart` 固定拉取 → 注入 systemPrompt（决定加载哪套阶段策略）
- 写入：仅由 `advance_stage` 工具通过 `MemoryService.setStage()` 写入。阶段合法性在工具层校验，memory store 不做业务判断。

### 2.4 长期记忆 (Long-term Memory)

**定义**：跨会话复用的用户稳定信息、稳定求职意向 + 历次求职经历摘要。

**存储**：Supabase `agent_long_term_memories` 表（每用户一行）+ Redis 整行 2h 缓存。

**三部分**（[`long-term.types.ts`](../../src/memory/types/long-term.types.ts)）：

#### Profile Facts（身份信息）

```typescript
interface UserProfileFactValue<T> {
  value: T;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  source:
    | 'candidate'
    | 'llm'
    | 'rule'
    | 'system'
    | 'memory'
    | 'derived'
    | 'booking'
    | 'extraction'
    | 'enrichment';
  evidence: string;
  updatedAt: string;
}

interface UserProfileFacts {
  name: UserProfileFactValue<string> | null;
  phone: UserProfileFactValue<string> | null;
  gender: UserProfileFactValue<string> | null;
  age: UserProfileFactValue<string> | null;
  is_student: UserProfileFactValue<boolean> | null;
  education: UserProfileFactValue<string> | null;
  has_health_certificate: UserProfileFactValue<string> | null;
}
```

- 读取：每回合 `onTurnStart` 固定注入 `[用户档案]`，**只保留字段值、置信度、来源、更新日期**（注入瘦身，不带 evidence 全文；evidence 是排障字段）
- 工具消费：进入工具上下文时统一 unwrap，只传高置信字段，低/中/未知置信字段交给大模型判断是否追问
- 写入：`SettlementService` 在沉淀时从 session facts 抽身份字段；预约成功通过 `writeFromBooking()` 写入 `booking/high`；外部补充通过 `MemoryService.saveProfile()` 写入

#### Preference Facts（跨会话稳定求职意向）

存于 `preference_facts` 列（[`LONG_TERM_PREFERENCE_FIELD_KEYS`](../../src/memory/types/long-term.types.ts)）：

```typescript
// 只收跨会话稳定的意向，排除单次 episode 临时态（short_term/time_windows/open_position）
const LONG_TERM_PREFERENCE_FIELD_KEYS = [
  'city', 'district', 'location', 'brands', 'position', 'schedule',
  'salary', 'labor_form', 'schedule_constraint', 'delayed_intent', 'available_after',
];
```

- 覆盖语义：**快照式整组覆盖**（最新一段会话的意向赢），与 session facts 的 deepMerge 累积不同——累积会让错值/错字变体永远清不掉
- 唯一写方：`SettlementService`
- 读取：注入为 prompt 的 `[历史求职意向]` 段（`formatLongTermPreferences`），带更新日期与“本次优先”指引；过期的 `available_after` 不渲染
- **不进工具预填**：仅供大模型参考，不参与程序化判断

#### Summary（分层压缩的对话摘要）

```typescript
interface SummaryData {
  recent: SummaryEntry[];        // 最近 N 条详细摘要（MAX_RECENT_SUMMARIES = 5）
  archive: string | null;        // 更早的被 LLM 压缩合并成一段自然语言总结
  lastSettledMessageAt: string | null;  // 全局兜底的已沉淀消息边界
  lastSettledBySession?: Record<string, string> | null; // 按会话隔离的沉淀边界（sessionId → 边界时间）
}

interface SummaryEntry {
  summary: string;
  sessionId: string;
  startTime: string;
  endTime: string;
}
```

**压缩策略**：
1. 每次沉淀，生成一条 `SummaryEntry` 追加到 `recent` 头部
2. 当 `recent.length > 5` 时，最早条目移出
3. 移出的条目与现有 `archive` 一起，由 LLM 压缩合并为新的 `archive`

**不固定注入的原因**：摘要条数不定且会越积越多，固定注入浪费 token；大部分对话不需要回顾历史，让 LLM 通过 `recall_history` 工具按需检索更高效。

### 2.5 旁路：本轮高置信线索 (highConfidenceFacts)

**定义**：针对"本轮 user 最新消息"的规则 + 别名前置识别结果。

**能力**（[`facts/high-confidence-facts.ts`](../../src/memory/facts/high-confidence-facts.ts)）：
- 品牌规范化（基于 sponge 品牌表 alias 匹配，资产经 `getBrandMatchAssets` memoize）
- 城市识别（直辖市简写 / 明确城市 / 唯一区域别名 / 商圈 alias），“X 附近”停用词见 `NEARBY_LOCATION_STOPWORDS`
- 用工形式 / 年龄 / 身高 / 体重 / 户籍省份等规则字段

**规则层注册表化**：无字段间联动的标量/数组字段统一走 `FIELD_EXTRACTORS` 注册表（主循环遍历应用）；联动字段（gender 联动 / city 三件套 / brands 品类展开 / schedule_constraint / available_after / is_student+education）仍保留手写。模块加载期 `assertRegistryFieldsMirrored()` 自检注册表字段在各处镜像一致。

**关键边界**：
- 只看**当前轮新消息**，不 fallback 到历史窗口
- 注入本轮 prompt sidecar（`[本轮高置信线索] / [本轮待确认线索]`）
- **不写入 Redis / Supabase，不参与后置事实提取落库**

因此它不是正式记忆层，是当前轮前置解析 sidecar。

---

## 3. 读写时序

### 3.1 每回合对话 — onTurnStart

[`memory-lifecycle.service.ts`](../../src/memory/services/memory-lifecycle.service.ts) 负责编排。

```
用户消息到达
  │
  ├── onTurnStart(corpId, userId, sessionId, currentUserMessage?, options)
  │   │
  │   ├── 并行读取：
  │   │   ├── short-term messages     (Redis → DB fallback)
  │   │   ├── session state           (Redis)
  │   │   ├── procedural state        (Redis)
  │   │   └── profile_facts           (Redis cache → Supabase)
  │   │
  │   ├── 短期窗口空兜底：如为空且 currentUserMessage 非空，兜一条 user 消息
  │   ├── 前置高置信识别：basedOn currentUserMessage + brandList → highConfidenceFacts
  │   ├── 可选 enrichment：options.enrichmentIdentity 提供时向外部系统补全缺失字段
  │   │
  │   └── 返回 MemoryRecallContext {
  │         shortTerm.messageWindow,
  │         sessionMemory,
  │         highConfidenceFacts,
  │         procedural,
  │         longTerm.profile,
  │         longTerm.preferences,
  │         _warnings?
  │       }
  │
  ├── Agent 组装 prompt + 注入记忆 → 调用 LLM
  │   │
  │   └── LLM 可能调用的工具：
  │       ├── advance_stage      — 推进流程阶段（程序记忆写入）
  │       ├── recall_history     — 按需检索长期 summary
  │       └── invite_to_group    — 记录已邀入群（→ MemoryService.saveInvitedGroup）
  │
  └── onTurnEnd(ctx, assistantText?) — 回合收尾
```

### 3.2 每回合收尾 — onTurnEnd

```
1. 读旧 sessionState（用于沉淀判定）
2. 分支 A：settlement（可选）
   └── 若 chat_messages 中出现 gap ≥ settlementGapSeconds → 触发沉淀
3. 分支 B：session_turn_end_updates（串行，避免 Redis 状态互覆盖）
   ├── save_candidate_pool         (ctx.candidatePool → lastCandidatePool)
   ├── project_assistant_turn      (岗位投影 → presentedJobs / currentFocusJob)
   └── extract_facts               (后置 LLM 事实提取 → facts)
4. 把每一步的 success/skipped/failure 写入 message_processing_records.post_processing_status
```

**关键点**：settlement 使用 `load_previous_state` 读到的原始 `sessionFacts`，保留字段 metadata，写长期画像时会把原字段 source/confidence/evidence 带入长期 evidence。

**回合收尾纳入处理锁**：WeCom 链路用 `deferTurnEnd=true` 让回合收尾延迟到投递阶段——turn-end 与后续投递并行执行，但必须在释放 chat 处理锁前 `await` 完成（`reply-workflow` 的 finally）。否则收尾仍在异步写 session state 时，会与下一个 job 的读写并发，整份覆盖写互相丢更新。首次调用若被 replay 丢弃，记忆投影/事实提取也一同被丢弃，避免「未发出的回复」污染 session 记忆。

### 3.3 会话沉淀 — Settlement

[`settlement.service.ts`](../../src/memory/services/settlement.service.ts)

```
detectAndSettle(): chat_messages 中出现 gap ≥ settlementGapSeconds
  │
  ├── 边界判定：取 summary_data.lastSettledBySession[sessionId]，
  │   缺失再回退全局 lastSettledMessageAt
  │   → 分页扫描边界后消息（每页 SETTLEMENT_FETCH_LIMIT=500，最多 MAX_PAGES=10）
  │
  ├── 身份字段沉淀 → profile_facts
  │   使用 Redis sessionFacts 中已校验/清洗过的结构化事实
  │   从 facts.interview_info 抽 name/phone/gender/age/is_student/education/has_health_certificate
  │   → Supabase agent_long_term_memories.profile_facts 字段级合并
  │   → 已有 high 字段不会被非 high 覆盖
  │
  ├── 稳定意向沉淀 → preference_facts
  │   从 LONG_TERM_PREFERENCE_FIELD_KEYS 抽稳定意向，整组覆盖写入
  │
  ├── 对话摘要 → Summary
  │   读边界后到旧会话断点之间的消息（输入截尾最近 SUMMARY_MAX_MESSAGES=120 条）
  │   + facts 中的求职意向 → LLM 生成 ≤100 字摘要
  │   → 通过 RPC append_long_term_summary_atomic（行锁内）追加到 summary_data.recent；
  │     溢出部分 LLM 合并进 archive（≤200 字）；带 p_session_id 同步写 lastSettledBySession
  │   → 通过 RPC mark_long_term_settled_boundary（带 p_session_id）原子更新沉淀边界
  │
  └── 不反写 Redis 会话态；Redis key 自然过期；沉淀边界按会话隔离，
      双 bot 服务同一候选人时不再互相推进彼此边界
```

---

## 4. 工具策略

### 4.1 保留的工具

| 工具 | 记忆类型 | 操作 | 保留原因 |
|------|---------|------|---------|
| `advance_stage` | 程序记忆 | 写入 | 只有 LLM 能判断阶段推进时机 |
| `recall_history` | 长期记忆（summary） | 读取 | 历史摘要按需检索，避免 token 浪费 |
| `invite_to_group` | 会话记忆（invitedGroups） | 写入 | 群邀请是 LLM 决策触发的副作用，发卡后需回写记录 |

### 4.2 已删除 / 不再存在的工具

| 工具 | 删除原因 |
|------|---------|
| `memory_recall` | 编排层 `onTurnStart` 已固定注入全部当前记忆 |
| `memory_store`  | 编排层 `onTurnEnd` 已通过后置事实提取结构化写回，LLM 随意写会格式不一致 |

**设计原则**：编排层保证 LLM 一定知道"当前状态"，工具让 LLM 可以主动"翻阅历史"或"登记副作用"。结构化写入由编排层统一控制。

---

## 5. 服务周期与时间常量

记忆系统中多个时间参数围绕同一个业务概念——**单次求职服务周期**（候选人打招呼到上岗的完整过程）。

### 5.1 服务周期定义

```
单次求职服务周期 (Service Cycle)
= 候选人首次发消息 → 咨询 → 面试安排 → 入职确认
= 典型时长：1~7 天
= 当前默认服务间隔：1 天（settlementGapSeconds）
```

**空闲超时判定**：连续两条消息之间的时间差达到 `settlementGapSeconds`，即认为前一段会话已经结束。

### 5.2 时间常量总表

所有时间配置统一由 [`MemoryConfig`](../../src/memory/memory.config.ts) 管理：

| 常量 | 默认值 | 环境变量 | 说明 |
|------|--------|---------|------|
| `sessionTtl` | 2 天（172800 s） | `MEMORY_SESSION_TTL_DAYS` | Redis 会话级数据 TTL；常见环境配置为 3 天 |
| `settlementGapSeconds` | 1 天（86400 s） | `MEMORY_SETTLEMENT_GAP_DAYS` | 消息间隔达到该值时触发旧会话沉淀 |
| `historyWindowSeconds` | 7 天（604800 s） | `MEMORY_HISTORY_WINDOW_DAYS` | 短期窗口 DB fallback 回查边界 |
| `sessionWindowMaxMessages` | 60 | `MAX_HISTORY_PER_CHAT` | 短期记忆最大消息条数 |
| `sessionWindowMaxChars` | 12000 | `AGENT_MAX_INPUT_CHARS` | 短期记忆总字符上限（超限从最早消息开始裁剪） |
| `sessionExtractionIncrementalMessages` | 10 | `SESSION_EXTRACTION_INCREMENTAL_MESSAGES` | 已有 facts 时，后置提取只重看最近 N 条 |
| `longTermCacheTtl` | 2h（7200 s） | — | `agent_long_term_memories` 整行在 Redis 的缓存时长（硬编码） |
| `MAX_RECENT_SUMMARIES` | 5 | — | `summary.recent` 最多保留多少条（溢出压缩进 archive） |

**核心约束**：`sessionTtl`、`settlementGapSeconds`、`historyWindowSeconds` 已经分离。Redis 存活、沉淀判定、DB 回查窗口分别调优。

---

## 6. 存储后端

| 记忆类型 | 存储后端 | 主键 / Key | TTL | 写入策略 |
|---------|---------|-----------|-----|---------|
| 短期记忆 | Supabase `chat_messages` + Redis 窗口缓存 | `chat_id` / `session:{id}` | 永久 / 会话级 | 业务写 chat_messages，memory 同步镜像到 Redis |
| 会话记忆 | Redis | `facts:{corpId}:{userId}:{sessionId}` | `sessionTtl` | deepMerge（null 不覆盖，数组去重合并） |
| 程序记忆 | Redis | `stage:{corpId}:{userId}:{sessionId}` | `sessionTtl` | 覆盖写 |
| 长期记忆 | Supabase `agent_long_term_memories` + Redis 整行缓存 | `(corp_id, user_id)` 唯一 / `long-term:{corpId}:{userId}` | 永久 / 2h 缓存 | Profile facts 字段级合并；Summary 分层压缩 |

---

## 7. agent_long_term_memories 表结构

每用户一行，Profile facts、Summary / message_metadata 均以 jsonb 存储。

| 字段 | 类型 | 说明 |
|------|------|------|
| **基础** | | |
| `id` | uuid | 主键 |
| `corp_id` | string | 企业 ID |
| `user_id` | string | 用户 ID |
| **Profile Facts（jsonb）** | | |
| `profile_facts` | jsonb | `{ name, phone, gender, age, is_student, education, has_health_certificate }`，每个字段为 fact wrapper 或 null |
| **Preference Facts（jsonb）** | | |
| `preference_facts` | jsonb? | 跨会话稳定求职意向，键见 `LONG_TERM_PREFERENCE_FIELD_KEYS`，快照式整组覆盖 |
| **Summary（jsonb）** | | |
| `summary_data` | jsonb? | `{ recent: SummaryEntry[], archive, lastSettledMessageAt, lastSettledBySession }` |
| **消息元数据（jsonb）** | | |
| `message_metadata` | jsonb? | `{ botId, imBotId, imContactId, contactType, contactName, externalUserId, avatar }` |
| **时间戳** | | |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 最后更新时间 |

**唯一约束**：`(corp_id, user_id)`。

`profile_facts` 单字段结构：

```json
{
  "value": "19986247174",
  "confidence": "high",
  "source": "booking",
  "evidence": "报名成功后写入",
  "updatedAt": "2026-05-27T10:00:00.000Z"
}
```

`confidence` 语义：

| 值 | 含义 | 工具消费 |
|----|------|----------|
| `high` | 可程序化采用。来自确定性规则、明确结构化输入，或经过强校验的事实 | 默认消费 |
| `medium` | 可给模型参考。通常来自 LLM 结构化提取、会话沉淀或外部补全 | 默认不消费 |
| `low` | 弱参考。来自系统兜底、弱规则或补充接口 | 不消费 |
| `unknown` | 旧数据或缺少元数据的兼容值 | 不消费 |

`source` 语义：

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

**设计原因**：
- Profile facts 与 highConfidenceFacts / sessionFacts 的字段结构保持一致
- 给大模型时保留所有字段的置信度和证据
- 工具消费时可以统一 unwrap 高置信字段，避免低置信字段参与程序化判断
- 每用户一行 → 不需要 type 字段区分

---

## 8. 字段归属对照

FACTS 提取的字段按稳定性拆分到不同记忆层。

| 字段 | 稳定性 | 归属 | 存储 |
|------|--------|------|------|
| `name` | 基本不变 | **Profile facts** | Supabase 永久 |
| `phone` | 基本不变 | **Profile facts** | Supabase 永久 |
| `gender` | 基本不变 | **Profile facts** | Supabase 永久 |
| `age` | 半稳定 | **Profile facts** | Supabase 永久 |
| `is_student` | 半稳定 | **Profile facts** | Supabase 永久 |
| `education` | 半稳定 | **Profile facts** | Supabase 永久 |
| `has_health_certificate` | 半稳定 | **Profile facts** | Supabase 永久 |
| `applied_store` / `applied_position` / `interview_time` | 每次不同 | **Session facts.interview_info** | Redis `sessionTtl` |
| `labor_form` / `brands` / `salary` / `position` / `schedule` / `city` / `district` / `location` 等 | 每次不同（但有跨会话稳定意向） | **Session facts.preferences**；稳定意向沉淀到 **Long-term preference_facts** | Redis `sessionTtl` / Supabase 永久 |
| `lastCandidatePool` / `presentedJobs` / `currentFocusJob` | 会话级推导 | **Session Memory 顶层** | Redis `sessionTtl` |
| `invitedGroups` | 会话级副作用 | **Session Memory 顶层** | Redis `sessionTtl` |

---

## 9. 模块结构

```
src/memory/
├── memory.service.ts                 # 对外 facade
├── memory.config.ts                  # 时间 / 窗口 / 缓存配置
├── memory.module.ts
├── README.md                         # 模块内部实现说明（真相源）
│
├── services/                         # 领域服务
│   ├── memory-lifecycle.service.ts   # onTurnStart / onTurnEnd 编排
│   ├── short-term.service.ts         # chat_messages + Redis 窗口
│   ├── session.service.ts            # 会话态读写 + 岗位投影 + 后置事实提取
│   ├── procedural.service.ts         # 阶段状态读写
│   ├── long-term.service.ts          # profile_facts / summary 持久化
│   ├── settlement.service.ts         # 会话沉淀
│   ├── memory-enrichment.service.ts  # 外部系统补全身份字段
│   ├── session-job-matching.ts       # 岗位投影匹配
│   └── session-extraction.prompt.ts  # 后置事实提取 prompt
│
├── stores/                           # 基础设施
│   ├── redis.store.ts
│   ├── supabase.store.ts
│   ├── deep-merge.util.ts
│   └── store.types.ts
│
├── types/                            # 类型定义
│   ├── memory-runtime.types.ts       # MemoryRecallContext (onTurnStart 返回)
│   ├── short-term.types.ts
│   ├── session-facts.types.ts        # 含 EntityExtractionResult / CityFact
│   ├── procedural.types.ts
│   └── long-term.types.ts
│
├── facts/                            # 规则 / 别名识别
│   ├── high-confidence-facts.ts      # 当前轮高置信识别（旁路），含 FIELD_EXTRACTORS 注册表
│   ├── fact-merge.util.ts            # 规则/LLM 合并 + 跨轮置信度守卫共享原语
│   ├── geo-mappings.ts               # 城市 / 区域 / 商圈别名
│   ├── labor-form.ts                 # 用工形式规范化
│   └── name-guard.ts                 # 姓名真伪判定
│
└── formatters/
    └── fact-lines.formatter.ts       # 把 facts 渲染为 prompt 行
```

### 9.1 MemoryService 对外入口

```typescript
// 回合开始：读取四类记忆 + 当轮高置信识别
const memory = await this.memory.onTurnStart(
  corpId, userId, sessionId,
  currentUserMessage?,
  { includeShortTerm?, shortTermEndTimeInclusive?, enrichmentIdentity? },
);

// 回合结束：写回会话态 + 触发后置提取
await this.memory.onTurnEnd(
  { corpId, userId, sessionId, messageId?, normalizedMessages, candidatePool? },
  assistantText?,
);

// 长期摘要按需读取（供 recall_history）
const summary = await this.memory.getSummaryData(corpId, userId);

// 程序记忆写入口（供 advance_stage）
await this.memory.setStage(corpId, userId, sessionId, state);

// 长期 profile_facts 外部写入（如 enrichment 补齐性别）
await this.memory.saveProfile(corpId, userId, partialProfile, metadata?);

// 已邀群登记（供 invite_to_group）
await this.memory.saveInvitedGroup(corpId, userId, sessionId, record);

// 清理用户长期记忆
await this.memory.clearLongTermMemory(corpId, userId);
```

---

## 10. 设计边界

- **orchestration 层不直接操作 Redis / Supabase**：只通过 `MemoryService` facade
- **prompt 格式化放在 agent 模块**，不放在 memory facade
- **memory store 不做业务判断**：阶段合法性在 `advance_stage` 工具层校验，不在 procedural.service
- **`advance_stage` 是程序记忆的唯一显式写入口**
- **`recall_history` 是长期摘要的唯一按需读入口**
- **沉淀过程不反写 Redis 会话态**：只做 Redis → Supabase 的单向搬运，Redis key 自然过期
- **highConfidenceFacts 不落库**：只是本轮 sidecar，事实落库走 `onTurnEnd` 后置 LLM 提取

---

## 相关文件

- [`src/memory/README.md`](../../src/memory/README.md) — 模块实现细节（真相源）
- [`src/memory/memory.service.ts`](../../src/memory/memory.service.ts) — facade
- [`src/memory/services/memory-lifecycle.service.ts`](../../src/memory/services/memory-lifecycle.service.ts) — onTurnStart / onTurnEnd 编排
- [`src/memory/services/settlement.service.ts`](../../src/memory/services/settlement.service.ts) — 沉淀逻辑
- [`src/memory/memory.config.ts`](../../src/memory/memory.config.ts) — 时间常量
- [`src/agent/agent-preparation.service.ts`](../../src/agent/agent-preparation.service.ts) — Agent 侧消费 onTurnStart 结果
- [`src/tools/advance-stage.tool.ts`](../../src/tools/advance-stage.tool.ts) — 阶段推进
- [`src/tools/recall-history.tool.ts`](../../src/tools/recall-history.tool.ts) — 按需检索摘要
- [`src/tools/invite-to-group.tool.ts`](../../src/tools/invite-to-group.tool.ts) — 群邀请副作用登记
- [`src/biz/message/repositories/chat-message.repository.ts`](../../src/biz/message/repositories/chat-message.repository.ts) — chat_messages 表操作
