# 出站守卫与记忆系统改造方案（执行版）

> 状态：待实施（2026-07-07）
> 设计依据：[rules-vs-semantics-design-philosophy.md](./rules-vs-semantics-design-philosophy.md)（先读它，本文所有决策都引用其中原则编号 P1~P10）
> 本文档是自包含的实施说明书：不依赖任何会话上下文，按工作流（WS1~WS5）+ PR 拆分执行。

---

## 0. 背景与目标

### 0.1 问题

出站守卫（`src/agent/guardrail/output/`）现有 35 条硬规则 + 一次受控 repair 回路。
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
| 每条 veto 规则的精确率 | 不可测 | 可从判例库直接计算 |
| 记忆事实覆盖可审计性 | 不可审计 | 每个字段值可回溯到观测记录 |

### 0.3 范围外（本次不做）

- 不整体删除规则档，不动工具层 37 个闸门（它们是正确设计，见哲学文档 P1/P3）；
- 不动输入守卫（risk-intercept / prompt-injection）与消息管道过滤规则；
- 语义档（LLM reviewer）的 enforce 灰度是运营动作，本次只做它的评估基建（WS3）；
- 记忆确认流（WS4c）只出设计与最小实现（姓名/电话），不铺开到全部字段。

---

## 1. 现状代码地图（实施前必读的文件）

| 区域 | 文件 | 说明 |
|------|------|------|
| 规则目录 | `src/agent/guardrail/output/rules/output-rule-catalog.ts` | 35 条规则元数据（action/priority/feedback），`catalog.spec` 校验 id 一致性 |
| 规则调度 | `src/agent/guardrail/output/hard-rules.service.ts` | 显式编排全部 detect 函数，输出 RuleContradiction[] |
| 裁决组合 | `src/agent/guardrail/output/output-guardrail.service.ts` | rule 档 + llm 档合成 pass/revise/replan/block；语义档开关读 `SystemConfigService.getAgentReplyConfig()` |
| repair 回路 | `src/agent/runner/agent-runner.service.ts` 的 `invokeReviewed()`（约 L175-345） | 一次受控 repair；`revise_empty`/`revise_dangling` 直接 block；二审仍 revise 时 P1/P2 可 fail-open（reasonCode `repair_exhausted_fail_open`） |
| 悬空检测 | `src/agent/runner/dangling-reply.ts` | repair 产物"我帮你查下X"式空头承诺判定 |
| 判例落库 | `guardrail_review_records` 表（迁移 `20260706110000` 修复了 upsert） | 首版/重写版/裁决/reasonCode 全量归档 |
| 声称判定 | `src/agent/guardrail/output/rules/claim-assertion.util.ts` | 句/小句粒度的否定、疑问豁免共享原语 |
| 语义档 | `src/agent/guardrail/output/llm/semantic-reviewer.service.ts` + `review-packet.builder.ts` | shadow/enforce 双 flag，判例目前只发飞书 |
| 记忆提取 | `src/memory/facts/high-confidence-facts.ts` | 15+ 字段正则提取 + name-guard |
| 记忆合并 | `src/memory/services/session.service.ts`（`mergeFactsWithConfidenceGuard`，约 L215-244）+ `src/memory/stores/deep-merge.util.ts` | 可变 JSON 合并 + 置信度守卫 |
| 岗位工具 | `src/tools/duliday/job-list/`（`search.util.ts`、`salary-facts.util.ts`） | job_list 返回 markdown + rawData |
| 运行时配置 | `src/biz/hosting-config/services/system-config.service.ts` | `agent_reply_config` 增字段的模式参考（Dashboard 即时生效，env 仅 bootstrap 默认值） |

---

## 2. WS2：修复回路改造（最高优先级，先做）

> 对应原则 P4（修复原语分级）。目标：静默清零 + 修复制造率归零。
> 全部改动在 `src/agent/guardrail/output/` 与 `src/agent/runner/`，不碰规则本身。

### 2.1 确定性变换层（transform）

**新增** `src/agent/guardrail/output/transforms/`：

```typescript
// output-transform.types.ts
export interface OutputRuleTransform {
  ruleId: string;
  /**
   * 尝试对违规文本做确定性修补。
   * 返回修补后的全文；无法安全修补时返回 null（回退到 rewrite 路径）。
   * 必须是纯函数：不调用 LLM、不做 IO。
   */
  apply(text: string, toolCalls: AgentToolCall[]): string | null;
}
```

首批注册两个 transform：

1. **`district-level-distance.transform.ts`**（消化命中榜第一名，68 次/2天）：
   把回复中的精确距离表述 `(\d+(?:\.\d+)?)\s*(?:km|公里|千米)` 替换为
   `约N公里（按区域位置大概估算的）`（N 取整）。仅当
   `district_level_distance_claim` 命中时应用。替换后该规则的
   `SPECIFIC_LOCATION_REQUEST_PATTERN` 豁免（"按…估算"）自然放行。
2. **`internal-leak-strip.transform.ts`**：针对 repair 产物整段是工具调用文本的
   形态（`geocode(...)`、`<function=...>`、`[toolName][arguments]` 等），**不做修补、
   直接返回 null**——它的存在是占位说明：内部泄漏不可 transform，必须走 2.3 的
   fail-open 阶梯。（此项可省略实现，仅在 README 说明。）

**接线**（`agent-runner.service.ts` 的 `invokeReviewed`）：

首审 decision 为 revise/replan 时，在进入 LLM repair **之前**插入 transform 尝试：

```
不可发送违规集合 = decision.violations.filter(currentReplySendable === false)
若 每条违规的 ruleId 都有注册 transform：
    text' = 依次 apply（任一返回 null 则整体放弃，走原 repair 路径）
    对 text' 重跑 outputGuard.check（silent: true，避免重复飞书告警）
    若 text' 裁决为 pass/observe：
        采纳 text'，guardrailTrace 增加 step 'transformed'
        persistReviewRecord：revised_reply = text'，reason_code = 'transformed'
        跳过 LLM repair，直接 finalize
    否则：回退原 repair 路径（transform 不叠加重试）
```

catalog 增加可选字段 `repairStrategy?: 'transform' | 'rewrite' | 'replan'`
（缺省按现有 action 派生），`district_level_distance_claim` 标 `transform`。

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
> 改动集中在 `output-rule-catalog.ts` + 个别 rule 文件 + 对应 spec。

### 3.1 档位再分配（附数据依据）

| 规则 | 现状 | 改为 | 依据 |
|------|------|------|------|
| `proactive_insurance_policy_mention` | block P0 | **revise P1**，并收窄触发：只拦"承诺式"（`(?:有\|交\|缴\|买\|包\|含)[^。！？\n]{0,6}(?:五险\|社保\|保险)` 且为肯定声称句），转述岗位要求（含"要求/需要/需/须/第一职业/第二职业"锚点的句子）直接放行 | 2 天 7 命中 7 全拦，抽样全部是如实转述岗位硬性要求（档案 id=97/202） |
| `district_level_distance_claim` | revise | repairStrategy=`transform`（WS2 已做），action 不变 | 68 次命中，6 次 exhausted，修复劣化标本 id=166 |
| `work_content_generalization` | revise | **observe** | 纯词库、无 ground truth（§3②），"餐饮一般要洗碗"是真人招募的诚实模糊表达 |
| `system_status_fabrication` | revise | **保留 revise 但补豁免**：本轮任一副作用工具真实失败（复用 false-promises 的 `isFailedToolCall` 口径）时不触发——工具真失败时"系统提交失败"是诚实解释不是编造 | 规则对工具状态盲（§3② 反例） |
| `geocode_ambiguous_candidates_omitted` | revise | **observe** | 教练规则（教怎么问城市），P5 |
| `farther_job_recommended` | revise | **observe** | 多目标权衡是模型职责，规则只认距离单维度，P5 |
| `wait_notice_time_collection` | revise | **observe** | 有结构化信号但拦的是追问方式，residualRisk 自认候选人主动追问会误拦 |
| `confirmed_booking_onsite_script_missing` | revise | **observe** | 完整性问题，下一轮可补，不值得丢整版 |
| `group_promise_without_invite` | revise | **保留**，但：① 确认 2eddfcf5 完成时态校准已在生产分支；② 把两天档案中 19 条 block 的 first_reply 做成回归 fixture，断言"我先帮你进群""要不我拉你进群？"等承诺/征询式全部不命中；③ 若有漏网，扩 `isConditionalGroupInviteQuestion` 或收紧 keywords，以 fixture 为准 | 19 次 block 抽样全是产品设计内的两轮协议前置轮话术 |

其余规则不动（`internal_output_leak`、`discriminatory_screening_leak`、
`quota_promise`、`tool_failure_success_claim`、值对账三条、`ungrounded_job_recommendation`
等是正确设计，理由见哲学文档 §4 P3）。

### 3.2 catalog 治理注释

在 `output-rule-catalog.ts` 文件头注释追加准入规则（从哲学文档 §3/§4 P8 摘要）：

- 新规则默认 `observe` 入场；
- 升 revise 需要 ≥2 周 observe 判例 + 抽标精确率 ≥90% + 三条件测试
  （风险不对称 / 有 ground truth / 恢复路径可靠）；
- block 仅限"封闭形态 + 不可逆"（JSON 泄漏、封闭词表品牌错名、歧视词组合）；
- veto 档规则精确率 < 70%（按 WS3 报表）自动降 observe。

### 3.3 测试

- `tests/agent/guardrail/output/hard-rules.service.spec.ts` 同步档位断言；
- 保险规则新增豁免/收窄用例（含档案 id=97/202 的原文形态）；
- `catalog.spec` 保持通过（元数据一致性）。

---

## 4. WS3：语义档评估基建

> 对应原则 P8（升档靠数据）、P10（判例落库）。语义档是话术类规则的接盘者，
> 不建评估闭环它永远开不了 enforce，规则档也退不了役。

### 4.1 语义判例落库

**新迁移** `semantic_review_records`：

```sql
CREATE TABLE IF NOT EXISTS semantic_review_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL,              -- shadow | enforce | confidence_downgraded
  decision TEXT NOT NULL,          -- pass | observe | revise | replan | block
  confidence TEXT,                 -- low | medium | high
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_preview TEXT,
  user_message TEXT,
  trace_id TEXT,
  chat_id TEXT,
  user_id TEXT,
  bot_user_name TEXT,
  human_verdict TEXT,              -- true_positive | false_positive | unsure（人工标注）
  labeled_by TEXT,
  labeled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_semantic_review_created ON semantic_review_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_review_trace ON semantic_review_records (trace_id);
```

写入点：`OutputGuardrailService.notifyVerdict()` 路径（或新建
`SemanticReviewArchiveService` 与飞书通知并联，fire-and-forget、失败不影响裁决链路，
参考 `guardrail_review_records` 的 persister 模式）。**飞书通知保留**，落库是补充。

`guardrail_review_records` 同步加标注列（新迁移，`ADD COLUMN IF NOT EXISTS`）：
`human_verdict TEXT`、`labeled_by TEXT`、`labeled_at TIMESTAMPTZ`。

### 4.2 分规则统计 RPC

新迁移创建函数 `guardrail_rule_daily_stats(days INT)`：按天 × rule_id 输出
命中数、终态 block 数、exhausted 数、fail_open 数、已标注数、假阳数
（从 `guardrail_review_records` unnest `first_rule_ids` 聚合）。
供 Dashboard/脚本拉取，本次不做前端页面。

### 4.3 运营动作（文档化即可，不写代码）

在本文档留操作说明：Dashboard 运行时配置页打开
`outputGuardrailSemanticShadowEnabled`（enforce 保持关闭），跑 ≥2 周；
每周抽标 shadow 判例 ≥50 条填 `human_verdict`；shadow 精确率 ≥90% 且
fail-close 告警无异常后，再议 enforce 灰度。

### 4.4 迁移流程注意

按仓库规范：`pnpm run db:new <name>` 生成迁移，SQL 幂等
（`IF NOT EXISTS`/`ON CONFLICT`），先 `db:push:test` 验证；
**生产 push 随发版流程走，不在本 PR 内执行**。

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
  `district_level_distance_claim`**（与 WS2 transform 双保险）；
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

## 6. WS4：记忆层观测流改造（分三个可独立发布的子阶段）

> 对应原则 P7（确认换置信度）、P9（观测流 + 解析器）。
> 工程量最大，4a 可单独发布且零行为变化。

### 6.1 WS4a：观测流双写（零行为变化）

**新迁移** `memory_fact_observations`：

```sql
CREATE TABLE IF NOT EXISTS memory_fact_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  corp_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  field TEXT NOT NULL,             -- name / phone / age / gender / city / brands / ...
  value JSONB NOT NULL,
  method TEXT NOT NULL,            -- rule_regex | llm_extract | system_api | user_form | user_confirm
  confidence TEXT NOT NULL,        -- high | medium | low
  source_excerpt TEXT,             -- 触发提取的原文摘录（≤200字）
  message_id TEXT,
  extractor_version TEXT           -- 提取器标识，便于回放归因
);
CREATE INDEX IF NOT EXISTS idx_fact_obs_identity ON memory_fact_observations (corp_id, user_id, field, created_at DESC);
```

**双写点**：找到 facts 持久化的收口（`src/memory/services/session.service.ts` 的
facts 保存路径），在**每次写入合并结果前**，把本轮新增/变更的字段逐条追加为观测
记录（异步 fire-and-forget，失败只告警不阻塞——参考 memory 层现有的降级风格）。
覆盖三个来源：规则提取（`high-confidence-facts.ts`，method=`rule_regex`）、
LLM 提取（method=`llm_extract`）、系统补全（`memory-enrichment.service.ts` 性别补全，
method=`system_api`）。

现有 evidence/confidence 字段照抄进观测记录。**不改任何读路径，纯增量。**

### 6.2 WS4b：解析器 + 影子对比

**新增** `FactResolverService`（`src/memory/facts/fact-resolver.service.ts`）：

- 输入：某 (corp_id, user_id) 的观测流（近 N 天，N 对齐 `historyWindowSeconds`）；
- 输出：当前事实集 + `needsReconfirm: string[]`（跨级冲突字段清单）；
- 优先级（同级取最新，跨级高者胜，**跨级且值冲突时额外进 needsReconfirm**）：

  ```
  user_confirm > user_form > rule_regex(high) > llm_extract(high)
  > system_api > llm_extract(medium/low)
  ```

- 数组型字段（brands/position/district）：按 union 语义聚合，不做优先级覆盖。

**影子对比**：`recallAll` 读取路径保持现状，同时（fire-and-forget）跑解析器，
把与现存 merged facts 的**分歧**写入轻量表 `memory_fact_resolver_divergences`
（identity + field + merged_value + resolved_value + created_at；同样新迁移）。
跑 ≥1 周，分歧清零或逐条确认解析器更优后，加 flag `factResolverEnabled`
（`agent_reply_config`，默认 false）切换读路径。

`needsReconfirm` 在 flag 开启后经 `src/memory/formatters/fact-lines.formatter.ts`
注入 prompt：`⚠️ 以下信息前后不一致，找机会向候选人自然确认：…`——把静默覆盖
变成显性的对话动作（P9 的核心收益）。

### 6.3 WS4c：报名级字段确认流（先出设计评审，后实现）

范围：仅姓名、电话。

- `precheck-core.ts` 的 `evaluateBookingNameGate` 增加 `needs_confirm` 决策档
  （介于 allow 与 reject_collect 之间）：形态可疑但有正向证据时，不拒收，
  而是在 precheck 返回里提示 Agent 复述确认（"报名用的名字是「X」对吧？
  要和身份证一致哈"）；
- 候选人明确肯定（下一轮消息对确认句的肯定答复，由 LLM 提取层判定并写
  method=`user_confirm` 观测）后，该字段升至最高置信，gate 放行；
- 少数民族/罕见姓名走确认流而不是 `mustHandoff`，减少人工补录。

**注意**：确认判定本身是语义任务，交给 LLM 提取层（P7），不写"对/嗯/是的"词库。
此子阶段实现前先出一页设计给业务确认交互文案。

---

## 7. PR 拆分与执行顺序

| PR | 内容 | 依赖 | 预估规模 |
|----|------|------|---------|
| PR-1 | WS2 全部（transform 层 + repair prompt 加固 + fail-open 阶梯 + 判例回放 fixture） | 无 | 中 |
| PR-2 | WS5 全部（档位再分配 + 保险规则收窄 + system_status 豁免 + group_promise 回归 fixture + catalog 治理注释） | 无（与 PR-1 并行可） | 小 |
| PR-3 | WS3（semantic_review_records 迁移 + 落库服务 + 标注列 + 统计 RPC） | 无 | 小-中 |
| PR-4 | WS1（渲染服务 + prompt section + flag + 测试） | 无 | 中 |
| PR-5 | WS4a（观测表迁移 + 双写） | 无 | 中 |
| PR-6 | WS4b（解析器 + 影子对比 + flag 切换） | PR-5 | 中-大 |
| PR-7 | WS4c（确认流，先设计评审） | PR-6 | 中 |

顺序建议：PR-1 → PR-2 立即做（止血）；PR-3 随后（评估基建）；
PR-4、PR-5 并行；PR-6/7 在影子数据支撑下推进。

---

## 8. 仓库执行须知（给实施者）

1. **分支与 PR**：从 `develop` 切分支，PR 目标 `develop`（本仓库无 main，
   主线是 master，由 release 流程合并）。Conventional Commits。
2. **并发工作区**：仓库常有多会话并发改码，`git commit` 必须用 pathspec
   限定本 PR 文件，勿 `git add -A`。
3. **测试**：`nvm use 22.16.0`，`pnpm run test -- <spec路径> --no-watchman`
   （不加 `--no-watchman` 会静默跑 0 个测试）。测试放 `tests/` 镜像目录。
4. **迁移**：`pnpm run db:new <name>` 生成，SQL 幂等，`pnpm run db:push:test`
   验证；**不要向生产 push**，生产迁移随发版流程执行。
5. **代码规范**：严格 TS（无 any）、构造器注入、Logger（禁 console）、
   服务 <500 行；`infra/` 禁止 import `biz/`、`agent/`。
6. **观测纪律**：所有新的拦截/降级/分歧事件必须落库或发飞书告警，
   不允许只打日志（团队既有裁定）。
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
| transform 误改正常文本 | transform 仅在对应规则命中时应用，产物重过规则档复核，不干净即回退 rewrite |
| 渲染卡片降低回复自然度 | 卡片外的对话文字仍由模型自由发挥；flag 可即时回退 |
| 观测双写增加写放大 | fire-and-forget + 单表 append-only，失败不阻塞；表按月评估分区需求 |
| 解析器切换改变生产事实 | 影子对比 ≥1 周 + 分歧清零后才切 flag，随时可切回 |
| 保险/教练规则降档后漏放真问题 | observe 告警保留全部观测；语义档 shadow 同步在收判例，作为接盘验证 |
