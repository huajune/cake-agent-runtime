# 地理与城市（GEO）

仓库业务口径与行为索引；运行时文字在对应源文件。首次归档以本分支基线为准，未把源码存在或单测通过当作新业务裁定、真实 Agent 验证或上线证明。

## GEO-01 位置召回与城市消歧

位置分享直接使用经纬度；文字地点先解析位置，已确认城市必须带入。通用地名按工具的歧义结果澄清，不重复问已确认的城市。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/geo.md#GEO-01`
- 落点：`src/tools/geocode.tool.ts#buildGeocodeTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/geocode.tool.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#distance_number_grounding`
- 验证：`tests/agent/generator/context/context.service.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#location_reference_needs_grounding`

## GEO-02 工作地址与面试地址

明确具体岗位后发送对应定位。进行中的线下面试默认使用面试地址；线上或形式未知不发送面试定位，工作门店地址不能替代面试地址。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/geo.md#GEO-02`
- 落点：`src/tools/send-store-location.tool.ts#buildSendStoreLocationTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/send-store-location.tool.spec.ts`
- 落点：`src/agent/generator/context/sections/procedural/final-check.section.ts#store_location_send_consistency`
- 验证：`tests/agent/generator/context/context.service.spec.ts`

## GEO-03 城市改变先核实

候选人坚持另一个城市时停止旧城市流程，确认实际位置后重新查岗，不能当作笔误继续收资。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/agent/generator/context/sections/procedural/rules/geo.md#GEO-03`
- 落点：`src/tools/geocode.tool.ts#buildGeocodeTool`
- 验证：`tests/agent/generator/context/manual-loader.spec.ts`
- 验证：`tests/tools/tool/geocode.tool.spec.ts`

## GEO-04 城市来源与定位可信度

候选人明确位置与工具解析证据可用于查岗和邀群；昵称/备注城市只用于求证，冲突位置先澄清；机制实现保留在地理解析域。

- 状态：现行基线
- 来源：`docs/prompt-rule-ledger.md`；下列当前实现及其原始裁定/BadCase 注释（未补造裁定人或日期）。
- 落点：`src/tools/geocode.tool.ts#buildGeocodeTool`
- 落点：`src/tools/invite/invite-city-gate.ts`
- 验证：`tests/tools/tool/geocode.tool.spec.ts`
- 验证：`tests/tools/invite/invite-city-gate.spec.ts`
- 落点：`src/agent/guardrail/tool/tool-guardrail.catalog.ts#invite_city_provenance`
- 验证：`tests/agent/guardrail/catalog.spec.ts`

## 验证边界

`manual-loader.spec.ts` 验证拆分前后模型可见文案等价、加载完整和失败行为；其他链接是已有局部契约测试，不能据此宣称整条业务已通过真实 Agent 回归。最近实际执行结果见 PR 验证记录。

## 未决与冲突

- 地名、城市来源与字段信任等级由地理解析域维护；本主题不新增词表或把昵称城市升级为已确认位置。

## 变更记录

- 2026-10-23：首次按主题建立口径、执行落点与验证关联；机械拆分手册，保持文案与顺序；不新增业务裁定。
