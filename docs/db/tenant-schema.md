# 租户数据表与字段

2026-11-26，按 Supabase 测试库系统目录核对。蛋糕的 `public` 有 34 张实体表，15 张有名为 `tenant_id` 的物理列，19 张采用其他归属方式或尚未落列。此处统计表结构，历史行的归属完整率须另按业务时间核对。Supabase 服务自身的 Auth、Storage、系统表以及 SQL 视图各自独立于这一口径。上期移出的策略历史保存在 `strategy_archive.strategy_config_changelog`，属于平台归档。[归档表的 7 个字段](database-schema.md#13-strategy_config_changelog---策略变更日志)

## 本期新增的 7 张实体表

账号与托管登记占 6 张，另有 1 张用户活动事件表。迁移早期曾创建的 `hosting_bot_handovers` 已从测试库退役。成员表的原地更名沿用原记录和主键，只计一张。

| 表 | 字段数 | 作用和组织归属 |
| --- | ---: | --- |
| `tenants` | 5 | 组织。组织主键，一条记录代表一家租户。 |
| `tenant_members` | 10 | 租户成员。organization 外键指向 tenants.id。可先建档，开通后 user_id 关联 auth.users.id。 |
| `hosting_group_ownership` | 4 | 小组的组织归属。在事件时间取同一连接、小组最近一次已生效的登记。 |
| `hosting_bot_memberships` | 4 | Bot 的小组归属。按连接、Bot、事件时间找小组，再用同一时刻查小组的组织。 |
| `hosting_directory_scans` | 5 | Stride 目录快照。一个连接保留最近一次完整目录，可涵盖多个租户，按已登记归属筛选后展示。 |
| `hosting_owner_changes` | 8 | 小组负责人变更记录。按连接、小组、变更生效时间可追溯当时的组织。 |
| `user_activity_events` | 7 | 用户活动事件。记录一笔消息量或用量变动，按 event_key 去重并保留原始事件归属。 |

### 逐字段说明

类型采用 PostgreSQL 名称。必填表示数据库禁止 NULL。

#### tenants

组织，主键为 `(id)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `id` | `text` | 是 | `(gen_random_uuid())::text` | 组织 ID |
| `name` | `text` | 是 | — | 后台显示名 |
| `created_at` | `timestamptz` | 是 | `now()` | 登记时间 |
| `reads_all_tenants` | `boolean` | 是 | `false` | 是否获跨租户业务查看权，总部为真 |
| `feishu_route` | `text` | 否 | — | 飞书通知路由，未接入时为空 |

#### tenant_members

租户成员，主键为 `(id)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `phone` | `text` | 否 | — | 员工登录手机号，使用国际格式 |
| `user_id` | `uuid` | 否 | — | Supabase Auth 用户 ID，待开通时为空 |
| `name` | `text` | 是 | — | 成员姓名 |
| `organization` | `text` | 是 | — | 所属组织 ID |
| `disabled` | `boolean` | 是 | `false` | 停用标记 |
| `hosting_group_id` | `text` | 否 | — | 负责的 Stride 小组 ID，可稍后绑定 |
| `id` | `uuid` | 是 | `gen_random_uuid()` | 稳定成员 ID |
| `feishu_open_id` | `text` | 否 | — | 可选的飞书人员标识 |
| `login_name` | `text` | 否 | — | 平台专用账号名 cakeadmin，员工按手机号登录 |
| `tenant_role` | `text` | 否 | `'group_leader'::text` | 员工为 tenant_admin 或 group_leader，平台专用账号为空 |

#### hosting_group_ownership

小组的组织归属，主键为 `(connection_id, group_id, effective_from)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `connection_id` | `text` | 是 | — | 渠道连接 ID |
| `group_id` | `text` | 是 | — | 外部托管小组 ID |
| `effective_from` | `timestamptz` | 是 | — | 本次归属生效时间 |
| `tenant_id` | `text` | 否 | — | 归属组织，空值显式结束绑定 |

#### hosting_bot_memberships

Bot 的小组归属，主键为 `(connection_id, bot_im_id, effective_from)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `connection_id` | `text` | 是 | — | 渠道连接 ID |
| `bot_im_id` | `text` | 是 | — | 托管 Bot 标识 |
| `effective_from` | `timestamptz` | 是 | — | 本次入组或退出的生效时间 |
| `group_id` | `text` | 否 | — | 所属托管小组，空值表示退出 |

#### hosting_directory_scans

Stride 目录快照，主键为 `(connection_id)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `connection_id` | `text` | 是 | — | 渠道连接 ID |
| `started_at` | `timestamptz` | 是 | — | 同步开始时间 |
| `checked_at` | `timestamptz` | 是 | — | 目录核对时间 |
| `groups` | `jsonb` | 是 | — | 该连接的小组清单 |
| `bots` | `jsonb` | 是 | — | Bot 清单及各自小组 |

#### hosting_owner_changes

小组负责人变更记录，主键为 `(id)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `id` | `bigint` | 是 | `GENERATED ALWAYS AS IDENTITY` | 审计记录 ID |
| `connection_id` | `text` | 是 | — | 渠道连接 ID |
| `group_id` | `text` | 是 | — | 变更的小组 |
| `previous_member` | `uuid` | 否 | — | 前任成员 ID |
| `member_id` | `uuid` | 是 | — | 本次绑定的成员 ID |
| `member_previous_group` | `text` | 否 | — | 新负责人先前的小组 ID |
| `actor_id` | `uuid` | 是 | — | 办理人的 Auth 用户 ID |
| `effective_at` | `timestamptz` | 是 | `clock_timestamp()` | 变更生效时间 |

#### user_activity_events

用户活动事件，主键为 `(event_key)`。

| 字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `event_key` | `text` | 是 | — | 幂等事件键 |
| `chat_id` | `text` | 是 | — | 候选人会话 |
| `bot_im_id` | `text` | 否 | — | 托管 Bot |
| `occurred_at` | `timestamptz` | 是 | — | 原业务发生时间 |
| `tenant_id` | `text` | 否 | — | 事件所属组织，可待核实 |
| `message_count` | `integer` | 是 | — | 本事件新增消息数 |
| `token_usage` | `integer` | 是 | — | 本事件增加的模型 token 数 |

手机号、已绑定的 Auth 用户、非空负责小组、飞书人员标识和专用登录名在成员表分别唯一。一位组长可以先开户、后绑组。成员表只持有登录身份的外键，密码由 Supabase Auth 管理。

## 其余 27 张表的归属和完整字段

回复回合、业务动作和候选人黑名单是需要优先审视的三类业务数据。动作回执、人工裁定以及回合输入已有指向父记录的外键。若以后开放这些明细给租户，先确认父记录归属及查询入口。跨租户的监控汇总、平台策略和评测资产继续按其实际用途解释。

| 表 | 字段数 | 当前归属与缺口 |
| --- | ---: | --- |
| `agent_action_evidence` | 6 | 随动作。用 (corp_id, action_id) 外键关联动作主表。 |
| `agent_action_records` | 28 | 待完善。保存 account_id、chat_id、input_occurred_at。预约动作恢复时按原 Bot 和时间解组织，动作主表尚无独立租户列。 |
| `agent_action_reviews` | 8 | 随动作。用 (corp_id, action_id) 外键关联原动作。 |
| `agent_execution_events` | 11 | 有 tenant_id。依消息流水的 trace_id 继承。 |
| `agent_long_term_memories` | 14 | 有 tenant_id。关系记忆按租户、企业、候选人和 Bot 区分，预约指针保存在 bot_user_id 为空的候选人行。 |
| `agent_reply_inputs` | 5 | 随回复回合。外键为 (corp_id, logical_turn_id)，也保留原消息 ID。回合主表尚无租户列。 |
| `agent_reply_turns` | 22 | 待完善。保存账号、会话、输入及业务时间，要做租户独立查询需核实原始消息归属。 |
| `candidate_blacklist` | 17 | 现行黑名单按 target_id 去重，命中策略共用。记录含 Bot/会话线索，尚不支持同一对象在不同租户独立封禁。 |
| `chat_messages` | 25 | 有 tenant_id。按原消息时间、渠道连接和 Bot/小组的有效登记归属。 |
| `daily_ops_report` | 25 | 有 tenant_id。日报投影的唯一维度含组织、企业、日期和 Bot。 |
| `guardrail_review_records` | 29 | 有 tenant_id。依消息流水的 trace_id 继承。 |
| `handoff_events` | 19 | 有 tenant_id。按原 Bot、介入时间归属。 |
| `message_processing_invocations` | 9 | 有 tenant_id。逐次模型 HTTP 请求按 message_id 继承主流水归属。 |
| `message_processing_records` | 36 | 有 tenant_id。按 Bot 与 source_occurred_at 确认组织，随后供子记录继承。 |
| `message_processing_turn_snapshots` | 5 | 有 tenant_id。回合请求和响应按 message_id 继承主流水归属。 |
| `monitoring_daily_stats` | 19 | 全平台日聚合。一行可计入多个租户的请求。 |
| `monitoring_error_logs` | 15 | 平台错误与告警。部分行有 message_id 可回查，组件级故障没有单一业务租户。 |
| `monitoring_hourly_stats` | 27 | 全平台小时聚合。一行可计入多个租户的请求。 |
| `ops_events` | 15 | 有 tenant_id。按原 Bot、occurred_at 归属。 |
| `reengagement_touch_records` | 29 | 有 tenant_id。按原 Bot、触达锚点时间归属。 |
| `strategy_config` | 15 | 平台策略版本，供运行时共用。 |
| `system_config` | 5 | 按 key 存配置，可含跨租户的托管配置 JSON，服务读取时按具体用途拆解。 |
| `test_batches` | 17 | 平台评测批次，测试套件按 batch 管理。 |
| `test_conversation_snapshots` | 17 | 平台评测资产，关联评测批次，引用业务样本时需要按样本来源控制使用。 |
| `test_executions` | 33 | 平台评测执行，关联测试批次，可关联对话快照。 |
| `user_activity` | 14 | 有 tenant_id。按会话保留活动汇总，跨事件统计使用带归属的事件与聊天明细。 |
| `user_hosting_status` | 14 | 有 tenant_id。租户人工暂停写本组织，user_id 仍是会话级唯一键，混合归属会话拒绝租户操作。 |

### 其余表的字段名与类型

以下按数据库原列序列出。

**agent_action_evidence（6 列）**

`corp_id text`、`action_id text`、`attempt_id text`、`evidence_hash text`、`completion jsonb`、`created_at timestamptz`。

**agent_action_records（28 列）**

`corp_id text`、`action_id text`、`previous_action_id text`、`account_id text`、`chat_id text`、`logical_turn_id text`、`kind text`、`resource_hash text`、`payload_hash text`、`request_id text`、`intent jsonb`、`input_occurred_at timestamptz`、`retention_redacted boolean`、`mode text`、`status text`、`local_sync text`、`owner text`、`dispatch_attempt_id text`、`fence integer`、`attempts integer`、`result jsonb`、`evidence jsonb`、`retryable boolean`、`next_check_at timestamptz`、`recovery_deadline timestamptz`、`review_required boolean`、`created_at timestamptz`、`updated_at timestamptz`。

**agent_action_reviews（8 列）**

`id bigint`、`corp_id text`、`action_id text`、`operator_id text`、`basis text`、`conclusion text`、`completion jsonb`、`created_at timestamptz`。

**agent_execution_events（11 列）**

`id bigint`、`trace_id text`、`event_type text`、`user_id text`、`corp_id text`、`chat_id text`、`scenario text`、`caller_kind text`、`payload jsonb`、`created_at timestamptz`、`tenant_id text`。

**agent_long_term_memories（14 列）**

`id uuid`、`corp_id text`、`user_id text`、`semantic_profile jsonb`、`episodic_session_summaries jsonb`、`message_metadata jsonb`、`created_at timestamptz`、`updated_at timestamptz`、`active_booking jsonb`、`semantic_job_intent jsonb`、`bot_user_id text`、`consolidation_watermarks jsonb`、`active_booking_versions jsonb`、`tenant_id text`。

**agent_reply_inputs（5 列）**

`corp_id text`、`account_id text`、`chat_id text`、`message_id text`、`logical_turn_id text`。

**agent_reply_turns（22 列）**

`corp_id text`、`account_id text`、`chat_id text`、`logical_turn_id text`、`input_ids text[]`、`input_occurred_at timestamptz`、`mode text`、`status text`、`owner text`、`fence integer`、`generation_until timestamptz`、`recovery jsonb`、`projection_status text`、`review_required boolean`、`next_check_at timestamptz`、`created_at timestamptz`、`updated_at timestamptz`、`delivery_policy text`、`delivery_result jsonb`、`review_reason text`、`review_notified_at timestamptz`、`recovery_attempts integer`。

**candidate_blacklist（17 列）**

`id uuid`、`target_id text`、`reason text`、`operator text`、`chat_id text`、`im_contact_id text`、`contact_name text`、`source text`、`hit_count integer`、`last_hit_at timestamptz`、`last_hit_chat_id text`、`last_hit_bot_id text`、`last_hit_message_id text`、`created_at timestamptz`、`updated_at timestamptz`、`im_bot_id text`、`bot_name text`。

**chat_messages（25 列）**

`id uuid`、`chat_id text`、`message_id text`、`role text`、`content text`、`timestamp timestamptz`、`candidate_name text`、`manager_name text`、`created_at timestamptz`、`is_room boolean`、`message_type text`、`source text`、`im_bot_id text`、`im_contact_id text`、`contact_type text`、`is_self boolean`、`payload jsonb`、`avatar text`、`external_user_id text`、`visual_facts jsonb`、`history_only_reason text`、`hosting_connection_id text`、`hosting_group_id text`、`tenant_id text`、`hosting_observed_group_id text`。

**daily_ops_report（25 列）**

`id bigint`、`corp_id text`、`report_date date`、`bot_im_id text`、`manager_name text`、`group_name text`、`friends_added_count integer`、`agent_opening_sent_count integer`、`break_ice_count integer`、`candidate_message_count integer`、`agent_reply_count integer`、`job_recommend_count integer`、`precheck_pass_count integer`、`booking_success_count integer`、`booking_fail_count integer`、`group_invite_count integer`、`handoff_count integer`、`interview_pass_count integer`、`candidate_summary text`、`booking_brands text[]`、`created_at timestamptz`、`updated_at timestamptz`、`booking_cancel_count integer`、`interview_modified_count integer`、`tenant_id text`。

**guardrail_review_records（29 列）**

`id bigint`、`created_at timestamptz`、`trace_id text`、`chat_id text`、`user_id text`、`bot_im_id text`、`bot_user_name text`、`contact_name text`、`user_message text`、`first_reply text`、`first_decision text`、`first_risk_level text`、`first_rule_ids text[]`、`first_blocked_rule_ids text[]`、`first_violations jsonb`、`first_feedback text`、`repair_mode text`、`repaired boolean`、`revised_reply text`、`revised_decision text`、`revised_risk_level text`、`revised_rule_ids text[]`、`revised_blocked_rule_ids text[]`、`revised_violations jsonb`、`committed_side_effects text`、`final_decision text`、`reason_code text`、`semantic_reviews jsonb`、`tenant_id text`。

**handoff_events（19 列）**

`id bigint`、`chat_id text`、`corp_id text`、`user_id text`、`reason_code text`、`reason text`、`action_advice text`、`stage text`、`bot_im_id text`、`work_order_id bigint`、`idempotency_key text`、`created_at timestamptz`、`missing_job_info jsonb`、`job_id bigint`、`sequence_no integer`、`outcome text`、`resolved_at timestamptz`、`recorded_at timestamptz`、`tenant_id text`。

**message_processing_invocations（9 列）**

`message_id text`、`id uuid`、`started_at timestamptz`、`provider text`、`http_status smallint`、`complete boolean`、`request_body bytea`、`response_body bytea`、`tenant_id text`。

**message_processing_records（36 列）**

`id bigint`、`message_id text`、`chat_id text`、`user_id text`、`user_name text`、`manager_name text`、`received_at timestamptz`、`message_preview text`、`reply_preview text`、`reply_segments integer`、`status text`、`error text`、`scenario text`、`total_duration integer`、`queue_duration integer`、`prep_duration integer`、`ai_duration integer`、`send_duration integer`、`token_usage integer`、`is_fallback boolean`、`fallback_success boolean`、`created_at timestamptz`、`updated_at timestamptz`、`batch_id character varying(255)`、`alert_type text`、`tool_calls jsonb`、`agent_steps jsonb`、`anomaly_flags text[]`、`memory_snapshot jsonb`、`post_processing_status jsonb`、`bot_im_id text`、`ttft_ms integer`、`guardrail_input jsonb`、`guardrail_output jsonb`、`source_occurred_at timestamptz`、`tenant_id text`。

**message_processing_turn_snapshots（5 列）**

`message_id text`、`created_at timestamptz`、`tenant_id text`、`request jsonb`、`response jsonb`。

**monitoring_daily_stats（19 列）**

`id uuid`、`stat_date date`、`message_count integer`、`success_count integer`、`failure_count integer`、`timeout_count integer`、`success_rate numeric`、`avg_duration integer`、`total_token_usage bigint`、`unique_users integer`、`unique_chats integer`、`fallback_count integer`、`fallback_success_count integer`、`fallback_affected_users integer`、`avg_queue_duration integer`、`avg_prep_duration integer`、`error_type_stats jsonb`、`created_at timestamptz`、`updated_at timestamptz`。

**monitoring_error_logs（15 列）**

`id uuid`、`message_id text`、`error text`、`alert_type text`、`created_at timestamptz`、`timestamp timestamptz`、`subsystem text`、`component text`、`action text`、`severity text`、`summary text`、`code text`、`dedupe_key text`、`throttled boolean`、`delivered boolean`。

**monitoring_hourly_stats（27 列）**

`id uuid`、`hour timestamptz`、`message_count integer`、`success_count integer`、`failure_count integer`、`success_rate numeric`、`avg_duration integer`、`min_duration integer`、`max_duration integer`、`p50_duration integer`、`p95_duration integer`、`p99_duration integer`、`avg_ai_duration integer`、`avg_send_duration integer`、`active_users integer`、`active_chats integer`、`created_at timestamptz`、`updated_at timestamptz`、`total_token_usage bigint`、`fallback_count integer`、`fallback_success_count integer`、`scenario_stats jsonb`、`tool_stats jsonb`、`timeout_count integer`、`avg_queue_duration integer`、`avg_prep_duration integer`、`error_type_stats jsonb`。

**ops_events（15 列）**

`id bigint`、`corp_id text`、`event_name text`、`occurred_at timestamptz`、`report_date date`、`bot_im_id text`、`manager_name text`、`group_name text`、`source_channel text`、`user_id text`、`chat_id text`、`idempotency_key text`、`payload jsonb`、`created_at timestamptz`、`tenant_id text`。

**reengagement_touch_records（29 列）**

`id bigint`、`created_at timestamptz`、`updated_at timestamptz`、`touch_key text`、`session_id text`、`user_id text`、`corp_id text`、`scenario_code text`、`anchor_event_id text`、`anchor_at timestamptz`、`job_id text`、`status text`、`decision_reason text`、`shadow boolean`、`fire_at timestamptz`、`scheduled_at timestamptz`、`fired_at timestamptz`、`sent_at timestamptz`、`outcome_kind text`、`generated_text text`、`reserve_result text`、`error text`、`events jsonb`、`batch_id text`、`candidate_name text`、`manager_name text`、`bot_im_id text`、`stop_context jsonb`、`tenant_id text`。

**strategy_config（15 列）**

`id uuid`、`name text`、`description text`、`persona jsonb`、`stage_goals jsonb`、`red_lines jsonb`、`industry_skills jsonb`、`is_active boolean`、`created_at timestamptz`、`updated_at timestamptz`、`role_setting jsonb`、`status text`、`version integer`、`version_note text`、`released_at timestamptz`。

**system_config（5 列）**

`key character varying(100)`、`value jsonb`、`description text`、`created_at timestamptz`、`updated_at timestamptz`。

**test_batches（17 列）**

`id uuid`、`name character varying(200)`、`source character varying(50)`、`feishu_table_id character varying(100)`、`total_cases integer`、`executed_count integer`、`passed_count integer`、`failed_count integer`、`pending_review_count integer`、`pass_rate numeric`、`avg_duration_ms integer`、`avg_token_usage integer`、`status character varying(20)`、`created_by character varying(100)`、`created_at timestamptz`、`completed_at timestamptz`、`test_type character varying(50)`。

**test_conversation_snapshots（17 列）**

`id uuid`、`batch_id uuid`、`feishu_record_id character varying(100)`、`conversation_id character varying(100)`、`participant_name character varying(200)`、`full_conversation jsonb`、`raw_text text`、`total_turns integer`、`avg_similarity_score numeric`、`min_similarity_score numeric`、`status character varying(50)`、`created_at timestamptz`、`updated_at timestamptz`、`source_trace jsonb`、`memory_setup jsonb`、`memory_assertions jsonb`、`validation_title character varying(500)`。

**test_executions（33 列）**

`id uuid`、`batch_id uuid`、`case_id character varying(100)`、`case_name character varying(500)`、`category character varying(100)`、`test_input jsonb`、`expected_output text`、`agent_request jsonb`、`agent_response jsonb`、`actual_output text`、`tool_calls jsonb`、`execution_status character varying(20)`、`duration_ms integer`、`token_usage jsonb`、`error_message text`、`review_status character varying(20)`、`review_comment text`、`reviewed_by character varying(100)`、`reviewed_at timestamptz`、`failure_reason character varying(100)`、`created_at timestamptz`、`test_scenario character varying(100)`、`conversation_snapshot_id uuid`、`turn_number integer`、`similarity_score numeric`、`input_message text`、`evaluation_reason text`、`reviewer_source character varying(50)`、`source_trace jsonb`、`execution_trace jsonb`、`memory_setup jsonb`、`memory_assertions jsonb`、`memory_trace jsonb`。

**user_activity（14 列）**

`id bigint`、`chat_id text`、`od_id text`、`od_name text`、`activity_date date`、`message_count integer`、`token_usage integer`、`first_active_at timestamptz`、`last_active_at timestamptz`、`created_at timestamptz`、`updated_at timestamptz`、`bot_user_id text`、`im_bot_id text`、`tenant_id text`。

**user_hosting_status（14 列）**

`user_id character varying(100)`、`is_paused boolean`、`paused_at timestamptz`、`resumed_at timestamptz`、`pause_count integer`、`created_at timestamptz`、`updated_at timestamptz`、`pause_expires_at timestamptz`、`is_permanent boolean`、`pause_reason text`、`pause_operator text`、`pause_source text`、`handoff_scope jsonb`、`tenant_id text`。

[数据库读写与迁移说明](database-schema.md) · [Redis 键说明](redis-schema.md) · [组织、成员和业务账号](../product/organization-members-and-business-accounts.md)
