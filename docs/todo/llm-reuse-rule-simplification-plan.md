# 复用现有 LLM 的规则简化改造方案

**状态**：已完成（2026-08-26）
**范围**：候选人表单外语义提取、品牌/用工形式解析、Input/Output Guardrail 及相关规则清理

**Precheck 边界**：收资入参问题已拆到 [Precheck 收资入参统一专项](./precheck-form-answer-contract-refactor.md)，本方案不再裁定 `candidateClaims` / `formAnswers` 的接口形态
**核心约束**：不新增 LLM 调用，不新增观测项、Dashboard、Rule Catalog、shadow 对照或人工标注流程

## 1. 背景与目标

当前仓库同时存在两类能力：

1. 确定性能力：文本清洗、格式解析、品牌/行政区划目录、工具回执和不可逆动作闸门；
2. 语义能力：主 Agent、轮末 `extract_facts`、`brand_intents` 和 `labor_form_intent`。

历史代码中仍有不少正则在重复判断开放自然语言的意图、否定、身份、承诺和上下文。这些规则容易形成“增加一个命中分支，再增加一个豁免分支”的维护循环，也会与已经存在的 LLM 语义结果互相覆盖。

本次改造的目标不是引入新的 LLM，而是把仓库里已经存在、已经付过调用成本的 LLM 能力真正用起来，删除与其重复竞争的语义正则。

最终职责划分：

```text
主 Agent
  └─ 负责理解当前对话和生成回复

现有 extract_facts
  ├─ 负责表单外软偏好
  ├─ 负责 brand_intents
  └─ 负责 labor_form_intent

确定性代码
  ├─ 负责消息清洗
  ├─ 负责格式、目录和枚举验证
  ├─ 负责 quote 原文公证
  ├─ 负责冲突转确认
  └─ 负责工具回执和不可逆动作闸门
```

## 2. 非目标

本次明确不做：

- 不增加新的同步或异步 LLM 调用；
- 不启用额外的 Output Semantic Reviewer；
- 不增加规则命中埋点、质量 Dashboard 或人工标注平台；
- 不增加新的 Rule Catalog；
- 不建立 shadow diff 或双轨观测流程；
- 不尝试一次性删除所有正则；
- 不改变品牌目录、行政区划、岗位数据等业务真值来源；
- 不削弱报名、改约、拉群等不可逆动作前的确定性检查。

## 3. 现有 LLM 能力

### 3.1 轮末 `extract_facts`

每轮结束已经存在一次偏好抽取调用：

- 调用入口：`src/memory/lifecycle.service.ts`
- LLM 调用：`src/memory/short-term/facts.service.ts`
- 输出 Schema：`src/memory/short-term/short-term.types.ts`
- 提取 Prompt：`src/memory/short-term/extraction.prompt.ts`

当前 `LLMEntityExtractionResultSchema` 已经包含：

```text
preferences
brand_intents
labor_form_intent
```

因此品牌复杂极性和用工形式意图可以直接复用这一调用，不需要新增分类模型。

### 3.2 Precheck 收资语义

报名资料仍复用主 Agent 已完成的对话理解和现有确定性公证，不新增字段抽取 LLM；但主模型应通过
哪一种工具入参提交答案、岗位动态标签和常见语义字段如何统一，不在本方案继续重复定义。唯一执行
规格见 [Precheck 收资入参统一专项](./precheck-form-answer-contract-refactor.md)。

### 3.3 主 Agent 的对话理解

无岗、不满意、切换岗位、候选人追问等对话语义，主 Agent 已经能读取完整对话和结构化工具结果。对于这类不需要长期入档的判断，不再新增独立分类器，也不再用复杂正则重复判断。

## 4. 目标运行链路

### 4.1 表单外偏好

```text
候选人消息
  → 现有 extract_facts
  → preferences / brand_intents / labor_form_intent
  → 品牌目录、枚举、quote 等确定性验证
  → 写入偏好或品牌状态
```

### 4.2 输出回复

```text
主 Agent 根据对话和工具结果生成回复
  → 确定性 Output Guardrail 只做格式与事实对账
  → 局部清洗
  → 投递
```

Output Guardrail 不再用正则重新判断整段自然语言是否“像承诺”“像泛化”“像不满意”。

## 5. 分领域改造方案

### 5.1 品牌：实体继续确定性，极性复用 `brand_intents`

保留：

- 品牌 ID；
- 标准名完全匹配；
- 唯一别名完全匹配；
- 有长度和边界保护的子串匹配；
- 品牌目录标准化；
- 歧义检测；
- 模糊召回建议及候选人确认。

改造：

- `brand_intents` 负责复杂的 positive / negative / browse_all；
- `brand-matcher` 继续只负责实体匹配和标准化；
- 规则轨只保留非常明确的否定、换品牌、不限品牌表达，作为 LLM 降级兜底；
- LLM 正常返回时，不再让复杂 `polarity-rules.ts` 结果覆盖 LLM 极性；
- LLM 降级时，才使用现有规则轨极性；
- LLM 品牌名必须继续经过品牌目录验证；
- 模糊品牌只能作为建议，不得直接写入品牌状态。

涉及文件：

- `src/resolution/brand/brand-matcher.ts`
- `src/resolution/brand/polarity-rules.ts`
- `src/resolution/evidence/producers/brand-intents.ts`
- `src/memory/lifecycle.service.ts`

### 5.2 用工形式：`labor_form_intent` 从对照项改成生效结果

当前状态：

```text
decideLaborFormIntent() 规则轨掌舵
labor_form_intent 只用于 semantic_track_diff
```

目标状态：

```text
LLM 正常：labor_form_intent 掌舵
LLM 降级：decideLaborFormIntent() 兜底
```

行为定义：

- `intent=set`：使用 `labor_form` 中的标准枚举值；
- `intent=clear`：写入 labor-form tombstone；
- `intent=ignore`：本轮不修改已有 labor-form；
- LLM 输出非法或调用降级：使用现有规则结果；
- 规则产生的 labor-form turn hint 在 LLM 正常时不得覆盖 LLM 结果。

删除：

- `emitLaborFormSemanticTrackDiff()`；
- labor-form 的 `semantic_track_diff` 发射；
- 只为双轨对照存在的分支；
- LLM 正常时 rule-track 对 labor-form 的重复覆盖。

收缩：

- `src/resolution/labor-form/index.ts` 只保留降级兜底所需的核心明确表达；
- 不再增加当前工作、岗位询问、语气词和长尾否定的豁免正则。

涉及文件：

- `src/memory/short-term/facts.service.ts`
- `src/memory/short-term/short-term.types.ts`
- `src/memory/short-term/extraction.prompt.ts`
- `src/resolution/labor-form/index.ts`
- `src/resolution/evidence/producers/rule-track.ts`
- `src/resolution/evidence/producers/rule-track-preferences.ts`

### 5.3 无岗、不满意和切换意图：交给主 Agent

改造：

- 岗位工具本轮无结果时继续使用结构化 `noMatchScript`；
- 已拉群状态继续读取结构化 `invitedGroups`；
- 主 Agent 根据完整对话判断是否继续推荐、换范围或回答追问；
- `invite_timing_gate` 继续阻止错误或过早拉群；
- 删除通过助手历史文本推断“已经无岗几轮”的复杂正则；
- 删除 `DISSATISFACTION_SIGNAL` 及连续两轮不满意的文本计数；
- 不新增情绪分类器或独立 LLM 调用。

涉及文件：

- `src/tools/job-list/no-match-script.util.ts`
- `src/tools/invite/invite-timing-gate.ts`
- 主 Agent 的候选人沟通 Prompt。

### 5.4 Input Guardrail：只保留明确高风险形态

保留：

- 明确转人工；
- 明确投诉；
- 明确辱骂；
- 明确残障披露；
- 明确询问面试结果；
- 明确 Prompt Injection 封闭形态。

收缩：

- 删除可能大量命中正常句子的宽泛单词；
- 不再通过增加更多关键词覆盖开放表达；
- 不明确时交给主 Agent 正常响应，不做硬拦截；
- 不增加输入分类 LLM。

涉及文件：

- `src/agent/guardrail/input/risk-intercept.service.ts`
- `src/agent/guardrail/input/prompt-injection.service.ts`

### 5.5 Output Guardrail：只保留格式和权威事实对账

继续保留或迁移为确定性实现：

- `invalid_model_output`；
- `internal_output_leak`；
- `meta_narration_reply`；
- 日期与结构化时间的确定性一致性；
- `booking_receipt_mismatch`；
- `interview_time_change_unconfirmed`；
- `online_interview_location_claim`；
- `unsupported_store_status_speculation` 中有明确 no-match 工具事实的部分；
- `brand_alias_fuzzy_match_ignored`；
- 精确重复回复去重。

高风险安全规则只保留明确封闭形态：

- 身份造假教唆；
- 经历造假教唆；
- 歧视性筛选泄漏；
- 主动籍贯探问；
- 无依据名额承诺。

删除纯观察项：

- `example_value_leak`；
- `dangling_reply_promise`；
- `proactive_insurance_policy_mention`；
- `repeated_reply`；
- `job_detail_lookup_required`；
- `settlement_cycle_mismatch`；
- `requested_brand_mismatch`；
- `image_description_not_saved`。

迁移特殊项：

- `repeated_reply_verbatim` 移到 `OutboundReplySanitizer` 做精确文本去重；
- `handoff_promise_reconciliation` 移到回合结果/副作用处理；
- `date_reference_mismatch` 移到日期格式化或结构化日期一致性处理；
- 删除 Output Catalog 中只用于 observe 的执行分支。

不启用额外 Semantic Reviewer。开放语义约束由现有主 Agent Prompt 承担，Output Guardrail 不再调用第二个模型复审主 Agent。

涉及文件：

- `src/agent/guardrail/output/rules/output-rule-catalog.ts`
- `src/agent/guardrail/output/hard-rules.service.ts`
- `src/agent/guardrail/output/output-guardrail.service.ts`
- `src/agent/guardrail/output/outbound-reply-sanitizer.ts`
- `src/agent/runner/agent-runner.service.ts`
- `src/agent/guardrail/output/repair-regression.util.ts`
- 主 Agent 的候选人沟通与最终检查 Prompt。

## 6. 修复链简化

执行要求：

- 最多修复一次；
- 格式问题优先由代码直接修复；
- LLM 修复只修改命中的局部句子；
- 修复器不得调用业务工具；
- 修复器不得新增岗位、薪资、门店、地址、时间、预约状态或政策事实；
- 不再由纯观察规则触发修复；
- 可以精确删除的泄漏内容不得整段重写；
- 工具事实冲突无法安全局部修复时，使用已有固定安全口径；
- 继续保留修复版相对首版的结构、极性、日期和承诺回归检查。

## 7. 执行顺序

### 第一批：让现有 LLM 结果真正生效

- [x] `labor_form_intent` 从对照项改为生效结果；
- [x] 删除 `emitLaborFormSemanticTrackDiff()`；
- [x] 删除 labor-form 的 `semantic_track_diff` 发射；
- [x] LLM 正常时禁止 rule-track 覆盖 labor-form；
- [x] LLM 降级时回退 `decideLaborFormIntent()`；
- [x] `brand_intents` 负责复杂品牌极性；
- [x] LLM 正常时规则轨仅保留品牌实体结果，不覆盖复杂极性；
- [x] LLM 降级时回退品牌极性正则。

### 第二批：删除重复对话语义判断

- [x] 删除 `DISSATISFACTION_SIGNAL`；
- [x] 删除连续两轮不满意的文本计数；
- [x] 保留本轮结构化 `noMatchScript`；
- [x] 保留 `invite_timing_gate`；
- [x] 收缩 Input Guardrail 宽泛关键词；
- [x] 不新增输入语义分类器。

### 第三批：Output Guardrail 瘦身

- [x] 删除纯观察规则；
- [x] 精确重复回复移到 sanitizer；
- [x] handoff 对账移到副作用处理；
- [x] 日期错配移到日期格式化/一致性处理；
- [x] 只保留格式、封闭词形和工具事实对账规则；
- [x] 收窄造假、歧视等高风险正则；
- [x] 删除开放语义泛化规则；
- [x] 不启用额外 Semantic Reviewer；
- [x] 修复器只做一次局部修复。

### 第四批：清理与验证

- [x] 删除不再引用的正则、常量、分支和测试夹具；
- [x] 删除不再使用的规则实现文件；
- [x] 更新 Output Rule Catalog；
- [x] 更新 Guardrail、品牌、用工形式和语义三分法文档；
- [x] 更新 Prompt Rule Ledger；
- [x] 补充 LLM 正常与降级回退测试；
- [x] 补充品牌极性、labor-form 和工具回执回归测试；
- [x] 运行格式检查、类型检查、相关单测和完整 CI。

## 8. 必测场景

### 品牌

- [x] “我想去肯德基”；
- [x] “肯德基以前做过，不想再去了”；
- [x] “这个不考虑了”；
- [x] “品牌都可以”；
- [x] 同一轮同时表达正向和排斥；
- [x] LLM 降级时明确否定仍能由规则兜底；
- [x] 模糊品牌不会直接写入状态。

### 用工形式

- [x] “我找全职”；
- [x] “我现在做兼职，但接下来想找全职”；
- [x] “这是兼职岗位吗”必须为 ignore；
- [x] “兼职不考虑了”必须 clear；
- [x] LLM 降级时核心明确表达仍能识别；
- [x] ignore 不覆盖已有偏好。

### Output 与工具

- [x] booking 成功回执与回复一致；
- [x] 未成功改约时不得确认新时间；
- [x] 线上面试不得发送到店指引；
- [x] 无岗位事实时不得猜关店、搬迁或招满；
- [x] 精确重复回复可以确定性去重；
- [x] 格式泄漏可以局部删除，不整段重写；
- [x] 修复器不得新增事实。

## 9. 完成标准

改造完成必须同时满足：

- [x] 没有新增 LLM 调用；
- [x] 没有新增观测项、Dashboard、shadow diff 或 Rule Catalog；
- [x] `brand_intents` 已承担复杂品牌极性；
- [x] `labor_form_intent` 已直接影响偏好，不再只做对照；
- [x] Precheck 收资入参未在本方案中被重复改造，专项边界保持清晰；
- [x] `extract_facts` 仍只处理表单外软事实；
- [x] labor-form 和品牌极性正则明显收缩；
- [x] 无岗与不满意不再依靠复杂历史文本计数；
- [x] Output Guardrail 只保留格式、封闭高风险形态和权威事实对账；
- [x] 纯观察规则已删除或迁移到真实行为位置；
- [x] 报名、改约、拉群的确定性闸门保持不变；
- [x] 相关单测、类型检查和 CI 全部通过；
- [x] 文档与实际代码保持一致。

## 10. 恢复记录（2026-08-26 数据复核）

改造完成当日按近 7/30 天生产 `guardrail_review_records` 逐条复核删除项，做了定点回补
（非整体回滚），详见 prompt-rule-ledger 第七节：

- **恢复执行档**：`human_service_phrase_leak`——近 7 天仍有真阳人设露馅（"真人经理已经
  说了…"直发前被拦），封闭词形 7-21 升档史零误报，符合本方案"只保留封闭词形"的保留标准，
  属误删。
- **恢复 observe 哨兵（只落档不拦截）**：`dangling_reply_promise`、`requested_brand_mismatch`、
  `settlement_cycle_mismatch`、`proactive_insurance_policy_mention`。
- **新哨兵**：`booking_done_claim_without_submission`（observe 入场）接替
  `booking_promise_without_booking` 的完成时态缺口；原规则的将来时口径经抽样证实
  几乎全命中合法收资话术（约 60 次/天），维持删除。
- **维持删除**：语义审查器全链路（生产 shadow-only、近全假阳）、
  `job_detail_lookup_required`（宽口径噪音 200 次/周）、`date_reference_mismatch`
  （抽样全为日期正确记录）、`unsupported_schedule_window_claim`（8 次/周中约 6-7 假阳，
  拦的是诚实兜底话术）及全部零命中规则族。

## 11. 执行 Goal 指令

```text
/goal 按 docs/todo/llm-reuse-rule-simplification-plan.md 完成规则简化改造。必须复用现有 extract_facts、brand_intents、labor_form_intent、主 Agent 对话理解和工具闸门；precheck 的 candidateClaims/formAnswers 问题不在本 Goal 内改动，另按 docs/todo/precheck-form-answer-contract-refactor.md 执行。不得新增任何 LLM 调用、观测项、Dashboard、Rule Catalog、shadow diff 或人工标注流程。按文档执行顺序逐批实施，保护工作区已有改动，完成相关单测、类型检查和 CI；发现文档与当前代码冲突时，以“不新增能力、删除重复语义正则、保留确定性格式/目录/工具回执对账”为原则做最小改造，直至清单与完成标准全部满足。
```
