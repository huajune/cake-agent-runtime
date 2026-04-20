# 数据库表设计与使用说明

> Cake Agent Runtime - Supabase (PostgreSQL) 数据库设计文档

**最后更新**：2026-04-20

**数据库**：Supabase PostgreSQL | **基线迁移**：[supabase/migrations/20260310000000_baseline.sql](../../supabase/migrations/20260310000000_baseline.sql)

**项目环境**：prod `uvmbxcilpteaiizplcyp` / test `gaovfitvetoojkvtalxy`

---

## 目录

- [总览](#总览)
- [表分类与关系](#表分类与关系)
- [核心业务表](#核心业务表)
  - [chat_messages](#1-chat_messages---聊天消息记录)
  - [message_processing_records](#2-message_processing_records---消息处理记录)
  - [interview_booking_records](#3-interview_booking_records---面试预约记录)
  - [recruitment_cases](#4-recruitment_cases---招聘案件)
- [记忆/画像表](#记忆画像表)
  - [agent_memories](#5-agent_memories---用户长期画像)
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
  - [strategy_config_changelog](#13-strategy_config_changelog---策略变更日志)
- [测试套件表](#测试套件表)
  - [test_batches](#14-test_batches---测试批次)
  - [test_executions](#15-test_executions---测试执行记录)
  - [test_conversation_snapshots](#16-test_conversation_snapshots---对话测试数据源)
- [RPC 函数](#rpc-函数)
- [数据生命周期](#数据生命周期)

---

## 总览

| # | 表名 | 业务域 | 写入方式 | 读取方式 | 数据保留 |
|---|------|--------|---------|---------|---------|
| 1 | `chat_messages` | 消息 | upsert | select / RPC | 90 天 |
| 2 | `message_processing_records` | 消息 | insert / upsert | select / RPC | 30 天（7 天后清空 agent_invocation） |
| 3 | `interview_booking_records` | 消息 | RPC upsert | select | 永久 |
| 4 | `recruitment_cases` | 消息 | insert / update | select | 永久（按 status 归档） |
| 5 | `agent_memories` | 记忆 | upsert | select | 永久 |
| 6 | `user_activity` | 用户 | RPC upsert | select | 30 天 |
| 7 | `user_hosting_status` | 用户 | upsert / update | select | 永久 |
| 8 | `monitoring_hourly_stats` | 监控 | upsert | select | 永久 |
| 9 | `monitoring_daily_stats` | 监控 | upsert | select | 永久 |
| 10 | `monitoring_error_logs` | 监控 | insert | select | 30 天 |
| 11 | `system_config` | 配置 | upsert | select | 永久 |
| 12 | `strategy_config` | 配置 | insert / update | select | 永久（多版本） |
| 13 | `strategy_config_changelog` | 配置 | insert | select | 永久 |
| 14 | `test_batches` | 测试 | insert / update | select | 永久 |
| 15 | `test_executions` | 测试 | insert / update | select | 永久 |
| 16 | `test_conversation_snapshots` | 测试 | insert / update | select | 永久 |

---

## 表分类与关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        核心业务表                                │
│                                                                 │
│  chat_messages ──────> message_processing_records               │
│       │                    │        (message_id 关联)            │
│       │                    │                                    │
│       │                    ├─── 每小时 ──> monitoring_hourly_stats │
│       │                    └─── 每天  ──> monitoring_daily_stats  │
│       │                                                         │
│       ├──> interview_booking_records (chat_id 关联)              │
│       └──> recruitment_cases       (chat_id/corp_id 关联)        │
├─────────────────────────────────────────────────────────────────┤
│                        记忆/画像                                 │
│                                                                 │
│  agent_memories  (corp_id + user_id 唯一，跨会话持久画像)          │
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
│  strategy_config ──> strategy_config_changelog (审计)            │
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

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `chat_id` | text | NOT NULL | 会话ID，通常为 recipientId |
| `message_id` | text | NOT NULL, UNIQUE | 消息唯一ID，用于去重 |
| `role` | text | NOT NULL | 消息角色：`user` / `assistant` |
| `content` | text | NOT NULL | 消息内容 |
| `timestamp` | timestamptz | NOT NULL | 消息发送时间 |
| `candidate_name` | text | - | 候选人微信昵称 |
| `manager_name` | text | - | 招募经理姓名 |
| `org_id` | text | - | 企业ID |
| `bot_id` | text | - | Bot ID |
| `is_room` | boolean | false | 是否群聊 |
| `message_type` | text | 'TEXT' | TEXT/IMAGE/VOICE/FILE/VIDEO/LINK |
| `source` | text | 'MOBILE_PUSH' | MOBILE_PUSH/API_SEND/AI_REPLY |
| `im_bot_id` | text | - | 托管账号的系统 wxid |
| `im_contact_id` | text | - | 联系人系统ID |
| `contact_type` | text | 'UNKNOWN' | UNKNOWN/PERSONAL_WECHAT/OFFICIAL_ACCOUNT/ENTERPRISE_WECHAT |
| `is_self` | boolean | false | 是否托管账号自己发送 |
| `payload` | jsonb | - | 原始消息 JSON |
| `avatar` | text | - | 用户头像 URL |
| `external_user_id` | text | - | 企微外部用户ID |
| `created_at` | timestamptz | now() | 记录创建时间 |

**索引**：

- `idx_chat_messages_timestamp` - timestamp DESC
- `idx_chat_messages_chat_id` - (chat_id, timestamp DESC)

**操作说明**：

- **写入**：`saveChatMessage()` / `saveChatMessagesBatch()` — upsert by message_id
- **读取**：`getChatHistory()` / `getSessionList()` — 按 chat_id + 时间范围
- **清理**：RPC `cleanup_chat_messages(90)` — 保留 90 天

---

### 2. message_processing_records - 消息处理记录

**用途**：记录每条消息的处理全生命周期 —— 状态、耗时、AI 调用、工具使用、异常标记、记忆快照等

**代码位置**：

- Repository: [src/biz/message/repositories/message-processing.repository.ts](../../src/biz/message/repositories/message-processing.repository.ts)
- Entity: [src/biz/message/entities/message-processing.entity.ts](../../src/biz/message/entities/message-processing.entity.ts)
- Tracking: [src/biz/monitoring/services/tracking/message-tracking.service.ts](../../src/biz/monitoring/services/tracking/message-tracking.service.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | bigint | sequence | 主键（自增） |
| `message_id` | text | NOT NULL, UNIQUE | 关联 chat_messages |
| `chat_id` | text | NOT NULL | 会话ID |
| `user_id` | text | - | 用户ID |
| `user_name` | text | - | 用户昵称（trgm 索引） |
| `manager_name` | text | - | 经理姓名 |
| `received_at` | timestamptz | now() | 消息接收时间 |
| `message_preview` | text | - | 用户消息预览 |
| `reply_preview` | text | - | AI 回复预览 |
| `reply_segments` | integer | 0 | 回复分段数 |
| `status` | text | NOT NULL, CHECK | `processing` / `success` / `failure` / `timeout` |
| `error` | text | - | 错误信息 |
| `scenario` | text | - | 场景分类 |
| `alert_type` | text | - | 失败分类：agent/message/delivery/system/merge/unknown |
| `total_duration` | integer | - | 总耗时（ms） |
| `queue_duration` | integer | - | 队列等待耗时（ms） |
| `prep_duration` | integer | - | 准备阶段耗时（ms） |
| `ai_start_at` | bigint | - | AI 处理开始时间戳 |
| `ai_end_at` | bigint | - | AI 处理结束时间戳 |
| `ai_duration` | integer | - | AI 处理耗时（ms） |
| `send_duration` | integer | - | 消息发送耗时（ms） |
| `tool_calls` | jsonb | - | 工具调用明细 `[{ toolName, args, result, status, durationMs }]` |
| `agent_steps` | jsonb | - | Agent 逐步轨迹 `[{ stepIndex, text, reasoning, toolCalls, usage, durationMs }]` |
| `anomaly_flags` | text[] | - | 异常标记：tool_loop/tool_empty_result/tool_narrow_result/tool_chain_overlong/no_tool_called |
| `memory_snapshot` | jsonb | - | 运行时记忆快照 `{ currentStage, presentedJobIds, recommendedJobIds, sessionFacts, profileKeys }` |
| `token_usage` | integer | - | Token 消耗量 |
| `is_fallback` | boolean | false | 是否降级处理 |
| `fallback_success` | boolean | - | 降级是否成功 |
| `agent_invocation` | jsonb | - | Agent 完整调用记录（request/response/http，7 天后置 NULL） |
| `batch_id` | varchar(255) | - | 聚合批次ID |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | trigger 自动维护 |

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
- **读取**：`getSlowestMessages()` / `getMessageProcessingRecords()` — Dashboard 查询
- **聚合**：RPC `aggregate_hourly_stats()` / `aggregate_daily_stats()`
- **清理**：RPC `cleanup_message_processing_records(30)` — 保留 30 天
- **瘦身**：RPC `null_agent_invocation(7)` — 7 天后清空 agent_invocation

---

### 3. interview_booking_records - 面试预约记录

**用途**：记录 AI 预约面试的统计数据，按品牌/门店/日期聚合

**代码位置**：

- Repository: [src/biz/message/repositories/booking.repository.ts](../../src/biz/message/repositories/booking.repository.ts)
- Entity: [src/biz/message/entities/booking.entity.ts](../../src/biz/message/entities/booking.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `date` | date | NOT NULL | 预约日期 |
| `brand_name` | text | - | 品牌名称 |
| `store_name` | text | - | 门店名称 |
| `booking_count` | integer | 0 | 预约次数 |
| `chat_id` | varchar(255) | - | 会话ID |
| `user_id` | varchar(255) | - | 用户 wxid（imContactId） |
| `user_name` | varchar(255) | - | 用户昵称 |
| `manager_id` | varchar(255) | - | 招募经理 ID |
| `manager_name` | varchar(255) | - | 招募经理昵称 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

**唯一约束**：`(date, brand_name, store_name)`

**索引**：`date` / `brand_name` / `user_id` / `manager_id` / `(date, manager_id)`（多为部分索引）

**操作说明**：

- **写入**：`incrementBookingCount()` — 通过 RPC `increment_booking_count` 原子 upsert，`brand_name`/`store_name` 为空时 COALESCE 为 `''`
- **读取**：`getBookingStats()` / `getTodayBookingCount()` — Dashboard 统计

---

### 4. recruitment_cases - 招聘案件

**用途**：跟踪约面后的 Case 生命周期（目前仅 `onboard_followup`），驱动后续跟进触达

**代码位置**：

- Repository: [src/biz/recruitment-case/repositories/recruitment-case.repository.ts](../../src/biz/recruitment-case/repositories/recruitment-case.repository.ts)
- Entity: [src/biz/recruitment-case/entities/recruitment-case.entity.ts](../../src/biz/recruitment-case/entities/recruitment-case.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `corp_id` | text | NOT NULL | 企业ID |
| `chat_id` | text | NOT NULL | 会话ID |
| `user_id` | text | - | 候选人ID |
| `case_type` | text | NOT NULL, CHECK | 当前仅 `onboard_followup` |
| `status` | text | NOT NULL, CHECK | `active` / `handoff` / `closed` / `expired` |
| `booking_id` | text | - | 预约ID |
| `booked_at` | timestamptz | - | 预约时间 |
| `interview_time` | text | - | 面试时间（文本） |
| `job_id` | bigint | - | 岗位ID |
| `job_name` | text | - | 岗位名 |
| `brand_name` | text | - | 品牌 |
| `store_name` | text | - | 门店 |
| `bot_im_id` | text | - | 托管账号 |
| `followup_window_ends_at` | timestamptz | - | 跟进窗口截止 |
| `last_relevant_at` | timestamptz | - | 最近相关活动 |
| `metadata` | jsonb | - | 扩展字段 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | trigger 自动维护 |

**索引**：

- `idx_recruitment_cases_chat` - (corp_id, chat_id, updated_at DESC)
- `idx_recruitment_cases_user` - (user_id, updated_at DESC)
- `idx_recruitment_cases_open_unique` - (corp_id, chat_id, case_type) WHERE status IN ('active','handoff')

**触发器**：`trigger_recruitment_cases_updated_at`

---

## 记忆/画像表

### 5. agent_memories - 用户长期画像

**用途**：按 `(corp_id, user_id)` 存储跨会话的候选人画像（结构化字段 + summary JSON）

**代码位置**：

- Store: [src/memory/stores/supabase.store.ts](../../src/memory/stores/supabase.store.ts)
- Service: [src/memory/services/long-term.service.ts](../../src/memory/services/long-term.service.ts)
- Types: [src/memory/types/long-term.types.ts](../../src/memory/types/long-term.types.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `corp_id` | text | NOT NULL | 企业ID |
| `user_id` | text | NOT NULL | 候选人唯一ID |
| `name` | text | - | 姓名 |
| `phone` | text | - | 电话 |
| `gender` | text | - | 性别 |
| `age` | text | - | 年龄 |
| `is_student` | boolean | - | 是否学生 |
| `education` | text | - | 教育水平 |
| `has_health_certificate` | text | - | 健康证 |
| `summary_data` | jsonb | - | 摘要 `{ recent: string[], archive: string }` |
| `message_metadata` | jsonb | - | 最近消息元数据 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | trigger 自动维护 |

**唯一约束**：`(corp_id, user_id)`（迁移 20260320 后每用户仅一行，扁平化画像字段）

**触发器**：`trigger_agent_memories_updated_at`

**Key 命名**：`profile:{corpId}:{userId}`（由 SupabaseStore 内部使用）

---

## 用户管理表

### 6. user_activity - 用户活跃度

**用途**：按天记录用户活跃度（消息数 / Token 消耗 / 首末时间）

**代码位置**：

- Repository: [src/biz/user/repositories/user-hosting.repository.ts](../../src/biz/user/repositories/user-hosting.repository.ts)
- Entity: [src/biz/user/entities/user-activity.entity.ts](../../src/biz/user/entities/user-activity.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | bigint | sequence | 主键（自增） |
| `chat_id` | text | NOT NULL | 用户唯一标识 |
| `od_id` | text | - | 用户 OD ID |
| `od_name` | text | - | 用户昵称 |
| `group_id` | text | - | 所属小组 ID |
| `group_name` | text | - | 所属小组名称 |
| `activity_date` | date | NOT NULL | 活跃日期（按天聚合） |
| `message_count` | integer | 0 | 当日消息数 |
| `token_usage` | integer | 0 | 当日 Token 消耗 |
| `first_active_at` | timestamptz | NOT NULL | 首次活跃时间 |
| `last_active_at` | timestamptz | NOT NULL | 末次活跃时间 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

**唯一约束**：`(chat_id, activity_date)`

**操作说明**：

- **写入**：RPC `upsert_user_activity()` — 消息接收时自动累加
- **读取**：RPC `get_active_users_by_range()` / `get_daily_user_stats_by_range()`
- **清理**：RPC `cleanup_user_activity(30)` — 保留 30 天

---

### 7. user_hosting_status - 用户托管状态

**用途**：AI 托管暂停/恢复状态管理

**代码位置**：

- Repository: [src/biz/user/repositories/user-hosting.repository.ts](../../src/biz/user/repositories/user-hosting.repository.ts)
- Entity: [src/biz/user/entities/user-hosting-status.entity.ts](../../src/biz/user/entities/user-hosting-status.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `user_id` | varchar(100) | NOT NULL | 主键，用户ID |
| `is_paused` | boolean | false | 是否暂停 |
| `paused_at` | timestamptz | - | 暂停时间 |
| `resumed_at` | timestamptz | - | 恢复时间 |
| `pause_count` | integer | 0 | 累计暂停次数 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `hour` | timestamptz UNIQUE | 统计小时（整点） |
| `message_count` / `success_count` / `failure_count` / `timeout_count` | integer | 消息数/成功/失败（非超时）/超时 |
| `success_rate` | numeric | 成功率 |
| `avg_duration` / `min_duration` / `max_duration` | integer | 耗时统计 |
| `p50_duration` / `p95_duration` / `p99_duration` | integer | 耗时分位 |
| `avg_queue_duration` / `avg_prep_duration` / `avg_ai_duration` / `avg_send_duration` | integer | 各阶段耗时 |
| `active_users` / `active_chats` | integer | 活跃维度 |
| `total_token_usage` | bigint | Token 总消耗 |
| `fallback_count` / `fallback_success_count` | integer | 降级计数 |
| `scenario_stats` / `tool_stats` / `error_type_stats` | jsonb | 场景/工具/错误类型分布 |
| `created_at` / `updated_at` | timestamptz | - |

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `stat_date` | date UNIQUE | 统计日期 |
| `message_count` / `success_count` / `failure_count` / `timeout_count` | integer | 消息/成功/失败（非超时）/超时 |
| `success_rate` / `avg_duration` | numeric / integer | 成功率/平均耗时 |
| `total_token_usage` | bigint | Token 总消耗 |
| `unique_users` / `unique_chats` | integer | 去重用户/会话 |
| `fallback_count` / `fallback_success_count` / `fallback_affected_users` | integer | 降级指标 |
| `avg_queue_duration` / `avg_prep_duration` | integer | 各阶段平均耗时 |
| `error_type_stats` | jsonb | 错误类型分布 |
| `created_at` / `updated_at` | timestamptz | - |

**索引**：`idx_monitoring_daily_stats_stat_date` (stat_date DESC)

**数据来源**：RPC `aggregate_daily_stats()`

---

### 10. monitoring_error_logs - 错误日志

**用途**：消息处理过程中的系统错误，与 message_id 关联便于追踪

**代码位置**：

- Repository: [src/biz/monitoring/repositories/error-log.repository.ts](../../src/biz/monitoring/repositories/error-log.repository.ts)
- Entity: [src/biz/monitoring/entities/error-log.entity.ts](../../src/biz/monitoring/entities/error-log.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `message_id` | text | NOT NULL | 关联消息ID |
| `timestamp` | timestamptz | NOT NULL | 错误时间（20260312 迁移后改为 timestamptz） |
| `error` | text | NOT NULL | 错误信息 |
| `alert_type` | text | - | 告警类型分类 |
| `created_at` | timestamptz | now() | - |

**索引**：`idx_error_logs_timestamp` (timestamp DESC)

**操作说明**：

- **写入**：`saveErrorLog()` / `saveErrorLogsBatch()`
- **清理**：`cleanupErrorLogs()` — 保留 30 天

---

## 配置管理表

### 11. system_config - 系统配置

**用途**：全局 KV 配置（JSONB）

**代码位置**：

- Repository: [src/biz/hosting-config/repositories/system-config.repository.ts](../../src/biz/hosting-config/repositories/system-config.repository.ts)
- Entity: [src/biz/hosting-config/entities/system-config.entity.ts](../../src/biz/hosting-config/entities/system-config.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `key` | varchar(100) | NOT NULL | 主键 |
| `value` | jsonb | NOT NULL | 配置值 |
| `description` | text | - | 配置描述 |
| `created_at` / `updated_at` | timestamptz | now() | - |

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

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `name` / `description` | text | - | 名称/描述 |
| `persona` / `stage_goals` / `red_lines` / `industry_skills` / `role_setting` | jsonb | '{}' | 策略各片段 |
| `is_active` | boolean | true | 是否激活 |
| `status` | text | CHECK | `testing` / `released` / `archived`（20260330 新增版本化） |
| `version` | integer | 1 | 版本号 |
| `version_note` | text | - | 版本说明 |
| `released_at` | timestamptz | - | 发布时间 |
| `created_at` / `updated_at` | timestamptz | now() | trigger 维护 updated_at |

**索引**：

- `idx_strategy_config_released` (status) WHERE status='released' AND is_active=true
- `idx_strategy_config_testing` (status) WHERE status='testing' AND is_active=true

**触发器**：`trigger_update_strategy_config_updated_at`

**操作说明**：

- **读取**：`findReleasedConfig()` / `findTestingConfig()`（内存 + Redis 缓存）
- **发布**：RPC `publish_strategy(p_version_note)` — 原子将 testing → released，旧 released → archived

---

### 13. strategy_config_changelog - 策略变更日志

**用途**：审计 strategy_config 每次字段变更

**代码位置**：

- Repository: [src/biz/strategy/repositories/strategy-changelog.repository.ts](../../src/biz/strategy/repositories/strategy-changelog.repository.ts)
- Entity: [src/biz/strategy/entities/strategy-changelog.entity.ts](../../src/biz/strategy/entities/strategy-changelog.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `config_id` | uuid | FK → strategy_config | 关联策略（ON DELETE CASCADE） |
| `field` | text | NOT NULL | 变更字段：persona/stage_goals/red_lines/... |
| `old_value` / `new_value` | jsonb | - / NOT NULL | 前后值 |
| `changed_at` | timestamptz | now() | 变更时间 |
| `changed_by` | text | - | 操作者（预留） |

**索引**：`idx_changelog_config_time` (config_id, changed_at DESC) / `idx_changelog_field` (field)

---

## 测试套件表

### 14. test_batches - 测试批次

**用途**：场景测试 / 对话回归的批次管理

**代码位置**：

- Repository: [src/biz/test-suite/repositories/test-batch.repository.ts](../../src/biz/test-suite/repositories/test-batch.repository.ts)
- Entity: [src/biz/test-suite/entities/test-batch.entity.ts](../../src/biz/test-suite/entities/test-batch.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `name` | varchar(200) | NOT NULL | 批次名称 |
| `source` | varchar(50) | 'manual' | `manual` / `feishu` |
| `feishu_table_id` | varchar(100) | - | 飞书回写目标 |
| `total_cases` / `executed_count` / `passed_count` / `failed_count` / `pending_review_count` | integer | 0 | 计数 |
| `pass_rate` / `avg_duration_ms` / `avg_token_usage` | numeric / integer | - | 汇总 |
| `status` | varchar(20) | 'created' | created/running/reviewing/completed/cancelled |
| `test_type` | varchar(50) | 'scenario' | `scenario` / `conversation` |
| `created_by` | varchar(100) | - | 创建者 |
| `created_at` / `completed_at` | timestamptz | - | - |

> `feishu_app_token` 字段已于 20260312 迁移中删除。

**索引**：status / test_type / created_at / (test_type, created_at DESC)

---

### 15. test_executions - 测试执行记录

**用途**：单条测试用例的执行详情（输入/输出/Agent 请求/相似度分）

**代码位置**：

- Repository: [src/biz/test-suite/repositories/test-execution.repository.ts](../../src/biz/test-suite/repositories/test-execution.repository.ts)
- Entity: [src/biz/test-suite/entities/test-execution.entity.ts](../../src/biz/test-suite/entities/test-execution.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `batch_id` | uuid | FK → test_batches | - |
| `case_id` / `case_name` / `category` | varchar | - | 用例标识 |
| `test_input` | jsonb | NOT NULL | 输入 |
| `expected_output` / `actual_output` | text | - | 期望/实际 |
| `agent_request` / `agent_response` / `tool_calls` / `token_usage` | jsonb | - | Agent 调用详情 |
| `execution_status` | varchar(20) | 'pending' | pending/running/completed/failed |
| `duration_ms` | integer | - | 耗时 |
| `error_message` | text | - | 错误信息 |
| `review_status` / `review_comment` / `reviewed_by` / `reviewed_at` | - | - | 审核相关 |
| `failure_reason` | varchar(100) | - | 失败分类 |
| `test_scenario` | varchar(100) | - | 飞书场景名 |
| `conversation_snapshot_id` | uuid | - | 关联 snapshot |
| `turn_number` | integer | - | 对话轮次 |
| `similarity_score` | numeric | - | 语义相似度（0-100） |
| `input_message` | text | - | 当前轮用户输入 |
| `evaluation_reason` | text | - | LLM 评估理由 |
| `created_at` | timestamptz | now() | - |

**索引**：batch_id / execution_status / review_status / category / created_at / (batch_id, execution_status) / (batch_id, review_status) / (batch_id, created_at) / conversation_snapshot_id / (conversation_snapshot_id, turn_number) / turn_number

---

### 16. test_conversation_snapshots - 对话测试数据源

**用途**：对话回归测试的源数据（从飞书导入完整对话）

**代码位置**：

- Repository: [src/biz/test-suite/repositories/conversation-snapshot.repository.ts](../../src/biz/test-suite/repositories/conversation-snapshot.repository.ts)
- Entity: [src/biz/test-suite/entities/conversation-snapshot.entity.ts](../../src/biz/test-suite/entities/conversation-snapshot.entity.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `batch_id` | uuid | NOT NULL, FK | - |
| `feishu_record_id` | varchar(100) | NOT NULL | 飞书记录ID |
| `conversation_id` | varchar(100) | NOT NULL | 对话唯一标识 |
| `participant_name` | varchar(200) | - | 候选人姓名 |
| `full_conversation` | jsonb | NOT NULL | 解析后的对话数组 |
| `raw_text` | text | - | 原始对话文本 |
| `total_turns` | integer | 0 | 总轮数 |
| `avg_similarity_score` / `min_similarity_score` | numeric | - | 相似度分 |
| `status` | varchar(50) | 'pending' | pending/running/completed/failed |
| `created_at` / `updated_at` | timestamptz | now() | trigger 维护 updated_at |

**触发器**：`trigger_conversation_snapshots_updated_at`

**索引**：batch_id / status / (batch_id, status)

---

## RPC 函数

### 清理类

| 函数 | 默认参数 | 说明 |
|------|---------|------|
| `cleanup_chat_messages(retention_days)` | 90 | 删除过期聊天消息 |
| `cleanup_message_processing_records(days_to_keep)` | 30 | 删除过期处理记录 |
| `cleanup_user_activity(retention_days)` | 30 | 删除过期用户活跃记录 |
| `null_agent_invocation(p_days_old)` | 7 | 清空旧记录 agent_invocation 字段 |

### 查询类

| 函数 | 说明 |
|------|------|
| `get_distinct_chat_ids()` | 所有 chat_id |
| `get_chat_session_list(start, end)` | 会话列表（含最新消息/头像） |
| `get_chat_daily_stats(start, end)` | 按天聚合消息/会话数 |
| `get_chat_summary_stats(start, end)` | 汇总（总会话/总消息/活跃会话） |
| `get_active_users_by_range(start, end)` | 指定区间活跃用户 |
| `get_daily_user_stats_by_range(start, end)` | 按天的用户活跃统计 |

### Dashboard 类

| 函数 | 说明 |
|------|------|
| `get_dashboard_overview_stats(start, end)` | 总览（消息数/成功率/耗时/Token/avg_ttft） |
| `get_dashboard_fallback_stats(start, end)` | 降级统计（含受影响用户） |
| `get_dashboard_hourly_trend(start, end)` | 小时趋势 |
| `get_dashboard_minute_trend(start, end, interval)` | 分钟趋势（可配间隔） |
| `get_dashboard_daily_trend(start, end)` | 日趋势 |
| `get_dashboard_scenario_stats(start, end)` | 场景分布 |
| `get_dashboard_tool_stats(start, end)` | 工具使用（20260417 改为从 tool_calls jsonb 解析） |

### 聚合类

| 函数 | 说明 |
|------|------|
| `aggregate_hourly_stats(hour_start, hour_end)` | 小时级聚合（20260417 refine，支持 timeout_count/error_type_stats/tool_calls） |
| `aggregate_daily_stats(day_start, day_end)` | 日级聚合（20260416 新增） |

### 数据修改类

| 函数 | 说明 |
|------|------|
| `increment_booking_count(...)` | 面试预约原子 upsert（自动 COALESCE NULL） |
| `upsert_user_activity(...)` | 用户活跃度 upsert（每次消息触发） |
| `publish_strategy(p_version_note)` | 策略版本发布（testing → released，旧 released → archived） |

---

## 数据生命周期

```
消息接收
  │
  ├──► chat_messages（保留 90 天）
  │
  ├──► message_processing_records（保留 30 天）
  │       │
  │       ├── 7 天后：agent_invocation 字段置 NULL
  │       │
  │       ├── 每小时 ──► monitoring_hourly_stats（永久）
  │       └── 每天   ──► monitoring_daily_stats（永久）
  │
  ├──► user_activity（保留 30 天）
  │
  ├──► monitoring_error_logs（保留 30 天，异常时写入）
  │
  ├──► interview_booking_records（AI 预约面试时 upsert）
  │
  ├──► recruitment_cases（约面后跟进 Case，状态驱动）
  │
  └──► agent_memories（跨会话用户画像，永久）
```

**清理调度**：由 [src/biz/monitoring/services/cleanup/](../../src/biz/monitoring/services/cleanup/) 下的定时任务驱动，经 Supabase RPC 执行批量删除。

**存储估算**（日均 500 条消息）：

- chat_messages: ~45K 行/90 天 ≈ 50 MB
- message_processing_records: ~15K 行/30 天 ≈ 30 MB（含 tool_calls/agent_steps JSONB）
- monitoring_hourly_stats: ~8760 行/年 ≈ 5 MB
- monitoring_daily_stats: ~365 行/年 ≈ <1 MB
- 总计: < 150 MB（远低于 Supabase 免费额度 500 MB）
