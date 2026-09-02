# Memory 兼容字段清理

**最后核对**：2026-09-02

记忆结构重构已经完成；当前只剩 `interview_info.gender_source` 的兼容读边界需要在存量自然
过期后删除。`preferences.brand_ids` 已确认仍有 Prompt 与工具参数候选用途，不是待删除字段。

## 唯一活跃项：删除 `gender_source` sibling

当前状态：

- 新规则 producer 与 booking 不再写 `gender_source`；
- `gender` 信封的 `source + confidence` 已承载来源语义；
- `readGenderProvenance()` 仍兼容旧 sibling，避免滚动发布或 3 天 session 存量改变行为；
- `short-term.types.ts`、evidence 投影视图、Prompt 共享裁决和测试 fixture 仍保留该键。

删除闸门：

| #   | 闸门                                                        | 状态（2026-09-02 核对）                                                                                                           |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 含批 A 的版本在生产稳定运行至少一个完整 session TTL（3 天） | ✅ v11.0.0 于 2026-08-27 上线                                                                                                     |
| 2   | 没有现行写路径再产生 sibling                                | ✅ `rule-track.ts` 已停发、`reducer.ts` 只置 null；生产存量里全部 sibling 信封的 `extractedAt` ≤ 08-27 11:54 CST，之后 6 天零新增 |
| 3   | Redis 样本审计确认旧 sibling 命中为 0                       | ❌ **未归零**，见下方审计记录                                                                                                     |
| 4   | 完成收资、Prompt 展示、工具预填和旧 fixture 回归            | 未开始，闸门 3 通过后再做                                                                                                         |

### 闸门 3 审计记录（2026-09-02）

- 范围：生产 Redis `production:factsv2:*` 全量 994 个 hash（SCAN MATCH + COUNT 100，10 轮走到
  cursor 0；服务端 EVAL 只回传计数，不回传候选人内容），其中 978 个带 `facts` 字段。
- 命中：**17 个** session 的 `facts.interview_info.gender_source` 非 null（1.7%）。TTL 剩余
  7.6 小时 ~ 3.27 天；其中最近一次候选人消息在 2026-09-02，说明仍有活跃会话在带着它。
- 第二证据：`message_processing_records.memory_snapshot` 近 7 天有 716 回合 / 171 个 chat 带该键，
  近 24 小时只剩 1 回合 / 1 个 chat，趋势在收敛。
- 为什么没有随 3 天 TTL 消失：`saveCollectionProgressFact` / `saveCompletedCollectionFacts` 用
  `...base.interview_info` 原样带上旧 sibling 并刷新整个 key 的 TTL。这不是新的写路径，但意味着
  "自然过期"只对闲置会话成立，归零时间取决于这 17 个会话何时闲置满 3.5 天。
- 预计归零：不早于 2026-09-05 18:00 CST（按当前最长 TTL 推算，且这些会话不再有身份写入）。
  建议 **2026-09-06 之后复扫**；复扫命中为 0 再进入闸门 4。

复扫方式（Upstash MCP `redis_database_run_redis_commands`，`EVAL <script> 0 <起始cursor> <最大轮数>`，
每轮 COUNT 100，脚本只返回计数）：

```lua
local cursor, maxIter, iters, total, hits = ARGV[1], tonumber(ARGV[2]), 0, 0, 0
repeat
  local res = redis.call('SCAN', cursor, 'MATCH', 'production:factsv2:*', 'COUNT', '100')
  cursor = res[1]; iters = iters + 1
  for _, k in ipairs(res[2]) do
    total = total + 1
    local f = redis.call('HGET', k, 'facts')
    if f then
      local ok, obj = pcall(cjson.decode, f)
      if ok and type(obj) == 'table' and type(obj.interview_info) == 'table' then
        local gs = obj.interview_info.gender_source
        if gs ~= nil and gs ~= cjson.null then hits = hits + 1 end
      end
    end
  end
until cursor == '0' or iters >= maxIter
return cjson.encode({ cursor = cursor, total = total, hits = hits })
```

SQL 侧对照（近 7 天，两段式，`received_at` 过滤）：统计
`memory_snapshot->'sessionFacts' ? 'interview.gender_source'` 的回合数与 `chat_id` 数。

闸门通过后一次性删除：

- `short-term.types.ts` 的 schema、field key 与类型；
- `evidence/types.ts`、`policies.ts`、`merge.ts` 中的 sibling 投影；
- `prompt-memory-adjudicator.ts` 的关联字段处理；
- `readGenderProvenance()` 对 sibling 的 fallback 与相应兼容测试/fixture。

在没有命中数据前不要仅按日期删除；否则旧 Redis session 可能把系统标签误当候选人自陈。

## 相关文档

- [候选人档案域架构](../architecture/candidate-profile-domain.md)
- [Memory 当前实现](../../src/memory/README.md)
- [记忆与状态全局视图](../architecture/memory-and-state.md)
