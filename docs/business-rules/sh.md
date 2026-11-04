# 班次与出勤（SH）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## SH-01 排班类型与周频分别判断

固定、组合、灵活排班按本轮岗位数据解释；完整班次、每天工时与每周出勤分别核对，不把时间跨度当工作时长或把组合档位相加。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sh.md#SH-01`
- 落点：`src/resolution/schedule/matcher.ts`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/resolution/schedule/matcher.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#combo_schedule_two_dimensions`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## SH-02 不改写班次

同轮回复须与工作时间字段一致；候选人提出新的时间窗时重新核对，不自行截短班次、承诺未列出的时段或把推断和工具结果并列。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sh.md#SH-02`
- 落点：`src/resolution/schedule/matcher.ts`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/resolution/schedule/matcher.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#time_unsuitable_clarify_first`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## SH-03 出勤冲突须解释

班次或周出勤约束导致无匹配时说明实际冲突，按约束重查后决定后续。收资前确认每周出勤要求，固定轮休不等于任意少上班。

2026-11-04 用户裁定：公开工期/班次字段只有真实拒绝项或数值门槛才属于筛选要求；必填、选项数量和字段标题不能单独证明硬门槛。模板先告知已配置的公开要求，仍保留所有真实回答选项。仅选择某个门店班次不等于排他性可工作时间，周末可在岗不等于只能周末。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sh.md#SH-03`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/resolution/collection/disclosure-policy.ts#isPublicWorkConditionField`
- 落点：`src/tools/collection/collection-template.renderer.ts#renderCollectionTemplate`
- 落点：`src/tools/collection/verified-work-answers.ts#collectVerifiedWorkAnswers`
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 验证：`tests/tools/collection/collection-template.renderer.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`
- 落点：`src/resolution/schedule/matcher.ts`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/resolution/schedule/matcher.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#schedule_constraint_precheck_first`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## SH-04 最短工期与阶段工期

只在候选人明确做不满最短工期时拒绝当前岗位；不主动盘问月数，不把试做或尚不确定当作拒绝依据，阶段岗位按起止时段判断。

首次推荐保留岗位卡已有的最短工期；没有配置时不自行补要求。报名标签明确筛退工期选项时如实保留答案，公开工期拒因可说明契约要求；不把“做到年后”外推成日历月数。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sh.md#SH-04`
- 落点：`src/resolution/schedule/matcher.ts`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/resolution/schedule/matcher.spec.ts`
- 落点：`src/resolution/collection/disclosure-policy.ts#disclosureLevelOf`
- 落点：`src/tools/collection/collection-template.renderer.ts#renderCollectionTemplate`
- 验证：`tests/tools/collection/collection-template.renderer.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`

## SH-05 负向条件持续生效

候选人明确拒绝的职责、班次和距离须跨轮承接；当前岗位存在冲突时在继续收资前说明并取得知情确认，不隐瞒绕过。

查岗可引用本轮 precheck 读取或验证过的本人公开工期/班次答案，无须重新拼接原话。引用只证明出处，字段语义与排他性由 Agent 结合问题理解；不自动把选中班次投影为个人限制。表单修正/清空后旧引用失效，代报他人及档案预填不提供本人出处。跨轮先 query 已有表单即可复用，不重问候选人；引用失败不得丢弃仍有效的条件绕过核验。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sh.md#SH-05`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/resolution/schedule/matcher.ts`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/resolution/schedule/matcher.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#job_list_schedule_constraint_provenance`
- 落点：`src/tools/job-list/schedule-evidence.ts#verifyScheduleCitation`
- 落点：`src/tools/collection/verified-work-answers.ts#collectVerifiedWorkAnswers`
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/resolution/schedule/types.ts#SCHEDULE_CONSTRAINT_GUIDANCE`
- 验证：`tests/tools/collection/verified-work-answers.spec.ts`
- 验证：`tests/tools/tool/duliday-job-list.tool.spec.ts`
- 验证：`tests/agent/guardrail/catalog.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- 排班机制以现有 shift-matching 架构与测试为依据；岗位原始数据是否连上/轮班缺失时，继续使用当前缺字段处理，不推断补齐。
- 岗位 529230 的展示最短工期与标签筛选范围不一致，交独立数据核对会话与运营确认，本次不改海绵数据。

## 变更记录

- 2026-11-04：按用户修正及 audit 459023（trace `batch_6aea9566ce406a6aee2ccfb0_1793759532338`）区分公开要求与普通选择题，保留真实不合格回答；查岗复用已核验表单证据，补工期/班次边界回归。投诉回应按用户意见保持现状。

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
