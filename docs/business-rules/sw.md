# 薪资福利与社保（SW）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## SW-01 追问福利与薪资细则先重查

候选人追问当前岗位的福利、阶梯算法、结算或签约主体时，先查该岗位的最新完整字段；记忆只用于确定岗位，缺字段才转人工。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sw.md#SW-01`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#salary_worktime_fact_grounding`
- 验证：`tests/agent/generator/context/context.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#job_detail_missing_field_lookup`

## SW-02 保险福利与社保准入分开

不主动介绍保险。主动问公司购买情况按福利字段，问个人社保准入按招聘要求；商业险不说成社保。失业金与证明、个人账务交对应人工场景。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sw.md#SW-02`
- 落点：`src/tools/job-list/welfare-facts.util.ts#extractWelfareFacts`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#proactive_insurance_policy_mention`
- 落点：`src/agent/guardrail/output/rules/insurance-policy-claims.rule.ts#detectProactiveInsurancePolicyMention`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/welfare-facts.util.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.restored-sentinels.spec.ts`

## SW-03 关键用工事实缺失转人工

合同性质、社保、税务、试用期、工时结算等先查字段，缺答案当轮转人工，不凭常识作答或空口承诺稍后确认。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sw.md#SW-03`
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/request-handoff.tool.spec.ts`

## SW-04 发薪与签约主体

按本轮岗位合作模式的实际结论回答发薪和签约主体；缺字段转人工，不把合同升格为劳动合同，不对外泄漏商业内部术语。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sw.md#SW-04`
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/tools/job-list/render.util.ts#render`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/tools/job-list/render.util.spec.ts`

## SW-05 计薪单位不互相折算

月薪岗不估算时薪；兼职时薪岗即使被问月收入，也按时薪和阶梯说明，不报综合月薪区间或估算月收入。每日工时看排班字段。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sw.md#SW-05`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#part_time_salary_display_mismatch`
- 落点：`src/agent/guardrail/output/rules/part-time-salary-display.rule.ts#detectPartTimeSalaryDisplayMismatch`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/part-time-salary-display.rule.spec.ts`

## SW-06 本人银行卡发薪

默认工资发到本人银行卡，不支持微信、支付宝、他人卡或现金；候选人不能接受时停止推进并交个人账务场景，不承诺变通。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/sw.md#SW-06`
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/request-handoff.tool.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#salary_account_no_fabricated_policy`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## SW-07 阶梯算法与结算

升档按全部工时还是超出部分取阶梯括注；阶梯累计周期与工资发放周期分开说明，不能把日结理解为阶梯每天清零。周期口径分歧见未决项。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/tools/job-list/render.util.ts#render`
- 落点：`src/tools/job-list/salary-settlement.util.ts#formatSettlementSummary`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#settlement_cycle_mismatch`
- 落点：`src/agent/guardrail/output/rules/settlement-cycle-mismatch.rule.ts#detectSettlementCycleMismatch`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/tools/job-list/render.util.spec.ts`
- 验证：`tests/tools/job-list/salary-settlement.util.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/settlement-renderer-contract.spec.ts`

## SW-08 餐宿与福利字段

明确区分福利未加载和已加载但餐宿未配置；后者按现有无餐宿默认处理，保险缺字段仍是不明确，不能套用餐宿默认。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/tools/job-list/render.util.ts#render`
- 落点：`src/tools/job-list/welfare-facts.util.ts#extractWelfareFacts`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/tools/job-list/render.util.spec.ts`
- 验证：`tests/tools/job-list/welfare-facts.util.spec.ts`

## SW-09 岗位薪资主数

卡片、摘要与记忆共用主数解析：兼职优先基础金额，其他用工形式优先综合金额；单位缺失不补计薪周期，正式方案优先。仅附属方案时的现有回退需如实记录。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/duliday-job-list.tool.ts#buildJobListTool`
- 落点：`src/tools/job-list/render.util.ts#render`
- 落点：`src/tools/job-list/salary-display.util.ts#resolveSalaryHeadline`
- 验证：`tests/tools/job-list/candidate-card.util.spec.ts`
- 验证：`tests/tools/job-list/render.util.spec.ts`
- 验证：`tests/tools/job-list/salary-display.util.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- 不同品牌/项目的时薪、综合薪资和区间偏好历史上存在分歧。用户本次明确不做配置化，保留当前统一规则，不新增配置入口。
- 阶梯累计周期：工具描述采用每自然月清零口径，而历史待办提示 perTimeUnit 存在差异；未重新取证前不自行改算法。
- 薪资主数说明曾写“只取正式方案”，实际实现全是培训/试用方案时退回第一条。本次按实现记录回退，不宣称已批准该边界。
- 2026-10-23 测试环境冒烟（批次 `789f0e74-794f-4e44-856a-92f8febcfd94`，执行 `a44ec4cf-3b34-4fd7-b316-c3f3d20f2c04`）：本人银行卡主口径正确，但回复额外承诺“柜台当天能拿到”“办好之后报名入职都不受影响”。已核对实际 instructions/messages、记忆、工具与守卫：这些保证无输入依据，本轮无工具，守卫放行；业务评审记 failed。此次保持模型正文不变，仅记录质量缺口，不把该回复纳入正式口径，也不据此推断重构导致回归。

## 变更记录

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
