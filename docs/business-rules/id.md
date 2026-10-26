# 身份与门槛（ID）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## ID-01 昵称、真名与身份事实

加好友验证语和昵称不作为年龄、性别、城市等身份事实。登记使用候选人确认的姓名，不因少见姓名形态判假，也不把姓名当称呼反复复述。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-01`
- 落点：`src/resolution/candidate/identity-attribution.ts#evaluateBookingNameGate`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/resolution/candidate/identity-attribution.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#booking_real_name`
- 验证：`tests/agent/guardrail/catalog.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#no_internal_terms_no_nickname`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## ID-02 性别来源与确认

本人自陈可用于筛选，系统兜底性别仅供预填并等待确认；不把弱来源当作拒绝或预约依据，不为确认性别拆开整张收资表。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-02`
- 落点：`src/tools/collection/collection-form.service.ts#CollectionFormService`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/collection/collection-form.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#gender_self_report_check`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## ID-03 健康证要求与办理

餐饮需食品健康证，办理阶段按具体岗位；电子与纸质形式同等，默认本地证。费用默认自费约100元、不免费、不报销，岗位明确支持报销时按字段答。疑问不代表已持证或愿意办证。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-03`
- 落点：`src/resolution/candidate/health-cert-eligibility.ts`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#health_cert_general_answer`
- 验证：`tests/agent/generator/context/context.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#health_cert_is_not_major`

## ID-04 不补造候选人资料

未提供的字段留空或追问，不能把岗位年龄范围、默认值或他人信息写成候选人资料。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-04`
- 落点：`src/tools/collection/collection-form.service.ts#CollectionFormService`
- 落点：`src/resolution/candidate/identity-attribution.ts#evaluateBookingNameGate`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/collection/collection-form.service.spec.ts`
- 验证：`tests/resolution/candidate/identity-attribution.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#booking_name_authority`
- 验证：`tests/agent/guardrail/catalog.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#bare_number_reply_is_age_first`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## ID-05 用工形式与季节身份

全职、兼职及兼职子类型按结构化字段。明确只要暑假工时不主动降级；身份改口须来自候选人，不诱导其回答指定答案。转全职政策缺字段时转人工。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-05`
- 落点：`src/resolution/labor-form/index.ts`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#identity_misregistration_coaching`
- 落点：`src/agent/guardrail/output/rules/identity-fraud-coaching.rule.ts#detectIdentityMisregistrationCoaching`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`

## ID-06 公开门槛先筛后推

已知身份、年龄或性别不符时不推荐或收资；身份未知时先确认身份再发其余资料。年龄边界依预检结论处理，内部筛选数值不对外披露。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-06`
- 落点：`src/tools/collection/collection-form.service.ts#CollectionFormService`
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#student_acceptance_contradiction`
- 落点：`src/agent/guardrail/output/rules/student-acceptance.rule.ts#detectStudentAcceptanceContradiction`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/collection/collection-form.service.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-precheck.age-boundary.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/student-acceptance.rule.spec.ts`

## ID-07 不指导身份或经历造假

候选人提出或承认造假时引导如实说明和自行更正，不保证不核查或无影响；没有修改报名表的工具时不承诺代改。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-07`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#experience_fraud_coaching`
- 落点：`src/agent/guardrail/output/rules/experience-fraud-coaching.rule.ts#detectExperienceFraudCoaching`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`

## ID-08 敏感筛选与拒绝终态

内部敏感条件不主动询问或披露；正式筛选拒绝后当前岗位保持终态，参数或证据错误可补正。现存中性拒绝与状态证据冲突见本主题未决项。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-08`
- 落点：`src/tools/collection/collection-form.service.ts#CollectionFormService`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#discriminatory_screening_leak`
- 落点：`src/agent/guardrail/output/rules/discrimination-leaks.rule.ts#DISCRIMINATION_LEAK_RULES`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#sensitive_origin_probe`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/collection/collection-form.service.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#residency_gate_no_leak`
- 验证：`tests/agent/generator/context/context.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#tattoo_self_report_soft_decline`

## ID-09 截图与第三方信息的边界

截图岗位事实可能过期，须查当前工具；发布方联系方式不属于候选人，截图中其他人员姓名、联系方式和面试安排不复述。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/id.md#ID-09`
- 落点：`src/resolution/candidate/identity-attribution.ts#evaluateBookingNameGate`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/resolution/candidate/identity-attribution.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- 敏感条件拒绝时的“以岗位已招满等中性理由说明”与不编造门店状态的规则存在冲突。重构保留原文并显式登记；2026-10-23 用户明确裁定本次只登记冲突、重构保持当前行为；是否修改该拒绝口径另行讨论。
- 学生身份改口是否永久锁定，历史积压仍有收紧诉求；当前按本人陈述与既有核实流程执行，不自动升级为锁定。

## 变更记录

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
