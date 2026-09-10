# Guardrail 质量体系

**最后更新**：2026-09-10（按当前规则、修复所有权与目录复核）

> 本文描述当前 Output 守卫的实时裁决和修复边界。Input / Prompt / Tool / Output 全景见
> [安全护栏说明](./security-guardrails.md)。

## 1. 当前实时链

```text
Prompt 生成首版
  → Tool gate 已约束本轮动作
  → Runner 剥离时间标记
  → OutputGuardrailService
      ├─ 精确分段去重
      └─ HardRulesService：格式、封闭高风险词形、工具回执对账
  → pass / observe：跳过修复
  → 需要修复时，Runner 按 repairMode 执行最多一次：
      ├─ rewrite：确定性最小修复，或 ReplyRepairAgent 无工具局部重写
      └─ replan：首版无已提交副作用时，同参数重进 Generator
      两路 → 同一确定性 Output guard 二审
          → 适用的修复回归检查
          → resolution：reply（含有记录的 fail-open）/ handoff / skipped
  → OutboundReplySanitizer
  → TurnOutcome 分类
  → Replay 定局
  → 投递 / TurnOutcomeInterventionService.commit 提交人工介入
  → TurnFinalizer 按投递结局收尾记忆
```

Output 不调用第二个评审模型，也没有 semantic shadow/enforce 分支。主 Agent 负责开放对话语义；
Output 只对可复算信号裁决。
重生成若由真实工具明确短路为 `handoff/skipped`，优先保留工具终态，不伪造二审；纯无工具空产物仍按修复失败处理。
空文本、悬空承接句或特定违规可以提前收敛；图中二审与回归检查表示常规有效修复产物的处理链。
审查结果只描述实际审过的草稿；Runner 另用 `resolution: { outcome: reply | handoff | skipped, reasonCode? }`
表达处置。Trace 的 `finalOutcome` 记录处置结果；advisory 只有审查结果，不伪造最终处置。

## 2. 当前规则面

`output/output-rule-catalog.ts` 是 Output 规则与默认处置的唯一来源，当前 24 条（19 执行档 + 5 observe 哨兵）：

| 类别                         | ruleId                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 格式/内部泄漏                | `invalid_model_output`、`internal_output_leak`、`meta_narration_reply`、`human_service_phrase_leak`                                                                           |
| 封闭高风险                   | `identity_misregistration_coaching`、`experience_fraud_coaching`、`discriminatory_screening_leak`、`sensitive_origin_probe`、`quota_promise`                                  |
| 工具回执/状态对账            | `online_interview_location_claim`、`unsupported_store_status_speculation`、`booking_receipt_mismatch`、`interview_slot_availability_mismatch`、`interview_time_change_unconfirmed`、`brand_alias_fuzzy_match_ignored`、`booking_done_claim_no_work_order`、`cancel_done_claim_failed_tool` |
| 查询/岗位事实来源（replan）  | `job_query_claim_without_query`、`job_fact_without_provenance` |
| observe 哨兵（只落档不拦截） | `requested_brand_mismatch`、`settlement_cycle_mismatch`、`proactive_insurance_policy_mention`、`booking_done_claim_without_submission`、`cancel_done_claim_without_submission` |

当前目录包含 2026-08-26 数据复核恢复的定点哨兵和后续完成态对账规则；
`dangling_reply_promise` 已于 2026-09-07 退场，判别改由离线回扫承接。这些规则不代表开放语义
审查恢复；新规则仍一律 observe 入场，升档须 ≥2 周判例且精确率
≥90%。既有运行时 override 仅兼容 `off | observe` 降档；它不允许增加规则或提高权限。
聚合顺序为 `replan > repair > observe > pass`。规则动作包括 observe / repair / replan；`job_query_claim_without_query`、`job_fact_without_provenance` 是当前仅有的
replan 档——它们的问题不是文案而是"该发生的查询没发生"。

旧审查值 revise / block 均对应当前 repair；原 block 的严格拒发属性独立保存为 `allowFailOpen: false`，
`recoverability` 仅供旧记录解释，不参与运行时判定。旧记录保留原值，按审查阶段与最终处置分别读取。

仅有 observe 命中时，Output 保留 `ruleIds` 并以 `pass` 返回；Runner 不为观察命中启动修复。

精确重复由确定性清洗处理，不占用 Output ruleId：`OutboundReplySanitizer.pruneRepeatedSegments()` 只删除与近期真实投递
段落在去空白标点后全等的长段落；候选人明确要求重发时不删，不做相似度判断。

handoff 承诺也不登记 Output ruleId：`turn-outcome.ts` 将封闭承诺词形与本轮成功
`request_handoff`/托管暂停副作用对账，缺失时生成既有 `general_handoff` side effect。

## 3. 修复边界

repair 是 Output 裁决后的有界收敛；回归检查和 Runner 恢复分支由各自实现与行为测试维护：

- 最多修复一次；
- 格式残留优先机械删除或拆封，保留正文；
- `ReplyRepairAgent` 只修改命中局部，不拥有业务工具；
- 无工具重写不得新增证据未覆盖的岗位、薪资、门店、地址、时间、预约状态或政策事实；
- rewrite 版使用首版工具轨迹二审；replan 版使用重生成版自己的工具轨迹二审；
- regression gate 保留结构坍缩、岗位极性反转、日期星期改错和已完成 booking 被降级为待办的检查；
- 机械剥离/拆封仍须二审，但逐字保留或提取正文，跳过回归比较；
- rewrite 仍有 P0 高风险或 `allowFailOpen: false` 的违规时转人工；只剩允许 fail-open 的 P1/P2 且二审未要求 replan 时，才按既有规则留档放行；即使首版走 rewrite，二审 `repairMode=replan` 也禁止作为低风险残留放行。

守卫由规则 action 派生 repairMode；Runner 依据 repairMode 选择路径，并结合副作用、机械修复
条件与风险策略收敛：

- rewrite（可执行命中未要求 replan）：优先确定性剥离/拆封，或由 ReplyRepairAgent 无工具局部重写；
- replan（replan 档派生）：首版整体作废，用**完全相同的参数**再调一次 Generator——
  不注入守卫反馈、不裁工具集；重生成结果按修复版走二审与 regression gate，首版永不回退，
  二审不 fail-open，仍不过则以 `replan_exhausted` 转人工。regression gate 对 replan 档首版
  跳过结构坍缩与极性反转检查（首版的岗位事实本身就是违规内容）。执行层唯一守门：首版已提交
  副作用时拒绝重进 Generator，降级 rewrite 并告警。

replan 的语义自 2026-07-03 契约首版起就是"重走工具再生成"。2026-07-03～07-27 的旧实现走偏成
带守卫反馈重进 Generator 并裁工具集（改目标函数、砍事实来源，叠加即"更合规外观的更糟输出"），
07-27 物理删除；2026-09-09 以原意重新占位。规则不得再声明 `repairToolNames`；修复不得重新
执行副作用。档案里 2026-07-27 之前 `repair_mode='replan'` 的行属于旧实现。

首审直达处置仍保留封闭例外：仅元叙述旁白时 `skipped`，保留工具意图且不新增人工介入；
仅内部泄漏且全文为推理/工具调用残文时直接 `handoff`。混合命中仍走常规修复。修复为空、
悬空或出现回归时，按既有首版放行资格回退，否则转人工，不伪造一次未发生的二审。

## 4. 组件所有权

| 组件                             | 可以做什么                                            | 不能做什么                 |
| -------------------------------- | ----------------------------------------------------- | -------------------------- |
| `HardRulesService`               | 读取回复、memory 和工具回执，产出确定性 contradiction | 改文案、调工具、猜开放语义 |
| `OutputGuardrailService`         | 精确去重、运行规则、聚合裁决并派生 repairMode         | 调第二个模型、执行修复、提交副作用 |
| `AgentRunnerService`             | 按守卫派生的 repairMode 执行一次修复（rewrite / replan），二审并收敛 outcome | 在 rewrite 中重跑业务工具、带反馈重进 Generator |
| `RepairEvidenceBuilder`          | 将工具事实与策略投影为 `RepairEvidencePacket`，供 ReplyRepairAgent 组装修复输入 | 裁决是否放行、取代规则证据对账 |
| `ReplyRepairAgent`               | 消费修复证据与上下文，执行无工具局部重写             | 调业务工具、决定修复次数或最终投递 |
| `TurnOutcomeInterventionService` | Replay 定局后提交暂停托管、handoff 和告警             | 重新解释回复语义           |
| `TurnFinalizer`                  | 按投递结局执行或丢弃 `runTurnEnd`，等待记忆落盘       | 提交人工介入、重执行业务工具 |

物理目录按所有权划分：

```text
agent/guardrail/output/
  output-guardrail.service.ts       # 出站审查门面
  output-rule.types.ts              # 规则公共契约
  output-rule-catalog.ts            # 规则元数据与默认策略
  rules/                           # hard-rules.service、*.rule、job-fact-signals
  sanitizer/                       # outbound-reply-sanitizer，确定性清洗
agent/reply-repair/
  reply-repair.agent.ts             # 无工具修复模型
  reply-repair-context.provider.ts  # 修复上下文读取与投影
  repair-evidence.builder.ts        # RepairEvidenceBuilder / BuildRepairEvidenceInput
  repair-evidence.types.ts          # RepairEvidencePacket 与证据类型
  repair-regression.util.ts         # 首版与修复版的确定性回归比较
agent/runner/
  agent-runner.service.ts           # 修复预算、路径资格、恢复判据与理由码
```

`RepairEvidenceBuilder` 由 `AgentModule` 注册，`GuardrailModule` 不提供或导出它。
证据包是修复输入，Output 直接基于规则输入对账；目录中不再保留 `output/llm/`。
证据数据形状、规则匹配条件和修复 Prompt 保持不变。

### 聚合目录与定义所有权

Catalog 仅管理可独立识别与治理的规则。保留 Input、Tool、Output 三份子目录，
`guardrail/catalog.ts` 按这三个执行层聚合审计，不再手写 Output 源码映射或 Input 服务级占位项。

- Input：20 个注入模式与 5 类风险直接由执行器消费目录定义，保留原匹配顺序。
- Output：24 条默认策略集中定义；检测函数保留匹配和证据对账，默认动作不在检测器重复写。
  改约/预约的场景化反馈可引用本轮真实时间，但必须显式声明 `feedbackSource: 'per_hit'`。
- Tool：从现有工具门禁清单聚合，执行仍在 tools / resolution；目录不声称枚举了工具内全部参数校验。

修复回归直接看 `reply-repair/repair-regression.util.ts`，恢复分支直接看
`runner/agent-runner.service.ts`，清洗直接看 `output/sanitizer/outbound-reply-sanitizer.ts`，
并结合各自行为测试理解。回归结果、恢复理由码和判据、清洗步骤均在所属实现中维护，不另设登记目录。

Input 行为探针和 Output 源码/调度审计验证执行与定义的一致性；根目录测试验证三层聚合、
全局 ID 和实现/测试文件存在。不能把同一目录派生的两个 ID 列表互相比对当作执行覆盖证明。

## 5. 记录面

- `message_processing_records.guardrail_output`：回合级紧凑摘要；
- `guardrail_review_records`：确定性规则命中、首版/修复版与最终裁决；历史
  `semantic_reviews` 字段只作存量数据兼容，没有新的生产者；
- `TurnOutcome.outputGuardrail`：保留真实审查结果；Runner resolution 与 Trace `finalOutcome` 表达最终处置。

聚合目录用于代码审计，不生成新的线上 ruleId 事件，也不改变 Dashboard 或人工标注流程。

## 6. 维护纪律

1. 新规则必须有封闭词形或结构化外生信号，不能用正则猜开放语义；
2. 通过 `createOutputRuleFinding(ruleId, label, feedback?)` 生成命中，默认 action / severity / allowFailOpen / feedback 由目录提供；未登记 ID 明确抛错，只有声明 `per_hit` 的规则允许动态反馈；
3. 执行源码与目录双向校验：检测入口、FactRule、HardRules 调度、来源路径都必须对应，负例必须证明漏登记、孤立条目、未调度规则及默认动作覆盖会失败；
4. Prompt 教侧配对变化同步更新 [Prompt 规则台账](../prompt-rule-ledger.md)；
5. 对话理解问题优先修主 Agent Prompt、既有抽取标签或工具契约；
6. precheck 只暴露统一 `fieldValueProposals`，字段全集与标签原文由岗位契约负责，不在 Output 修补。

## 相关代码

- [Output 审查门面](../../src/agent/guardrail/output/output-guardrail.service.ts)
- [确定性规则编排](../../src/agent/guardrail/output/rules/hard-rules.service.ts) / [规则目录](../../src/agent/guardrail/output/output-rule-catalog.ts)
- [最终清洗](../../src/agent/guardrail/output/sanitizer/outbound-reply-sanitizer.ts)
- [修复证据构建](../../src/agent/reply-repair/repair-evidence.builder.ts) / [证据契约](../../src/agent/reply-repair/repair-evidence.types.ts)
- [修复模型](../../src/agent/reply-repair/reply-repair.agent.ts) / [修复上下文](../../src/agent/reply-repair/reply-repair-context.provider.ts) / [回归闸](../../src/agent/reply-repair/repair-regression.util.ts)
- [Runner](../../src/agent/runner/agent-runner.service.ts) / [Outcome 分类](../../src/agent/runner/turn-outcome.ts)
- [人工介入提交](../../src/agent/runner/turn-outcome-intervention.service.ts) / [记忆收尾](../../src/agent/runner/turn-finalizer.ts)
