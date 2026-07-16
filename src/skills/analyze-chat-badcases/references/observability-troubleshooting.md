# 多表观测排障参考

用于把“最终回复不对”定位成具体链路阶段问题。先锚定一条 turn，再定点下钻；不要对大 JSONB 字段做无边界全表扫描。

## 1. 先区分数据路径

### 生产对话

生产消息通常以候选人入站 `message_id` 作为 `trace_id`，可串联主流水、执行事件和守卫档案。完整链路优先按以下顺序取证：

`chat_messages → message_processing_records → agent_execution_events → guardrail_review_records → 业务副作用表 → monitoring_error_logs`

### test-suite / debug-chat

测试流为了不污染“今日托管”等生产指标，会跳过 `message_processing_records` 等生产 tracking 写入；`guardrail_review_records` 也只在带生产 `traceId` 的回合落库。因此测试排障应以这些字段为主：

- `test_executions.agent_request`：实际测试入参和历史。
- `test_executions.agent_response / actual_output`：运行结果，不等同于业务通过。
- `test_executions.tool_calls`：工具输入、输出和错误。
- `test_executions.execution_trace`：steps、guardrailTrace、投递/终态证据。
- `test_executions.memory_setup / memory_trace`：记忆 fixture 与执行前后状态。
- `agent_execution_events`：若能从执行 trace 取得运行时 traceId，可补查模型、工具、语义评审事件；不要假设每条测试都存在生产主流水或守卫档案。

## 2. 表的职责与关联方式

| 表 | 回答的问题 | 首选关联键 | 重要边界 |
|---|---|---|---|
| `chat_messages` | 候选人和 Agent 实际说了什么 | `chat_id`, `message_id` | 对话事实，不解释运行原因 |
| `message_processing_records` | 本 turn 的主链终态、工具、步骤、记忆、守卫摘要和后处理 | `message_id = trace_id` | 主账本；大字段按单 trace 读取 |
| `agent_execution_events` | 模型、工具、语义评审、memory、error/end 的结构化时间线 | `trace_id` | 一条 trace 多行；`payload` 随 event_type 变化 |
| `guardrail_review_records` | 首版回复、首审、修复版、二审和最终裁决 | `trace_id` | 稀疏表，仅守卫有信号的生产回合写；写入是异步 best-effort |
| `monitoring_error_logs` | 渠道、外部依赖、观测持久化、告警与投递基础设施是否异常 | `message_id`；无 ID 时用时间窗 + subsystem/component | 系统级告警可以没有 message_id |
| `handoff_events` | 是否真实触发转人工及 reason/stage | `chat_id`, `user_id`, 时间窗 | 没有 trace_id，需用业务时间对齐 |
| `ops_events` | booking/precheck/replied/handoff 等业务副作用是否实际落账 | `chat_id`, `user_id`, 时间窗 | 是业务事实底账，不是模型推理档案 |
| `reengagement_touch_records` | 主动复聊为何排程、停止、shadow、重复或投递失败 | `session_id`, `touch_key`, `anchor_event_id` | 只适用于 reengagement 场景 |

`daily_ops_report` 等聚合/投影表适合看趋势，不适合给单条 BadCase 定责；单条排障查原始底账。

## 3. 主链必查字段

对确定的问题 turn，先读取 `message_processing_records`：

- `status / error / scenario / reply_segments`
- `tool_calls / agent_steps / anomaly_flags`
- `memory_snapshot / post_processing_status`
- `guardrail_input / guardrail_output`
- `reply_preview / is_fallback / fallback_success`
- 各阶段 duration 与 `ttft_ms`

只有在上述证据不足，且需要确认 prompt、历史注入、时间戳或工具 schema 时，才读取该 trace 的 `agent_invocation -> request -> agentRequest`。不要把 `agent_invocation` 加进批量抽样 SQL。

## 4. 分层查询模板

将占位符替换为已确认的值；所有查询保持只读。

### 4.1 锚定主 turn

```sql
SELECT
  message_id, chat_id, received_at, status, error, scenario,
  reply_segments, reply_preview, anomaly_flags,
  tool_calls, agent_steps, memory_snapshot,
  guardrail_input, guardrail_output, post_processing_status,
  is_fallback, fallback_success, total_duration, ttft_ms
FROM message_processing_records
WHERE message_id = '<trace_id>';
```

若只有 `chat_id + 时间`，先在小时间窗内定位，不要直接模糊扫全表：

```sql
SELECT message_id, received_at, message_preview, reply_preview, status
FROM message_processing_records
WHERE chat_id = '<chat_id>'
  AND received_at BETWEEN '<start_at>' AND '<end_at>'
ORDER BY received_at;
```

### 4.2 还原执行事件时间线

```sql
SELECT id, created_at, event_type, scenario, caller_kind, payload
FROM agent_execution_events
WHERE trace_id = '<trace_id>'
ORDER BY created_at, id;
```

重点解释：

- `model_call / model_fallback / agent_error / agent_end`
- `tool_call / tool_error`
- `memory_recall / memory_store`
- `semantic_review` 的 `mode / decision / confidence / findingCodes`

`semantic_review` 无命中也应有 pass 事件；它可作为 shadow/enforce 是否存活的证据。若事件缺失，先核对配置、执行路径和事件落库健康，不能直接断言语义评审通过。

### 4.3 查看守卫全过程

```sql
SELECT
  created_at, trace_id, user_message,
  first_reply, first_decision, first_rule_ids, first_blocked_rule_ids,
  first_violations, first_feedback, repair_mode,
  repaired, revised_reply, revised_decision, revised_rule_ids,
  final_decision, reason_code, committed_side_effects
FROM guardrail_review_records
WHERE trace_id = '<trace_id>';
```

对 `block/revise/replan/observe` 的结论，同时核对主表 `guardrail_output`。守卫档案无行可能意味着 pass、未走该路径、测试流隔离、异步写失败或历史数据已清理，不能单凭缺行作结论。

### 4.4 核对告警和业务副作用

```sql
SELECT "timestamp", subsystem, component, action, severity,
       code, summary, error, throttled, delivered
FROM monitoring_error_logs
WHERE message_id = '<trace_id>'
   OR (
     "timestamp" BETWEEN '<start_at>' AND '<end_at>'
   )
ORDER BY "timestamp";
```

```sql
SELECT created_at, reason_code, reason, action_advice, stage, work_order_id
FROM handoff_events
WHERE chat_id = '<chat_id>'
  AND created_at BETWEEN '<start_at>' AND '<end_at>'
ORDER BY created_at;

SELECT occurred_at, event_name, idempotency_key, payload
FROM ops_events
WHERE chat_id = '<chat_id>'
  AND occurred_at BETWEEN '<start_at>' AND '<end_at>'
ORDER BY occurred_at, id;
```

涉及预约时，用 `ops_events` 判断 `precheck.passed / booking.succeeded / booking.failed / booking.canceled / booking.interview_modified` 是否实际发生；涉及转人工时，同时核对 `handoff_events` 与 `ops_events.event_name='handoff.triggered'`，不以 Agent 文案里的“已转人工”作为事实。

### 4.5 主动复聊专用

```sql
SELECT
  touch_key, session_id, scenario_code, anchor_event_id,
  status, decision_reason, shadow, fire_at, fired_at, sent_at,
  outcome_kind, generated_text, reserve_result, error, events
FROM reengagement_touch_records
WHERE session_id = '<session_id>'
ORDER BY created_at;
```

## 5. 按症状选择证据

| 症状 | 最少证据组合 |
|---|---|
| 重复追问、遗忘已给信息 | `chat_messages + memory_snapshot + agent_steps + agent_invocation(单 trace)` |
| 工具没调、参数错、动态事实错 | `tool_calls + agent_execution_events(tool_*) + agent_steps` |
| 回复被改写、拦截或静默 | `guardrail_output + guardrail_review_records + reply_segments` |
| semantic shadow/enforce 是否执行 | `agent_execution_events(event_type='semantic_review') + 当前配置` |
| 声称已预约/转人工但事实可疑 | `ops_events + handoff_events + tool_calls` |
| “Agent 没回复” | 主表终态 + `reply_segments` + guardrail/skip outcome + `monitoring_error_logs` |
| 真人插话后不该回复 | 对话来源标记 + agent steps/skip_reply + 投递终态 |
| 主动复聊没发或重复发 | `reengagement_touch_records.events + reserve_result + monitoring_error_logs` |

## 6. 证据判定规则

1. 区分四类事实：模型意图、工具执行、守卫裁决、外部副作用。上一层的文案不能证明下一层已经发生。
2. 同时存在结构化底账和日志时，优先结构化底账；日志只用于补充异常堆栈和异步写失败。
3. `HTTP success / execution_status=completed` 只证明链路完成，不证明业务行为正确。
4. 稀疏表缺行必须显式说明可能原因；不要把“没有证据”写成“证明确实没有”。
5. 异步事件允许轻微时间偏移；用 traceId 优先于纯时间 join。没有 traceId 的业务表才使用 `chat_id/user_id + 窄时间窗`。
6. 排障后保留最小证据包：`chatId, messageId/traceId, source record, 关键表行 ID/时间, 根因层, 证据缺口`；不要复制无关的完整 prompt 或隐私字段。

## 7. 结论格式

每条 BadCase 至少给出：

```text
现象：候选人可见结果或业务异常
根因层：prompt/stage/tool/data/memory/guardrail/delivery/workflow/observability
执行链：模型决策 → 工具 → 守卫 → 投递/副作用
证据：traceId + 表名.字段 = 关键值
置信度：高/中/低
证据缺口：缺失表、测试隔离、过期或无法关联的部分
修复点：具体代码/prompt/配置/数据位置
回归断言：要验证的结构化字段和候选人可见行为
```
