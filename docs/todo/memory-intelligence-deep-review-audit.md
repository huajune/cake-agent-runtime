# 记忆智能点深审查证记录（2026-08-25）

本文记录 `M5-深审` 中仅要求查证、不在本批改变行为的两项字段审计，以及本批保守决策。

## `preferences.brand_ids` 三通道审计

结论：它不是只经过 brand-state 的无消费透传字段，当前不能登记为可直接退役。

1. 生产与存储：轮末抽取 schema/prompt 仍生产 `brand_ids`；证据合并策略使用
   `array-union`，结果以 `SessionFacts.preferences.brand_ids` 信封留在短期事实中。
2. Prompt 消费：`fact-lines.formatter.ts` 把它渲染为意向品牌 ID；
   `hard-constraints.section.ts` 在规则值与可信 session facts 之间选值，并明确提示模型调用
   `duliday_job_list` 时优先传给 `brandIdList`。
3. 工具边界：`duliday_job_list` 不会在模型省略 `brandIdList` 时偷偷读取 session
   `brand_ids` 自动筛选，现有回归测试锁住“由模型显式决定是否传参”。
4. 长期边界：长期 `LONG_TERM_JOB_INTENT_FIELD_KEYS` 没有 `brand_ids`；长期品牌快照来自
   `facts.brand.currentBrand` 并写入 `brands`。因此它是短期的模型提示/工具参数候选通道，
   不是长期品牌真相，也不是 brand-state 的简单过路字段。

本批保持现状。若未来统一为 `facts.brand`，至少要先替换规则轨生产、证据合并、两处 Prompt
渲染及模型到 `brandIdList` 的显式映射，并用真实对话验证多品牌 ID 语义不会被单一
`currentBrand` 压扁后，才具备退役条件。

## `interview_info.gender_source` 消费与迁移路径

当前生产方：

- 规则轨识别候选人自陈性别时，同时发布 `gender=candidate value` 与
  `gender_source=candidate`；
- 外部补充/系统标签同时发布低置信 `gender` 与 `gender_source=system`；
- booking 成功把候选人确认值写为 high，并写入 `gender_source=candidate`。

当前消费方：

- `fact-lines.formatter.ts` 用它区分“候选人自陈”和“系统标签，不能直接排除”的模型可见
  口径；
- `tool-context.builder.ts` 用它阻止系统标签被当作候选人确权资料预填；
- `turn-hints.section.ts` 不单独展示 sibling 字段，但在展示 gender claim 时把来源 claim
  一并投影，保证两者同步裁决；
- 长期 `semantic_profile` 不保存这个 sibling；长期 gender 自身信封的 `source` 已是长期
  事实来源字段。

建议迁移顺序（本批只登记，不改行为）：

1. 先让所有消费者读取 `gender` 信封上的来源语义，并对旧 `gender_source` 做兼容回退；
2. 部署双读后，生产方停止写 sibling，新读边界对旧记录做懒归一；
3. 观察存量与兼容命中归零，再从 schema、字段 key 和规则轨联动中删除
   `gender_source`。

不能先删 sibling：当前 `source=system/candidate_quote` 与业务口径
`gender_source=system/candidate` 并非严格一一对应，直接替换会改变工具预填安全守卫。

## 本批验证与决策

- booking high 身份字段后执行一轮纯 preference 抽取，身份信封保持原样；无需 P0 修复，
  因此没有拆出额外提交。
- archive 段上限规格只要求“有上限、确定性淘汰最老段”，未给数字。本批保守选择
  `12` 段：按旧到新保存，追加第 13 段时只丢最老一段；旧 string blob 在读边界成为首段。
- archive 压缩 prompt 只包含本次 overflow，不读取、拼接或改写既有 archive 段。
- 原子追加 RPC 先裁剪 recent/推进水位，因此应用层在调用前保留摘要快照；压缩或 archive
  回写失败时先恢复 RPC 前的 recent/archive/水位再抛错，Bull 重试不会被错误水位挡住。
