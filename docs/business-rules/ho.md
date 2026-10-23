# 人工介入边界（HO）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## HO-01 真人沟通期间的静默

真人正在沟通且候选人仅回应真人、没有新诉求时保持静默；不把旁白、思考过程或静默说明发给候选人。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ho.md#HO-01`
- 落点：`src/agent/reengagement/reengagement.agent.ts#buildSystemPrompt`
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/agent/reengagement/reengagement.agent.spec.ts`
- 验证：`tests/tools/request-handoff.tool.spec.ts`

## HO-02 招聘方身份

对外使用独立客名称，旧名与英文别名属于同一主体。说明身份仍须遵循真实业务字段，不能借身份介绍主动承诺保险。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ho.md#HO-02`
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#human_service_phrase_leak`
- 落点：`src/agent/guardrail/output/rules/internal-info-leaks.rule.ts#detectHumanServicePhraseLeak`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/request-handoff.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.restored-sentinels.spec.ts`

## HO-03 面试后事项交真人

追问面试结果、历史面试、未通过原因或录取时立即转相应人工场景，不倒退荐岗、收资或重新报名；面试前提醒仍可进行。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ho.md#HO-03`
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/request-handoff.tool.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#post_interview_no_rebook`
- 验证：`tests/agent/generator/context/context.service.spec.ts`
- 落点：`src/agent/generator/context/sections/semantic/memory.section.ts#BOOKING_CONTEXT_SHARED_RULES`
- 验证：`tests/agent/generator/context/sections/memory.section.spec.ts`

## HO-04 人工原因与提交边界

按岗位缺字段、个人账务、改约、面试结果等真实场景选择原因；真人接管与通知由统一出口提交，模型不得以口头转交代替实际动作。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 验证：`tests/tools/request-handoff.tool.spec.ts`

- 落点：`src/agent/guardrail/input/input-rule-catalog.ts#defineInputRiskRule`
- 验证：`tests/agent/guardrail/input/risk-intercept.service.spec.ts`

## HO-05 招聘身份与不收费说明

对“是不是中介、收不收费”直接说明当前固定口径：独立客招聘经理、直接对接门店不收取费用、就近分配；答复保持简洁，不重复上轮无关结论。固定口径归档不替代真实性裁定。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；原手册关于招聘方身份和费用的既有条款及 BadCase 注释。
- 落点：`src/agent/generator/context/sections/procedural/rules/ho.md#HO-05`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- DB 中现有红线与阶段策略是运行时输入；本次不读取或改写生产配置，文档不保证生产文本与仓库完全一致。冲突须记录具体配置版本再裁定。

## 变更记录

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
