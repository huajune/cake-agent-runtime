# 面试与报名（IB）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## IB-01 预检先于预约

收资与预约须先取得预检结论，按工具契约处理筛选题、健康证、班次与待收字段；不绕过预检直接提交。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-01`
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/tools/duliday-interview-booking.tool.ts#buildInterviewBookingTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-booking.tool.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#booking_precheck_contract`
- 验证：`tests/agent/guardrail/catalog.spec.ts`

## IB-02 不保留名额或保证未来可约

无保留名额能力时只说明当前查询状态；候选人需办证或远途出行时提示岗位和时段可能变化，未提交成功不能保证未来约得上。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-02`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#quota_promise`
- 落点：`src/agent/guardrail/output/rules/false-promises.rule.ts#FALSE_PROMISE_RULES`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#quota_reservation_promise`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## IB-03 先报名再到店

未报名约面时不鼓励自行到店；说明流程后尊重候选人是否报名的决定，明确拒绝报名时不催促或提供到店找人话术。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-03`
- 落点：`src/tools/send-store-location.tool.ts#buildSendStoreLocationTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/send-store-location.tool.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#walkin_without_signup_closure`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## IB-04 报名成功与失败的真实回执

只凭真实预约结果确认成功。失败原因没有证据时不猜；候选人只要当前结果且拒绝后续动作时，答完即结束。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-04`
- 落点：`src/tools/duliday-interview-booking.tool.ts#buildInterviewBookingTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#booking_receipt_mismatch`
- 落点：`src/agent/guardrail/output/rules/booking-receipt.rule.ts#detectBookingReceiptMismatch`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#booking_done_claim_without_submission`
- 落点：`src/agent/guardrail/output/rules/booking-claim-reconciliation.rule.ts#detectBookingDoneClaimWithoutSubmission`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-booking.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/booking-claim-reconciliation.rule.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#future_booking_promise_grounding`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## IB-05 不臆测门店状态或改派面试

门店名称不能证明开业或筹建状态；面试形式和地点以预检与预约结果为准，不据猜测改派。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-05`
- 落点：`src/tools/send-store-location.tool.ts#buildSendStoreLocationTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#unsupported_store_status_speculation`
- 落点：`src/agent/guardrail/output/rules/store-status-speculation.rule.ts#detectUnsupportedStoreStatusSpeculation`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/send-store-location.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`

## IB-06 面试形式与AI完成时限

按工具区分AI、电话、视频和线下，线上不可跳过或改到店。AI收到真实通知后可在规定时限内自主完成；线下、电话、视频仍按约定时间。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-06`
- 落点：`src/sponge/interview-method.ts#parseInterviewMethod`
- 落点：`src/tools/send-store-location.tool.ts#buildSendStoreLocationTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#online_interview_location_claim`
- 落点：`src/agent/guardrail/output/rules/online-interview-location.rule.ts#detectOnlineInterviewLocationClaim`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/sponge/interview-method.spec.ts`
- 验证：`tests/tools/tool/send-store-location.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`
- 落点：`src/agent/generator/context/sections/semantic/memory.section.ts#BOOKING_CONTEXT_SHARED_RULES`
- 验证：`tests/agent/generator/context/sections/memory.section.spec.ts`

## IB-07 应聘工种须本人认可

同店多个工种或岗位有工种划分时，提交前确认候选人选择，不替其选择。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-07`
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/tools/duliday-interview-booking.tool.ts#buildInterviewBookingTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-booking.tool.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#booking_jobid_provenance`
- 验证：`tests/agent/guardrail/catalog.spec.ts`

## IB-08 整表收资与插问承接

按预检返回的待收字段一次性发出；已知值由官方模板预填，插问岗位细节先回答再提醒缺项，不复制整表重复收集。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-08`
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/tools/collection/collection-form.service.ts#CollectionFormService`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`
- 验证：`tests/tools/collection/collection-form.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#submitted_form_no_refill`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## IB-09 改约与窗口外时间冲突

改日期先核实可约时段再提交改约，成功前不确认已改。反复明确只能在窗口外参加时转人工申请，不持续劝请假或口头协调。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/ib.md#IB-09`
- 落点：`src/tools/duliday-modify-interview-time.tool.ts#buildModifyInterviewTimeTool`
- 落点：`src/tools/request-handoff.tool.ts#buildRequestHandoffTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#interview_time_change_unconfirmed`
- 落点：`src/agent/guardrail/output/rules/booking-receipt.rule.ts#detectBookingReceiptMismatch`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/duliday-modify-interview-time.tool.spec.ts`
- 验证：`tests/tools/request-handoff.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/hard-rules.service.spec.ts`
- 落点：`src/agent/generator/context/sections/semantic/memory.section.ts#BOOKING_CONTEXT_SHARED_RULES`
- 验证：`tests/agent/generator/context/sections/memory.section.spec.ts`

## IB-10 报名截止与可约窗口

按完整日期时间判断报名截止和可约时段；不把完成时限、报名截止、工单时间或到达窗口混为一谈。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/tools/duliday-interview-booking.tool.ts#buildInterviewBookingTool`
- 落点：`src/tools/booking/interview-window.util.ts#findSameDayCutoffViolation`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#interview_slot_availability_mismatch`
- 落点：`src/agent/guardrail/output/rules/interview-slot-availability.rule.ts#detectInterviewSlotAvailabilityMismatch`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-booking.tool.spec.ts`
- 验证：`tests/tools/booking/interview-window.util.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/interview-slot-availability.rule.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#interview_date_precheck_first`
- 验证：`tests/agent/generator/context/context.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#interview_time_only_precheck_first`
- 落点：`src/agent/generator/context/sections/semantic/memory.section.ts#BOOKING_CONTEXT_SHARED_RULES`
- 验证：`tests/agent/generator/context/sections/memory.section.spec.ts`

## IB-11 多人报名逐人确认与提交

下一人先以其手机号预检取得官方核对信息，再单独确认与提交；第一人的成功工单不证明第二人已报名。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/duliday-interview-precheck.tool.ts#buildInterviewPrecheckTool`
- 落点：`src/tools/duliday-interview-booking.tool.ts#buildInterviewBookingTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#booking_done_claim_no_work_order`
- 落点：`src/agent/guardrail/output/rules/booking-claim-reconciliation.rule.ts#detectBookingDoneClaimWithoutSubmission`
- 验证：`tests/tools/tool/duliday-interview-precheck.tool.spec.ts`
- 验证：`tests/tools/tool/duliday-interview-booking.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/booking-claim-reconciliation.rule.spec.ts`

## IB-12 取消与工单归属

取消或改约须校验本人、岗位和工单归属，只有动作成功才确认已完成；换店不自动代表旧单已取消。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/duliday-modify-interview-time.tool.ts#buildModifyInterviewTimeTool`
- 落点：`src/tools/duliday-cancel-work-order.tool.ts#buildCancelWorkOrderTool`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#cancel_done_claim_without_submission`
- 落点：`src/agent/guardrail/output/rules/booking-claim-reconciliation.rule.ts#detectCancelDoneClaimWithoutSubmission`
- 落点：`src/agent/guardrail/output/output-rule-catalog.ts#cancel_done_claim_failed_tool`
- 验证：`tests/tools/duliday-modify-interview-time.tool.spec.ts`
- 验证：`tests/tools/duliday-cancel-work-order.tool.spec.ts`
- 验证：`tests/agent/guardrail/output/rules/booking-claim-reconciliation.rule.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#cancel_work_order_ownership`
- 验证：`tests/agent/guardrail/catalog.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#modify_work_order_ownership`
- 落点：`src/agent/generator/context/sections/semantic/memory.section.ts#BOOKING_CONTEXT_SHARED_RULES`
- 验证：`tests/agent/generator/context/sections/memory.section.spec.ts`

## IB-13 复聊提醒与回访

复聊使用独立链路：按实际工单、真人来源和候选人诉求判断是否提醒或停止。仅到店面试适用聊天约定时间不一致闸；AI完成截止不当成改约时间。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/reengagement/reengagement.agent.ts#buildSystemPrompt`
- 落点：`src/agent/reengagement/scenario-registry.ts#generationPolicy`
- 验证：`tests/agent/reengagement/reengagement.agent.spec.ts`
- 验证：`tests/agent/reengagement/scenario-registry.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- AI 面试提醒目前仍使用工单钟点；是否改用通知截止时间，历史台账 RE8 明确待裁定。本次不改变提醒文案或调度。
- 换店是否自动取消旧单属于新业务行为；当前按取消工具契约执行，不由重构推导为自动取消。

## 变更记录

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
