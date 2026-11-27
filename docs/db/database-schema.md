# 数据库表设计与使用说明

> Cake Agent Runtime - Supabase (PostgreSQL) 数据库设计文档

**最后更新**：2026-11-26（新加坡生产库 v11.22.1 迁移验收）

**数据库**：Supabase PostgreSQL | **基线迁移**：[supabase/migrations/20260310000000_baseline.sql](../../supabase/migrations/20260310000000_baseline.sql)

**项目环境**：prod `resexopnhpthuoxfwydx` / test `gaovfitvetoojkvtalxy`

---

### 组织归属（测试库已验收，正式发布待执行）

11 月 26 日核对测试库 `public` 的 34 张实体表，其中 15 张有 `tenant_id`。相对 v11.22.1，本期净增 7 张。新增表的字段类型、默认值、主键及其余 27 张表的完整字段和归属见[租户数据表与字段](tenant-schema.md)。

组织登记在 `tenants`，成员的 `tenant_members.organization` 通过外键引用组织。小组与组织、Bot 与小组分别在 `hosting_group_ownership`、`hosting_bot_memberships` 记录生效时间。聊天、流水、调用明细、执行和审查记录、复聊、人工介入、运营事件、日报、用户活动及长期记忆使用同一组织主键。历史记录缺少时间或渠道证据时保留空归属。权限、登记操作与回填条件见[租户、成员和业务账号](../product/organization-members-and-business-accounts.md)。

中心员工的服务端查询以当前成员档案确定组织。消息处理的 `source_occurred_at` 与处理接收时间分别保存。幂等活动事件写入 `user_activity_events`，业务报表按 Bot 所属组织汇总，同一活动重放只计一次。[可回滚的测试库验收](../../tests/supabase/business-tenant-ownership.sql)

## 这次生产切换改了什么

2026 年 11 月 26 日 16:16（北京时间），新加坡生产库完成本批五份迁移，最新版本号为 `20261125100000`。读消息处理详情时，先用主流水定位处理尝试，再按问题读取对应的回合快照或模型 HTTP 请求。[联合迁移与生产验收](../technical/runtime-storage-batch.md) · [v11.22.1 发布记录](https://github.com/huajune/cake-agent-runtime/releases/tag/v11.22.1)

| 生产对象 | 切换后的用途 | 停写时点与迁移结果 |
| --- | --- | --- |
| `message_processing_records` | 每次处理的状态、耗时、工具调用和分步信息 | 96,378 条主流水全部保留。抽核 964 条流水中的 890 次工具调用，名称、参数、结果均一致，步骤位置均有效。 |
| `message_processing_turn_snapshots` | 每次处理至多一份 Cake 回合请求和回合响应 | 6,408 份全部迁入。请求、按新结构保留的响应及原创建时间逐份相符。 |
| `message_processing_invocations` | 每次模型供应商 HTTP 尝试的原始请求和响应 | 切换时为 0 行。旧 SDK 快照没有独立采集的 HTTP 字节，新请求从新版开始记录。 |
| `chat_messages`、`test_executions` | 直接从本表读渠道载荷和测试响应 | 核对还原的 585,055 条渠道载荷，差异为 0。生产当时有 0 条测试响应需要还原。 |
| `agent_action_records` | 本表保存当前采信的结果，`agent_action_evidence` 留存各次回执 | 核对 6,423 条受保护动作，其中 6,410 条从对应回执还原，结果和依据差异为 0。 |

本批已删除 10 个兼容字段，旧写入开关也已退役。更早的 v11.20.0 已删除主流水旧列 `agent_invocation` 和公开表 `strategy_config_changelog`，124 条策略历史留存在私有归档。v11.18.0 至 v11.21.1 的旧字段、开关、还原脚本和当时的抽核结果可查对应版本。[十个字段与迁移顺序](../technical/runtime-storage-batch.md#发布顺序) · [11 月 25 日的表结构](https://github.com/huajune/cake-agent-runtime/blob/390af8d4cabdac536c05c534cb5415ce045728ff/docs/db/database-schema.md)

## 目录

- [总览](#总览)
- [表分类与关系](#表分类与关系)
- [核心业务表](#核心业务表)
  - [chat_messages](#1-chat_messages---聊天消息记录)
  - [message_processing_records](#2-message_processing_records---消息处理记录)
    - [message_processing_turn_snapshots](#message_processing_turn_snapshots---回合快照)
    - [message_processing_invocations](#message_processing_invocations---模型-http-调用)
  - [回复执行与外部动作](#回复执行与外部动作)
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
| 2.1   | `message_processing_turn_snapshots` | 消息 | 随主流水同事务写入 | 回合详情、完整请求 | 默认 90 天，主流水删除时级联 |
| 2.2   | `message_processing_invocations` | 消息 | 随主流水同事务写入 | 按处理 ID 列举 HTTP 调用，按调用 ID 读原文 | 默认 90 天，主流水删除时级联 |
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
│  chat_messages <── request.sourceMessageIds[]（渠道输入）       │
│                       message_processing_records                │
│                            │        (流水 message_id)            │
│                            ├─── message_processing_turn_snapshots（0 或 1）
│                            ├─── message_processing_invocations（0 到多次 HTTP）
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
| `message_id`       | text        | NOT NULL, UNIQUE  | 渠道消息 ID，用于原消息去重                                       |
| `role`             | text        | NOT NULL          | 消息角色：`user` / `assistant`                             |
| `content`          | text        | NOT NULL          | 消息内容                                                   |
| `timestamp`        | timestamptz | NOT NULL          | 消息发送时间                                               |
| `candidate_name`   | text        | -                 | 候选人微信昵称                                             |
| `manager_name`     | text        | -                 | 招募经理姓名                                               |
| `is_room`          | boolean     | false             | 是否群聊                                                   |
| `message_type`     | text        | 'TEXT'            | TEXT/IMAGE/VOICE/FILE/VIDEO/LINK                           |
| `source`           | text        | 'MOBILE_PUSH'     | MOBILE_PUSH/API_SEND/AI_REPLY                              |
| `im_bot_id`        | text        | -                 | 托管账号的系统 wxid                                        |
| `im_contact_id`    | text        | -                 | 联系人系统ID                                               |
| `contact_type`     | text        | 'UNKNOWN'         | UNKNOWN/PERSONAL_WECHAT/OFFICIAL_ACCOUNT/ENTERPRISE_WECHAT |
| `is_self`          | boolean     | false             | 是否托管账号自己发送                                       |
| `payload`          | jsonb       | -                 | 渠道上报或发送时保存的完整载荷，按原键读取 |
| `avatar`           | text        | -                 | 用户头像 URL                                               |
| `external_user_id` | text        | -                 | 渠道外部联系人 ID，取自回调或渠道历史中的 externalUserId                                             |
| `created_at`       | timestamptz | now()             | 记录创建时间                                               |
| `visual_facts` | jsonb | — | 从图片提取的事实，与图片说明一起更新 |
| `history_only_reason` | text | — | 消息仅入历史的原因 |

**索引**：

- `idx_chat_messages_timestamp` - timestamp DESC
- `idx_chat_messages_chat_id` - (chat_id, timestamp DESC)

**操作说明**：

- **写入**：`saveChatMessage()` / `saveChatMessagesBatch()` — upsert by message_id
- **读取**：`getChatHistoryDetail()` 按会话和时间顺序读取消息及 `payload`。`getChatSessionList()` 读取会话列表。
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
| `message_id`       | text         | NOT NULL, UNIQUE | 处理流水 ID，同一轮可合并多条渠道输入。API 字段为 messageId                                                                               |
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
| `ai_duration`      | integer      | -                | AI 处理耗时（ms）                                                                                |
| `send_duration`    | integer      | -                | 消息发送耗时（ms）                                                                               |
| `tool_calls`       | jsonb        | -                | 完整工具调用，保存名称、参数、结果、状态和耗时。可附内部判断 `decisions` 和零起始的 `stepPosition`                                  |
| `agent_steps`      | jsonb        | -                | 每步自身的文本、推理、用量和耗时。详情按 `stepPosition` 从 `tool_calls` 取出该步调用                  |
| `anomaly_flags`    | text[]       | -                | 异常标记：tool_loop/tool_empty_result/tool_narrow_result/tool_chain_overlong/no_tool_called      |
| `memory_snapshot`  | jsonb        | -                | 运行时记忆快照 `{ currentStage, presentedJobIds, recommendedJobIds, sessionFacts, profileKeys }` |
| `token_usage`      | integer      | -                | Token 消耗量                                                                                     |
| `is_fallback`      | boolean      | false            | 是否降级处理                                                                                     |
| `fallback_success` | boolean      | -                | 降级是否成功                                                                                     |
| `batch_id`         | varchar(255) | -                | 聚合批次ID                                                                                       |
| `created_at`       | timestamptz  | now()            | -                                                                                                |
| `updated_at`       | timestamptz  | now()            | trigger 自动维护                                                                                 |
| `bot_im_id` | text | — | 处理本轮的托管账号系统标识，用于 BOT 筛选和中心授权范围 |
| `source_occurred_at` | timestamptz | — | 原始输入的业务时间，普通回复续发沿用这个时间核定组织。 |
| `tenant_id` | text | — | 由原 Bot 和业务时间确定，证据不足时为空。 |
| `ttft_ms` | integer | — | 模型首段文本等待时间，单位毫秒 |
| `guardrail_input` / `guardrail_output` | jsonb | — | 入站和出站守卫的审查摘要 |
| `post_processing_status` | jsonb | — | 回合结束后的处理状态 |

> `is_primary` 字段已于 20260414 迁移中移除，单条消息均视为自身主记录；`tools text[]` 已于 20260417 迁移中被 `tool_calls jsonb` 取代。

按 `message_id` 唯一定位。生产索引支持按接收时间、状态、会话、用户、姓名和中心账号范围查询。更新触发器维护 `updated_at`。更正聊天、接收时间或批次会清除原回合快照和原 HTTP 调用，更正工具或步骤也会清除旧回合快照。状态结算保留已采集的正文。[写入和更正触发器](../../supabase/migrations/20261125080100_processing_snapshot_storage.sql)

`saveMessageProcessingRecord()` 调用 `save_processing_snapshot` 写入主流水及当时已采集的两类快照。可续发普通回复在保存已审核分段时提交三表，结算时根据受理回执更新主流水结果。列表与最慢榜仅读轻量字段。总部详情按需加载上下文、提示词和模型原文，中心按授权 BOT 查询摘要。`aggregate_hourly_stats`、`aggregate_daily_stats` 从主流水聚合。[流水仓储](../../src/biz/message/repositories/message-processing.repository.ts) · [分段结算](../../supabase/migrations/20261125100000_ordinary_reply_segment_io.sql)

#### message_processing_turn_snapshots - 回合快照

一个处理回合至多一行。总部打开详情时只取聊天上下文和回合响应，点开完整 Agent 请求时才读取提示词、工具定义等。要查合并前的原消息，用完整请求中的 `sourceMessageIds` 在同一会话的 `chat_messages.message_id` 查找。[读取接口](../../src/biz/message/message.controller.ts)

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `message_id` | text | 主键，同时外键关联主流水。 |
| `created_at` | timestamptz | 首次保存的时间，历史迁入时保留。 |
| `request` | jsonb | Cake 本轮准备的 SDK 请求、上下文和渠道输入标识。 |
| `response` | jsonb | 回合级响应和投递摘要。工具调用、步骤、记忆分别由主流水对应字段提供。 |
| `tenant_id` | text | 继承主流水的组织，主流水补齐归属时同步。 |

#### message_processing_invocations - 模型 HTTP 调用

一轮可能重试、换供应商，产生多次 HTTP 尝试。总部先按 `message_id` 查清单，展开其中一次时再取原始字节。传输中断时保留当时已采集的字节。生产已开启行级安全，普通登录和匿名角色均无直接读取原文的权限。[采集代码](../../src/observability/context/model-invocations.ts) · [原文查询](../../src/biz/message/repositories/message-processing.repository.ts)

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `message_id` | text | 主流水外键。与 `id` 组成主键。 |
| `id` | uuid | 一次 HTTP 尝试的标识。 |
| `started_at` | timestamptz | 请求开始时间，也是本表计算保留期的起点。 |
| `provider` | text | 该次请求使用的供应商。 |
| `http_status` | smallint | 收到的 HTTP 状态码。未收到响应时可为空。 |
| `complete` | boolean | 响应是否已完整采集。 |
| `request_body` / `response_body` | bytea | 捕获到的请求、响应原始字节，可分别为空。 |
| `tenant_id` | text | 继承主流水的组织，补齐归属时保留已采集的字节。 |

每天北京时间 03:00 清理。主流水按 `received_at`、回合快照按 `created_at`、HTTP 尝试按 `started_at` 计算期限。两类快照默认跟随主流水的 90 天，在同一批 500 行额度内先清理到期回合，再清理到期 HTTP 调用。删除主流水也会级联删除两类快照。[清理任务](../../src/biz/monitoring/services/cleanup/data-cleanup.service.ts) · [清理函数](../../supabase/migrations/20261125080100_processing_snapshot_storage.sql)

### 回复执行与外部动作

Redis 保存待处理输入、Bull 任务和会话锁。下列关系表记录了断电重启后仍需知道的事实，以及供运营回查的事件。

| 表 | 一行的用途 | 写入和读取 |
| --- | --- | --- |
| `agent_reply_inputs`（5 列） | 一条渠道输入归属哪个回复回合。合并两条输入会有两行。 | 登记回合的事务写入。后续按企业、账号、聊天及 `message_id` 找回 `logical_turn_id`。[回合函数](../../supabase/migrations/20261125080000_resume_ordinary_replies.sql) |
| `agent_reply_turns`（22 列） | 一轮普通回复的输入、已审核分段、执行进度和已受理的结果。 | 渠道保存进度。恢复服务按 `next_check_at` 查到期回合，核对原分段回执后决定续发或收尾。普通回复的续发窗口为 5 分钟。[回合仓储](../../src/biz/reply-execution/reply-turns.repository.ts) · [恢复服务](../../src/channels/wecom/message/delivery/reply-recovery.service.ts) |
| `agent_action_records`（28 列） | 企业内一个外部动作的当前状态。`status`、`result`、`evidence` 保存当前采信的结论。 | 执行器登记、领取派发权，受理或失败后更新结果。恢复和预约读取采信结果及已有工单号。[动作仓储](../../src/biz/action-execution/action-records.repository.ts) |
| `agent_action_evidence`（6 列） | 某一派发尝试的一份回执，`completion` 保存凭证内容。 | 收到回执时按企业、动作、尝试和摘要去重。核实时可查同一尝试收到的多份不同回执。[回执写入](../../supabase/migrations/20261125081000_retire_body_storage_markers.sql) |
| `agent_action_reviews`（8 列） | 一次人工裁定的操作者、依据、结论和时间。 | 受控 `review_agent_action` 函数写入，核查动作时读取历史裁定。[人工核实](../technical/runtime-action-records.md#人工核实) |
| `agent_execution_events`（10 列） | 一次执行中值得排查的事件，用 `trace_id` 回看时间线。 | 应用按事件类型写入。`tool_call` 对有副作用、报错、空结果、窄结果或耗时至少 3 秒的调用留档。工具总数取主流水。[记录条件](../../src/observability/execution-event-policy.ts) · [事件仓储](../../src/biz/monitoring/repositories/agent-execution-event.repository.ts) |

<details>
<summary>查看这六张表的全部生产字段</summary>

| 表 | 身份与关联 | 执行、结果或依据 | 时间与清理 |
| --- | --- | --- | --- |
| `agent_reply_inputs` | `corp_id`、`account_id`、`chat_id`、`message_id`、`logical_turn_id` | — | — |
| `agent_reply_turns` | `corp_id`、`account_id`、`chat_id`、`logical_turn_id`、`input_ids` | `mode`、`status`、`owner`、`fence`、`recovery`、`projection_status`、`delivery_policy`、`delivery_result`、`review_required`、`review_reason`、`recovery_attempts` | `input_occurred_at`、`generation_until`、`next_check_at`、`review_notified_at`、`created_at`、`updated_at` |
| `agent_action_records` | `corp_id`、`action_id`、`previous_action_id`、`account_id`、`chat_id`、`logical_turn_id`、`kind`、`resource_hash`、`payload_hash`、`request_id`、`dispatch_attempt_id` | `intent`、`mode`、`status`、`local_sync`、`owner`、`fence`、`attempts`、`result`、`evidence`、`retryable`、`review_required` | `input_occurred_at`、`next_check_at`、`recovery_deadline`、`retention_redacted`、`created_at`、`updated_at` |
| `agent_action_evidence` | `corp_id`、`action_id`、`attempt_id`、`evidence_hash` | `completion` | `created_at` |
| `agent_action_reviews` | `id`、`corp_id`、`action_id`、`operator_id` | `basis`、`conclusion`、`completion` | `created_at` |
| `agent_execution_events` | `id`、`trace_id`、`user_id`、`corp_id`、`chat_id` | `event_type`、`scenario`、`caller_kind`、`payload` | `created_at` |

</details>

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

按组织、企微企业、候选人与托管账号存储长期关系档。组织隔离版的唯一键为 `(tenant_id, corp_id, user_id, bot_user_id)`。
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

- 组织迁移前的关系行使用 `(corp_id, user_id, bot_user_id)` 去重。
- 迁移后组合唯一键采用 `NULLS NOT DISTINCT`。每个组织内的同一企业和候选人最多保留一行 `bot_user_id IS NULL` 的预约指针，长期召回使用有稳定托管账号的关系行。

**触发器**：`trigger_agent_long_term_memories_updated_at`

**RPC**：

- `upsert_long_term_profile_facts`：写 profile patch，并可整组替换最新 job intent；置信度 rank 防止降级覆盖
- `append_long_term_summary_atomic`：原子追加单层摘要数组，最多保留 20 段
- `mark_long_term_settled_boundary`：兼容名称；原子更新摘要与独立 `consolidation_watermarks`

长期档案缓存时长为两小时。已经确认组织的运行时请求给长期档案、会话和预约快照的 Redis 键加上 `tenant:{tenantId}:` 前缀。

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

组织隔离版按 `(tenant_id, chat_id, activity_date)` 唯一。原有按会话和日期累计的数据须基于事件证据核实归属。

**操作说明**：

- **写入**　消息接收和 Token 用量分别以事件键调用 `record_user_activity`，首次写入事件才累计活动。
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

2026-11-24 逐键核对了正式库的 11 项和测试库的 7 项。下表记录各项的实际用途。

| 配置键 | 用途 | 已配置的环境 |
| --- | --- | --- |
| `ai_reply_enabled` | 平台 AI 回复总开关 | 正式、测试 |
| `group_blacklist` | 关闭 AI 托管的小组名单 | 正式、测试 |
| `message_merge_enabled` | 连续消息聚合开关 | 正式、测试 |
| `agent_reply_config` | 回复模型、分段与节奏、监控阈值 | 正式、测试 |
| `hosting_member_config` | 按 Bot 读取海绵凭据、飞书接收人、企微昵称和人设，另支持运营接收人和任务派单 | 正式、测试 |
| `group_task_config` | 群任务通知开关和试运行模式 | 正式、测试 |
| `conversion_bot_identity_aliases` | 转化分析归并历史 Bot 身份 | 正式、测试 |
| `feishu_task_config` | 人工介入时创建飞书任务的开关 | 正式 |
| `oob_reconcile_scan_config` | 带外工单对账扫描开关及每次扫描上限 | 正式 |
| `runtime_storage_writes` | 数据库触发器按项控制消息、执行步骤、工具回复和评测内容的写入 | 正式 |
| `system_config` | 消息处理 Worker 的并发数 `workerConcurrency` | 正式 |

`agent_reply_config` 有三种需要区分的情况。

- 测试库保留了 `reviewModelId`、`outputGuardrailLlmEnabled`、`outputGuardrailSemanticShadowEnabled`。当前前后端均无读取入口，正式库没有这三个字段，可从测试配置清理。
- 两个库都保存了 `alertThrottleWindowMs` 和 `alertThrottleMaxCount`。配置接口接受这两个值，飞书告警发送端目前按去重键限流，同一键 5 分钟内最多发送 3 次。要让这两项可调，需要接通发送端。[告警节流实现](../../src/notification/services/alert-notifier.service.ts)
- `typingDelayPerCharMs` 是旧字段，消息运行时仍有兼容读取逻辑。[回复速度的计算](../../src/channels/wecom/message/runtime/message-runtime-config.service.ts)

成员开户使用 `tenant_members`。托管凭据和通知仍从 `hosting_member_config` 读取，迁移范围见[组织、成员和业务账号](../product/organization-members-and-business-accounts.md#现有配置如何迁入)。

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

单条测试用例的执行详情包含输入、输出、Agent 请求和相似度分。创建、查询和导出直接读写 `test_executions.agent_response`。

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
| `delete_expired_agent_invocations(p_days_old, p_limit)`      | 90 天，500 条 | 先按 `created_at` 清理到期回合快照，再用剩余额度按 `started_at` 清理到期 HTTP 调用 |

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
  │       ├──► message_processing_turn_snapshots（每轮至多一份，默认 90 天）
  │       ├──► message_processing_invocations（每次 HTTP 尝试一行，默认 90 天）
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
