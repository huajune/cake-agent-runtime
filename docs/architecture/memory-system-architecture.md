# Agent 记忆系统架构

**最后更新**：2026-03-19

---

## 1. 设计理念

基于认知科学的记忆分类模型（CoALA 框架），将 Agent 记忆分为三层。核心原则：

- **编排层固定读写**：记忆的读取和存储是 Agent Loop 的固定前置/后置步骤，不由 LLM 自主决定
- **按需工具补充**：大体量、非每轮必需的记忆（如历史摘要）通过工具按需检索
- **语义命名**：代码命名体现"这是什么记忆"，而非"存在哪里"

---

## 2. 三层记忆模型

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Loop（编排层）                      │
│                                                             │
│  recall:  一次性读取所有记忆 → 注入 prompt                    │
│  store:   Agent 完成后 → 更新记忆                            │
│                                                             │
├──────────── 固定注入（小，每轮都需要）──────────────────────────┤
│                                                             │
│  ┌── 短期记忆 (Short-term / Working Memory) ──────────────┐  │
│  │  chat_messages（Supabase 永久存储）                      │  │
│  │  → 滑动窗口（轮数 + token + 时间）→ messages[]           │  │
│  │  → 注入 LLM context window                             │  │
│  │  → 请求结束即释放，不额外持久化                           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌── 会话事实 (Session Facts) ────────────────────────────┐  │
│  │  本次求职意向：品牌、薪资、岗位、城市、面试安排            │  │
│  │  → Redis SESSION_TTL，会话级，每轮 Agent 完成后异步提取            │  │
│  │  → 空闲超时后沉淀到长期记忆                              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌── 程序记忆 (Procedural Memory) ───────────────────────┐  │
│  │  STAGE = 招聘流程阶段                                   │  │
│  │  → Redis SESSION_TTL，控制 Agent 行为模式                        │  │
│  │  → 由 advance_stage 工具写入（LLM 判断推进时机）          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌── 长期记忆 — Profile (Long-term) ─────────────────────┐  │
│  │  用户身份：姓名、电话、性别、年龄、学历、是否学生          │  │
│  │  → Supabase 永久，用户级，跨会话复用                     │  │
│  │  → 从 Session Facts 中沉淀身份字段                      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
├──────────── 工具按需检索（大，不总是需要）──────────────────────┤
│                                                             │
│  ┌── 长期记忆 — Summary (Long-term) ─────────────────────┐  │
│  │  情景记忆：历次求职经历摘要                              │  │
│  │  → Supabase 永久，用户级                               │  │
│  │  → 会话空闲超时后生成（FACTS + 对话 → LLM 摘要）         │  │
│  │  → 通过 recall_history 工具按需检索                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 短期记忆 (Short-term / Working Memory)

**定义**：当前对话的上下文窗口内容，本质是 LLM 的 context window。

**数据源**：`chat_messages` 表（Supabase 永久存储）。注意 chat_messages 本身不是记忆系统的一部分，它是业务数据（审计、Dashboard、回溯），同时作为短期记忆的数据源。

**窗口策略**（由记忆管理系统统一控制）：

| 限制维度 | 默认值 | 环境变量 |
|---------|--------|---------|
| 最大消息条数 | 60 条 | `MAX_HISTORY_PER_CHAT` |
| 时间窗口 | 3 天 | — |
| 总字符上限 | 8000 | `AGENT_MAX_INPUT_CHARS` |

**读取时机**：Agent 每轮请求前，从 chat_messages 取最近 N 条消息，裁剪后作为 `messages[]` 传入 LLM。

### 2.2 会话事实 (Session Facts)

**定义**：本次求职过程中提取的结构化意向信息，会话级别。

**存储**：Redis，TTL = SESSION_TTL，key 格式 `facts:{corpId}:{userId}:{sessionId}`

**包含字段**：

```typescript
// 本次求职意向（会话级，每次可能不同）
interface SessionFacts {
  preferences: {
    labor_form: string;    // 用工形式（兼职/全职/暑假工）
    brands: string[];      // 意向品牌
    salary: string;        // 意向薪资
    position: string[];    // 意向岗位
    schedule: string;      // 意向班次
    city: string;          // 意向城市
    district: string[];    // 意向区域
    location: string[];    // 意向地点
  };
  interviewInfo: {
    applied_store: string;    // 应聘门店
    applied_position: string; // 应聘岗位
    interview_time: string;   // 面试时间
  };
}
```

**读写时机**：
- 读取：Agent 每轮请求前，作为 `recall()` 的一部分固定注入 prompt
- 写入：Agent 完成后，由 FactExtractionService 异步提取并存储（fire-and-forget）
- 沉淀：会话空闲超时后，关键信息沉淀到 Profile 和 Summary

### 2.3 程序记忆 (Procedural Memory)

**定义**：招聘流程的当前阶段，控制 Agent "怎么做事"。

**存储**：Redis，TTL = SESSION_TTL，key 格式 `stage:{corpId}:{userId}:{sessionId}`

**阶段流程**：
```
trust_building → needs_collection → job_recommendation → interview_arrangement
（信任建立）     （需求收集）        （岗位推荐）          （面试安排）
```

**读写时机**：
- 读取：Agent 每轮请求前，固定注入，决定 systemPrompt 中加载哪套阶段策略
- 写入：由 `advance_stage` 工具在 Agent 循环中写入（LLM 判断当前阶段目标是否达成）

**设计要点**：`advance_stage` 是唯一保留的记忆写入工具，因为阶段推进的时机只有 LLM 能判断。

### 2.4 长期记忆 — Profile

**定义**：用户的稳定身份信息，跨会话复用。

**存储**：Supabase 永久 + Redis 2h 缓存，key 格式 `profile:{corpId}:{userId}`

**包含字段**：

```typescript
// 用户身份信息（用户级，基本不变）
interface UserProfile {
  name: string;        // 姓名
  phone: string;       // 电话
  gender: string;      // 性别
  age: string;         // 年龄
  is_student: boolean; // 是否学生
  education: string;   // 学历
  has_health_certificate: string; // 健康证
}
```

**读写时机**：
- 读取：Agent 每轮请求前，固定注入（"我知道你是张三"）
- 写入：会话沉淀时，从 Session Facts 中提取身份字段写入/更新

### 2.5 长期记忆 — Summary

**定义**：历次求职经历的对话摘要，情景记忆（Episodic Memory）。

**存储**：Supabase 永久，用户级

**示例**：
```
2026-03-15：找上海兼职，意向KFC/麦当劳，面试了KFC浦东店，候选人要确认时间，未入职。
2026-03-19：找杭州全职，意向星巴克，已安排面试。
```

**读写时机**：
- 读取：通过 `recall_history` 工具按需检索（LLM 发现用户提到"上次"时主动调用）
- 写入：会话空闲超时后，由沉淀服务生成（FACTS + 对话记录 → LLM 摘要）

**不固定注入的原因**：摘要可能有多条且越积越多，固定注入会浪费 token。大部分对话不需要回顾历史，让 LLM 按需检索更高效。

---

## 3. 读写时序

### 3.1 每轮对话

```
用户消息到达
  │
  ├── 1. 空闲检测
  │   └── lastInteraction 距今 ≥ SESSION_TTL？
  │       → 是：触发沉淀（Session Facts → Profile + Summary）
  │       → 否：继续
  │
  ├── 2. recall() — 一次性读取所有固定注入的记忆
  │   ├── 短期记忆：chat_messages → 窗口裁剪 → messages[]
  │   ├── 会话事实：Redis facts → sessionFacts
  │   ├── 程序记忆：Redis stage → procedural
  │   └── 长期记忆：Supabase/Redis profile → profile
  │
  ├── 3. 组装 prompt + 注入记忆 → 调用 LLM
  │   │
  │   └── LLM 可能调用的工具：
  │       ├── advance_stage — 推进流程阶段（程序记忆写入）
  │       └── recall_history — 按需检索历史摘要（长期记忆读取）
  │
  └── 4. store() — Agent 完成后更新记忆
      ├── 更新 lastInteraction
      └── 异步事实提取 → 写入 Session Facts（fire-and-forget）
```

### 3.2 会话沉淀（空闲超时触发）

```
下一条消息到达 → 检测 lastInteraction 距今 ≥ SESSION_TTL
  │
  ├── 1. 读取即将过期的 Session Facts
  │
  ├── 2. 身份字段沉淀到 Profile
  │   └── name, phone, gender, age, education, is_student
  │       → Supabase upsert（deepMerge，不覆盖已有值）
  │
  ├── 3. 生成对话摘要 → 写入 Summary
  │   └── 读取 chat_messages 中该时段的对话
  │       + Session Facts 中的求职意向
  │       → LLM 生成一段摘要
  │       → 写入 Supabase
  │
  └── 4. Session Facts / Stage 的 Redis key 自然过期（SESSION_TTL）
```

---

## 4. 工具策略

### 4.1 保留的工具

| 工具 | 记忆类型 | 操作 | 保留原因 |
|------|---------|------|---------|
| `advance_stage` | 程序记忆 | 写入 | 只有 LLM 能判断阶段推进时机 |
| `recall_history` | 长期记忆 | 读取 | 历史摘要按需检索，避免 token 浪费 |

### 4.2 删除的工具

| 工具 | 删除原因 |
|------|---------|
| `memory_recall` | 编排层已固定注入所有当前记忆，无需 LLM 主动回忆 |
| `memory_store` | 编排层已通过 FactExtractionService 结构化提取，LLM 随意写入会导致格式不一致和数据冲突 |

**设计原则**：编排层保证 LLM 一定知道"当前状态"，工具让 LLM 可以主动"翻阅历史"。写入一律由编排层控制（advance_stage 除外）。

---

## 5. 服务周期与时间常量

记忆系统中有多个时间参数，它们都围绕同一个业务概念——**单次求职服务周期**（从候选人打招呼到上岗的完整过程）。这些时间常量必须统一管理，而非散落在各服务中。

### 5.1 服务周期定义

```
单次求职服务周期（Service Cycle）
= 候选人首次发消息 → 咨询 → 面试安排 → 入职确认
= 典型时长：1~7 天
= 当前默认值：1 天（SESSION_TTL）
```

**空闲超时判定**：最后一条消息距今超过服务周期时长，视为本次服务结束，触发沉淀。

### 5.2 时间常量总表

所有记忆相关的时间配置统一定义在记忆模块中，由 `MemoryConfig` 统一管理：

| 常量 | 默认值 | 环境变量 | 说明 | 受服务周期影响 |
|------|--------|---------|------|:---:|
| `SESSION_TTL` | 1d (86400s) | `MEMORY_SESSION_TTL_DAYS` | 会话记忆（Facts + Stage）的 Redis TTL | ✅ 核心参数 |
| `IDLE_TIMEOUT` | 1d | `MEMORY_IDLE_TIMEOUT_DAYS` | 空闲超时阈值，超过触发沉淀 | ✅ 等于 SESSION_TTL |
| `SHORT_TERM_WINDOW` | 1d | — | 短期记忆时间窗口（chat_messages 查询范围） | ✅ 等于 SESSION_TTL |
| `SHORT_TERM_MAX_MESSAGES` | 60 | `MAX_HISTORY_PER_CHAT` | 短期记忆最大消息条数 | |
| `SHORT_TERM_MAX_CHARS` | 8000 | `AGENT_MAX_INPUT_CHARS` | 短期记忆总字符上限 | |
| `PROFILE_CACHE_TTL` | 2h (7200s) | — | Profile 的 Redis 缓存时间 | |

**关键约束**：`SESSION_TTL` = `IDLE_TIMEOUT` = `SHORT_TERM_WINDOW`，三者语义相同——都是"一次服务周期的时长"。修改时只需调整 `SESSION_TTL`，其余两个跟随。

### 5.3 代码实现

```typescript
// src/memory/memory.config.ts — 统一时间常量管理

@Injectable()
export class MemoryConfig {
  /** 服务周期时长（秒） — 所有会话级时间的基准 */
  readonly sessionTtl: number;

  /** 短期记忆最大消息条数 */
  readonly shortTermMaxMessages: number;

  /** 短期记忆总字符上限 */
  readonly shortTermMaxChars: number;

  /** Profile Redis 缓存时间（秒） */
  readonly profileCacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    const days = parseInt(this.configService.get('MEMORY_SESSION_TTL_DAYS', '1'), 10);
    this.sessionTtl = days * 24 * 60 * 60;

    this.shortTermMaxMessages = parseInt(
      this.configService.get('MAX_HISTORY_PER_CHAT', '60'), 10,
    );
    this.shortTermMaxChars = parseInt(
      this.configService.get('AGENT_MAX_INPUT_CHARS', '8000'), 10,
    );
    this.profileCacheTtl = 2 * 60 * 60; // 2h，硬编码
  }

  /** 服务周期天数（用于 Supabase 时间查询） */
  get sessionTtlDays(): number {
    return this.sessionTtl / (24 * 60 * 60);
  }
}
```

---

## 6. 存储后端

| 记忆类型 | 存储后端 | TTL | Key 格式 | 写入策略 |
|---------|---------|-----|---------|---------|
| 短期记忆 | Supabase（chat_messages 表） | 永久 | chat_id | 每条消息落库 |
| Session Facts | Redis | SESSION_TTL | `facts:{corpId}:{userId}:{sessionId}` | deepMerge |
| Stage | Redis | SESSION_TTL | `stage:{corpId}:{userId}:{sessionId}` | 覆盖写 |
| Profile + Summary | `agent_memories` 表（每用户一行）+ Redis 2h 缓存 | 永久 | `(corp_id, user_id)` | Profile 非 null 覆盖，Summary 分层压缩 |

---

## 7. 存储字段总览

完整的记忆系统数据结构一览，按记忆类型分组。

### 7.1 短期记忆 — chat_messages 表（Supabase）

数据源表，非记忆系统直接管理，但作为短期记忆的读取来源。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `chat_id` | string | 会话 ID |
| `message_id` | string | 消息唯一 ID（去重键） |
| `role` | `'user' \| 'assistant'` | 消息角色 |
| `content` | string | 消息内容 |
| `timestamp` | timestamptz | 消息时间 |
| `candidate_name` | string? | 候选人名称 |
| `manager_name` | string? | 招募经理名称 |
| `org_id` | string? | 企业 ID |
| `bot_id` | string? | 托管账号 ID |
| `message_type` | string? | 消息类型（文本/图片等） |
| `source` | string? | 消息来源（手机/AI等） |
| `is_room` | boolean | 是否群聊 |
| `im_bot_id` | string? | 托管账号系统 wxid |
| `im_contact_id` | string? | 联系人系统 ID |
| `contact_type` | string? | 客户类型 |
| `is_self` | boolean? | 是否托管账号自己发送 |
| `payload` | jsonb? | 原始消息内容 |
| `avatar` | string? | 用户头像 URL |
| `external_user_id` | string? | 企微外部用户 ID |

**窗口读取**：取最近 SHORT_TERM_MAX_MESSAGES 条 + SESSION_TTL 内 → 裁剪到字符上限 → 输出为 `SimpleMessage[]`

```typescript
interface SimpleMessage {
  role: 'user' | 'assistant';
  content: string;  // 注入时间上下文后的内容
}
```

### 7.2 会话事实 — Session Facts（Redis）

**Key**: `facts:{corpId}:{userId}:{sessionId}` | **TTL**: 3d | **写入策略**: deepMerge

```typescript
interface SessionFacts {
  /** 面试相关（本次求职） */
  interviewInfo: {
    applied_store: string | null;     // 应聘门店
    applied_position: string | null;  // 应聘岗位
    interview_time: string | null;    // 面试时间
  };

  /** 求职意向（本次求职，每次可能不同） */
  preferences: {
    labor_form: string | null;     // 用工形式（兼职/全职/暑假工/寒假工/小时工）
    brands: string[] | null;       // 意向品牌（标准品牌名）
    salary: string | null;         // 意向薪资
    position: string[] | null;     // 意向岗位
    schedule: string | null;       // 意向班次/时间
    city: string | null;           // 意向城市
    district: string[] | null;     // 意向区域
    location: string[] | null;     // 意向地点/商圈
  };

  /** 提取推理说明 */
  reasoning: string;

  /** 上轮已推荐岗位（每轮覆盖） */
  lastRecommendedJobs: RecommendedJobSummary[] | null;

  /** 最后交互时间（用于空闲检测） */
  lastInteraction: string;

  /** 最后话题摘要 */
  lastTopic: string;
}

interface RecommendedJobSummary {
  jobId: number;
  brandName: string | null;
  jobName: string | null;
  storeName: string | null;
  cityName: string | null;
  regionName: string | null;
  laborForm: string | null;
  salaryDesc: string | null;
  jobCategoryName: string | null;
}
```

### 7.3 程序记忆 — Stage（Redis）

**Key**: `stage:{corpId}:{userId}:{sessionId}` | **TTL**: 3d | **写入策略**: 覆盖写

```typescript
interface ProceduralState {
  /** 当前阶段标识 */
  currentStage: string;    // 'trust_building' | 'needs_collection' | 'job_recommendation' | 'interview_arrangement'
  /** 推进时间 */
  advancedAt: string;      // ISO 时间戳
  /** 推进原因（审计用） */
  reason: string;
}
```

**阶段流转**：

```
trust_building → needs_collection → job_recommendation → interview_arrangement
  (信任建立)       (需求收集)          (岗位推荐)           (面试安排)
```

### 7.4 长期记忆 — `agent_memories` 表（Supabase）

**核心设计**：每个用户一行，所有长期记忆信息在同一行中。

**表结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| | **基础信息** | |
| `id` | uuid | 主键，自动生成 |
| `corp_id` | string | 企业 ID |
| `user_id` | string | 用户 ID |
| | | |
| | **Profile 字段（平铺）** | |
| `name` | string? | 姓名 |
| `phone` | string? | 联系方式 |
| `gender` | string? | 性别 |
| `age` | string? | 年龄 |
| `is_student` | boolean? | 是否学生 |
| `education` | string? | 学历 |
| `has_health_certificate` | string? | 健康证情况 |
| | | |
| | **Summary 字段（jsonb，分层压缩）** | |
| `summary_data` | jsonb? | 对话摘要数据（分层压缩结构，见下方） |
| | | |
| | **消息元数据（jsonb 对象）** | |
| `message_metadata` | jsonb? | 消息回调的关键字段，首次沉淀时写入 |
| | | |
| | **时间戳** | |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 最后更新时间 |

**唯一约束**：`(corp_id, user_id)`（每用户一行）

**Redis 缓存**：整行有 2h Redis 缓存（读时回填）。

**设计说明**：
- Profile 字段平铺为表列：可直接 SQL 查询、索引、过滤，不需要 jsonb 解析
- Summary 和 message_metadata 收为 jsonb：它们是整体数据，不需要单独索引
- 每个用户只有一行，不需要 type 字段区分

#### 7.4.1 Profile

**写入策略**: 非 null 字段覆盖更新

**数据来源**：会话沉淀时从 Session Facts 中提取身份字段写入。跨会话复用，下次再聊无需重新询问。

#### 7.4.2 Summary（分层压缩策略）

`summary_data` jsonb 结构：

```typescript
interface SummaryData {
  /** 最近 N 条详细摘要（默认保留 5 条） */
  recent: SummaryEntry[];
  /** 更早的摘要被 LLM 压缩合并成一段总结 */
  archive: string | null;
}

interface SummaryEntry {
  /** 摘要内容 */
  summary: string;
  /** 关联的 sessionId */
  sessionId: string;
  /** 会话开始时间 */
  startTime: string;
  /** 会话结束时间 */
  endTime: string;
}
```

**压缩策略**：
1. 每次沉淀时，生成一条 `SummaryEntry` 追加到 `recent` 数组头部
2. 当 `recent.length > MAX_RECENT_SUMMARIES`（默认 5）时，将最早的条目移出
3. 移出的条目与现有 `archive` 一起，由 LLM 压缩合并为新的 `archive`
4. `archive` 是一段自然语言总结，如：*"该候选人曾多次咨询，2026年1-2月期间主要找上海地区兼职，面试过KFC和麦当劳共3次，均未入职。"*

**示例数据**：

```json
{
  "recent": [
    {
      "summary": "找杭州全职服务员，意向星巴克，已安排西湖店面试。",
      "sessionId": "chat_def456",
      "startTime": "2026-03-19T09:00:00Z",
      "endTime": "2026-03-19T11:00:00Z"
    },
    {
      "summary": "找上海浦东兼职，意向KFC和麦当劳，推荐了KFC浦东店，候选人要确认时间，未安排面试。",
      "sessionId": "chat_abc123",
      "startTime": "2026-03-15T09:00:00Z",
      "endTime": "2026-03-15T11:30:00Z"
    }
  ],
  "archive": "2026年1-2月期间曾多次咨询上海地区兼职岗位，面试过麦当劳徐汇店（未到场）和必胜客人民广场店（通过但未入职）。"
}
```

**`message_metadata` 结构**：

```typescript
interface MessageMetadata {
  botId: string;           // 托管账号 ID
  imBotId: string;         // 托管账号系统 wxid
  imContactId: string;     // 联系人系统 ID
  contactType: number;     // 客户类型：0=未知 1=个微 2=企微 3=企微自建
  contactName: string;     // 客户名称
  externalUserId: string;  // 企微外部用户 ID
  avatar: string;          // 用户头像 URL
}
```

### 7.5 字段归属对照（FACTS 拆分）

当前 FactExtractionService 提取的字段将按稳定性拆分到不同记忆层：

| 字段 | 稳定性 | 归属 | 存储 |
|------|--------|------|------|
| `name` | 基本不变 | **Profile** | Supabase 永久 |
| `phone` | 基本不变 | **Profile** | Supabase 永久 |
| `gender` | 基本不变 | **Profile** | Supabase 永久 |
| `age` | 半稳定 | **Profile** | Supabase 永久 |
| `is_student` | 半稳定 | **Profile** | Supabase 永久 |
| `education` | 半稳定 | **Profile** | Supabase 永久 |
| `has_health_certificate` | 半稳定 | **Profile** | Supabase 永久 |
| `applied_store` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `applied_position` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `interview_time` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `labor_form` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `brands` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `salary` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `position` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `schedule` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `city` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `district` | 每次不同 | **Session Facts** | Redis SESSION_TTL |
| `location` | 每次不同 | **Session Facts** | Redis SESSION_TTL |

---

## 8. 模块结构

```
src/memory/
├── memory.service.ts           # 统一入口：recall() / store()
├── memory.config.ts            # 时间常量统一管理（SESSION_TTL 等）
├── memory.types.ts             # 所有记忆相关类型定义
│
├── stores/                     # 存储后端（内部实现）
│   ├── redis.store.ts          # Redis 存储
│   ├── supabase.store.ts       # Supabase 存储
│   └── deep-merge.util.ts      # 深合并工具
│
├── short-term.service.ts       # 短期记忆（对话窗口管理）
├── session-facts.service.ts    # 会话事实（本次求职意向）
├── procedural.service.ts       # 程序记忆（流程阶段）
├── long-term.service.ts        # 长期记忆（Profile + Summary）
└── settlement.service.ts       # 沉淀服务（空闲超时 → 长期化）
```

### 8.1 Agent 层调用接口

```typescript
// 读取 — 一次性获取完整记忆上下文
const memory = await this.memory.recall(corpId, userId, sessionId);

interface AgentMemoryContext {
  /** 短期记忆 — 裁剪后的对话窗口 */
  shortTerm: SimpleMessage[];
  /** 长期记忆 — 用户身份 */
  longTerm: {
    profile: UserProfile | null;
  };
  /** 程序记忆 — 当前流程阶段 */
  procedural: {
    currentStage: string | null;
    advancedAt: string | null;
  };
  /** 会话事实 — 本次求职意向 */
  sessionFacts: SessionFacts | null;
}

// 写入 — Agent 完成后一次性更新
await this.memory.store(corpId, userId, sessionId, {
  facts: extractedFacts,
});
```

---

## 9. 与现有系统的变更清单

| 变更项 | 现状 | 目标 |
|-------|------|------|
| 短期记忆窗口裁剪 | 分散在 MessageHistoryService + LoopService.trimMessages() | 收编到 `short-term.service.ts` |
| FACTS 中的身份字段 | 混在 Session Facts 中，Redis SESSION_TTL 后丢失 | 拆分到 Profile（Supabase 永久） |
| 对话摘要 | 不存在 | 新增 Summary（沉淀服务生成） |
| memory_recall 工具 | 存在，与编排层重复 | 删除 |
| memory_store 工具 | 存在，与 FactExtraction 冲突 | 删除 |
| recall_history 工具 | 不存在 | 新增，按需检索历史摘要 |
| enrichPrompt 读取 | 分别读 stage、facts，两次 await | 统一 `memory.recall()` 一次读取 |
| FACTS key 前缀 | `wework_session:` | `facts:`（语义化） |
| Profile 调用方 | 基础设施已搭，无调用方 | 接入编排层，沉淀服务写入 |

---

## 相关文件

- `src/memory/` — 记忆管理模块
- `src/agent/loop.service.ts` — Agent 编排层（记忆读写调用方）
- `src/agent/fact-extraction.service.ts` — 事实提取服务
- `src/tools/advance-stage.tool.ts` — 阶段推进工具
- `src/tools/memory-recall.tool.ts` — 待删除
- `src/tools/memory-store.tool.ts` — 待删除
- `src/channels/wecom/message/services/history.service.ts` — 消息历史（短期记忆数据源）
- `src/biz/message/repositories/chat-message.repository.ts` — chat_messages 表操作
