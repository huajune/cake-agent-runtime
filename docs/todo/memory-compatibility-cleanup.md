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

1. 含批 A 的版本在生产稳定运行至少一个完整 session TTL（3 天）；
2. 确认没有现行写路径再产生 sibling；
3. 通过 Redis 样本审计或临时兼容命中计数，确认旧 sibling 命中为 0；
4. 完成收资、Prompt 展示、工具预填和旧 fixture 回归。

闸门通过后一次性删除：

- `short-term.types.ts` 的 schema、field key 与类型；
- `evidence/types.ts`、`policies.ts`、`merge.ts` 中的 sibling 投影；
- `prompt-memory-adjudicator.ts` 的关联字段处理；
- `readGenderProvenance()` 对 sibling 的 fallback 与相应兼容测试/fixture。

闸门核对（2026-09-02）：① 批 A 随 v11.0.0 于 08-27 上线，已满 3 天 ✅；② 全仓无写路径——`rule-track` 已停发 sibling，`turn-hints/reducer` 仅置 null ✅；③ **未核**，需 Redis 样本审计或临时兼容命中计数（当前唯一阻断项）；④ 待 ③ 通过后一并做。

在没有命中数据前不要仅按日期删除；否则旧 Redis session 可能把系统标签误当候选人自陈。

## 相关文档

- [候选人档案域架构](../architecture/candidate-profile-domain.md)
- [Memory 当前实现](../../src/memory/README.md)
- [记忆与状态全局视图](../architecture/memory-and-state.md)
