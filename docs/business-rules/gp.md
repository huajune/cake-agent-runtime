# 无岗承接与拉群（GP）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## GP-01 在招结论先查询

询问某品牌、城市或用工形式是否有岗时，条件足够就查询，条件不足先补齐；查询前不保证有岗。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-01`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#job_query_claim_without_query`
- 落点：`src/agent/guardrail/output/rules/job-fact-reconciliation.rule.ts#detectJobQueryClaimWithoutQuery`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/job-fact-reconciliation.rule.spec.ts`

## GP-02 推荐展示遵循岗位卡片

介绍岗位时遵循查岗工具的展示契约，保留岗位、薪资、班次和要求，不能只问候选人能否接受却不说明条件。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-02`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#salary_told_before_collection`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## GP-03 品牌与品类意向

明确点名品牌时按其意向召回；咖啡品类默认与主动排除按现有契约处理。Agent 自推岗位被接受不等于候选人锁死品牌；不适配时承接硬条件查替代。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-03`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#brand_alias_fuzzy_match_ignored`
- 落点：`src/agent/guardrail/output/rules/brand-name-errors.rule.ts#detectBrandAliasFuzzyMatchIgnored`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#requested_brand_mismatch`
- 落点：`src/agent/guardrail/output/rules/brand-name-errors.rule.ts#detectRequestedBrandMismatch`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/brand-name-errors.rule.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#job_list_brand_provenance`
- 验证：`tests/agent/guardrail/catalog.spec.ts`

## GP-04 岗位事实纠错

先前介绍的地址、时间、班次、薪资或要求与最新工具结果不同时，明确纠正并说明真实信息，不能换个说法继续坚持。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-04`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#job_fact_without_provenance`
- 落点：`src/agent/guardrail/output/rules/job-fact-reconciliation.rule.ts#detectJobFactWithoutProvenance`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/job-fact-reconciliation.rule.spec.ts`

## GP-05 健康证筛选不保证有岗

没有相应筛选参数时先召回再逐岗核对健康证要求，找到合适岗位前不保证能报名或先面试。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-05`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#cert_flexible_job_existence`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## GP-06 职责与备注按岗位事实

工作职责只按岗位字段说明，不凭行业常识补充；含日期的筹备、开业或上岗备注按当前日期解释，过期信息不当长期事实。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-06`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`

## GP-07 多品牌推荐与距离

多个品牌有相近通勤距离时应提供品牌选择；距离明显不同仍按距离优先，同品牌不同门店要区分。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-07`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`

## GP-08 无其他岗位时承接与收口

候选人反复拒绝唯一选项时，了解新的工种、区域或用工形式后查替代；确实无匹配且不愿调整时一次性收口，不反复施压或承诺未安排的通知。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-08`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`

## GP-09 招聘平台与发布主体

提到平台名不自动当身份质疑；截图岗位归属按品牌、门店和本轮岗位结果核对，不能因人力公司发布主体就否认归属。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/gp.md#GP-09`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`

## GP-10 拉群时机与后续边界

按当前邀群契约选择城市与群，已有邀请走去重；无岗收口后不主动续推，候选人提出新诉求时再处理。报名后的群用途与报名回执一致。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/reengagement/scenario-registry.ts#generationPolicy`
- 落点：`src/tools/invite/invite-city-gate.ts`
- 落点：`src/tools/invite-to-group.tool.ts#buildInviteToGroupTool`
- 落点：`src/tools/invite/invite-timing-gate.ts`
- 验证：`tests/agent/reengagement/scenario-registry.spec.ts`
- 验证：`tests/tools/invite/invite-city-gate.spec.ts`
- 验证：`tests/tools/tool/invite-to-group.tool.spec.ts`
- 验证：`tests/tools/invite/invite-timing-gate.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#invite_timing_gate`
- 验证：`tests/agent/guardrail/catalog.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#job_pool_vs_interview_group`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- 历史积压中的“不主动提薪资”意见不能覆盖现行四行岗位卡契约；没有新裁定时保持卡片薪资行。
- 群与门店实时状态依赖工具证据，文档不能证明线上现在有岗或有群。
- 2026-10-23 测试环境冒烟的“美团外卖未合作”预期缺少合作状态依据；实际 instructions/toolDefinitions 和工具结果均不能证明该前提。执行 `f1f6da14-e949-4e7d-8127-0f699d06e070` 标记 skipped / 测试资产不可评估，不算业务通过或失败，不由此新增“不合作”规则。

## 变更记录

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
