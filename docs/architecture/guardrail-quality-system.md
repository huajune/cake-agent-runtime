# Guardrail 质量体系

**最后更新**：2026-08-26

> 本文描述当前 Output 守卫的实时裁决和修复边界。Input / Prompt / Tool / Output 全景见
> [安全护栏说明](./security-guardrails.md)。

## 1. 当前实时链

```text
Prompt 生成首版
  → Tool gate 已约束本轮动作
  → OutputGuardrailService
      ├─ 精确分段去重
      └─ HardRulesService：格式、封闭高风险词形、工具回执对账
  → pass / observe：进入 outcome 分类
  → revise / block：
      ├─ 可机械删除的泄漏做确定性最小修复
      └─ ReplyRepairAgent 无工具局部重写，hard cap = 1
          → 同一确定性 Output guard 二审
          → repair regression gate
          → pass / 有记录的 fail-open / guardrail_blocked
  → OutboundReplySanitizer
  → Replay 定局
  → 投递或提交 handoff/暂停托管副作用
```

Output 不调用第二个评审模型，也没有 semantic shadow/enforce 分支。主 Agent 负责开放对话语义；
Output 只对可复算信号裁决。

## 2. 当前规则面

`output/rules/output-rule-catalog.ts` 是唯一运行目录，当前 19 条（14 执行档 + 5 observe 哨兵）：

| 类别 | ruleId |
| --- | --- |
| 格式/内部泄漏 | `invalid_model_output`、`internal_output_leak`、`meta_narration_reply`、`human_service_phrase_leak` |
| 封闭高风险 | `identity_misregistration_coaching`、`experience_fraud_coaching`、`discriminatory_screening_leak`、`sensitive_origin_probe`、`quota_promise` |
| 工具回执对账 | `online_interview_location_claim`、`unsupported_store_status_speculation`、`booking_receipt_mismatch`、`interview_time_change_unconfirmed`、`brand_alias_fuzzy_match_ignored` |
| observe 哨兵（只落档不拦截） | `dangling_reply_promise`、`requested_brand_mismatch`、`settlement_cycle_mismatch`、`proactive_insurance_policy_mention`、`booking_done_claim_without_submission` |

observe 哨兵是 2026-08-26 数据复核恢复的定点回补（人设露馅升执行档、四族有信号量的哨兵
落档），不是开放语义规则的整体回归；新规则仍一律 observe 入场，升档须 ≥2 周判例且精确率
≥90%。既有运行时 override 仅兼容 `off | observe` 降档；它不允许增加规则或提高权限。
聚合顺序仍为 `block > revise > observe > pass`。

精确重复不登记 ruleId：`OutboundReplySanitizer.pruneRepeatedSegments()` 只删除与近期真实投递
段落在去空白标点后全等的长段落；候选人明确要求重发时不删，不做相似度判断。

handoff 承诺也不登记 Output ruleId：`turn-outcome.ts` 将封闭承诺词形与本轮成功
`request_handoff`/托管暂停副作用对账，缺失时生成既有 `general_handoff` side effect。

## 3. 修复边界

repair 是 Output 裁决后的有界收敛，不是新的 guardrail 层：

- 最多修复一次；
- 格式残留优先机械删除或拆封，保留正文；
- `ReplyRepairAgent` 只修改命中局部，不拥有业务工具；
- 不得新增岗位、薪资、门店、地址、时间、预约状态或政策事实；
- 修复版使用相同工具轨迹再过一次确定性二审；
- regression gate 保留结构坍缩、岗位极性反转、日期星期改错和已完成 booking 被降级为待办的检查；
- P0/不可恢复问题仍不合格时 block；只剩可恢复 P1/P2 时按既有规则留档 fail-open。

`replan` 已退役；修复不得重进 Generator 或重新执行副作用。

## 4. 组件所有权

| 组件 | 可以做什么 | 不能做什么 |
| --- | --- | --- |
| `HardRulesService` | 读取回复、memory 和工具回执，产出确定性 contradiction | 改文案、调工具、猜开放语义 |
| `OutputGuardrailService` | 精确去重、运行规则并形成 pass/revise/block | 调第二个模型、提交副作用 |
| `AgentRunnerService` | 选择一次确定性/LLM 局部修复，二审并收敛 outcome | 在 repair 中重跑业务工具 |
| `TurnOutcomeInterventionService` | Replay 定局后提交暂停托管、handoff 和告警 | 重新解释回复语义 |

## 5. 记录面

- `message_processing_records.guardrail_output`：回合级紧凑摘要；
- `guardrail_review_records`：确定性规则命中、首版/修复版与最终裁决；历史
  `semantic_reviews` 字段只作存量数据兼容，没有新的生产者；
- `TurnOutcome.outputGuardrail`：渠道投递前的最终裁决事实。

本链路不新增观测项、Dashboard、shadow diff、自动 Rule Catalog 或人工标注流程。

## 6. 维护纪律

1. 新规则必须有封闭词形或结构化外生信号，不能用正则猜开放语义；
2. ruleId 与现有 output catalog 双向一致，单测覆盖真阳和主要假阳；
3. Prompt 教侧配对变化同步更新 [Prompt 规则台账](../prompt-rule-ledger.md)；
4. 对话理解问题优先修主 Agent Prompt、既有抽取标签或工具契约；
5. precheck `candidateClaims/formAnswers` 由独立改造负责，不在 Output 修补。

## 相关代码

- `src/agent/guardrail/output/output-guardrail.service.ts`
- `src/agent/guardrail/output/hard-rules.service.ts`
- `src/agent/guardrail/output/rules/output-rule-catalog.ts`
- `src/agent/guardrail/output/repair-regression.util.ts`
- `src/agent/guardrail/output/outbound-reply-sanitizer.ts`
- `src/agent/runner/agent-runner.service.ts`
- `src/agent/runner/turn-outcome.ts`
- `src/agent/reply-repair/reply-repair.agent.ts`
