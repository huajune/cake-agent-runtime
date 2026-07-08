# 出站守卫与记忆系统改造方案（收缩执行版）

> 状态：收缩执行版（2026-07-08）
> 设计依据：[rules-vs-semantics-design-philosophy.md](./rules-vs-semantics-design-philosophy.md)（先读它，本文所有决策都引用其中原则编号 P1~P10）
> 本文档是自包含的实施说明书：短期优先止血和减少生成错误，不预建评估系统；
> 只记录必要过程数据，分析直接查 SQL。

---

## 0. 背景与目标

### 0.1 问题

出站守卫（`src/agent/guardrail/output/`）原有 37 条硬规则 + 一次受控 repair 回路。
止血版退役 9 条无人消费的死遥测/教练规则，规则档收敛到 28 条。
`guardrail_review_records` 上线首两日（2026-07-06 ~ 07-07）生产数据：

- 301 条判例中 180 条进入 repair，58 条最终 block（候选人整轮静默，约 29 次/天）；
- **58 次静默中 28 次（48%）由 repair 回路自己制造**：首版命中规则（多为假阳）→
  `toolMode:'none'` 无工具重写 → 模型把工具调用写成文本 → `internal_output_leak`
  拦下重写版 → 静默；
- 命中榜前两名 `district_level_distance_claim`（68 次）、`group_promise_without_invite`
  （52 次）抽样以假阳为主；
- 档案标本 id=166：首版如实推荐真实岗位（9.4km），因区级定位公里数进重写，
  重写版把真岗位改口成"暂时没找到岗位"，再被二审拦掉——修复制造事实错误后静默。

记忆系统（`src/memory/`）的规则提取层用 15+ 组正则从自然语言提取事实，
合并层用可变 JSON + deepMerge + 置信度守卫，存在静默覆盖（已知 badcase：
"后厨(high)"被"内场(medium)"覆盖）、同置信度顺序未定义、历史不可审计三个结构缺陷。

### 0.2 目标（可量化验收）

| 指标 | 基线（07-06~07） | 目标 |
|------|------|------|
| 非 P0 静默次数/天 | ~29 | < 2 |
| 修复制造的静默占比（repair 产物泄漏/悬空导致的 block） | 48% | ≈ 0 |
| 值级错报类规则命中/周（开启岗位卡渲染后） | — | 趋零 |
| 每条 veto 规则的精确率 | 不稳定 | 从 `guardrail_review_records` 抽样 + SQL 复盘 |

### 0.3 范围外（本轮不做）

- 不整体删除规则档，不动工具层 37 个闸门（它们是正确设计，见哲学文档 P1/P3）；
- 不动输入守卫（risk-intercept / prompt-injection）与消息管道过滤规则；
- 不新建 `semantic_review_records`、统计 RPC 或 Dashboard；评估直接查
  `guardrail_review_records`；
- 不新建记忆观测表，不启动 resolver/确认流改造；记忆系统保持现状，另行排期。

---

## 1. 现状代码地图（实施前必读的文件）

| 区域 | 文件 | 说明 |
|------|------|------|
| 规则目录 | `src/agent/guardrail/output/rules/output-rule-catalog.ts` | 28 条规则元数据（action/priority/feedback），`catalog.spec` 校验 id 一致性 |
| 规则调度 | `src/agent/guardrail/output/hard-rules.service.ts` | 显式编排全部 detect 函数，输出 RuleContradiction[] |
| 裁决组合 | `src/agent/guardrail/output/output-guardrail.service.ts` | rule 档 + llm 档合成 pass/revise/replan/block；语义档开关读 `SystemConfigService.getAgentReplyConfig()` |
| repair 回路 | `src/agent/runner/agent-runner.service.ts` 的 `invokeReviewed()`（约 L175-345） | 一次受控 repair；`revise_empty`/`revise_dangling` 直接 block；二审仍 revise 时 P1/P2 可 fail-open（reasonCode `repair_exhausted_fail_open`） |
| 悬空检测 | `src/agent/runner/dangling-reply.ts` | repair 产物"我帮你查下X"式空头承诺判定 |
| 判例落库 | `guardrail_review_records` 表（迁移 `20260706110000` 修复了 upsert） | 首版/重写版/裁决/reasonCode 全量归档 |
| 声称判定 | `src/agent/guardrail/output/rules/claim-assertion.util.ts` | 句/小句粒度的否定、疑问豁免共享原语 |
| 语义档 | `src/agent/guardrail/output/llm/semantic-reviewer.service.ts` + `review-packet.builder.ts` | shadow/enforce 双 flag；短期不做新表评估基建 |
| 记忆提取 | `src/memory/facts/high-confidence-facts.ts` | 15+ 字段正则提取 + name-guard |
| 记忆合并 | `src/memory/services/session.service.ts`（`mergeFactsWithConfidenceGuard`，约 L215-244）+ `src/memory/stores/deep-merge.util.ts` | 可变 JSON 合并 + 置信度守卫 |
| 岗位工具 | `src/tools/duliday/job-list/`（`search.util.ts`、`salary-facts.util.ts`） | job_list 返回 markdown + rawData |
| 运行时配置 | `src/biz/hosting-config/services/system-config.service.ts` | `agent_reply_config` 增字段的模式参考（Dashboard 即时生效，env 仅 bootstrap 默认值） |

---

## 2. WS2：修复回路改造（最高优先级，先做）

> 对应原则 P4（修复原语分级）。目标：静默清零 + 修复制造率归零。
> 全部改动在 `src/agent/guardrail/output/` 与 `src/agent/runner/`，不碰规则本身。

### 2.1 确定性文本修补（不建层）

不新增 `transforms/`、注册表、接口或 catalog 字段。只在现有
`src/agent/guardrail/output/hard-rules.service.ts` 放一个小函数：

```typescript
/** 命中规则里能用字符串替换修好的，先直接修；修不了返回 null 走正常重写。 */
export function tryDeterministicFix(text: string, blockedRuleIds: string[]): string | null {
  if (blockedRuleIds.includes('brand_name_violation')) {
    const fixed = sanitizeBrandName(text);
    if (fixed !== text) return fixed;
  }
  if (blockedRuleIds.includes('district_level_distance_claim')) {
    return text.replace(/(\d+(?:\.\d+)?)\s*(?:km|公里|千米)/gi, (_, n) =>
      `约${Math.round(Number(n))}公里（按区域位置估算的）`,
    );
  }
  return null;
}
```

保留两个修补动作，不保留抽象层：

1. `brand_name_violation` 的平台名错字：复用 `sanitizeBrandName(text)` 直接替换。
   若是岗位品牌被模型改写，`sanitizeBrandName` 修不了，自动回落 rewrite。
2. `district_level_distance_claim`：消化命中榜第一名（68 次/2天），把精确距离
   `(\d+(?:\.\d+)?)\s*(?:km|公里|千米)` 替换为
   `约N公里（按区域位置估算的）`。这比每天多 30 多次 LLM 重写更便宜，也避免已知
   badcase 里 LLM 把真岗位改坏。

**接线**（`agent-runner.service.ts` 的 `invokeReviewed`）：

首审 decision 为 revise/replan/block 且不可发送时，在进入 LLM repair **之前**插入一次小修尝试：

```
fixed = tryDeterministicFix(firstText, decision.blockedRuleIds)
若 fixed 非空：
    对 fixed 重跑 outputGuard.check（silent: true，避免重复飞书告警）
    若 fixed 裁决为 pass/observe：
        采纳 fixed
        persistReviewRecord：revised_reply = fixed，reason_code = 'deterministic_fix'
        跳过 LLM repair，直接 finalize
    否则：回退原 repair 路径
```

### 2.2 repair 生成的提示词加固

定位 generator 中消费 `guardrailRepair` / `reviseFeedback` 拼 repair prompt 的位置
（`src/agent/generator/` 内搜索 `guardrailRepair`）。当 `toolMode === 'none'` 时，
在修复指令中**显式追加**：

> 本次修复不能调用任何工具。不要输出任何工具名、函数调用、JSON、方括号指令或
> XML 标签——只输出发给候选人的纯中文文本。如果你认为需要重新查询才能回答，
> 不要尝试查询，改为向候选人自然地确认信息或告知稍后跟进。

这是 48% 静默的直接病灶的第一道防线（第二道见 2.3）。

### 2.3 fail-open 阶梯扩展（静默清零的关键）

`invokeReviewed` 现有三个"以静默收场"的分支，逐一改造。定义辅助判定：

```typescript
// 首版是否有资格 fail-open：非 high 风险，且全部违规可恢复
const firstFailOpenEligible =
  decision.riskLevel !== 'high' &&
  decision.violations.every(v => v.recoverability !== 'non_recoverable');
```

1. **`revise_empty` / `revise_dangling` 分支**（repair 产物为空或悬空承接句）：
   现状直接 block。改为：若 `firstFailOpenEligible` → **投递首版**，
   `reasonCode: 'repair_unusable_fail_open'`；否则维持 block。
2. **repair 产物泄漏分支**：二审 `decision2.decision === 'block'` 且
   `decision2.blockedRuleIds` **仅含** `internal_output_leak`（即垃圾是 repair
   制造的，不是首版的问题）：若 `firstFailOpenEligible` → 投递首版，
   同 reasonCode；否则 block。
3. **`repair_exhausted` 分支**：现有 P1/P2 fail-open 投递**修复版**的逻辑保留，
   但增加一个比较：若修复版的违规集合是首版违规集合的超集（修复没有变好），
   投递**首版**而非修复版（避免 id=166"真岗位改口成没岗位"的修复劣化被投出去）。
   实现上比较 `decision2.blockedRuleIds ⊇ decision.blockedRuleIds` 即可，不必语义对比。

三个分支都必须 `persistReviewRecord`（final_decision='pass' + 对应 reasonCode），
并保留飞书告警（fail-open 不是无声放行，是"投递 + 欠债告警"）。

### 2.4 回归测试（必做）

- 单测：`tests/agent/runner/agent-runner.service.spec.ts` 补三个分支的用例
  （首版 P1 违规 + repair 产物为工具调用文本 → 投递首版；首版 P0 → 仍 block）；
- **判例回放**：从 `guardrail_review_records` 摘取以下档案 id 的
  `first_reply`/`user_message`/`first_rule_ids` 做成 fixture，断言新逻辑下
  final_decision 不再是 block：id=166（松江真岗位）、id=195/197/185/186/161/164
  （repair 泄漏系列）。fixture 数据放 `tests/agent/guardrail/output/fixtures/`，
  注意脱敏（去掉真实手机号/姓名，档案里主要是岗位文案，风险低）。

### 2.5 验收

- 上线一周后查：`reason_code='repair_unusable_fail_open'` 有量、
  block 中 revised 命中 internal_output_leak 的记录 ≈ 0、
  非 P0 `final_decision='block'` < 2/天。

---

## 3. WS5：规则档治理（第二优先级，改动小、生效快）

> 对应原则 P5（教练规则不进 veto 档）、P8（数据驱动升降档）、§3 三条件准入测试。
> 改动集中在 `output-rule-catalog.ts` + rule 调度 + 对应 spec。

### 3.1 observe 准入：必须有消费者

`observe` 不是规则养老档。每条 observe 必须写清楚：

- **消费者**：谁会看这个命中，拿它做什么决策；
- **退场条件**：什么情况下删掉或按构造替代；
- **查询方式**：只进 `guardrail_review_records`，分析直接写 SQL，不写飞书告警、不新建表。

没有消费者的 observe 视为死遥测：只会制造维护债和告警噪音，应直接退役。

### 3.2 本轮直接退役 9 条死遥测/教练规则

| 规则 | 动作 | 理由 |
|------|------|------|
| `geocode_ambiguous_candidates_omitted` | 删除 catalog + detect + 调度 + spec | 同域问题已有语义 finding（brand_or_geo_ambiguity_ignored），这是教练规则，无升档路径 |
| `farther_job_recommended` | 删除 catalog + detect + 调度 + spec | 多目标推荐权衡不该按距离单维度判，已有语义 finding（job_recommendation_not_best_supported） |
| `work_content_generalization` | 从 FactRule 列表删除 | “餐饮一般要洗碗”等是真人招募正常模糊话术，不是稳定缺陷 |
| `provided_booking_fields_ignored` | 删除 catalog + detect + 调度 + spec | 7 组正则做自然语言字段理解，观测噪音高；重复收资走 badcase 分析更准 |
| `group_invite_without_reason` | 删除 catalog + detect + 调度 + spec | “理由是否充分”是语义判断，两天 63 次命中无人消费，刷屏噪音 |
| `repeated_greeting` | 删除 catalog + detect + 调度 + spec | 与 `repeated_reply` 概念重叠，隔天重连等合理问候会大量误计 |
| `candidate_name_echo` | 删除 catalog + detect + 调度 + spec | 靠企微备注子串撞普通中文词，误报面大；若担心备注泄漏，应改查封闭内部标记形态 |
| `distance_missing` | 删除 catalog + detect + 调度 + spec | 观察“漏说距离”没有消费者；距离应由岗位卡渲染器从 `rawData` 按构造填充 |
| `confirmed_booking_onsite_script_missing` | 删除 catalog + detect + 调度 + spec | 到店脚本在 booking 工具返回里，应由代码拼进成功话术，不观察模型说没说 |

删除不丢历史：旧命中仍在 `guardrail_review_records` 和飞书历史里；若将来证明需要复活，从 git 历史恢复并补消费者/退场条件。

### 3.3 暂留 observe 的 5 条

| 规则 | 消费者 | 退场条件 |
|------|------|------|
| `proactive_insurance_policy_mention` | 运营复盘准不可逆承诺样本 | 收窄成承诺式后观察 2 周，仍全是假阳则删除，交语义档 `unsupported_commitment` |
| `system_status_fabrication` | 运营话术复盘“甩锅系统”投诉源 | 工具真失败豁免后观察 2 周，若无人消费告警则删除 |
| `human_service_phrase_leak` | 人设 prompt 迭代；封闭词表 + 已有运营反馈判例 | 长期保留 |
| `wait_notice_time_collection` | prompt 修复验证指标 | 命中归零 1 个月后删除 |
| `repeated_reply` | badcase 簇复盘/生成策略治理；有真实已发消息 ground truth | 保留到生成层能稳定避免整段复读后再删 |

### 3.4 留下的 28 条分四条路

| 路径 | 规则 | 处理 |
|------|------|------|
| 代码直接修 | `brand_name_violation` 的平台名别名、`district_level_distance_claim` | `tryDeterministicFix` 后复检，干净则直接投递；`brand_name_violation` 中岗位品牌错配无法 sanitize 时回落重写 |
| 重查工具 | `ungrounded_job_recommendation`、`requested_brand_mismatch` | `repairMode=replan`，只读工具重新查岗/查指定品牌 |
| 打回重写 | `tool_failure_success_claim`、`precheck_blocked_booking_claim`、`handoff_no_booking_claim`、`group_full_without_invite`、`group_promise_without_invite`、`wait_notice_time_fabrication`、`schedule_filtered_job_recommended`、`geocode_uncertain_location_claim`、`salary_fabrication`、`hourly_salary_value_mismatch`、`job_shift_polarity_mismatch`、`settlement_cycle_mismatch`、`brand_alias_fuzzy_match_ignored`、`confirmed_booking_time_missing`、`booking_form_field_mismatch`、`image_description_not_saved`、`internal_output_leak`、`quota_promise`、`discriminatory_screening_leak` | 一次受控重写；二审仍不通过则 `repair_exhausted`。P0/high 或 non_recoverable 不 fail-open |
| 只观察 | `proactive_insurance_policy_mention`、`system_status_fabrication`、`human_service_phrase_leak`、`wait_notice_time_collection`、`repeated_reply` | 只落 `guardrail_review_records`，不写飞书告警；每条有消费者/退场条件 |

### 3.5 机制调整：block 也先救

`agent-runner.service.ts` 的 repair 入口改成：

```typescript
const shouldRepair = decision.decision !== 'pass' && decision.decision !== 'observe';
```

即 `block` 不再首轮静默，先和 `revise/replan` 一样进入一次受控修复。
二审仍为非 `pass/observe` 时统一收敛为 `repair_exhausted`；高风险或不可恢复违规仍不会
fail-open，因此安全性不降。

### 3.6 测试

- `tests/agent/guardrail/output/hard-rules.service.spec.ts` 删除退役规则用例，保留 5 条 observe 的断言；
- `tests/agent/guardrail/catalog.spec.ts` 保持通过，确保 catalog、审计目录、规则调度同步；
- 用 `guardrail_review_records` SQL 复盘保留 observe 的命中量和消费情况。

---

## 4. WS3：轻量观测与 SQL 复盘（不建新系统）

> 对应原则 P8（升档靠数据）、P10（只记录必要过程数据）。
> 本轮不建 `semantic_review_records`、不建统计 RPC、不做 Dashboard。
> 先复用已有 `guardrail_review_records`，分析时直接写 SQL。

### 4.1 记录边界

短期只要求已有审查档案能回答这些问题：

- 首版命中了哪些规则：`first_rule_ids`；
- 修复版命中了哪些规则：`revised_rule_ids`；
- 最终是否静默：`final_decision='block'`；
- 为什么放行/拦截：`reason_code`；
- 是否由 repair 制造事故：`revised_rule_ids` 含 `internal_output_leak`，
  或 `reason_code` 为 `revise_empty` / `revise_dangling` /
  `repair_unusable_fail_open`；
- 确定性文本修补是否生效：`reason_code='deterministic_fix'`。

如果某个新路径没有进入 `guardrail_review_records`，优先补现有记录字段或
`reason_code`，不要先建新表。

### 4.2 直接 SQL 示例

非 P0 静默趋势：

```sql
SELECT date_trunc('day', created_at) AS day, count(*) AS blocks
FROM guardrail_review_records
WHERE final_decision = 'block'
  AND NOT ('internal_output_leak' = ANY(first_rule_ids))
GROUP BY 1
ORDER BY 1 DESC;
```

repair 自己制造事故：

```sql
SELECT date_trunc('day', created_at) AS day, count(*) AS repair_made_blocks
FROM guardrail_review_records
WHERE final_decision = 'block'
  AND (
    'internal_output_leak' = ANY(revised_rule_ids)
    OR reason_code IN ('revise_empty', 'revise_dangling')
  )
GROUP BY 1
ORDER BY 1 DESC;
```

fail-open 与确定性文本修补量：

```sql
SELECT reason_code, count(*) AS n
FROM guardrail_review_records
WHERE reason_code IN (
  'deterministic_fix',
  'repair_unusable_fail_open',
  'repair_exhausted_fail_open'
)
GROUP BY 1
ORDER BY n DESC;
```

分规则命中趋势：

```sql
SELECT date_trunc('day', created_at) AS day, rule_id, count(*) AS hits
FROM guardrail_review_records,
LATERAL unnest(first_rule_ids) AS rule_id
GROUP BY 1, 2
ORDER BY 1 DESC, hits DESC;
```

### 4.3 语义档暂缓

语义 reviewer 的 shadow/enforce 灰度暂不作为本轮工程目标。需要复盘开放语言误伤时，
先从 `guardrail_review_records` 的 hard-rule 判例和飞书 badcase 抽样；如果后续确认
语义档要进入 enforce，再单独设计最小记录字段，不预先搭评估平台。

---

## 5. WS1：岗位卡模板渲染化（按构造约束）

> 对应原则 P2。一步消除"模型转抄岗位数字"这一整类幻觉的产生土壤，
> 是唯一"增强"而非"删减"回复可靠性的工作流。feature flag 全程可回退。

### 5.1 协议设计

模型输出占位符，代码渲染卡片：

- **占位符语法**：`{{job_card:<jobId>}}`，独占一行；
- **数据源**：本轮 `duliday_job_list` 全部可用结果（复用
  `src/agent/guardrail/output/rules/job-list-call.util.ts` 的"可用"口径与
  多次调用并集语义）中匹配 jobId 的岗位 `rawData`；
- **渲染模板**（与现有 markdown 卡片格式对齐，保证 `MessageSplitter` 的
  表单块保护继续生效）：

  ```
  {品牌}（{门店}）- {工种}{，X.Xkm 或 ，约X公里（按区域位置估算）}
  班次：{班次描述}
  薪资：{薪资行，来自 salary-facts/jobSalary 原文}
  要求：{年龄/健康证等要求行}
  ```

- **距离口径**：本轮 geocode 结果 `areaLevelQuery === true` 时渲染
  `约N公里（按你说的区域大概估算的）`，否则 `X.Xkm`——**结构性消化
  `district_level_distance_claim`**（与 WS2 确定性文本修补双保险）；
- **未知 jobId**（不在本轮可用结果中）：整行删除占位符 + `logger.warn` +
  写 `guardrail_review_records` 风格的观测（或飞书 observe 告警）。
  绝不把原始占位符发给候选人。

### 5.2 实施点

1. **渲染服务**：新增 `src/agent/reply/job-card-renderer.service.ts`
   （或放 `src/agent/runner/`，遵循分层：依赖 toolCalls，不依赖 wecom 层）。
   纯函数核心 + 注入 Logger，输入 `(replyText, toolCalls, geocodeContext)`，
   输出渲染后文本；
2. **接线位置**：`invokeReviewed` 完成守卫裁决**之后**、结果返回**之前**渲染
   （守卫检查占位符形态的文本——占位符本身无数字，不会触发值对账规则；
   渲染产物是确定性的，无需再审）。**必须保证投递与写入会话历史的是渲染后文本**
   （`repeated_reply` 对账依赖真实已发文本）；
3. **Prompt**：在 `src/agent/generator/context/sections/` 新增或扩展岗位推荐
   Section：推荐岗位时用 `{{job_card:jobId}}` 占位、卡片外的对话文字不得手写
   薪资/班次/距离数字（值对账规则保留作为手写事实的兜底，不删）；
4. **开关**：`agent_reply_config` 增字段 `jobCardRenderEnabled`（默认 false，
   env bootstrap `JOB_CARD_RENDER_ENABLED`），同时门控 Prompt Section 注入与
   渲染服务（关闭时占位符协议不出现在 prompt 里，模型行为与现状一致）。
   参考 `outputGuardrailLlmEnabled` 的实现模式（SystemConfigService →
   1s 热缓存 → Redis → DB → env）。

### 5.3 测试与验收

- 渲染服务单测：正常渲染 / 未知 jobId 剔除 / areaLevelQuery 距离口径 /
  多次 job_list 调用并集取数 / 占位符混排普通文本；
- 集成断言：渲染后文本通过 `MessageSplitter` 时卡片不被拆碎
  （现有 splitter 测试模式参考 `tests/channels/wecom/`）；
- 验收：flag 开启一周后，`hourly_salary_value_mismatch` /
  `settlement_cycle_mismatch` / `job_shift_polarity_mismatch` /
  `district_level_distance_claim` 周命中数对比 flag 开启前显著下降（目标趋零）。

---

## 6. WS4：记忆层改造暂缓

> 对应原则 P7（确认换置信度）、P9（观测流 + 解析器）。
> 这是长期正确方向，但本轮不做新表、不做 resolver、不改读路径。

### 6.1 当前只保留问题陈述

记忆系统现状仍有三类结构问题：

- 可变 JSON + deepMerge 会静默覆盖历史事实；
- 同置信度覆盖顺序不稳定；
- 字段值缺少完整来源链路，复盘成本高。

这些问题暂不进入本轮发版。短期只处理出站守卫静默、repair 修坏、规则误伤和岗位事实
转抄错报。

### 6.2 未来触发条件

只有出现以下任一情况，才重新打开 WS4：

- 记忆覆盖直接造成报名失败、错约或明显业务损失；
- 需要把姓名/电话这类报名级字段改成确认流；
- 现有 facts 存储已经无法通过 SQL 或日志复盘某类高频问题。

重新打开时也先做最小方案：先确认已有表或消息记录能否承载必要来源信息；只有没有合适
归属时，才讨论新增表。

---

## 7. PR 拆分与执行顺序

| PR | 内容 | 依赖 | 预估规模 |
|----|------|------|---------|
| PR-1 | WS2 全部（确定性文本修补 + repair prompt 加固 + fail-open 阶梯 + 判例回放 fixture） | 无 | 中 |
| PR-2 | WS5 全部（档位再分配 + 保险规则收窄 + system_status 豁免 + group_promise 回归 fixture + catalog 治理注释） | 无（与 PR-1 并行可） | 小 |
| PR-3 | WS3 轻量观测：确认 `guardrail_review_records` 已覆盖 reasonCode / ruleIds，补缺失字段或记录路径；附 SQL 查询文档，不建新表 | PR-1/2 后 | 小 |
| PR-4 | WS1（渲染服务 + prompt section + flag + 测试） | 无 | 中 |

顺序建议：PR-1 → PR-2 立即做（止血）；PR-3 只补记录和 SQL 文档；
PR-4 做岗位卡模板渲染。WS4 记忆层改造暂缓，不进入本轮 PR 队列。

---

## 8. 仓库执行须知（给实施者）

1. **分支与 PR**：从 `develop` 切分支，PR 目标 `develop`（本仓库无 main，
   主线是 master，由 release 流程合并）。Conventional Commits。
2. **并发工作区**：仓库常有多会话并发改码，`git commit` 必须用 pathspec
   限定本 PR 文件，勿 `git add -A`。
3. **测试**：`nvm use 22.16.0`，`pnpm run test -- <spec路径> --no-watchman`
   （不加 `--no-watchman` 会静默跑 0 个测试）。测试放 `tests/` 镜像目录。
4. **迁移**：本轮原则上不新增表。确需补字段时才用 `pnpm run db:new <name>`
   生成迁移，SQL 幂等，`pnpm run db:push:test` 验证；**不要向生产 push**，
   生产迁移随发版流程执行。
5. **代码规范**：严格 TS（无 any）、构造器注入、Logger（禁 console）、
   服务 <500 行；`infra/` 禁止 import `biz/`、`agent/`。
6. **观测纪律**：所有新的拦截/降级/fail-open 事件必须进入现有可查询链路
   （优先 `guardrail_review_records` 的 `reason_code` / ruleIds）或发飞书告警；
   不为了分析预建 Dashboard/RPC/新表。
7. **catalog 一致性**：改规则必须同步 `output-rule-catalog.ts` 元数据，
   `catalog.spec` 会校验 ruleId 集合一致。
8. **flag 模式**：新增运行时开关一律进 `agent_reply_config`
   （SystemConfigService，Dashboard 即时生效），env 变量只作 bootstrap 默认值，
   默认关闭。

---

## 9. 风险与回退

| 风险 | 缓解 |
|------|------|
| fail-open 把带瑕疵的首版发出去 | 仅限 P1/P2 可恢复违规；每次 fail-open 都有飞书告警 + 档案 reasonCode，可周度复盘；P0/不可恢复维持 block |
| 确定性文本修补误改正常文本 | 只在对应规则命中时应用，产物重过规则档复核，不干净即回退 rewrite |
| 渲染卡片降低回复自然度 | 卡片外的对话文字仍由模型自由发挥；flag 可即时回退 |
| 记录不够分析 | 优先补现有 `guardrail_review_records` 的 reasonCode / ruleIds / trace 字段；仍不够再讨论最小迁移 |
| 保险/教练规则降档后漏放真问题 | observe 告警保留观测；用现有审查档案 + SQL 抽样复盘，必要时再升档 |
