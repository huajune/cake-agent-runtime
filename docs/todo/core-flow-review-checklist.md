# 核心链路 Code Review 修改清单

> 用途：人工 code review 过程中累积的待改项，review 结束后交给 GPT 统一执行。
> 约定：每条给出「位置 / 现象 / 建议改法 / 验收」，`P0` 有行为风险、`P1` 一致性与可测性、`P2` 可读性。
> 状态：`[ ]` 待执行 / `[x]` 已执行。

## 执行结案（2026-08-17）

26 条全部执行完毕。`pnpm run typecheck` / `lint:check` 通过；全量 `pnpm run test` 435 套件
7111 用例全绿。

**执行期新增的用户裁定（与清单原文不一致处以此为准）**：

| 条目 | 清单原文 | 实际裁定 | 出处 |
|---|---|---|---|
| 6-1 | 标注「执行前需用户确认」 | **做**，combined 窗口改读 normalizedMessages | 用户 8-17 确认 |
| 8-2 | 先向海绵确认约束，再决定删/降级 | **直接删保守分支**，查不到工单手机号一律放行交海绵仲裁 | 用户 8-17 裁定 |
| 7-1 | 新 reasonCode `promise_reconciliation` 便于分开统计 | **不新开底账分桶**，复用 `other`——运营侧就是一次普通「需人工跟进」，该做的动作与模型自发 handoff 完全一样；排障区分由 guardrail_review_records 的 ruleId 承担 | 用户 8-17 裁定 |

**执行中的两处偏离（已在代码注释写明理由）**：

- **5-1 第 4 条**：`GeneratorRunResult.runTurnEnd` 的**契约注释**已按要求写死，但类型**保留 optional**——
  runner/turn-outcome 在把闭包交给 TurnFinalizer 后会显式置 `runTurnEnd: undefined`，用"字段为空"
  表示"已被接管，渠道层不要再碰"。去 optional 需要把 `buildRunResult` 拆成两段构造，属纯类型改造
  且与该语义冲突，收益不抵改动面。
- **9-1 第 2 条**：checklist 判定名与 templateText 渲染行名本就同源（都来自 `displayOrder`，
  `FIELD_LABELS` 只是展示装饰）。实际错位在两个反方向：① 模型按**展示名**回填时判定端不认
  → 已加 `FIELD_BY_DISPLAY_LABEL` 由 `FIELD_LABELS` 派生反查；② 后台 labelName 自带括号注记
  （`身高(cm)`）时与标准字段互不相认 → `normalizeChecklistField` 增加 NFKC + 剥注记。
  副作用：`期望薪资（元/月）` 这类注记里的单位提示不再出现在 templateText——判定与展示改为
  同一个归一后的名字，是消除本类死循环的必要代价。

---

## 议题 1 — `PromptContext.sessionFacts` 的 `EntityExtractionResult | SessionFacts` 联合类型

审查对象：[hard-constraints.section.ts:80](src/agent/generator/context/sections/hard-constraints.section.ts:80)
（同源声明还有 [section.interface.ts:27](src/agent/generator/context/sections/section.interface.ts:27)、
[context.service.ts:53](src/agent/generator/context/context.service.ts:53)、
[turn-hints.section.ts:71](src/agent/generator/context/sections/turn-hints.section.ts:71)）

### 背景（不是断言，是联合类型的两条分支）

同一批候选人事实在系统里有两种形态：

| 形态 | 字段样子 | 谁产出 |
|---|---|---|
| `SessionFacts`（存储态） | `city: { value:'南京', confidence:'high', source:'rule', evidence:'…' }` | Redis 落盘 / `toSessionFacts()` |
| `EntityExtractionResult`（解包态） | `city: { value:'南京', confidence, evidence }`、其余字段是裸值 | `unwrapSessionFacts()` 的输出、LLM 抽取原始结果 |

`unwrapSessionFacts(facts, {minConfidence})` 两种都吃，所以类型上写成联合。历史上是先有裸态、后加信封
（置信度/来源元数据），联合类型是当时留下的兼容口。

### 现状核查结论

生产链路 **只会走 `SessionFacts` 一条分支**：`preparation.service.ts:266` 传的是
`memory.sessionMemory?.facts`，其类型链是 `TurnStartMemory.sessionMemory: WeworkSessionState | null`
→ `facts: SessionFacts | null`。裸态分支在生产不可达，只有测试在走
（`hard-constraints.section.spec.ts` 全部用 `cloneFallback()` 造 `EntityExtractionResult`）。

---

### [x] 1-1 `P0` 两条分支的 `minConfidence` 语义不等价，导致置信度门在测试里是空操作

**位置**：[session-facts.types.ts:723](src/memory/types/session-facts.types.ts:723)（`unwrapSessionFactValue`）、
[session-facts.types.ts:773](src/memory/types/session-facts.types.ts:773)（`unwrapSessionFacts` 的 city 分支）

**现象**：
- `unwrapSessionFactValue` 里 `if (!isSessionFactValue(value)) return value;` —— 裸值**在置信度比较之前**原样返回，
  `{minConfidence:'high'}` 对它完全不生效。
- city 同理：裸 `CityFact` 不满足 `isSessionFactValue`（缺 `source` 键），走 `: city` 原样透传分支，
  连 `confidence:'low'` 的城市也能穿过 `high` 门。

后果不是生产 bug（生产没有裸态输入），而是**测试覆盖的是一套语义、生产跑的是另一套**：
`hard-constraints.section.spec.ts` 的 20+ 用例全部走裸值分支，`minConfidence:'high'` 这道门
从未被任何测试执行过。将来若把门收紧/放松（比如改成 `medium`），测试不会有任何反应。

**建议改法**（推荐第一种）：
1. 把 `PromptContext.sessionFacts` / `ComposeParams.sessionFacts` / `mergeFacts` / `partition` 四处的类型
   收敛为 `SessionFacts | null`，删掉 `EntityExtractionResult` 分支（生产唯一形态）；
2. 新建 `tests/helpers/session-facts.fixture.ts`，导出 `sessionFactsOf(partial, meta?)`，
   内部走 `toSessionFacts(...)` 构造带信封的 fixture，默认 `confidence:'high'`；
3. 把 `hard-constraints.section.spec.ts` / `turn-hints.section.spec.ts` / `context.service.spec.ts`
   里的 `cloneFallback()` 与内联字面量替换成该 helper；
4. **补一条负向用例**：`confidence:'medium'` 的 city 不应出现在硬约束段（证明门真的在工作）。

`unwrapSessionFacts` 本身保留双形态入参（`settlement.service.ts:228` 等处仍在用，
且它是 Redis 旧档兼容的落点），只是 prompt 侧不再依赖裸态分支。

**验收**：`pnpm run typecheck` 通过；上述三个 spec 全绿；新增的 medium-city 负向用例在
去掉 `minConfidence:'high'` 时会失败。

---

### [x] 1-2 `P1` `renderGroupInventoryBlock` 绕过置信度门直读 city，与硬约束段口径不一致

**位置**：[context.service.ts:210](src/agent/generator/context/context.service.ts:210)

**现象**：`const city = sessionFacts?.preferences?.city?.value?.trim();` —— 直接摸 `.value`，
没有经过 `unwrapSessionFacts`。这行之所以能同时编译两条分支，是因为 `SessionFactValue<string>` 和
`CityFact` 恰好都有 `value: string`，属于结构上的巧合，不是设计。

结果是同一份 prompt 里城市口径分裂：

| 城市置信度 | 兼职群资源块（无门） | 硬约束段（`high` 门） | 记忆块（`high` 门） |
|---|---|---|---|
| `high` | 渲染 | 渲染 | 渲染 |
| `medium` / `low` / `unknown` | **仍渲染** | 不渲染 | 不渲染 |

可达路径：Redis 旧档里的裸字符串 city 会被 `NullableSessionCityFactSchema` 归一化成
`confidence:'unknown'`（[session-facts.types.ts:553](src/memory/types/session-facts.types.ts:553)），
该形态按代码注释「拆除判据」尚未确认归零。此时 prompt 会出现
「## 兼职群资源（南京）… 该城市暂无可用兼职群 → 禁止承诺拉群」，而硬约束段里根本没有"城市: 南京"——
**用一个系统自己都不敢当硬约束用的城市，去下达禁止拉群的指令**。

**建议改法**：改为与硬约束同门取值：

```ts
const city = unwrapSessionFacts(sessionFacts, { minConfidence: 'high' })
  ?.preferences.city?.value?.trim();
```

取 `high` 而非更松的门，理由：这个块不只是"参考信息"，它会输出「本城市群库为空 → 禁止承诺拉群」
这类有行为后果的指令；城市取错时两个方向都会错（该拉的不拉 / 不该拉的拉）。
放宽的风险由 `invite_to_group` 自己的 [invite-city-gate.ts](src/tools/shared/invite-city-gate.ts) 兜底。

**验收**：补一条 spec —— city 置信度为 `medium` 时 `compose()` 产物**不含**「兼职群资源」块；
`high` 时仍含（现有 `context.service.spec.ts:268` 用例改为构造 high 信封后应继续通过）。

---

### [x] 1-3 `P2` `mergeFacts` 的注释未说明"为什么入参是联合类型"

**位置**：[hard-constraints.section.ts:71-84](src/agent/generator/context/sections/hard-constraints.section.ts:71)

**现象**：注释详细写了"本轮高置信覆盖旧值"的口径统一理由（很好），但没有一句解释
入参为何要同时接受两种形态。下一个读代码的人会像本次 review 一样先卡在这里。

**建议改法**：若 1-1 采纳（收敛为 `SessionFacts`），本条自动消解，只需把 `EntityExtractionResult`
的 import 收窄为返回值类型使用。若 1-1 不采纳，则在 `section.interface.ts:27` 的字段注释上补一句：
「两种形态：SessionFacts=带信封的存储态（生产路径），EntityExtractionResult=已解包的裸态（测试/旧调用方）；
注意 minConfidence 只对前者生效。」

---

## 议题 2 — `TurnHintsSection` 的提示词文案与实际渲染物不符

审查对象：[turn-hints.section.ts](src/agent/generator/context/sections/turn-hints.section.ts)

### 背景（section 的实际产物）

`build()` 把本轮规则 claim 按"是否与会话记忆冲突"分成两块渲染：`[本轮解析线索]`（不冲突）
与 `[本轮待确认线索]`（与记忆已有值不等）。分流逻辑在 `partition()` L86-103：记忆无值 / 值相等 → 普通；
值不等 → 待确认；`preferences.labor_form` 无条件走普通（最新表达覆盖语义）；
`gender_source` 跟随 `gender` 入桶。

`[本轮解析线索]` 的六行说明各答一个不同问题（出身与可靠性 / 冲突优先级 / 用途闸门 / 保密 /
地点线索特例 / 城市证据码词典），但排成一段无分层标记——这是"读起来绕"的直接原因。
下列各条是核查后发现的**实质问题**，不只是排版。

---

### [x] 2-1 `P1` 「每条附原文出处」与实际渲染物不符，且恰好废掉它自己声明的防线

**位置**：[turn-hints.section.ts:40](src/agent/generator/context/sections/turn-hints.section.ts:40)（文案）、
[fact-lines.formatter.ts:257](src/memory/formatters/fact-lines.formatter.ts:257)（渲染）

**现象**：文案说「每条附原文出处……用前对照出处原文核验」，但渲染出的 `证据:` 取的是
`fact.evidence.code ?? fact.evidence.label`——即 `explicit_city` / `年龄识别：25`，
**是解析结论的复述，不是候选人原话**。claim 结构里确实带着原话逐字片段
（`evidence.quote`，[rule-track.ts:213](src/resolution/evidence/producers/rule-track.ts:213)），
formatter 从未渲染它。

后果是自反的：这段文案点名要防的两类误判之一是"候选人复述岗位要求"，
但候选人说「这岗位要求18-45岁」时模型看到的是
`- 年龄: 18-45（置信度: high，来源: rule，证据: 年龄识别：18-45）`——
证据行只把结论重说一遍，没有任何信号提示这句原本在讲岗位要求。
单条消息轮里模型尚可自行比对当轮消息；debounce 合并多条消息时 claim→来源句 的映射彻底断裂。

**建议改法**（二选一，倾向前者）：
1. **渲染 quote**：`formatRuleFactClaimLines` 的 `includeEvidence` 分支改为输出
   `原话: ${fact.evidence.quote}`。注意 `quote` 默认取整条消息且上限 1000 字
   （[direct-field.ts:27](src/resolution/evidence/producers/direct-field.ts:27)），逐字段渲染会把
   同一条消息重复 N 遍——需要同时加约束：截断到 ~40 字，且当 `quote` 等于整条当轮消息时省略
   （单消息轮无信息量，合并轮才需要指明来自哪条）。
2. 若判定 quote 渲染代价过大，则把文案改准：「每条附解析依据（非候选人原话）；原话见本轮消息，
   采用前自行回看当轮消息核验」。

**验收**：补 spec —— 合并多条消息的轮次里，两条消息各产出一个 claim 时，渲染行能区分各自来源；
且单消息轮不出现整条消息的重复注入。

---

### [x] 2-2 `P2` 城市 confidence 说明写成了"分档教学"，但规则轨 city 恒为 high

**位置**：[turn-hints.section.ts:49](src/agent/generator/context/sections/turn-hints.section.ts:49)

**现象**：文案「城市字段带有 confidence 与 evidence：confidence=high 的结果来自明确规则匹配……
查岗可直接采用」，暗示存在非 high 的城市结果需要模型区别对待。实际
[rule-track-preferences.ts:296](src/resolution/evidence/producers/rule-track-preferences.ts:296)
把规则轨 city 的 confidence **硬编码为 'high'**，四个 evidence 码
（`municipality_compact` / `explicit_city` / `unique_district_alias` / `hotspot_alias`）没有档位差别。
另外「城市字段带有 confidence 与 evidence」的措辞暗示只有城市带，实际 formatter 给
**每个**已登记字段都追加了 `（置信度，来源，证据）`。

这行的真实作用其实是**给英文 evidence 码做词典**——city 是唯一渲染机器码而非中文标签的字段
（`code ?? label`，其余字段无 code 故落到中文 label）。

**建议改法**：改写为词典口吻，去掉不存在的分档语义。参考：
「城市行的『证据』是机器码，含义：municipality_compact=直辖市紧凑写法、explicit_city=显式城市名、
unique_district_alias=全国唯一区名映射、hotspot_alias=热门地标映射；四者均为确定性白名单命中，
查岗可直接采用。与候选人本轮新表述冲突时，仍以候选人当前明示为准。」

---

### [x] 2-3 `P2` 地点线索指令与 hard-constraints 段重复且口径不完全一致

**位置**：[turn-hints.section.ts:48](src/agent/generator/context/sections/turn-hints.section.ts:48)
vs [hard-constraints.section.ts:191](src/agent/generator/context/sections/hard-constraints.section.ts:191)

**现象**：turn-hints 说「行政区域可直接查岗；商圈/地标/街道/详细地址……应优先先 geocode」；
hard-constraints 在**无已确认城市**时说「优先把区/县名作为 address 传给 geocode……不要先反问候选人城市」。
两段都在教 geocode，且对"行政区能不能直接查"给出表面相反的指引，模型需自行合成
「有城市时区可直查、无城市时区要先 geocode」。

**建议改法**：geocode 口径收敛到 hard-constraints 单一段落，turn-hints 这行删除或降为指针
（「地点线索的处理口径见 [本轮查询硬约束]」）。若保留，必须补上"有无已确认城市"的前提条件，
与 hard-constraints 措辞对齐。

---

### [x] 2-4 `P2` `includeEvidence: true` 与 formatter 文档契约直接矛盾

**位置**：[turn-hints.section.ts:35](src/agent/generator/context/sections/turn-hints.section.ts:35)、
[turn-hints.section.ts:57](src/agent/generator/context/sections/turn-hints.section.ts:57)
vs [fact-lines.formatter.ts:14-20](src/memory/formatters/fact-lines.formatter.ts:14)

**现象**：formatter 的 `includeEvidence` 注释写明「默认 false：Agent prompt 注入只带（置信度/来源），
evidence 是排障字段……**仅事实提取 prompt** 的 [规则模式匹配线索] 注入需要置 true」。
但 turn-hints 是主 Agent system prompt 的 section，两处调用都传了 true。

实际风险不大——规则轨 evidence 是 `年龄识别：25` 这类短标签，不是张漪 case 里被灌进上下文的
LLM reasoning 全文。但**文档契约与调用点直接矛盾**，按注释行事的人会改错。

**建议改法**：改注释，承认主 Agent prompt 的规则线索段也用 true，并写清为什么安全
（规则轨 evidence 是短标签，长文 evidence 只出现在 LLM 轨/sessionFacts 侧）。
若 2-1 采纳方案 1（改渲染 quote），此处注释需一并说明 quote 的截断约束。

---

### [x] 2-5 `P2` 六行说明缺分层，建议加小标题

**位置**：[turn-hints.section.ts:37-53](src/agent/generator/context/sections/turn-hints.section.ts:37)

**现象**：六行分属六个维度（出身可靠性 / 冲突优先级 / 用途闸门 / 保密 / 地点特例 / 证据码词典），
无分层标记，且第 1 行末「以你的理解为准」与第 2 行「一律以候选人当前明示信息为准」在讲同一件事的两个侧面。

**建议改法**：低风险排版整理，**不改语义**——按「可靠性 / 冲突时听谁的 / 能拿它干什么 / 别说漏嘴 /
地点与城市」分组，合并第 1、2 行的重复部分。改动需逐条比对改前改后语义集合一致，
并跑一轮 test-suite 回归确认无行为漂移（提示词改动一律不做"顺手优化"）。

---

## 议题 3 — 候选人↔工单关系（`active_booking` / `loadBookingContext`）

审查对象：[preparation.service.ts:554](src/agent/generator/preparation.service.ts:554)、
[long-term.types.ts:267-293](src/memory/types/long-term.types.ts:267) 及全部读写方

### 设计裁定（2026-08-14 深度讨论收敛，⚠️ 勿重开）

**行为现状全部冻结，不做任何行为变更**。经完整盘点（存储/8 读者/2 写入者/20 场景矩阵）与
逐场景讨论后用户裁定：现状是一批批 badcase 堆出来的，每处"不规整"都对应真实生产事故的修复
（cancel 归属核验=臆造取消 6e9ar9gd；状态核验=面完还取消 j8ed80tk；软查重手机号反查=
罗欣宇/许颖误拦 448367→448402；零工单断言=空头宣称簇 zvey1mg8 等；复聊 oob 核验=
带外操作骚扰簇 recvqgvKqRAcKg 等），为架构对称性重构等于重新打开已闭合的补丁。

**讨论中被否决的方案（勿再提）**：
- 手机号直查替代指针（身份非一一映射：代报多人/共享测试号/带外越界；且手机号与指针存同一行，
  身份裂开时一起丢，不构成容灾）；
- `biz/booking` 域 + `resolveCandidateWorkOrders` 统一 resolver（前提"Agent 需全知带外单"
  不成立——带外单操作已裁定一律转人工，Agent 无需主动发现）；
- 主聊零工单分支加手机号探针、渲染终态过滤+懒清、话术改口、setActiveBooking 写失败告警
  （均属行为/观测变更，随本裁定一并撤销）。

**保留的讨论结论**（背景知识，供后续排障）：指针语义 = "Agent 自建单的账本"，同时承担
cancel/modify 的**授权边界**角色（手机号永远不能授权）；带外单发现维持 precheck 查重与
复聊 oob 两个既有点位；带外单/丢指针单的操作请求出口都是转人工。

在"行为冻结"前提下，用户要求**实现侧整洁化**——以下三条均为零行为变更的代码卫生项：

---

### [x] 3-1 `P1` 工单状态词表 5 处副本收拢单点（零行为变更）

**位置**：[duliday-interview-precheck.tool.ts:1735](src/tools/duliday-interview-precheck.tool.ts:1735)、
[oob-work-order.ts:34](src/agent/reengagement/oob-work-order.ts:34)、
[follow-up.processor.ts:117](src/agent/reengagement/follow-up.processor.ts:117)（三份相同的
活跃集）、[duliday-cancel-work-order.tool.ts](src/tools/duliday-cancel-work-order.tool.ts) B5-2
的不可取消集、状态全集仅存在于 [sponge.types.ts:530](src/sponge/sponge.types.ts:530) 注释。

**改法**：状态词是海绵的领域语言，在 `sponge/` 导出单点常量（状态全集 +
`ACTIVE_INTERVIEW_WORK_ORDER_STATUSES` + cancel 的 `SELF_CANCEL_BLOCKED_STATUSES`），
五处消费点改 import。**严格约束**：只做常量搬迁，集合成员逐字节不变；各消费点现有的
比较预处理（precheck 的 `normalizePolicyText` / oob 的 `trim`）**各自保留原样**，不做"顺手统一"
——统一比较函数属于行为变更（可能改变边界输入的判定），明确排除。

**验收**：五处现有 spec 全绿；diff 里不出现任何比较逻辑变化，仅 import 与常量声明。

---

### [x] 3-2 `P2` `ActiveBooking` 递归自嵌类型拆分（纯类型，存储形态不动）

**位置**：[long-term.types.ts:289-293](src/memory/types/long-term.types.ts:289)

**现象**：`ActiveBooking` 含 `bookings?: ActiveBooking[]`——列表项类型里嵌着"整个状态"的字段，
类型上允许无限递归；实际语义是"顶层 = 最近一笔镜像（老形态兼容）+ bookings = 全量列表"，
两种角色共用一个 interface，读代码时无法从类型分辨拿到的是条目还是状态根。

**改法**：拆成 `ActiveBookingEntry`（work_order_id / linked_at / job_id）与
`ActiveBookingState`（entry 字段 + `bookings?: ActiveBookingEntry[]`），
`AgentLongTermMemoryRow.active_booking` 指向后者，读写方法签名按角色收窄。
**JSONB 存储形态与运行时读写逻辑逐字节不变**——这是编译期标注，不是数据迁移。

**验收**：`pnpm run typecheck` 通过；supabase.store / long-term.service 现有 spec 全绿；
无任何运行时 diff（仅类型与签名）。

---

### [x] 3-3 `P2` 单数 `getActiveBooking` 收敛为复数派生（行为等价验证后执行）

**位置**：[long-term.service.ts:267](src/memory/services/long-term.service.ts:267)（单数 API，
唯一生产调用方 [request-handoff.tool.ts:153](src/tools/request-handoff.tool.ts:153)）

**现象**：单数/复数两个读 API 并存，语义关系（单数 = 列表最近一笔）只存在于存储实现的约定里。

**改法**：先在 store 层验证"单数返回 ≡ 复数返回的 [0]"在所有存量数据形态（老单笔形态/新列表
形态/null）下成立；成立则单数 API 改为复数派生（或内联到唯一调用方），失配则本条**放弃并在此
记录失配形态**。不改 request-handoff 的任何判定逻辑。

**验收**：request-handoff 现有 spec 全绿；等价性由新增的 store 层单测锁定。

---
## 议题 4 — 回合账本 geo 双记录（anchor / cityAttestation）

审查对象：[turn.types.ts:9-23](src/types/turn.types.ts:9)、
[geocode.tool.ts:287](src/tools/geocode.tool.ts:287)、[preparation.service.ts:137](src/agent/generator/preparation.service.ts:137)

### 设计裁定（review 结论，非改动项）

anchor 与 cityAttestation **不是同一信息存两遍**，是一次地理解析事件对两个消费域的不同投影：
anchors[]（坐标+精度，轮内工作集）供 job-list 距离精度确定性判定与坐标出处核查、invite 城市门、
geocode 锚点复用，随轮丢弃；cityAttestation（城市+证据+来源，单值）供轮末
`saveToolAttestedCity` 经裁决写 pref.city（排 extract_facts 前，候选人亲证 T1 可覆盖工具确权 T2）。
字段集几乎不重叠、生命周期相反，分开是对的。维持现设计。

---

### [x] 4-1 `P2` 双记录成对调用靠调用方自觉，收敛为单方法双投影

**位置**：[geocode.tool.ts:287-305](src/tools/geocode.tool.ts:287)、
[preparation.service.ts:137-149](src/agent/generator/preparation.service.ts:137)

**现象**：两个调用点都需记得"先 recordGeocodeAnchor 后 recordCityAttestation"，
且"坐标有效但 city 为空 → 只记 anchor 不记 attestation"这条不变式由调用方各自维护。
新增第三个解析入口（如未来图片地图直通轨想 seed 锚点）时容易漏记一半。

**建议改法**：TurnLedger 增加组合方法
`recordGeoResolution(input: { longitude; latitude; areaLevelQuery; areaName; city; district?; evidence; source })`，
内部完成 anchor 追加 + city 非空时的 attestation 写入；现有两个调用点改调组合方法；
原两个细粒度方法保留但收窄为组合方法的内部实现（或标注仅供测试）。零行为变更。

**验收**：两个调用点各自现有 spec 全绿；grep 确认生产代码不再直接成对调用两个细粒度方法。

---

### [x] 4-2 `P2` cityAttestation 同轮覆盖无证据强度语义，需文档化或按 source 定优先级

**位置**：[turn-ledger.ts:80-82](src/agent/generator/preparation-utils/turn-ledger.ts:80)（last-write-wins）、
[session.service.ts:338-358](src/memory/services/session.service.ts:338)（裁决只挡既有 high 冲突）

**现象**：attestation 是单值后写覆盖。prep 的定位分享 seed 恒在最前、工具轮 geocode 在后——
同轮候选人先发定位（真实位置）、模型又对另一城市地址 geocode unique 成功时，
attestation 被时序覆盖为后者；若会话此前无城市档，轮末直接以 confidence=high 入档。
`location_share`（人在哪）与 `geocode_unique`（查了哪）证据强度不同，现在纯时序定胜负，
且该选择未文档化。发生频率低（同轮双源+异城+无旧档三条件叠加），定 P2。

**建议改法**（按序优先）：
1. `recordCityAttestation` 内加规则：已有 attestation 且 source='location_share'、新记录
   source='geocode_unique' 且城市不同时，保留 location_share（真实位置强于文本查询解析），
   并 logger.warn 记录被抑制的候选城市；
2. 同轮同源异城覆盖维持 last-write-wins（模型连续 geocode 多地属正常探索，最后一次最接近意图）；
3. 在 CityAttestation 类型注释写明单值覆盖语义与上述优先级。

**验收**：单测——定位分享 seed 后再 geocode 异城，attestation 保持 location_share 城市；
同源两次 geocode 异城，取后者。

## 议题 5 — `deferTurnEnd` 的文档与默认分支描述已过时

审查对象：[generator.types.ts:178](src/agent/generator/generator.types.ts:178)、
[generator.agent.ts:385-421](src/agent/generator/generator.agent.ts:385)

### 现状核查结论

`deferTurnEnd` 机制本身**不是下线代码**——它是当前生产唯一活跃模式（TurnFinalizer 统一副作用
出口建立在它之上）。真正死掉的是注释当作"默认行为"描述的 fire-and-forget 分支：
`invokeReviewed` 恒强制 `deferTurnEnd: true`（[agent-runner.service.ts:219](src/agent/runner/agent-runner.service.ts:219)，
生产企微/debug-chat/test-execution 非流式全走此入口）；`runner.invoke` 透传的唯一调用方
conversation-test 显式传 `true`；复聊不经 GeneratorAgent。
**⚠️ 修正（8-14 数据流 review）**：`!deferTurnEnd` fire-and-forget 分支并非完全不可达——
test-suite SSE 交互测试链 [test-execution.service.ts:364](src/biz/test-suite/services/test-execution.service.ts:364)
经 `runner.stream` 未传 `deferTurnEnd`，stream `onFinish` 内 `attachTurnEnd(defer=undefined)`
正走该分支自动收尾。invoke 路径不可达、stream 路径在用。注释仍是 PR #415 重构前的世界观
（fire-and-forget 常态、defer 是 replay 特例），且"GeneratorAgent 内部触发 / runner 不再
自动触发"两处主语混用。

---

### [x] 5-1 `P2` 删除 `deferTurnEnd` 开关，defer 成为唯一语义（API 收敛 + 死分支清除）

**位置**：[generator.types.ts:165-178](src/agent/generator/generator.types.ts:165)、
[generator.agent.ts:385-421](src/agent/generator/generator.agent.ts:385)、
[agent-runner.service.ts:208-228](src/agent/runner/agent-runner.service.ts:208)、
[conversation-test.service.ts:606](src/biz/test-suite/services/conversation-test.service.ts:606)、
[test-execution.service.ts:184](src/biz/test-suite/services/test-execution.service.ts:184)

**改法**：
1. 删 `GeneratorInvokeParams.deferTurnEnd`；`attachTurnEnd` 删 `!deferTurnEnd` fire-and-forget
   分支，恒定挂 `runTurnEnd` 闭包；
2. `invokeReviewed` 内部的 `{ ...params, deferTurnEnd: true }` 强制逻辑与
   `wantDefer` 分流随之简化（repair 复用首版闭包的语义不变）;
3. 两个 test-suite 调用点删去 `deferTurnEnd: true` 传参（行为不变，它们本就消费 runTurnEnd）；
4. `GeneratorRunResult.runTurnEnd` 注释改为必然存在（类型去 optional 需核对 turn-outcome.ts
   的读取处），并写死契约：「调用 invoke 后必须在结果定局时触发一次 runTurnEnd，
   否则本轮记忆投影/事实提取静默丢失」——这是删除 fire-and-forget 兜底后的唯一防线；
5. `dispatchTurnEndLifecycle` 若仅剩该死分支使用则一并删除；
6. **stream 路径专项**（8-14 数据流 review 发现）：`stream()` 的 SSE 调用方
   （[test-execution.service.ts:364](src/biz/test-suite/services/test-execution.service.ts:364)）
   现依赖 fire-and-forget 默认收尾。删开关后 `stream()` 的 `onFinish` 内部改为显式
   `void result.runTurnEnd()`（挂闭包后立即自触发），保持 SSE 交互测试的既有收尾行为不变。

**风险边界**：生产 invoke 路径零行为变更（所有调用方本就 defer）；stream 路径以第 6 条
自触发保行为。唯一语义变化是"未来新调用方忘触发 runTurnEnd 会丢记忆写入"，以第 4 条的
契约注释 + 类型必然存在缓解。若执行时发现有未盘点到的调用方依赖 fire-and-forget，
本条降级为仅重写注释（把"默认 false=常态"的过时世界观改成"生产全路径 defer"）并在此记录。

**验收**：`pnpm run typecheck` 通过；generator.agent / agent-runner / turn-finalizer /
两个 test-suite 服务现有 spec 全绿；grep 全库无 `deferTurnEnd` 残留。

---

### [x] 5-2 `P1` replan 退役遗留：三个死入参字段 + 恒空的 HC-1 revise 注入链路整体收割

**位置**：[generator.types.ts:93-114](src/agent/generator/generator.types.ts:93)（三字段）、
[revise-directives.ts](src/agent/generator/preparation-utils/revise-directives.ts)（死分支）、
[preparation.service.ts:329,336](src/agent/generator/preparation.service.ts:329)（恒空调用）

**现象**：`reviseFeedback` / `guardrailRepair` / `committedSideEffects` 三个 GeneratorInvokeParams
字段**全库零写侧**（注释各自承认"replan 退役后不再传入/不经本字段"；runner 里的同名
`committedSideEffects:` 写点是 ReplyRepairAgent 入参与守卫档案的异构同名字段，与本字段无关）。
连锁：`buildReviseNotice` 恒返回空串、`buildReviseUserDirective` 恒返回 null，preparation 两处
调用为每轮空操作；活的修复链路是独立的 ReplyRepairAgent，不经 generator 重生成。

**改法**：
1. 删三个字段及其注释；
2. 删 `buildReviseNotice` / `buildReviseUserDirective` 及 preparation 的两处调用与 import；
   revise-directives.ts 仅存活 `buildProactiveDirective`（保留，主动回合在用），文件头注释
   同步改写（去掉 HC-1 revise 叙述）；
3. `generator.types.ts` 顶部的 `GuardViolation` re-export（L32-34，注释"HC-1 revise 回路注入用"）
   ——先 grep 确认无第三方从 generator.types 导入该类型，无则连 import 一并删；有则保留 re-export
   但改注释指向真实消费方；
4. `GENERATOR_TOOL_MODES` 的 `readonly` 注释从 "compatibility mode" 改为如实描述：
   主动回合（proactive）的物理工具约束，runner 对 proactive 触发默认 readonly；
5. 执行前先全库（含 tests/）复核三字段确无写侧；若 tests 有直测 buildReviseNotice 的 spec，
   随函数一并删除。

**注意**：本条只收割 replan 退役的死路径，不触碰活着的 ReplyRepairAgent 修复链
（repair 链路另有用户复盘裁定，勿顺手改动）。若未来复盘后要重建 revise 回路，git 历史可找回。

**验收**：`pnpm run typecheck` + lint 通过；preparation / generator / test-suite 现有 spec 全绿；
grep 全库无 `reviseFeedback|guardrailRepair` 残留，`committedSideEffects` 仅存于
reply-repair 与 guardrail-review 两个域。

## 议题 6 — preparation.service / generator.agent 数据流 review

审查对象：[preparation.service.ts](src/agent/generator/preparation.service.ts)、
[generator.agent.ts](src/agent/generator/generator.agent.ts)（全量数据流走查）

### 核过无问题的数据流（record，防止重复审）

- 规则轨输入用 `trailingUserMessages`（逐条数组，PR #1000 P0-1 修复在位），memory.onTurnStart
  与 compose/ledger 消费同一份 `memory.ruleFacts`；
- ledger 单实例贯穿 prep→工具→turn-end drain，无第二写入口；
- `recoverEmptyTextResult` 在 `attachTurnEnd` 之前执行，恢复文本正确成为 turn-end 的
  assistantText；短路轮（skip_reply/shortCircuited）正确跳过恢复；
- `computeToolCallStatus` 的 errorText/state 参数非死参（ai-stream-trace 在传）；
- 输入注入扫描每轮重扫整个短期窗口属正确设计（注入消息仍在上下文内则 GUARD_SUFFIX 应持续），
  告警侧有 throttle 兜底；
- entryStage 双处解析（compose 前未验证 returningUserStage / compose 后验证）最终一致——
  StageStrategySection 对未知 stage 回退首阶段，与 entryStage 回退口径巧合对齐（脆弱但当前无错）；
- stream 路径无空文本恢复为已知差异（SSE 测试链可见原始行为，暂视为有意）。

---

### [x] 6-1 `P1` critical-turn-guard 的 `combined` 目标在生产 WECOM 路径退化为仅本轮消息，四条规则的"近邻上下文"侦测静默失效

**位置**：[preparation.service.ts:403-422](src/agent/generator/preparation.service.ts:403)（`buildCriticalTurnGuard`）、
[critical-turn-guard.rules.ts](src/agent/generator/preparation-utils/critical-turn-guard.rules.ts)（4 条 `target: 'combined'` 规则）、
[agent-runner.service.ts:1052-1066](src/agent/runner/agent-runner.service.ts:1052)（WECOM 消息构造）

**现象**：`buildCriticalTurnGuard` 的 `combined` = `params.messages` 尾部 12 条 + 当前消息。
但生产 WECOM 路径 runner 只构造**一条**当前 user 消息（完整历史由 memory 层加载进
`normalizedMessages`，不进 `params.messages`）——`combined ≡ current`。
4 条 `combined` 规则的设计语义明确依赖历史（文案自证："即使**历史助手**说过专业不符"、
"**近邻上下文**显示候选人已在面试…"）：health_cert_is_not_major / post_interview_no_rebook /
salary_account_no_fabricated_policy / location_reference_needs_grounding。生产中它们只剩
"候选人单轮消息内同时命中全部 patterns"一种触发方式，跨轮场景（上一轮助手说"你已面试通过"、
本轮候选人只说"再帮我约一次"）全部漏过。而 test-suite/debug 传完整历史，combined 按设计工作——
**测试覆盖的语义 ≠ 生产语义**（与议题 1-1 同构的病）。

**建议改法**：`buildCriticalTurnGuard` 的 recent 窗口改从 `normalizedMessages`（含短期记忆窗口）
取尾部 12 条（text 部分），替代 `params.messages`——test-suite/debug 行为不变（其
normalizedMessages 与 params.messages 同源），WECOM 恢复规则设计语义。
⚠️ 这是**行为变更**（4 条规则在生产的触发面恢复到设计预期，动态禁令会更多出现），
执行前需用户确认；确认后建议附带在 test-suite 补一条"历史含'面试通过'+本轮仅'再约一次'
触发 post_interview_no_rebook"的回归用例锁定语义。

**验收**：新增回归用例通过；现有 critical-turn-guard 相关 spec 全绿；
WECOM 路径灰度观察动态禁令注入频次无异常暴涨。

---

### [x] 6-2 `P2` `buildCriticalTurnGuard` 输入与 `truncatedMessages` 的角色标签在 WECOM 恒为单条，注释未声明该约束

**位置**：[preparation.service.ts:328](src/agent/generator/preparation.service.ts:328)、
[preparation.service.ts:406-412](src/agent/generator/preparation.service.ts:406)

**现象**：`recent` 拼接 `${message.role}: ${message.content}` 声称覆盖"最近 12 条"，
实际条数取决于调用方传参形态（WECOM=1，test-suite=全history）。若 6-1 采纳则本条随之消解；
若 6-1 被否（维持现状），至少在 `buildCriticalTurnGuard` 注释里写明
「WECOM 生产路径 params.messages 仅含本轮消息，combined 实际退化为 current；
历史语义仅在 test-suite/debug 生效」，避免下一个维护者按注释语义添加依赖历史的规则。

**验收**：6-1 采纳→本条关闭；6-1 被否→注释补充后关闭。

## 议题 7 — handoff 承诺的治理形态：从"拦文案"改为"补动作"

审查对象：已下线的 `handoff_promise_without_handoff`（2026-08-11 第三批下线，commit ca0ce158
删除 handoff-promises.rule.ts 383 行）、
[dangling-promise.rule.ts](src/agent/guardrail/output/rules/dangling-promise.rule.ts)（在册 OBSERVE）、
[output-rule-catalog.ts:311](src/agent/guardrail/output/rules/output-rule-catalog.ts:311)（human_service_phrase_leak）

### 设计裁定（用户 8-14 明确）

原规则的拦截形态本身就是错的：模型承诺"让同事帮你确认/帮你转人工"而本轮无 handoff 动作时，
**正确处置不是改写/拦掉文案（消灭承诺），而是补执行 handoff 动作（让承诺成真）**。
dangling-promise 规则注释已独立论证过同一结论（repair 改不出候选人要的结果、block 让候选人
什么都收不到）。下线后现状真空：human_service_phrase_leak 只管措辞人设露馅、
dangling_reply_promise 只观测裸查询承诺，"handoff 承诺-动作对账"无人管，纯靠生成侧提示词。

---

### [x] 7-1 `P1` 重建 handoff 承诺-动作对账，形态=补动作，**直接 enforce 不设 shadow 期**（用户 8-14 裁定）

**改法**：
1. **检测器**：从 git 找回已删规则的词形（`git show ca0ce158^:src/agent/guardrail/output/rules/handoff-promises.rule.ts`），
   只保留**第一人称明确升级承诺**的最窄子集（"帮你转人工…"、"我让/找同事…确认/联系你"），
   沿用原规则"不拦『具体以门店确认为准』类边界声明"的排除设计；判定条件 = 命中词形 &&
   本轮无成功的 request_handoff / raise_risk_alert 调用（对账逻辑与原规则一致）。
2. **动作形态**：不进投递路径、不改文本——检测命中时在 turn-outcome 上挂人工介入
   sideEffect intent（与入站守卫的 TurnOutcomeInterventionService.commit 同模式，replay 定局后
   统一执行）：暂停托管 + 飞书通知 + handoff-events 落库（新 reasonCode，如
   `promise_reconciliation`，便于与模型自发 handoff 区分统计）。文本原样放行，承诺由真人接续兑现。
3. **直接 enforce**（用户裁定，不做 shadow 先行）：上线即执行补动作。理由：补动作形态下
   假阳代价 = 一次不必要的暂停+真人被 ping（候选人无感知、无错误投递物），风险本质不同于
   原 block 形态，无需观测期背书。每次触发都落 handoff-events + guardrail_review_records，
   精确率可事后从档案回看，出现假阳簇再收词形，不预设开关。
4. **边界**：human_service_phrase_leak 的措辞治理不动（人设露馅照旧 revise）；
   本机制只管动作对账，两者正交。ReplyRepairAgent 修复链不涉及（勿顺手改动，另有复盘裁定）。

**验收**：单测覆盖{承诺+无handoff=触发补动作 / 承诺+有handoff=不触发 / 边界声明=不触发 /
sideEffect 经 commit 出口执行且文本未被改动}；上线后 handoff-events 可按
`promise_reconciliation` reasonCode 过滤回看命中质量。

## 议题 8 — 多人代报（中介）场景系统性失效（badcase chat 6a4229f2ce406a6aeea72c81，8-14）

### 事故档案（数据实证，排障锚点）

中介联系人一轮给牛艳雪(19560645423)+王淼(15563231209)双报 jobId 528855：
牛艳雪成功(工单457339,提交手机号正确)；王淼被三道闸接力误杀——①09:13 姓名/电话一致性闸门拒
（单人档案装不下第二人身份）→ ②09:21 软查重 `booking.already_booked` 误判（命中牛艳雪的单;
不同手机号本应放行,罗欣宇/许颖修复的保守分支被新单查不到手机号击穿）→ ③09:31-36 precheck
`missingFields:["有无本地健康证"]` 死循环（"有"无法归属到王淼）→ 模型 system_blocked 转人工+
静默 → 真人未接手,09:42/09:46 两条"报名好了吗"卡 status='processing' 永不终结,候选人视角=卡死。
另：模型对②的归因**编造**"王淼手机号和牛艳雪同号/该号已报名"（工具结果只给了
existingWorkOrderId,未说手机号相同）。

**根因定性**：单候选人档案假设（sessionFacts.interview_info 单份身份/收资状态机单人/
闸门以会话级身份做一致性）vs 中介多人代报现实。四处闸门同时爆是同一假设的四个症状；
议题 3 冻结裁定的前提（补丁网络能用）对该场景类不成立。

---

### [x] 8-1 `P1` 多人代报轻量支持：报名调用自包含 + 候选人文本逐字锚定（不建子档案，不动记忆架构）

**裁定沿革（8-14 三轮收敛，勿回摆）**：初版"子候选人档案立项级重设计"被用户否决（低频场景
不做大修改）；"第二人一律转人工"也被否决（**同时服务多人是应该有的能力**）。终版=轻量支持：
不改档案/记忆架构，只把报名链路上"假设单一身份"的几道闸门改为**按调用自包含验证**。

**关键事实**：booking payload 本就 per-person 自包含（本案模型给两人分别传了正确的姓名/手机号），
被卡住的全是会话级单身份假设的闸门。防臆造保护不降级——验证源从"会话档案单一身份"换成
"候选人消息文本逐字锚定"（表单粘贴即满足），后者正是 candidate_quote 证据的本义，
对粘贴表单场景比档案匹配更强。

**改法**（工具层为主，预计 2-3 个 PR 粒度）：
1. **booking 一致性闸门加代报豁免轨**：payload 的姓名与手机号**都能在本会话候选人消息文本中
   逐字找到**（剥引用块/时间后缀，与既有 quote 验证同口径）→ 按 candidate_quote 证据放行；
   找不到 → 维持现有会话档案一致性闸（张冠李戴/示例回声防线原样保留）；
2. **precheck 收资按调用自包含**：候选人文本中含该人完整表单时，missingFields 判定
   以表单字段 + 其后确认问答为证据源（含"有无本地健康证"类 supplement），允许模型
   per-call 传齐，不依赖会话级 collect 状态——消解"'有'无法归属第二人"的死循环；
3. **软查重改 (jobId, phone) 口径**：与 8-2 合并执行——同联系人不同手机号报同岗 = 合法
   平行报名；Bull 重试必同 phone，防护天然保留；
4. **代报身份不写会话档案**：sessionFacts.interview_info 维持主聊对象单身份现状，
   代报人的字段只经本轮 ledger/booking 流转，不做沉淀（防多人字段互相覆盖的标量污染；
   也意味着指针/档案架构零改动）；
5. 验收锚 = 本 chat 场景：双人同轮同岗报名，两单都成、手机号各自正确、无收资死循环。

**边界**：不建子档案、不改 active_booking 指针结构、不动"禁增业务字段"硬纪律——
议题 3 冻结与本条不冲突（本条只改 booking/precheck 工具层闸门的证据源）。

**执行记录（2026-08-17）**：第 1 条（booking 一致性闸门代报豁免轨）与第 4 条（代报身份不写会话档案）
已落地——后者是**核对后确认现状即如此**：booking 工具不写 profile/sessionFacts，只写 active_booking 指针，
零代码改动。第 2 条（precheck 收资按调用自包含）由 9-1 键名归一化 + 9-2 断路器覆盖：王淼案的
"'有'无法归属第二人"根因是补充标签键名匹配失败，不是 collect 状态机；标准字段的 per-call 通道
（candidate* 入参优先于会话档案）本就存在。第 3 条即 8-2。

---

### [x] 8-2 `P1` 软查重保守分支修正：查不到既有工单手机号时不应保守判重

**位置**：[duliday-interview-booking.tool.ts:1039-1050](src/tools/duliday-interview-booking.tool.ts:1039)

**现象**：罗欣宇/许颖修复的语义是"反查工单手机号,不同=不同人放行",但"查不到工单手机号时
保守处理（判重）"的分支在本案击穿了修复本身——刚创建的工单（8 分钟前）海绵侧查不到/无手机号,
王淼（手机号明确不同）被误拦,且模型据此向候选人编造拒绝理由。

**建议改法**：查不到既有工单手机号时改为**放行交海绵仲裁**（海绵有同手机号同岗位的服务端
约束,注释自证"重复预约主要靠海绵约束"）；Bull 重试场景重试必然同 phone,海绵会拒,
不因此产生真重复。保守分支仅在海绵约束确认不存在时才有存在意义,执行前先向海绵侧确认
该约束现状,确认存在则删保守分支,不存在则改为 fresh 直查重试一次后再保守。

**验收**：单测——{同联系人同岗不同手机号+既有单查不到 → 放行}/{同手机号同岗 → 仍拦}；
本案时序（新单 8 分钟后二人报名）回归通过。

---

### [x] 8-3 `P2` already_booked 的 replyInstruction 补归因约束,禁止模型编造拒绝理由

**位置**：[duliday-interview-booking.tool.ts:144](src/tools/duliday-interview-booking.tool.ts:144) 附近
already_booked 分支的 `_replyInstruction`

**现象**：工具结果只含 existingWorkOrderId,模型向候选人编造"两人手机号相同/该号已报过名"。
**建议改法**：replyInstruction 追加一句「向候选人说明时只能说"系统显示近期已有一笔该岗位的
报名记录",不得自行推断或声称手机号相同/该号已报名等具体原因;候选人质疑时转 request_handoff
核实,不要坚持解释」。

**验收**：文案 review + 现有 booking spec 全绿。

---

### [x] 8-4 `P2` 托管暂停后的入站消息卡 status='processing' 永不终结

**位置**：channels 入站管道（暂停态分流处）,本案实例 message_id
a75c392b…(09:42) / 0fee189f…(09:46)

**现象**：handoff 暂停托管后,候选人后续消息的流水记录停在 processing,只能等 03:00 UTC cron
标 timeout（与"121 条 pps 卡 running"同族,又添两例）。不影响候选人（本就该由真人接）,
但污染观测口径（processing≠真在处理）。
**建议改法**：暂停态分流时把已建流水记录终结为 skipped/paused 状态（复用现有跳过语义）,
不新增状态机;若该分流点在建记录之前则改为不建记录。
**验收**：模拟暂停后入站,断言记录终态非 processing。

## 议题 9 — 收资补充标签死循环把模型逼到谎称已报名（badcase chat 6a7e7846ce406a6aeee2e232，8-14）

### 事故档案（数据实证）

候选人黄燕报小吊梨汤龙华会店。04:03 一行流表单给全资料后，precheck 四轮恒返回
`collect_fields` 只缺「身高(cm)/体重(kg)/有无本地健康证/需要中餐厅服务员经验」；模型三通道
全传过（deprecated 裸字段 + 带 quote 的 candidateClaims(含130斤=65kg换算) + supplementAnswers），
裁决零拒收零待确认，工具仍指示「请向候选人补问」→ 模型只能反复"确认下…对吗"，候选人
"是滴"+"对"×3 → 第 4 轮模型谎称"资料已经齐了，我帮你提交报名"（将来时逃逸 B-5 完成口径守卫）,
**booking 从未调用，报名至今未提交**。同日王淼案（议题 8）的"有无本地健康证"死循环同根。

**根因**：岗位补充标签（customerLabel）答案通道是三重窄门——①supplementAnswers 精确键名匹配,
但 checklist 判定名（"需要中餐厅服务员经验"）与模板显示名（"有无中餐厅服务员经验"）不同源；
②手工别名表按族维护,经验类正则覆盖不到新词形（本 bug 类已知,badcase 6a2fac72 曾修"工作经历族",
补丁式别名=每个新词形再卡死一次,这就是"最近频繁出现"的结构性原因）；③消息表单解析只认
独占一行「字段名：值」,候选人顿号一行流（"身高153、体重130"无冒号）全部读不出。
且 collect_fields 无断路器,模型被无限退回"去问候选人"。
代码自证：[interview-booking-customer-label.builder.ts:243-247](src/tools/duliday/booking/interview-booking-customer-label.builder.ts:243)。

**⚠️ 运营即办**（不入改动项）：黄燕 18013465216 小吊梨汤龙华会店报名需人工补交。

---

### [x] 9-1 `P0` 补充标签键名匹配从"精确+手工别名"改为归一化双向匹配 + 两套名字同源化

**位置**：[interview-booking-customer-label.builder.ts:236-255](src/tools/duliday/booking/interview-booking-customer-label.builder.ts:236)
（getSupplementAnswerAliases / normalizeSupplementKey / getSupplementAnswerValue）、
precheck 侧 checklist 显示名与模板 templateText 生成处

**改法**：
1. `normalizeSupplementKey` 升级：NFKC 折叠 + 去空白 + 去括号注记（`（有/无）`/`(cm)`/`(kg)`）+
   剥语气前缀（有无/需要/是否有/是否/能否）后再比对；供 supplementAnswers 键名与 labelName
   双向归一匹配；
2. **两套名字同源化（治本）**：checklist 判定名与 templateText 渲染行名从同一 label 常量生成,
   渲染层如需加"有无"类引导词只做展示装饰、判定仍用原始 label——从根上消除"模型按模板名回填、
   判定按后台名比对"的错位；
3. 手工别名表保留作兜底,但在归一化匹配后应只剩真正的语义别名（籍贯/户籍类）。

**验收**：本案回归——supplementAnswers 键"有无中餐厅服务员经验"命中 label"需要中餐厅服务员经验"；
6a2fac72 的工作经历族现有用例全绿；新增归一化单测覆盖括号注记/前缀剥离。

---

### [x] 9-2 `P0` collect_fields 断路器：同集合连续卡轮 + 模型已提交对应答案时禁止第三次"去问候选人"

**位置**：precheck 收资判定出口（[duliday-interview-precheck.tool.ts](src/tools/duliday-interview-precheck.tool.ts)
collect_fields 分支）

**现象**：missingFields 集合连续 4 轮不变、模型每轮都提交了针对这些字段的答案，工具仍指示
"请向候选人补问"——模型没有诚实出路,最终谎称已提交（将来时逃逸 B-5）。这是"把模型逼到说谎"
的结构性缺陷,独立于任何具体词形 bug（9-1 修不完所有未来词形）。

**改法**：precheck 检测「本次 missingFields ⊆ 上次 missingFields（可从 lastJobListQuery 同款
会话状态或 ledger 轮内多次调用比对）且本次入参 supplementAnswers/claims 中存在与缺失项
归一化匹配的键」时,不再返回 collect_fields:
- 该批答案按"模型转写、低置信"如实采纳进 checklist（booking 侧透传 supplementAnswers,
  海绵后台本就以文本存标签答案）,nextAction 推进；
- 若业务判定不可自动采纳（如筛选型标签）,则 nextAction=转 request_handoff,replyInstruction
  明确"系统无法核对该字段,已转人工",禁止再让模型向候选人重复收资。
两条路都给模型**诚实的出口**。

**验收**：单测——{同集合第2轮+入参含匹配答案 → 采纳推进}/{不含 → 维持 collect_fields}；
本案与王淼案（有无本地健康证）双锚回归。

---

### [x] 9-3 `P1` 一行流表单解析支持：顿号/逗号分隔的「字段名[：]值」inline 解析

**位置**：[interview-booking-customer-label.builder.ts:212-234](src/tools/duliday/booking/interview-booking-customer-label.builder.ts:212)
（extractSupplementAnswerFromMessages 只认独占一行「名：值」）

**现象**：候选人把模板拼成一行顿号流（"身高153、体重130、健康证情况（有/无）无"）回填,
逐行解析读不出任何字段;此形态在移动端粘贴场景常见。
**改法**：解析前先按 、/，/, 切段,每段再按「字段名[：:]?值」匹配（字段名须归一化命中
checklist label 或其别名,数值型字段允许省略冒号如"身高153"）;仍只读 user 消息、仍要求
字段名命中,防岗位要求文本误吸的安全边界不降。
**验收**：本案 04:03 原文解析出 电话/年龄/学历/健康证/身份/身高/体重/中餐经验;
现有防误吸用例（assistant 消息/空模板不吸）全绿。

---

### [x] 9-4 `P2` 议题 7 词形族补充：报名类将来时承诺 + 无 booking 动作

**现象**："我帮你提交报名/马上帮你提交"类将来时承诺后无 booking 调用——B-5 只拦完成时态,
dangling_reply_promise 只管查询承诺,报名承诺两头都不管。与 handoff 承诺不同,报名动作
无法自动补（precheck 未通过时不能替报）,故出口不是补动作而是并入观测/转人工。
**改法**：并入议题 7-1 的词形登记（独立分支）：检测报名类将来时承诺 && 本轮无 booking success
&& precheck 非 ready_to_book → 落守卫档案观测；若 9-2 断路器已落地,此形态应趋零,
指标用于验证 9-2 有效性。
**验收**：词形单测 + 守卫档案可按该 ruleId 过滤。
