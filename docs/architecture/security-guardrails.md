# 安全护栏说明

**最后更新**：2026-08-12（全文对代码核实：路径 / 服务名 / 规则 catalog / 裁决枚举 / 环境变量）

> 定位：本文是**护栏现状总览（entry point）**——覆盖基础设施层安全 + Agent 三层守卫（input / tool / output）。
> 每条护栏的可审计登记表在代码 `src/agent/guardrail/catalog.ts`（含 `exogenousSignal` 审计字段）；
> 出站链路的分段职权、repair 动手权与规则生命周期见 [guardrail-quality-system.md](./guardrail-quality-system.md)；
> 面向运营的敏感信息保护说明见 [../product/sensitive-info-guardrails-for-operations.md](../product/sensitive-info-guardrails-for-operations.md)。

---

## 1. 概述

安全护栏分为**基础设施层**（业务无关的入站/调用安全）与 **Agent 三层守卫**（生成前 input → 动作门禁 tool → 出站验收 output）。

```
HTTP 请求
  → [基础设施] 环境变量启动校验 → ApiTokenGuard → DTO 校验 → 输入长度守卫 → 告警节流
  → [Agent · input 守卫] 风险预检拦截（辱骂/投诉/结果追问 → 转人工）
                         Prompt Injection 检测（追加防护 suffix + 告警）
  → [Agent · 生成循环] Chat 模型 + 工具调用
  → [Agent · tool 守卫]  动作门禁（jobId 溯源 / precheck 契约 / 真名 / 拉群城市与时机 / 硬筛，不符即 REJECT）
  → [Agent · output 守卫] 出站验收（确定性 rule 档 + 语义 reviewer，pass/observe/revise/block）
  → 候选人可见回复
```

**分工铁律**：

| 层 | 本质 | 成功标准 |
|---|---|---|
| Prompt | 生成引导 / 预防 | 降低首次违规率，不作为最终责任层 |
| Input 守卫 | 生成前拦截 | 高危入站（辱骂/投诉/结果追问）不进 Agent；注入尝试被硬化 |
| Tool 守卫 | 动作门禁 | 错误 jobId、跳过 precheck、硬筛不符、可疑姓名不进副作用工具 |
| Output 守卫 | 出站验收 / 最终 veto | 工具失败不能说成功；敏感筛选理由不外露；未接地事实不发出 |

**公开端点**（企微回调、健康检查）标注 `@Public()`，跳过 Token 鉴权。

---

## 2. 基础设施层护栏

**环境变量启动校验** · `src/infra/config/env.validation.ts`
服务启动时用 `class-validator` 校验全部环境变量，必填缺失则启动失败。

**API Token Guard** · `src/infra/server/guards/api-token.guard.ts`
全局 Guard，保护 `/agent/*`、`/config/*`、`/test-suite/*`。校验 `Authorization: Bearer <token>` 与 `API_GUARD_TOKEN`：

| 场景 | 行为 |
|------|------|
| 未配置 `API_GUARD_TOKEN` | 放行（开发兼容），启动打印 WARN |
| `@Public()` 端点 | 跳过 |
| Token 匹配 / 不匹配 | 放行 / 403 + WARN |

**重试 + 降级 + 错误分类** · `src/providers/reliable.service.ts`
三层容错：同模型指数退避重试（1s→30s）→ fallback 链降级 → 错误分类（401/403/404/400 non_retryable，429 rate_limited，其余 retryable）。fallback 链走 `AGENT_{ROLE}_FALLBACKS` / `AGENT_DEFAULT_FALLBACKS`。

**告警节流** · `src/notification/services/alert-notifier.service.ts`
节流键 `errorType:scenario`，5 分钟窗口内同类型最多 3 次，超出静默丢弃。

**其余** · DTO 校验（全局 `ValidationPipe`）、消息历史上限（`MAX_HISTORY_PER_CHAT` 默认 60）、日志脱敏（不记 Key/Token，用户消息截断）。

---

## 3. Agent · Input 守卫（生成前）

物理位置：`src/agent/guardrail/input/`。

### 3.1 风险预检拦截（pre-agent risk intercept）

位置：`src/agent/guardrail/input/risk-intercept.service.ts`（`RiskInterceptService`，高危关键词信号在同文件内维护）。

生成前同步预检：命中辱骂、投诉风险、面试结果追问等需人工介入的信号即**暂停托管 + 飞书告警 + 转人工**，本轮不跑 Agent。编排权收在 runner（`AgentRunnerService.precheckInboundOutcome`），渠道只把入站 DTO 解析成中立 `RiskInterceptInput`，命中后收敛成 `intercepted` 终态静默收尾。

### 3.2 Prompt Injection 防护

位置：`src/agent/guardrail/input/prompt-injection.service.ts`（由 `input-guard.service.ts` 的 `InputGuardrailService` 编排，在 `src/agent/generator/preparation.service.ts` 生成前应用）。

检测角色劫持 / 提示词泄露 / 指令注入三类模式。策略：**不阻断**，在 systemPrompt 末尾追加防护 suffix，同时异步飞书告警（类型 `prompt_injection`，受节流控制）。

### 3.3 输入长度守卫 & 输出上限

- 输入截断 · `src/agent/generator/preparation.service.ts`（`PreparationService`）：消息总字符超 `AGENT_MAX_INPUT_CHARS`（默认 12000）从最早丢弃。
- 输出上限 · `src/agent/generator/generator.agent.ts`：`generateText`/`streamText` 统一传 `maxOutputTokens`（`AGENT_MAX_OUTPUT_TOKENS` 默认 4096）。

---

## 4. Agent · Tool 守卫（动作门禁）

登记目录：`src/agent/guardrail/tool/tool-guardrail.catalog.ts`；真实执行逻辑物理留在 `src/tools/**`（避免 tools 反向依赖 agent 造成分层环，目录只做审计登记）。

共 **8 条**，命中即在工具层拒绝，不进副作用。`REJECT_HARD` = 硬拒并短路 loop（HC-3）；`REJECT_COLLECT` = 拒绝并转回收资。

| id | 动作 | 说明 |
|---|---|---|
| `booking_jobid_provenance` | REJECT_HARD | 只能约本会话真实召回过的岗位，禁止凭空 jobId |
| `booking_precheck_contract` | REJECT_HARD | 必须复用本轮 precheck 的 ready_to_book 结论，禁止绕过 |
| `booking_screening_answers` | REJECT_HARD | 岗位硬筛答案不符时禁止预约 |
| `booking_hard_requirements` | REJECT_HARD | 候选人参数不满足岗位硬约束时拒绝 |
| `booking_real_name` | REJECT_COLLECT | 昵称/拼音/占位符不入报名库 |
| `booking_name_authority` | REJECT_COLLECT | 姓名须来自高置信自陈/表单，不用打招呼昵称顶替 |
| `invite_city_provenance` | REJECT_COLLECT | 拉群前城市须有出处（含 geocode 确权与区级映射，非仅字面命中） |
| `invite_timing_gate` | REJECT_COLLECT | 拉群两轮协议：先征询意向，同意后的下一轮才实调 invite |

---

## 5. Agent · Output 守卫（出站验收）

物理位置：`src/agent/guardrail/output/`；组合器 `output-guardrail.service.ts`，两档汇成最终裁决 `pass | observe | revise | block`。

> **没有「重进 generator 重取数 + 重写全文」这条修复路径**：语义档裁决在 `normalizeDecision` 归一为 `revise`。全链路只有一个能改候选人可见文本的写手（§5.3）。

### 5.1 确定性 rule 档

位置：`hard-rules.service.ts`（检测逻辑按领域拆在 `output/rules/*.rule.ts`），元数据登记在 `output/rules/output-rule-catalog.ts`。先跑、同步、可 veto。observe 只落 `guardrail_review_records`，不写飞书告警。

**当前 28 条**（catalog 实况，`catalog.spec` 校验 id 一致性）：

| 档位 | 条数 | 规则 |
|---|---|---|
| **block**<br>高风险且发出后不可逆 | 6（全 P0） | `invalid_model_output` `internal_output_leak` `meta_narration_reply` `discriminatory_screening_leak` `sensitive_origin_probe` `quota_promise` |
| **revise**<br>丢首版走受控修复 | 15 | P0：`identity_misregistration_coaching` `experience_fraud_coaching` `interview_time_change_unconfirmed`<br>P1：`application_record_update_promise` `date_reference_mismatch` `summer_worker_alternative_upsell` `combination_schedule_weekly_generalization` `health_certificate_generalization` `unsupported_schedule_window_claim` `online_interview_location_claim` `unsupported_store_status_speculation` `booking_receipt_mismatch` `brand_alias_fuzzy_match_ignored`<br>P2：`human_service_phrase_leak` `repeated_reply_verbatim` |
| **observe**<br>只记录不拦 | 7 | `dangling_reply_promise` `proactive_insurance_policy_mention` `job_detail_lookup_required` `settlement_cycle_mismatch` `requested_brand_mismatch` `image_description_not_saved` `repeated_reply` |

**block 不再首轮静默**：runner 先进入一次受控重写，二审仍违规才静默归档 `repair_exhausted`。

**准入治理**（catalog 头部注释即规范）：新规则默认 `observe` 入场；升 `revise` 需 ≥2 周 observe 判例 + 抽标精确率 ≥90%，且同时满足风险不对称、有 ground truth、恢复路径可靠；`block` 仅限封闭形态且发出后不可逆的事故；**veto 档精确率 <70% 应自动降 observe**。

> **规则存活判据**：拿正则猜语义承诺 / 出处 / 原因的规则全病，有确定性证据基的才活。据此判死的规则不再修补、不再重加——参见 [Guardrail 质量体系 §4](./guardrail-quality-system.md) 的规则生命周期。

### 5.2 LLM 语义 reviewer

位置：`output/llm/semantic-reviewer.service.ts`，吃 `review-packet.builder.ts` 裁剪的证据包（jobList / precheck / booking / geocode / sentLocation 五类），输出领域 finding。

**当前 5 类 contract**：`job_recommendation_not_best_supported`、`brand_or_geo_ambiguity_ignored`、`active_booking_state_conflict`、`fact_asserted_without_any_evidence`、`sensitive_screening_disclosure_or_probe`。

`sentLocation` 证据段记录目的地类型、面试形式、工作门店/面试/实际发送地址及冲突标记，用于拦截把面试定位说成工作门店、线上面试声称需到店、工作门店与面试地址混用。

⚠️ **证据包裁剪是已知假阳来源**：摘录有字数上限，被截断的字段会让 reviewer 误判「无出处」。薪资段已补录，**非薪资字段被截仍会盲**。

- 触发：本轮成功提交过副作用工具 / 回复含承诺·动态事实措辞 / 命中语义 contract 触发词。
- 灰度开关（已迁托管配置 `agent_reply_config`，Dashboard 即时生效；env 仅作 bootstrap 默认）：`OUTPUT_GUARDRAIL_LLM_ENABLED`（enforce 参与裁决）、`OUTPUT_GUARDRAIL_SEMANTIC_SHADOW_ENABLED`（shadow 只观测）。
- **LLM 不能自证**：reviewer 自评 `confidence=low` 的 revise / block 在代码层强制降级为 observe，不允许凭感觉 block。
- **故障降级**：高风险触发（副作用既成/承诺事实）reviewer 故障 → block（fail-close）；仅语义 contract 触发 → 回退 rule 档裁决（fail-open）。
- **silent advisory**：`check({ silent: true })` 只返回裁决、不 fire 任何告警/判例落库，用于调试流量流末展示"守卫会怎么判"，避免污染生产守卫日志。

### 5.3 受控修复回路

编排在 `src/agent/runner/agent-runner.service.ts` 的 `invokeReviewed`，重写由**独立的 `ReplyRepairAgent`**（`src/agent/reply-repair/reply-repair.agent.ts`）执行——它是全链路唯一能改候选人可见文本的写手。

- 裁决 `revise` / `block` → 丢首版，交 `ReplyRepairAgent` 按 violations + 已知事实做**文本修复**（不重取数）；
- **确定性短路**：命中 fence-only（`reason_code=fence_stripped`）或 JSON 信封（`envelope_unwrapped`）时直接剥壳，**跳过 LLM 重写**；
- 修复后再审一次，二审仍不过按「repair 死循环硬上限 1」收敛（`repair_exhausted`）；
- 两次生成都 `deferTurnEnd`——**被丢弃的首版不写记忆**（HC-4）。

### 5.4 观测落库

出站全程 trace（首审→repair→二审）落 `message_processing_records.guardrail_output`；完整守卫命中、Semantic Shadow verdict 与修复正文落 `guardrail_review_records`；是否运行、通过量和 finding code 统计落 `agent_execution_events`。机器判例不自动创建 BadCase，只有人工确认需要修复的问题才进入 BadCase。入站拦截摘要落 `guardrail_input`（主表字段均为独立小 JSONB，不塞 agent_invocation 大 blob）。Dashboard 流水页徽标 + 详情抽屉时间线展示；调试页流末 `data-guardrail` part 展示 advisory 裁决。

---

## 6. 安全相关环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_GUARD_TOKEN` | 无 | 管理端点 Bearer Token，未配置则不鉴权 |
| `AGENT_MAX_OUTPUT_TOKENS` | `4096` | LLM 单次最大输出 token |
| `AGENT_MAX_INPUT_CHARS` | `12000` | 输入消息总字符上限 |
| `AGENT_DEFAULT_FALLBACKS` | 无 | 全局模型降级链，逗号分隔 |
| `OUTPUT_GUARDRAIL_LLM_ENABLED` | `false` | 出站 llm 档 enforce（已迁托管配置，env 仅 bootstrap） |
| `OUTPUT_GUARDRAIL_SEMANTIC_SHADOW_ENABLED` | `false` | 出站语义 reviewer shadow 观测 |
| `FEISHU_ALERT_WEBHOOK_URL` / `FEISHU_ALERT_SECRET` | 无 | 生产必填，安全告警推送 |

告警节流硬编码（`src/infra/feishu/constants/constants.ts`）：`WINDOW_MS` 5 分钟，`MAX_COUNT` 3 次。

---

## 7. 待实现的护栏

| 护栏 | 优先级 | 说明 |
|------|--------|------|
| 用户级限流 | 高 | 单用户每分钟最大请求数，防刷 |
| 成本 / 预算控制 | 中 | 每日 token 累计超预算后降级低成本模型 |
| 熔断器（Circuit Breaker） | 中 | 某 Provider 连续失败后熔断，避免雪崩重试 |
| 语义 reviewer contract 扩展 | 中 | 现 5 类，待补收资 / 多消息 / 图片置信度等 |
| 证据包截断补录 | 中 | 摘录字数上限导致非薪资字段被截时 reviewer 误判「无出处」（§5.2） |

---

## 8. 验证方式

```bash
# ApiTokenGuard：有效 200 / 无效 403 / @Public 免鉴权
curl -H "Authorization: Bearer your-guard-token" http://localhost:8585/agent/health
curl -H "Authorization: Bearer wrong-token"      http://localhost:8585/agent/health
curl http://localhost:8585/wecom/message/health

# 出站守卫 advisory（调试页流末返回 data-guardrail，不 fire 生产告警）
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Authorization: Bearer your-guard-token" -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"test-001"}'
```

守卫单测：`tests/agent/guardrail/**`（catalog 审计不变量、hard-rules 各规则、output-guardrail 组合裁决与 silent、runner repair 回路）。

---

## 相关文件

- `src/agent/guardrail/catalog.ts` — 三层守卫统一审计登记表（`exogenousSignal` 审计字段）
- `src/agent/guardrail/input/{input-guard,prompt-injection,risk-intercept}.service.ts` — input 层
- `src/agent/guardrail/tool/tool-guardrail.catalog.ts` — tool 层登记（执行在 `src/tools/**`）
- `src/agent/guardrail/output/{output-guardrail,hard-rules}.service.ts` + `output/rules/*.rule.ts` + `output/llm/*` — output 层
- `src/agent/runner/agent-runner.service.ts` — `invokeReviewed` 受控修复编排
- `src/agent/reply-repair/reply-repair.agent.ts` — 唯一的回复重写者
- `src/agent/generator/generator.agent.ts` — maxOutputTokens
- `src/agent/generator/preparation.service.ts` — 输入长度守卫 + 注入 suffix 应用
- `src/infra/server/guards/api-token.guard.ts` / `src/providers/reliable.service.ts` / `src/notification/services/alert-notifier.service.ts` — 基础设施层
