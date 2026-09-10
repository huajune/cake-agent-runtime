# 安全护栏说明

**最后更新**：2026-09-10（按当前 guardrail catalog、Runner outcome 与 repair 所有权核实）

> 定位：本文是安全防线的技术入口。运行时共有 **Input / Prompt / Tool / Output 四个防线作用位**；
> 其中 Input / Tool / Output 是三类具有执行判定权的 guardrail，Prompt 负责生成前预防但不拥有
> runtime veto 权。Catalog 仅管理可独立识别与治理的规则；`src/agent/guardrail/catalog.ts`
> 只聚合 Input / Tool / Output 三份子目录。Prompt 防线由独立台账维护。
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
  → [Output]     确定性格式/封闭词形/工具回执对账，产出裁决与 repairMode
  → [Runner]     必要时一次 rewrite / replan，再二审、回归检查与最终清洗
  → Output resolution：reply / handoff / skipped（Input 风险同样归入 handoff）
```

| 作用位 | 主要职责                                                       | 权限边界                                        | 权威清单                                                      |
| ------ | -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Prompt | 用人设、手册、渠道规范、策略、证据块和发送前自检降低首版违规率 | 负责教与预防，不是最终放行依据                  | `src/agent/generator/context/` + `docs/prompt-rule-ledger.md` |
| Input  | 生成前识别确定性高危入站；识别并硬化注入尝试                   | 可短路整轮或追加 system 防护，不决定工具准入    | `src/agent/guardrail/input/`                                  |
| Tool   | 用真实业务信号守住副作用动作                                   | 可拒绝动作、要求补收资或短路 loop，不审最终文案 | `src/agent/guardrail/tool/tool-guardrail.catalog.ts`          |
| Output | 审查候选回复与本轮证据是否一致                                 | 草稿验收，可 observe / repair / replan       | `src/agent/guardrail/output/output-rule-catalog.ts`     |

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
| 消息窗口         | `MAX_HISTORY_PER_CHAT` 默认 300（硬上限）；`AGENT_MAX_INPUT_CHARS` 默认 24000         |
| 输出预算         | `AGENT_MAX_OUTPUT_TOKENS` 默认 4096                                                   |
| 告警节流         | `AlertNotifierService`；同类事件按 dedupe / throttle 约束，避免告警风暴               |

`API_GUARD_TOKEN` 未配置时保留开发兼容放行并打印 WARN；生产不能把这一兼容行为当作安全默认值。

---

## 3. Input 守卫

统一入口是 `InputGuardrailService`。`input/input-rule-catalog.ts` 逐项定义 20 个注入模式与 5 类风险，
检测器直接消费模式、风险元数据和顺序，不再仅登记两个服务级条目。Input 审查只返回 `pass | handoff`。

### 3.1 高危入站短路

`RiskInterceptService` 只基于本轮候选人文本识别高置信信号，例如辱骂、明确投诉/举报、历史面试
结果追问、明确转人工请求和残障披露。它只产出判定与副作用意图，不直接暂停托管或发通知。

Runner 将命中收敛为：

```text
TurnOutcome.kind = handoff
TurnOutcome.guardrail.phase = inbound
TurnOutcome.guardrail.source = input_guardrail
```

本轮不进入 Generator，也不向候选人发送文本。暂停托管与人工告警在 Replay 定局后由
`TurnOutcomeInterventionService.commit` 提交既有 `conversation_risk` 意图，避免被丢弃的回合提前产生副作用；不因终态更名新增 `general_handoff`。当前事件名为 `inbound_guardrail_handoff`，旧 `inbound_guardrail_block` 和 `guardrail_blocked` 仅供历史读取兼容。

### 3.2 Prompt Injection 检测与硬化

`PromptInjectionDetector` 纯检测角色劫持、提示词泄露和指令注入模式，
`PromptSecurityObserverService` 负责观测与告警。当前策略是：

- 不直接拦截候选人消息；
- 由显式 `InputSecuritySection` 在本轮 system prompt 生成防护 block；
- 异步发送 `prompt_injection` 安全告警。

检测属于 Input，追加的 system 内容属于 Prompt 防线；这是跨作用位协作，不是把 Prompt 层省略掉。

---

## 4. Prompt 生成防线

Prompt 由 `PreparationService` 编排、`context/sections/` 渲染并由 `ContextService` 编译；所有动态
内容保持 system 语义，不进入 messages。`candidate-consultation` 的 manifest 声明 Section 集合，
`PromptSlot` 固定跨类别顺序，末部自然形成
`final-check → input-guard → critical-turn-guard`，后两者按条件省略。

Prompt 防线包括：

- identity、手册和渠道规范，约束角色与基本工作法；
- red-lines、thresholds 和 stage strategy，提供当前账号与阶段策略；
- memory、turn hints、hard constraints 等证据/本轮信号；
- final-check 与 critical-turn-guard 两个渲染落点共用唯一 `FINAL_CHECK_RULES`，降低已知 badcase 在首版复现的概率；
- teaching / evidence / tool_result 语料域标签，防止教学示例取得事实出处资格。

Prompt 只能降低首次违规率。jobId 来源、真实姓名、工具动作是否允许、回复能否发送，仍必须由
Tool / Output 的确定性边界裁决。

---

## 5. Tool 守卫

物理执行仍在 `src/tools/**`，`tool-guardrail.catalog.ts` 是审计目录。当前共 **7 项**：

| id                          | 动作             | 保护目标                                   |
| --------------------------- | ---------------- | ------------------------------------------ |
| `job_list_brand_provenance` | `reject_hard` | 查岗品牌须有本轮提及来源；提及集合不可用时保留放行 |
| `booking_jobid_provenance`  | `reject_hard`    | 只能预约本会话真实召回过的岗位             |
| `booking_precheck_contract` | `reject_hard`    | booking 必须复用本轮可预约的 precheck 结论 |
| `booking_real_name`         | `reject_collect` | 昵称、拼音和占位串不进入报名库             |
| `booking_name_authority`    | `reject_collect` | 姓名必须来自候选人明确自报或表单           |
| `invite_city_provenance`    | `reject_collect` | 拉群城市必须有会话事实或候选人原文出处     |
| `invite_timing_gate`        | `reject_collect` | 防同会话同城重复拉群；对话时机由主 Agent 判断           |

`reject_hard` 与 `reject_collect` 是工具门禁动作，Output 的 `repair` / `replan` 则请求修复草稿。需要人工介入
的 hard gate 通过结构化 `shortCircuited + gateRejected` 交给 Runner 收敛，工具本身不直接发告警。

---

## 6. Output 守卫与修复

### 6.1 确定性规则

`output/output-rule-catalog.ts` 当前登记 **24 个 ruleId**（19 条执行档 + 5 条 observe 哨兵）：

- 格式/内部泄漏：`invalid_model_output`、`internal_output_leak`、`meta_narration_reply`、
  `human_service_phrase_leak`（人设露馅封闭词表，2026-08-26 数据复核恢复）；
- 封闭高风险：身份/经历造假教唆、歧视性筛选、主动籍贯探问、名额承诺；
- 工具回执/状态对账：预约、面试时段、改约、线上面试位置、明确 no-match 门店状态、
  高置信品牌回指、无在途工单却宣称报名完成、工具失败却宣称取消/改期完成；
- 查询/岗位事实来源：零查询轮宣称查过，或报出会话内没有来源的岗位数字，触发 replan；
- observe 哨兵（只落档不拦截）：跨品牌串台、结算周期错配、主动保险提及、
  零调用完成时态报名宣称、零调用完成时态取消/改期宣称。

`HardRulesService` 只检查封闭文本形态、工具结果和必要的 memory 事实；`OutputGuardrailService`
按 `replan > repair > observe > pass` 聚合。仅有 observe 命中时，Output 保留规则命中并
返回 `pass`，不触发修复。Output 不运行第二个 LLM reviewer，不做 semantic shadow，开放语义
由主 Agent 承担。旧审查值 revise / block 都映射为 repair；旧 block 的拒发约束保留为
`allowFailOpen: false`，旧记录按原阶段和值兼容读取，`recoverability` 不再参与运行时判定。

精确重复由 sanitizer 机械删除；handoff 承诺在 outcome/副作用层对账；两者都不登记成
Output ruleId，直接由所属实现和行为测试维护。

### 6.2 一次有界修复与收敛

Output guard 可做精确去重并产出 `deterministicReply`，其余只产出规则裁决与派生的
`repairMode`。Runner 持有修复编排权，hard cap 为一次：

1. rewrite 路径先尝试确定性剥围栏、剥推理残文或拆 JSON 信封；不能确定性修时交给
   无工具的 `ReplyRepairAgent` 做局部重写；
2. replan 路径以完全相同参数重进一次 Generator，不注入守卫反馈、不裁工具集；首版已有
   已提交副作用时禁止重进，降级 rewrite 并告警；
3. 重生成若由真实工具明确短路为 `handoff/skipped`，优先保留工具终态，不伪造二审；纯无工具空产物仍按修复失败处理。其余产物再过 Output guard；rewrite 使用首版工具轨迹，replan 使用重生成版工具轨迹；
4. 回归闸比较首版与修复版，防结构坍缩、极性反转、日期星期改错和承诺状态退化；
   首版因内部泄漏/自我旁白/异常 completion 被封禁时豁免结构坍缩判定——此时首版的
   "结构"本身就是违规脚手架，剥掉它是修复目标而非退化。确定性剥离/拆封直接跳过回归比较；
   replan 首版的岗位内容不可信，豁免结构坍缩与岗位极性反转检查；
5. rewrite 仍有 P0 高风险或 `allowFailOpen: false` 的违规时收敛为 `handoff`，携带 guardrail 原因；
   仅剩允许 fail-open 的 P1/P2 时按既定规则放行并完整留档。replan 首版不回退、二审不 fail-open，
   仍不过则以 `replan_exhausted` 转人工。

`ReplyRepairAgent` 的输入由 `ReplyRepairContextProvider` 和 `RepairEvidenceBuilder` 提供：
前者读取并投影修复上下文，后者将本轮工具事实与策略构建成 `RepairEvidencePacket`。
两者都归 `src/agent/reply-repair/`，由 `AgentModule` 注册；`GuardrailModule` 不导出修复证据构建器。
证据构建不参与 Output 规则裁决，修复代理也不拥有最终放行权。任何修复都不能重做已提交的副作用。
Runner 用 `resolution: { outcome: reply | handoff | skipped, reasonCode? }` 收敛，真实首审/二审保持原样。
仅元叙述旁白的 `meta_narration_silenced` 为 `skipped`，保留已有工具意图且不新增介入；纯推理/工具
残文直接 `handoff`。空修复、悬空承接句等提前分支不伪造二审，并保留既有回退资格。

### 6.3 最终清洗

`OutboundReplySanitizer` 负责确定性清理时间标记、投递格式残留与近期已投递长段落的精确
全等去重。清洗不是新的语义裁决器，不做相似度判断。

代码入口：[Output 门面](../../src/agent/guardrail/output/output-guardrail.service.ts)、
[rules](../../src/agent/guardrail/output/rules/)、[sanitizer](../../src/agent/guardrail/output/sanitizer/)、
[修复证据](../../src/agent/reply-repair/repair-evidence.builder.ts)、
[修复回归闸](../../src/agent/reply-repair/repair-regression.util.ts)。

---

## 7. Outcome、副作用与观测

Runner 形成 `TurnOutcome` 与副作用意图；Replay 定局后由独立的
`TurnOutcomeInterventionService.commit()` 提交暂停托管、handoff 与告警。
`TurnFinalizer` 只按投递结局执行或丢弃 `runTurnEnd`，负责记忆收尾与等待落盘。

| 结果                         | 含义                                            |
| ---------------------------- | ----------------------------------------------- |
| `reply`                      | 文本可进入 Replay / 投递；副作用在最终回合提交  |
| `handoff`                    | 入站风险、出站无法安全放行、模型显式转人工或 Tool gate 硬拒绝；守卫来源携带 phase/source 与原因 |
| `skipped`                    | 普通短路、空文本、元叙述旁白或主动回合的保守放弃 |

主要观测面：

- `message_processing_records.guardrail_input / guardrail_output`：回合级紧凑摘要；
- `guardrail_review_records`：确定性规则命中、首版/修复版与最终裁决；存量
  `semantic_reviews` 字段只作历史兼容；
- `TurnOutcome.guardrail`：入站拦截或出站转人工的守卫归因；
- Trace `finalOutcome`：Runner 最终处置；advisory 只返回实际审查，不带最终处置。

`silent: true` 仅供调试 / test-suite advisory，不能写入生产守卫判例池。

---

## 8. 配置与验证

| 配置                      | 代码默认值 | 说明                   |
| ------------------------- | ---------: | ---------------------- |
| `AGENT_MAX_INPUT_CHARS`   |    `24000` | prepare 的消息字符预算 |
| `MAX_HISTORY_PER_CHAT`    |      `300` | 单会话历史条数硬上限   |
| `AGENT_MAX_OUTPUT_TOKENS` |     `4096` | 单次模型输出上限       |

验证入口：

```bash
pnpm exec jest tests/agent/guardrail tests/agent/reply-repair tests/agent/runner --watchman=false --runInBand
```

Catalog 只聚合 Input、Tool、Output 三份规则目录。Input 与 Output 执行器直接引用规则定义，
Tool 目录用于审计登记，门禁仍在工具域执行。Output 默认 action 与修复属性由目录统一提供，检测函数通过
`createOutputRuleFinding` 引用；未知 ID 抛错，不再以默认策略静默兜底。运行时 `off | observe`
override 继续只对已注册 Output 规则降档，不用于控制修复策略或清洗。

Input 行为探针与 Output 源码/调度审计核对规则注册关系，并用漏登记/孤立条目等负例验证校验有效。
根目录只负责三层聚合元数据与来源有效性；Prompt 侧由 section / 台账测试独立治理。
修复回归、Runner 恢复与确定性清洗直接阅读各自实现和行为测试；理由码、恢复判据与清洗步骤
留在所属实现中，不另设 Catalog。

---

## 相关代码与文档

- `src/agent/generator/preparation/preparation.service.ts`、`src/agent/generator/context/` — Prompt 编译
- `src/agent/guardrail/catalog.ts` — Input / Tool / Output 三层规则的聚合审计视图
- `src/agent/guardrail/input/` — 入站判定与注入检测
- `src/agent/guardrail/tool/tool-guardrail.catalog.ts` — Tool 守卫登记
- `src/agent/guardrail/output/` — 出站确定性规则与清洗
- `src/agent/reply-repair/repair-regression.util.ts` — 修复回归判据与结果类型
- `src/agent/runner/agent-runner.service.ts` — 入站短路、修复、终态分类
- `src/agent/reply-repair/reply-repair.agent.ts` — 唯一的 LLM 文本修复者
- [Agent 运行时架构](./agent-runtime-architecture.md) — 回合主干与四个防线作用位
- [Prompt 规则台账](../prompt-rule-ledger.md) — Prompt 教侧唯一索引
- [Gate 拒绝与人工介入流水线](./handoff-gate-and-intervention-pipeline.md) — Tool gate 到 handoff
