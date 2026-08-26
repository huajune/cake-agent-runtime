# 蛋糕运营数据体系 + 海绵工单集成 产品设计

**创建时间**: 2026-05-28
**状态**: 已上线（终态描述，2026-08-21 按代码复核；早期 P0/P1/P2 施工脚手架与逐条差异标注已并入正文）
**权威声明**：本文三、四章是运营事件清单与 idempotency_key 设计的权威（`src/biz/ops-events/types/ops-events.types.ts` 头注反向引用本文）
**运营使用说明**：日报 / Web 转化分析 / 埋点三出口的口径与用法见 [ops-data-spec-for-operations.md](./ops-data-spec-for-operations.md)（运营向）

---

## 一、背景与驱动

本次改造由 5 个问题驱动（2026-05 立项时的背景，保留作历史语境）：

1. **修复 bug**：`request_handoff` 工具的 `modify_appointment` 在候选人首次约面时被误判为"改期"，发出误导性飞书告警
2. **数据基础修复**：`recruitment_cases` 表 158 条记录里 booking_id **全部为 NULL**，本地状态完全脱节于海绵
3. **运营要看数据**：每天每个号的招聘漏斗数据（飞书日报 + Web 转化分析）
4. **新好友盲区**：候选人加企微 bot 好友的瞬间，系统无感知，Agent 也不会主动打招呼
5. **跨系统埋点**：关键招聘事件需要上报到 huajune 分析系统（4 个事件）

---

## 二、核心设计概览

### 1. 废弃 recruitment_cases，预约指针挂候选人档案（active_booking）

```
agent_long_term_memories.active_booking jsonb
（迁移 20260630120000 由 latest_booking 改名；JSONB 键 latest_work_order_id 同步改为 work_order_id）
```

- **极简指针**：只存 `work_order_id` / `linked_at` / `job_id` 事务指针，不复制任何业务事实
- **多工单**：`bookings[]` 保留同一候选人的多笔工单；顶层字段是最近一笔的镜像（兼容老行 JSONB 形态），读侧一律经 `normalizeActiveBookings` 归并
- **有限生命周期**：新预约 UPSERT 追加；候选人自助取消工单成功后由 `clearActiveBooking` 清除对应指针——初版"永不清空、不维护任何状态机"的权衡**已作废**
- 业务字段不冗余：状态/品牌/门店/岗位/面试时间每次实时查海绵

### 2. 海绵工单 API 是 source of truth

- Agent 上下文渲染 → Redis 5min 缓存 + 海绵实时查
- 历史预约 / 通过 / 品牌 / 候选人明细 → 全部以海绵为准
- 本地不维护任何业务字段状态机

### 3. 事件底账 ops_events + daily_ops_report 投影

- **`ops_events` 底账表**：append-only，所有事件原始记录 + idempotency_key 去重
- **`daily_ops_report`**：从 ops_events 投影出来的汇总缓存，服务 Web 转化分析页（KPI / 账号对比）；飞书日报每日定时读一次
- **Cohort 漏斗全部基于 ops_events**：长期保留事件流，不依赖 mpr（mpr 30 天清理，跨期分析会失真）

### 4. runtime 短路语义

- 短路判定收拢在回合出口 **`src/agent/runner/turn-outcome.ts`**：`isShortCircuitedToolCall` 检查工具结果的 `shortCircuited` 标记，`toolCalls.some(isShortCircuitedToolCall)`（约 L265）命中即本轮不产出对外文本
- request_handoff 工具按返回值控制是否短路（正常 handoff `true`；HANDOFF_NO_BOOKING `false`）
- `skip_reply` 保持无条件短路
- 初版设计的 `agent-runner.service.ts` 内 `shortCircuitByResult` helper 已随回合出口重构迁走，勿再按旧位置找

### 5. 加好友信号：新增客户回调为主，消息反推兜底

- **主信号**：`POST /new-customer` RPA 回调（平台侧配置回调地址 `https://cake.duliday.com/new-customer`；`@Public` + `@RawResponse`，同步 ACK + 异步处理）。真实加好友即触发，**含从不开口的僵尸好友**
- **兜底**：消息回调路径按候选人首条消息反推 friend.added；两条路径共用幂等键 `${imContactId}:friend_added`，谁先到算谁
- **破冰排除加好友握手语**：加好友时微信以普通 user 消息推送握手语（`我是{昵称}` / `请求添加你为朋友` / `我通过了你的…验证请求`），由 `isPureFriendAddGreeting`（`src/channels/wecom/message/utils/friend-add-greeting.util.ts`）识别，命中即**不记** `candidate.message_received` → 破冰自然落到下一条真实消息；带求职意图的「我是找工作的 / 我是兼职 / 我是应聘的」仍计入破冰
- 早期"合成 `[新好友添加]` synthetic 消息"方案未实施；曾随之落库的孤儿列 `message_processing_records.is_synthetic` 已连同 `idx_mpr_synthetic` 索引删除（迁移 `20260706043700`）

### 6. handoff 简化 + 单独事件表

- 废弃 recruitment_cases 的 `active/handoff/closed` 状态机
- handoff 状态只靠 `UserHostingService` 的 pause/resume 一层表达
- `handoff_events` 表记录富字段明细（reason 原话 / action_advice / stage / work_order_id）
- **聚合分析数据源已切到 `ops_events(handoff.triggered)` 的 payload**（见六-D Block 4），handoff_events 退为回捞复盘底账

### 7. 自助改约 / 取消（新增能力）

- `duliday_modify_interview_time` 工具：候选人要求改面试时间时 Agent 自助调海绵改约，成功写事件 `booking.interview_modified`
- `duliday_cancel_work_order` 工具：候选人明确取消时 Agent 自助调海绵取消工单，成功写事件 `booking.canceled` + `clearActiveBooking` 清指针 + 飞书私聊通知
- 自助失败再走 `request_handoff(modify_appointment)` 兜底转人工

---

## 三、数据模型

### 3.1 表清单

| 表                                        | 状态                                                                         | 说明                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent_long_term_memories`                | 列 `active_booking jsonb`（原 `latest_booking`，迁移 `20260630120000` 改名） | 候选人当前有效预约工单指针（含 `bookings[]` 多工单）                                                  |
| `ops_events`                              | 在产                                                                         | 事件底账：append-only，所有事件原始记录 + idempotency_key                                             |
| `daily_ops_report`                        | 在产                                                                         | 每日每 bot **14 列**事件计数（从 ops_events 投影；12 列初版 + 取消/改约 2 列，迁移 `20260608120000`） |
| `handoff_events`                          | 在产                                                                         | Handoff 富字段底账（含 stage / action_advice；聚合分析已改读 ops_events）                             |
| `recruitment_cases`                       | **已删除**                                                                   | 2026-06-10 整表删除（迁移 `20260610170000_drop_recruitment_cases.sql`），代码同步移除                 |
| `message_processing_records.is_synthetic` | **已删除**                                                                   | synthetic 方案未实施留下的孤儿列，连同 `idx_mpr_synthetic` 于迁移 `20260706043700` 删除               |

### 3.2 active_booking 字段

```json
{
  "work_order_id": 12346,
  "linked_at": "2026-06-30T10:00:00Z",
  "job_id": 679,
  "bookings": [
    { "work_order_id": 12345, "linked_at": "2026-06-28T09:00:00Z", "job_id": 678 },
    { "work_order_id": 12346, "linked_at": "2026-06-30T10:00:00Z", "job_id": 679 }
  ]
}
```

- 顶层 `work_order_id` / `linked_at` / `job_id` 是**最近一笔的镜像**，仅为兼容老行 JSONB 形态而写；`bookings[]` 才是全量列表。读侧一律经 `normalizeActiveBookings` 归并两者
- 类型定义：`ActiveBookingEntry` / `ActiveBookingState`（`src/memory/long-term/long-term.types.ts`）
- 写入口：预约成功 `LongTermService.setActiveBooking`；自助取消成功 `clearActiveBooking(corpId, userId, expectedWorkOrderId)`
- **硬纪律**：本结构禁止新增业务字段；任何"顺手存一下面试时间/门店"的提案一律拒绝。出现"按工单反查候选人"需求或工单状态回流（webhook）立项时，必须迁入 biz 独立关系指针表（corp_id + user_id + work_order_id 一行一工单，身份口径 wecomUserId），严禁复活旧聚合计数表形态

### 3.3 ops_events 事件底账表

```sql
CREATE TABLE ops_events (
  id bigserial PRIMARY KEY,
  corp_id text NOT NULL,               -- ⚡ 多 corp 隔离
  event_name text NOT NULL,            -- 事件名（见第四章清单）
  occurred_at timestamptz NOT NULL,    -- 事件实际发生时间
  report_date date NOT NULL,           -- ⚡ 由 RPC 内部按 Asia/Shanghai 计算（不由调用方传）
  bot_im_id text,                      -- 归属 bot
  manager_name text,                   -- 冗余：bot 对应招聘经理（便于查询）
  group_name text,                     -- 冗余：bot 所属小组
  source_channel text,                 -- ⚡ 候选人来源渠道（反范式冗余便于按渠道切片）；拿不到落 'unknown'
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
- 写入侧统一走 `OpsEventsRecorderService`，返回三态 `inserted / duplicate / failed`（区分"幂等重复"与"写入失败可重试"，供"首条插入即语义判定"的调用方——如开场白判定——使用）。

**idempotency_key 设计（防重复关键）**：

| 事件                         | idempotency_key                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `friend.added`               | `imContactId + ":friend_added"`（每候选人一次；新增客户回调与消息兜底路径共用，谁先到算谁）                               |
| `agent.opening_sent`         | `chat_id + ":opening"`（每会话仅一次；首次插入成功=开场白）                                                               |
| `candidate.engaged`          | `chat_id + ":engaged"`（每会话仅一次）                                                                                    |
| `candidate.message_received` | 企微 message_id                                                                                                           |
| `agent.replied`              | 我方 message_id 或 `chat_id + ":" + sent_at_ms`                                                                           |
| `job.recommended`            | `chat_id + ":job_recommend:" + turn_id`                                                                                   |
| `precheck.passed`            | `chat_id + ":precheck:" + job_id + ":" + turn_id`                                                                         |
| `booking.succeeded`          | `String(workOrderId)`                                                                                                     |
| `booking.failed`             | `chat_id + ":booking_fail:" + step_id`                                                                                    |
| `group.invited`              | `chat_id + ":group:" + group_name + ":" + turn_id`                                                                        |
| `handoff.triggered`          | `chat_id + ":handoff:" + turn_id`                                                                                         |
| `interview.passed`           | `String(workOrderId) + ":pass"` ⚠️ 不带 interviewPassTime（海绵修正时间不会重复计数）                                     |
| `booking.canceled`           | `String(workOrderId) + ":canceled"`（一张工单仅取消一次，Bull 重试去重）                                                  |
| `booking.interview_modified` | `String(workOrderId) + ":interview_modified:" + newInterviewTime`（同一工单可多次改约，仅同工单同新时间的 Bull 重试去重） |
| `candidate.hired`            | ⚠️ **保留事件名，不采集**（统计收口到面试通过，见第四章）                                                                 |

> **turn_id 说明**：`turn_id` = 触发本轮的企微 `messageId`（聚合时为 `batchId`），即 `agent.replied` 复用的 traceId，由 `ToolBuildContext.turnId` 透传给工具。它**按轮**而非**按候选人终身**去重：daily_ops_report 是「当天事件数」，若用 `user_id` 终身键，同一候选人后续天数再次推荐/预检/进群会被压成 0。turn_id 同批重跑保持不变，故 Bull 重试时仍能去重、不会重复 +1。工具在 turn_id 缺省（test/debug 链路）时回退时间戳。

**payload 字段约定**：

- `booking.succeeded`: `{ candidate_name, phone, brand_name, store_name, job_name, interview_time }`
- `handoff.triggered`: `{ reason_code, reason, action_advice, stage }`（转化分析 Block 4 按 `payload.reason_code` 聚合）
- `interview.passed`: `{ interview_pass_time }`（时间放 payload，不进幂等键）
- `booking.canceled`: `{ work_order_id, cancel_reason_id, cancel_reason, cancel_reason_desc, candidate_name, phone, brand_name, store_name, job_name, interview_time }`
- `booking.interview_modified`: `{ work_order_id, new_interview_time }`
- `friend.added`: `{ source_channel, add_way?, state? }`（来源渠道；add_way/state 为企微原始添加方式，留作回溯）
- 其他事件：可选附加上下文（如 message_id、step_id、job_id 等）

> **source_channel 反范式说明**：source_channel 是候选人画像上的固定属性，friend.added 时确定。下游事件（engaged/booking/...）的 source_channel 由 OpsEventsRecorder 写入时从画像带出（与 manager_name/group_name 同样的反范式做法），这样任何阶段都能直接 `GROUP BY source_channel` 做渠道切片。当前上游渠道透传未接入，统一落 `'unknown'`。

**特点**：

- append-only 事件流，永不删除（不在 data-cleanup 的清理范围）
- idempotency_key UNIQUE 索引保证幂等：重复 INSERT 会被 PG 拒绝
- 所有分析（daily_ops_report 投影、cohort 漏斗、handoff 原因分布、huajune idempotency）都从这里取数
- 长期保留 → 不受 mpr 30 天清理影响

### 3.4 daily_ops_report 投影表（14 列）

daily_ops_report 是**从 ops_events 投影出来的汇总缓存**，主要服务 **Web 转化分析页**（KPI / 账号对比，按时间范围 SUM）；飞书日报只是每日定时从它读一次推送。

⚠️ 同样需要 `corp_id` 字段，唯一键 `(corp_id, report_date, bot_im_id)`。

```sql
CREATE TABLE daily_ops_report (
  id bigserial PRIMARY KEY,
  corp_id text NOT NULL,                 -- ⚡ 多 corp 隔离
  report_date date NOT NULL,
  bot_im_id text NOT NULL,
  manager_name text,
  group_name text,

  -- 14 个事件计数（period snapshot，当天事件数）
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
  interview_pass_count        integer DEFAULT 0,  -- ⑫ interview.passed（海绵 15min poll）
  booking_cancel_count        integer DEFAULT 0,  -- ⑬ booking.canceled（自助取消，迁移 20260608120000）
  interview_modified_count    integer DEFAULT 0,  -- ⑭ booking.interview_modified（自助改约，同上）

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
- 写 ops_events 后同步更新 daily_ops_report 对应字段 +1（事件名 → 投影列的映射在 `ops_event_projection_column` RPC，迁移 `20260608120000` 起含取消/改约两列）
  - 用 `UPSERT (corp_id, report_date, bot_im_id) ON CONFLICT DO UPDATE SET 字段 = 字段 + 1`
  - 出问题可直接从 ops_events 全量重算覆盖（**真·自愈，无副作用**——表里没有飞书同步状态/人工备注会被冲掉）
- candidate_summary / booking_brands 也是从 ops_events.payload 投影
- `candidate.hired` 不采集，无入职列（统计收口到面试通过）
- **不存飞书同步状态**：飞书日报每日定时读一次推一次（见六-F），不回写、不增量

### 3.5 handoff_events 表

```sql
CREATE TABLE handoff_events (
  id bigserial PRIMARY KEY,
  chat_id text NOT NULL,
  corp_id text NOT NULL,
  user_id text,                        -- 候选人维度复盘
  reason_code text NOT NULL,           -- 原因代码（当前 15 类，见 request-handoff.tool.ts）；text 不设约束，可扩展
  reason text,                         -- Agent 给的原话
  action_advice text,                  -- Agent 给的建议动作
  stage text,                          -- 触发时会话阶段（程序性阶段），定位 handoff 卡在哪一步
  bot_im_id text,                      -- 关联到 group
  work_order_id bigint,                -- modify_appointment 等场景关联工单
  idempotency_key text NOT NULL,       -- 去重
  created_at timestamptz DEFAULT now(),
  UNIQUE(corp_id, idempotency_key)     -- 按 corp 隔离去重
);

CREATE INDEX idx_handoff_events_corp_created ON handoff_events (corp_id, created_at);
CREATE INDEX idx_handoff_events_corp_reason ON handoff_events (corp_id, reason_code);
CREATE INDEX idx_handoff_events_corp_stage ON handoff_events (corp_id, stage);
CREATE INDEX idx_handoff_events_user_id ON handoff_events (user_id);
```

**特点**：

- append-only 事件流，永不更新
- 触发 handoff 时 INSERT 一行，同时也 INSERT 一行 ops_events（event_name='handoff.triggered'，payload 带 reason_code/reason/action_advice/stage）
- **分工（2026-08 现状）**：转化分析页的原因分布**读 ops_events(handoff.triggered) 的 payload**（与其余指标同一 report_date 切窗、同一 group 过滤口径，且与 daily_ops_report.handoff_count 同源）；handoff_events 提供 reason 原话、action_advice、stage、work_order_id 等富字段，供触发追踪 → 原因复盘 → 回捞对话

### 3.6 索引补充

```sql
-- 日报按日聚合好友数
CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_created_date
  ON agent_long_term_memories (created_at);

-- 日报按日+manager 聚合
CREATE INDEX IF NOT EXISTS idx_mpr_received_at_manager
  ON message_processing_records (received_at, manager_name);
```

---

## 四、蛋糕产品事件清单（15 名，实际采集 14 个）

事件名全集定义在 `src/biz/ops-events/types/ops-events.types.ts` 的 `OPS_EVENT_NAMES`（15 个名字）；其中 `candidate.hired` 只是保留名、**不采集**，实际采集 **14 个**。

| 事件                         | 触发位置                                                                                                                           | daily_ops_report 字段                                                                | 飞书展示      | 其他用途                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------------- |
| `friend.added`               | **主**：`POST /new-customer` RPA 回调；**兜底**：候选人首条消息（accept-inbound，含加好友握手语）。幂等 `imContactId:friend_added` | `friends_added_count`                                                                | ✅ 添加好友数 | 首次插入时开户长期记忆                                     |
| `agent.opening_sent`         | 本会话首条对外回复（reply-workflow，幂等 chat_id:opening）                                                                         | `agent_opening_sent_count`                                                           | —             | huajune `candidate_contacted`                              |
| `candidate.engaged`          | 候选人首条**真实**消息（破冰，排除加好友纯默认招呼语）                                                                             | `break_ice_count`                                                                    | ✅ **破冰数** |                                                            |
| `candidate.message_received` | 候选人发消息（排除加好友纯默认招呼语）                                                                                             | `candidate_message_count`                                                            | —             | huajune `message_received`                                 |
| `agent.replied`              | Agent 回复发出                                                                                                                     | `agent_reply_count`                                                                  | —             | huajune `message_sent`                                     |
| `job.recommended`            | job_list 工具成功                                                                                                                  | `job_recommend_count`                                                                | —             |                                                            |
| `precheck.passed`            | precheck 工具通过                                                                                                                  | `precheck_pass_count`                                                                | —             |                                                            |
| `booking.succeeded`          | booking 工具成功                                                                                                                   | `booking_success_count`<br>+ `candidate_summary` append<br>+ `booking_brands` append | ✅ 成功报名数 | huajune `interview_booked`；写 active_booking 指针         |
| `booking.failed`             | booking 工具失败                                                                                                                   | `booking_fail_count`                                                                 | —             |                                                            |
| `group.invited`              | invite_to_group 工具成功                                                                                                           | `group_invite_count`                                                                 | ✅ 邀请进群数 |                                                            |
| `handoff.triggered`          | request_handoff 工具（原因 **15 类**）                                                                                             | `handoff_count`                                                                      | —             | `handoff_events` 表写入（富字段）；转化分析 Block 4 数据源 |
| `interview.passed`           | 海绵 15min poll 写 ops_events                                                                                                      | `interview_pass_count`（投影 +1）                                                    | ✅ 通过数     |                                                            |
| `booking.canceled`           | `duliday_cancel_work_order` 工具成功（自助取消）                                                                                   | `booking_cancel_count`                                                               | —             | 同时 `clearActiveBooking` 清指针 + 飞书私聊通知            |
| `booking.interview_modified` | `duliday_modify_interview_time` 工具成功（自助改约）                                                                               | `interview_modified_count`                                                           | —             |                                                            |
| ~~`candidate.hired`~~        | ⚠️ **保留事件名，不采集**：海绵轮询收口到 `interview.passed`，「整体转化率」= 面试通过数 / 新增好友                                | —                                                                                    | —             | —                                                          |

**飞书表头 5 列**：添加好友数 / 破冰数 / 成功报名数 / 邀请进群数 / 通过数

**海绵 currentStatus 9 个枚举值**（生命周期顺序）：约面待确认 → 约面失败 / 约面取消 / 约面成功 → 面试失败 / 面试成功 → 上岗失败 / 上岗成功 → 已离职

---

## 五、6 个数据写入入口

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

①② 加好友 + 开场白
   friend.added（加好友数）——两条路径共用幂等键 `${imContactId}:friend_added`，谁先到算谁：
     主信号：POST /new-customer RPA 回调（src/channels/wecom/customer/）。
       真实加好友即触发（含从不开口的僵尸好友），异步处理，落 friend.added + 开户长期记忆。
     兜底：accept-inbound 按候选人首条消息反推（含握手语）。
       微信以普通 user 消息（source=MOBILE_PUSH）推送三类握手语：
         - 「我是{昵称}」（微信加好友默认招呼语）
         - 「请求添加你为朋友」
         - 「我通过了你的(朋友|联系人)验证请求，现在我们可以开始聊天了」
       握手语正常过滤通过 → 触发 Agent → Agent 回它即开场白。
     首次真正插入时开户长期记忆元数据（message_metadata；不写 name/gender，微信昵称不可信）。
     → 投影 daily_ops_report.friends_added_count +1
     ⚠ source_channel 暂统一落 'unknown'（上游渠道透传待接入）

   agent.opening_sent（开口数）—— reply-workflow：
     → Agent 对本会话**首条**对外回复即开场白，idempotency_key=chat_id+":opening" → 每会话一次。
       （用幂等插入返回值判定"首条"：首次插入成功=开场白，之后插入冲突=普通回复 agent.replied）
     → 投影 daily_ops_report.agent_opening_sent_count +1
     → huajune 上报 candidate_contacted（key=chat_id+":first_contact"；开场白不报 message_sent）

③ 预约成功 (Agent → duliday_interview_booking → 海绵)
   海绵返回: data.workOrder.workOrderId (int64)
   → LongTermService.setActiveBooking 写 active_booking（bookings[] 追加，顶层镜像最近一笔）
   → INSERT ops_events(booking.succeeded, idempotency_key=String(workOrderId),
       payload={ candidate_name, phone, brand_name, store_name, job_name, interview_time })
     → 投影 daily_ops_report.booking_success_count +1
       + candidate_summary append (从 payload 取)
       + booking_brands 去重 append
   → agent_long_term_memories.profile_facts writeFromBooking（已有逻辑）
   → huajune 上报 interview_booked (idempotency 复用 workOrderId)

④ Agent 调 request_handoff（原因 15 类）
   → INSERT handoff_events（含 reason_code, reason, action_advice, stage, idempotency_key）
     ⚡ stage 取自当前程序性阶段（procedural），用于分析 handoff 卡在对话哪一步
   → INSERT ops_events(handoff.triggered, idempotency_key=同上,
       payload={ reason_code, reason, action_advice, stage })
     → 投影 daily_ops_report.handoff_count +1
   → 现有的 pauseUser + 飞书告警（保持不变）
   ⚠ 工具返回 { shortCircuited: true/false }，由 turn-outcome 决定是否短路

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
     ⚠️ 用 occurred_at < T_now 避免把当前消息误算进"之前"
     ⚠️ 用 ops_events 不用 mpr，避免 30 天清理影响
   → Agent 工具执行结果:
     - job_list 成功 → INSERT ops_events(job.recommended)
     - precheck 通过 → INSERT ops_events(precheck.passed)
     - booking 失败 → INSERT ops_events(booking.failed)
     - invite_to_group 成功 → INSERT ops_events(group.invited)

⑥ 自助改约 / 取消（Agent 工具 → 海绵）
   duliday_modify_interview_time 改约成功:
     → INSERT ops_events(booking.interview_modified,
         idempotency_key=workOrderId+":interview_modified:"+newInterviewTime,
         payload={ work_order_id, new_interview_time })
       → 投影 daily_ops_report.interview_modified_count +1
     （active_booking 指针不动，仍指向同一工单）
   duliday_cancel_work_order 取消成功:
     → INSERT ops_events(booking.canceled, idempotency_key=workOrderId+":canceled",
         payload={ work_order_id, cancel_reason_id, cancel_reason, cancel_reason_desc,
                   candidate_name, phone, brand_name, store_name, job_name, interview_time })
       → 投影 daily_ops_report.booking_cancel_count +1
     → LongTermService.clearActiveBooking(corpId, userId, workOrderId) 清指针
     → 飞书私聊通知招聘经理
```

---

## 六、数据读取场景

### A. Agent 上下文 — 每轮注入 [当前预约信息]

```
读 agent_long_term_memories.active_booking（按 corpId+userId 查，normalizeActiveBookings 归并 bookings[]）
  → 有工单 → 逐笔查 Redis 缓存 sponge:workorder:{work_order_id}（TTL 5min）
    ├─ 命中 → 直接用缓存
    ├─ miss → 调海绵 signup/list（定位键 workOrderId，从 workOrders[] 挑出该条）→ 写缓存 → 返回
    └─ 海绵失败 → 不渲染（按"海绵不会挂"的假设）
  → 无值 → 不渲染 [当前预约信息]（如需兜底，可按 profile.phone 查最近工单，见场景③）
```

### B. request_handoff 守卫 — modify_appointment 专用

```
reasonCode='modify_appointment'
  → 读 getActiveBookings 最近一笔（linked_at 倒序首项），回退 ledger.jobs.resolvedWorkOrderId
  → 有指针 → 正常 handoff，work_order_id 关联进 handoff_events
  → 均无 → 返回 HANDOFF_NO_BOOKING（shortCircuited=false，按首次约面继续对话，不短路）

其他 reasonCode → 不受影响，保持原逻辑
```

⚠ 自助改约/取消工具上线后，改期/取消诉求优先走 `duliday_modify_interview_time` / `duliday_cancel_work_order` 自助闭环；`modify_appointment` 只承接自助失败后的兜底转人工。

### C. daily_ops_report — ops_events 投影 + cron poll

**投影路径**：先写 ops_events 底账（带 idempotency_key 去重），成功 INSERT 后再投影更新 daily_ops_report；重复事件被底账层拒绝，投影不会重复 +1。事件名 → 投影列映射见 `ops_event_projection_column` RPC（14 列，全清单见 3.4）。

**海绵 15min cron poll**（`sponge-status-poll.cron.ts`）：

⚠️ **来源**：扫 `ops_events` 的 booking.succeeded（不用 active_booking，避免被新预约/取消影响丢历史）。
⚠️ **写入**：走 ops_events 底账，不直接 SET daily_ops_report，保持统一投影路径。

```
1. 取近 60 天（lookbackDays=60）「已 booking.succeeded、尚未 interview.passed」的工单
   （interview.passed 后即从待轮询集合移除）

2. 逐工单查海绵（getCachedWorkOrderById，按 botImId 解析 token），
   只处理我方底账记录过的 workOrderId，避免把候选人自招/线下工单计入"通过数"

3. 对返回的工单：
   - 若 interviewPassTime 非空（按字段判定，不限当前态，兼容"面试成功"快速跃迁到"上岗成功/已离职"）:
     → INSERT ops_events(interview.passed,
                         occurred_at = interviewPassTime,  ⚠️ 业务时间，不是 poll 当前时间
                         idempotency_key = workOrderId + ":pass",
                         payload = { interview_pass_time: interviewPassTime, ... })
       → RPC 内部按 occurred_at 算 report_date，落到正确日期
       → 投影 daily_ops_report.interview_pass_count +1
   - 入职（candidate.hired）不采集：统计收口到面试通过

   ⚠️ 关键约束：
     - idempotency_key 保证同一工单只触发一次 interview.passed
     - occurred_at 必须用业务发生时间（interviewPassTime），不是 poll 当前时间
       否则昨天通过、今天 poll 发现，会落到今天日报（口径错）
```

### D. Web 转化分析页（菜单 `/conversion-analysis`）

后端 `src/biz/conversion-analytics/`，前端 `web/src/view/conversion-analysis/list/`。

**双口径 `mode=period|cohort`**（`ConversionMetricMode`）：

- **period（同期发生量）**：同一时间窗内各阶段独立按候选人去重后按公式相除——"这段时间各阶段各发生了多少"
- **cohort（成熟同批追踪）**：追踪本期**新增好友这同一批人**的后续转化，逐级分子 ⊆ 上一级分母；带 `maturityDays` 成熟期参数（默认 7 天、上限 30），未满成熟期的近期数据不计入，避免"刚加好友还没来得及转化"压低比率
- 接口默认：kpis / trends / bots 默认 `period`，funnel 默认 `cohort`；**前端页面默认 cohort**，顶部「数据口径」Tab（同期发生量 / 成熟同批追踪）一键切换，所有 Block 同步刷新

```
顶部 ControlPanel: 时间范围（today/week/month/twoMonths/threeMonths/sixMonths）| 小组 ▼ | 数据口径 Tab

Block 1: 5 个转化率 KPI 卡（breakIceRate / bookingRate / groupInviteRate / passRate / overallRate）
  整体转化率 = 面试通过 / 新增好友（收口到面试通过，无 hireRate）
  加群率 = 破冰后加群 / 破冰（运营侧支，分母是破冰不是报名）

Block 1.5: KPI 趋势图（GET /analytics/conversion/trends）
  5 个比率的逐日趋势，口径与 KPI 卡 mode 同源；当日分母为 0 时该点为 null，前端画断点而非 0%

Block 2: Cohort 漏斗
  ─ 加好友 cohort（4 级主链，线性单调）: 新增好友 → 破冰 → 报名 → 面试通过
    + 加群侧支：group.invited 不进主链，作为破冰后的侧支单独度量（分母=破冰人数）
  ─ 报名 cohort（2 级）: 报名 → 面试通过（按 workOrderId 串联，避免 cohort 外新工单误算）
  取数全部基于 ops_events（长期保留，不依赖 mpr）；下游命中须 occurred_at >= cohort_occurred_at

Block 3: 账号对比表（每 bot 一行）
  计数列 7 个：新加好友 / 破冰 / 报名 / 进群 / 通过 / 自助取消(booking_cancel) / 自助改约(interview_modified)
  + 整体转化率 + 状态灯
  ⚡ bot 身份别名合并：system_config `conversion_bot_identity_aliases` 登记「旧 botImId → canonical botImId」，
    换号（wxid 轮换）bot 的计数合并到同一身份行相加展示（mergeAliasedBots，临时止血方案）

Block 4: Handoff 原因分布
  饼图（当前 15 类 reason_code，可扩展）+ 总触发数
  数据源：ops_events(handoff.triggered) 的 payload.reason_code —— 与其余指标同一 report_date 切窗、
  同一 group_name 过滤口径，且与 daily_ops_report.handoff_count 同源；
  取代旧的 handoff_events.created_at 切窗 + bot_im_id 白名单（会漏算空 bot 的转人工）
```

⚠ **来源渠道维度未接入**：source_channel 数据全落 `'unknown'`，各接口**当前没有 `channel=` 过滤参数**；渠道切片是 ops_events 反范式列预留的能力，接入上游透传后再启用。

### E. 仪表盘小组筛选

现有 dashboard 顶部 ControlPanel 有"小组"筛选下拉；后端 `AnalyticsController` 接受 `groups?` 参数过滤所有现有指标。

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

| 任务         | 频率       | 内容                                                                                                                                               |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件驱动写入 | 实时       | 14 个采集事件 → INSERT ops_events + 投影 daily_ops_report                                                                                          |
| 海绵 poll    | 每 15min   | 从 ops_events.booking.succeeded 扫近 **60 天**待通过工单 → 查海绵 → INSERT ops_events(**仅 interview.passed**；入职不采集) → 投影 daily_ops_report |
| 飞书同步     | 每日 21:00 | 当天数据 → 飞书 bitable                                                                                                                            |

---

## 八、huajune 埋点上报（4 个事件）

**配置**:

- `HUAJUNE_API_BASE_URL`（默认 `https://huajune.duliday.com`）
- `HUAJUNE_API_TOKEN`

**agentId 命名**: `{manager_name}-cake-{index}`

- 维护 `manager_name + bot_im_id → index` 映射表

**4 个事件触发点（互斥语义参考 zhipin）**:

| 事件                  | 触发位置                                                  | idempotencyKey                |
| --------------------- | --------------------------------------------------------- | ----------------------------- |
| `message_received`    | `AcceptInboundMessageService.execute` 过滤后              | 企微 message_id               |
| `message_sent`        | `MessageSenderService` 发送成功后（**非主动打招呼场景**） | 我方 message_id 或 chat_id+ts |
| `candidate_contacted` | 新好友 → 首次开场白发送成功                               | chat_id + ":first_contact"    |
| `interview_booked`    | `duliday_interview_booking` tool 成功后                   | String(workOrderId)           |

**互斥规则**：主动打招呼场景只报 `candidate_contacted`（不报 `message_sent`），避免 huajune 那边重复计数。

**实现要点**: 全部 fire-and-forget，失败打 warn 日志，不阻塞主流程。（reporter 里预留了 `candidate_hired` 方法，无调用方——与运营统计"不采集入职"口径一致。）

---

## 九、handoff 流程

handoff 涉及两件**互不相干**的事，分开处理——别混在一起看：

| 关注点                                    | 由谁表达                                                                                    | 用途                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **运行时状态**：这人现在归谁管            | `UserHostingService` 的 pause/resume 一层（pause=人工跟进中，active=AI 跟进；3 天自动解禁） | 决定 AI 要不要继续自动回复                             |
| **触发分析**（本节重点）：何时/为何转人工 | `ops_events.handoff.triggered`（聚合分析数据源）+ `handoff_events`（富字段底账）            | 聚合原因、定位卡点、回捞对话 → 反推优化 Agent 托管流程 |

不再维护 recruitment_cases 的 `active/handoff/closed` 状态机：运行时状态用 pause 一层就够，分析价值全部沉到事件底账。

### 触发流程

```
Agent 调 request_handoff（reasonCode 15 类之一）
  ↓
InterventionService.dispatch()
  ├─ ① UserHostingService.pauseUser()    运行时状态：暂停 AI 托管
  ├─ ② handoff_events INSERT 一行         富字段底账（reason_code/reason/action_advice/stage/work_order_id）
  ├─ ③ ops_events(handoff.triggered)     计数底账 + 投影 handoff_count +1
  └─ ④ 发飞书告警

招聘经理恢复托管
  ↓
UserHostingService.resumeUser()           运行时状态：恢复（不做任何 case 状态操作）
```

### 原因代码（15 类，`request-handoff.tool.ts`）

`reason_code` 是 `text` 无 DB 约束，随产品形态增删无需迁移；工具侧 `z.enum` + `HANDOFF_REASON_LABELS` 是唯一登记点。当前 15 类：

| reason_code                 | 含义                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| cannot_find_store           | 找不到门店                                                                             |
| no_reception                | 到店无人接待                                                                           |
| booking_conflict            | 预约信息冲突                                                                           |
| onboarding_paperwork        | 入职办理异常                                                                           |
| interview_result_inquiry    | 候选人追问面试结果                                                                     |
| modify_appointment          | 候选人要求改期/取消已预约面试（自助改约/取消失败后的兜底）                             |
| self_recruited_or_completed | 候选人已被面试通过/餐厅自招/办入职                                                     |
| no_match_or_group_full      | 无匹配岗位/群满需维护                                                                  |
| system_blocked              | 系统异常需人工补录                                                                     |
| booking_capacity_full       | 岗位报名人数已满                                                                       |
| group_invite_failed         | 拉群失败需人工维护                                                                     |
| salary_admin_inquiry        | 薪资/考勤/证明类咨询（岗位数据缺口随 missingJobInfo 上报运营补录）                     |
| interview_slot_coordination | 面试时段需人工协调（**尚未预约成功**的硬时间窗协调，区别于 modify_appointment 的改期） |
| identity_age_exception      | 身份/年龄边界需人工裁量（如 17 岁、学生上社会岗等破例场景）                            |
| other                       | 其他需人工处理场景（能归类就不要用）                                                   |

### 分析问题 → 字段

| 分析问题                   | 用什么                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| 哪类原因最高发             | ops_events(handoff.triggered) 按 payload.reason_code 聚合（Block 4 饼图） |
| handoff 集中在对话哪个阶段 | handoff_events.stage 聚合（分析接口未消费，需直查表）                     |
| 哪个号 / 经理转人工最多    | bot_im_id 聚合                                                            |
| 具体卡在哪、是不是误触发   | handoff_events.reason 原话 + chat_id 回捞整段对话复盘                     |
| 关联的预约工单             | handoff_events.work_order_id（modify_appointment 等）                     |

---

## 十、海绵集成与关键实现

### Sponge 集成

- `SPONGE_API_BASE_URL` 环境变量（默认 `https://gateway.duliday.com/sponge`）
- 工单查询 URL：`${SPONGE_API_BASE_URL}/ai/api/workorder/signup/list`
- 预约接口 Zod schema 完整解析 workOrder 字段（修复 booking_id 全 NULL 的历史 bug）
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

**currentStatus 9 态**：约面待确认 → 约面失败 / 约面取消 / 约面成功 → 面试失败 / 面试成功 → 上岗失败 / 上岗成功 → 已离职。映射：`interview.passed` ← 面试成功（`interviewPassTime` 非空）；入职态不再映射事件（不采集）。

**场景 → 参数矩阵**：

| 场景                              | 定位键                               | queryParam                                              | 用途                                                     |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------- |
| ① Agent 上下文 [当前预约信息]     | `workOrderId`（active_booking 逐笔） | 无                                                      | 渲染该次预约当前状态/品牌/门店/岗位/面试时间             |
| ② 15min cron 状态推进             | 底账工单逐个查                       | 可不传                                                  | 检测 面试成功 → interview.passed                         |
| ③ active_booking 缺失兜底         | `phone`（取自 profile）              | 无（按 signUpTime 取最近一条）                          | 无 workOrderId 时恢复"当前预约信息"                      |
| ④ 报名前查重                      | `phone`                              | `currentStatus=[约面待确认,约面成功,面试成功,上岗成功]` | 判断是否已有进行中工单，避免重复预约                     |
| ⑤ handoff 上下文（自招/追问结果） | `phone`                              | 无                                                      | 给招聘经理候选人工单全貌                                 |
| ⑥ 复聊带外核验                    | `phone`                              | 无                                                      | pre_booking 复聊到点核验带外工单（见 reengagement 文档） |

**各场景要点**：

- **① Agent 上下文**：定位键用 workOrderId（active_booking 已记，精确）；不加 queryParam（要当前真实状态）；响应里挑目标那条渲染；Redis 缓存 5min（key=`sponge:workorder:{workOrderId}`）。
- **② cron 状态推进**：没有全局查询 → 只能从 `ops_events.booking.succeeded` 近 60 天列表枚举；判定用**字段值而非仅当前态**（`interviewPassTime` 非空 → interview.passed，occurred_at=interviewPassTime），即使两次 poll 间从"面试成功"快速跃迁到"上岗成功/已离职"也不漏；只对我方底账记录过的 workOrderId 发事件。
- **③ 缺失兜底**：仅当 active_booking 为空但 profile 有 phone 时启用，按 signUpTime 取最近一条兜底渲染。
- **④ 报名前查重**：预约前用 phone + 进行中状态集合查，命中则提示/转人工而非重复预约。
- **⑤ handoff 上下文**：`self_recruited_or_completed` / `interview_result_inquiry` 触发时按 phone 拉全部工单，把状态写进 handoff 上下文/告警。

### request_handoff + runtime 短路语义（终态）

- 工具输出统一带 `shortCircuited: boolean` 标记：正常 handoff → `{ dispatched: true, shortCircuited: true }` 停轮；HANDOFF_NO_BOOKING 拒绝 → `{ errorType, shortCircuited: false }` Agent 继续。
- 短路判定的实现**收拢在回合出口 `src/agent/runner/turn-outcome.ts`**（约 L265）：`isShortCircuitedToolCall` 读取工具结果的 `shortCircuited` 标记，`toolCalls.some(isShortCircuitedToolCall)` 命中（或文本为空）→ 本轮归为 `skipped`，不产出对外文本。`skip_reply` 保持无条件短路。
- 初版方案在 `agent-runner.service.ts` 内做 `shortCircuitByResult` StopCondition 的写法已随回合出口重构演进，本节以 turn-outcome 为准。

### active_booking 读写（LongTermService）

- `setActiveBooking(corpId, userId, workOrderId, metadata)` — 预约成功时写入（bookings[] 追加 + 顶层镜像刷新）
- `getActiveBookings(corpId, userId)` — 返回按 linked_at 倒序的工单列表（首项=最近一笔；单数 API 已删除，一律从列表派生）
- `clearActiveBooking(corpId, userId, expectedWorkOrderId)` — 自助取消成功后清除对应指针

---

## 十一、关键设计权衡

1. **active_booking 极简指针 + 有限生命周期**
   - 只存 work_order_id / linked_at / job_id 事务指针，不维护业务状态机；业务字段全部实时查海绵（Redis 缓存 5min）
   - 生命周期只有两笔：预约成功写入、自助取消清除；改约不动指针（同一工单）
   - 初版"永不清空"的权衡随自助取消能力上线**作废**——取消后不清指针会让 Agent 上下文渲染已死工单

2. **不统计入职**
   - 飞书表头没入职列；统计收口到"面试通过"，整体转化率 = 面试通过 / 新增好友
   - 避免"累计快照"语义歧义 + 海绵无上岗时间字段；`candidate.hired` 仅保留事件名

3. **period / cohort 双口径并存**
   - period snapshot 回答"这段时间发生了多少"；cohort（带成熟期）回答"这批人最终转化如何"
   - 飞书日报固定 period；Web 端 KPI/趋势/漏斗/账号对比统一按 Tab 切换，口径互不混淆

4. **daily_ops_report 14 列平铺**
   - 直观、查询简单；加新事件需 ALTER TABLE + 更新投影 RPC，接受这个代价（事件清单相对稳定，取消/改约两列即按此路径扩展）

5. **15min poll 走 ops_events 底账**
   - 来源：扫 ops_events.booking.succeeded 近 60 天待通过工单；写入走统一投影路径
   - 不依赖 active_booking（避免被新预约/取消影响丢历史）

6. **handoff 双底账分工**
   - ops_events 做计数与聚合分析（与全体指标同切窗同过滤），handoff_events 提供富字段供回捞复盘
   - reason_code 无 DB 约束，增删原因只改工具枚举 + 前端映射，无需迁移

7. **huajune 上报互斥**
   - candidate_contacted 和 message_sent 互斥，避免 huajune 重复计数（参考 zhipin 工具的处理方式）

8. **海绵不会挂的假设**
   - active_booking 极简后没有降级数据；Agent 上下文渲染依赖海绵 API 可用性；Redis 缓存 5min 缓解高频访问压力

---

## 十二、风险与缓解

| 风险                                          | 缓解                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 海绵 API 挂了 Agent 上下文无法渲染            | Redis 5min 缓存兜底；若仍失败按"海绵不会挂"假设处理                                               |
| 候选人入职/流程终结后 active_booking 仍有指针 | Agent 上下文渲染时通过 currentStatus 区分对待（已上岗就不显示"待面试"提示）；自助取消已联动清指针 |
| recruitment_cases 历史数据                    | 已整表删除（2026-06-10），历史查询走海绵工单 / `ops_events`                                       |
| handoff_events 没有"已解决"状态               | 如后续需要追踪闭环，反查 user_pauses 表"暂停超 N 天未恢复"的用户                                  |
| 海绵 15min cron 调用量大                      | 仅扫近 60 天底账内"未通过"工单，通过后即移出待轮询集合                                            |
| 换号（wxid 轮换）导致账号对比裂成两行         | `conversion_bot_identity_aliases` 动态配置合并同一身份（临时止血；根治需统一 wecomUserId 口径）   |

---

## 十三、前端页面设计 — 转化分析页

### 13.1 页面定位

| 页面           | 用途                                                            |
| -------------- | --------------------------------------------------------------- |
| 飞书运营日报   | 每天每号的成绩单（当天快照）                                    |
| 现有仪表盘     | 系统健康度（real-time）                                         |
| **转化分析页** | **业务转化复盘**（KPI + 趋势 + 漏斗 + 账号对比 + Handoff 原因） |

三个页面分工不重叠：**飞书 = 流水**，**仪表盘 = 体检**，**转化分析 = 复盘**。

### 13.2 页面骨架

路由 `/conversion-analysis`，挂在仪表盘菜单下方。

```
顶部 ControlPanel
  时间范围: today / week / month / twoMonths / threeMonths / sixMonths
            （ops_events / daily_ops_report 长期保留，不受 mpr 30 天清理限制）
  小组筛选: [全部 ▼]（多选下拉）
  数据口径: MetricModeTabs「同期发生量 | 成熟同批追踪」（默认成熟同批追踪；cohort 成熟期 7 天）
  自动刷新: 开关

Block 1: 5 个核心转化率 KPI（一排）
Block 1.5: KPI 趋势图（KpiTrendChart）
Block 2: Cohort 漏斗（CohortFunnel）
Block 3: 账号维度对比表（BotComparisonTable）
Block 4: Handoff 原因分布饼图（HandoffPieChart）
```

### 13.3 Block 1 — 5 个转化率 KPI

| KPI        | 字段              | 公式（去重人数）                                      | 业务含义                      |
| ---------- | ----------------- | ----------------------------------------------------- | ----------------------------- |
| 破冰率     | `breakIceRate`    | 破冰 / 新增好友                                       | 开场白质量 + 僵尸好友比例     |
| 报名转化率 | `bookingRate`     | 报名 / 破冰                                           | Agent 收资料和约面能力        |
| 加群率     | `groupInviteRate` | 破冰后加群 / **破冰**（侧支，分母非报名）             | 引导进群能力                  |
| 面试通过率 | `passRate`        | 面试通过 / 报名                                       | 预匹配能力（precheck 准确性） |
| 整体转化率 | `overallRate`     | **面试通过 / 新增好友**（收口到面试通过，不统计入职） | 端到端漏斗效率                |

- 后端 `ConversionKpisResponse` 就是这 5 个字段，**没有 `hireRate`**
- 口径随 mode：period 各阶段在时间窗内独立去重；cohort 逐级分子 ⊆ 上一级分母（同一批新增好友）
- 每张卡显示：主数字（百分比）+ 同环比（`+3pp ↑`）+ 分子/分母原始值

### 13.4 Block 1.5 — KPI 趋势图

- 接口 `GET /analytics/conversion/trends?range=&groups=&mode=&maturityDays=`
- 返回 `{ mode, summary, points[] }`：5 个比率的逐日 `ConversionTrendPoint`，口径与 KPI 卡 mode 同源
- 当日分母为 0（无对应 cohort / 无数据）时该率为 `null`，前端渲染断点而非 0%

### 13.5 Block 2 — Cohort 漏斗

```
Cohort 维度：[加好友] [报名]   ← Tab 切换

加好友 cohort（4 级主链 + 加群侧支）：
████████████████ 新增好友  500  (100%)
████████████     破冰      400  (整体 80%)
████             报名      120  (整体 24%)
██               面试通过   60  (整体 12%)
（侧支）邀请进群 300 —— 分母=破冰，不进线性单调链
```

- 加好友 cohort 主链 **4 级**：新增好友 → 破冰 → 报名 → 面试通过（`FRIEND_ADDED_STAGE_DEFS`）；加群是运营动作，作为破冰后的**侧支**单独度量
- 报名 cohort **2 级**：报名 → 面试通过（按 workOrderId 串联：interview.passed 的幂等键是 workOrderId 前缀，可精确 join，避免 cohort 外新工单误算）
- 均无"入职"级；显示双转化率：整体率（vs cohort 总数）+ 阶段率（vs 上一阶段）
- 下游命中必须 `occurred_at >= cohort_occurred_at`；friend_added cohort 的下游匹配按 user_id **或** chat_id 任一命中（部分事件只带其一）

### 13.6 Block 3 — 账号维度对比表

- 粒度：每个 bot 一行（manager_name 是 bot 对应的招聘经理），表头可排序，小组筛选联动
- 计数列（`ConversionBotCounts`）：`friends_added / break_ice / booking_success / group_invite / interview_pass / booking_cancel / interview_modified`——后两列是自助取消/自助改约**侧支计数**，直接按 period 计数 ops_events，不参与漏斗与转化率计算
- 状态灯按整体率染色（🟢 ≥10% / 🟡 5-10% / 🔴 <5%，阈值可调）
- **bot 身份别名合并**：system_config `conversion_bot_identity_aliases` 登记别名映射（aliasBotImId → canonicalBotImId + managerName），`mergeAliasedBots` 把换号前后的计数行合并相加成同一身份行；无登记时原样返回。临时止血方案，根治待 wecomUserId 统一口径

### 13.7 Block 4 — Handoff 原因分布

- 数据源：`ops_events(handoff.triggered)` 按 `payload.reason_code` 聚合（缺失回退 `other`）——与其余指标同一 report_date 切窗、同一小组过滤，且与 daily_ops_report.handoff_count 同源；不再读 handoff_events 切窗
- 当前 **15 类** reason_code（清单见第九章）；`reason_code` 是 text 无约束，饼图动态聚合，增删原因无需迁移，只改 `request-handoff.tool.ts` 的 z.enum + 前后端 `HANDOFF_REASON_LABELS` 映射
- 未知 reason_code 兜底展示，不会崩
- 按 stage 的分布未做接口聚合（stage 已落 handoff_events 表，需要时直查）

### 13.8 后端 API 接口

```typescript
// 通用 query：range / groups / corpId / mode=period|cohort / maturityDays（cohort 专用，默认 7，上限 30）
GET /analytics/conversion/kpis     // 5 率 KPI（默认 period）→ ConversionKpisResponse
GET /analytics/conversion/trends   // 逐日趋势（默认 period）→ { mode, summary, points[] }
GET /analytics/conversion/funnel?cohort=friend_added|booking  // 漏斗（默认 cohort）→ { mode, cohort, totalCohort, stages[] }
GET /analytics/conversion/bots     // 账号对比（默认 period；含 booking_cancel/interview_modified 列 + 别名合并）
GET /analytics/conversion/handoff  // 原因分布（无 mode）→ { total, reasons[] }；无 byStage
```

### 13.9 前端结构

```
web/src/view/conversion-analysis/list/
  ├── index.tsx                    页面入口（metricMode state，默认 'cohort'）
  └── components/
      ├── ControlPanel/            顶部筛选器
      ├── MetricModeTabs/          数据口径 Tab（同期发生量 / 成熟同批追踪）
      ├── KpiCards/                Block 1
      ├── KpiTrendChart/           Block 1.5 趋势图
      ├── CohortFunnel/            Block 2
      ├── BotComparisonTable/      Block 3
      └── HandoffPieChart/         Block 4
web/src/hooks/analytics/useConversion{Kpis,Trends,Funnel,Bots}.ts + useHandoffReasons.ts
```

---

## 十四、相关文档与代码

- 飞书运营日报 bitable：app_token `TM0hb4fmtaa5jusAnlnc32Nfnpg` / table_id `tblusTgxaBKp9BA7`
- 海绵工单查询 API：`POST ${SPONGE_API_BASE_URL}/ai/api/workorder/signup/list`
- huajune Open API：`POST https://huajune.duliday.com/api/v1/recruitment-events`
- 新增客户回调（friend.added 主信号）：`POST /new-customer`（`src/channels/wecom/customer/`，RPA 回调，@Public + @RawResponse）
- 加好友握手语识别（消息兜底路径）：`src/channels/wecom/message/utils/friend-add-greeting.util.ts`（`isPureFriendAddGreeting`）
- 自助改约/取消工具：`src/tools/duliday-modify-interview-time.tool.ts` / `src/tools/duliday-cancel-work-order.tool.ts`
- active_booking 类型与纪律：`src/memory/long-term/long-term.types.ts`（ActiveBookingEntry / ActiveBookingState 头注）
- 事件写入侧类型（引用本文为权威）：`src/biz/ops-events/types/ops-events.types.ts`
- 转化分析：`src/biz/conversion-analytics/`（controller / service / types）
- 短路语义：`src/agent/runner/turn-outcome.ts`
- 已有 long-term memory 架构：`docs/architecture/memory-architecture.md`
