# 蛋糕运营数据体系 + 海绵工单集成 产品设计

**创建时间**: 2026-05-28
**状态**: 待评审

---

## 一、背景与驱动

本次改造由 5 个问题驱动：

1. **修复 bug**：`request_handoff` 工具的 `modify_appointment` 在候选人首次约面时被误判为"改期"，发出误导性飞书告警
2. **数据基础修复**：`recruitment_cases` 表 158 条记录里 booking_id **全部为 NULL**，本地状态完全脱节于海绵
3. **运营要看数据**：每天每个号的招聘漏斗数据（飞书日报 + Web 转化分析）
4. **新好友盲区**：候选人加企微 bot 好友的瞬间，系统无感知，Agent 也不会主动打招呼
5. **跨系统埋点**：关键招聘事件需要上报到 huajune 分析系统（4 个事件）

---

## 二、6 大核心决策

### 决策 1：废弃 recruitment_cases，预约信息挂候选人画像上

```
agent_long_term_memories 加一列：latest_booking jsonb
{ "latest_work_order_id": 12345, "linked_at": "2026-05-28T10:00:00Z" }
```

**设计要点**：
- 极简指针：只存 `latest_work_order_id` + `linked_at`
- **永不清空**：新预约 UPSERT 覆盖，不维护任何状态机
- 业务字段不冗余：状态/品牌/门店/岗位/面试时间每次实时查海绵

### 决策 2：海绵工单 API 是 source of truth

- Agent 上下文渲染 → Redis 5min 缓存 + 海绵实时查
- 历史预约 / 通过 / 入职 / 品牌 / 候选人明细 → 全部以海绵为准
- 本地不维护任何业务字段状态机

### 决策 3：事件底账 ops_events + daily_ops_report 投影 ⭐ **核心修订**

**问题**：原方案 daily_ops_report 实时 UPSERT 计数，对重试/重复回调/工具重复调用不安全；cohort 漏斗依赖 `message_processing_records` 但该表 14 天清理一次（已验证），跨期分析必失真。

**新设计**：
- **`ops_events` 底账表**：append-only，所有事件原始记录 + idempotency_key 去重
- **`daily_ops_report` 改为投影**：从 ops_events 算出来的汇总缓存，仅服务飞书日报
- **Cohort 漏斗全部基于 ops_events**：长期保留事件流，不依赖 mpr

### 决策 4：runtime 短路语义改造 ⭐ **核心修订**

**问题**：当前 `runner.service.ts` 用 `hasToolCall('request_handoff')` 作为 stopWhen 条件（已验证），任何调用都无条件短路，HANDOFF_NO_BOOKING 设计在 runtime 层根本不生效。

**新设计**：
- 新增 `shortCircuitByResult` helper：根据 toolResult 的 `shortCircuited: true` 标记决定是否停止
- request_handoff 工具按返回值控制是否短路（正常 handoff `shortCircuited: true`；HANDOFF_NO_BOOKING `shortCircuited: false`）
- `skip_reply` 保持现有无条件短路

### 决策 5：合成消息标 synthetic ⭐ **新增**

**问题**：新好友消息（CONTACT_CARD/WECOM_SYSTEM）放行后会合成 `[新好友添加]` 文本进消息管道。如果不标 synthetic，会被错误计入 `candidate.message_received` 和 `candidate.engaged`，破冰数虚高。

**新设计**：
- 合成消息打 `metadata.synthetic = true` 标记
- candidate.engaged 检测时过滤 synthetic 消息
- mpr 记录 synthetic 标记，便于事后审计

### 决策 6：handoff 简化 + 单独事件表

- 废弃 recruitment_cases 的 `active/handoff/closed` 状态机
- handoff 状态只靠 `UserHostingService` 的 pause/resume 一层表达
- 新建 `handoff_events` 表只记录原因明细，方便聚合分析

---

## 三、数据模型变更

### 3.1 表清单

| 表 | 状态 | 说明 |
|---|---|---|
| `agent_long_term_memories` | **加列** `latest_booking jsonb` | 候选人最近一次预约工单 ID 指针 |
| `ops_events` | **新建** ⭐ | 事件底账：append-only，所有事件原始记录 + idempotency_key |
| `daily_ops_report` | **新建** | 每日每 bot 12 列事件计数（**从 ops_events 投影出来**）|
| `handoff_events` | **新建** | Handoff 事件结构化记录（10 字段）|
| `recruitment_cases` | **废弃** | 不删表、不迁数据、标记 @deprecated |

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

### 3.3 ops_events 事件底账表 ⭐ **新增**

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
| `job.recommended` | `chat_id + ":job_recommend:" + step_id` |
| `precheck.passed` | `chat_id + ":precheck:" + job_id + ":" + step_id` |
| `booking.succeeded` | `String(workOrderId)` |
| `booking.failed` | `chat_id + ":booking_fail:" + step_id` |
| `group.invited` | `chat_id + ":group:" + group_id + ":" + occurred_at_ms` |
| `handoff.triggered` | `chat_id + ":handoff:" + occurred_at_ms` |
| `interview.passed` | `String(workOrderId) + ":pass"` ⚠️ 不带 interviewPassTime（海绵修正时间不会重复计数）|
| `candidate.hired` | `String(workOrderId) + ":hired"` |

**payload 字段约定**：
- `booking.succeeded`: `{ candidate_name, phone, brand_name, store_name, job_name, interview_time }`
- `handoff.triggered`: `{ reason_code, reason, action_advice }`
- `interview.passed`: `{ interview_pass_time }`（时间放 payload，不进幂等键）
- `candidate.hired`: `{ hired_at? }`（如果海绵能提供）
- 其他事件：可选附加上下文（如 message_id、step_id、job_id 等）

**特点**：
- append-only 事件流，永不删除（不在 data-cleanup 的清理范围）
- idempotency_key UNIQUE 索引保证幂等：重复 INSERT 会被 PG 拒绝
- 所有分析（daily_ops_report 投影、cohort 漏斗、huajune idempotency）都从这里取数
- 长期保留 → 不受 mpr 14 天清理影响

### 3.4 daily_ops_report 投影表

**改造**：原方案是事件实时 UPSERT 累加；新方案是**从 ops_events 投影出来的汇总缓存**，仅服务飞书日报和账号对比表 Block。

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
  break_ice_count             integer DEFAULT 0,  -- ③ candidate.engaged ⭐飞书"破冰数"
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

  notes text,                            -- 运营手动备注
  feishu_record_id text,                 -- 飞书同步回写
  synced_at timestamptz,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(corp_id, report_date, bot_im_id)  -- ⚡ 加 corp_id
);
```

**关键变化**：
- daily_ops_report 现在是**投影缓存**，从 ops_events 算出来
- 投影机制：写 ops_events 后同步更新 daily_ops_report 对应字段 +1
  - 用 `UPSERT (corp_id, report_date, bot_im_id) ON CONFLICT DO UPDATE SET 字段 = 字段 + 1`
  - 如果出问题，可以从 ops_events 重新跑出来覆盖（自愈能力）
- candidate_summary / booking_brands 也是从 ops_events.payload 投影
- **入职数（hired）不存这里**，Web 分析页用 `ops_events.candidate.hired` 取数（poll 写入底账）

### 3.5 handoff_events 表（扩展 10 字段）

```sql
CREATE TABLE handoff_events (
  id bigserial PRIMARY KEY,
  chat_id text NOT NULL,
  corp_id text NOT NULL,
  user_id text,                        -- ⚡ 新增：候选人维度复盘
  reason_code text NOT NULL,           -- 8 类原因之一
  reason text,                         -- Agent 给的原话
  action_advice text,                  -- ⚡ 新增：Agent 给的建议动作
  bot_im_id text,                      -- 关联到 group
  work_order_id bigint,                -- ⚡ 新增：modify_appointment 等场景关联工单
  idempotency_key text NOT NULL,       -- ⚡ 新增：去重
  created_at timestamptz DEFAULT now(),
  UNIQUE(corp_id, idempotency_key)     -- ⚡ 按 corp 隔离去重
);

CREATE INDEX idx_handoff_events_corp_created ON handoff_events (corp_id, created_at);
CREATE INDEX idx_handoff_events_corp_reason ON handoff_events (corp_id, reason_code);
CREATE INDEX idx_handoff_events_user_id ON handoff_events (user_id);
```

**特点**：
- append-only 事件流，永不更新
- 触发 handoff 时 INSERT 一行，同时也 INSERT 一行 ops_events（event_name='handoff.triggered'，payload 引用 reason/action_advice）
- handoff_events 是"详情表"，ops_events 是"流水底账"，两者共存：
  - ops_events 用于统一聚合（daily_ops_report 投影）
  - handoff_events 提供 reason 文本、action_advice 等富字段，方便复盘

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

| # | 事件 | 触发位置 | daily_ops_report 字段 | 飞书展示 | 其他用途 |
|---|------|---------|---------------------|---------|---------|
| 1 | `friend.added` | 新增客户回调 | `friends_added_count` | ✅ 添加好友数 | |
| 2 | `agent.opening_sent` | 首次开场白发出 | `agent_opening_sent_count` | — | huajune `candidate_contacted` |
| 3 | `candidate.engaged` | 候选人首次回消息（破冰）| `break_ice_count` | ✅ **破冰数** | |
| 4 | `candidate.message_received` | 候选人后续发消息 | `candidate_message_count` | — | huajune `message_received` |
| 5 | `agent.replied` | Agent 回复发出 | `agent_reply_count` | — | huajune `message_sent` |
| 6 | `job.recommended` | job_list 工具成功 | `job_recommend_count` | — | |
| 7 | `precheck.passed` | precheck 工具通过 | `precheck_pass_count` | — | |
| 8 | `booking.succeeded` | booking 工具成功 | `booking_success_count`<br>+ `candidate_summary` append<br>+ `booking_brands` append | ✅ 成功报名数 | huajune `interview_booked` |
| 9 | `booking.failed` | booking 工具失败 | `booking_fail_count` | — | |
| 10 | `group.invited` | invite_to_group 工具成功 | `group_invite_count` | ✅ 邀请进群数 | |
| 11 | `handoff.triggered` | request_handoff 工具 | `handoff_count` | — | `handoff_events` 表写入（详情）|
| 12 | `interview.passed` | 海绵 15min poll 写 ops_events | `interview_pass_count`（投影 +1）| ✅ 通过数 | |
| 13 | `candidate.hired` | 海绵 15min poll 写 ops_events | —（不投影 daily_ops_report）| — | Web cohort 漏斗 / KPI 读 ops_events |

**飞书表头 5 列**：添加好友数 / 破冰数 / 成功报名数 / 邀请进群数 / 通过数

**海绵 currentStatus 8 个枚举值**（供参考）：约面失败 / 约面取消 / 约面成功 / 面试失败 / 面试成功 / 上岗失败 / 上岗成功 / 已离职

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

① 新增客户回调 (Stride → POST /wecom/customer/callback)
   payload: imContactId, name, gender, botInfo.imBotId ...
   → agent_long_term_memories UPSERT 开户（空 profile + message_metadata.source_bot_im_id）
   → INSERT ops_events(friend.added, idempotency_key=imContactId+createTimestamp)
     → 投影 daily_ops_report.friends_added_count +1
   ⚠ 不写 name/gender 到 Profile（微信昵称不可信）

② 新好友消息 (Stride 消息管道)
   messageType = CONTACT_CARD(3) / WECOM_SYSTEM(10001)
   → SupportedMessageTypeFilterRule 放行（原来过滤）
   → 合成 "[新好友添加]" 作为 user message ⚡ metadata.synthetic=true
   → Agent 生成开场白
   → 开场白发送成功:
     - INSERT ops_events(agent.opening_sent, idempotency_key=chat_id+":opening:"+message_id)
       → 投影 daily_ops_report.agent_opening_sent_count +1
     - huajune 上报 candidate_contacted

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
   → INSERT handoff_events（含 reason_code, reason, action_advice, idempotency_key）
   → INSERT ops_events(handoff.triggered, idempotency_key=同上,
       payload={ reason_code, reason, action_advice })
     → 投影 daily_ops_report.handoff_count +1
   → 现有的 pauseUser + 飞书告警（保持不变）
   ⚠ 工具返回 { shortCircuited: true/false }，由 runtime 决定是否短路

⑤ 每轮对话
   → message_processing_records（已有，不改；synthetic 消息打标记）
   → 候选人非 synthetic 消息:
     - INSERT ops_events(candidate.message_received, idempotency_key=企微 message_id)
       → 投影 daily_ops_report.candidate_message_count +1
     - huajune message_received
   → Agent 回复（非主动打招呼场景）:
     - INSERT ops_events(agent.replied, idempotency_key=我方 message_id)
       → 投影 daily_ops_report.agent_reply_count +1
     - huajune message_sent
   → 候选人首次回复（额外检测，过滤 synthetic）⭐ **顺序需明确**:
     步骤：
       1. 先 INSERT ops_events(candidate.message_received, idempotency_key=企微 message_id)
          取得新事件的 occurred_at（设为 T_now）
       2. 查询 ops_events：
            SELECT 1 FROM ops_events
            WHERE corp_id = ? AND chat_id = ?
              AND event_name = 'candidate.message_received'
              AND occurred_at < T_now    -- ⚡ 严格小于，不包括当前这条
            LIMIT 1
       3. 若步骤 2 返回空（此前无候选人消息）→ 当前是首条破冰：
            INSERT ops_events(candidate.engaged, idempotency_key=chat_id+":engaged")
              → 投影 daily_ops_report.break_ice_count +1
     ⚠️ 用 occurred_at < T_now 避免把当前消息误算进"之前"
     ⚠️ 建议把"检测 + 写入"包成一个 PG RPC 原子完成，避免并发问题
     ⚠️ 用 ops_events 不用 mpr，避免 14 天清理影响
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
    ├─ miss → 调海绵 API → 写缓存 → 返回
    └─ 海绵失败 → 不渲染（按"海绵不会挂"的假设）
  → 无值 → 不渲染 [当前预约信息]
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

**改造**：原方案是直接 UPSERT daily_ops_report 计数；新方案是**先写 ops_events 底账（带 idempotency_key 去重），成功 INSERT 后再投影更新 daily_ops_report**。重复事件被底账层拒绝，投影不会重复 +1。

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

**海绵 15min cron poll** ⭐ **修订**：

⚠️ **来源改为 ops_events**：不再用 `latest_booking`（会被新预约覆盖，旧工单状态变化会漏）。
⚠️ **写入路径走 ops_events 底账**：不直接 SET daily_ops_report，保持统一投影路径。

```
1. SELECT 所有 booking.succeeded 事件的 (corp_id, user_id, workOrderId, phone, bot_im_id)
   FROM ops_events
   WHERE event_name = 'booking.succeeded'
   AND report_date >= today - 30 days        -- 只看近 30 天活跃工单，老的可忽略

2. 对每个 workOrderId（用 workOrderId 而非 phone，更精确）调海绵
   fetchSignupWorkOrders({ workOrderId })

3. 对返回的工单遍历：
   - 若 currentStatus = '面试成功' AND interviewPassTime 非空:
     → INSERT ops_events(interview.passed,
                         occurred_at = interviewPassTime,  ⚠️ 业务时间，不是 poll 当前时间
                         idempotency_key = workOrderId + ":pass",
                         payload = { interview_pass_time: interviewPassTime, ... })
       → RPC 内部按 occurred_at 算 report_date，落到正确日期
       → 投影 daily_ops_report.interview_pass_count +1
   - 若 currentStatus = '上岗成功':
     → INSERT ops_events(candidate.hired,
                         occurred_at = 海绵 updated_at 或 当前时间,
                         idempotency_key = workOrderId + ":hired",
                         payload = {...})
       （hired 不投影 daily_ops_report，仅 Web cohort 漏斗用）

   ⚠️ 关键约束：
     - idempotency_key 保证同一工单只触发一次 interview.passed / candidate.hired
     - occurred_at 必须用业务发生时间（interviewPassTime），不是 poll 当前时间
       否则昨天通过、今天 poll 发现，会落到今天日报（口径错）

⚠️ latest_booking 不做生命周期维护（永不清空）
⚠️ hired_count 不存 daily_ops_report
```

### D. Web 转化分析页（新菜单 `/conversion-analysis`）

```
顶部 ControlPanel: 时间范围 ▼ | 小组 ▼

Block 1: 12 个事件 KPI 卡片 + 趋势曲线
  数据源: daily_ops_report 按时间范围 SUM
  入职数：cohort 漏斗里展示，不在这里

Block 2: Cohort 漏斗（独立查询）
  Cohort 维度切换: 加好友 / 报名

  ─ 加好友 cohort: 本期加好友 N 人里
    → 后续 破冰/报名/进群/通过/入职 命中数

  ─ 报名 cohort: 本期报名 N 人里
    → 后续 进群/通过/入职 命中数

  Cohort 查询实现（全部基于 ops_events，不依赖 mpr）⭐ 修订：
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
      - 入职:   ops_events WHERE event_name='candidate.hired' AND ...

      ⚠️ 报名 cohort 特殊处理：通过/入职阶段建议**按 workOrderId 串**（cohort 取的就是
        booking 事件，每条带 workOrderId）。后续 interview.passed / candidate.hired
        的 idempotency_key 也是 workOrderId 前缀，可以精确 join。
        避免：候选人 A 在 cohort 之外又新预约了别的工单又通过了，被错误算进 cohort。

    Step 3: 聚合 cohort 总数 + 各阶段命中数

  ⚠️ 关键：ops_events 是长期保留，不在 data-cleanup 范围内
  ⚠️ 不再依赖 message_processing_records.agent_steps（14 天清理会失数据）

Block 3: 分组对比表
  | 小组 | 12 个事件计数 | 整体转化率 |

Block 4: Handoff 原因分布
  饼图（8 类 reason_code）+ 总触发数
  数据源: handoff_events
```

### E. 仪表盘小组筛选

现有 dashboard 顶部 ControlPanel 加"小组"筛选下拉。
后端 `AnalyticsController` 接受 `groups?` 参数过滤所有现有指标。

### F. 飞书日报同步（每日 7:00 cron）

```
执行顺序（关键，避免迟到事件丢飞书）:
  Step 1: 强制跑一次海绵 poll（拉取昨天最后一波 interview.passed / candidate.hired）
  Step 2: SELECT daily_ops_report WHERE report_date = T-1
          - 若 synced_at IS NULL → 首次同步（CREATE 飞书 record）
          - 若 synced_at IS NOT NULL AND updated_at > synced_at → 增量更新（UPDATE 飞书 record）

只推 5 列到飞书 bitable:
  friends_added_count → 添加好友数
  break_ice_count → 破冰数
  booking_success_count → 成功报名数
  group_invite_count → 邀请进群数
  interview_pass_count → 通过数

另带 candidate_summary + booking_brands
其他 7 个字段不推飞书（仅服务 Web 分析页）

→ 回写 feishu_record_id + synced_at
```

⚠️ **迟到事件处理**：海绵可能在 T-1 23:59 之后才同步过来 interview.passed。处理方式：
- 7:00 sync 前**先强制 poll 一次**，让 T-1 数据尽可能齐
- daily_ops_report 触发更新时（投影 +1）记录 updated_at
- sync 时判断 `updated_at > synced_at`：True 则增量更新飞书（UPDATE 而不是 CREATE）
- 这样即便 7:30 才有迟到的 interview.passed 也能在下一次 cron（例如 8:00 跑补偿 sync）补到飞书

---

## 七、3 个定时任务

| 任务 | 频率 | 内容 |
|------|------|------|
| 事件驱动写入 | 实时 | 11 个事件 → INSERT ops_events + 投影 daily_ops_report |
| 海绵 poll | 每 15min | 从 ops_events.booking.succeeded 扫近 30 天工单 → 查海绵 → INSERT ops_events(interview.passed / candidate.hired) → 投影 daily_ops_report |
| 飞书同步 | 每日 7:00 | T-1 数据 → 飞书 bitable |

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

## 九、handoff 简化详解

### 现状（简化前）

```
Agent 调 request_handoff
  ↓
InterventionService.dispatch()
  ├─ ① UserHostingService.pauseUser()             第一层：暂停托管
  ├─ ② RecruitmentCaseService.markHandoff(caseId) 第二层：case 状态 active→handoff
  └─ ③ 发飞书告警

招聘经理处理完 → 操作"恢复托管"
  ↓
UserController / HostingConfigFacade
  ├─ ① UserHostingService.resumeUser()             第一层：恢复
  └─ ② RecruitmentCaseService.closeLatestHandoffCase() 第二层：case 状态 handoff→closed
```

### 为什么要简化

1. **recruitment_cases 表都废弃了**，case 状态机自然没了 host
2. **第二层状态机实际数据很烂**：
   - 158 条 active case 里 92 条已过期但 status 没改（僵尸数据）
   - 35 条 handoff 状态里只有 6 条最终 closed（17% 闭环率）
3. **UserHostingService 的 pause/resume 已经够表达"是否在人工跟进"**：
   - 用户被 pause → 在人工跟进中
   - 用户 active → AI 在跟进

### 简化后

```
Agent 调 request_handoff
  ↓
InterventionService.dispatch()
  ├─ ① UserHostingService.pauseUser()    唯一状态变更
  ├─ ② handoff_events INSERT 一行         ⚡ 新增：记录原因明细
  ├─ ③ daily_ops_report.handoff_count +1 ⚡ 计数累加
  └─ ④ 发飞书告警

招聘经理恢复托管
  ↓
UserHostingService.resumeUser()           唯一状态变更
（不再做任何 case 状态操作）
```

**核心变化**：去掉 `markHandoff(caseId)` 和 `closeLatestHandoffCase()` 这两个调用。

### handoff_events 表的价值

虽然不要 case 状态机了，但 handoff 的**原因和明细**有分析价值：

| 分析场景 | 用什么 |
|---------|--------|
| Web 转化分析页"Handoff 原因分布"饼图 | reason_code 聚合 |
| 看哪个 bot 转人工最多 | 按 bot_im_id 聚合 |
| 看哪种 reasonCode 最高发 | reason_code 聚合 |
| 复盘个别 handoff 是否误触发 | 看 reason 原文 |

只要这些原因数据，不需要状态机。

### 简化收益

- **代码复杂度↓**：移除 markHandoff / closeLatestHandoffCase 调用
- **表数量↓**：recruitment_cases 废弃，新增 handoff_events 但只是 append-only 事件流
- **状态机更清晰**：只有 UserHostingService 一层

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

### request_handoff + runtime 短路语义改造 ⭐ **新增**

**问题**：当前 runner.service.ts 用 `hasToolCall('request_handoff')` 作 stopWhen，无条件短路（已验证），HANDOFF_NO_BOOKING 设计不生效。

**修复**：

```typescript
// src/agent/runner.service.ts 新增 helper
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

### 新好友消息放行 + synthetic 标记 ⭐ **修订**

- `SupportedMessageTypeFilterRule` 改为放行 CONTACT_CARD(3) / WECOM_SYSTEM(10001)
- 合成 `[新好友添加]` 作为 user message，让 Agent 走正常回复流程

**synthetic 字段落库**：

```sql
ALTER TABLE message_processing_records
  ADD COLUMN IF NOT EXISTS is_synthetic boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mpr_synthetic
  ON message_processing_records (chat_id, received_at)
  WHERE is_synthetic = false;  -- 过滤 synthetic 的部分索引
```

- 消息管道写 mpr 时，合成消息设 `is_synthetic = true`，正常消息默认 `false`
- 事件检测层过滤 synthetic：
  - `candidate.message_received` 事件不为合成消息触发（消息管道层判断 `is_synthetic = false` 才记 ops_events）
  - `candidate.engaged` 首条检测时跳过 synthetic 消息
- 事后审计：可以按 `is_synthetic = true` 查所有合成消息记录

### latest_booking 读写
- 不新建模块，在现有 `LongTermService` 上加：
  - `setLatestBooking(corpId, userId, workOrderId)` — 预约成功时 UPSERT
  - `getLatestBooking(corpId, userId)` — Agent 上下文 / handoff 守卫读取
- 永不清空，新预约 UPSERT 覆盖

---

## 十一、实施顺序（P0 / P1 / P2 三阶段）

按 Codex review 建议重排：先修数据底座和阻塞 bug，再做日报闭环，最后做深度分析和跨系统埋点。

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
  - 新建 handoff_events 表（10 字段含 idempotency_key UNIQUE）
  - agent_long_term_memories.latest_booking 加列
  - message_processing_records.is_synthetic 加列 + 部分索引
  - RPC 函数：
    - `upsert_ops_event(corp_id, event_name, occurred_at, ...)` — 内部算 report_date + INSERT ops_events + UPSERT daily_ops_report 投影
    - `check_and_record_first_engaged(corp_id, chat_id, message_id, occurred_at)` — 原子检测 + 写入破冰事件

P0-2. SpongeService booking schema 修复
  - 修复 InterviewBookingApiResponseSchema 的 workOrder 子对象（关键 bug）
  - bookInterview() 提取 data.workOrder.workOrderId
  - 让 booking 成功后能拿到真正的 workOrderId

P0-3. runtime 短路语义改造
  - src/agent/runner.service.ts 新增 shortCircuitByResult helper
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
  - fetchSignupWorkOrders() + Zod schema
  - SPONGE_API_BASE_URL 环境变量
  - Redis 缓存层（5min TTL）

P1-2. LongTermService.setLatestBooking / getLatestBooking
  - 写预约成功时的 work_order_id 指针
  - 永不清空，新预约 UPSERT 覆盖

P1-3. 新好友感知（双路径）
  - 回调 endpoint: POST /wecom/customer/callback
  - SupportedMessageTypeFilterRule 放行 + synthetic 标记
  - 各路径触发对应 ops_events 事件

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

P1-8. 飞书日报同步（cron 7:00）
  - 读 daily_ops_report WHERE report_date = T-1
  - 推 5 列到飞书 bitable
  - 回写 feishu_record_id + synced_at

P1-9. 海绵 15min cron poll
  - 从 ops_events.booking.succeeded 扫近 30 天 (corp_id, workOrderId, user_id, bot_im_id) 列表
  - 对每个 workOrderId 查海绵 fetchSignupWorkOrders
  - 若 currentStatus='面试成功' AND interviewPassTime 落今天:
    → INSERT ops_events(interview.passed) + 投影 daily_ops_report.interview_pass_count +1
  - 若 currentStatus='上岗成功':
    → INSERT ops_events(candidate.hired)（不投影 daily_ops_report，Web cohort 用）
```

### P2：深度分析 + 跨系统埋点

```
P2-1. Web 转化分析页 + 仪表盘小组筛选
  - 后端 src/biz/conversion-analytics/ 模块
    - GET /analytics/conversion/kpis           5 个转化率
    - GET /analytics/conversion/funnel          cohort 漏斗（基于 ops_events）
    - GET /analytics/conversion/bots            账号对比表（基于 daily_ops_report）
    - GET /analytics/conversion/handoff         handoff 原因（基于 handoff_events）
  - 前端 web/src/view/conversion-analysis/list/
  - 仪表盘 ControlPanel 加 group 下拉

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

## 十一·补、Codex review 后的关键修订（变更日志）

### 第一轮 review（评分 5.5/10 → 7.5/10）

| 编号 | 问题 | 验证 | 修订 |
|-----|------|-----|------|
| 1 | daily_ops_report 直接 UPSERT 不安全（重试/重复回调会重复计数）| 设计审查 | 引入 `ops_events` 底账表 + idempotency_key；daily_ops_report 改为投影 |
| 2 | Web cohort 依赖 mpr，但 mpr 14 天清理 | 已验证（data-cleanup.service.ts:26 `DATA_CLEANUP_PROCESSING_DAYS=14`；数据库实际只有 14 天内记录）| Cohort 全部基于 ops_events 长期事件流 |
| 3 | request_handoff runtime 无条件短路，HANDOFF_NO_BOOKING 不生效 | 已验证（runner.service.ts:36 `hasToolCall('request_handoff')`）| 新增 `shortCircuitByResult` helper，由工具返回值的 `shortCircuited` 标记控制 |
| 4 | latest_booking 覆盖丢历史，cohort 报名维度数据不全 | 设计审查 | Cohort 报名维度改用 `SELECT user_id FROM ops_events WHERE event_name='booking.succeeded'` |
| 5 | 合成消息 `[新好友添加]` 会让破冰数虚高 | 设计审查 | 合成消息打 `metadata.synthetic=true`；事件检测层过滤 |
| 6 | handoff_events 字段太少难复盘 | 设计审查 | 扩展到 10 字段：补 user_id / action_advice / work_order_id / idempotency_key |
| 7 | 实施顺序未区分 P0/P1/P2 | 设计审查 | 拆为 4+9+3 步三阶段，P0 先解决底座 |

### 第二轮 review（评分 7.5/10 → 可进 P0 实施前评审）

第一轮修订完成后，Codex 又指出 6 个收口问题，全部验证成立并已修订：

| 编号 | 问题 | 验证 | 修订 |
|-----|------|-----|------|
| 8 | ops_events / daily_ops_report 缺 corp_id | 现有所有用户级表都有 corp_id | 加 corp_id 字段；唯一键改为 `(corp_id, event_name, idempotency_key)` 和 `(corp_id, report_date, bot_im_id)` |
| 9 | interview.passed 绕过 ops_events 直接 SET daily_ops_report | 违反"所有指标从底账投影"原则 | poll 改为 INSERT `ops_events(interview.passed)` 再投影 |
| 10 | 海绵 poll 来源 `latest_booking` 会漏旧工单状态变化 | latest_booking 被覆盖后旧工单脱离监控 | poll 来源改为 `SELECT FROM ops_events WHERE event_name='booking.succeeded'` |
| 11 | `candidate.engaged` 检测顺序歧义 | 同一事务先写再查会把自己算进"之前" | 明确用 `occurred_at < current_occurred_at`；包成单 RPC 原子完成 |
| 12 | synthetic 标记没说存哪 | mpr 表确实没 synthetic 字段 | 加 `is_synthetic boolean DEFAULT false` 列 + 部分索引 |
| 13 | shortCircuitByResult 示例代码用 `result.result` | 已验证（runner.service.ts:428 实际用 `.output`）| 示例代码改为 `tr.output`，避免实现时 stopWhen 永远 false 的 bug |
| 14 | report_date 让调用方传容易时区错 | 设计审查 | RPC 内部按 `(occurred_at AT TIME ZONE 'Asia/Shanghai')::date` 计算 |

### 第三轮 review（评分 7.5/10 → 8/10，可进 P0 实施）

第二轮修订后 Codex 又指出 5 处文档残留口径，已全部统一：

| 编号 | 问题 | 修订 |
|-----|------|-----|
| 15 | 流程示例 `ON CONFLICT (event_name, idempotency_key)` 漏了 corp_id | 改为 `ON CONFLICT (corp_id, event_name, idempotency_key)` |
| 16 | daily_ops_report 投影说明 `UPSERT (report_date, bot_im_id)` 漏了 corp_id | 改为 `UPSERT (corp_id, report_date, bot_im_id)` |
| 17 | handoff_events 唯一键 `UNIQUE(idempotency_key)` 漏了 corp_id | 改为 `UNIQUE(corp_id, idempotency_key)` + 加 `(corp_id, created_at)` / `(corp_id, reason_code)` 索引 |
| 18 | 定时任务表 + P1-9 实施顺序还写 "查 latest_booking → set daily_ops_report" 旧口径 | 统一改为"从 ops_events.booking.succeeded 扫工单 → INSERT ops_events(interview.passed/candidate.hired) → 投影" |
| 19 | Web KPI 入职率/整体转化率公式仍写 hired_count(海绵) | 改为 `hired_count(ops_events.candidate.hired 计数)`；前端只读底账不直接调海绵 |
| 20 | 设计权衡章节"15min poll 极简"/"handoff_events 6 字段"/"风险表 latest_booking 遍历"都是旧描述 | 全部更新为新口径（走 ops_events / 10 字段 / 扫底账）|

### 第四轮 review（评分 8/10 → 8.5/10，进入 P0 实施定版）

第三轮修订后 Codex 又指出 4 处零散残留，已全部清理：

| 编号 | 问题 | 修订 |
|-----|------|-----|
| 21 | 事件清单 #12/#13 描述仍写旧口径（"set" / "实时查海绵"）| `interview.passed` 改为"poll 写 ops_events 后投影 +1"；`candidate.hired` 改为"poll 写 ops_events / Web 读底账" |
| 22 | Cohort 查询的"通过/入职"阶段仍写"海绵工单 API" | 改为读 `ops_events.interview.passed` / `ops_events.candidate.hired`（海绵只是 poll 来源）|
| 23 | 聚合粒度描述漏 corp_id（数据流图 + Block 3 数据源说明）| 统一为 `(corp_id, report_date, bot_im_id)` |
| 24 | 验证清单 "cron → daily_ops_report.interview_pass_count 更新" 不够精确 | 改为"cron → ops_events.interview.passed/candidate.hired 写入成功，且 interview.passed 投影更新 daily_ops_report"|

### P0 实施关键提示

按 Codex 建议，P0 实施时需重点关注：

1. **`upsert_ops_event` RPC 是唯一入口**：所有事件写入必须经过这个 RPC，避免绕过底账直接 SET daily_ops_report
2. **RPC 必须有"是否投影"的分支**：
   - `interview.passed` → 写底账 + 投影 `daily_ops_report.interview_pass_count +1`
   - `candidate.hired` → 仅写底账，不投影 daily_ops_report（飞书没这列，Web 读底账）
   - 通过 RPC 入参 `project_to_daily_ops: boolean` 或事件名白名单决定
3. **report_date 由 RPC 内部按 Asia/Shanghai 计算**：调用方不传，避免时区错误
4. **idempotency_key 在 RPC 层做 ON CONFLICT 处理**：调用方不用判断重复

### 第五轮 review（评分 8.5/10 → 8.7/10，通过 P0 实施前评审）

| 编号 | 问题 | 修订 | 验收阶段 |
|-----|------|-----|---------|
| 25 | `interview.passed` 幂等键带 `interviewPassTime` 易重复（海绵修正时间会产生新 key）| 改为 `workOrderId + ":pass"`，时间放 payload | **P1 验收** |
| 26 | poll 写事件时 `occurred_at` 用 poll 当前时间，会让昨日通过落到今日日报 | 明确 `occurred_at = interviewPassTime`（业务时间）| **P1 验收** |
| 27 | 飞书日报已 synced_at 后迟到的事件丢飞书 | sync 前强制跑 poll + 支持增量更新（`updated_at > synced_at` 触发 UPDATE）| **P1 验收** |
| 28 | Cohort 阶段命中漏时间约束，会把 cohort 之前的旧事件算进来 | 加 `occurred_at >= cohort_occurred_at`；报名 cohort 按 workOrderId 串通过/入职 | **P2 cohort 实现说明** |
| 29 | `idx_ops_events_event_date` 未带 corp_id | 改为 `(corp_id, event_name, report_date)` | **P0 立即修** |

### P0 实施总结

至此方案通过 Codex 终审（8.7/10）。可进入 P0 实施。

**P0 立即执行**：
- Supabase 迁移（3 张表 + 1 个加列 + RPC 函数）
- booking schema 修复
- runtime 短路改造
- OpsEventsRecorder 服务

**P1 验收时重点确认**：
- interview.passed 幂等键不带时间
- poll 写事件用业务时间 occurred_at
- 飞书 sync 支持增量更新

**P2 cohort 实现说明**：
- 加 occurred_at >= cohort_occurred_at 约束
- 报名 cohort 按 workOrderId 串后续阶段

## 十二、关键设计权衡

1. **latest_booking 极简（永不清空）**
   - 只存 work_order_id + linked_at，不维护状态机
   - 业务字段全部实时查海绵（Redis 缓存 5min）
   - 简单可靠，无僵尸数据问题

2. **不存 hired_count 在 daily_ops_report**
   - 飞书表头没这列
   - Web cohort 漏斗 / KPI 直接读 `ops_events.candidate.hired` 底账（海绵只作 poll 来源）
   - 避免"累计快照"语义歧义

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
   - 10 字段（含 user_id / action_advice / work_order_id / idempotency_key）
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
- [ ] 新客户回调 → agent_long_term_memories 开户 + ops_events 有 friend.added 记录
- [ ] 新好友消息 → Agent 生成开场白；合成消息打 synthetic 标记不计入破冰
- [ ] request_handoff 触发 → handoff_events + ops_events 都有记录（共享 idempotency_key）
- [ ] 每 15 分钟 cron 轮询海绵 → ops_events.interview.passed / candidate.hired 写入成功，且 interview.passed 投影更新 daily_ops_report.interview_pass_count
- [ ] 7:00 cron 同步 T-1 数据到飞书 bitable（每 bot 一行 + 5 列指标）

### P2 验证
- [ ] Web 转化分析页 cohort 漏斗能跨越 30 天（从 ops_events 取数，不受 mpr 14 天清理影响）
- [ ] Web 转化分析页：5 KPI + cohort 漏斗 + 账号对比表 + Handoff 饼图渲染正确
- [ ] 仪表盘小组筛选生效
- [ ] huajune 上报：4 事件按 zhipin 互斥规则、agentId 正确、idempotency_key 复用 ops_events

---

## 十四、风险与缓解

| 风险 | 缓解 |
|------|------|
| 海绵 API 挂了 Agent 上下文无法渲染 | Redis 5min 缓存兜底；若仍失败按"海绵不会挂"假设处理 |
| latest_booking 永不清空，候选人入职后还有指针 | Agent 上下文渲染时通过 currentStatus 区分对待（已上岗就不显示"待面试"提示）|
| recruitment_cases 历史数据不迁移 | 标记 @deprecated 但保留表，查历史走老表 |
| handoff_events 没有"已解决"状态 | 如后续需要追踪闭环，反查 user_pauses 表"暂停超 N 天未恢复"的用户 |
| 海绵 15min cron 调用量大 | 仅扫近 30 天 `ops_events.booking.succeeded` 工单，按 workOrderId 精确查；可加 PG WHERE 过滤终态工单（已 hired/已离职跳过）|
| 飞书 bitable 新增"邀请进群数"列依赖运营操作 | 运营在飞书表上加好后再上线 sync 逻辑 |

---

## 十五、前端页面设计 — 转化分析页

### 15.1 页面定位

| 页面 | 用途 |
|------|------|
| 飞书运营日报 | 每天每号的成绩单（流水，T-1）|
| 现有仪表盘 | 系统健康度（real-time）|
| **转化分析页**（新增）| **业务转化复盘**（漏斗 + 账号对比 + Handoff 原因）|

三个页面分工不重叠：**飞书 = 流水**，**仪表盘 = 体检**，**转化分析 = 复盘**。

### 15.2 页面骨架

挂在仪表盘菜单下方，新菜单项"转化分析"，路由 `/conversion-analysis`。

```
顶部 ControlPanel
  时间范围: [本日] [近7天] [近30天] [近2月] [近3月]
  小组筛选: [全部 ▼]（多选下拉）
  自动刷新: 开关（默认开，参考仪表盘 15s/60s）

────────────────────────────────────────────────────

Block 1: 5 个核心转化率 KPI（一排）

Block 2: Cohort 漏斗（recharts FunnelChart）

Block 3: 账号维度对比表

Block 4: Handoff 原因分布饼图
```

### 15.3 Block 1 — 5 个转化率 KPI

```
┌─────────┬──────────┬──────────┬────────┬──────────┐
│ 破冰率  │报名转化率│面试通过率│ 入职率 │整体转化率│
│  70.8%  │   29.4%  │  75.0%   │ 58.3%  │   7.0%   │
│ +3pp ↑  │  +2pp ↑  │  -1pp ↓  │ +5pp ↑ │ +0.5pp ↑ │
│ (85/120)│ (25/85)  │ (15/25)  │(35/60) │(35/500)  │
└─────────┴──────────┴──────────┴────────┴──────────┘
```

公式：

| KPI | 公式 | 业务含义 |
|-----|------|---------|
| 破冰率 | break_ice_count / friends_added_count | 开场白质量 + 僵尸好友比例 |
| 报名转化率 | booking_success_count / break_ice_count | Agent 收资料和约面能力 |
| 面试通过率 | interview_pass_count / booking_success_count | 预匹配能力（precheck 准确性）|
| 入职率 | hired_count(ops_events.candidate.hired 计数) / interview_pass_count | 候选人留存能力 |
| 整体转化率 | hired_count(ops_events.candidate.hired 计数) / friends_added_count | 端到端漏斗效率 |

入职数统一从 `ops_events WHERE event_name='candidate.hired'` 取数（poll 写入底账，前端读底账）。海绵 API 仅作为 poll 的数据来源，前端不直接调海绵。

每张卡显示：
- 主数字（百分比）
- 同环比（`+3pp ↑` / `-1pp ↓` 形式）
- 子数字（分子/分母原始值）

### 15.4 Block 2 — Cohort 漏斗

```
Cohort 维度：[加好友] [报名]   ← Tab 切换

加好友 cohort（本期 500 人）：
████████████████ 加好友   500  (100%)
████████████     破冰     400  (整体 80%  │ 阶段 80%)
████             报名     120  (整体 24%  │ 阶段 30%)
███              进群      90  (整体 18%  │ 阶段 75%)
██               通过      60  (整体 12%  │ 阶段 67%)
█                入职      35  (整体 7%   │ 阶段 58%)
```

- 图表库：`recharts` 的 `FunnelChart`（已在依赖里）
- 维度切换 Tab：加好友 cohort（6 阶段）/ 报名 cohort（4 阶段：报名→进群→通过→入职）
- 显示双转化率：整体率（vs cohort 总数）+ 阶段率（vs 上一阶段）

### 15.5 Block 3 — 账号维度对比表

```
┌──────────┬──────────┬─────┬─────┬─────┬─────┬─────┬─────────┬────┐
│ 账号     │所属小组  │好友 │破冰 │报名 │进群 │通过 │整体转化率│状态│
├──────────┼──────────┼─────┼─────┼─────┼─────┼─────┼─────────┼────┤
│ gaoyaqi  │琪琪组    │ 120 │  85 │  25 │  20 │  18 │  15.0%  │ 🟢 │
│ ZhuDS    │小祝组    │ 110 │  80 │  20 │  15 │  12 │  10.9%  │ 🟡 │
│ HeMin    │小祝组    │  95 │  60 │  18 │  12 │  10 │  10.5%  │ 🟡 │
│ LiHanT   │南瓜组    │  80 │  55 │  12 │   8 │   6 │   7.5%  │ 🟡 │
│ LiYuH    │宇航组    │  70 │  45 │  10 │   7 │   5 │   7.1%  │ 🔴 │
└──────────┴──────────┴─────┴─────┴─────┴─────┴─────┴─────────┴────┘
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

### 15.7 后端 API 接口

```typescript
// 1. 5 个转化率 KPI（含同环比）
GET /analytics/conversion/kpis?range=&groups=
→ {
    breakIceRate: { current, previous, change, numerator, denominator },
    bookingRate: { ... },
    passRate: { ... },
    hireRate: { ... },
    overallRate: { ... }
  }

// 2. Cohort 漏斗
GET /analytics/conversion/funnel?cohort=friend_added|booking&range=&groups=
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
GET /analytics/conversion/bots?range=&groups=
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
- 新增客户回调：`POST /wecom/customer/callback`（待新建）
- 已有 long-term memory 架构：`docs/architecture/memory-and-hints-data-flow.md`
- 已废弃的 recruitment_cases TODO：`docs/todo/recruitment-case-followup-window-and-stage-reset.md`
