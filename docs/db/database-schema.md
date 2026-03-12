# 数据库表设计与使用说明

> DuLiDay 企业微信服务 - Supabase (PostgreSQL) 数据库设计文档

**最后更新**：2026-03-11

**数据库**：Supabase PostgreSQL | **基线迁移**：`supabase/migrations/20260310000000_baseline.sql`

---

## 目录

- [总览](#总览)
- [表分类与关系](#表分类与关系)
- [核心业务表](#核心业务表)
  - [chat_messages](#1-chat_messages---聊天消息记录)
  - [message_processing_records](#2-message_processing_records---消息处理记录)
  - [interview_booking_records](#3-interview_booking_records---面试预约记录)
- [用户管理表](#用户管理表)
  - [user_activity](#4-user_activity---用户活跃度)
  - [user_hosting_status](#5-user_hosting_status---用户托管状态)
- [监控统计表](#监控统计表)
  - [monitoring_hourly_stats](#6-monitoring_hourly_stats---小时级统计)
  - [monitoring_error_logs](#7-monitoring_error_logs---错误日志)
- [配置管理表](#配置管理表)
  - [system_config](#8-system_config---系统配置)
  - [strategy_config](#9-strategy_config---策略配置)
- [测试套件表](#测试套件表)
  - [test_batches](#10-test_batches---测试批次)
  - [test_executions](#11-test_executions---测试执行记录)
  - [conversation_test_sources](#12-conversation_test_sources---对话测试数据源)
- [RPC 函数](#rpc-函数)
- [数据生命周期](#数据生命周期)

---

## 总览

| # | 表名 | 业务域 | 写入方式 | 读取方式 | 数据保留 |
|---|------|--------|---------|---------|---------|
| 1 | `chat_messages` | 消息 | upsert | select / RPC | 90 天 |
| 2 | `message_processing_records` | 消息 | insert / upsert | select / RPC | 30 天 |
| 3 | `interview_booking_records` | 消息 | insert | select | 待定 |
| 4 | `user_activity` | 用户 | RPC upsert | select | 30 天 |
| 5 | `user_hosting_status` | 用户 | upsert / update | select | 永久 |
| 6 | `monitoring_hourly_stats` | 监控 | upsert | select | 永久 |
| 7 | `monitoring_error_logs` | 监控 | insert | select | 30 天 |
| 8 | `system_config` | 配置 | upsert | select | 永久 |
| 9 | `strategy_config` | 配置 | insert / update | select | 永久 |
| 10 | `test_batches` | 测试 | insert / update | select | 待定 |
| 11 | `test_executions` | 测试 | insert / update | select | 待定 |
| 12 | `conversation_test_sources` | 测试 | insert / update | select | 待定 |

---

## 表分类与关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        核心业务表                                │
│                                                                 │
│  chat_messages ──────> message_processing_records               │
│       │                    │        (message_id 关联)            │
│       │                    ▼                                    │
│       │            monitoring_hourly_stats (按小时聚合)           │
│       │                                                         │
│       └──> interview_booking_records (chat_id 关联)              │
├─────────────────────────────────────────────────────────────────┤
│                        用户管理表                                │
│                                                                 │
│  user_activity ◄──── user_hosting_status                        │
│    (chat_id)           (user_id/chat_id 关联)                    │
├─────────────────────────────────────────────────────────────────┤
│                        监控统计表                                │
│                                                                 │
│  monitoring_error_logs (独立错误日志)                              │
│  monitoring_hourly_stats (聚合自 message_processing_records)     │
├─────────────────────────────────────────────────────────────────┤
│                        测试套件表                                │
│                                                                 │
│  test_batches ──> test_executions                               │
│       │               │                                         │
│       └──> conversation_test_sources ◄──┘                       │
│               (batch_id + conversation_source_id 关联)           │
├─────────────────────────────────────────────────────────────────┤
│                        配置管理表                                │
│                                                                 │
│  system_config (KV 配置)    strategy_config (AI 策略)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心业务表

### 1. chat_messages - 聊天消息记录

**用途**：存储用户与 AI 之间的所有聊天消息（私聊为主，含群聊标记）

**代码位置**：
- Repository: `src/biz/message/repositories/chat-message.repository.ts`
- Entity: `src/biz/message/entities/chat-message.entity.ts`
- Enum: `src/wecom/message/enums/chat-message.enum.ts`

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
| `message_type` | text | 'TEXT' | 消息类型：TEXT/IMAGE/VOICE/FILE/VIDEO/LINK |
| `source` | text | 'MOBILE_PUSH' | 来源：MOBILE_PUSH/API_SEND/AI_REPLY |
| `im_bot_id` | text | - | 托管账号的系统 wxid |
| `im_contact_id` | text | - | 联系人系统ID |
| `contact_type` | text | 'UNKNOWN' | UNKNOWN/PERSONAL_WECHAT/OFFICIAL_ACCOUNT/ENTERPRISE_WECHAT |
| `is_self` | boolean | false | 是否托管账号自己发送的消息 |
| `payload` | jsonb | - | 原始消息 JSON（完整 payload） |
| `avatar` | text | - | 用户头像 URL |
| `external_user_id` | text | - | 企微外部用户ID |
| `created_at` | timestamptz | now() | 记录创建时间 |

**索引**：
- `idx_chat_messages_timestamp` - timestamp DESC

**操作说明**：
- **写入**：`saveChatMessage()` / `saveChatMessagesBatch()` — upsert by message_id
- **读取**：`getChatHistory()` / `getSessionList()` — 按 chat_id + 时间范围查询
- **清理**：RPC `cleanup_chat_messages(90)` — 保留 90 天

---

### 2. message_processing_records - 消息处理记录

**用途**：记录每条消息的处理全生命周期，包含各阶段耗时、AI 调用详情、状态等

**代码位置**：
- Repository: `src/biz/message/repositories/message-processing.repository.ts`
- Entity: `src/biz/message/entities/message-processing.entity.ts`
- Tracking: `src/biz/monitoring/services/tracking/message-tracking.service.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | bigint | sequence | 主键（自增） |
| `message_id` | text | NOT NULL, UNIQUE | 关联 chat_messages |
| `chat_id` | text | NOT NULL | 会话ID |
| `user_id` | text | - | 用户ID |
| `user_name` | text | - | 用户昵称 |
| `manager_name` | text | - | 经理姓名 |
| `received_at` | timestamptz | now() | 消息接收时间 |
| `message_preview` | text | - | 用户消息预览 |
| `reply_preview` | text | - | AI 回复预览 |
| `reply_segments` | integer | 0 | 回复分段数 |
| `status` | text | NOT NULL | 处理状态：success / failure / timeout 等 |
| `error` | text | - | 错误信息 |
| `scenario` | text | - | 场景分类 |
| `total_duration` | integer | - | 总耗时（ms） |
| `queue_duration` | integer | - | 队列等待耗时（ms） |
| `prep_duration` | integer | - | 准备阶段耗时（ms） |
| `ai_start_at` | bigint | - | AI 处理开始时间戳 |
| `ai_end_at` | bigint | - | AI 处理结束时间戳 |
| `ai_duration` | integer | - | AI 处理耗时（ms） |
| `send_duration` | integer | - | 消息发送耗时（ms） |
| `tools` | text[] | - | 使用的工具列表 |
| `token_usage` | integer | - | Token 消耗量 |
| `is_fallback` | boolean | false | 是否降级处理 |
| `fallback_success` | boolean | - | 降级是否成功 |
| `agent_invocation` | jsonb | - | Agent 完整调用记录（request/response/http） |
| `batch_id` | varchar(255) | - | 聚合批次ID |
| `is_primary` | boolean | false | 是否为主消息（调用 Agent 的那条） |
| `created_at` | timestamptz | now() | 记录创建时间 |
| `updated_at` | timestamptz | now() | 记录更新时间（trigger 自动维护） |

**索引**：
- `idx_message_processing_received_at` - received_at DESC
- `idx_message_processing_received_status` - received_at DESC, status
- `idx_message_batch_id` - batch_id（部分索引：batch_id IS NOT NULL）
- `idx_message_batch_primary` - batch_id, is_primary
- `idx_message_is_primary` - is_primary（部分索引：is_primary = true）

**触发器**：`trigger_update_message_processing_records_updated_at` — UPDATE 时自动更新 updated_at

**操作说明**：
- **写入**：`saveMessageProcessingRecord()` — 消息接收时创建，处理完成后更新
- **读取**：`getSlowestMessages()` / `getMessageProcessingRecords()` — Dashboard 查询
- **聚合**：RPC `aggregate_hourly_stats()` — 每小时聚合到 monitoring_hourly_stats
- **清理**：RPC `cleanup_message_processing_records(30)` — 保留 30 天
- **瘦身**：RPC `null_agent_invocation(7)` — 7 天后清空 agent_invocation 字段节省空间

---

### 3. interview_booking_records - 面试预约记录

**用途**：记录 AI 预约面试的统计数据，按品牌/门店/日期聚合

**代码位置**：
- Repository: `src/biz/message/repositories/booking.repository.ts`
- Entity: `src/biz/message/entities/booking.entity.ts`

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

**索引**：
- `idx_interview_booking_date` - date
- `idx_interview_booking_brand` - brand_name（部分索引）
- `idx_interview_booking_user_id` - user_id（部分索引）
- `idx_interview_booking_manager_id` - manager_id（部分索引）
- `idx_interview_booking_date_manager` - date, manager_id（部分索引）

**操作说明**：
- **写入**：`incrementBookingCount()` — 每次预约 +1
- **读取**：`getBookingStats()` / `getTodayBookingCount()` — Dashboard 统计

---

## 用户管理表

### 4. user_activity - 用户活跃度

**用途**：按天记录用户的活跃情况，包含消息数、Token 消耗、组织信息

**代码位置**：
- Repository: `src/biz/user/repositories/user-hosting.repository.ts`
- Entity: `src/biz/user/entities/user-activity.entity.ts`
- Tracking: `src/biz/monitoring/services/tracking/message-tracking.service.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | bigint | sequence | 主键（自增） |
| `chat_id` | text | NOT NULL | 用户唯一标识 |
| `od_id` | text | - | 用户 OD ID |
| `od_name` | text | - | 用户昵称 |
| `group_id` | text | - | 所属小组 ID |
| `group_name` | text | - | 所属小组名称 |
| `activity_date` | date | NOT NULL | 活跃日期（按天聚合） |
| `message_count` | integer | 0 | 当日消息数量 |
| `token_usage` | integer | 0 | 当日 Token 消耗 |
| `first_active_at` | timestamptz | NOT NULL | 当日首次活跃时间 |
| `last_active_at` | timestamptz | NOT NULL | 当日最后活跃时间 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

**唯一约束**：`(chat_id, activity_date)`

**操作说明**：
- **写入**：RPC `upsert_user_activity()` — 消息接收时自动更新（message-tracking 触发）
- **读取**：`findUserProfiles()` — 根据 chat_id 获取 od_name/group_name
- **清理**：RPC `cleanup_user_activity(30)` — 保留 30 天

---

### 5. user_hosting_status - 用户托管状态

**用途**：管理用户的 AI 托管暂停/恢复状态

**代码位置**：
- Repository: `src/biz/user/repositories/user-hosting.repository.ts`
- Entity: `src/biz/user/entities/user-hosting-status.entity.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `user_id` | varchar(100) | NOT NULL | 主键，用户ID |
| `is_paused` | boolean | false | 是否暂停托管 |
| `paused_at` | timestamptz | - | 暂停时间 |
| `resumed_at` | timestamptz | - | 恢复时间 |
| `pause_count` | integer | 0 | 累计暂停次数 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

**操作说明**：
- **暂停**：`upsertPause()` — 设置 is_paused=true，记录 paused_at，pause_count +1
- **恢复**：`updateResume()` — 设置 is_paused=false，记录 resumed_at
- **查询**：`findPausedUserIds()` — 获取所有暂停中的用户

---

## 监控统计表

### 6. monitoring_hourly_stats - 小时级统计

**用途**：预聚合的小时级统计数据，替代直接查询 message_processing_records，供 Dashboard 使用

**代码位置**：
- Repository: `src/biz/monitoring/repositories/monitoring-hourly-stats.repository.ts`
- Entity: `src/biz/monitoring/entities/hourly-stats.entity.ts`
- Maintenance: `src/biz/monitoring/services/analytics/analytics-maintenance.service.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `hour` | timestamptz | NOT NULL, UNIQUE | 统计小时（整点） |
| `message_count` | integer | 0 | 消息总数 |
| `success_count` | integer | 0 | 成功数 |
| `failure_count` | integer | 0 | 失败数 |
| `success_rate` | numeric | 0 | 成功率 |
| `avg_duration` | integer | 0 | 平均耗时（ms） |
| `min_duration` | integer | 0 | 最小耗时 |
| `max_duration` | integer | 0 | 最大耗时 |
| `p50_duration` | integer | 0 | P50 耗时 |
| `p95_duration` | integer | 0 | P95 耗时 |
| `p99_duration` | integer | 0 | P99 耗时 |
| `avg_ai_duration` | integer | 0 | 平均 AI 处理耗时 |
| `avg_send_duration` | integer | 0 | 平均发送耗时 |
| `active_users` | integer | 0 | 活跃用户数 |
| `active_chats` | integer | 0 | 活跃会话数 |
| `total_token_usage` | bigint | 0 | Token 消耗总量 |
| `fallback_count` | integer | 0 | 降级次数 |
| `fallback_success_count` | integer | 0 | 降级成功次数 |
| `scenario_stats` | jsonb | '{}' | 场景分布统计 |
| `tool_stats` | jsonb | '{}' | 工具使用统计 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

**索引**：`idx_hourly_stats_hour` - hour DESC

**操作说明**：
- **写入**：`saveHourlyStats()` / `saveHourlyStatsBatch()` — 定时任务每小时聚合
- **读取**：`getRecentHourlyStats()` / `getHourlyStatsByDateRange()` — Dashboard 趋势图
- **数据来源**：RPC `aggregate_hourly_stats()` 从 message_processing_records 聚合
- **保留**：永久保留（约 8760 行/年 ≈ 5MB）

---

### 7. monitoring_error_logs - 错误日志

**用途**：记录消息处理过程中的系统错误，关联 message_id 便于追踪

**代码位置**：
- Repository: `src/biz/monitoring/repositories/monitoring-error-log.repository.ts`
- Entity: `src/biz/monitoring/entities/error-log.entity.ts`
- Tracking: `src/biz/monitoring/services/tracking/message-tracking.service.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `message_id` | text | NOT NULL | 关联的消息ID |
| `timestamp` | bigint | NOT NULL | 错误发生时间戳（Unix ms） |
| `error` | text | NOT NULL | 错误信息 |
| `alert_type` | text | - | 告警类型分类 |
| `created_at` | timestamptz | now() | - |

**索引**：`idx_error_logs_timestamp` - timestamp DESC

**操作说明**：
- **写入**：`saveErrorLog()` / `saveErrorLogsBatch()` — 异常时自动记录
- **读取**：`getRecentErrors()` / `getErrorLogsSince()` — Dashboard 错误列表
- **清理**：`cleanupErrorLogs()` — 保留 30 天

---

## 配置管理表

### 8. system_config - 系统配置

**用途**：全局系统配置的 KV 存储，支持 JSON 值

**代码位置**：
- Repository: `src/biz/hosting-config/repositories/system-config.repository.ts`
- Entity: `src/biz/hosting-config/entities/system-config.entity.ts`
- 群黑名单: `src/biz/hosting-config/repositories/group-blacklist.repository.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `key` | varchar(100) | NOT NULL | 主键，配置键名 |
| `value` | jsonb | NOT NULL | 配置值（JSON） |
| `description` | text | - | 配置描述 |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | - |

**当前使用的配置键**：
- `group_blacklist` — 群消息黑名单列表（跳过处理但仍记录历史）

**操作说明**：
- **读取**：`getConfigValue(key)` — 按键查询
- **写入**：`setConfigValue(key, value)` — UPSERT 模式

---

### 9. strategy_config - 策略配置

**用途**：AI Agent 行为策略配置，支持多版本管理，仅一个为激活状态

**代码位置**：
- Repository: `src/biz/strategy/repositories/strategy-config.repository.ts`
- Entity: `src/biz/strategy/entities/strategy-config.entity.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `name` | text | '默认策略' | 策略名称 |
| `description` | text | - | 策略描述 |
| `persona` | jsonb | '{}' | 人设配置 |
| `stage_goals` | jsonb | '{}' | 阶段目标 |
| `red_lines` | jsonb | '{}' | 红线规则 |
| `industry_skills` | jsonb | '{}' | 行业技能 |
| `is_active` | boolean | true | 是否激活（唯一索引保证只有一个） |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | trigger 自动维护 |

**唯一索引**：`idx_strategy_config_active` — 部分唯一索引 WHERE is_active = true（保证只有一条激活记录）

**触发器**：`trigger_update_strategy_config_updated_at` — UPDATE 时自动更新 updated_at

**操作说明**：
- **读取**：`findActiveConfig()` — 获取当前激活策略（内存 + Redis 缓存）
- **写入**：`insertConfig()` — 创建新版本
- **更新**：`updateConfigField()` — 修改策略字段

---

## 测试套件表

### 10. test_batches - 测试批次

**用途**：管理场景测试和对话验证的测试批次

**代码位置**：
- Repository: `src/biz/test-suite/repositories/test-batch.repository.ts`
- Entity: `src/biz/test-suite/entities/test-batch.entity.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `name` | varchar(200) | NOT NULL | 批次名称 |
| `source` | varchar(50) | 'manual' | 数据来源 |
| `feishu_app_token` | varchar(100) | - | 飞书应用 Token |
| `feishu_table_id` | varchar(100) | - | 飞书表格ID |
| `total_cases` | integer | 0 | 总用例数 |
| `executed_count` | integer | 0 | 已执行数 |
| `passed_count` | integer | 0 | 通过数 |
| `failed_count` | integer | 0 | 失败数 |
| `pending_review_count` | integer | 0 | 待审核数 |
| `pass_rate` | numeric | - | 通过率 |
| `avg_duration_ms` | integer | - | 平均耗时 |
| `avg_token_usage` | integer | - | 平均 Token |
| `status` | varchar(20) | 'created' | 状态：created/running/reviewing/completed/cancelled |
| `test_type` | varchar(50) | 'scenario' | 类型：scenario（场景测试）/ conversation（对话验证） |
| `created_by` | varchar(100) | - | 创建者 |
| `created_at` | timestamptz | now() | - |
| `completed_at` | timestamptz | - | 完成时间 |

**索引**：
- `idx_test_batches_status` - status
- `idx_test_batches_test_type` - test_type
- `idx_test_batches_created_at` - created_at DESC
- `idx_test_batches_type_created` - test_type, created_at DESC

---

### 11. test_executions - 测试执行记录

**用途**：记录单个测试用例的执行详情，包含输入输出、Agent 调用、相似度评分

**代码位置**：
- Repository: `src/biz/test-suite/repositories/test-execution.repository.ts`
- Entity: `src/biz/test-suite/entities/test-execution.entity.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `batch_id` | uuid | - | 关联 test_batches |
| `case_id` | varchar(100) | - | 用例ID |
| `case_name` | varchar(500) | - | 用例名称 |
| `category` | varchar(100) | - | 分类 |
| `test_input` | jsonb | NOT NULL | 测试输入 |
| `expected_output` | text | - | 期望输出 |
| `agent_request` | jsonb | - | Agent 请求（脱敏后） |
| `agent_response` | jsonb | - | Agent 响应 |
| `actual_output` | text | - | 实际输出 |
| `tool_calls` | jsonb | - | 工具调用记录 |
| `execution_status` | varchar(20) | 'pending' | 执行状态 |
| `duration_ms` | integer | - | 耗时（ms） |
| `token_usage` | jsonb | - | Token 使用详情 |
| `error_message` | text | - | 错误信息 |
| `review_status` | varchar(20) | 'pending' | 审核状态 |
| `review_comment` | text | - | 审核评语 |
| `reviewed_by` | varchar(100) | - | 审核人 |
| `reviewed_at` | timestamptz | - | 审核时间 |
| `failure_reason` | varchar(100) | - | 失败原因分类 |
| `test_scenario` | varchar(100) | - | 测试场景（飞书回写用） |
| `conversation_source_id` | uuid | - | 关联 conversation_test_sources |
| `turn_number` | integer | - | 对话轮次编号（从1开始） |
| `similarity_score` | numeric | - | 语义相似度分数（0-100） |
| `input_message` | text | - | 当前轮次用户输入 |
| `evaluation_reason` | text | - | LLM 评估理由 |
| `created_at` | timestamptz | now() | - |

**索引**：
- `idx_test_executions_batch_id` - batch_id
- `idx_test_executions_execution_status` - execution_status
- `idx_test_executions_review_status` - review_status
- `idx_test_executions_category` - category
- `idx_test_executions_created_at` - created_at DESC
- `idx_test_executions_batch_exec_status` - batch_id, execution_status
- `idx_test_executions_batch_review` - batch_id, review_status
- `idx_test_executions_conversation_source` - conversation_source_id
- `idx_test_executions_conv_turn` - conversation_source_id, turn_number（部分索引）

---

### 12. conversation_test_sources - 对话测试数据源

**用途**：存储对话回归测试的源数据，从飞书导入完整对话内容

**代码位置**：
- Repository: `src/biz/test-suite/repositories/conversation-source.repository.ts`
- Entity: `src/biz/test-suite/entities/conversation-source.entity.ts`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | uuid | gen_random_uuid() | 主键 |
| `batch_id` | uuid | NOT NULL | 关联 test_batches |
| `feishu_record_id` | varchar(100) | NOT NULL | 飞书表格记录ID |
| `conversation_id` | varchar(100) | NOT NULL | 对话唯一标识 |
| `participant_name` | varchar(200) | - | 候选人/用户名称 |
| `full_conversation` | jsonb | NOT NULL | 解析后的完整对话（JSON 数组） |
| `raw_text` | text | - | 原始对话文本（含时间戳） |
| `total_turns` | integer | 0 | 对话总轮数 |
| `avg_similarity_score` | numeric | - | 平均相似度分数（0-100） |
| `min_similarity_score` | numeric | - | 最低相似度分数（0-100） |
| `status` | varchar(50) | 'pending' | 状态：pending/running/completed/failed |
| `created_at` | timestamptz | now() | - |
| `updated_at` | timestamptz | now() | trigger 自动维护 |

**触发器**：`trigger_conversation_sources_updated_at` — UPDATE 时自动更新 updated_at

**索引**：
- `idx_conversation_sources_batch_id` - batch_id
- `idx_conversation_sources_status` - status
- `idx_conversation_sources_batch_status` - batch_id, status

---

## RPC 函数

### 清理类函数

| 函数 | 默认参数 | 说明 |
|------|---------|------|
| `cleanup_chat_messages(retention_days)` | 90 天 | 删除过期聊天消息 |
| `cleanup_message_processing_records(days_to_keep)` | 30 天 | 删除过期处理记录 |
| `cleanup_user_activity(retention_days)` | 30 天 | 删除过期用户活跃记录 |
| `null_agent_invocation(p_days_old)` | 7 天 | 清空旧记录的 agent_invocation 字段 |

### 查询类函数

| 函数 | 说明 |
|------|------|
| `get_distinct_chat_ids()` | 获取所有不同的 chat_id |
| `get_chat_session_list(start, end)` | 获取会话列表（含最新消息、头像等） |
| `get_chat_daily_stats(start, end)` | 按天统计消息数和会话数 |
| `get_chat_summary_stats(start, end)` | 汇总统计（总会话、总消息、活跃会话） |
| `upsert_user_activity(...)` | 更新用户活跃度（UPSERT） |

### Dashboard 函数

| 函数 | 说明 |
|------|------|
| `get_dashboard_overview_stats(start, end)` | 总览统计（消息数、成功率、耗时、Token） |
| `get_dashboard_fallback_stats(start, end)` | 降级统计 |
| `get_dashboard_hourly_trend(start, end)` | 小时趋势 |
| `get_dashboard_minute_trend(start, end, interval)` | 分钟趋势（可配间隔） |
| `get_dashboard_daily_trend(start, end)` | 日趋势 |
| `get_dashboard_scenario_stats(start, end)` | 场景分布统计 |
| `get_dashboard_tool_stats(start, end)` | 工具使用统计 |
| `aggregate_hourly_stats(hour_start, hour_end)` | 聚合小时统计 |

---

## 数据生命周期

```
消息接收
  │
  ├──► chat_messages（保留 90 天）
  │
  ├──► message_processing_records（保留 30 天）
  │       │
  │       ├── 7 天后：agent_invocation 字段置 NULL（节省空间）
  │       │
  │       └── 每小时 ──► monitoring_hourly_stats（永久保留）
  │
  ├──► user_activity（保留 30 天）
  │
  ├──► monitoring_error_logs（保留 30 天，仅异常时写入）
  │
  └──► interview_booking_records（AI 预约面试时写入）
```

**清理调度**：由 `src/biz/monitoring/services/cleanup/` 下的定时任务驱动，通过 Supabase RPC 函数执行批量删除。

**存储估算**（按日均 500 条消息）：
- chat_messages: ~45K 行/90 天 ≈ 50 MB
- message_processing_records: ~15K 行/30 天 ≈ 20 MB
- monitoring_hourly_stats: ~8760 行/年 ≈ 5 MB
- 总计: < 100 MB（远低于 Supabase 免费额度 500 MB）
