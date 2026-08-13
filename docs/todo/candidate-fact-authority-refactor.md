# 候选人事实裁决权改造：执行清单

> **来源**：2026-08-12 全链路评审——shadow 观测第 4 天（累计抽样 53 单元、解析器口径假阳率 72.3%）
> ＋ 三案考古（马楠七字段重问 / 苏海龙岗位卡回声连坐 / 董泽民确认死锁）＋ 全库裁决点普查。
> **原则宪法**：[rules-vs-semantics-design-philosophy.md](../principles/rules-vs-semantics-design-philosophy.md) **P11**（模型作证、代码公证、本人终审）。
> **范围裁定（用户已定，勿扩大）**：只动 resolution 域及其消费面。岗位侧解析族（job-policy-parser 等）、
> 出站守卫 28 规则、critical-turn-guard **不动**；收资匹配双栈（precheck/booking 私有标签匹配 +
> field-normalize 与 resolution 同名函数双栈）**独立立项**（另见收资字段解析统一方案），本文只留会师点 §6。

## 0. 三条定理（改造从这推导，争议回宪法 P11 打）

1. **病理**：事故 = 开放语言 × 确定性判定 × 终审权落档，三者叠加才发病；全库只有 resolution 候选人字段轨三项全占。
2. **分权**：置信度是证据的属性不是产者的属性。语义作者=模型（必附 quote）；出处公证=代码（纯字符串/标记）；系统内终审=候选人（可归责自陈是聊天系统的天花板）。
3. **代价**：公证器是代价路由器不是真值裁判。判据不是准确率，是每种错法都有便宜出口（误拒→模型本轮重试；误疑→多问一句；误收→报名级确认流兜底）。

## 1. 工序清单

### 工序 A：解析器转岗——能力保留，权力剥离

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| A1 | `AUTHORITATIVE_PRODUCERS` 摘除 `'rule'`（P9 教义现行法条，一行） | `src/resolution/candidate/types.ts` | ☑ |
| A2 | collected-fields 产物标签改真：`producer: 'candidate_quote'` → `'rule'` | `src/resolution/candidate/collected-fields.ts`（`parseCandidateFieldsFromText` 内 `put()`） | ☑ |
| A3 | `CandidatePrefillHint` 从 gender 一个字段推广到全字段（"带值求证"，注释里的三禁令原样继承：不得据此拒绝/提交/升级来源） | `src/resolution/candidate/types.ts` + `tool-context.builder` + precheck | ☑ |
| A4 | 解析结果渲染进模型上下文 hints section（与 job-policy-parser 同构：“解析线索：年龄24（出处‘今年24’），仅供参考”） | `turn-hints.section.ts` + `fact-lines.formatter`（出处截断 24 字） | ☑ |
| A5 | 值形状函数原地保留并转为公证第二问判据（`isPlausibleAgeValue` / `isStorableCandidatePhone` / `isDigitsOnlyName` / 称谓后缀 / 占位号族） | 各解析文件（原地未动）；**收拢点**改在 `evidence/normalize.ts` `isValidCandidateFieldShape` | ☑（解析文件零改动；见下方偏离说明①） |
| A6 | `normalize*ToId` 枚举映射照旧（提交侧值映射，合法） | 各解析文件 | ☑（未动） |

**纪律**：九个解析文件一行正则不删、不加。新口语形态一律不再补正则分支（冻结令），缺口由 B 通道吸收。

### 工序 B：作者通道扶正——candidateClaims 从副通道变唯一通道

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| B1 | 改写 `candidateClaims` describe：从"需要归一化理解时（推荐）用"改为"候选人一切资料必经此提交、必附逐字 quote、指代必须是候选人本人"；工具 description（:134 段）同步 | `src/tools/duliday-interview-precheck.tool.ts` | ☑ |
| B2 | 裸字段（`candidateName` / `candidateAge` 等）降级：描述标注 deprecated，工具侧自动转为无 quote 低置信 claim（过渡期兼容，P2 阶段删） | 同上（九个裸字段全部标 deprecated） | ☑ |
| B3 | schema 零改动确认：zod `CandidateClaimInputSchema`（封闭字段枚举 / quote 1-200 强制 / 元数据工具侧填充）现状即目标形态 | `src/resolution/evidence/claim.types.ts` | ☑（已验收，schema 未改一行） |

### 工序 C：公证器改造——evidence/ 只裁出处

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| C1 | 类型层删三个语义拒因：`no_candidate_evidence` / `value_not_derivable` / `strict_field_free_derivation`（删除即不可表达，P2 用于裁决器自身） | `src/resolution/evidence/claim.types.ts` `CandidateClaimRejectionReason` | ☑ |
| C2 | `conflicting_evidence` 改道：不 reject，路由 `needs_confirmation`（decision 联合类型里席位已就绪）；废除冲突连坐互杀 | `evidence/engine.ts` + `profile.ts`（新增 `needs_confirmation` 状态与 `pickNeedsConfirmationValues`） | ☑ |
| C3 | 裁决链重写为三问：①引文真伪（可作证语料 `extractCandidateTexts` 逐字查找）②值形状（A5 函数）③档案冲突（→转确认）。保留 `quote_not_found` / `invalid_value_shape` / `stale_after_correction` | **新件 `evidence/notary.ts`** + `engine.ts` 换血；`policies.ts` 删 `validateClaimValueAgainstQuote` | ☑（见偏离说明②） |
| C4 | 新增回声检查（唯一新件）：quote 同时存在于 Agent 已发消息全集 → 转确认（两边都是已知字符串，封闭）。苏海龙岗位卡回声在此拦截 | `notary.ts` `detectAgentEcho`（≥4 字才生效，短串同现属巧合） | ☑（shadow 只计数，enforce 才路由） |
| C5 | 短引文门：quote 长度 ≥ 值长度+2（按字段可调），防裸「有」退化 | `policies.ts` `MIN_QUOTE_CONTEXT_CHARS` + `notary.verifyQuoteContext` | ☑（见偏离说明③） |
| C6 | rule-track 降为影子观测员：继续跑、不产 claim，只记 coverage delta（"我能抓到而模型没提交的字段"）落观测事件——迁移期覆盖率仪表 | precheck `computeCoverageDelta` → `fact_adjudication.coverageDelta` | ☑（仪表已上；「不产 claim」属 P2 拆机） |

### 工序 D：确认流——终审机制落地

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| D1 | `needs_confirmation` 消费端：转确认字段自动进收资清单，渲染一句复述（"体重75公斤对吧？"）；肯定→confirmation 级覆盖一切；否定/改值→`operation=correct` | precheck `confirmationSuffixByField` + `prefilledConfirmationFields`（与性别表内确认同一条协议） | ☑（enforce 档，见偏离说明④） |
| D2 | 确认的识别由模型完成（引确认对答原话提交 claim），肯定词表正则不再参与 | 工具描述写明 `operation=confirm` + `agentQuestionQuote` 用法；`就是X` 正则 enforce 下停用 | ◐（作证通道已通；三个确认 producer 与四份肯定词表随 D5 在 P2 删） |
| D3 | 报名级字段（name/phone/age）booking 前强制 confirmation 级（P7 本义；"指代错误"残余风险的兜底网） | `snapshot.confirmedFields` + `BOOKING_CRITICAL_FIELDS` + booking 闸门 | ☑（enforce 档；姓名/电话已有出处闸门，实际新增的是年龄那道） |
| D4 | 身份翻转闸路由保留（改口后显式再确认，与终审原则同构，7-28 裁定勿收紧豁免） | — | ☑（未动） |
| D5 | 【P2 阶段】三个确认 producer（name/gender/city-confirmation）+ 四份分叉肯定词表（含 `gender-confirmation.ts` 的 `INLINE_CONFIRM_AFFIRMATION_RE` 与 `dialogue.ts` 的 `AFFIRMATIVE_ANSWER_RE`）退役删除 | `src/resolution/evidence/producers/` + `src/resolution/signal/dialogue.ts` | ☐ |

### 工序 E：消费面收编——取缔第二法庭

| # | 项 | 锚点 | 状态 |
|---|---|---|---|
| E1 | precheck 判缺改读账本：`missing = 必填 − {accepted, confirmed}`，删自跑解析器路径。I1（门不严于执行者）从测试性质变构造性质 | precheck 裁决段（账本既是过滤器也是**取值来源**，见偏离说明⑤） | ☑（enforce 档） |
| E2 | booking 姓名闸门按已批路线换 quote 作证：负向出处（打招呼语形态）保留、`就是X` 类确认识别正则删除、同题限问熔断保留 | `identity-gates.ts`（`attestedByClaim` / `allowLegacyConfirmRegex`）+ booking 提前载入快照 | ☑（见偏离说明⑥；2026-08-13 二轮评审已将 `attestedByClaim` 收紧为确认级且 enforce-only） |
| E3 | 【P2 阶段】双源对账机器拆除：`mergeRuleAndLlmFacts`、legacy superseded 双读 | `src/memory/services/session.service.ts` | ☐ |

### 落地偏离说明（七条，均为执行中发现、按宪法就地裁定）

① **A5 收拢点换了地方。** 清单原写"值形状函数原地保留、无代码变化"。九个解析文件确实一行没动，但公证第二问需要一个统一入口，因此把 `isPlausibleAgeValue` / `isPlaceholderPhone` / `isDigitsOnlyName` / `hasHonorificSuffix` 接进了 `evidence/normalize.ts` 的 `isValidCandidateFieldShape`（原先它自己内联了一份年龄区间与姓名标点判据，属重复实现）。新增判据全是封闭形态，符合 P11 身份 2；顺带消掉了"占位号形态合规"这个既有缺口。

② **公证器独立成文件。** 清单把三问写在 `adjudicate.ts` 名下，实际拆成 `evidence/notary.ts`（三个 verify 函数 + 回声 + 串行编排），`engine.ts` 只做归并与物化。理由是三问要能被单独测（判据④要求三问分项精确率），塞在裁决主链里测不动。

③ **短引文门按字段查表，不是一刀切 +2。** 「值长度+2」对严格身份字段会直接复活 badcase 6a7446eb（Agent 索名 → 候选人单独回一条"张丽鑫"，3 字 < 3+2），对性别会打死裸答"男"。改为 `MIN_QUOTE_CONTEXT_CHARS` 逐字段表：只有 `healthCertificate` / `isStudent` 这类"裸答可以回答任何问题"的字段设 3 字语境，其余为 0；`context_confirmation` 且带 `agentQuestionQuote` 时整体豁免（语境由问句提供）。

④ **D1 挂在 enforce 档，不在 P0 直上。** 它消费的 `needs_confirmation` 是 C2 的产物，而 C2 在 shadow 期不改行为（旧路径下冲突同样什么都不做）。若 D1 无条件生效，冲突字段会在 shadow 期就多出「（如有误请改）」后缀与借值，P0「零行为变化」不成立。shadow 期仍把 `needsConfirmationFields` 回给模型（与既有 `rejectedClaims` 同待遇）。

⑤ **E1 的账本既是过滤器也是取值来源。** 只做"剔除账本里没有的值"会让带引文的 claim 根本进不了清单——模型得同时提交 claim 和裸字段，与 B1/B2 要退役裸字段直接矛盾。改为：accepted / needs_confirmation 的账本值经 `normalizeClaimValueForChecklist` 写进 `knownFieldMap`，其余删除。

⑥ **`就是X` 正则按开关停用，不是直接删。** 清单写"删除"。但 shadow 期模型尚未稳定提交 confirm claim，此刻删掉，"就是陈佩珊"这类明确确认将无人接管，直接复活 badcase g4ytra23（booking 连拒 5 次、重复索名 4 遍）。做法：`evaluateBookingNameGate` 新增 `attestedByClaim` 与 `allowLegacyConfirmRegex`（enforce 下传 false）。2026-08-13 二轮评审进一步收紧：`attestedByClaim` 只认 `operation=confirm` / `context_confirmation` 的确认级 accepted claim，且调用方仅在 enforce 传入；statement claim、session 基线与 shadow 均不借此短路负向证据。物理删除随 D5 在 P2 与三个确认 producer、四份分叉肯定词表一起做——它们本就是同一批要退役的东西。

⑦ **shadow 下 accepted claim 补位回灌。** B1/B2 已把裸字段降级为 deprecated，模型可只提交 claim；若 shadow 不认公证结果，claims-only 输入仍会被判缺并重复追问。现将带 `acceptedClaimId` 的 accepted claim 值补入 `knownFieldMap` 空位，且只补不覆盖、不删除；无 claimId 的 session 基线不走此路。enforce 下随后的 E1 账本重写仍是唯一权威取值源。这是 P0「零行为变化」的已声明例外，接住已发布的工具契约而不扩张 statement claim 的权限。

### 已落地代码清单（PR #1000）

| 文件 | 改动 |
|---|---|
| `resolution/evidence/notary.ts` | **新增**——公证三问 + 回声 + 短引文门 |
| `resolution/evidence/engine.ts` | 裁决链换血：删产者信任表，冲突改道转确认，裸值同值判 superseded |
| `resolution/evidence/claim.types.ts` | 删三语义拒因，加 `quote_too_short` / `quote_echoes_agent_message` |
| `resolution/evidence/policies.ts` | 删 `validateClaimValueAgainstQuote`，加 `MIN_QUOTE_CONTEXT_CHARS` |
| `resolution/evidence/profile.ts` | `conflicted` → `needs_confirmation` 状态 + `pickNeedsConfirmationValues` |
| `resolution/evidence/normalize.ts` | 形状门接入 A5 函数族（占位号 / 纯数字姓名 / 称谓后缀） |
| `resolution/evidence/snapshot.ts` | `confirmedFields` + `BOOKING_CRITICAL_FIELDS` |
| `resolution/evidence/identity-gates.ts` | 姓名闸门 `attestedByClaim` / `allowLegacyConfirmRegex` |
| `resolution/evidence/producers/name-confirmation.ts` | `就是X` 识别改可关 |
| `resolution/candidate/types.ts` | A1 摘 `rule`；`CandidatePrefillHints` 推广全字段 |
| `resolution/candidate/collected-fields.ts` | A2 产物改标 `rule` |
| `agent/generator/preparation-utils/tool-context.builder.ts` | 弱来源 hint 从性别推广到九字段 |
| `agent/generator/context/sections/turn-hints.section.ts` | A4 提示便签口径 + 出处 |
| `memory/formatters/fact-lines.formatter.ts` | 出处渲染 + 截断参数 |
| `tools/duliday-interview-precheck.tool.ts` | B1/B2 描述、C6 delta、D1、E1、A3 消费 |
| `tools/duliday-interview-booking.tool.ts` | D3 报名级终审、E2 作证放行、快照提前载入 |
| `observability/observer.interface.ts` | `coverageDelta` / `echoDetections` |
| 测试 | 新增 `*.authority.spec.ts` ×2；改写 `policies.spec` 为三问矩阵；`engine`/`profile`/`collected-fields`/`turn-hints` 等按新教义更新 |

全量 `pnpm run ci:check` 通过（6990 passed / 6 skipped）。

## 2. 迁移三阶段（全程 shadow 保护）

| 阶段 | 内容 | 切换判据 | 状态 |
|---|---|---|---|
| **P0 影子双跑**（零行为变化，声明例外） | 三问裁决全量计算、判例落 `fact_adjudication`；C4 回声只计数（`echoDetections`）；C6 coverage delta 开始记。声明例外：A3/A4 hints 直上、偏离④ `needsConfirmationFields` 回传、P0-8 手机号门收紧、偏离⑦ claim 回灌补位 | 新旧 diff 可解释、无未知形态 | ☑ 代码就绪（开关默认 shadow） |
| **P1 权力切换**（开关分级放量） | C1/C2/C3/C5 + B1/B2 + D1/D3 + E1/E2，全部挂在既有 `CANDIDATE_FACT_ADJUDICATION_MODE=enforce` 上 | §3 四个结构量达标 + 下方「切换前必验」两条 | ☐ 待判据 |
| **P2 拆机** | D5 + E3 + rule-track 影子退休 | coverage delta ≤ 噪音水平持续两周 | ☐ 待数据 |

**切换前必验（P1 的额外闸口，均属死锁风险，勿跳）**：

1. **模型能不能稳定产 `operation=confirm` claim**。D3 让年龄在 enforce 下只认候选人明确表态，E2 让姓名解锁只认公证过的引文——两条都以"模型照工具描述提交确认 claim"为前提。shadow 期先从判例库统计 confirm claim 的出现率；出现率为 0 就直接切，会把年龄字段变成新的确认死锁（身份确认死锁家族的第 4 变体）。
2. **enforce 下 E1 的取值来源已经通了**。判缺读账本意味着裸字段不再回灌，账本里没有的值一律算缺。切换前确认 `model_` 通道 accepted 量已成主导（判据②），否则一切换全员卡 collect_fields。

## 3. enforce 判据（换血后）与观测口径

| # | 结构量 | 目标 |
|---|---|---|
| ① | 确定性开放语言裁决量/天（宪法 §7 第 5 指标） | → 0 |
| ② | 作证通道占比（带 quote 的 accepted / 全部 accepted） | 68:633 倒转为主导 |
| ③ | needs_confirmation 发问量与一次解决率 | 单会话单字段 ≤1 次复述（打扰上限） |
| ④ | 公证器三问分项精确率（回声误报、短引文误收单独盯） | 抽样达标，超阈调参 |

**配套（观测侧）**：
- ☑ 定时任务 `fact-adjudication-shadow-daily/SKILL.md` 判读口径重写：`no_candidate_evidence`＝"体系战果"的分类**废除**（已被 72.3% 假阳实测证伪，它是最大缺陷池）；判据表换为上四条；附带修正任务文件里已失效的文档路径（`candidate-fact-evidence-adjudication-plan.md` → `candidate-profile-domain.md`）。
- ◐ 中继会话（一会话多人，NEW-7）：观测侧已就位（SKILL.md 的 SQL-E 打标、冲突统计先剔中继）；「distinct 手机号≥3 → 转人工」是产品裁定项，按原议独立处置、不阻断主链，本次未做。

## 4. 风险对账（每个旧防线都有接盘者）

| 威胁 | 接盘者 | 强弱 |
|---|---|---|
| 模型编造值 | 公证第一问（编不出真实存在的引文） | **更强**（shadow 实证：真编造全被引文检查抓获） |
| 昵称当真名 | 打招呼语负向出处（保留）＋ D3 报名级确认 | 等强，死锁灭绝 |
| 截图第三方信息 | 传输来源标记剔除（PR #944/#1000 已有） | 不变 |
| 指代错误（"我姐今年24"） | D3 确认流终审 | 旧系统同输入照样中招（`parseAge` 的 `今年(\d{2})` 分支同样命中）且无兜底——新错误集是旧错误集的子集 |
| 覆盖率下降（模型漏报） | C6 delta 仪表 + A4 hints 提示 | 可测、可回退 |
| 快环裁定（不加实时 LLM） | 全程零新增 LLM 调用（模型本来就在回合里） | 守恒 |

## 5. 明确不动清单

岗位侧解析族（job-policy-parser / supplement-label-classifier / schedule-semantic / hard-requirements）、出站守卫 28 规则、critical-turn-guard、37 个工具闸门、红线词表、`normalize*ToId`、身份翻转闸、同题限问熔断、图片描述不作证、`invalid_value_shape` / `quote_not_found` / `stale_after_correction` 三拒因。

## 6. 与收资统一立项（领土 2）的会师点

- 收资共享域的"判缺"消费形态直接对接 E1 读账本——两项目在 I1 上合流；
- labelId 二期（海绵结构化标签契约）落地后，字段身份由构造消灭，公证第三问的归一化比对面随之收窄；
- field-normalize 与 resolution 同名函数双栈（`normalizeGenderValue` ×2、`inferIdentityFromAge` 藏于 precheck）在该立项内收敛，本改造不并行动它。

## 7. 工作约定

- 仓库多会话并发：commit 一律 pathspec 限定本改造文件；`src/resolution/brand/*` 等他人在途改动勿碰。
- 跑测试：`nvm use 22.16.0`，`pnpm run test -- <spec> --watchman=false`；收尾 `pnpm run ci:check`。
- 生产形态 fixture 纪律（PR #1000 遗产）：一切新 spec 必须喂带时间后缀 / debounce 拼接 / `[图片消息]` 占位 / 引用块的生产形态文本，不许只喂干净文本。
- 新增对开放语言的正则分支＝违宪（P11 冻结令），review 直接打回。
