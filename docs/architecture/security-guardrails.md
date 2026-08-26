# 安全护栏说明

**最后更新**：2026-08-26（按当前 Prompt 装配、guardrail catalog、Runner outcome 与 repair 链核实）

> 定位：本文是安全防线的技术入口。运行时共有 **Input / Prompt / Tool / Output 四个防线作用位**；
> 其中 Input / Tool / Output 是三类具有执行判定权的 guardrail，Prompt 负责生成前预防但不拥有
> runtime veto 权。`src/agent/guardrail/catalog.ts` 只登记执行 guardrail，不代表架构里没有 Prompt 防线。
>
> Prompt 规则的唯一台账见 [Prompt 规则台账](../prompt-rule-ledger.md)；出站动作与质量闭环见
> [Guardrail 质量体系](./guardrail-quality-system.md)；运营口径见
> [敏感信息与安全护栏说明](../product/sensitive-info-guardrails-for-operations.md)。

---

## 1. 防线全景

```text
HTTP 请求
  → [基础设施] 启动校验 / API Token / DTO 校验 / 长度预算 / Provider 重试降级
  → [Input]      高危入站短路；Prompt Injection 检测
  → [Prompt]     system sections + 动态红线/证据 + final-check；注入命中时追加防护 suffix
  → [Tool]       业务动作执行前做 provenance / precheck / 身份 / 拉群门禁
  → [Output]     确定性规则 + 可配置语义 reviewer + 一次有界修复 + 最终清洗
  → 候选人可见回复，或 guardrail_blocked / handoff / skipped
```

| 作用位 | 主要职责                                                       | 权限边界                                        | 权威清单                                                      |
| ------ | -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Prompt | 用人设、手册、渠道规范、策略、证据块和发送前自检降低首版违规率 | 负责教与预防，不是最终放行依据                  | `src/agent/generator/context/` + `docs/prompt-rule-ledger.md` |
| Input  | 生成前识别确定性高危入站；识别并硬化注入尝试                   | 可短路整轮或追加 system 防护，不决定工具准入    | `src/agent/guardrail/input/`                                  |
| Tool   | 用真实业务信号守住副作用动作                                   | 可拒绝动作、要求补收资或短路 loop，不审最终文案 | `src/agent/guardrail/tool/tool-guardrail.catalog.ts`          |
| Output | 审查候选回复与本轮证据是否一致                                 | 最终出站验收，可 observe / revise / block       | `src/agent/guardrail/output/rules/output-rule-catalog.ts`     |

同一条业务约束可以有“Prompt 教 + Tool/Output 拦”的配对，但必须在 Prompt 规则台账互链；
不能把同一份规则文本复制到多个居所后各自演化。

---

## 2. 基础设施安全

| 能力             | 当前实现                                                                              |
| ---------------- | ------------------------------------------------------------------------------------- |
| 环境变量启动校验 | `src/infra/config/env.validation.ts`；必填缺失或类型错误时拒绝启动                    |
| API Token        | `src/infra/server/guards/api-token.guard.ts`；全局 Bearer Token，`@Public()` 端点豁免 |
| DTO 校验         | Nest 全局 `ValidationPipe`                                                            |
| Provider 韧性    | `src/providers/reliable.service.ts`；错误分类、同模型重试、fallback 链                |
| 消息窗口         | `MAX_HISTORY_PER_CHAT` 默认 120；`AGENT_MAX_INPUT_CHARS` 默认 24000                   |
| 输出预算         | `AGENT_MAX_OUTPUT_TOKENS` 默认 4096                                                   |
| 告警节流         | `AlertNotifierService`；同类事件按 dedupe / throttle 约束，避免告警风暴               |

`API_GUARD_TOKEN` 未配置时保留开发兼容放行并打印 WARN；生产不能把这一兼容行为当作安全默认值。

---

## 3. Input 守卫

统一入口是 `InputGuardrailService`，当前在执行 catalog 中登记 2 项。

### 3.1 高危入站短路

`RiskInterceptService` 只基于本轮候选人文本识别高置信信号，例如辱骂、明确投诉/举报、历史面试
结果追问、明确转人工请求和残障披露。它只产出判定与副作用意图，不直接暂停托管或发通知。

Runner 将命中收敛为：

```text
TurnOutcome.kind = guardrail_blocked
TurnOutcome.guardrail.phase = inbound
```

本轮不进入 Generator，也不向候选人发送文本。暂停托管与人工告警在 Replay 定局后由
`TurnOutcomeInterventionService.commit` 统一提交，避免被丢弃的回合提前产生副作用。

### 3.2 Prompt Injection 检测与硬化

`PromptInjectionService` 检测角色劫持、提示词泄露和指令注入模式。当前策略是：

- 不直接拦截候选人消息；
- 在本轮 system prompt 追加防护 suffix；
- 异步发送 `prompt_injection` 安全告警。

检测属于 Input，追加的 system 内容属于 Prompt 防线；这是跨作用位协作，不是把 Prompt 层省略掉。

---

## 4. Prompt 生成防线

Prompt 由 `PreparationService` 和 `context/sections/` 编译，所有动态内容保持 system 语义，不进入
messages。`candidate-consultation` 的 section 顺序以 `scenario.registry.ts` 为准；清单末位只有
`final-check` 复合 section。它负责发送前 recitation，条件命中时在内部附加
`critical-turn-guard` 子块。

Prompt 防线包括：

- identity、手册和渠道规范，约束角色与基本工作法；
- red-lines、thresholds 和 stage strategy，提供当前账号与阶段策略；
- memory、turn hints、hard constraints 等证据/本轮信号；
- final-check 复合 section（含命中时追加的 critical-turn-guard 子块），降低已知 badcase 在首版复现的概率；
- teaching / evidence / tool_result 语料域标签，防止教学示例取得事实出处资格。

Prompt 只能降低首次违规率。jobId 来源、真实姓名、工具动作是否允许、回复能否发送，仍必须由
Tool / Output 的确定性边界裁决。

---

## 5. Tool 守卫

物理执行仍在 `src/tools/**`，`tool-guardrail.catalog.ts` 是审计目录。当前共 **6 项**：

| id                          | 动作             | 保护目标                                   |
| --------------------------- | ---------------- | ------------------------------------------ |
| `booking_jobid_provenance`  | `reject_hard`    | 只能预约本会话真实召回过的岗位             |
| `booking_precheck_contract` | `reject_hard`    | booking 必须复用本轮可预约的 precheck 结论 |
| `booking_real_name`         | `reject_collect` | 昵称、拼音和占位串不进入报名库             |
| `booking_name_authority`    | `reject_collect` | 姓名必须来自候选人明确自报或表单           |
| `invite_city_provenance`    | `reject_collect` | 拉群城市必须有会话事实或候选人原文出处     |
| `invite_timing_gate`        | `reject_collect` | 防重复、突兀或打断成单的拉群调用           |

`reject_hard` 与 `reject_collect` 是工具门禁动作，不等于 Output 的 `block` / `revise`。需要人工介入
的 hard gate 通过结构化 `shortCircuited + gateRejected` 交给 Runner 收敛，工具本身不直接发告警。

---

## 6. Output 守卫与修复

### 6.1 确定性规则

`output-rule-catalog.ts` 当前登记 **31 个 ruleId**，动作分布以 catalog 实况为准：

| 动作      | 数量 | 运行语义                                                   |
| --------- | ---: | ---------------------------------------------------------- |
| `block`   |    6 | 高风险且首版不可发送；除直达静默特例外，先尝试一次受控修复 |
| `revise`  |   14 | 首版不可发送，进入一次有界修复                             |
| `observe` |   11 | 内容仍可发送，保留命中证据供复盘                           |

规则 ID、风险目标、外生信号、盲区与回归测试只在 catalog 维护；本文不复制 31 行矩阵。
`HardRulesService` 会检查回复、工具结果、短期会话文本和 memory snapshot 等证据，并按
`block > revise > observe > pass` 聚合。

### 6.2 语义 reviewer

`SemanticReviewerService` 处理规则难以表达、但证据包可以支撑的语义问题。当前 finding code 共 5 类：

- `job_recommendation_not_best_supported`
- `brand_or_geo_ambiguity_ignored`
- `active_booking_state_conflict`
- `fact_asserted_without_any_evidence`
- `sensitive_screening_disclosure_or_probe`

是否 enforce / shadow 由托管配置 `agent_reply_config` 控制，环境变量只作 DB 未持久化时的 bootstrap。
低置信 veto 会在代码层降为 observe；高风险回复的 reviewer 故障 fail-close，普通语义触发故障
回退 rule 档。语义档关闭时仍会运行确定性规则。

### 6.3 一次有界修复与收敛

Output guard 只读、不直接改文案。Runner 持有修复编排权：

1. 首版为 `revise` / `block` 时，先尝试确定性剥围栏、剥推理残文或拆 JSON 信封；
2. 不能确定性修时，交给无工具的 `ReplyRepairAgent`，只做一次文本重写；
3. 修复版再过一次 Output guard；
4. 回归闸比较首版与修复版，防结构坍缩、极性反转、日期星期改错和承诺状态退化；
5. P0 / 不可恢复问题仍不合格时收敛为 `guardrail_blocked/outbound`；仅剩可恢复 P1/P2 时按
   既定 fail-open 规则收敛并完整留档。

`replan` 已退役：修复不能重进 Generator、不能重新调用工具，也不能重做已经提交的副作用。
直达静默、悬空承接句等特例同样由 Runner 显式给出 `reasonCode`，不允许裸静默。

### 6.4 最终清洗

`OutboundReplySanitizer` 负责确定性清理时间标记和投递格式残留。清洗不是新的语义裁决器，
也不能替代前面的 Output 审查。

---

## 7. Outcome、副作用与观测

| 结果                         | 含义                                            |
| ---------------------------- | ----------------------------------------------- |
| `reply`                      | 文本可进入 Replay / 投递；副作用在最终回合提交  |
| `guardrail_blocked/inbound`  | 入站高危短路，未运行 Agent                      |
| `guardrail_blocked/outbound` | 首版与有界修复均不能安全发送                    |
| `handoff`                    | 模型显式转人工或 Tool gate 硬拒绝后确定性转人工 |
| `skipped`                    | 普通短路、空文本或主动回合的保守放弃            |

主要观测面：

- `message_processing_records.guardrail_input / guardrail_output`：回合级紧凑摘要；
- `guardrail_review_records`：规则命中、语义 verdict、首版/修复版与最终裁决；
- `agent_execution_events`：`semantic_review` 等运行事件；
- `TurnOutcome.guardrail`：渠道投递前的确定性终态归因。

`silent: true` 仅供调试 / test-suite advisory，不能写入生产守卫判例池。

---

## 8. 配置与验证

| 配置                                       | 代码默认值 | 说明                                    |
| ------------------------------------------ | ---------: | --------------------------------------- |
| `AGENT_MAX_INPUT_CHARS`                    |    `24000` | prepare 的消息字符预算                  |
| `MAX_HISTORY_PER_CHAT`                     |      `120` | 单会话历史消息上限                      |
| `AGENT_MAX_OUTPUT_TOKENS`                  |     `4096` | 单次模型输出上限                        |
| `OUTPUT_GUARDRAIL_LLM_ENABLED`             |    `false` | 语义 reviewer enforce 的 bootstrap 默认 |
| `OUTPUT_GUARDRAIL_SEMANTIC_SHADOW_ENABLED` |    `false` | 语义 reviewer shadow 的 bootstrap 默认  |

验证入口：

```bash
pnpm test -- --runInBand tests/agent/guardrail
pnpm test -- --runInBand tests/agent/runner/agent-runner.service.spec.ts
```

Catalog 不变量测试负责核对执行实现与登记表的 ruleId；Prompt 侧由 section / 台账测试独立治理。

---

## 相关代码与文档

- `src/agent/generator/preparation/preparation.service.ts`、`src/agent/generator/context/` — Prompt 编译
- `src/agent/guardrail/catalog.ts` — Input / Tool / Output 执行守卫聚合审计视图
- `src/agent/guardrail/input/` — 入站判定与注入检测
- `src/agent/guardrail/tool/tool-guardrail.catalog.ts` — Tool 守卫登记
- `src/agent/guardrail/output/` — 出站规则、语义 reviewer、清洗与证据包
- `src/agent/runner/agent-runner.service.ts` — 入站短路、修复、终态分类
- `src/agent/reply-repair/reply-repair.agent.ts` — 唯一的 LLM 文本修复者
- [Agent 运行时架构](./agent-runtime-architecture.md) — 回合主干与四个防线作用位
- [Prompt 规则台账](../prompt-rule-ledger.md) — Prompt 教侧唯一索引
- [Gate 拒绝与人工介入流水线](./handoff-gate-and-intervention-pipeline.md) — Tool gate 到 handoff
