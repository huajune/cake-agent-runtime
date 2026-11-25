# 数据库表设计与使用说明

> Cake Agent Runtime - Supabase (PostgreSQL) 数据库设计文档

**最后更新**：2026-11-25（新加坡生产库消息与动作存储验收）

**数据库**：Supabase PostgreSQL | **基线迁移**：[supabase/migrations/20260310000000_baseline.sql](../../supabase/migrations/20260310000000_baseline.sql)

**项目环境**：prod `resexopnhpthuoxfwydx` / test `gaovfitvetoojkvtalxy`

---

### v11.21.1 消息与动作存储

迁移依次为 [20261124100000 正文引用](../../supabase/migrations/20261124100000_runtime_body_compaction.sql)、[20261124100100 已采信预约工单](../../supabase/migrations/20261124100100_booking_accepted_work_order.sql) 和 [20261124100200 流水预览](../../supabase/migrations/20261124100200_processing_list_previews.sql)。

TEST 和新加坡生产库均已登记本批三份迁移。生产在既有 `runtime_storage_writes` 中开启 `chat_mixed_text` 和 `action_failed_body`，对应基础开关 `chat_text` 和 `action_body` 已开启。TEST 保留原有开关值。[发布顺序、三份迁移及恢复步骤](../technical/runtime-storage-batch.md#发布与历史清理) · [v11.21.1 发布记录](https://github.com/huajune/cake-agent-runtime/releases/tag/v11.21.1)

动作主表 `agent_action_records` 用 `body_ref_v1` 标记已移交正文的记录。完整读取 `action_record_json` 按企业、动作、采信尝试和采信摘要定位到 `agent_action_evidence.completion`。预约回放用同一采信关系查找较新的工单。确定失败只有在请求已终止、不可重试且正文与回执一致时才能引用。

北京时间 **2026-11-25 13:42:46** 在同一可重复读快照核对两张表。实际变更按批次提交的唯一业务键计算，已计入截止时的已引用数。

| 对象 | 总行数 | 历史实际变更 | 已引用 | 保留原值 | 待核实 | 剩余可清理 | 断链 | 完整读值差异 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `chat_messages` | 614,637 | 576,917 | 582,303 | 32,334 | 0 | 0 | 0 | 0 |
| `agent_action_records` | 45,424 | 182 | 4,912 | 27,831 | 12,681 | 0 | 0 | 0 |

每个实际变更键在截止快照中均可读取，逐批提交前后的完整值一致。12,681 条动作缺少唯一采信标识，保留原记录。保留原值的动作中有 13 条等待人工裁定。守卫审查、执行事件及裁定记录继续按各自的保留规则处理。还原时先关闭对应的基础和新增写入开关并保留完整读取，再按批次实际变更键和在线新格式还原键恢复，每批最多 100 行。本次截止快照另外导出了 330,559 个混合聊天键和 144 个失败动作键，已逐键核对。[按键还原脚本](../../scripts/restore-runtime-storage.sql)

同一快照抽核 12 条流水，步骤和调用快照中的工具顺序均与原记录一致。80 笔预约样本中有 9 笔的工单号只存在于已采信回执。生产及 TEST 结构的隔离回放验证了快照在 89 天和 90 天保留、超过 90 天进入清理的边界。

### v11.20.0 的生产结构

消息流水与模型调用快照默认均保留 90 天。生产已删除 `public.message_processing_records.agent_invocation` 和旧清理函数 `null_agent_invocation(integer, integer)`，详情从快照子表还原。策略版本继续保存在 `public.strategy_config`。原公开逐字段变更表已退役，生产的 124 条历史完整保存在私有归档，迁移前后全字段摘要一致。[v11.20.0 发布说明](https://github.com/huajune/cake-agent-runtime/releases/tag/v11.20.0)

### v11.18.0 的读写约定

六份数据库治理迁移定义了下列读写接口。各字段的启用条件和回退方法见[专项验收](../todo/runtime-data-model-execution-plan.md#8-2026-年-11-月-19-日候选版本验收)。交付版本见 [v11.18.0 发布说明](https://github.com/huajune/cake-agent-runtime/releases/tag/v11.18.0)。

| 数据 | 写入与查询 |
| --- | --- |
| 消息流水与调用快照 | 通过 `save_processing_snapshot` 同事务写入。详情从 `processing_read_steps` 与 `processing_read_invocation` 还原对应代次的工具和响应。列表仅读取摘要。 |
| 渠道聊天 | 读完整载荷使用 `chat_read_payload`。Center 继续按账号和会话返回原有受限投影。 |
| 测试执行 | 写 `test_executions`，完整查询和导出读 `test_execution_results`。该视图执行调用角色权限，服务角色可查。 |
| 转人工 | 调用 `record_handoff` 写事件、处理明细及日报投影。恢复托管通过 `resolve_hosting_handoffs` 按原暂停作用域关闭对应明细。 |
| 动作回执、人工裁定 | 现行 RPC 按原派发尝试保存采信回执。`action_record_json` 返回完整动作，`action_terminal_evidence` 识别同一次尝试的冲突证据。`agent_action_reviews` 对服务角色仅支持直接查询，裁定使用 `review_agent_action`。 |

`system_config` 中 `runtime_storage_writes` 的 `response_tools`、`steps`、`chat_text`、`test_text`、`action_body` 各自控制合格新写。仅 JSON 布尔值 `true` 开启相应格式，初始均关闭。停写后仍可通过完整投影读取已有记录。每次还原显式指定至多 100 个业务键。[按键还原脚本](../../scripts/restore-runtime-storage.sql)

## 目录

- [总览](#总览)
- [表分类与关系](#表分类与关系)
- [核心业务表](#核心业务表)
  - [chat_messages](#1-chat_messages---聊天消息记录)
  - [message_processing_records](#2-message_processing_records---消息处理记录)
    - [message_processing_invocations](#message_processing_invocations---模型调用快照)
  - [interview_booking_records](#3-interview_booking_records---面试预约记录) 🗄️ 已删除
  - [recruitment_cases](#4-recruitment_cases---招聘案件) 🗄️ 已删除
- [记忆/画像表](#记忆画像表)
  - [agent_long_term_memories](#5-agent_long_term_memories---用户长期记忆)
- [用户管理表](#用户管理表)
  - [user_activity](#6-user_activity---用户活跃度)
  - [user_hosting_status](#7-user_hosting_status---用户托管状态)
- [监控统计表](#监控统计表)
  - [monitoring_hourly_stats](#8-monitoring_hourly_stats---小时级统计)
  - [monitoring_daily_stats](#9-monitoring_daily_stats---日级统计)
  - [monitoring_error_logs](#10-monitoring_error_logs---错误日志)
- [配置管理表](#配置管理表)
  - [system_config](#11-system_config---系统配置)
  - [strategy_config](#12-strategy_config---策略配置)
  - [策略逐字段变更归档](#13-策略逐字段变更归档)
- [测试套件表](#测试套件表)
  - [test_batches](#14-test_batches---测试批次)
  - [test_executions](#15-test_executions---测试执行记录)
  - [test_conversation_snapshots](#16-test_conversation_snapshots---对话测试数据源)
- [RPC 函数](#rpc-函数)
- [数据生命周期](#数据生命周期)

---

## 总览

| #     | 表名                                      | 业务域 | 写入方式            | 读取方式     | 数据保留                            |
| ----- | ----------------------------------------- | ------ | ------------------- | ------------ | ----------------------------------- |
| 1     | `chat_messages`                           | 消息   | upsert              | select / RPC | 永久（不可再生资产）                |
| 2     | `message_processing_records`              | 消息   | RPC                 | select / RPC | 90 天                               |
| 2.1   | `message_processing_invocations`          | 消息   | 随流水同事务写入    | 详情查询     | 90 天，删除主流水时级联删除         |
| ~~3~~ | ~~`interview_booking_records`~~ 🗄️ 已删除 | —      | —                   | —            | 迁移 20260625111500 移除            |
| ~~4~~ | ~~`recruitment_cases`~~ 🗄️ 已删除         | —      | —                   | —            | 迁移 20260610170000 移除            |
| 5     | `agent_long_term_memories`                | 记忆   | RPC upsert / select | select       | 永久                                |
| 6     | `user_activity`                           | 用户   | RPC upsert          | select       | 永久                                |
| 7     | `user_hosting_status`                     | 用户   | upsert / update     | select       | 永久                                |
| 8     | `monitoring_hourly_stats`                 | 监控   | upsert              | select       | 90 天                               |
| 9     | `monitoring_daily_stats`                  | 监控   | upsert              | select       | 90 天                               |
| 10    | `monitoring_error_logs`                   | 监控   | insert              | select       | 90 天                               |
| 11    | `system_config`                           | 配置   | upsert              | select       | 永久                                |
| 12    | `strategy_config`                         | 配置   | insert / update     | select       | 永久（多版本）                      |
| 13    | `strategy_archive.strategy_config_changelog` | 配置 | 退役时归档       | 管理员查询   | 长期保留                            |
| 14    | `test_batches`                            | 测试   | insert / update     | select       | 永久                                |
| 15    | `test_executions`                         | 测试   | insert / update     | select       | 永久                                |
| 16    | `test_conversation_snapshots`             | 测试   | insert / update     | select       | 永久                                |

---

## 表分类与关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        核心业务表                                │
│                                                                 │
│  chat_messages ──────> message_processing_records               │
│                            │        (message_id 关联)            │
│                            ├─── message_processing_invocations  │
│                            ├─── 每小时 ──> monitoring_hourly_stats │
│                            └─── 每天  ──> monitoring_daily_stats  │
├─────────────────────────────────────────────────────────────────┤
│                        记忆/画像                                 │
│                                                                 │
│  agent_long_term_memories  (corp_id + user_id + bot_user_id 关系档) │
├─────────────────────────────────────────────────────────────────┤
│                        用户管理表                                │
│                                                                 │
│  user_activity ◄──── user_hosting_status                        │
│    (chat_id)           (user_id 关联)                            │
├─────────────────────────────────────────────────────────────────┤
│                        监控统计表                                │
│                                                                 │
│  monitoring_error_logs  (异常日志)                                │
│  monitoring_hourly_stats / monitoring_daily_stats                │
│     (aggregate_hourly_stats / aggregate_daily_stats 聚合生成)     │
├─────────────────────────────────────────────────────────────────┤
│                        配置管理表                                │
│                                                                 │
│  strategy_config（在线策略版本）                                 │
│  strategy_archive.strategy_config_changelog（独立历史归档）      │
│  system_config (KV 配置：黑名单/功能开关)                         │
├─────────────────────────────────────────────────────────────────┤
│                        测试套件表                                │
│                                                                 │
│  test_batches ──> test_executions                               │
│       │               │                                         │
│       └──> test_conversation_snapshots ◄──┘                       │
│               (batch_id + conversation_snapshot_id 关联)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心业务表

### 1. chat_messages - 聊天消息记录

**用途**：存储用户与 AI 之间的所有聊天消息（私聊为主，含群聊标记）

**代码位置**：

- Repository: [src/biz/message/repositories/chat-message.repository.ts](../../src/biz/message/repositories/chat-message.repository.ts)
- Entity: [src/biz/message/entities/chat-message.entity.ts](../../src/biz/message/entities/chat-message.entity.ts)

| 字段               | 类型        | 默认值            | 说明                                                       |
| ------------------ | ----------- | ----------------- | ---------------------------------------------------------- |
| `id`               | uuid        | gen_random_uuid() | 主键                                                       |
| `chat_id`          | text        | NOT NULL          | 会话ID，通常为 recipientId                                 |
| `message_id`       | text        | NOT NULL, UNIQUE  | 消息唯一ID，用于去重                                       |
| `role`             | text        | NOT NULL          | 消息角色：`user` / `assistant`                             |
| `content`          | text        | NOT NULL          | 消息内容                                                   |
| `timestamp`        | timestamptz | NOT NULL          | 消息发送时间                                               |
| `candidate_name`   | text        | -                 | 候选人微信昵称                                             |
| `manager_name`     | text        | -                 | 招募经理姓名                                               |
| `org_id`           | text        | -                 | 企业ID                                                     |
| `bot_id`           | text        | -                 | Bot ID                                                     |
| `is_room`          | boolean     | false             | 是否群聊                                                   |
| `message_type`     | text        | 'TEXT'            | TEXT/IMAGE/VOICE/FILE/VIDEO/LINK                           |
| `source`           | text        | 'MOBILE_PUSH'     | MOBILE_PUSH/API_SEND/AI_REPLY                              |
| `im_bot_id`        | text        | -                 | 托管账号的系统 wxid                                        |
| `im_contact_id`    | text        | -                 | 联系人系统ID                                               |
| `contact_type`     | text        | 'UNKNOWN'         | UNKNOWN/PERSONAL_WECHAT/OFFICIAL_ACCOUNT/ENTERPRISE_WECHAT |
| `is_self`          | boolean     | false             | 是否托管账号自己发送                                       |
| `payload`          | jsonb       | -                 | 完整载荷或引用同值文本键后保留的其他字段 |
| `payload_text_v1`  | smallint    | -                 | 掩码 1 从 `content` 还原 `text`，2 还原 `pureText`，3 还原两键 |
| `avatar`           | text        | -                 | 用户头像 URL                                               |
| `external_user_id` | text        | -                 | 企微外部用户ID                                             |
| `created_at`       | timestamptz | now()             | 记录创建时间                                               |

**索引**：

- `idx_chat_messages_timestamp` - timestamp DESC
- `idx_chat_messages_chat_id` - (chat_id, timestamp DESC)

**操作说明**：

- **写入**：`saveChatMessage()` / `saveChatMessagesBatch()` — upsert by message_id
- **读取**：`getChatHistory()` / `getSessionList()` — 按 chat_id + 时间范围。完整消息包使用 `chat_read_payload` 组合正文和剩余字段。类型、值或键有差异的字段保留原值。
- **清理**：不清理，永久保留（业务 / 不可再生数据）

---

### 2. message_processing_records - 消息处理记录

**用途**：记录每条消息的处理全生命周期 —— 状态、耗时、AI 调用、工具使用、异常标记、记忆快照等

**代码位置**：

- Repository: [src/biz/message/repositories/message-processing.repository.ts](../../src/biz/message/repositories/message-processing.repository.ts)
- Entity: [src/biz/message/entities/message-processing.entity.ts](../../src/biz/message/entities/message-processing.entity.ts)
- Tracking: [src/biz/monitoring/services/tracking/message-tracking.service.ts](../../src/biz/monitoring/services/tracking/message-tracking.service.ts)

| 字段               | 类型         | 默认值           | 说明                                                                                             |
| ------------------ | ------------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| `id`               | bigint       | sequence         | 主键（自增）                                                                                     |
| `message_id`       | text         | NOT NULL, UNIQUE | 关联 chat_messages                                                                               |
| `chat_id`          | text         | NOT NULL         | 会话ID                                                                                           |
| `user_id`          | text         | -                | 用户ID                                                                                           |
| `user_name`        | text         | -                | 用户昵称（trgm 索引）                                                                            |
| `manager_name`     | text         | -                | 经理姓名                                                                                         |
| `received_at`      | timestamptz  | now()            | 消息接收时间                                                                                     |
| `message_preview`  | text         | -                | 本次流水保存的入站内容，列表与最慢榜最多 50 个字符 |
| `reply_preview`    | text         | -                | 本次流水保存的回复内容，列表与最慢榜最多 120 个字符 |
| `reply_segments`   | integer      | 0                | 回复分段数                                                                                       |
| `status`           | text         | NOT NULL, CHECK  | `processing` / `success` / `failure` / `timeout`                                                 |
| `error`            | text         | -                | 错误信息                                                                                         |
| `scenario`         | text         | -                | 场景分类                                                                                         |
| `alert_type`       | text         | -                | 失败分类：agent/message/delivery/system/merge/unknown                                            |
| `total_duration`   | integer      | -                | 总耗时（ms）                                                                                     |
| `queue_duration`   | integer      | -                | 队列等待耗时（ms）                                                                               |
| `prep_duration`    | integer      | -                | 准备阶段耗时（ms）                                                                               |
| `ai_start_at`      | bigint       | -                | AI 处理开始时间戳                                                                                |
| `ai_end_at`        | bigint       | -                | AI 处理结束时间戳                                                                                |
| `ai_duration`      | integer      | -                | AI 处理耗时（ms）                                                                                |
| `send_duration`    | integer      | -                | 消息发送耗时（ms）                                                                               |
| `tool_calls`       | jsonb        | -                | 工具调用明细 `[{ toolName, args, result, status, durationMs }]`                                  |
| `agent_steps`      | jsonb        | -                | Agent 逐步轨迹 `[{ stepIndex, text, reasoning, toolCalls, usage, durationMs }]`                  |
| `anomaly_flags`    | text[]       | -                | 异常标记：tool_loop/tool_empty_result/tool_narrow_result/tool_chain_overlong/no_tool_called      |
| `memory_snapshot`  | jsonb        | -                | 运行时记忆快照 `{ currentStage, presentedJobIds, recommendedJobIds, sessionFacts, profileKeys }` |
| `token_usage`      | integer      | -                | Token 消耗量                                                                                     |
| `is_fallback`      | boolean      | false            | 是否降级处理                                                                                     |
| `fallback_success` | boolean      | -                | 降级是否成功                                                                                     |
| `invocation_version` | uuid       | -                | 保存新快照时生成的代次，用于校验详情引用的工具调用                                               |
| `batch_id`         | varchar(255) | -                | 聚合批次ID                                                                                       |
| `created_at`       | timestamptz  | now()            | -                                                                                                |
| `updated_at`       | timestamptz  | now()            | trigger 自动维护                                                                                 |

> `is_primary` 字段已于 20260414 迁移中移除，单条消息均视为自身主记录；`tools text[]` 已于 20260417 迁移中被 `tool_calls jsonb` 取代。

**索引**：

- `idx_message_processing_received_at` - received_at DESC
- `idx_message_processing_received_status` - (received_at DESC, status)
- `idx_message_batch_id` - batch_id（部分索引：batch_id IS NOT NULL）
- `idx_message_processing_user_id` - user_id（部分索引：user_id IS NOT NULL）
- `idx_message_processing_chat_id` - chat_id
- `idx_message_processing_records_user_name_trgm` - user_name（GIN + pg_trgm）
- `idx_message_processing_records_anomaly_flags` - anomaly_flags（GIN）

**触发器**：`trigger_update_message_processing_records_updated_at` — UPDATE 时自动维护 updated_at

**Realtime**：已加入 `supabase_realtime` publication（Dashboard 实时推送）

**操作说明**：

- **写入**：`saveMessageProcessingRecord()` — 接收时创建，处理完成后更新
- **读取**：`getSlowestMessages()` 和 `getMessageProcessingRecords()` 用于总部最慢榜及列表。中心列表也读取限长预览。详情保留主表原值和回复段数，并读取对应快照中的工具顺序和分段回复。快照缺失或到期时，主表保留的回复及兜底内容仍可读取。
- **聚合**：RPC `aggregate_hourly_stats()` / `aggregate_daily_stats()`
- `cleanup_message_processing_records()` 按 `received_at` 清理超过 90 天的流水，通过外键级联删除对应快照。

#### message_processing_invocations - 模型调用快照

每条主流水最多关联一条快照，`message_id` 同时是子表主键和指向主流水的外键。`agent_invocation` 保存当次调用的请求、模型回复及随调用记录的工具和 HTTP 信息，`created_at` 决定快照保留期限。详情接口通过 `processing_read_invocation` 读取快照。请求与回复只随详情返回。

`write_version` 与 `response_tools_v1` 用于核对复用的工具调用。主流水修正后，`superseded_invocation` 可保留被替代的旧快照至原到期时间，详情仅返回与当前流水匹配的快照。快照缺失或到期时，仍可读取保留期内的主流水状态与耗时。[快照读写实现](../../supabase/migrations/20261119080000_processing_storage.sql)

每日北京时间 03:00 执行例行清理。`DATA_CLEANUP_PROCESSING_DAYS` 默认 90，快照天数默认继承它，可由 `DATA_CLEANUP_AGENT_INVOCATION_DAYS` 单独覆盖。本次核实生产两者均为 90 天。此前按旧期限删除的快照无法随保留期延长而恢复。[保留期迁移](../../supabase/migrations/20261124024050_align_invocation_retention_with_processing.sql) · [主表旧列退役迁移](../../supabase/migrations/20261124032811_retire_parent_agent_invocation.sql)

---

### 3. interview_booking_records - 面试预约记录

> **🗄️ 已删除**（迁移 `20260625111500_drop_legacy_interview_booking_records.sql`）。预约统计已切到 `ops_events`，
> 见 [ops-data-and-sponge-integration.md](../product/ops-data-and-sponge-integration.md)。以下为历史 schema 记录，代码已移除。

**用途**：记录 AI 预约面试的统计数据，按品牌/门店/日期聚合

**代码位置**：已随表删除（原 `src/biz/message/repositories/booking.repository.ts` / `booking.entity.ts`）

| 字段            | 类型         | 默认值            | 说明                     |
| --------------- | ------------ | ----------------- | ------------------------ |
| `id`            | uuid         | gen_random_uuid() | 主键                     |
| `date`          | date         | NOT NULL          | 预约日期                 |
| `brand_name`    | text         | -                 | 品牌名称                 |
| `store_name`    | text         | -                 | 门店名称                 |
| `booking_count` | integer      | 0                 | 预约次数                 |
| `chat_id`       | varchar(255) | -                 | 会话ID                   |
| `user_id`       | varchar(255) | -                 | 用户 wxid（imContactId） |
| `user_name`     | varchar(255) | -                 | 用户昵称                 |
| `manager_id`    | varchar(255) | -                 | 招募经理 ID              |
| `manager_name`  | varchar(255) | -                 | 招募经理昵称             |
| `created_at`    | timestamptz  | now()             | -                        |
| `updated_at`    | timestamptz  | now()             | -                        |

**唯一约束**：`(date, brand_name, store_name)`

**索引**：`date` / `brand_name` / `user_id` / `manager_id` / `(date, manager_id)`（多为部分索引）

**操作说明**：

- **写入**：`incrementBookingCount()` — 通过 RPC `increment_booking_count` 原子 upsert，`brand_name`/`store_name` 为空时 COALESCE 为 `''`
- **读取**：`getBookingStats()` / `getTodayBookingCount()` — Dashboard 统计

---

### 4. recruitment_cases - 招聘案件

> **🗄️ 已删除**（迁移 `20260610170000_drop_recruitment_cases.sql`）。跟进/预约状态改以海绵工单为 source of truth +
> `ops_events` 事件底账，见 [ops-data-and-sponge-integration.md](../product/ops-data-and-sponge-integration.md)。以下为历史 schema 记录，代码已移除。

**用途**：跟踪约面后的 Case 生命周期（目前仅 `onboard_followup`），驱动后续跟进触达

**代码位置**：已随表删除（原 `src/biz/recruitment-case/` 模块）

| 字段                      | 类型        | 默认值            | 说明                                        |
| ------------------------- | ----------- | ----------------- | ------------------------------------------- |
| `id`                      | uuid        | gen_random_uuid() | 主键                                        |
| `corp_id`                 | text        | NOT NULL          | 企业ID                                      |
| `chat_id`                 | text        | NOT NULL          | 会话ID                                      |
| `user_id`                 | text        | -                 | 候选人ID                                    |
| `case_type`               | text        | NOT NULL, CHECK   | 当前仅 `onboard_followup`                   |
| `status`                  | text        | NOT NULL, CHECK   | `active` / `handoff` / `closed` / `expired` |
| `booking_id`              | text        | -                 | 预约ID                                      |
| `booked_at`               | timestamptz | -                 | 预约时间                                    |
| `interview_time`          | text        | -                 | 面试时间（文本）                            |
| `job_id`                  | bigint      | -                 | 岗位ID                                      |
| `job_name`                | text        | -                 | 岗位名                                      |
| `brand_name`              | text        | -                 | 品牌                                        |
| `store_name`              | text        | -                 | 门店                                        |
| `bot_im_id`               | text        | -                 | 托管账号                                    |
| `followup_window_ends_at` | timestamptz | -                 | 跟进窗口截止                                |
| `last_relevant_at`        | timestamptz | -                 | 最近相关活动                                |
| `metadata`                | jsonb       | -                 | 扩展字段                                    |
| `created_at`              | timestamptz | now()             | -                                           |
| `updated_at`              | timestamptz | now()             | trigger 自动维护                            |

**索引**：

- `idx_recruitment_cases_chat` - (corp_id, chat_id, updated_at DESC)
- `idx_recruitment_cases_user` - (user_id, updated_at DESC)
- `idx_recruitment_cases_open_unique` - (corp_id, chat_id, case_type) WHERE status IN ('active','handoff')

**触发器**：`trigger_recruitment_cases_updated_at`

---

## 记忆/画像表

### 5. agent_long_term_memories - 用户长期记忆

**用途**：按 `(corp_id, user_id, bot_user_id)` 存储候选人与托管账号之间的长期关系档。
`bot_user_id` 必须使用稳定的企微 `wecomUserId`，不可使用会轮换的 `imBotId`。

**代码位置**：

- Store: [src/memory/stores/supabase.store.ts](../../src/memory/stores/supabase.store.ts)
- Service: [src/memory/long-term/long-term.service.ts](../../src/memory/long-term/long-term.service.ts)
- Types: [src/memory/long-term/long-term.types.ts](../../src/memory/long-term/long-term.types.ts)

| 字段                         | 类型        | 默认值                               | 说明                                                          |
| ---------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------- |
| `id`                         | uuid        | gen_random_uuid()                    | 主键                                                          |
| `corp_id`                    | text        | NOT NULL                             | 企业ID                                                        |
| `user_id`                    | text        | NOT NULL                             | 候选人唯一ID                                                  |
| `bot_user_id`                | text        | NULL（仅兼容行）                     | 稳定托管账号维；生产长期召回只读非空关系行                    |
| `semantic_profile`           | jsonb       | `default_long_term_profile_facts()`  | 9 个带置信度与来源的候选人身份字段                            |
| `semantic_job_intent`        | jsonb       | `{}`                                 | 最新一段求职意向快照，按段整组覆盖                            |
| `episodic_session_summaries` | jsonb       | `[]`                                 | 咨询段摘要数组，最多 20 段，超限淘汰最老条目                  |
| `consolidation_watermarks`   | jsonb       | `default_consolidation_watermarks()` | 按 session 记录已处理消息边界，不属于记忆正文                 |
| `message_metadata`           | jsonb       | -                                    | 最近消息元数据                                                |
| `active_booking`             | jsonb       | -                                    | 兼容业务指针；只读写 `bot_user_id IS NULL` 行，不进入长期召回 |
| `created_at`                 | timestamptz | now()                                | -                                                             |
| `updated_at`                 | timestamptz | now()                                | trigger 自动维护                                              |

`semantic_profile` 固定字段：

- `name`
- `phone`
- `gender`
- `age`
- `is_student`
- `education`
- `has_health_certificate`
- `height`
- `weight`

每个字段值结构：

```json
{
  "value": "19986247174",
  "confidence": "high",
  "source": "system",
  "evidence": "报名成功后写入",
  "updatedAt": "2026-05-27T10:00:00.000Z"
}
```

字段没有值时为 `null`。

`confidence` 取值说明：

| 值       | 含义                                                             | 工具消费   |
| -------- | ---------------------------------------------------------------- | ---------- |
| `high`   | 可程序化采用。来自确定性规则、明确结构化输入，或经过强校验的事实 | 默认消费   |
| `medium` | 可给模型参考。通常来自 LLM 结构化提取、会话沉淀或外部补全        | 默认不消费 |

读边界会把旧 `low/unknown` 兼容归一为 `medium`；当前写入只使用 `high/medium`。

`source` 取值说明：

| 值                | 含义                                     |
| ----------------- | ---------------------------------------- |
| `candidate_quote` | 候选人直接明示且保留了原话证据           |
| `model`           | LLM 根据对话做的结构化提取或模型工具入参 |
| `rule`            | 确定性规则、正则、白名单或别名表匹配得到 |
| `system`          | 外部系统或平台接口补充得到               |
| `manual`          | 真人经理带外裁决                         |
| `archive`         | 历史记忆或跨会话档案回放                 |

旧 source 名字只在读边界兼容映射，不再作为当前写入词汇。

**约束与兼容行**：

- 生产关系行唯一约束：`(corp_id, user_id, bot_user_id)`；
- `bot_user_id IS NULL` 的旧行保留且不参与长期召回；
- NULL 行由部分唯一索引约束为每个 `(corp_id, user_id)` 至多一行，用于兼容 `active_booking`。

**触发器**：`trigger_agent_long_term_memories_updated_at`

**RPC**：

- `upsert_long_term_profile_facts`：写 profile patch，并可整组替换最新 job intent；置信度 rank 防止降级覆盖
- `append_long_term_summary_atomic`：原子追加单层摘要数组，最多保留 20 段
- `mark_long_term_settled_boundary`：兼容名称；原子更新摘要与独立 `consolidation_watermarks`

**Redis 缓存 key**：`long-term:{corpId}:{userId}:{botUserId}`，TTL 2 小时。

---

## 用户管理表

### 6. user_activity - 用户活跃度

**用途**：按天记录用户活跃度（消息数 / Token 消耗 / 首末时间）

**代码位置**：

- Repository: [src/biz/user/repositories/user-hosting.repository.ts](../../src/biz/user/repositories/user-hosting.repository.ts)
- Entity: [src/biz/user/entities/user-activity.entity.ts](../../src/biz/user/entities/user-activity.entity.ts)

| 字段              | 类型        | 默认值   | 说明                 |
| ----------------- | ----------- | -------- | -------------------- |
| `id`              | bigint      | sequence | 主键（自增）         |
| `chat_id`         | text        | NOT NULL | 用户唯一标识         |
| `od_id`           | text        | -        | 用户 OD ID           |
| `od_name`         | text        | -        | 用户昵称             |
| `group_id`        | text        | -        | 所属小组 ID          |
| `group_name`      | text        | -        | 所属小组名称         |
| `activity_date`   | date        | NOT NULL | 活跃日期（按天聚合） |
| `message_count`   | integer     | 0        | 当日消息数           |
| `token_usage`     | integer     | 0        | 当日 Token 消耗      |
| `first_active_at` | timestamptz | NOT NULL | 首次活跃时间         |
| `last_active_at`  | timestamptz | NOT NULL | 末次活跃时间         |
| `created_at`      | timestamptz | now()    | -                    |
| `updated_at`      | timestamptz | now()    | -                    |

**唯一约束**：`(chat_id, activity_date)`

**操作说明**：

- **写入**：RPC `upsert_user_activity()` — 消息接收时自动累加
- **读取**：RPC `get_active_users_by_range()` / `get_daily_user_stats_by_range()`
- **清理**：不清理，永久保留（托管趋势数据源）

---

### 7. user_hosting_status - 用户托管状态

**用途**：AI 托管暂停/恢复状态管理

**代码位置**：

- Repository: [src/biz/user/repositories/user-hosting.repository.ts](../../src/biz/user/repositories/user-hosting.repository.ts)
- Entity: [src/biz/user/entities/user-hosting-status.entity.ts](../../src/biz/user/entities/user-hosting-status.entity.ts)

| 字段          | 类型         | 默认值   | 说明         |
| ------------- | ------------ | -------- | ------------ |
| `user_id`     | varchar(100) | NOT NULL | 主键，用户ID |
| `is_paused`   | boolean      | false    | 是否暂停     |
| `paused_at`   | timestamptz  | -        | 暂停时间     |
| `resumed_at`  | timestamptz  | -        | 恢复时间     |
| `pause_count` | integer      | 0        | 累计暂停次数 |
| `created_at`  | timestamptz  | now()    | -            |
| `updated_at`  | timestamptz  | now()    | -            |

**操作说明**：

- **暂停**：`upsertPause()` — is_paused=true，pause_count +1
- **恢复**：`updateResume()` — is_paused=false，记录 resumed_at
- **查询**：`findPausedUserIds()` — 获取所有暂停中用户

---

## 监控统计表

### 8. monitoring_hourly_stats - 小时级统计

**用途**：每小时预聚合的监控指标，Dashboard 查询直接命中

**代码位置**：

- Repository: [src/biz/monitoring/repositories/hourly-stats.repository.ts](../../src/biz/monitoring/repositories/hourly-stats.repository.ts)
- Entity: [src/biz/monitoring/entities/hourly-stats.entity.ts](../../src/biz/monitoring/entities/hourly-stats.entity.ts)

| 字段                                                                                 | 类型               | 说明                            |
| ------------------------------------------------------------------------------------ | ------------------ | ------------------------------- |
| `id`                                                                                 | uuid               | 主键                            |
| `hour`                                                                               | timestamptz UNIQUE | 统计小时（整点）                |
| `message_count` / `success_count` / `failure_count` / `timeout_count`                | integer            | 消息数/成功/失败（非超时）/超时 |
| `success_rate`                                                                       | numeric            | 成功率                          |
| `avg_duration` / `min_duration` / `max_duration`                                     | integer            | 耗时统计                        |
| `p50_duration` / `p95_duration` / `p99_duration`                                     | integer            | 耗时分位                        |
| `avg_queue_duration` / `avg_prep_duration` / `avg_ai_duration` / `avg_send_duration` | integer            | 各阶段耗时                      |
| `active_users` / `active_chats`                                                      | integer            | 活跃维度                        |
| `total_token_usage`                                                                  | bigint             | Token 总消耗                    |
| `fallback_count` / `fallback_success_count`                                          | integer            | 降级计数                        |
| `scenario_stats` / `tool_stats` / `error_type_stats`                                 | jsonb              | 场景/工具/错误类型分布          |
| `created_at` / `updated_at`                                                          | timestamptz        | -                               |

**索引**：`idx_hourly_stats_hour` (hour DESC)

**操作说明**：

- **写入**：`saveHourlyStats()` / `saveHourlyStatsBatch()` — 定时聚合任务
- **读取**：`getRecentHourlyStats()` / `getHourlyStatsByDateRange()` — 趋势图
- **数据来源**：RPC `aggregate_hourly_stats()` 从 message_processing_records 聚合

---

### 9. monitoring_daily_stats - 日级统计

**用途**：日级预聚合指标（2026-04 新增），替代直接 GROUP BY 查询 message_processing_records

**代码位置**：

- Repository: [src/biz/monitoring/repositories/daily-stats.repository.ts](../../src/biz/monitoring/repositories/daily-stats.repository.ts)
- Entity: [src/biz/monitoring/entities/daily-stats.entity.ts](../../src/biz/monitoring/entities/daily-stats.entity.ts)

| 字段                                                                    | 类型              | 说明                          |
| ----------------------------------------------------------------------- | ----------------- | ----------------------------- |
| `id`                                                                    | uuid              | 主键                          |
| `stat_date`                                                             | date UNIQUE       | 统计日期                      |
| `message_count` / `success_count` / `failure_count` / `timeout_count`   | integer           | 消息/成功/失败（非超时）/超时 |
| `success_rate` / `avg_duration`                                         | numeric / integer | 成功率/平均耗时               |
| `total_token_usage`                                                     | bigint            | Token 总消耗                  |
| `unique_users` / `unique_chats`                                         | integer           | 去重用户/会话                 |
| `fallback_count` / `fallback_success_count` / `fallback_affected_users` | integer           | 降级指标                      |
| `avg_queue_duration` / `avg_prep_duration`                              | integer           | 各阶段平均耗时                |
| `error_type_stats`                                                      | jsonb             | 错误类型分布                  |
| `created_at` / `updated_at`                                             | timestamptz       | -                             |

**索引**：`idx_monitoring_daily_stats_stat_date` (stat_date DESC)

**数据来源**：RPC `aggregate_daily_stats()`

---

### 10. monitoring_error_logs - 错误日志

**用途**：消息处理过程中的系统错误，与 message_id 关联便于追踪

**代码位置**：

- Repository: [src/biz/monitoring/repositories/error-log.repository.ts](../../src/biz/monitoring/repositories/error-log.repository.ts)
- Entity: [src/biz/monitoring/entities/error-log.entity.ts](../../src/biz/monitoring/entities/error-log.entity.ts)

| 字段         | 类型        | 默认值            | 说明                                        |
| ------------ | ----------- | ----------------- | ------------------------------------------- |
| `id`         | uuid        | gen_random_uuid() | 主键                                        |
| `message_id` | text        | NOT NULL          | 关联消息ID                                  |
| `timestamp`  | timestamptz | NOT NULL          | 错误时间（20260312 迁移后改为 timestamptz） |
| `error`      | text        | NOT NULL          | 错误信息                                    |
| `alert_type` | text        | -                 | 告警类型分类                                |
| `created_at` | timestamptz | now()             | -                                           |

**索引**：`idx_error_logs_timestamp` (timestamp DESC)

**操作说明**：

- **写入**：`saveErrorLog()` / `saveErrorLogsBatch()`
- **清理**：`cleanupErrorLogs()` — 保留 90 天（跟随 `DATA_CLEANUP_PROCESSING_DAYS`）

---

## 配置管理表

### 11. system_config - 系统配置

**用途**：全局 KV 配置（JSONB）

**代码位置**：

- Repository: [src/biz/hosting-config/repositories/system-config.repository.ts](../../src/biz/hosting-config/repositories/system-config.repository.ts)
- Entity: [src/biz/hosting-config/entities/system-config.entity.ts](../../src/biz/hosting-config/entities/system-config.entity.ts)

| 字段                        | 类型         | 默认值   | 说明     |
| --------------------------- | ------------ | -------- | -------- |
| `key`                       | varchar(100) | NOT NULL | 主键     |
| `value`                     | jsonb        | NOT NULL | 配置值   |
| `description`               | text         | -        | 配置描述 |
| `created_at` / `updated_at` | timestamptz  | now()    | -        |

**常用配置键**：

- `group_blacklist` — 群消息黑名单
- `ai_reply_enabled` — AI 回复全局开关
- `message_merge_enabled` — 聚合开关
- `agent_reply_config` — Agent 回复配置（模型/延迟/阈值）

---

### 12. strategy_config - 策略配置

**用途**：Agent 行为策略（persona / 阶段目标 / 红线 / 行业技能 / 角色设定），多版本管理

**代码位置**：

- Repository: [src/biz/strategy/repositories/strategy-config.repository.ts](../../src/biz/strategy/repositories/strategy-config.repository.ts)
- Entity: [src/biz/strategy/entities/strategy-config.entity.ts](../../src/biz/strategy/entities/strategy-config.entity.ts)

| 字段                                                                         | 类型        | 默认值            | 说明                                                       |
| ---------------------------------------------------------------------------- | ----------- | ----------------- | ---------------------------------------------------------- |
| `id`                                                                         | uuid        | gen_random_uuid() | 主键                                                       |
| `name` / `description`                                                       | text        | -                 | 名称/描述                                                  |
| `persona` / `stage_goals` / `red_lines` / `industry_skills` / `role_setting` | jsonb       | '{}'              | 策略各片段                                                 |
| `is_active`                                                                  | boolean     | true              | 是否激活                                                   |
| `status`                                                                     | text        | CHECK             | `testing` / `released` / `archived`（20260330 新增版本化） |
| `version`                                                                    | integer     | 1                 | 版本号                                                     |
| `version_note`                                                               | text        | -                 | 版本说明                                                   |
| `released_at`                                                                | timestamptz | -                 | 发布时间                                                   |
| `created_at` / `updated_at`                                                  | timestamptz | now()             | trigger 维护 updated_at                                    |

**索引**：

- `idx_strategy_config_released` (status) WHERE status='released' AND is_active=true
- `idx_strategy_config_testing` (status) WHERE status='testing' AND is_active=true

**触发器**：`trigger_update_strategy_config_updated_at`

**操作说明**：

- **读取**：`findReleasedConfig()` / `findTestingConfig()`（内存 + Redis 缓存）
- **发布**：RPC `publish_strategy(p_version_note)` — 原子将 testing → released，旧 released → archived

---

### 13. 策略逐字段变更归档

线上从 `GET /strategy/versions` 查询策略版本。`public.strategy_config_changelog` 和旧接口 `GET /strategy/changelog` 已退役。退役前的逐字段历史保存在 `strategy_archive.strategy_config_changelog`，保留原始 `id`、`config_id`、`field`、`old_value`、`new_value`、`changed_at`、`changed_by` 七列。`config_id` 保存原版本标识，删除在线策略版本不会级联删除归档。

归档已启用行级安全，`anon`、`authenticated`、`service_role` 均无归档读取权限。需要回滚旧服务时，数据库所有者先确认原 `config_id` 对应版本存在，再运行恢复脚本。脚本在事务内恢复原表、约束、索引、权限和数据，逐行双向核对后提交，私有归档继续保留。[归档迁移](../../supabase/migrations/20261124024135_archive_strategy_config_changelog.sql) · [恢复脚本](../../scripts/sql/restore-strategy-changelog.sql)

---

## 测试套件表

### 14. test_batches - 测试批次

**用途**：场景测试 / 对话回归的批次管理

**代码位置**：

- Repository: [src/biz/test-suite/repositories/test-batch.repository.ts](../../src/biz/test-suite/repositories/test-batch.repository.ts)
- Entity: [src/biz/test-suite/entities/test-batch.entity.ts](../../src/biz/test-suite/entities/test-batch.entity.ts)

| 字段                                                                                        | 类型              | 默认值            | 说明                                          |
| ------------------------------------------------------------------------------------------- | ----------------- | ----------------- | --------------------------------------------- |
| `id`                                                                                        | uuid              | gen_random_uuid() | 主键                                          |
| `name`                                                                                      | varchar(200)      | NOT NULL          | 批次名称                                      |
| `source`                                                                                    | varchar(50)       | 'manual'          | `manual` / `feishu`                           |
| `feishu_table_id`                                                                           | varchar(100)      | -                 | 飞书回写目标                                  |
| `total_cases` / `executed_count` / `passed_count` / `failed_count` / `pending_review_count` | integer           | 0                 | 计数                                          |
| `pass_rate` / `avg_duration_ms` / `avg_token_usage`                                         | numeric / integer | -                 | 汇总                                          |
| `status`                                                                                    | varchar(20)       | 'created'         | created/running/reviewing/completed/cancelled |
| `test_type`                                                                                 | varchar(50)       | 'scenario'        | `scenario` / `conversation`                   |
| `created_by`                                                                                | varchar(100)      | -                 | 创建者                                        |
| `created_at` / `completed_at`                                                               | timestamptz       | -                 | -                                             |

> `feishu_app_token` 字段已于 20260312 迁移中删除。

**索引**：status / test_type / created_at / (test_type, created_at DESC)

---

### 15. test_executions - 测试执行记录

**用途**：单条测试用例的执行详情（输入/输出/Agent 请求/相似度分）

**代码位置**：

- Repository: [src/biz/test-suite/repositories/test-execution.repository.ts](../../src/biz/test-suite/repositories/test-execution.repository.ts)
- Entity: [src/biz/test-suite/entities/test-execution.entity.ts](../../src/biz/test-suite/entities/test-execution.entity.ts)

| 字段                                                               | 类型         | 默认值            | 说明                             |
| ------------------------------------------------------------------ | ------------ | ----------------- | -------------------------------- |
| `id`                                                               | uuid         | gen_random_uuid() | 主键                             |
| `batch_id`                                                         | uuid         | FK → test_batches | -                                |
| `case_id` / `case_name` / `category`                               | varchar      | -                 | 用例标识                         |
| `test_input`                                                       | jsonb        | NOT NULL          | 输入                             |
| `expected_output` / `actual_output`                                | text         | -                 | 期望/实际                        |
| `agent_request` / `agent_response` / `tool_calls` / `token_usage`  | jsonb        | -                 | Agent 调用详情                   |
| `execution_status`                                                 | varchar(20)  | 'pending'         | pending/running/completed/failed |
| `duration_ms`                                                      | integer      | -                 | 耗时                             |
| `error_message`                                                    | text         | -                 | 错误信息                         |
| `review_status` / `review_comment` / `reviewed_by` / `reviewed_at` | -            | -                 | 审核相关                         |
| `failure_reason`                                                   | varchar(100) | -                 | 失败分类                         |
| `test_scenario`                                                    | varchar(100) | -                 | 飞书场景名                       |
| `conversation_snapshot_id`                                         | uuid         | -                 | 关联 snapshot                    |
| `turn_number`                                                      | integer      | -                 | 对话轮次                         |
| `similarity_score`                                                 | numeric      | -                 | 语义相似度（0-100）              |
| `input_message`                                                    | text         | -                 | 当前轮用户输入                   |
| `evaluation_reason`                                                | text         | -                 | LLM 评估理由                     |
| `created_at`                                                       | timestamptz  | now()             | -                                |

**索引**：batch_id / execution_status / review_status / category / created_at / (batch_id, execution_status) / (batch_id, review_status) / (batch_id, created_at) / conversation_snapshot_id / (conversation_snapshot_id, turn_number) / turn_number

---

### 16. test_conversation_snapshots - 对话测试数据源

**用途**：对话回归测试的源数据（从飞书导入完整对话）

**代码位置**：

- Repository: [src/biz/test-suite/repositories/conversation-snapshot.repository.ts](../../src/biz/test-suite/repositories/conversation-snapshot.repository.ts)
- Entity: [src/biz/test-suite/entities/conversation-snapshot.entity.ts](../../src/biz/test-suite/entities/conversation-snapshot.entity.ts)

| 字段                                            | 类型         | 默认值            | 说明                             |
| ----------------------------------------------- | ------------ | ----------------- | -------------------------------- |
| `id`                                            | uuid         | gen_random_uuid() | 主键                             |
| `batch_id`                                      | uuid         | NOT NULL, FK      | -                                |
| `feishu_record_id`                              | varchar(100) | NOT NULL          | 飞书记录ID                       |
| `conversation_id`                               | varchar(100) | NOT NULL          | 对话唯一标识                     |
| `participant_name`                              | varchar(200) | -                 | 候选人姓名                       |
| `full_conversation`                             | jsonb        | NOT NULL          | 解析后的对话数组                 |
| `raw_text`                                      | text         | -                 | 原始对话文本                     |
| `total_turns`                                   | integer      | 0                 | 总轮数                           |
| `avg_similarity_score` / `min_similarity_score` | numeric      | -                 | 相似度分                         |
| `status`                                        | varchar(50)  | 'pending'         | pending/running/completed/failed |
| `created_at` / `updated_at`                     | timestamptz  | now()             | trigger 维护 updated_at          |

**触发器**：`trigger_conversation_snapshots_updated_at`

**索引**：batch_id / status / (batch_id, status)

---

## RPC 函数

### 清理类

| 函数                                               | 默认参数 | 说明                                                 |
| -------------------------------------------------- | -------- | ---------------------------------------------------- |
| `cleanup_message_processing_records(days_to_keep)`          | 90 天         | 删除到期流水及关联快照 |
| `delete_expired_agent_invocations(p_days_old, p_limit)`      | 90 天，500 条 | 按 `created_at` 从最早到期的子表记录开始分批删除 |

`cleanup_chat_messages` / `cleanup_user_activity` 已随迁移 20260902073727 DROP：两表永久保留，改配置也不会再删。
`monitoring_hourly_stats` / `monitoring_daily_stats` / `handoff_events` / `monitoring_error_logs` 的 90 天清理由仓储直接 `delete().lt()`，不走 RPC。

### 查询类

| 函数                                        | 说明                           |
| ------------------------------------------- | ------------------------------ |
| `get_distinct_chat_ids()`                   | 所有 chat_id                   |
| `get_chat_session_list(start, end)`         | 会话列表（含最新消息/头像）    |
| `get_chat_daily_stats(start, end)`          | 按天聚合消息/会话数            |
| `get_chat_summary_stats(start, end)`        | 汇总（总会话/总消息/活跃会话） |
| `get_active_users_by_range(start, end)`     | 指定区间活跃用户               |
| `get_daily_user_stats_by_range(start, end)` | 按天的用户活跃统计             |

### Dashboard 类

| 函数                                               | 说明                                              |
| -------------------------------------------------- | ------------------------------------------------- |
| `get_dashboard_overview_stats(start, end)`         | 总览（消息数/成功率/耗时/Token/avg_ttft）         |
| `get_dashboard_fallback_stats(start, end)`         | 降级统计（含受影响用户）                          |
| `get_dashboard_hourly_trend(start, end)`           | 小时趋势                                          |
| `get_dashboard_minute_trend(start, end, interval)` | 分钟趋势（可配间隔）                              |
| `get_dashboard_daily_trend(start, end)`            | 日趋势                                            |
| `get_dashboard_scenario_stats(start, end)`         | 场景分布                                          |
| `get_dashboard_tool_stats(start, end)`             | 工具使用（20260417 改为从 tool_calls jsonb 解析） |

### 聚合类

| 函数                                           | 说明                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `aggregate_hourly_stats(hour_start, hour_end)` | 小时级聚合（20260417 refine，支持 timeout_count/error_type_stats/tool_calls） |
| `aggregate_daily_stats(day_start, day_end)`    | 日级聚合（20260416 新增）                                                     |

### 数据修改类

| 函数                               | 说明                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `upsert_user_activity(...)`        | 用户活跃度 upsert（每次消息触发）                          |
| `publish_strategy(p_version_note)` | 策略版本发布（testing → released，旧 released → archived） |

---

## 数据生命周期

```
消息接收
  │
  ├──► chat_messages（永久）
  │
  ├──► message_processing_records（保留 90 天）
  │       │
  │       ├──► message_processing_invocations（默认 90 天，主流水删除时级联删除）
  │       │
  │       ├── 每小时 ──► monitoring_hourly_stats（保留 90 天）
  │       └── 每天   ──► monitoring_daily_stats（保留 90 天）
  │
  ├──► user_activity（永久）
  │
  ├──► monitoring_error_logs（保留 90 天，异常时写入）
  │
  └──► agent_long_term_memories（跨会话长期记忆，永久）
```

**清理调度**：由 [src/biz/monitoring/services/cleanup/](../../src/biz/monitoring/services/cleanup/) 下的定时任务驱动，经 Supabase RPC 执行批量删除。

**生产存储实测**（2026-11-24）

按 `pg_total_relation_size` 计入表、TOAST 和索引，清理完成时主流水占 1.46 GiB，调用快照子表占 807 MiB，策略历史归档占 1.12 MiB。快照保留期于当天延长，完整 90 天窗口的容量要在后续观察。

**消息与动作存储实测**（2026-11-25）

按 `pg_total_relation_size` 计入表、TOAST 和索引，堆页按 8 KiB 计数。更新产生的旧行版本占用已分配页面，后续写入可在数据库例行回收后复用。

| 生产表 | 执行前 MiB | 验收时 MiB | 执行前堆页 | 验收时堆页 |
| --- | ---: | ---: | ---: | ---: |
| `chat_messages` | 682.1 | 713.7 | 49,136 | 52,356 |
| `agent_action_records` | 109.9 | 109.9 | 8,528 | 8,528 |
| `agent_action_evidence` | 35.0 | 35.1 | 2,256 | 2,262 |

按历史实际变更键比较完整 JSON 与剩余正文字段的 UTF-8 文本，聊天减少 96,994,069 字节，动作减少 25,793 字节。此口径只计正文字段的逻辑表示。
