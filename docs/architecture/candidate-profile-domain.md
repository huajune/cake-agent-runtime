# 候选人档案域架构（candidate profile domain）

**最后更新**：2026-08-12
**代码居所**：`src/resolution/{candidate,evidence,signal,brand,geo,labor-form,visual,job}/` + `src/memory/`

> **发版状态**：已随 PR #1000 / v10.44.0 上生产（2026-08-19）。其后收资表单批（PR #1023）
> 把收资场景的消费侧整体切到 [collection-form-machine.md](./collection-form-machine.md)
> 描述的表单状态机，并退役了本域的部分防线（三个 confirmation producer、adjudicate、
> 快照闸——写入公证接管后失去对象）；本文的裁决三分法（模型作证/代码公证/本人终审）、
> claim 通货与身份闸门仍是全系统底盘。涉及被退役部件的小节以代码为准，待下轮刷新。

> 本文是候选人事实链路的**域宪法与现状架构**。品牌、地理两个解析子域的细节各有专文：
> [brand-resolution.md](./brand-resolution.md)、[geo-resolution.md](./geo-resolution.md)；
> 记忆的存储与生命周期见 [memory-architecture.md](./memory-architecture.md)。

---

## 1. 域宪法

> **白话版（日常只记这三条）：**
> 1. **规则进 resolution**——怎么认字段、信不信、冲突听谁的，写成纯函数，一个字段一份，别处不许再写；
> 2. **事实进 memory**——判断结论轮末落 memory，要用事实找 memory 拿；
> 3. **一轮一判**——本轮消息/图片只判一次，结果挂回合上下文，谁用谁取。

**一句话：事实的主权归 memory，判断的实现归 resolution。**

`resolution` **没有运行时存在**——无 NestJS module、无 service、无状态、零 IO，是「一本证据规则 + 一台计算器」。什么时候裁、拿什么裁、裁完归谁、留多久，全部由 memory（跨轮）与工具执行点（轮内）决定，resolution 对时机与所有权**一概无权**。

「引擎住 resolution」不架空 memory：被搬走的只是散在执行点行间、本就无家可归的判断规则；memory 的全部难度——窗口组装 / 落盘并发 / TTL / 四层生命周期 / 沉淀 / 召回 / LLM 抽取编排——原地不动，它仍是唯一有主权的域。

```
对话/图片/工具确权 ──▶ memory 编排 ──调用──▶ resolution 判断（纯函数，算完即忘）
                          │◀────────结论─────────┘
                          ▼
                 memory 落档（证据链唯一归档处）──▶ agent / tools 消费
```

**回档纪律：判断可以现场做，结论必须回档。** tools 轮内可直接调用引擎（precheck、拉群门），但结论须经 memory 归档——precheck→booking 的 Redis 快照就是现行先例——**下游一律从档案取数，不从计算器的余温里取**。

---

## 2. 字段的四个生命周期阶段

每个候选人字段（brand、city、name、phone、labor_form……）都有四个阶段。**健康判据只有一条：每个字段 × 每个阶段，恰好一个居所**——0 个居所是散落，2 个居所是漂移。已知病灶全部能归到这两种。

| 阶段 | 回答的问题 | 准入判据 | 归属 |
|---|---|---|---|
| ① 解析 | 这段文本是什么标准值？ | 输入文本 → 输出该字段的**带证据主张**，不需要知道存量与来源 | resolution 解析工序 |
| ② 治理 | 谁说的？可信吗？冲突听谁的？ | 输入多源主张（存量作为入参传入）→ 输出采信结论，零 IO | **实现**：`resolution/evidence`；**主权与编排**：memory（跨轮）/ 工具执行点（轮内，结论回档） |
| ③ 存储 | 存哪、存多久、并发怎么办？ | 只管信封 / 持久化 / TTL / 沉淀，不做任何判断 | memory |
| ④ 使用 | 拿档案办什么事？ | 只读裁决结果（经 memory 供数），**消费点不得自带第二套判断** | tools / agent |

### 2.1 治理层的四条不变式

1. **一个引擎**——全部字段的治理只经统一裁决引擎（claim 底盘 + 三道审），没有第二条路径；
2. **策略是参数，不是方言**——字段差异只允许出现在同一张 `Record<Field, FieldPolicy>` 的参数行里（值类型 / 允许的 operation / producer 优先序与门槛 / 冲突语义），**编译期穷尽**；任何字段不得自带引擎；
3. **一个字段只有一份实现**——同一判断不得存在第二套方言，也不允许用适配层长期并存兜住；防再生靠 ESLint 与类型约束；
4. **一信号一判**——同一原始信号在一轮内只判一次，判决实例挂回合上下文共享，查询 / 闸门 / 归档消费同一份，**禁止各自重新解析**。

> **为什么不设字段豁免**：「X 特殊」式豁免会产生分叉——同一条规则在两个域各修一遍，两版逐渐漂移。特殊性只在**策略层**成立（字段的 producer 优先序、冲突语义可以各不相同），**从不在底盘层成立**：品牌那种带复合槽值与替换语义的字段，全部行为都能表达为统一引擎的一行策略，无一条需要自带引擎。

---

## 3. 域清单

```
src/resolution/                  # 判断力函数库：纯确定性、零 LLM、零 IO、无 NestJS module、不拥有事实
│
│  ── 登记工序（信号轴：每种信号唯一登记处）──
├── signal/         # markers（时间/引用/视觉/附件/位置标记协议，含写入侧）
│                   # self-report（候选人自陈语料选择 + 手机号出处核验）
│                   # dialogue（user 文本、对话轮次、引用发言人、确认短答）
│                   # visual/（视觉 sheet schema、归属规则、脱敏与存储解析）
│
│  ── 解析工序（字段轴：自由文本/信号 → 该字段的带证据主张）──
├── brand/          # 品牌：目录/匹配/极性/品类
├── geo/            # 地理：行政区/白名单/歧义/归一
├── labor-form/     # 用工形式：三态意向/层级匹配/展示规整
├── candidate/      # 身份字段族：name/phone/age/gender/height/weight/
│                   #   health-cert/education/household-province/is-student —— 每字段唯一解析器
├── job/            # 岗位指代解析（展示岗位提取 / 焦点岗位消解）
│
│  ── 裁决工序（多源主张 + 存量入参 → 采信结论）──
└── evidence/       # 统一裁决引擎 + Record<Field, FieldPolicy> 字段策略表
```

`src/resolution/evidence/README.md` 是该目录的文件地图（四组职责：通货与引擎 / producers / 入档准入 / 动作授权）。

### 3.1 两条正交轴

**字段轴**（每字段唯一解析器，答「这个串是什么标准值」）与**信号轴**（每种信号唯一登记处，答「这条消息是什么、里面的信息归谁」）**正交共存**。

`visual` 是**图片信号的登记处**，不在解析器轴上——sheet 的 field key 是**信号载荷**（vision 模型声称看到的串），不是解析产物；入档前仍须过字段解析器（`map_location` 的 city 过 geo 白名单、`job_posting` 的 brand 过 `resolveBrands`）与裁决。

```
信号 → 登记 → 授权域 → 字段解析器 → 裁决 → 落档
```

**归属 / 可信先验是信号的属性，值语义是字段的属性。** 「每字段唯一解析器」不因 sheet 存在而动摇。登记处有**盖章权**，故写入侧随登记处一起住在 `resolution/signal`。

### 3.2 memory 终态（事实主权域）

```
src/memory/
├── services/    # session（编排：调 LLM 抽取 → 调裁决链 → 落档）/ short / long
│                #   / procedural / settlement / lifecycle
│                # + brand-state（薄出口：只剩存取）
│                # + candidate-snapshot（薄出口：只剩 Redis get/set，快照语义归 evidence）
├── stores/      # Redis / Supabase 适配
├── types/       # 存储信封与 schema
└── formatters/  # 档案读模型唯一渲染出口（fact-lines）= ④消费的唯一供数口
```

「事实怎么算」（臆造门、city 多路径、rule×LLM 合并）全部是 evidence 的纯函数链，不在 memory 内实现。`session.service` 只有三步：**调 LLM 抽取 → 调裁决链 → 落档**。

### 3.3 依赖方向（ESLint 强制）

```
evidence → candidate/brand/geo/labor-form/signal/job + infra/utils
解析工序各子域 → infra/utils（brand→geo 既有例外保留）
memory / tools / agent / guardrail → resolution（任意子域）

硬禁：src/memory/** ↛ @tools/*
硬禁：src/tools/**  ↛ @memory/facts/*（DI 服务消费不受限）
读取约定（无法 lint，靠评审）：④对事实的消费一律经 memory 供数口
```

---

## 4. 判决时刻表与回合账本

本轮增量分两型：

- **消息型**——候选人本轮说的 / 发的，debounce 合并完即齐，规则轨纯函数可在 prep 判；
- **工具型**——geocode / vision 等工具执行才产生，只能随产随判。

```
prep（工具前）   消息型 producer 跑一次（规则轨前移）→ 临时判决挂 turn ledger
轮中             工具型 producer 随产随判 → 追加 turn ledger
轮末             LLM 轨补充 → 终审（与存量合并）→ 落档（唯一写出口不变）
```

工具从此只有两个只读来源：**档案（memory）+ turn ledger（回合上下文）**。工具内部的自行解析（precheck 就地解析、invite 门的 userTexts 扫描）已随 ledger 落地全部退役——它们是「一信号多判」的另一半病灶。

ledger 是物理上无法提前归档的那部分，内容出自同一台计算器、轮末必然归档；**prep 判决为临时态，终审在轮末，临时态不落档**。

### 4.1 协调者 vs 工具契约

**不是一个东西，是「所有者 vs 消费视图」：**

| | 角色 | 状态 / 契约 |
|---|---|---|
| 轮内协调者 | agent 运行时（开轮装配、轮中穿线、轮末交档） | **回合账本** `TurnLedger`——本轮判决实例的唯一副本 |
| 工具契约 | 工具的输入工作包 | `ToolBuildContext`——只持有账本的读取 + 追加**句柄** |

类型居所 `src/types/turn.types.ts`（中立契约，tools / memory / guardrail / agent 四方共读）；实例归 agent 运行时（开轮创建、轮末 `drain()` 交给 finalizer）。**与跨轮完全同构**：协调者拥有账本，工具借阅账本，memory 收编账本。

> 两个时间尺度、两个协调者（轮内 = 回合上下文，跨轮 = memory），**都按同一台计算器**。

---

## 5. 裁决通货：claim 与存根

### 5.1 通货

```ts
{ field, value, operation: 'set' | 'exclude' | 'clear',
  producer, evidence: { quote }, assertedAt }
```

经**三道审**：出处审 / 强度审 / 冲突审。

**来源根词汇六章**（`claim.types.ts` 是全库唯一定义点）：`candidate_quote` / `rule` / `model` / `system` / `manual` / `archive`。

- **待遇判据**——策略表待遇不同才配进词汇；
- **取名判据**——名字须填得进「这个值是 ____ 来的」；
- 更细的分法归 `interpretation` / `confidence` / `evidence`，不进根词汇。

**词汇在定义处就统一，不设翻译层**——存储枚举与根词汇之间的换算是 stores 适配器的 IO 细节，不构成独立的语义边界。

### 5.2 通货与存根的语义关系

**语义只定义一次（判决书），档案字段是判决书的导出存根，导出函数全库唯一。**

存根四字段没人再手写：`confidence` ← 策略档位 + 结论、`source` ← producer + 渠道、`evidence` ← quote + 理由码压缩、`extractedAt` ← assertedAt。理解 `source` 的方式是查映射表那一行，**不是另学一套词汇**。

完整判决书（谁主张 / 原话 / 理由码 / 被谁顶掉）落 `fact_adjudication` 观测事件（`trace_id` 可 join）：

> **存根答「现在信什么」，观测答「当初为什么信」**——可追溯性靠观测存全文，不靠档案存全文。

回放方向同表反跑（存根 → `producer='archive'` 主张）。**不消灭存根的理由**：回滚安全（存储零迁移）+ 演进解耦（判决模型随 badcase 快演进，存储格式必须稳）。

### 5.3 信封处置

| 信封 | 终态 |
|---|---|
| `CandidateFactClaim` | **全域唯一裁决通货** |
| `HighConfidenceValue` | 不存在——规则轨作为 producer 直接产 claim，无包装层 |
| `CollectedField` | **结构存续**（ledger 权威视图）；其「谁说的」词汇不独立，并入根词汇 |
| `VisualFactField.ownership` | visual producer 的出参，经映射进 claim，不是独立信封 |
| `BrandResolution` | brand 策略行的内部类型，对外一律走 claim |
| `SessionFactValue` / `UserProfileFactValue` | **纯落盘格式**——不承载裁决语义；存储格式与判决模型刻意解耦 |

防复发：新信封想出生，先回答「你为什么不是一个 `FieldPolicy` 参数行」。

### 5.4 采信分级

档案里的每个字段不是一个「值」，而是一条**有出处的主张**。渠道按证据强度分三档：

| 采信等级 | 渠道 | 例子 |
|---|---|---|
| **T1 亲证** | 候选人原文抽取 | 「我在浑南区」 |
| **T1 亲证** | GPS 定位坐标逆解析 | 曹路定位 → 上海 |
| **T1 亲证** | Agent 确认句 + 候选人肯定应答 | 「是在沈阳市对吧？」→「好的」 |
| **T2 工具确权** | geocode unique / precheck / booking 结构化结果 | `_cityConfirmed: 沈阳市` |
| **T2 确定性推导** | 区名 → 城市、品类 → 品牌 | 浑南区 → 沈阳 |
| **T2 带外权威** | 真人经理消息 / 操作、工单状态变化 | 「这个候选人我拒了」 |
| **T3 继承** | 长期画像带入本会话 | 「之前意向填的上海」 |
| **不采信** | 模型自报参数 | `invite(city=杭州)` 凭空传 |

T1/T2 全部由确定性规则产生（正则模板、工具返回、消息来源标记），**无 LLM 实时判断进快环**——与「投递路径只准确定性动作」一致。

### 5.5 消费准入矩阵

收口不是建一个新服务，而是用一张矩阵取代散落各处的 if：

| 动作风险档 | 例子 | 准入要求 |
|---|---|---|
| **不可逆副作用** | invite_to_group、booking 提交 | 关键字段 **≥ T2**，且本会话内产生或本会话确认过 |
| **对外展示档案** | 预填报名表、「你之前说过 X」 | 字段 **≥ T1 本会话亲证**；T3 继承值只准披露句式（「我记得你之前提过…现在还是吗」），**禁止断言式** |
| **内部检索 / 推荐** | job_list 查岗、群资源段渲染 | 任何等级可用（含 T3）——错了会被候选人纠正，无副作用 |
| **触达决策** | 复聊、面试提醒 | 必须检查**带外负向事实**（经理已拒 / 已面试 / 带外约面），命中即静默 |

> 判据散在各消费点时，「GPS 都不算证据」（过严）与「臆造姓名进表单」（过松）会同时出现——严与松并存说明缺的不是调松紧，而是**收口到同一张矩阵**。

---

## 6. 消费面：单一供数口 ≠ 单一调用口

门是用来保护状态的。**事实是带生命周期的可变状态，故供数单一门户（memory）；resolution 是纯函数，无状态可保护**，在它前面设门面零收益、三代价（memory API 变成全系统需求并集 / 纯代码被迫依赖 IO 域 / 瓶颈域重演杂物间动力学）。

精确表述：**resolution 的「事实产品线」由 memory 独家经销（裁决结论只有回档一个法定去向）；它的「判断力」是公共品。**

| 用法 | 例 | 结论去向 |
|---|---|---|
| 现场判断 → 回档 | geocode 确权、图片品牌旁路 | 进档案（回档纪律） |
| 动作授权判断 | invite 城市门、快照对账闸、姓名闸 | 不是事实，**用完即弃**；「判过 / 为何拒」落观测 |
| 信号的试探性使用 | 本轮 sheet phone 回灌查工单、查询构造 | 不入档；**必须消费共享判决实例**（不变式④） |
| 词表 / 归一借用 | labor-form 渲染、guardrail 对账、群标签匹配 | 无事实产生，不设门 |

### 6.1 消费权限表

引擎输出置信度与证据，但**「哪档置信度允许哪个动作」是消费方定价**——同一个事实，报名与拉群的门槛本可不同。这张表收在 `src/tools/shared/action-confidence.ts`（动作 → 允许消费的最低置信档），与「消费点不得自带第二套判断」同批落地。

### 6.2 消费域全景

共 7 个消费域：

| 消费域 | 调用点 | 用的子域 | 四类归属 |
|---|---|---|---|
| **memory** | `session.service` `extractAndSave` | evidence、candidate | 现场判断→回档 |
| | memory-lifecycle / turn-finalizer | evidence（brand/city 策略行） | 现场判断→回档 |
| | formatters/fact-lines | labor-form / brand 展示词表 | 词表借用（④唯一供数口） |
| **agent 运行时** | preparation + tool-context.builder | brand、geo、visual | **不变式④的协调者** |
| | context sections | labor-form、brand | 词表借用 |
| **tools** | precheck / booking | evidence、candidate | 现场判断→回档 + 动作授权 |
| | invite-to-group + 城市门 | geo、evidence | 动作授权 |
| | geocode.tool | geo | 现场判断→回档 |
| | job-list / brand-query / search | brand、geo、labor-form | 试探性使用 |
| | save-image-description.tool | visual | 证物登记（**生产者**） |
| **guardrail** | brand-name-errors / summer-worker 规则 | brand 归一、labor-form | 词表借用 |
| | review-packet.builder | visual | 共享判决实例 |
| **channels** | image-description.service | visual | 证物登记（生产者） |
| | image-brand-backfill | brand producer | 现场判断→回档 |
| **biz** | group-task 群标签匹配 | geo 归一 | 词表借用 |
| | candidate-profile-enrichment | candidate 归一器 | 词表借用 |
| **observability** | observer.interface 事件契约 | evidence / brand 类型 | 类型借用（编译期） |

结构要点：

1. **两个协调者地位特殊**——memory（跨轮）与 agent 运行时（轮内）不只消费，还**分发判决实例**；其余五域是纯下游；
2. **只有 memory 与 tools 碰裁决工序**，其余只碰解析工序的词表与归一，一条事实也不产；
3. **生产者是独立角色**——`save-image-description.tool` 与 `image-description.service` 调 visual 是给自己产的证物办登记，位于数据流上游，不是消费判断。

---

## 7. 关键裁决记录

| # | 裁决 |
|---|---|
| ① | **brand 上统一底盘，reducer 终删**——「brand 特殊」只在策略层成立；reducer 全部行为逐条映射为 brand 策略行（复合槽值 + set/exclude/clear + assertedAt 水位），无一条豁免 |
| ② | **candidate 快照：存储归 memory，语义归 evidence**——快照是 precheck→booking 的事务握手状态，不是记忆，不进 onTurnStart/onTurnEnd；`CandidateSnapshotService` 只剩 Redis get/set |
| ③ | **rule×LLM 合并归 evidence**——合并策略是裁决的一部分。改成 `Record<FieldKey, MergePolicy>` 编译期穷尽：加字段不表态即编译失败（旧的三份手抄字段清单曾静默丢弃 `brand_ids`） |
| ④ | **memory↔tools 环怎么断**——解析器出 tools、裁决出 memory，两边指向 resolution；单向断开环即不存在 |
| ⑤ | **visual 归属：生产归一留 visual，消费策略归 evidence**——授权域矩阵四个域名（identity/phone/preferences/geo）没有一个是视觉概念，它是档案准入策略借住在 visual |
| ⑥ | **消费权限表归④使用层，单一居所** |
| ⑦ | **「存量也是主张」**——把存量档案值作为 `producer='archive'` 的主张连同新主张一起送引擎，让位 / 置信度守卫化为普通冲突审规则，memory 写入彻底机械化 |

---

## 8. 观察期章程

> **性质：换挡不是停车。** 系统同时开着十余个观察窗（D4 shadow 重积累、DeepSeek 换模 drop 曲线、
> labor-form 双轨 diff、A1 §11 复测、`brand_state_change` 分布、收资去重率），
> **所有窗口共享同一基线**——沉淀期的红线是归因纪律，不是保守。

### 8.1 红线（观察期全程有效）

**不动结构**：不迁存储、不改词汇、不动域边界、不 bump 抽取契约版本。

⚠️ **观察期内任何会话（人或 AI）提议结构性改动，以本节为明文拦截依据**，改动意向写 backlog 过 §6.2 定则评审。

### 8.2 三类允许动作（白名单，其余免谈）

1. **收割预定决策**——翻开关不是重构：决策已做完，观察期只等数据递扳机；
2. **P0 止血**——永远豁免，任何时期豁免；
3. **对账类确定性小修**——badcase 只允许对账修复（工具回执 / 词典 / 原话账本比对）；「加个规则判一下」的冲动由对账定则拦截。

### 8.3 下一次「大动」的立项判据（仅两种合法信号）

1. 观察期数据指出结构性病灶；
2. 业务本身变化（新渠道 / 新品类 / 新作业模式）。

---

## 9. 开放项

### 9.1 待收割（决策已做完，等数据递扳机）

| # | 内容 | 扳机 |
|---|---|---|
| D4 | `CANDIDATE_FACT_ADJUDICATION_MODE` 仍为 **shadow**（代码默认值） | shadow 重新积累 ≥7 天、拒绝率达标后翻 `enforce`，先窄档（无出处值剔出 knownFieldMap）。旧 shadow 数据跨大版本作废 |
| — | labor-form 意向三态掌舵翻转 + 意向正则冻结 | 双轨 diff 一致率达标 |
| D7 | `GEO_NATIONAL_COUNTY_MAPPING_ENABLED` 默认开启并删开关 | 凭对照差异表终审（见 [geo-resolution.md §9.2](./geo-resolution.md)） |

### 9.2 挂起项与重开条件（不会丢，也不许提前唤醒）

| 挂起项 | 重开条件 |
|---|---|
| `CollectedField` 结构并入 claim | ledger 稳定运行一段时间后再议 |
| 存储枚举迁移（互转完全体） | 某天值得为词汇美学做存储迁移时 |
| 放行位仲裁器 | shadow 数据证明某确定性闸门大量误伤 |
| 语义档第二批迁移（极性长尾 / 要求 vs 自述 / 复聊 anchor） | labor-form 首发翻转后按 diff 数据排期 |
| `active_booking` 迁 biz 独立表 | **暂住不是定居**：出现「按工单反查候选人」需求或工单状态回流立项，任一出现即迁；硬纪律 = 禁增业务字段 |

---

## 相关文档

- [语义判定三分法](./semantic-decision-taxonomy.md) — 判定机制轴：正则 / LLM 标签位 / 向量的准入边界
- [品牌解析域](./brand-resolution.md) ｜ [地理解析域](./geo-resolution.md) ｜ [图片信息链路](./visual-fact-pipeline.md)
- [记忆系统架构与数据流](./memory-architecture.md)
- [记忆与状态全局视图](./memory-and-state.md)
- [Memory 当前实现权威](../../src/memory/README.md)
- `src/resolution/evidence/README.md` — evidence 目录的文件地图
