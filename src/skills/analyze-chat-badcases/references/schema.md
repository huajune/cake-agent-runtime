# 数据 Schema 参考

读 SQL 返回后理解字段所需的最小字典。

## `chat_messages` — 完整对话流水

每行代表候选人或 Agent 的一条消息。

| 字段 | 说明 |
|------|------|
| `chat_id` | 会话 ID，对应一个候选人 |
| `message_id` | 消息唯一 ID，可和 `message_processing_records.message_id` join |
| `role` | `user`（候选人）/ `assistant`（Agent） |
| `content` | 本条消息文本 |
| `timestamp` | 消息时间（毫秒时间戳） |
| `candidate_name` | 候选人昵称 |
| `manager_name` | 招募经理姓名 |

## `message_processing_records` — 每 turn 处理记录

只对 assistant 轮次有行；user 轮 LEFT JOIN 后这些字段为 NULL。

| 字段 | 说明 |
|------|------|
| `status` | `success` / `failure` / `timeout` / `processing` |
| `error` | 失败时的错误描述 |
| `is_fallback` | 是否走了降级模型 |
| `fallback_success` | 降级模型是否成功 |
| `anomaly_flags` | 已自动打标的异常信号（见下表） |
| `tool_calls` | 本轮工具调用链（JSONB 数组，见下） |
| `memory_snapshot` | 本轮入口时的记忆快照（JSONB，见下） |
| `ai_duration` | LLM 处理耗时（毫秒） |
| `total_duration` | 端到端总耗时（毫秒） |

### `anomaly_flags` 取值

| 值 | 触发条件 |
|----|---------|
| `tool_loop` | 同一工具被调用 ≥ 3 次 |
| `tool_empty_result` | 某次工具调用返回 0 条结果 |
| `tool_narrow_result` | 某次工具调用只返回 1 条（候选人没的选） |
| `tool_chain_overlong` | 本轮工具调用链长度 ≥ 5 |
| `no_tool_called` | 本轮未调用任何工具（留给业务规则使用，暂不自动打标） |

### `tool_calls` 数组结构

```json
[
  {
    "toolName": "duliday_job_list",
    "args": { "...": "..." },
    "resultCount": 3,
    "status": "ok",
    "durationMs": 450
  }
]
```

- `status`: `ok` / `empty` / `narrow` / `unknown` / `error`
- `resultCount`: 返回条数（推不出则缺省）

### `memory_snapshot` 结构

```json
{
  "currentStage": "intent_clarification",
  "presentedJobIds": [101, 102],
  "recommendedJobIds": [101, 102, 103],
  "sessionFacts": { "location": "上海", "...": "..." },
  "profileKeys": ["age", "workExperience"]
}
```

- `currentStage`: 本轮入口所处的 procedural 阶段
- `presentedJobIds`: 本会话已展示过给候选人的岗位 id
- `recommendedJobIds`: 上一轮 `duliday_job_list` 返回的候选池
- `sessionFacts`: 已抽取的会话事实（意向、偏好等扁平化字段）
- `profileKeys`: 长期画像里已填充的字段名列表（不含具体值）
