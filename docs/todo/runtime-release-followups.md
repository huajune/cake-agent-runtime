# 运行时改造发版后续

**最后核对**：2026-08-26

上下文装配与记忆终态改造已经完成；施工方案已从 todo 删除并保留在 Git 历史。
本单只追踪无法由本地代码检查证明的发版与生产观测事项。

## 1. 发版前确认数据库迁移同批执行

确认目标环境已按顺序应用下列迁移，代码与数据库不得拆批上线：

1. `20260821210000_rename_long_term_columns_coala.sql`
2. `20260825025701_add_long_term_bot_account_dimension.sql`
3. `20260825050239_flatten_session_summaries_and_move_consolidation_watermarks.sql`
4. `20260825055058_extend_long_term_profile_height_weight.sql`
5. `20260825063752_fix_atomic_episodic_lazy_migration.sql`

验收：迁移清单与目标库一致；对测试候选人完成 profile、job intent、episode append 和
watermark 回读；确认长期关系行带稳定 `bot_user_id`。

## 2. system 段序上线后观察

- 用一期口径记录上线前后 `cachedInputTokens` / input tokens 与命中占比；
- 确认 Qwen 隐式前缀缓存有实际命中，且 tools 序列化在相同场景下逐字节稳定；
- 对既有 badcase/test-suite 基线复测，确认没有系统性回升；
- 若命中率或质量显著劣化，回滚方式是 revert 段序提交，不涉及数据回滚。

生产命中率数字只在真实流量观测后填写，不用本地估算代替。

## 3. 完成条件

- 五个迁移已在目标环境核对；
- 记录至少一个可比生产窗口的缓存数字；
- badcase 与关键 test-suite 基线无回升；
- 结果写入对应 release note 后删除本 todo。

## 相关文档

- [Agent 运行时架构](../architecture/agent-runtime-architecture.md)
- [Memory 当前实现](../../src/memory/README.md)
- [Prompt Section 动态组装体系](../knowledge-base/05-Prompt-Section动态组装体系.md)
