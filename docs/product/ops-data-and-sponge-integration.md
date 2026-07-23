# 蛋糕运营数据体系 + 海绵工单集成 产品设计

**创建时间**: 2026-05-28
**状态**: 已落地（2026-06 实现，2026-07-02 按代码复核）
**运营使用说明**：日报 / Web 转化分析 / 埋点三出口的口径与用法见 [ops-data-spec-for-operations.md](./ops-data-spec-for-operations.md)（运营向）

---

> ## ✅ 实现要点（2026-07-02 已按代码逐条复核，与初版设计的差异）
>
> 本设计主体已落地。以下几处**最终实现与初版设计不同，下述为准**（正文相关段落已就地标注；均已对照当前代码确认仍生效）：
>
> 1. **入职 `candidate.hired` 不再采集**：15min 海绵轮询收口到 `interview.passed`，不写 `candidate.hired`（[`sponge-status-poll.cron.ts:21`](../../src/biz/ops-events/crons/sponge-status-poll.cron.ts#L21)）。因此「整体转化率」= **面试通过数 / 新增好友**（不再是"入职/加好友"）；cohort 漏斗、KPI 均**无「入职」阶段**。
> 2. **KPI 无 `hireRate` 字段**：后端 `ConversionKpisResponse` 实际返回 `breakIceRate / bookingRate / groupInviteRate / passRate / overallRate`，**没有 `hireRate`**（[`conversion-analytics.types.ts:37-44`](../../src/biz/conversion-analytics/types/conversion-analytics.types.ts#L37-L44)）。第三张卡是**加群率 = 破冰后加群人数 / 破冰人数**（分母是破冰，不是报名）。
> 3. **handoff 接口无 `byStage`**：`/analytics/conversion/handoff` 只返回 `reasons[]`（reason_code 聚合），未实现按 `stage` 的分布（stage 字段在 `handoff_events` 表里有，分析接口未消费）。
> 4. **`is_synthetic` 列实际加了、但没用**：迁移 `20260529150000` 仍 `ADD COLUMN message_processing_records.is_synthetic`（+部分索引），而 TS 代码**零引用**——孤儿列（破冰改走 `isPureFriendAddGreeting` 文本识别）。下文"已废弃不加"的说法不准。
> 5. **handoff 原因 10 类**（非 8 类）：新增 `no_match_or_group_full`、`system_blocked`；见 [`request-handoff.tool.ts`](../../src/tools/request-handoff.tool.ts) 与迁移 `20260603120000_reclassify_handoff_other_reasons.sql`。
> 6. **轮询窗口 60 天**（非 30 天）：`sponge-status-poll.cron.ts` 的 `lookbackDays = 60`。
> 7. **cohort 漏斗实际阶段**：加好友 cohort = 新增好友 → 破冰 → 邀请进群 → 报名 → 面试通过（5 级，进群为破冰侧支）；报名 cohort = 报名 → 面试通过（2 级）。均**无"入职"**。
> 8. **已完成**（本文"实施顺序"曾列为后续）：P1-8 飞书 21:00 日报 cron（[`ops-daily-report.cron.ts`](../../src/biz/ops-events/crons/ops-daily-report.cron.ts)）、P2-2 huajune 埋点（[`huajune-reporter.service.ts`](../../src/biz/huajune/huajune-reporter.service.ts)）均已实现。

---

## 一、背景与驱动

本次改造由 5 个问题驱动：

1. **修复 bug**：`request_handoff` 工具的 `modify_appointment` 在候选人首次约面时被误判为"改期"，发出误导性飞书告警
2. **数据基础修复**：`recruitment_cases` 表 158 条记录里 booking_id **全部为 NULL**，本地状态完全脱节于海绵
3. **运营要看数据**：每天每个号的招聘漏斗数据（飞书日报 + Web 转化分析）
4. **新好友盲区**：候选人加企微 bot 好友的瞬间，系统无感知，Agent 也不会主动打招呼
5. **跨系统埋点**：关键招聘事件需要上报到 huajune 分析系统（4 个事件）

---

## 二、核心设计概览

### 1. 废弃 recruitment_cases，预约信息挂候选人画像上

```
agent_long_term_memories 加一列：latest_booking jsonb
{ "latest_work_order_id": 12345, "linked_at": "2026-05-28T10:00:00Z" }
```

- 极简指针：只存 `latest_work_order_id` + `linked_at`
- **永不清空**：新预约 UPSERT 覆盖，不维护任何状态机
- 业务字段不冗余：状态/品牌/门店/岗位/面试时间每次实时查海绵

### 2. 海绵工单 API 是 source of truth

- Agent 上下文渲染 → Redis 5min 缓存 + 海绵实时查
- 历史预约 / 通过 / 入职 / 品牌 / 候选人明细 → 全部以海绵为准
- 本地不维护任何业务字段状态机

### 3. 事件底账 ops_events + daily_ops_report 投影

- **`ops_events` 底账表**：append-only，所有事件原始记录 + idempotency_key 去重
- **`daily_ops_report`**：从 ops_events 投影出来的汇总缓存，服务 Web 转化分析页（KPI / 账号对比）；飞书日报每日定时读一次
- **Cohort 漏斗全部基于 ops_events**：长期保留事件流，不依赖 mpr（mpr 30 天清理，跨期分析会失真）

### 4. runtime 短路语义

- `shortCircuitByResult` helper：根据 toolResult 的 `shortCircuited` 标记决定是否停止
- request_handoff 工具按返回值控制是否短路（正常 handoff `true`；HANDOFF_NO_BOOKING `false`）
- `skip_reply` 保持无条件短路

### 5. 破冰排除加好友握手语（替代原 synthetic 方案）

> ⚠ **原"合成 `[新好友添加]` synthetic 消息"方案已废弃**（生产无 NEW_CUSTOMER_ANSWER_SOP、未配 SOP，
> 加好友信号是微信以普通 user 消息推送的握手语，详见下方 ①②）。改用文本识别排除，无需 synthetic 标记/列。

- 加好友握手语（`我是{昵称}` / `请求添加你为朋友` / `我通过了你的…验证请求`）由 accept-inbound
  用 `isPureFriendAddGreeting`（`src/channels/wecom/message/utils/friend-add-greeting.util.ts`）识别
- 命中即**不记** `candidate.message_received` → 破冰自然落到下一条真实消息，避免破冰数虚高
- 带求职意图的「我是找工作的 / 我是兼职 / 我是应聘的」仍计入破冰

### 6. handoff 简化 + 单独事件表

- 废弃 recruitment_cases 的 `active/handoff/closed` 状态机
- handoff 状态只靠 `UserHostingService` 的 pause/resume 一层表达
- 新建 `handoff_events` 表只记录原因明细，方便聚合分析

---

## 三、数据模型变更

### 3.1 表清单

| 表 | 状态 | 说明 |
|---|---|---|
| `agent_long_term_memories` | **加列** `latest_booking jsonb` | 候选人最近一次预约工单 ID 指针 |
| `ops_events` | **新建** | 事件底账：append-only，所有事件原始记录 + idempotency_key |
| `daily_ops_report` | **新建** | 每日每 bot 12 列事件计数（**从 ops_events 投影出来**）|
| `handoff_events` | **新建** | Handoff 触发分析底账（11 字段，含 stage / reason_code）|
| `recruitment_cases` | **已删除** | 原计划"不删表、标记 @deprecated"，最终已于 2026-06-10 整表删除（迁移 `20260610170000_drop_recruitment_cases.sql`），代码同步移除 |

### 3.2 latest_booking 字段

```sql
ALTER TABLE agent_long_term_memories
  ADD COLUMN IF NOT EXISTS latest_booking jsonb;
```

```json
{
  "latest_work_order_id": 12345,
  "linked_at": "2026-05-28T10:00:00Z"
}
```

### 3.3 ops_events 事件底账表

```sql
CREATE TABLE ops_events (
  id bigserial PRIMARY KEY,
  corp_id text NOT NULL,               -- ⚡ 多 corp 隔离
  event_name text NOT NULL,            -- 13 个事件名之一
  occurred_at timestamptz NOT NULL,    -- 事件实际发生时间
  report_date date NOT NULL,           -- ⚡ 由 RPC 内部按 Asia/Shanghai 计算（不由调用方传）
  bot_im_id text,                      -- 归属 bot
  manager_name text,                   -- 冗余：bot 对应招聘经理（便于查询）
  group_name text,                     -- 冗余：bot 所属小组
  source_channel text,                 -- ⚡ 候选人来源渠道（friend.added 采集，反范式冗余便于按渠道切片）；拿不到落 'unknown'
  user_id text,                        -- 候选人 ID（cohort 漏斗 join 用）
  chat_id text,                        -- 会话 ID
  idempotency_key text NOT NULL,       -- 去重键
  payload jsonb,                       -- 事件元数据
  created_at timestamptz DEFAULT now(),

  UNIQUE(corp_id, event_name, idempotency_key)  -- ⚡ 多 corp 安全：同 corp 内同事件同 key 唯一
);

CREATE INDEX idx_ops_events_corp_date_bot ON ops_events (corp_id, report_date, bot_im_id);
CREATE INDEX idx_ops_events_corp_event_date ON ops_events (corp_id, event_name, report_date);
CREATE INDEX idx_ops_events_user_event ON ops_events (corp_id, user_id, event_name);
CREATE INDEX idx_ops_events_chat_event ON ops_events (corp_id, chat_id, event_name);
CREATE INDEX idx_ops_events_corp_channel ON ops_events (corp_id, source_channel, event_name);
```

**关键约定**：
- `report_date` **必须由 RPC 内部按 `(occurred_at AT TIME ZONE 'Asia/Shanghai')::date` 计算**，调用方不传这个字段。避免时区错误（如调用方在 UTC 环境算出错误日期）。
- 调用 RPC 时只传 `occurred_at`（建议默认 `now()`），RPC 自动算出 `report_date`。

**idempotency_key 设计（防重复关键）**：

| 事件 | idempotency_key |
|------|----------------|
| `friend.added` | `imContactId + ":" + createTimestamp` |
| `agent.opening_sent` | `chat_id + ":opening:" + message_id` |
| `candidate.engaged` | `chat_id + ":engaged"`（每会话仅一次）|
| `candidate.message_received` | 企微 message_id |
| `agent.replied` | 我方 message_id 或 `chat_id + ":" + sent_at_ms` |
| `job.recommended` | `chat_id + ":job_recommend:" + turn_id` |
| `precheck.passed` | `chat_id + ":precheck:" + job_id + ":" + turn_id` |
| `booking.succeeded` | `String(workOrderId)` |
| `booking.failed` | `chat_id + ":booking_fail:" + step_id` |
| `group.invited` | `chat_id + ":group:" + group_name + ":" + turn_id` |
| `handoff.triggered` | `chat_id + ":handoff:" + turn_id` |
| `interview.passed` | `String(workOrderId) + ":pass"` ⚠️ 不带 interviewPassTime（海绵修正时间不会重复计数）|
| ~~`candidate.hired`~~ | ⚠️ **已废弃不采集**（见顶部实现要点 #1）|

> **turn_id 说明**：`turn_id` = 触发本轮的企微 `messageId`（聚合时为 `batchId`），即 `agent.replied` 复用的 traceId，由 `ToolBuildContext.turnId` 透传给工具。它**按轮**而非**按候选人终身**去重：daily_ops_report 是「当天事件数」，若用 `user_id` 终身键，同一候选人后续天数再次推荐/预检/进群会被压成 0。turn_id 同批重跑保持不变，故 Bull 重试时仍能去重、不会重复 +1。工具在 turn_id 缺省（test/debug 链路）时回退时间戳。

**payload 字段约定**：
- `booking.succeeded`: `{ candidate_name, phone, brand_name, store_name, job_name, interview_time }`
- `handoff.triggered`: `{ reason_code, reason, action_advice, stage }`
- `interview.passed`: `{ interview_pass_time }`（时间放 payload，不进幂等键）
- ~~`candidate.hired`: `{ hired_at? }`~~ ⚠️ 已废弃不采集（顶部实现要点 #1）
- `friend.added`: `{ source_channel, add_way?, state? }`（来源渠道；add_way/state 为企微原始添加方式，留作回溯）
- 其他事件：可选附加上下文（如 message_id、step_id、job_id 等）

> **source_channel 反范式说明**：source_channel 是候选人画像上的固定属性，friend.added 时确定。下游事件（engaged/booking/...）的 source_channel 由 OpsEventsRecorder 写入时从画像带出（与 manager_name/group_name 同样的反范式做法），这样任何阶段都能直接 `GROUP BY source_channel` 做渠道切片。

**特点**：
- append-only 事件流，永不删除（不在 data-cleanup 的清理范围）
- idempotency_key UNIQUE 索引保证幂等：重复 INSERT 会被 PG 拒绝
- 所有分析（daily_ops_report 投影、cohort 漏斗、huajune idempotency）都从这里取数
- 长期保留 → 不受 mpr 30 天（1 个月）清理影响

### 3.4 daily_ops_report 投影表

daily_ops_report 是**从 ops_events 投影出来的汇总缓存**，主要服务 **Web 转化分析页**（Block 1 KPI / Block 3 账号对比，按时间范围 SUM）；飞书日报只是每日定时从它读一次推送。

⚠️ 同样需要 `corp_id` 字段，唯一键 `(corp_id, report_date, bot_im_id)`。

```sql
CREATE TABLE daily_ops_report (
  id bigserial PRIMARY KEY,
  corp_id text NOT NULL,                 -- ⚡ 多 corp 隔离
  report_date date NOT NULL,
  bot_im_id text NOT NULL,
  manager_name text,
  group_name text,

  -- 12 个事件计数（period snapshot，当天事件数）
  friends_added_count        integer DEFAULT 0,  -- ① friend.added
  agent_opening_sent_count    integer DEFAULT 0,  -- ② agent.opening_sent
  break_ice_count             integer DEFAULT 0,  -- ③ candidate.engaged（飞书"破冰数"）
  candidate_message_count     integer DEFAULT 0,  -- ④ candidate.message_received
  agent_reply_count           integer DEFAULT 0,  -- ⑤ agent.replied
  job_recommend_count         integer DEFAULT 0,  -- ⑥ job.recommended
  precheck_pass_count         integer DEFAULT 0,  -- ⑦ precheck.passed
  booking_success_count       integer DEFAULT 0,  -- ⑧ booking.succeeded
  booking_fail_count          integer DEFAULT 0,  -- ⑨ booking.failed
  group_invite_count          integer DEFAULT 0,  -- ⑩ group.invited
  handoff_count               integer DEFAULT 0,  -- ⑪ handoff.triggered
  interview_pass_count        integer DEFAULT 0,  -- ⑫ interview.passed（海绵 15min poll set）

  -- booking 事件的衍生明细
  candidate_summary text,                -- 每人一行：姓名 手机号
  booking_brands text[],                 -- 报名品牌列表（去重）

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),   -- 最后投影时间（迟到事件会刷新）
  UNIQUE(corp_id, report_date, bot_im_id)  -- ⚡ 加 corp_id
);
-- 全表皆为可从 ops_events 重算的投影列，不存飞书同步状态/人工备注
```

**投影机制**：
- daily_ops_report 是**投影缓存**，**所有列都从 ops_events 算出来**（不含任何不可重建的状态）
- 写 ops_events 后同步更新 daily_ops_report 对应字段 +1
  - 用 `UPSERT (corp_id, report_date, bot_im_id) ON CONFLICT DO UPDATE SET 字段 = 字段 + 1`
  - 出问题可直接从 ops_events 全量重算覆盖（**真·自愈，无副作用**——表里没有飞书同步状态/人工备注会被冲掉）
- candidate_summary / booking_brands 也是从 ops_events.payload 投影
- ~~**入职数（hired）不存这里**，Web 分析页用 `ops_events.candidate.hired` 取数~~ ⚠️ 入职已不采集（顶部实现要点 #1），无此数据
- **不存飞书同步状态**：飞书日报每日定时读一次推一次（见六-F），不回写、不增量

### 3.5 handoff_events 表（11 字段）

```sql
CREATE TABLE handoff_events (
  id bigserial PRIMARY KEY,
  chat_id text NOT NULL,
  corp_id text NOT NULL,
  user_id text,                        -- ⚡ 新增：候选人维度复盘
  reason_code text NOT NULL,           -- 原因代码（当前 10 类，见 request-handoff.tool.ts）；text 不设约束，可扩展
  reason text,                         -- Agent 给的原话
  action_advice text,                  -- ⚡ 新增：Agent 给的建议动作
  stage text,                          -- ⚡ 新增：触发时会话阶段（程序性阶段），定位 handoff 卡在哪一步
  bot_im_id text,                      -- 关联到 group
  work_order_id bigint,                -- ⚡ 新增：modify_appointment 等场景关联工单
  idempotency_key text NOT NULL,       -- ⚡ 新增：去重
  created_at timestamptz DEFAULT now(),
  UNIQUE(corp_id, idempotency_key)     -- ⚡ 按 corp 隔离去重
);

CREATE INDEX idx_handoff_events_corp_created ON handoff_events (corp_id, created_at);
CREATE INDEX idx_handoff_events_corp_reason ON handoff_events (corp_id, reason_code);
CREATE INDEX idx_handoff_events_corp_stage ON handoff_events (corp_id, stage);
CREATE INDEX idx_handoff_events_user_id ON handoff_events (user_id);
```

**特点**：
- append-only 事件流，永不更新
- 触发 handoff 时 INSERT 一行，同时也 INSERT 一行 ops_events（event_name='handoff.triggered'，payload 引用 reason/action_advice）
- handoff_events 是"触发分析底账"，ops_events 是"流水计数底账"，两者共存：
  - ops_events 用于统一聚合（daily_ops_report 投影）
  - handoff_events 提供 reason 文本、action_advice、stage 等富字段，支撑触发追踪 → 原因分析 → 调 Agent 工作流

### 3.5 索引补充

```sql
-- 日报按日聚合好友数
CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_created_date
  ON agent_long_term_memories (created_at);

-- 日报按日+manager 聚合
CREATE INDEX IF NOT EXISTS idx_mpr_received_at_manager
  ON message_processing_records (received_at, manager_name);
```

---

## 四、蛋糕产品事件清单（13 个）

| 事件 | 触发位置 | daily_ops_report 字段 | 飞书展示 | 其他用途 |
|------|---------|---------------------|---------|---------|
| `friend.added` | 候选人首条消息（accept-inbound，含加好友握手语；幂等 user_id:friend_added） | `friends_added_count` | ✅ 添加好友数 | 首次插入时开户长期记忆 |
| `agent.opening_sent` | 本会话首条对外回复（reply-workflow，幂等 chat_id:opening） | `agent_opening_sent_count` | — | huajune `candidate_contacted` |
| `candidate.engaged` | 候选人首条**真实**消息（破冰，排除加好友纯默认招呼语）| `break_ice_count` | ✅ **破冰数** | |
| `candidate.message_received` | 候选人发消息（排除加好友纯默认招呼语）| `candidate_message_count` | — | huajune `message_received` |
| `agent.replied` | Agent 回复发出 | `agent_reply_count` | — | huajune `message_sent` |
| `job.recommended` | job_list 工具成功 | `job_recommend_count` | — | |
| `precheck.passed` | precheck 工具通过 | `precheck_pass_count` | — | |
| `booking.succeeded` | booking 工具成功 | `booking_success_count`<br>+ `candidate_summary` append<br>+ `booking_brands` append | ✅ 成功报名数 | huajune `interview_booked` |
| `booking.failed` | booking 工具失败 | `booking_fail_count` | — | |
| `group.invited` | invite_to_group 工具成功 | `group_invite_count` | ✅ 邀请进群数 | |
| `handoff.triggered` | request_handoff 工具 | `handoff_count` | — | `handoff_events` 表写入（详情）|
| `interview.passed` | 海绵 15min poll 写 ops_events | `interview_pass_count`（投影 +1）| ✅ 通过数 | |
| ~~`candidate.hired`~~ | ⚠️ **已废弃，不采集**（见顶部实现要点 #1：轮询收口到 interview.passed，不写 hired）| — | — | — |

> ⚠️ 上表标"13 个"，但 `candidate.hired` 已废弃不采集，**实际生效 12 个事件**。

**飞书表头 5 列**：添加好友数 / 破冰数 / 成功报名数 / 邀请进群数 / 通过数

**海绵 currentStatus 9 个枚举值**（生命周期顺序）：约面待确认 → 约面失败 / 约面取消 / 约面成功 → 面试失败 / 面试成功 → 上岗失败 / 上岗成功 → 已离职

---

## 五、5 个数据写入入口

**统一原则**：所有事件先 INSERT `ops_events`（带 idempotency_key 防重），再投影更新 `daily_ops_report` 对应字段。两步在同一个事务中：

```
事件发生
  ↓
INSERT INTO ops_events(...) ON CONFLICT (corp_id, event_name, idempotency_key) DO NOTHING
  ↓
若 INSERT 真正发生（不是冲突跳过）→ UPSERT daily_ops_report 对应字段 +1
```

**幂等性**：重复事件因为 idempotency_key 冲突会被 PG 拒绝，投影也不会重复 +1。

```
┌─────────────────────────────────────────────────────────────────┐
│                       数据写入                                  │
└─────────────────────────────────────────────────────────────────┘

①② 加好友 + 开场白 (微信加好友握手语，走常规消息管道)
   ⚠ 现状修正（2026-06 据生产 chat_messages 实测）：线上**没有**独立的 `/wecom/customer/callback`
     新增客户回调，也**没有**配置平台 SOP（NEW_CUSTOMER_ANSWER_SOP / 合成 "[新好友添加]" 的设想已废弃）。
     候选人加好友时，微信以普通 user 消息（source=MOBILE_PUSH）推送一条「握手语」，三类形态：
       - 「我是{昵称}」（微信加好友默认招呼语）
       - 「请求添加你为朋友」
       - 「我通过了你的(朋友|联系人)验证请求，现在我们可以开始聊天了」
     这条握手语正常过滤通过 → 触发 Agent → Agent 回它即开场白（"你好呀 + 你在哪个区域找工作"）。

   friend.added（加好友数）—— accept-inbound：
     → 任何候选人首条消息都代表新好友（含握手语），idempotency_key=user_id+":friend_added"
       → 每候选人一次；为省 RPC，仅在「握手语」或「首条真实消息(破冰)」时尝试。
     → 首次真正插入时开户长期记忆元数据（message_metadata；不写 name/gender，微信昵称不可信）。
     → 投影 daily_ops_report.friends_added_count +1
     ⚠ source_channel 暂统一落 'unknown'（上游渠道透传待接入，见 §出口2 来源渠道维度规划）

   agent.opening_sent（开口数）—— reply-workflow：
     → Agent 对本会话**首条**对外回复即开场白，idempotency_key=chat_id+":opening" → 每会话一次。
       （用幂等插入返回值判定"首条"：首次插入成功=开场白，之后插入冲突=普通回复 agent.replied）
     → 投影 daily_ops_report.agent_opening_sent_count +1
     → huajune 上报 candidate_contacted（key=chat_id+":first_contact"；开场白不报 message_sent）

③ 预约成功 (Agent → duliday_interview_booking → 海绵)
   海绵返回: data.workOrder.workOrderId (int64)
   → agent_long_term_memories.latest_booking 写入（latest_work_order_id + linked_at）
   → INSERT ops_events(booking.succeeded, idempotency_key=String(workOrderId),
       payload={ candidate_name, phone, brand_name, store_name, job_name, interview_time })
     → 投影 daily_ops_report.booking_success_count +1
       + candidate_summary append (从 payload 取)
       + booking_brands 去重 append
   → agent_long_term_memories.profile_facts writeFromBooking（已有逻辑）
   → huajune 上报 interview_booked (idempotency 复用 workOrderId)

④ Agent 调 request_handoff
   → INSERT handoff_events（含 reason_code, reason, action_advice, stage, idempotency_key）
     ⚡ stage 取自当前程序性阶段（procedural），用于分析 handoff 卡在对话哪一步
   → INSERT ops_events(handoff.triggered, idempotency_key=同上,
       payload={ reason_code, reason, action_advice, stage })
     → 投影 daily_ops_report.handoff_count +1
   → 现有的 pauseUser + 飞书告警（保持不变）
   ⚠ 工具返回 { shortCircuited: true/false }，由 runtime 决定是否短路

⑤ 每轮对话
   → message_processing_records（已有，不改）
   → 候选人消息（**排除微信加好友纯默认招呼语**，见下）:
     - INSERT ops_events(candidate.message_received, idempotency_key=企微 message_id)
       → 投影 daily_ops_report.candidate_message_count +1
     - huajune message_received
   → Agent 回复:
     - 本会话首条对外回复 → agent.opening_sent（见 ②，不记 agent.replied）
     - 其余回复 → INSERT ops_events(agent.replied, idempotency_key=我方 message_id)
       → 投影 daily_ops_report.agent_reply_count +1 + huajune message_sent
   → 候选人首条破冰（candidate.engaged，PG RPC check_and_record_first_engaged 原子完成）:
       1. 先 INSERT ops_events(candidate.message_received, idempotency_key=企微 message_id)，
          取得新事件的 occurred_at（设为 T_now）
       2. SELECT 1 FROM ops_events WHERE corp_id=? AND chat_id=?
            AND event_name='candidate.message_received' AND occurred_at < T_now LIMIT 1
       3. 步骤 2 返回空（此前无候选人消息）→ 当前是首条破冰：
            INSERT ops_events(candidate.engaged, idempotency_key=chat_id+":engaged")
              → 投影 daily_ops_report.break_ice_count +1
     ⚠️ **破冰排除「加好友纯默认招呼语」**（isPureFriendAddGreeting）：
        「我是{昵称}」「请求添加你为朋友」「我通过了你的…验证请求」**不记 candidate.message_received**，
        因此不会触发破冰；带求职意图的「我是找工作的/我是兼职/我是应聘的」仍正常计入破冰。
        （排除是为避免把加好友握手动作算成候选人真实开口，虚高破冰率）
     ⚠️ 用 occurred_at < T_now 避免把当前消息误算进"之前"
     ⚠️ 用 ops_events 不用 mpr，避免 30 天（1 个月）清理影响
   → Agent 工具执行结果:
     - job_list 成功 → INSERT ops_events(job.recommended)
     - precheck 通过 → INSERT ops_events(precheck.passed)
     - booking 失败 → INSERT ops_events(booking.failed)
     - invite_to_group 成功 → INSERT ops_events(group.invited)
```

---

## 六、4 个数据读取场景

### A. Agent 上下文 — 每轮注入 [当前预约信息]

```
读 agent_long_term_memories.latest_booking（按 user_id 查）
  → 有值 → 查 Redis 缓存 sponge:workorder:{latest_work_order_id}（TTL 5min）
    ├─ 命中 → 直接用缓存
    ├─ miss → 调海绵 signup/list（定位键 workOrderId=latest_work_order_id，
    │         从 workOrders[] 挑出该条）→ 写缓存 → 返回
    └─ 海绵失败 → 不渲染（按"海绵不会挂"的假设）
  → 无值 → 不渲染 [当前预约信息]（如需兜底，可按 profile.phone 查最近工单，见场景③）
```

### B. request_handoff 守卫 — modify_appointment 专用

```
reasonCode='modify_appointment' + latest_booking 为 null
  → 返回 HANDOFF_NO_BOOKING 错误（非短路，Agent 继续对话）

reasonCode='modify_appointment' + latest_booking 不为 null
  → 正常 handoff 流程（候选人有过预约就允许走 handoff）

其他 reasonCode → 不受影响，保持原逻辑
```

### C. daily_ops_report — ops_events 投影 + cron poll

**投影路径**：先写 ops_events 底账（带 idempotency_key 去重），成功 INSERT 后再投影更新 daily_ops_report；重复事件被底账层拒绝，投影不会重复 +1。

**11 个事件投影路径**：
```
friend.added              → friends_added_count +1
agent.opening_sent        → agent_opening_sent_count +1
candidate.engaged         → break_ice_count +1
candidate.message_received → candidate_message_count +1
agent.replied             → agent_reply_count +1
job.recommended           → job_recommend_count +1
precheck.passed           → precheck_pass_count +1
booking.succeeded         → booking_success_count +1
                          + candidate_summary append
                          + booking_brands append
booking.failed            → booking_fail_count +1
group.invited             → group_invite_count +1
handoff.triggered         → handoff_count +1

粒度: (corp_id, report_date, bot_im_id) 自动 UPSERT
```

**海绵 15min cron poll**：

⚠️ **来源**：扫 `ops_events` 的 booking.succeeded（不用 latest_booking，避免被新预约覆盖丢历史）。
⚠️ **写入**：走 ops_events 底账，不直接 SET daily_ops_report，保持统一投影路径。

```
1. SELECT 所有 booking.succeeded 事件的 (corp_id, user_id, workOrderId, phone, bot_im_id)
   FROM ops_events
   WHERE event_name = 'booking.succeeded'
   AND report_date >= today - 60 days        -- 实际 lookbackDays = 60（顶部实现要点 #6），非 30

2. 按 phone 去重，逐候选人调海绵 fetchSignupWorkOrders({ phone })
   （一次拿回该候选人全部工单，省调用；详见「海绵工单查询 signup/list — 按场景参数设计」）
   仅处理本步骤列表里记录过的 workOrderId，避免把候选人自招/线下工单计入"通过数"

3. 对返回的工单遍历：
   - 若 interviewPassTime 非空（按字段判定，不限当前态，兼容"面试成功"快速跃迁到"上岗成功/已离职"）:
     → INSERT ops_events(interview.passed,
                         occurred_at = interviewPassTime,  ⚠️ 业务时间，不是 poll 当前时间
                         idempotency_key = workOrderId + ":pass",
                         payload = { interview_pass_time: interviewPassTime, ... })
       → RPC 内部按 occurred_at 算 report_date，落到正确日期
       → 投影 daily_ops_report.interview_pass_count +1
   - ⚠️ ~~若 currentStatus = '上岗成功' → INSERT candidate.hired~~
     **已废弃，不实现**（见顶部实现要点 #1）：轮询只补 interview.passed，不再采集入职。

   ⚠️ 关键约束：
     - idempotency_key 保证同一工单只触发一次 interview.passed / candidate.hired
     - occurred_at 必须用业务发生时间（interviewPassTime），不是 poll 当前时间
       否则昨天通过、今天 poll 发现，会落到今天日报（口径错）

⚠️ latest_booking 不做生命周期维护（永不清空）
⚠️ hired_count 不存 daily_ops_report
```

### D. Web 转化分析页（新菜单 `/conversion-analysis`）

```
顶部 ControlPanel: 时间范围 ▼ | 小组 ▼ | 来源渠道 ▼

Block 1: 12 个事件 KPI 卡片 + 趋势曲线
  数据源: daily_ops_report 按时间范围 SUM
  入职数：cohort 漏斗里展示，不在这里

Block 2: Cohort 漏斗（独立查询）
  Cohort 维度切换: 加好友 / 报名
  来源渠道筛选: 选定渠道后，cohort 取数与各阶段命中都加 `AND source_channel = 选定值`
               （source_channel 已反范式到每条 ops_events，直接过滤即可，无需 join 画像）

  ⚠️ 实际阶段见顶部实现要点 #7（无"入职"级；进群为破冰侧支，分母=破冰）：
  ─ 加好友 cohort: 本期加好友 N 人里
    → 后续 破冰/邀请进群/报名/面试通过 命中数

  ─ 报名 cohort: 本期报名 N 人里
    → 后续 面试通过 命中数

  Cohort 查询实现（全部基于 ops_events，不依赖 mpr）：
    Step 1: 取 cohort（每个 user_id 记录其 cohort 时间 cohort_occurred_at）
      - friend_added: SELECT user_id, MIN(occurred_at) as cohort_occurred_at
                      FROM ops_events
                      WHERE event_name='friend.added' AND report_date IN [range]
                      GROUP BY user_id
      - booking:      SELECT user_id, workOrderId (from payload), MIN(occurred_at) as cohort_occurred_at
                      FROM ops_events
                      WHERE event_name='booking.succeeded' AND report_date IN [range]
                      GROUP BY user_id, workOrderId

    Step 2: 各阶段命中（⚠️ 必须加时间约束 occurred_at >= cohort_occurred_at，
            避免把 cohort 之前的旧事件算进来）
      - 破冰:   ops_events WHERE event_name='candidate.engaged'
                AND user_id IN cohort
                AND occurred_at >= cohort_occurred_at
      - 报名:   ops_events WHERE event_name='booking.succeeded' AND ...
      - 进群:   ops_events WHERE event_name='group.invited' AND ...
      - 通过:   ops_events WHERE event_name='interview.passed' AND ...
      - ~~入职:   event_name='candidate.hired'~~ 已废弃（顶部实现要点 #1，不采集）

      ⚠️ 报名 cohort 特殊处理：通过/入职阶段建议**按 workOrderId 串**（cohort 取的就是
        booking 事件，每条带 workOrderId）。后续 interview.passed / candidate.hired
        的 idempotency_key 也是 workOrderId 前缀，可以精确 join。
        避免：候选人 A 在 cohort 之外又新预约了别的工单又通过了，被错误算进 cohort。

    Step 3: 聚合 cohort 总数 + 各阶段命中数

  ⚠️ 关键：ops_events 是长期保留，不在 data-cleanup 范围内
  ⚠️ 不再依赖 message_processing_records.agent_steps（30 天清理会失数据）

Block 3: 对比表（维度可切：小组 / 账号 / 来源渠道）
  | 维度值 | 12 个事件计数 | 整体转化率 |
  - 来源渠道对比：`GROUP BY source_channel` 聚合 ops_events 各阶段事件数 + 转化率
    → 看哪个渠道不只是量大、而是**获客质量高**（破冰率/报名率/通过率）

Block 4: Handoff 原因分布
  饼图（当前 10 类 reason_code，可扩展）+ 总触发数
  + 按阶段（stage）分布：handoff 集中在对话哪一步，定位待优化环节
  数据源: handoff_events
```

### E. 仪表盘小组筛选

现有 dashboard 顶部 ControlPanel 加"小组"筛选下拉。
后端 `AnalyticsController` 接受 `groups?` 参数过滤所有现有指标。

### F. 飞书日报同步（每日 21:00 cron）

**每日一次性快照推送**，不回写、不增量、不管飞书侧后续变更：

```
21:00 cron:
  SELECT daily_ops_report WHERE report_date = today
  → 按每行 bot_im_id 解析托管账号 Duliday-Token
  → 调海绵 /ai/api/workorder/signup/self/list：
      signUpStartTime/signUpEndTime             → 覆盖成功报名数、候选人基本信息、报名品牌
      interviewPassStartTime/interviewPassEndTime → 覆盖通过数
  → 每个 bot 一行，推 5 列到飞书 bitable:
      friends_added_count   → 添加好友数
      break_ice_count       → 破冰数
      booking_success_count → 成功报名数（海绵覆盖）
      group_invite_count    → 邀请进群数
      interview_pass_count  → 通过数（海绵覆盖）
  → 另带 candidate_summary（海绵录入姓名）+ booking_brands
  其余字段不推飞书（仅服务 Web 分析页）
```

⚠️ **飞书为 21:00 当天快照**：21:00 之后才发生的报名/通过会在 Web 分析页继续更新；飞书日报定位为当天晚 9 点的一次性快照。
⚠️ 不存 feishu_record_id / synced_at；cron 一天跑一次。若手动重跑会在飞书重复建记录（可接受，不做去重）。

---

## 七、3 个定时任务

| 任务 | 频率 | 内容 |
|------|------|------|
| 事件驱动写入 | 实时 | 11 个事件 → INSERT ops_events + 投影 daily_ops_report |
| 海绵 poll | 每 15min | 从 ops_events.booking.succeeded 扫近 **60 天**工单 → 查海绵 → INSERT ops_events(**仅 interview.passed**；candidate.hired 已废弃) → 投影 daily_ops_report |
| 飞书同步 | 每日 21:00 | 当天数据 → 飞书 bitable |

---

## 八、huajune 埋点上报（4 个事件）

**配置**:
- `HUAJUNE_API_BASE_URL`（默认 `https://huajune.duliday.com`）
- `HUAJUNE_API_TOKEN`

**agentId 命名**: `{manager_name}-cake-{index}`
- 维护 `manager_name + bot_im_id → index` 映射表

**4 个事件触发点（互斥语义参考 zhipin）**:

| 事件 | 触发位置 | idempotencyKey |
|------|---------|---------------|
| `message_received` | `AcceptInboundMessageService.execute` 过滤后 | 企微 message_id |
| `message_sent` | `MessageSenderService` 发送成功后（**非主动打招呼场景**）| 我方 message_id 或 chat_id+ts |
| `candidate_contacted` | 新好友 → 首次开场白发送成功 | chat_id + ":first_contact" |
| `interview_booked` | `duliday_interview_booking` tool 成功后 | String(workOrderId) |

**互斥规则**：主动打招呼场景只报 `candidate_contacted`（不报 `message_sent`），避免 huajune 那边重复计数。

**实现要点**: 全部 fire-and-forget，失败打 warn 日志，不阻塞主流程

---

## 九、handoff 流程

handoff 涉及两件**互不相干**的事，分开处理——别混在一起看：

| 关注点 | 由谁表达 | 用途 |
|--------|---------|------|
| **运行时状态**：这人现在归谁管 | `UserHostingService` 的 pause/resume 一层（pause=人工跟进中，active=AI 跟进；3 天自动解禁）| 决定 AI 要不要继续自动回复 |
| **触发分析**（本节重点）：何时/为何转人工 | `handoff_events` 底账 + `ops_events.handoff.triggered` | 聚合原因、定位卡点、回捞对话 → 反推优化 Agent 托管流程 |

不再维护 recruitment_cases 的 `active/handoff/closed` 状态机：运行时状态用 pause 一层就够，分析价值全部沉到 handoff_events。

### 触发流程

```
Agent 调 request_handoff
  ↓
InterventionService.dispatch()
  ├─ ① UserHostingService.pauseUser()    运行时状态：暂停 AI 托管
  ├─ ② handoff_events INSERT 一行         触发分析底账（reason_code/reason/stage/...）
  ├─ ③ daily_ops_report.handoff_count +1 计数累加
  └─ ④ 发飞书告警

招聘经理恢复托管
  ↓
UserHostingService.resumeUser()           运行时状态：恢复（不做任何 case 状态操作）
```

### handoff_events 是触发分析底账

每次 `request_handoff` 触发都 INSERT 一行，目标是支撑「**触发追踪 → 原因分析 → 调 Agent 工作流**」闭环：

| 分析问题 | 用什么字段 |
|---------|-----------|
| 哪类原因最高发 | `reason_code` 聚合（Block 4 饼图）|
| handoff 集中在对话哪个阶段 | `stage` 聚合 → 针对该阶段改 prompt / 工具 |
| 哪个号 / 经理转人工最多 | `bot_im_id` 聚合 |
| 具体卡在哪、是不是误触发 | `reason` 原话 + `chat_id` 回捞整段对话复盘 |
| 关联的预约工单 | `work_order_id`（modify_appointment 等）|

> 误触发（如背景 #1 的 modify_appointment 误判）也沉到这张表，复盘后回修 Agent；可进一步把 handoff 样本按 reason_code / stage 分桶喂给对话评估框架，量化"本可避免的转人工"。

### 代码变更点

| 文件 | 操作 |
|------|------|
| `src/biz/intervention/intervention.service.ts` | 移除 `markHandoff()` 调用，新增 `handoffEventsRepository.insert()` |
| `src/biz/user/user.controller.ts` | 移除 `closeLatestHandoffCase()` 调用 |
| `src/biz/hosting-config/services/hosting-config-facade.service.ts` | 同上 |
| 新建 `src/biz/handoff-events/handoff-events.repository.ts` | INSERT handoff_events |
| `src/biz/recruitment-case/services/recruitment-case.service.ts` | 标 @deprecated |

---

## 十、附带的 bug 修复 + 改造

### Sponge 集成
- 新增 `SPONGE_API_BASE_URL` 环境变量（默认 `https://gateway.duliday.com/sponge`）
- 工单查询 URL：`${SPONGE_API_BASE_URL}/ai/api/workorder/signup/list`
- **修复预约接口 Zod schema 丢 workOrder 字段的 bug**（让 booking_id 不再全为 NULL）
- 海绵 API 加 Redis 缓存层（5min TTL）

### 海绵工单查询 signup/list — 按场景参数设计

**接口契约**（`POST ${SPONGE_API_BASE_URL}/ai/api/workorder/signup/list`，Header `Duliday-Token`）

请求体：
```
{
  workOrderId?: int64,    // 定位键：定位到某候选人；与 phone 至少传一个
  phone?: string,         // 定位键：定位到某候选人；与 workOrderId 至少传一个
  queryParam?: {
    signUpStartTime?, signUpEndTime?,               // 报名时间段
    interviewPassStartTime?, interviewPassEndTime?,  // 面试通过时间段
    currentStatus?: string[]                         // 当前状态中文列表过滤
  }
}
```

响应（**候选人维度**，一次返回该候选人全部报名工单，受 queryParam 过滤）：
```
data: {
  candidateName, gender, phone, age, total,
  workOrders: [{
    workOrderId, signUpTime, interviewPassTime,
    brandId, brandName, companyId, companyName,
    projectId, projectName, jobId, jobBasicInfoId, jobName,
    currentStatus, workOrderStatus, salary, salaryUnit, salaryPeriod
  }]
}
```

**两条硬约束（决定各场景怎么查）**：
1. **必须按候选人定位**：`workOrderId` / `phone` 至少传一个，**没有"全局列出今天所有通过工单"这种查法**。→ 任何"批量盯状态"的需求只能由我方底账枚举候选人后逐个查（15min poll 必须从 `ops_events.booking.succeeded` 驱动，不能反过来问海绵）。
2. **响应是候选人全部工单**：传任一定位键都返回该候选人的工单**列表** → 用 workOrderId 定位时，仍要在 `workOrders[]` 里挑出目标那条。

**currentStatus 9 态**：约面待确认 → 约面失败 / 约面取消 / 约面成功 → 面试失败 / 面试成功 → 上岗失败 / 上岗成功 → 已离职。映射：`interview.passed` ← 面试成功（`interviewPassTime` 非空）；`candidate.hired` ← 上岗成功。

**场景 → 参数矩阵**：

| 场景 | 定位键 | queryParam | 用途 | 阶段 |
|------|-------|-----------|------|------|
| ① Agent 上下文 [当前预约信息] | `workOrderId` = latest_work_order_id | 无 | 渲染该次预约当前状态/品牌/门店/岗位/面试时间 | P1 |
| ② 15min cron 状态推进 | 按 `phone` 去重逐候选人 | 可不传（或 currentStatus 含全部"已过面试"态）| 检测 面试成功→interview.passed、上岗成功→candidate.hired | P1 |
| ③ latest_booking 缺失兜底 | `phone`（取自 profile）| 无（按 signUpTime 取最近一条）| 无 workOrderId 时恢复"当前预约信息" | P1 兜底 |
| ④ 报名前查重 | `phone` | `currentStatus=[约面待确认,约面成功,面试成功,上岗成功]` | 判断是否已有进行中工单，避免重复预约 | 可选 |
| ⑤ handoff 上下文（自招/追问结果）| `phone` | 无 | 给招聘经理候选人工单全貌 | 可选 |

**各场景要点**：

- **① Agent 上下文**：定位键用 workOrderId（latest_booking 已记，精确；只关心"最近这次"而非全部历史）；不加 queryParam（要当前真实状态）；响应里挑 `workOrderId == latest_work_order_id` 那条渲染；Redis 缓存 5min（key=`sponge:workorder:{workOrderId}`）。
- **② cron 状态推进**：
  - 没有全局查询 → **只能从 `ops_events.booking.succeeded` 近30天列表枚举候选人**；该列表自带 phone，**按 phone 去重逐候选人查一次**即可拿回其全部工单，比逐 workOrderId 省调用。
  - 判定用**字段值而非仅当前态**：`interviewPassTime` 非空 → interview.passed（occurred_at=interviewPassTime）；`currentStatus=上岗成功` → candidate.hired（occurred_at 用 poll 当前时间，API 无上岗时间字段；hired 不投影日报，时间不敏感）。这样即使两次 poll 间从"面试成功"快速跃迁到"上岗成功/已离职"，也不漏 interview.passed。
  - **只对我方底账记录过的 workOrderId 发事件**：候选人自招/线下产生的工单不计入"通过数"，保持漏斗与我方预约对齐。
  - queryParam.currentStatus 过滤仅为减载的可选项；若启用，须包含所有"已过面试"的终态（面试成功/上岗成功/上岗失败/已离职），否则会漏掉快速跃迁工单的 interviewPassTime。
- **③ 缺失兜底**：仅当 latest_work_order_id 为空但 profile 有 phone 时启用，按 signUpTime 取最近一条兜底渲染。
- **④ 报名前查重**：可选增强，预约前用 phone + 进行中状态集合查，命中则提示/转人工而非重复预约。
- **⑤ handoff 上下文**：`self_recruited_or_completed` / `interview_result_inquiry` 触发时按 phone 拉全部工单，把状态写进 handoff 上下文/告警，方便招聘经理判断。

### request_handoff + runtime 短路语义

```typescript
// src/agent/runner/agent-runner.service.ts 新增 helper
// ⚠️ 注意：AI SDK 的 toolResult 用 .output 而不是 .result
//    参考现有 runner.service.ts:427-428 的取值方式
function shortCircuitByResult(toolName: string): StopCondition<any> {
  return ({ steps }) => {
    const lastStep = steps[steps.length - 1];
    if (!lastStep?.toolResults) return false;
    const tr = lastStep.toolResults.find((r) => r.toolName === toolName);
    if (!tr) return false;
    const output = (tr as { output?: unknown }).output as { shortCircuited?: boolean } | undefined;
    return output?.shortCircuited === true;  // ← 由工具返回值决定
  };
}

// 替换原 stopWhen（invoke + stream 两处都改）
stopWhen: [
  stepCountIs(ctx.maxSteps),
  hasToolCall(SKIP_REPLY_TOOL_NAME),         // skip_reply 仍无条件短路
  shortCircuitByResult('request_handoff'),    // request_handoff 看返回值
],

// 同步修改 recoverEmptyTextResult 的判断逻辑（line 497-503）
```

**工具内部约定**：
- 正常 handoff → 返回 `{ dispatched: true, shortCircuited: true, ... }` → runtime 停
- HANDOFF_NO_BOOKING 拒绝 → 返回 `{ errorType, shortCircuited: false }` → runtime 继续

新增 `HANDOFF_NO_BOOKING` 错误类型，`modify_appointment` + 无 latest_booking → 非短路拒绝。

### 新好友感知 + 破冰排除握手语（替代原 synthetic 方案）

> ⚠ **已废弃**：原计划"放行 CONTACT_CARD/WECOM_SYSTEM + 合成 `[新好友添加]` + `is_synthetic` 列"
> **未实施**。生产实测加好友是微信以普通 user 消息（MOBILE_PUSH）推送握手语、Agent 直接回它即开场白，
> 无需放行新消息类型、无需合成消息。
> ⚠️ 注意：`is_synthetic` 列与部分索引**迁移里仍建了**（顶部实现要点 #4），但代码零引用，是孤儿列。

- `friend.added`（accept-inbound）：任何候选人首条消息都代表新好友（含握手语），幂等 `user_id:friend_added`；
  首次插入时开户长期记忆元数据。
- `agent.opening_sent`（reply-workflow）：本会话首条对外回复即开场白，幂等 `chat_id:opening`。
- 破冰排除握手语：`isPureFriendAddGreeting`（`src/channels/wecom/message/utils/friend-add-greeting.util.ts`）
  命中即不记 `candidate.message_received` → 破冰落到下一条真实消息。**纯文本识别，不动 DB schema**。

### latest_booking 读写
- 不新建模块，在现有 `LongTermService` 上加：
  - `setLatestBooking(corpId, userId, workOrderId)` — 预约成功时 UPSERT
  - `getLatestBooking(corpId, userId)` — Agent 上下文 / handoff 守卫读取
- 永不清空，新预约 UPSERT 覆盖

---

## 十一、实施顺序（P0 / P1 / P2 三阶段）

三阶段：先修数据底座和阻塞 bug，再做日报闭环，最后做深度分析和跨系统埋点。

### P0：数据底座 + 阻塞 bug 修复（必须先做）

```
P0-1. Supabase 迁移（数据底座）
  - 新建 ops_events 表
    - 含 corp_id（多 corp 隔离）
    - UNIQUE(corp_id, event_name, idempotency_key)
    - report_date 由 RPC 内部按 Asia/Shanghai 计算（不由调用方传）
  - 新建 daily_ops_report 表
    - 含 corp_id
    - UNIQUE(corp_id, report_date, bot_im_id)
  - 新建 handoff_events 表（**12 字段**：含 stage、created_at、idempotency_key UNIQUE）
  - agent_long_term_memories.latest_booking 加列
  - ⚠️ message_processing_records.is_synthetic 列：**迁移实际加了**（含部分索引 idx_mpr_synthetic），
    但破冰最终改用文本识别（isPureFriendAddGreeting），**该列代码零引用 = 孤儿列**（顶部实现要点 #4，待清理）
  - RPC 函数：
    - `upsert_ops_event(corp_id, event_name, occurred_at, ...)` — 内部算 report_date + INSERT ops_events + UPSERT daily_ops_report 投影
    - `check_and_record_first_engaged(corp_id, chat_id, message_id, occurred_at)` — 原子检测 + 写入破冰事件

P0-2. SpongeService booking schema 修复
  - 修复 InterviewBookingApiResponseSchema 的 workOrder 子对象（关键 bug）
  - bookInterview() 提取 data.workOrder.workOrderId
  - 让 booking 成功后能拿到真正的 workOrderId

P0-3. runtime 短路语义改造
  - src/agent/runner/agent-runner.service.ts 新增 shortCircuitByResult helper
  - ⚠️ 取值用 .output 而非 .result（参考 runner.service.ts:427-428）
  - invoke + stream 两处 stopWhen 配置改造
  - 同步修 recoverEmptyTextResult 判断逻辑

P0-4. 事件底账写入服务（OpsEventsRecorder）
  - 新建 src/biz/ops-events/ 模块
  - 提供 recordEvent({ corpId, eventName, occurredAt, payload, idempotencyKey, ... }) 接口
  - 内部调 RPC：INSERT ops_events + 投影更新 daily_ops_report
  - 所有事件统一走这个入口，包括 interview.passed / candidate.hired
```

### P1：运营日报闭环（基础功能可用）

```
P1-1. SpongeService 工单查询接入
  - fetchSignupWorkOrders({ workOrderId?, phone?, queryParam? }) + Zod schema
    （workOrderId/phone 至少一个；响应候选人维度，含 workOrders[]）
  - SPONGE_API_BASE_URL 环境变量
  - Redis 缓存层（5min TTL）

P1-2. LongTermService.setLatestBooking / getLatestBooking
  - 写预约成功时的 work_order_id 指针
  - 永不清空，新预约 UPSERT 覆盖

P1-3. 新好友感知（✅ 已实施，方案与原计划不同）
  - 实际：加好友是微信普通 user 消息（MOBILE_PUSH）推送握手语，无独立回调、未配 SOP
  - friend.added 改在 accept-inbound 按候选人首条消息记（含握手语，幂等 user_id:friend_added，首次开户长期记忆）
  - agent.opening_sent 改在 reply-workflow 按本会话首条对外回复记（幂等 chat_id:opening）
  - 破冰排除握手语：isPureFriendAddGreeting（friend-add-greeting.util.ts），命中不记 candidate.message_received
  - ❌ 废弃：POST /wecom/customer/callback 回调、SupportedMessageTypeFilterRule 放行新类型、synthetic 标记
  - source_channel 暂统一落 'unknown'（上游渠道透传待接入，不阻塞）

P1-4. 预约流程迁移
  - duliday-interview-booking.tool.ts 改写
  - 写 latest_booking + INSERT ops_events(booking.succeeded)
  - 移除 recruitment_cases 写入

P1-5. Agent 上下文迁移
  - 用 latest_booking + Redis 缓存 + 海绵实时查
  - formatRecruitmentCase → formatBookingContext

P1-6. request_handoff 守卫 + handoff_events 写入
  - 新增 HANDOFF_NO_BOOKING 错误类型
  - 返回值带 shortCircuited 标记（配合 P0-3 的 runtime 改造）
  - INSERT handoff_events + INSERT ops_events(handoff.triggered)

P1-7. handoff 流程简化
  - 移除 markHandoff(caseId) 调用
  - 移除 closeLatestHandoffCase() 调用

P1-8. 飞书日报同步（cron 21:00）
  - 读 daily_ops_report WHERE report_date = today
  - 每日一次性推 5 列到飞书 bitable（不回写、不增量）

P1-9. 海绵 15min cron poll（✅ 已实施，sponge-status-poll.cron.ts）
  - 从 ops_events.booking.succeeded 扫近 **60 天**（lookbackDays=60）"已 booking、未 interview.passed"的工单
  - 按工单逐个查海绵（getCachedWorkOrderById，按 botImId 解析 token），只处理底账记录过的 workOrderId
  - 若 interviewPassTime 非空（按字段判定，不限当前态）:
    → INSERT ops_events(interview.passed, occurred_at=interviewPassTime) + 投影 daily_ops_report.interview_pass_count +1
  - ⚠️ ~~若 currentStatus='上岗成功' → INSERT candidate.hired~~ **已废弃不实现**（顶部实现要点 #1，收口到面试通过）
```

### P2：深度分析 + 跨系统埋点

```
P2-1. Web 转化分析页 + 仪表盘小组筛选
  - 后端 src/biz/conversion-analytics/ 模块（各接口支持 channel= 过滤）
    - GET /analytics/conversion/kpis           5 个转化率
    - GET /analytics/conversion/funnel          cohort 漏斗（基于 ops_events；可按 source_channel 拆分）
    - GET /analytics/conversion/bots            账号 / 来源渠道对比表（GROUP BY bot 或 source_channel）
    - GET /analytics/conversion/handoff         handoff 原因 + 阶段（基于 handoff_events）
  - 前端 web/src/view/conversion-analysis/list/（ControlPanel 加小组 + 来源渠道下拉）
  - 仪表盘 ControlPanel 加 group 下拉
  - ⚠ 来源渠道维度依赖 source_channel 数据接入（item 1 后续确认）；未接入前默认 unknown，UI 可先隐藏渠道下拉

P2-2. huajune 埋点模块
  - HUAJUNE_API_BASE_URL + HUAJUNE_API_TOKEN
  - agentId 映射表
  - 4 个事件触发点：复用 ops_events 的 idempotency_key 防重复
  - fire-and-forget

P2-3. 测试 + 废弃标记 recruitment_cases
  - 标记 RecruitmentCaseService.markHandoff / closeLatestHandoffCase @deprecated
  - 不删表、不迁数据
  - 全量回归测试
```

---

## 十二、关键设计权衡

1. **latest_booking 极简（永不清空）**
   - 只存 work_order_id + linked_at，不维护状态机
   - 业务字段全部实时查海绵（Redis 缓存 5min）
   - 简单可靠，无僵尸数据问题

2. **不统计入职（最终实现，顶部实现要点 #1）**
   - 飞书表头没入职列；统计收口到"面试通过"
   - ~~Web cohort / KPI 读 `ops_events.candidate.hired`~~ → candidate.hired 不再采集，整体转化率改用"面试通过/加好友"
   - 避免"累计快照"语义歧义 + 海绵无上岗时间字段

3. **Period Snapshot 全口径**
   - 飞书日报和 Web 12 事件视图都用 period snapshot
   - cohort 漏斗作为额外视角独立查询
   - 数据语义清晰、不混淆

4. **daily_ops_report 12 列平铺**
   - 直观、查询简单
   - 加新事件需 ALTER TABLE，但接受这个代价（事件清单相对稳定）

5. **15min poll 走 ops_events 底账**
   - 来源：扫 ops_events.booking.succeeded 近 30 天工单
   - 写入：INSERT ops_events(interview.passed / candidate.hired) → 投影 daily_ops_report
   - 不依赖 latest_booking（避免被新预约覆盖丢历史）
   - 不维护 latest_booking 生命周期

6. **handoff_events 单独建表**
   - 11 字段（含 user_id / action_advice / stage / work_order_id / idempotency_key）
   - append-only，按 (corp_id, idempotency_key) 唯一
   - 与 ops_events.handoff.triggered 并存：ops_events 做计数底账，handoff_events 提供 reason 文本等富字段
   - 方便按 reason_code 聚合分析

7. **huajune 上报互斥**
   - candidate_contacted 和 message_sent 互斥
   - 避免 huajune 那边重复计数（参考 zhipin 工具的处理方式）

8. **海绵不会挂的假设**
   - latest_booking 极简后没有降级数据
   - Agent 上下文渲染依赖海绵 API 可用性
   - Redis 缓存 5min 缓解高频访问压力

---

## 十三、验证清单

### P0 验证
- [ ] `pnpm test` + `pnpm lint` + `pnpm build`
- [ ] ops_events 表 idempotency_key UNIQUE 约束生效（重复 INSERT 被拒绝）
- [ ] 预约接口返回的 workOrderId 能正确解析（修复 booking_id 全 NULL 的 bug）
- [ ] runtime 短路：request_handoff 返回 `shortCircuited: true` 时 runtime 停；`false` 时 Agent 继续
- [ ] OpsEventsRecorder 重复调用同 idempotency_key 不会让 daily_ops_report 重复 +1

### P1 验证
- [ ] 预约成功 → agent_long_term_memories.latest_booking 写入 + latest_work_order_id 非空
- [ ] 预约成功 → ops_events 有 booking.succeeded 记录 → daily_ops_report 投影 +1
- [ ] modify_appointment 无 latest_booking → HANDOFF_NO_BOOKING 错误，Agent 继续对话
- [ ] 候选人首条消息（含加好友握手语）→ ops_events 有 friend.added 记录 + 首次开户长期记忆
- [ ] 加好友握手语（"我是xx"/"请求添加你为朋友"等）不记 candidate.message_received、不计破冰；带求职意图的"我是找工作的"计破冰
- [ ] 本会话首条对外回复 → ops_events 有 agent.opening_sent；后续回复 → agent.replied
- [ ] request_handoff 触发 → handoff_events + ops_events 都有记录（共享 idempotency_key）
- [ ] 每 15 分钟 cron 轮询海绵 → ops_events.interview.passed / candidate.hired 写入成功，且 interview.passed 投影更新 daily_ops_report.interview_pass_count
- [ ] 21:00 cron 同步当天数据到飞书 bitable（每 bot 一行 + 5 列指标）

### P2 验证
- [ ] Web 转化分析页 cohort 漏斗能跨越 180 天（从 ops_events 取数，不受 mpr 30 天（1 个月）清理影响）
- [ ] Web 转化分析页：5 KPI + cohort 漏斗 + 账号对比表 + Handoff 饼图渲染正确
- [ ] 仪表盘小组筛选生效
- [ ] huajune 上报：4 事件按 zhipin 互斥规则、agentId 正确、idempotency_key 复用 ops_events

---

## 十四、风险与缓解

| 风险 | 缓解 |
|------|------|
| 海绵 API 挂了 Agent 上下文无法渲染 | Redis 5min 缓存兜底；若仍失败按"海绵不会挂"假设处理 |
| latest_booking 永不清空，候选人入职后还有指针 | Agent 上下文渲染时通过 currentStatus 区分对待（已上岗就不显示"待面试"提示）|
| recruitment_cases 历史数据不迁移 | ~~标记 @deprecated 但保留表，查历史走老表~~ 最终已整表删除（2026-06-10，迁移 `20260610170000`），历史查询走海绵工单 / `ops_events` |
| handoff_events 没有"已解决"状态 | 如后续需要追踪闭环，反查 user_pauses 表"暂停超 N 天未恢复"的用户 |
| 海绵 15min cron 调用量大 | 仅扫近 30 天 `ops_events.booking.succeeded` 工单，按 workOrderId 精确查；可加 PG WHERE 过滤终态工单（已 hired/已离职跳过）|
| 飞书 bitable 新增"邀请进群数"列依赖运营操作 | 运营在飞书表上加好后再上线 sync 逻辑 |

---

## 十五、前端页面设计 — 转化分析页

### 15.1 页面定位

| 页面 | 用途 |
|------|------|
| 飞书运营日报 | 每天每号的成绩单（当天快照）|
| 现有仪表盘 | 系统健康度（real-time）|
| **转化分析页**（新增）| **业务转化复盘**（漏斗 + 账号对比 + Handoff 原因）|

三个页面分工不重叠：**飞书 = 流水**，**仪表盘 = 体检**，**转化分析 = 复盘**。

### 15.2 页面骨架

挂在仪表盘菜单下方，新菜单项"转化分析"，路由 `/conversion-analysis`。

```
顶部 ControlPanel
  时间范围: [今天] [近7天] [近30天] [近60天] [近180天]
            （档位可扩展；ops_events / daily_ops_report 长期保留，不受 mpr 30 天（1 个月）清理限制，可支撑 180 天甚至更长窗口）
  小组筛选: [全部 ▼]（多选下拉）
  来源渠道: [全部 ▼]（多选下拉；source_channel，⚠ 渠道数据接入后启用）
  自动刷新: 开关（默认开，参考仪表盘 15s/60s）

────────────────────────────────────────────────────

Block 1: 5 个核心转化率 KPI（一排）

Block 2: Cohort 漏斗（recharts FunnelChart）

Block 3: 账号维度对比表

Block 4: Handoff 原因分布饼图
```

### 15.3 Block 1 — 5 个转化率 KPI

```
┌─────────┬──────────┬────────┬──────────┬──────────┐
│ 破冰率  │报名转化率│ 加群率 │面试通过率│整体转化率│
│  70.8%  │   29.4%  │ 80.0%  │  60.0%   │   7.0%   │
│ +3pp ↑  │  +2pp ↑  │ +1pp ↑ │  -1pp ↓  │ +0.5pp ↑ │
│ (85/120)│ (25/85)  │(20/25) │ (15/25)  │(35/500)  │
└─────────┴──────────┴────────┴──────────┴──────────┘
```

公式：

公式（⚠️ 以实现为准，分母与早期设计不同 — 全部走 friend_added cohort 的按人去重单调子集，详见 `conversion-analytics.service.ts:getKpis`）：

| KPI | 字段 | 公式（去重人数） | 业务含义 |
|-----|------|---------|---------|
| 破冰率 | `breakIceRate` | 破冰 / 新增好友 | 开场白质量 + 僵尸好友比例 |
| 报名转化率 | `bookingRate` | 报名 / 破冰 | Agent 收资料和约面能力 |
| 加群率 | `groupInviteRate` | 破冰后加群 / **破冰**（侧支，分母非报名）| 报名后引导进群能力 |
| 面试通过率 | `passRate` | 面试通过 / 报名 | 预匹配能力（precheck 准确性）|
| 整体转化率 | `overallRate` | **面试通过 / 新增好友**（收口到面试通过，不统计入职）| 端到端漏斗效率 |

> ⚠ KPI 卡 5 张：破冰率 / 报名转化率 / 加群率 / 面试通过率 / 整体转化率。后端 `ConversionKpisResponse`
> **没有 `hireRate` 字段**（见顶部实现要点 #2），第三张是 `groupInviteRate`（加群率，分母=破冰）。
> 入职数已不再采集（顶部实现要点 #1），前端/后端都不读 `candidate.hired`。

每张卡显示：
- 主数字（百分比）
- 同环比（`+3pp ↑` / `-1pp ↓` 形式）
- 子数字（分子/分母原始值）

### 15.4 Block 2 — Cohort 漏斗

```
Cohort 维度：[加好友] [报名]   ← Tab 切换

加好友 cohort（本期 500 人，⚠️ 实际 5 级，无入职；进群为破冰侧支，插在破冰后）：
████████████████ 新增好友  500  (100%)
████████████     破冰      400  (整体 80%)
████████         邀请进群  300  (侧支，分母=破冰)
████             报名      120  (整体 24%)
██               面试通过   60  (整体 12%)
```

- 图表库：`recharts` 的 `FunnelChart`（已在依赖里）
- 维度切换 Tab：加好友 cohort（5 级：新增好友→破冰→邀请进群→报名→面试通过）/ 报名 cohort（**2 级：报名→面试通过**）
- ⚠️ **均无"入职"级**（顶部实现要点 #1/#7）；进群是破冰后的运营侧支，不进线性单调链
- 显示双转化率：整体率（vs cohort 总数）+ 阶段率（vs 上一阶段）

### 15.5 Block 3 — 账号维度对比表

```
┌──────────┬──────────┬─────────┬─────┬─────┬─────┬─────┬─────────┬────┐
│ 账号     │所属小组  │新加好友 │破冰 │报名 │进群 │通过 │整体转化率│状态│
├──────────┼──────────┼─────────┼─────┼─────┼─────┼─────┼─────────┼────┤
│ gaoyaqi  │琪琪组    │     120 │  85 │  25 │  20 │  18 │  15.0%  │ 🟢 │
│ ZhuDS    │小祝组    │     110 │  80 │  20 │  15 │  12 │  10.9%  │ 🟡 │
│ HeMin    │小祝组    │      95 │  60 │  18 │  12 │  10 │  10.5%  │ 🟡 │
│ LiHanT   │南瓜组    │      80 │  55 │  12 │   8 │   6 │   7.5%  │ 🟡 │
│ LiYuH    │宇航组    │      70 │  45 │  10 │   7 │   5 │   7.1%  │ 🔴 │
└──────────┴──────────┴─────────┴─────┴─────┴─────┴─────┴─────────┴────┘
```

- 粒度：每个 bot 一行（manager_name 是 bot 对应的招聘经理）
- 表头可点击排序（任一列升降序）
- 状态指示：按整体率染色（🟢 ≥10% / 🟡 5-10% / 🔴 <5%，阈值可调）
- 小组筛选时只显示选中小组的账号
- 数据源：`daily_ops_report` 直接 SELECT（按 (corp_id, report_date, bot_im_id) 在选定时间范围内 SUM 聚合）

### 15.6 Block 4 — Handoff 原因分布

```
Handoff 触发总数：45 次     │ 原因饼图
                            │
┌ 原因分布列表 ───────────┐ │      ╭─────╮
│ 找不到门店    15 (33%)  │ │     ╱       ╲
│ 到店无人接待  10 (22%)  │ │    │  Pie    │
│ 改期/取消      8 (18%)  │ │     ╲       ╱
│ 预约冲突       5 (11%)  │ │      ╰─────╯
│ 入职办理       4 (9%)   │ │
│ 追问结果       2 (4%)   │ │
│ 已被自招       1 (2%)   │ │
│ 其他           0 (0%)   │ │
└──────────────────────────┘ │
```

- 数据源：`handoff_events` 按 `reason_code` 聚合
- 图表库：chart.js Pie + 右侧 legend 列表
- ⚡ ~~**按阶段（stage）分布** `byStage[]`~~ **未实现**（顶部实现要点 #3）：`stage` 字段已落在 `handoff_events` 表，但 `/analytics/conversion/handoff` 接口当前只返回 `reasons[]`，未做 `GROUP BY stage`。如需阶段分布需补后端聚合。
- ⚡ **reason_code 可扩展**：当前**10 类**（顶部实现要点 #5：在初期 8 类基础上新增 `no_match_or_group_full`、`system_blocked`），后续随产品形态会增删。底层 `reason_code` 是 `text`（无 CHECK/enum 约束），饼图 `GROUP BY reason_code` 动态聚合，新增原因**无需数据库迁移**。增删一个原因只改两处代码：
  - `src/tools/request-handoff.tool.ts`：`reasonCode` 的 `z.enum([...])` + `HANDOFF_REASON_LABELS` 各加/删一行
  - 前端饼图 legend 的 `reasonCode → displayName` 映射各加/删一行
- ⚠️ 未知 reason_code 兜底：`HANDOFF_REASON_LABELS[code] ?? '需人工跟进'`，即便前端漏配映射也不会崩，会以代码原文或兜底文案展示

### 15.7 后端 API 接口

所有接口额外接受可选 `channel=` 过滤（按 source_channel）；funnel/bots 另支持按渠道维度聚合对比。

```typescript
// 1. 5 个转化率 KPI（含同环比）
GET /analytics/conversion/kpis?range=&groups=&channel=
→ {
    breakIceRate: { current, previous, change, numerator, denominator },
    bookingRate: { ... },
    groupInviteRate: { ... },   // ⚠️ 实际字段（加群率），非 hireRate
    passRate: { ... },
    overallRate: { ... }        // = 面试通过 / 新增好友（不含入职）
    // ⚠️ 无 hireRate 字段（顶部实现要点 #2）
  }

// 2. Cohort 漏斗
GET /analytics/conversion/funnel?cohort=friend_added|booking&range=&groups=&channel=
→ {
    cohort: 'friend_added',
    totalCohort: 500,
    stages: [
      { stage: 'friend_added', displayName: '加好友', count: 500, overallRate: 1.0, stageRate: 1.0 },
      { stage: 'break_ice', displayName: '破冰', count: 400, overallRate: 0.80, stageRate: 0.80 },
      ...
    ]
  }

// 3. 账号维度对比表
GET /analytics/conversion/bots?range=&groups=&channel=
→ {
    bots: [
      {
        botImId: '1688855974513959',
        managerName: 'gaoyaqi',
        groupName: '琪琪组',
        eventCounts: {
          friends_added: 120,
          break_ice: 85,
          booking_success: 25,
          group_invite: 20,
          interview_pass: 18
        },
        overallRate: 0.15,
        status: 'good' | 'warning' | 'bad'
      },
      ...
    ]
  }

// 4. Handoff 原因分布
GET /analytics/conversion/handoff?range=&groups=
→ {
    total: 45,
    reasons: [
      { reasonCode: 'cannot_find_store', displayName: '找不到门店', count: 15, percent: 0.33 },
      ...
    ]
    // ⚠️ byStage 未实现（顶部实现要点 #3）：接口只返回 reasons[]，无按 stage 的分布
  }
```

### 15.8 前端目录结构

```
web/src/api/types/conversion-analytics.types.ts    类型定义
web/src/api/services/conversion-analytics.service.ts API 封装

web/src/hooks/analytics/
  ├── useConversionKpis.ts        Block 1 数据
  ├── useConversionFunnel.ts      Block 2 数据
  ├── useConversionBots.ts        Block 3 数据
  └── useHandoffReasons.ts        Block 4 数据

web/src/view/conversion-analysis/list/
  ├── index.tsx                   页面入口
  ├── styles/index.module.scss
  ├── components/
  │   ├── ControlPanel/           顶部筛选器
  │   ├── KpiCards/               Block 1: 5 个转化率卡
  │   ├── CohortFunnel/           Block 2: recharts FunnelChart
  │   ├── BotComparisonTable/     Block 3: 账号对比表
  │   └── HandoffPieChart/        Block 4: Handoff 饼图
  └── types/index.ts

web/src/routes/lazy-pages.ts        新增 /conversion-analysis 路由
web/src/components/Sidebar/         新增"转化分析"菜单项
```

### 15.9 技术栈复用

| 项 | 复用 |
|---|---|
| 路由 | `web/src/routes/lazy-pages.ts` 加 `/conversion-analysis` |
| 图表库 | chart.js（饼图）+ recharts（漏斗）— 都已在依赖里 |
| 组件模式 | 参照 `dashboard/list/components/` 的 ControlPanel/MetricCard 风格 |
| 状态管理 | React Query（参照 `useDashboardOverview`）|
| 自动刷新 | 复用 dashboard 的 15s/60s 间隔模式 |

### 15.10 仪表盘改造（小组筛选）

**只改一处**：现有 dashboard 顶部 ControlPanel 加"小组"筛选下拉。

| 文件 | 改动 |
|------|------|
| `web/src/view/dashboard/list/components/ControlPanel/index.tsx` | 加 group 下拉 |
| `web/src/hooks/analytics/useDashboard.ts` | hook 加 `groups?: string[]` 参数 |
| `src/biz/monitoring/services/dashboard/analytics-dashboard.service.ts` | service 接受 groups 过滤 |
| `src/biz/monitoring/monitoring.controller.ts` | endpoint 加 `groups?` query param |

其他仪表盘指标全部不动。

### 15.11 实施 checklist

```
后端
  □ src/biz/conversion-analytics/conversion-analytics.module.ts
  □ src/biz/conversion-analytics/conversion-analytics.controller.ts
  □ src/biz/conversion-analytics/conversion-analytics.service.ts
  □ src/biz/conversion-analytics/types/                 DTO
  □ src/biz/conversion-analytics/queries/               SQL/查询逻辑
  □ src/biz/monitoring/services/dashboard/              支持 groups? 过滤

前端 — 转化分析页
  □ web/src/api/types/conversion-analytics.types.ts
  □ web/src/api/services/conversion-analytics.service.ts
  □ web/src/hooks/analytics/useConversion{Kpis,Funnel,Bots,...}.ts
  □ web/src/view/conversion-analysis/list/index.tsx
  □ web/src/view/conversion-analysis/list/components/   5 个组件
  □ web/src/routes/lazy-pages.ts                        路由注册
  □ web/src/components/Sidebar/                         菜单注册

前端 — 仪表盘改造
  □ web/src/view/dashboard/list/components/ControlPanel/  加小组下拉
  □ web/src/hooks/analytics/useDashboard.ts               支持 groups 参数
```

---

## 十六、相关文档与代码

- 飞书运营日报 bitable：app_token `TM0hb4fmtaa5jusAnlnc32Nfnpg` / table_id `tblusTgxaBKp9BA7`
- 海绵工单查询 API：`POST ${SPONGE_API_BASE_URL}/ai/api/workorder/signup/list`
- huajune Open API：`POST https://huajune.duliday.com/api/v1/recruitment-events`
- ~~新增客户回调 `POST /wecom/customer/callback`~~（已废弃：生产无此回调，加好友走普通消息管道握手语）
- 加好友握手语识别：`src/channels/wecom/message/utils/friend-add-greeting.util.ts`（`isPureFriendAddGreeting`）
- 已有 long-term memory 架构：`docs/architecture/memory-and-hints-data-flow.md`
- recruitment_cases 相关旧 TODO 已随整表和对应业务模块删除，不再维护。
