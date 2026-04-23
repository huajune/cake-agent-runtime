# Agent 记忆系统架构

**最后更新**：2026-04-23

> 这份文档描述当前主链路中真正生效的实现。模块内部的详细职责分解参见
> [`src/memory/README.md`](../../src/memory/README.md)。

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
│  │  → 读：Redis 优先，DB 兜底；时间边界与 sessionTtl 对齐            │  │
│  │  → 写：业务写 chat_messages 后同步镜像到 Redis                   │  │
│  │  → 最终裁剪为 ShortTermMessage[] 注入 LLM context                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌── 会话记忆 (Session Memory) ───────────────────────────────────┐  │
│  │  本次求职会话的结构化业务状态：                                   │  │
│  │    facts / lastCandidatePool / presentedJobs /                 │  │
│  │    currentFocusJob / invitedGroups / lastSessionActiveAt       │  │
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
│  │  profile：跨会话稳定身份（姓名/电话/性别/年龄/学历/学生/健康证）    │  │
│  │  summary：recent[] + archive（分层压缩）+ lastSettledMessageAt   │  │
│  │  → Supabase agent_memories 每用户一行 + Redis 整行 2h 缓存        │  │
│  │  → 来源：SettlementService 在空闲超时触发时写入                   │  │
│  │  → 读取：profile 固定注入；summary 通过 recall_history 工具按需读 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
├──────────── 旁路解析（非持久化）──────────────────────────────────────┤
│                                                                     │
│  ┌── 本轮高置信线索 (highConfidenceFacts) ───────────────────────┐    │
│  │  对"本轮 user 最新消息"做一次规则 + 别名识别                     │    │
│  │  → 识别品牌 / 城市 / 用工形式等                                 │    │
│  │  → 仅注入本轮 prompt，不落库、不参与后置事实提取                  │    │
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
3. DB fallback 的时间边界与 `sessionTtl` 对齐
4. miss 回退后把 DB 结果回填到 Redis
5. 给每条消息注入时间上下文
6. 按字符上限裁剪，最终输出 `ShortTermMessage[]`

**窗口策略**：

| 限制维度 | 默认值 | 环境变量 |
|---------|--------|---------|
| 最大消息条数 | 60 条 | `MAX_HISTORY_PER_CHAT` |
| 时间窗口 | `sessionTtl` 对齐 | `MEMORY_SESSION_TTL_DAYS` |
| 总字符上限 | 8000 | `AGENT_MAX_INPUT_CHARS` |

**空兜底**：WeCom 聚合/重跑时如果 Redis/DB 都为空，`memory-lifecycle` 会用调用方提供的 `currentUserMessage` 构造一条 user fallback，避免 `messages=[]` 直接抛错。

### 2.2 会话记忆 (Session Memory)

**定义**：本次求职会话的结构化业务状态（session 级，非 user 级）。

**存储**：Redis，key `facts:{corpId}:{userId}:{sessionId}`，TTL = `sessionTtl`。

**字段**（[`session-facts.types.ts`](../../src/memory/types/session-facts.types.ts)）：

```typescript
interface WeworkSessionState {
  /** 结构化事实（LLM 后置提取） */
  facts: EntityExtractionResult | null;
  /** 每轮覆盖：最后一次 duliday_job_list 返回的候选岗位池 */
  lastCandidatePool: RecommendedJobSummary[] | null;
  /** 最近几轮真正发给候选人的岗位 */
  presentedJobs: RecommendedJobSummary[] | null;
  /** 候选人当前明确在聊或准备报名的岗位 */
  currentFocusJob: RecommendedJobSummary | null;
  /** 本会话中已邀入的兼职群 */
  invitedGroups: InvitedGroupRecord[] | null;
  /** 本段会话最后一次仍在继续聊的时间（沉淀判定依据） */
  lastSessionActiveAt?: string;
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
- 写入：每回合 `onTurnEnd` 串行写候选池 / activity / 岗位投影 / 后置事实提取
- 合并策略：`deep-merge.util` —— null/undefined/空串不覆盖旧值，对象递归合并，数组去重合并
- 沉淀：`lastSessionActiveAt` 闲置超过 `sessionTtl` 后，身份字段沉淀到 Profile，对话摘要写入 Summary

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

**定义**：跨会话复用的用户稳定信息 + 历次求职经历摘要。

**存储**：Supabase `agent_memories` 表（每用户一行）+ Redis 整行 2h 缓存。

**两部分**（[`long-term.types.ts`](../../src/memory/types/long-term.types.ts)）：

#### Profile（身份信息）

```typescript
interface UserProfile {
  name: string | null;
  phone: string | null;
  gender: string | null;
  age: string | null;
  is_student: boolean | null;
  education: string | null;
  has_health_certificate: string | null;
}
```

- 读取：每回合 `onTurnStart` 固定注入（"我知道你是张三"）
- 写入：`SettlementService` 在沉淀时从 session facts 里抽身份字段；或外部系统（如补充性别）通过 `MemoryService.saveProfile()` 直接写入

#### Summary（分层压缩的对话摘要）

```typescript
interface SummaryData {
  recent: SummaryEntry[];        // 最近 N 条详细摘要（MAX_RECENT_SUMMARIES = 5）
  archive: string | null;        // 更早的被 LLM 压缩合并成一段自然语言总结
  lastSettledMessageAt: string | null;  // 最近一次已沉淀的消息边界
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
- 品牌规范化（基于 sponge 品牌表 alias 匹配）
- 城市识别（直辖市简写 / 明确城市 / 唯一区域别名 / 商圈 alias）
- 用工形式 / 年龄等规则字段

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
  │   │   └── profile                 (Redis cache → Supabase)
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
   └── 若 lastSessionActiveAt 距今 ≥ sessionTtl → 触发 SettlementService.settle()
3. 分支 B：session_turn_end_updates（串行，避免 Redis 状态互覆盖）
   ├── save_candidate_pool         (ctx.candidatePool → lastCandidatePool)
   ├── store_activity              (更新 lastSessionActiveAt = now)
   ├── project_assistant_turn      (岗位投影 → presentedJobs / currentFocusJob)
   └── extract_facts               (后置 LLM 事实提取 → facts)
4. 把每一步的 success/skipped/failure 写入 message_processing_records.post_processing_status
```

**关键顺序**：先读旧 `sessionState` 再更新 `lastSessionActiveAt`。否则一旦先写新 activity，旧会话永远达不到沉淀阈值。

### 3.3 会话沉淀 — Settlement

[`settlement.service.ts`](../../src/memory/services/settlement.service.ts)

```
shouldSettle(lastSessionActiveAt): elapsed ≥ sessionTtl
  │
  ├── 身份字段沉淀 → Profile
  │   从 facts.interview_info 抽 name/phone/gender/age/is_student/education/has_health_certificate
  │   → Supabase agent_memories 非 null 覆盖更新
  │
  ├── 对话摘要 → Summary
  │   读 chat_messages 中 lastSettledMessageAt → lastSessionActiveAt 之间的消息
  │   + facts 中的求职意向 → LLM 生成 ≤100 字摘要
  │   → 追加到 summary_data.recent；溢出部分 LLM 合并进 archive（≤200 字）
  │   → 更新 lastSettledMessageAt
  │
  └── 不反写 Redis 会话态；Redis key 自然过期
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
= 当前默认值：1 天（sessionTtl）
```

**空闲超时判定**：`lastSessionActiveAt` 距今超过 `sessionTtl` 即视为本段会话结束，触发沉淀。

### 5.2 时间常量总表

所有时间配置统一由 [`MemoryConfig`](../../src/memory/memory.config.ts) 管理：

| 常量 | 默认值 | 环境变量 | 说明 |
|------|--------|---------|------|
| `sessionTtl` | 1 天（86400 s） | `MEMORY_SESSION_TTL_DAYS` | Redis 会话级数据 TTL；也是沉淀阈值；短期窗口 DB fallback 时间边界 |
| `sessionWindowMaxMessages` | 60 | `MAX_HISTORY_PER_CHAT` | 短期记忆最大消息条数 |
| `sessionWindowMaxChars` | 8000 | `AGENT_MAX_INPUT_CHARS` | 短期记忆总字符上限（超限从最早消息开始裁剪） |
| `sessionExtractionIncrementalMessages` | 10 | `SESSION_EXTRACTION_INCREMENTAL_MESSAGES` | 已有 facts 时，后置提取只重看最近 N 条 |
| `longTermCacheTtl` | 2h（7200 s） | — | `agent_memories` 整行在 Redis 的缓存时长（硬编码） |
| `MAX_RECENT_SUMMARIES` | 5 | — | `summary.recent` 最多保留多少条（溢出压缩进 archive） |

**核心约束**：`sessionTtl` 一个参数同时决定 → (1) Redis 会话态过期 (2) 沉淀阈值 (3) 短期窗口 DB fallback 时间边界。修改时只改 `MEMORY_SESSION_TTL_DAYS` 即可。

---

## 6. 存储后端

| 记忆类型 | 存储后端 | 主键 / Key | TTL | 写入策略 |
|---------|---------|-----------|-----|---------|
| 短期记忆 | Supabase `chat_messages` + Redis 窗口缓存 | `chat_id` / `session:{id}` | 永久 / 会话级 | 业务写 chat_messages，memory 同步镜像到 Redis |
| 会话记忆 | Redis | `facts:{corpId}:{userId}:{sessionId}` | `sessionTtl` | deepMerge（null 不覆盖，数组去重合并） |
| 程序记忆 | Redis | `stage:{corpId}:{userId}:{sessionId}` | `sessionTtl` | 覆盖写 |
| 长期记忆 | Supabase `agent_memories` + Redis 整行缓存 | `(corp_id, user_id)` 唯一 | 永久 / 2h 缓存 | Profile 非 null 覆盖；Summary 分层压缩 |

---

## 7. agent_memories 表结构

每用户一行，Profile 字段平铺、Summary / message_metadata 以 jsonb 存储。

| 字段 | 类型 | 说明 |
|------|------|------|
| **基础** | | |
| `id` | uuid | 主键 |
| `corp_id` | string | 企业 ID |
| `user_id` | string | 用户 ID |
| **Profile（平铺）** | | |
| `name` | string? | 姓名 |
| `phone` | string? | 联系方式 |
| `gender` | string? | 性别 |
| `age` | string? | 年龄 |
| `is_student` | boolean? | 是否学生 |
| `education` | string? | 学历 |
| `has_health_certificate` | string? | 健康证情况 |
| **Summary（jsonb）** | | |
| `summary_data` | jsonb? | `{ recent: SummaryEntry[], archive, lastSettledMessageAt }` |
| **消息元数据（jsonb）** | | |
| `message_metadata` | jsonb? | `{ botId, imBotId, imContactId, contactType, contactName, externalUserId, avatar }` |
| **时间戳** | | |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 最后更新时间 |

**唯一约束**：`(corp_id, user_id)`。

**设计原因**：
- Profile 平铺为列 → 可直接 SQL 查询 / 索引 / 过滤
- Summary 和 metadata 作为整体 jsonb → 不需要单独索引
- 每用户一行 → 不需要 type 字段区分

---

## 8. 字段归属对照

FACTS 提取的字段按稳定性拆分到不同记忆层。

| 字段 | 稳定性 | 归属 | 存储 |
|------|--------|------|------|
| `name` | 基本不变 | **Profile** | Supabase 永久 |
| `phone` | 基本不变 | **Profile** | Supabase 永久 |
| `gender` | 基本不变 | **Profile** | Supabase 永久 |
| `age` | 半稳定 | **Profile** | Supabase 永久 |
| `is_student` | 半稳定 | **Profile** | Supabase 永久 |
| `education` | 半稳定 | **Profile** | Supabase 永久 |
| `has_health_certificate` | 半稳定 | **Profile** | Supabase 永久 |
| `applied_store` / `applied_position` / `interview_time` | 每次不同 | **Session facts.interview_info** | Redis `sessionTtl` |
| `labor_form` / `brands` / `salary` / `position` / `schedule` / `city` / `district` / `location` | 每次不同 | **Session facts.preferences** | Redis `sessionTtl` |
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
│   ├── long-term.service.ts          # profile / summary 持久化
│   ├── settlement.service.ts         # 空闲超时沉淀
│   ├── memory-enrichment.service.ts  # 外部系统补全身份字段
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
│   ├── high-confidence-facts.ts      # 当前轮高置信识别（旁路）
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

// 长期档案外部写入（如 enrichment 补齐性别）
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
