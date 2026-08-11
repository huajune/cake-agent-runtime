# 候选人档案域重构方案（candidate profile domain）

> **状态：✅ 已实施（2026-08-10，本分支）。** 终态代码以
> `src/resolution/candidate/`、`src/resolution/evidence/`、`src/resolution/labor-form/` 为准；
> memory 不再包含字段规则实现，brand/city/visual 的档案准入均消费同一 evidence 策略底盘。
> 本方案中描述的旧路径、行号和“现状”表仅保留为迁移审计记录。

> 2026-08-08。基于六路并行代码勘探（memory/facts 提取器族、candidate claim 引擎、brand、geo、visual、memory 存储层）+ 消息标记协议收口（已完成，见 `src/infra/utils/message-markup.util.ts`）。
> 关联文档：[candidate-fact-evidence-adjudication-plan.md](./candidate-fact-evidence-adjudication-plan.md)（claim 引擎，shadow 中）、[visual-fact-pipeline.md](./visual-fact-pipeline.md)、[geo-domain-refactor-plan.md](./geo-domain-refactor-plan.md)、[brand-resolution-refactor.md](./brand-resolution-refactor.md)。
> 触发裁决（jiezhu，2026-08-07）：**品牌、地址都是候选人信息，本就该与 name-guard 这类候选人信息平级**。本方案围绕这条反转展开。
> 追加裁决（jiezhu，2026-08-08）：**治理无例外**。"一套说辞、N 个方言、某字段永久豁免"正是本次要治的病根——全部字段上同一个裁决底盘，字段差异只能以参数行存在，每期验收物是旧实现物理删除（见 §2.0 三条不变式与 §3①）。
> 定稿裁决（jiezhu，2026-08-08，同日讨论收敛）：**事实的主权归 memory，判断的实现归 resolution**；一切对事实的消费经过 memory；判断可现场做、结论必须回档。全文以 §2.0 域宪法为准。

## 0. 根因：为什么乱

**「候选人档案」从来没有被立为一等域。** 系统真正的核心资产是一份档案——关于这个候选人我们知道什么（name/phone/age/城市/品牌意向/用工形式/健康证/……）、每条信息谁说的、冲突了听谁的。但这份档案没有唯一居所：每次 badcase 打到某个字段，就围绕那个字段长出一套小系统——品牌长出 reducer + 独立状态（vkikct39 之前）、城市长出七条写入路径、身份字段长出 claim 裁决引擎（收资证据化）、图片字段长出 ownership 闸（图片信息识别）。**每套各带一份「信封」模型（值 + 来源 + 置信度 + 冲突规则），互不相认。**

居所错位是同一病灶的另一面：解析器住进了它的第一个消费者家里（booking 先要 → 解析器住 tools），裁决住进了它的存储家里（结果要落 Redis → 裁决住 memory）。`memory/facts/` 已经被搬空过两次（geo、brand 各迁走一批，每个文件头都留着迁移记录），剩下的就是没搬完的那批。结果：

- **memory ↔ tools 双向真环**（≥7 条边，ESLint 零约束）；
- **同一字段两套解析器并行且已漂移**（phone 5 份 / name 3 份 / 健康证 3 份 / 年龄 3 份 / 性别 3 份 / 身高体重 2 份 / 户籍 2 份 / 学历 3 份）；
- **五套信封模型对「谁说的」各起一个名字**，同一个"候选人亲口说的手机号"分别是 `source='candidate'` / `provenance='user_text'` / `producer='rule'` / `ownership='candidate'`，全库零互转函数（唯一一个 `toCollectedFieldProvenance` 还是有损的，session.service.ts:536-540）。

## 1. 现状实锤（勘探摘要，全部带出处）

### 1.1 五套并存的信封模型

| # | 结构 | 来源轴 | 冲突处置 | 居所 |
|---|---|---|---|---|
| 1 | `SessionFactValue{value,confidence(4档),source(7值),evidence,extractedAt}` | candidate/llm/rule/system/memory/derived/tool | 置信度守卫：严格更低才拒（session.service.ts:448-457） | session-facts.types.ts:402-409 |
| 2 | `HighConfidenceValue{confidence(3档),source(2值)}` | rule/system | first-scalar / last-scalar / union-array 按字段注册 | session-facts.types.ts:435-440 |
| 3 | `CollectedField{provenance(4值),at}` | user_text/booking_writeback/llm_extract/model_arg | AUTHORITATIVE_PROVENANCE 白名单准入 | authoritative-session-state.types.ts:3-22 |
| 4 | `CandidateFactClaim{producer(4值),interpretation(4值),evidence{quote}}` | rule/model/confirmation_resolver/human | quote 复算 + 优先级 + 异值判 conflicted | candidate-fact-claim.types.ts:87-101 |
| 5 | `VisualFactField{ownership(4值)}` | candidate/publisher/third_party/unknown | kind→授权域整档开关 | visual-fact.types.ts:85-99 |
| +brand | `BrandResolution{intentPolarity(3),confidence数值档,source(3)}` | user_text/contact_name/image_description | 四步替换式 reducer，落盘即丢置信度 | brand-resolution.types.ts:37-96 |
| +长期 | `UserProfileFactValue{source(9值),updatedAt}` | 又一套 9 值枚举 | SQL 侧 rank 手工镜像 | long-term.types.ts:60-75 |

同一个候选人在同一轮说的话，走 city 通道被 confidence rank 比较、走 brand 通道被替换式状态机覆盖、走 name 通道被判 conflicted——三种结果互相不知道对方存在。

### 1.2 memory ↔ tools 真环（主要边）

```
memory/facts/candidate/candidate-fact-normalizers.ts:1-12 ──→ @tools/shared/candidate-field-parser（九个 parse*）
memory/facts/candidate/adjudication-runner.ts:1-3         ──→ @tools/shared/precheck-core + @tools/duliday/precheck/collection-strategy.util
memory/facts/placeholder-identity.ts:1                    ──→ @tools/shared/identity-statement.util
memory/services/session.service.ts:57-58                  ──→ @tools/shared/candidate-field-parser + precheck-core
memory/types/session-facts.types.ts:3                     ──→ @tools/duliday/job-list/welfare-facts.util（落盘 schema 依赖工具层！）
tools/shared/candidate-field-parser.ts:17,20-24           ──→ @memory/facts/name-guard + @memory/types（环闭合）
tools/duliday-interview-precheck.tool.ts:86-97            ──→ @memory/facts/candidate/*（claim 引擎全家）
```

被借用的能力全部是**纯 string→值 的确定性解析**，无一处需要工具执行上下文。环存在的唯一原因是解析器住错了地方。

### 1.3 两轨解析器漂移（勘探实锤的行为分歧，节选）

| 字段 | 规则轨（memory/facts/high-confidence-facts） | tools 轨（tools/shared/candidate-field-parser） | 分歧后果 |
|---|---|---|---|
| 健康证 | hcf:1207-1216 有疑问句守卫 | `parseHealthCert` 无疑问句守卫，「需要有健康证是吗」→ 1（有证） | **tools 轨产物直进 booking 有证 gate（真 bug）** |
| 身高 | hcf:893 先拒「要求/限/不低于」语境 | `parseHeight` 无语境守卫 | 复述岗位门槛「身高165以上能做吗」被当候选人身高，且是 user_text 权威档 |
| 性别 | hcf:1008 排除「要/招/限男女的」 | `parseGender` 第三分支 `/(男|女)(生|士)/` 命中「要招男生吗」 | 同一句两轨相反结果 |
| 年龄 | 区间判据在下游 fact-shape-gates（14-70） | parseAge 自带 14-70 | 三处各写一遍"什么是合法年龄" |
| 户籍 | 行首键值对 + 本地 34 项省名数组 | 认「老家/户口」+ 海绵省份词典 | 「老家是安徽」一轨提、一轨不提 |
| 学历 | 两个同名 `EDUCATION_KEYWORDS` 常量值域不同 | 输出「中专技校职高」，hcf 输出「中专」 | `normalizeEducationToId` 只认前者 |
| 简历判据 | visual-description:27 子串 `简历图片：` | resolution/visual:135 开头锚定 `简历|履历` + 认 sheet | **健康证 sheet 消息在 claim 轨被整条剔出语料 → quote_not_found 误拒** |

### 1.4 城市：解析层最干净、治理层最散的字段

> 注意口径：2026-07 的 geo 治理交付的是**解析层**（resolution/geo，勘探原话「边界写得很干净、零出向依赖」），且其方案明确把置信度生命周期划归 memory。本节的病灶全部在**治理层**——那是 geo 治理刻意划出 scope 的另一半，不是治理的失败。

pref.city 有 7 条产生路径（规则扫描 / LLM / 白名单回填 / 定位分享逆解析 / 地图截图确权 / 确认问答 / geocode 确权），其中 **6 条硬写 `confidence='high'`**——连 LLM 裸串都被 schema transform 抬成 high（session-facts.types.ts:72），置信度模型对 city 退化成常量。「本轮已有 high 则让位」这一条规则被手写了 **4 遍且写法各不相同**（session.service.ts:977-979 / 1230-1232 / 1523 / 349-366），geocode 确权路径还整个绕过形状门。同族的 district/location 则**零治理**：无形状门、纯累积去重、只进不出（session.service.ts:1778-1783）。

### 1.5 visual：sheet 字段近乎装饰，kind 才是产品

15 个 field key 里 **9 个全库零读者**（name/age_range/brand_id/publisher/store/salary_text/shift_text/cert_type/cert_issue_date），附录 A 承诺的 A2 品牌ID直通、B2 健康证补齐均未落地。真正生效的是 `kind → 授权域` 矩阵（resolveExtractionScope）——它回答的是「候选人档案的哪些字段允许被这条消息写入」，**是档案准入策略，只是恰好以图片 kind 为键**。另有一处倒挂：守卫的 review-packet.builder:262-288 从工具 raw args 手搓 sheet，绕过 finalize 的白名单/ownership 默认/身份证脱敏三道保证，而 semantic-reviewer 的提示词恰恰要求按 ownership 区分 candidate/publisher。

## 2. 目标架构

### 2.0 域宪法（2026-08-08 讨论定稿）

> **白话版（日常只记这三条，其余全是推导与辩护材料）：**
> 1. **规则进 resolution**——怎么认字段、信不信、冲突听谁的，写成纯函数，一个字段一份，别处不许再写；
> 2. **事实进 memory**——判断结论轮末落 memory，要用事实找 memory 拿；
> 3. **一轮一判**——本轮消息/图片只判一次，结果挂回合上下文，谁用谁取。
>
> 本节以下的术语（主权/实现、不变式、四类消费面、判决时刻表）是这三条的论证过程，服务于"有人挑战这三条时拿什么回答"；日常讨论与 code review 用白话版即可。claim/FieldPolicy/producer 是代码标识符，不是需要挂嘴上的概念。

**一句话：事实的主权归 memory，判断的实现归 resolution。**

resolution 没有运行时存在——无 NestJS module、无 service、无状态、零 IO，是「一本证据规则 + 一台计算器」（今天的 brand/geo 就是这个形态，裁决引擎做出来还是这个形态）。什么时候裁、拿什么裁、裁完归谁、留多久，全部由 memory（跨轮）与工具执行点（轮内）决定，resolution 对时机与所有权一概无权。因此「引擎住 resolution」不架空 memory：被搬走的只是散在执行点行间、本就无家可归的判断规则（约 520 行 if），memory 的全部难度——窗口组装/落盘并发/TTL/四层生命周期/沉淀/召回/LLM 抽取编排——原地不动，它仍是唯一有主权的域。

主链路数据流：

```
对话/图片/工具确权 ──▶ memory 编排 ──调用──▶ resolution 判断（纯函数，算完即忘）
                          │◀────────结论─────────┘
                          ▼
                 memory 落档（证据链唯一归档处）──▶ agent / tools 消费
```

**回档纪律：判断可以现场做，结论必须回档。** tools 轮内可直接调用引擎（precheck、拉群门），但结论须经 memory 归档——precheck→booking 的 Redis 快照就是现行先例——下游一律从档案取数，不从计算器的余温里取。

**resolution 的消费面：单一供数口 ≠ 单一调用口（2026-08-08 讨论定稿）。** 门是用来保护状态的：事实是带生命周期的可变状态，故供数单一门户（memory）；resolution 是纯函数，无状态可保护，在它前面设门面零收益、三代价（memory API 变成全系统需求并集 / 纯代码被迫依赖 IO 域 / 瓶颈域重演杂物间动力学）。精确表述：**resolution 的"事实产品线"由 memory 独家经销（裁决结论只有回档一个法定去向）；它的"判断力"是公共品**。域外调用共四类，各有纪律：

| 用法 | 例 | 结论去向 |
|---|---|---|
| 现场判断→回档 | geocode 确权、图片品牌旁路 | 进档案（回档纪律） |
| 动作授权判断 | invite 城市门、快照对账闸、姓名闸 | 不是事实，用完即弃；"判过/为何拒"落观测（守卫档案先例） |
| 信号的试探性使用 | 本轮 sheet phone 回灌查工单、查询构造 | 不入档；**必须消费共享判决实例**（不变式④） |
| 词表/归一借用 | labor-form 渲染、guardrail 对账、群标签匹配 | 无事实产生，不设门 |

轮内共享的协调者是回合上下文（agent 运行时，`turnVisualFactSheets` 即现行形态），跨轮协调者才是 memory——两个时间尺度、两个协调者，都按同一台计算器。

**协调者与工具契约的关系（2026-08-10 讨论定稿，回应"ToolBuildContext 是不是轮内协调者"）：不是一个东西，是"所有者 vs 消费视图"。** 轮内协调者是**角色**（agent 运行时：开轮装配、轮中穿线、轮末交档），它的状态叫**回合账本**（TurnLedger，本轮判决实例的唯一副本）；`ToolBuildContext` 是**契约**（工具的输入工作包），只应持有账本的读取+追加**句柄**。现状病理：账本无名无居所，字段被内联进工具契约（`turn*` 散字段 + 六个 `on*` 回调），账本被三个消费者之一绑架了户口——turn-finalizer 与 guardrail 只能从别的路径去凑同一批数据。终态所有权：类型居所 `src/types/turn.types.ts`（中立契约，tools/memory/guardrail/agent 四方共读，`GeocodeResolvedAnchor`/`CityAttestation` 等条目类型随迁）；实例归 agent 运行时（开轮创建、轮末 `drain()` 给 finalizer）；与跨轮完全同构——协调者拥有账本，工具借阅账本，memory 收编账本。

**判决时刻表（2026-08-08 追加，回应"tools 为何不全消费 memory"）。** 本轮增量分两型：**消息型**（候选人本轮说的/发的——debounce 合并完即齐，规则轨纯函数可在 prep 判）与**工具型**（geocode/vision 等工具执行才产生——只能随产随判，#765/oaz6inzf 两档 badcase 均属此型）。目标调度：

```
prep（工具前）   消息型 producer 跑一次（规则轨前移）→ 临时判决挂 turn ledger
轮中             工具型 producer 随产随判 → 追加 turn ledger
轮末             LLM 轨补充 → 终审（与存量合并）→ 落档（唯一写出口不变）
```

工具从此只有两个只读来源：**档案（memory）+ turn ledger（回合上下文）**；工具内部的自行解析（precheck 的 HC-2 就地解析、invite 门的 userTexts 扫描）随 ledger 落地全部退役——它们是"一信号多判"的另一半病灶。ledger 是物理上无法提前归档的那部分，内容出自同一台计算器、轮末必然归档；prep 判决为临时态，终审在轮末（LLM 轨可补充），临时态不落档。现行先例：prep 的定位分享 seed 与备注品牌 seed 就是消息型前移的雏形。

每个候选人字段（brand、city、name、phone、labor_form……）都有四个生命周期阶段。**健康判据只有一条：每个字段 × 每个阶段，恰好一个居所**——0 个居所是散落（city 的治理层），2 个居所是漂移（身份字段的解析层）。全部已知病灶都能归到这两种。

| 阶段 | 回答的问题 | 准入判据 | 归属 |
|---|---|---|---|
| ① 解析 | 这段文本是什么标准值？ | 输入文本 → 输出该字段的**带证据主张**，不需要知道存量与来源 | resolution 解析工序（brand/geo/labor-form/candidate/visual） |
| ② 治理 | 谁说的？可信吗？冲突听谁的？ | 输入多源主张（存量作为入参传入）→ 输出采信结论，零 IO | **实现**：resolution/evidence 统一裁决引擎；**主权与编排**：memory（跨轮）/ 工具执行点（轮内，结论回档） |
| ③ 存储 | 存哪、存多久、并发怎么办？ | 只管信封/持久化/TTL/沉淀，不做任何判断 | memory |
| ④ 使用 | 拿档案办什么事？ | 只读裁决结果（经 memory 供数），消费点不得自带第二套判断 | tools / agent |

**②治理层的四条不变式（本次治理的宪法）：**

1. **一个引擎**：全部字段的治理只经统一裁决引擎（claim 底盘：`{field, value, operation(set/exclude/clear), producer, evidence{quote}, assertedAt}` + 三道审），没有第二条路径。
2. **策略是参数，不是方言**：字段差异只允许出现在同一张 `Record<Field, FieldPolicy>` 的参数行里（值类型/允许的 operation/producer 优先序与门槛/冲突语义），编译期穷尽；任何字段不得自带引擎。
3. **每期验收 = 旧实现删除**：分期只是风险排序，不是架构表态；一期结束的标志是旧方言物理删除 + 防再生篱笆（ESLint/类型），不是适配层永久共存。（2026-08-08 加码为一气呵成：工序仍按此序，但单分支单发版，任何过渡形态不出 campaign 分支。）
4. **一信号一判**：同一原始信号在一轮内只判一次，判决实例挂回合上下文共享——查询、闸门、归档消费同一份，禁止各自重新解析。样板：`turnVisualFactSheets`（vision 判一次、finalize 归一一次，拉群门/precheck/入档共用）；已实证的反例：brand 文本被 hints/规则/LLM/昵称四轨独立解析且预处理各剥各的（§19.2「调用方无法再漏」的保证对规则轨不成立）、定位分享坐标被 prep 与轮末各逆解析一次。P3/P5 的 producer 清单即本条的落地形状。

历史注脚：三套现存治理（claim 引擎 / brand reducer / city 散装让位）各诞生于一个 badcase 波次，每一波只治理了当时出血的字段——"X 特殊"式豁免已实证产生分叉（发布方剔除在 brand 与 visual 各修一遍、简历判据两版漂移）。上周 claim 证据化把 brand/city 摘出去，摘除理由（"语义不同"）只在策略层成立、从不在底盘层成立（brand 的映射证明见 §3①）。

### 2.1 域清单与准入判据

resolution = **无状态的判断力函数库**（`resolution` 一词双关：entity resolution 实体解析 + conflict resolution 争议裁决）。内部分两道工序——解析（信号→带证据的主张）与裁决（多源主张→采信结论），src 根目录数不变（18）：

```
src/resolution/                  # 判断力函数库：纯确定性、零 LLM、零 IO、无 NestJS module、不拥有事实
│
│  ── 登记工序（信号轴，P8 终态：signal/{markers,self-report,dialogue,visual}——
│      现散居 infra/utils(markers 前身 message-markup)、evidence(corpus)、本域 visual）──
│  ── 解析工序（字段轴：自由文本/信号 → 该字段的带证据主张）──
├── brand/          # 品牌：目录/匹配/极性/品类（收编 validateBrandIntents、detectBrandAliasHints；
│                   #   brand-state.reducer 在 campaign 内化为 evidence 的 brand 策略行并删除，终态无 reducer）
├── geo/            # 地理：行政区/白名单/歧义/归一（现状保持；收编省级后缀归一两份漂移）
├── labor-form/     # 用工形式：三态意向/层级匹配/展示规整（自 memory/facts/labor-form.ts 平移，零 import 纯搬）
├── candidate/      # 身份字段族：name/phone/age/gender/height/weight/health-cert/education/
│                   #   household-province/is-student —— 每字段唯一解析器
│                   #   ← 合并 tools/shared/candidate-field-parser + identity-statement.util
│                   #     + precheck-core 真名问答解析器 + name-guard 纯函数 + hcf 逐字段提取器
├── visual/         # 视觉证物登记：sheet schema / finalize / 模型词表（生产归一，不判采信）
│
│  ── 裁决工序（多源主张 + 存量入参 → 采信结论）──
└── evidence/       # 统一裁决引擎（claim 底盘 + 三道审）+ Record<Field, FieldPolicy> 字段策略表
                    #   + 语料判定/quote 复算/producer 优先序/rule×LLM 合并策略
                    #   + 快照语义（watermark/gate）/来源分类学互转表/准入授权域
                    #   ← memory/facts/candidate/* + snapshot-gate + session.service 的 11 道臆造门
                    #   终态吸收：brand 策略行（P5，替代 reducer）、city 策略行（P3 首发）
```

**每个域的准入测试（能拒绝东西才算判据）：**

| 域 | 准入测试 | 被拒绝的例子 |
|---|---|---|
| 解析工序各子域 | 输入自由文本/信号，输出**该字段**的带证据主张；零 IO 零 LLM 零状态 | `sanitizeBrandName`（输出治理，非解析）；session 编排；任何读档案的代码 |
| resolution/visual | 视觉 sheet 的 schema 与**生产侧**归一（白名单/ownership 默认/脱敏） | `resolveExtractionScope`（消费策略→evidence）；vision 调用（→channels/tools） |

**两条正交轴的澄清（2026-08-10，回应"visual 为何按消息类型组织"）**：字段轴（每字段唯一解析器，答"这个串是什么标准值"）与信号轴（每种信号唯一登记处，答"这条消息是什么、里面的信息归谁"）正交共存。visual 是**图片信号的登记处**，不在解析器轴上——sheet 的 field key 是**信号载荷**（vision 模型声称看到的串），不是解析产物；入档前仍须过字段解析器（map_location 的 city 过 geo 白名单、job_posting 的 brand 过 resolveBrands）与裁决。归属/可信先验是信号的属性，值语义是字段的属性。流水线：信号 → 登记 → 授权域 → 字段解析器 → 裁决——"每字段唯一解析器"不因 sheet 存在而动摇。**信号轴归拢（2026-08-10 追加裁定，P8）**：登记处现散居三域（markup@infra/utils、corpus@evidence、visual@resolution），归拢为 `resolution/signal/{markers,self-report,dialogue,visual}` 第三道工序——**登记处有盖章权**，写入侧随迁（推翻 08-07 的 infra 安置：当时的反对理由只在"resolution=解析+裁决"旧定义下成立，用户当时的直觉先于词汇）。
| resolution/evidence | 输入多源主张（存量以入参形式传入），输出采信/拒绝/冲突 + 理由码；可调解析工序做归一复算 | 任何 IO；存储格式；prompt 拼装；LLM 调用；「何时裁/裁完归谁」的编排（→memory） |
| memory | **事实主权域**：编排判断、拥有档案与证据链归档、TTL/并发/生命周期/沉淀/召回、LLM 抽取 IO 编排、对外唯一供数口 | 判断规则的**实现**（→evidence，memory 只调用）；可复用纯解析 |
| tools | 工具执行上下文 + 外部系统适配；轮内可调引擎但结论必须回档 | 可复用的纯文本解析（→resolution）；自带第二套可信判断（→消费权限表） |
| infra/utils | 零依赖纯函数 + 消息标记协议（含写入侧） | 一切领域知识 |

**依赖方向**（ESLint 强制，现有规则扩展）：

```
evidence → candidate/brand/geo/labor-form/visual + infra/utils
解析工序各子域 → infra/utils（brand→geo 既有例外保留）
memory/tools/agent/guardrail → resolution（任意子域）
新增两条硬禁：src/memory/** ↛ @tools/*；src/tools/** ↛ @memory/facts/*（DI 服务消费不受限）
读取约定（无法 lint，靠评审）：④对事实的消费一律经 memory 供数口；轮内裁决结论经快照/落档回流
```

### 2.2 memory 终态（事实主权域）

```
src/memory/
├── services/    # session（编排：调 LLM 抽取 → 调裁决链 → 落档）/short/long/procedural/settlement/lifecycle
│                # + brand-state（薄出口：删自持 buildHashKey，走 SessionService 字段出口；P5 后只剩存取）
│                # + candidate-snapshot（薄出口：只剩 Redis get/set，快照语义归 evidence）
├── stores/      # Redis/Supabase 适配（现状）
├── types/       # 存储信封与 schema；HighConfidenceValue 的包装/解包设施从 hcf 拆入此处
└── formatters/  # 档案读模型唯一渲染出口（fact-lines）= ④消费的唯一供数口
（facts/ 目录最终解散——它已被搬空两次，这次搬完）
```

extractAndSave 里约 520 行「事实怎么算」（11 道臆造门 + 6 条 city 路径 + rule×LLM 合并）迁出为 evidence 的纯函数链后，session.service 只剩三步：调 LLM 抽取 → 调裁决链 → 落档。**这不是把 memory 变薄**：窗口组装、落盘并发锁、TTL、四层生命周期、沉淀、召回编排、抽取 IO——memory 的全部难度原地不动；被迁出的只是借住在执行点行间的判断规则。主权清单（什么时候裁、拿什么裁、裁完归谁、留多久）全部仍由 memory 行使。

### 2.3 信封终态（§1.1 五套并存的统一处置）

不是五套都删，是**三类处置：1 套通货 + 2 套纯存储格式 + 4 套退役**：

| 现状信封 | 终态 | 处置期 |
|---|---|---|
| `CandidateFactClaim` | **升格为全域唯一裁决通货**（不变式①） | P2 起 |
| `HighConfidenceValue` | **退役**——规则轨变 producer 直接产 claim，包装层失去存在理由 | P3-8 |
| `CollectedField`（HC-2 权威字段） | **退役**——出处审（quote 复算）取代 provenance 白名单；ledger 落地后工具内解析退场，`toCollectedFieldProvenance` 的有损映射随之消失 | P3-9 |
| `VisualFactField.ownership` | 降格为 visual producer 出参，经互转表映射进 claim | P4 |
| `BrandResolution` | 降格为 brand 策略行内部类型，对外走 claim | P5 |
| `SessionFactValue` | **保留，降格为纯落盘格式**——不再承载裁决语义，写入前通货是 claim | 非目标（Redis 兼容） |
| `UserProfileFactValue` | 同上（长期存储格式），来源枚举纳入互转表 | 非目标 |

过渡桥 = P3-6 来源分类学互转表（五套「谁说的」枚举映射唯一居所，有损必须显式，禁私转）。防复发 = 不变式①②（新信封想出生，先回答"你为什么不是一个 FieldPolicy 参数行"）。两轨解析器漂移（§1.3）的对应主轴是 P0 止血 + P1 合一 + ESLint 双禁令，居所收一、第二份解析器无合法出生地。

**通货与存根的语义关系（回应"记忆的证据链 vs 判决的证据链两套语义"之惑）：语义只定义一次（判决书），档案字段是判决书的导出存根，导出函数全库唯一（interop）。** 存根四字段没人再手写：`confidence` ← 策略档位+结论、`source` ← producer+渠道、`evidence` ← quote+理由码压缩、`extractedAt` ← assertedAt——理解 source 的方式是查映射表那一行，不是另学一套词汇。完整判决书（谁主张/原话/理由码/被谁顶掉）落 `fact_adjudication` 观测事件（trace_id 可 join）：**存根答"现在信什么"，观测答"当初为什么信"**——可追溯性靠观测存全文，不靠档案存全文（仓库既有观测模式）。回放方向同表反跑（存根 → `producer='archive'` 主张）。不消灭存根的理由：回滚安全（存储零迁移是一气呵成的底）+ 演进解耦（判决模型随 badcase 快演进，存储格式必须稳）。

## 3. 关键裁决记录

**① brand 上统一底盘，reducer 终删（2026-08-08 用户裁决，推翻本方案初稿的"信封统一非目标"）。** "brand 特殊"只在策略层成立、从不在底盘层成立——reducer 全部行为可逐条映射为统一引擎的 brand 策略行，无一条需要豁免：

| reducer 行为（brand-state.reducer.ts） | 统一底盘中的表达 |
|---|---|
| 第0步：剔 contact_name / 歧义 / <0.75 | ①出处审 + ②强度审（brand 行的 producer 门槛参数） |
| 第1步：positive 按来源序、「文字赢图片」 | ③冲突审的渠道优先序（user_text > image_description）+ `operation=set` 替换语义 |
| 履历语境闸 | ①出处审的语境规则（quote 落在履历语境不构成 set） |
| 第2步：negative 同轮排斥赢 | `operation=exclude` 冲突规则：同轮 exclude > set |
| 显式 positive 赦免解除排斥（品类展开不解除） | 跨槽规则：显式 set 移除排斥集中同品牌 |
| 第3步：browse_all 清空 | `operation=clear` |
| 晚到丢弃 shouldDropLateResolutions | 底盘时序规则（assertedAt 水位） |
| currentBrand + excludedBrands 复合状态 | brand 槽的值类型 = 复合结构（底盘须支持复合槽值——这是对引擎的要求，不是豁免理由） |

迁移排最后一期（P5）：金测试 = reducer 现有 spec 全集对新引擎回放，加 shadow_diff 双跑（品牌域已有成功先例）；**验收物是 `brand-state.reducer.ts` 物理删除**，不是适配层永存。过渡期动作照旧：BrandStateService 删自持 `buildHashKey`（brand-state.service.ts:329-331）走 SessionService 出口；`validateBrandIntents`（session.service.ts:1295-1350）与 `detectBrandAliasHints`（hcf:536-560）先收回 brand 域；`isSameBrandRef` 两份拷贝合一。存储格式（brand_state 字段形态）与引擎解耦，可保持不迁。

**② candidate 快照 vs memory 生命周期：存储归 memory，语义归 evidence。** 快照是 precheck→booking 的事务握手状态，不是记忆——它不进 onTurnStart/onTurnEnd 是对的（勘探确认 lifecycle 全文无引用），写进 README 固化。`precheck-snapshot.types`（watermark/factsVersion）、`snapshot-gate.util`（tools/duliday/booking，三个 import 全来自 claim 域）、`CLAIM_FIELD_TO_CHECKLIST` 等三张字段映射表（precheck.tool:645-703，注释自陈"写错一个字闸门无声失效"）全部归 evidence；CandidateSnapshotService 只剩 Redis get/set。

**③ rule×LLM 合并归谁：evidence。** 合并策略是裁决的一部分。现状是 session.service 三份手抄字段清单（SCALAR_INFO_FIELDS/SCALAR_PREF_FIELDS/ARRAY_PREF_FIELDS），已经漏掉 `brand_ids`——该字段两份清单都不在，规则轨产出被静默丢弃（session.service.ts:1767-1783，真 bug）。改成 `Record<FieldKey, MergePolicy>` 编译期穷尽：加字段不表态即编译失败（与 visual-fact.policy 的 KIND_EXTRACTION_SCOPE 同一招）。健康证「rule 覆盖 LLM」等特例成为显式策略而非行间注释。

**④ memory↔tools 环怎么断：解析器出 tools、裁决出 memory，两边指向 resolution。** Phase 1 断 memory→tools 方向（纯解析全部迁入 resolution/candidate + infra/utils），立即上 ESLint 禁令——单向断开环即不存在；Phase 2 断 tools→memory/facts 方向（claim 引擎迁 evidence）。`extractMessageText`（19 行多模态扁平化，住在收资策略文件里被 memory 两处 import）→ infra/utils/message-markup。

**⑤ visual 归属：生产归一留 visual，消费策略归 evidence。** 勘探结论明确：sheet.fields 九成无读者、kind→授权域才是产品，而授权域矩阵四个域名（identity/phone/preferences/geo）没有一个是视觉概念——它是档案准入策略借住在 visual。Phase 3 将 `resolveExtractionScope` 迁入 evidence 的字段准入层（与文本来源的 stripQuotedBlocks 收窄、claim 的语料判定合成同一张准入表）；visual 域保留 schema/finalize/词表（生产侧）。目录不再二次搬迁（不搞 `evidence/visual/` 嵌套）——上周刚建的 policy.ts 再迁一次文件属于计划内，import 面 ~4 个文件。

**⑥ 消费权限表归④使用层，单一居所。** 引擎输出置信度与证据，但「哪档置信度允许哪个动作」（只有 high 可预填报名、可放行拉群）是消费方定价——同一个事实，报名与拉群的门槛本可不同。现状这张表散在 invite gate / precheck 各处，收成一张显式权限表（单一文件），与「消费点不得自带第二套判断」同批落地。

**⑦ 「存量也是主张」：Phase 3 city 试点，不预先定生死。** 把存量档案值作为 `producer='archive'` 的主张连同新主张一起送引擎，让位/置信度守卫即化为普通冲突审规则，memory 写入彻底机械化。它是调用约定层面的技巧而非架构决定；city 反正要新建策略行（零迁移成本），先在 city 上验证，好用再推广，不好用则 memory 写入路径维持现状调用方式。

## 4. 执行序（一气呵成，2026-08-08 用户裁定）

**P0–P5 是工序依赖顺序，不是发版节奏**：同一 campaign 分支连续完成、一次发版落地，不对外暴露过渡期/双轨/适配层形态；回滚 = 应用版本整体回滚（全程零存储迁移）。brand 切换以金测试为闸、shadow_diff 改发版后验证（连续 7 天零分歧）。开工唯一前置：D1/D2/D3/归一剥「省」四项裁决一次拍完。施工手册见 [candidate-profile-domain-implementation-guide.md](./candidate-profile-domain-implementation-guide.md)。

> **执行状态（2026-08-10）**：第一 campaign（P0–P5 结构性动作）已全部落地并通过验收——账本核心兑现：六个整文件删除（含 `brand-state.reducer.ts`，金测试改回放 `evidence/brand-policy`）、`memory/facts` 目录消失、ESLint 双禁令落位、session.service 让位判据 0 残留、三大件全绿（typecheck / lint / 7081 测试）。评审修复随后完成：name-qa 拆三归 evidence（corpus / producers/name-confirmation / identity-gates）、裁决史注释回填、`isDigitsOnlyName` 口径还原、evidence 命名清理（brand 同名冲突 / run→adjudicate / admission-shape 并入 gates / producers 按信号渠道命名）+ evidence/README 文件地图、`parse.ts`→`collected-fields.ts`、`CollectedField` 信封别名化归一。两笔已声明余款转入 P6/P7。
> **终局（2026-08-11）**：P6–P9 亦全部落地（回合账本：ToolBuildContext 288→97 行五组化 + turn-ledger/drain；通货：rule-track claim 化、HighConfidenceValue 全库退役；信号轴：signal/{markers,dialogue,self-report,types,visual}、infra/utils 回归四件套；契约：各域 types 收口、tool.types 瘦身）。六个按工序 commit（c9eb8231→97299fcb），三大件全绿（7082 测试）。**唯一遗留**：消费权限表（P4-5/§3⑥）未成单一居所——实测散点仅剩 2 处（invite-to-group:310、send-store-location:181），小任务待收口。

**代码面貌账本（全部完成后的可量化验收，用户裁定 2026-08-08：交付物是代码干净，不是文档干净）：**
`memory/facts/` 目录消失（现 19 文件 4243 行）；`high-confidence-facts.ts`（1734 行）消失；session.service 内嵌判断 -520 行；同字段解析器 22 份→8 份；city 让位 4 份→1 行策略；合并清单 3 份→1 张 Record；行政区后缀剥离 8+→1；城市归一器 3 口径→1；信封 7 套→1 通货+2 存储格式；整文件删除清单：`brand-state.reducer.ts`（P5）、`visual-description.ts`、`city-normalize.util.ts`、`fact-shape-gates.ts`、`placeholder-identity.ts`（拆两半后消失）。
**命名纪律**：新文件名用人话（`candidate/phone.ts`、`evidence/engine.ts`、`evidence/policies.ts`），不做概念展览（反例：`candidate-phone-claim-producer.util.ts`）；迁移时顺手把 `adjudication-runner` 类名字改平实。

### Phase 0 · 独立修（与重构解耦，先发免押）

全部是勘探实锤的现行缺陷，不动架构：

| # | 动作 | 性质 | 验收 |
|---|---|---|---|
| 0-1 | `parseHealthCert` 补疑问句守卫（对齐 hcf:1207 口径） | **真 bug**：疑问句→有证→booking gate | 新增分歧句用例 |
| 0-2 | `parseHeight`/`parseWeight` 补要求语境守卫（对齐 hcf:893） | 复述门槛被当自陈，user_text 权威档 | 同上 |
| 0-3 | `parseGender` 第三分支补排除档（「要招男生吗」） | 两轨相反结果 | 同上 |
| 0-4 | `brand_ids` 合并丢弃修复 + 字段清单自检扩展到 session.service 三份手抄清单 | **真 bug**：规则轨产出静默丢弃 | 自检覆盖用例 |
| 0-5 | review-packet.builder 改走 `finalizeVisualFactSheet`（删手搓解析） | 白名单/ownership/脱敏三道保证在守卫链路失效 | reviewer packet 含 ownership 断言 |
| 0-6 | `[位置分享]`/`[经纬度:]` 标记收进 message-markup.util（第 6 个标记，4 处散写正则收一）；.eslintrc geo 专属 override 补 `!@infra/utils` 例外 | 收口扫尾 | 既有 location-share 测试 |
| 0-7 | `isPlausibleCityValue` 一行别名删除，直用 `isRecognizedCityName` | 同一判据两个名字 | typecheck |
| 0-8 | memory 三服务的 `MessageParser` 依赖切 infra（`formatCurrentTime` 下沉 date.util） | memory→channels 倒挂清零 | typecheck + 全量测试 |

### Phase 1 · 立域断环（resolution/candidate + labor-form）

1. `labor-form.ts` → `resolution/labor-form/`（零 import 纯平移，12 个域外引用点改路径）。
2. 立 `resolution/candidate/`，迁入并**合一**：`tools/shared/candidate-field-parser`、`tools/shared/identity-statement.util`（含 isStudent 唯一识别器与改口状态机）、`precheck-core` 的真名问答解析器族（resolveNameAnsweredToRealNameAsk 等，claim 的 confirmation_resolver 应从 producers/ 目录构造而非 runner 内联）、`name-guard` 纯函数部分（`sanitizeInterviewName` 吃 memory 类型，留 memory）、hcf 的逐字段提取器（extractPhone/extractAge/extractGender/...）。
3. **合一即消灭 §1.3 的漂移**：每字段单一解析器，守卫取两轨并集；确需宽严两档的（name 的 2-5 vs 2-4）保留显式变体并注明消费方。⚠️ 这一步是**行为变更**不是纯搬迁——把 §1.3 表格的分歧句逐条写成用例、逐条声明采用口径，作为验收物。
4. `extractMessageText` → infra/utils/message-markup。
5. ESLint 新增：`src/memory/** 禁 import @tools/*`。环从此单向断开，编译期防复发。

### Phase 2 · evidence 立域（claim 引擎迁出 memory）

1. `memory/facts/candidate/*`（含 producers/）→ `resolution/evidence/`；observability 的 fact_adjudication 事件类型引用随迁（保持观测契约不断）。
2. tools 侧归还：`snapshot-gate.util`、`CLAIM_FIELD_TO_CHECKLIST`、`buildSessionAcceptedFacts`/`buildProfileHintFacts` → evidence。
3. `HighConfidenceValue` 包装/解包设施（ruleValue/unwrap/filter 等 9 个函数）从 1732 行的 hcf 拆到 memory/types——它们一行文本解析都不做，且是 tools/agent 六个文件 import 整个提取器模块的唯一原因。
4. CandidateSnapshotService 剩薄出口；confirmation-facts / location-share 不再为拿 `stripQuotedBlocks` 而 import 71KB 的 hcf（直连 infra）。
5. ESLint 新增：`src/tools/** 禁 import @memory/facts/*`。双向禁令齐，环封死。

### Phase 3 · 字段策略收口（city 首发上底盘，四套信封并流）

1. **city 字段立策——统一底盘的首发字段**：七条产生路径注册为 producer 清单，「让位」规则写成 evidence 的 city 策略行（现状治理层 0 居所、零迁移成本，是验证底盘能装"带工具确权字段"的最佳样本），删除四份手写判据；geocode 确权路径纳入同一条链（不再绕过形状门）；定位分享坐标改为一次逆解析、判决实例轮内共享（prep 锚点与轮末入档共用，兑现不变式④）。同步试点「存量也是主张」（§3⑦）。这是「地址是候选人信息」的落地样板。
2. district/location 补值域门；累积语义按裁决 D2 处置。
3. **城市归一器三口径合一**：geo `normalizeCityName`（只剥市）/ biz `normalizeCity`（循环剥市省，为运营手打群标签而生，badcase 2k2km06k）/ 7 处内联 `.replace(/市$/,'')` ——「黑龙江省」在三处结果不一，且 invite 城市门用 biz 版、geocode 门用 geo 版，两门比对基准分裂。唯一居所归 geo（口径裁决：剥省与否，影响拉群匹配面）；顺手解除 tools/shared → @biz/group-task 的倒挂依赖。
4. session.service 的 11 道臆造门 → evidence 的 admission chain（输入 newFacts+previous+语料，输出 facts+dropped 事件，session.service 只调用）。
5. rule×LLM 合并 → `Record<FieldKey, MergePolicy>`（见 §3③）。
6. **来源分类学互转表**：五套来源枚举的映射唯一居所（evidence），禁再出现私有互转；`toCollectedFieldProvenance` 的有损塌缩显式化。
7. 简历/自陈判据合并（按裁决 D1），`extractCandidateTexts` 与 `typedOrSelfMaterialMessages` 与 `keepSelfReportedMessages` 三份语料过滤器合一——**修掉健康证 sheet 消息被 claim 轨误拒（quote_not_found）这条现行分歧**。
8. hcf 的 FIELD_EXTRACTORS 注册表退化为 evidence 的 rule-track producer，逐字段调用 resolution/candidate 解析器。
9. **消息型 producer 前移到 prep（判决时刻表落地，§2.0）**：规则轨在 prep 跑一次产出 turn ledger 临时判决，precheck 的 HC-2 就地解析与 invite 门的 userTexts 扫描改读 ledger 退役；LLM 轨与终审仍在轮末。city 先行验证，P4 推广到全部消息型字段。

### Phase 4 · 终态归位

1. `resolveExtractionScope` 授权域矩阵并入 evidence 字段准入表（visual 只留生产归一）。
2. memory/facts 目录解散（confirmation-facts/location-share 成为 city 的 producer，visual-description 与 resolution 版合并后消失，fact-merge/fact-shape-gates 各归其位）。
3. 档案读模型收口：memory-block.formatter 的「已失效历史资料」判定（第五个迷你裁决器，裸字符串比对连 `candidateValuesEquivalent` 都不用，formatProfile:181-184）改读裁决结果——落实 evidence 方案 §13 验收 6「Prompt、precheck、booking 对同一字段读取相同裁决结果」。
4. claim shadow→enforce（业务裁决 D4，凭 shadow 观测数据，非工程步骤）。
5. 消费权限表落地（§3⑥）：哪档置信度允许哪个动作，④使用层单一文件。
6. CLAUDE.md 架构树 / memory README（已确认漏列 5 个在跑文件）/ 相关架构文档刷新。

### Phase 5 · brand 上底盘（终态无例外的兑现）

1. reducer 全部行为按 §3① 映射表写成 evidence 的 brand 策略行（复合槽值 + operation 语义 + 渠道优先序 + 语境闸）；四条输入轨（hints/规则/LLM/昵称）收敛为 producer 清单，预处理统一收在 producer 入口，兑现不变式④（一信号一判）。
2. 金测试：reducer 现有 spec 全集对新引擎回放，全绿为前置；生产 shadow_diff 双跑对照（品牌域既有成功先例），分歧归零后切换。
3. **验收物：`brand-state.reducer.ts` 物理删除** + ESLint/类型篱笆防再生。存储格式（brand_state 字段形态）不迁。
4. 本期完成后，②治理层在全字段上只剩一个引擎——三条不变式全部兑现。

### Phase 6 · 回合账本（第二 campaign：轮内协调者立名，兑现判决时刻表 P3-9）

目标：把宪法里的"轮内协调者/回合账本"从概念变成代码实体——**账本立名、契约分组、消息型前移、工具内解析退役**，四步一刀（沿用一气呵成纪律：单分支、无别名期、旧写法物理删除）。

1. **`src/types/turn.types.ts` 立名**：`TurnLedger` 类型（中立契约四方共读）；`GeocodeResolvedAnchor` / `CityAttestation` 等账本条目类型自 `tool.types.ts` 随迁，`tool.types.ts` 瘦回工具契约本身。账本实例归 agent 运行时：prep 的匿名 `turnState` 正名为 ledger，turn-finalizer 收档改 `ledger.drain()`。
2. **`ToolBuildContext` 五组化**：`session`（路由与参与者）/ `archive`（memory 供数只读视图——"事实找 memory 拿"在类型上可见）/ `turnInput`（本轮原始输入 + prep 装配物）/ `ledger`（账本句柄）/ `runtime`（探针与策略开关）。
3. **命名四规则**：①分组即作用域，`turn*` 前缀退役（`ledger.visualFactSheets`，非 `ledger.turnVisualFactSheets`）；②回调转正为写方法（六个 `on*` → `ledger.record*()` / `ledger.markJobInvalidated()`，append-only 显式化）；③条目类型随账本迁居、名字不动；④无别名期，一次改到位，typecheck 兜底。
   改名账要点：`turnVisualFactSheets→ledger.visualFactSheets`、`geocodeResolvedAnchors→ledger.geocodeAnchors`、`jobListExecutedThisTurn→ledger.jobListExecuted`、`runtimeWorkOrderId→ledger.resolvedWorkOrderId`、`highConfidenceFacts→ledger.ruleFacts`（消息型前移后它就是 prep 时刻的首批账本条目）。
4. **消息型 producer 前移 prep + 工具内解析退役**（判决时刻表兑现）：规则轨在 prep 判一次产临时判决挂 ledger；precheck/booking 的 `collected-fields` 就地解析、invite 门的 userTexts 自扫，改读共享判决实例后删除。guardrail review-packet 改从 ledger 读本轮 sheet。
5. 验收：`grep -rn "on[A-Z].*?:.*=>" src/types/turn.types.ts src/types/tool.types.ts` 无回调残留；`turnState` 匿名对象消失；`grep "turnVisualFactSheets\|jobListExecutedThisTurn"` 为空；工具内解析删除清单逐项 `git log --diff-filter=D` 可查；三大件全绿。

### Phase 7 · 通货收尾（余款 P3-8：rule-track 的 claim 化）

1. `producers/rule-track.ts`（1375 行，原 hcf 形态整体寄居）改写为逐字段 claim producer：调 `resolution/candidate` 解析器、产出带 quote 的主张，`HighConfidenceValue` 包装/解包设施（memory/types/high-confidence.ts）随之退役删除。
2. admission 输入统一为 claim 流——不变式①（一个引擎、一种通货）在全字段完全兑现；§2.3 信封终态表的最后两行"退役"落袋。
3. **排序理由（为何在 P6 之后）**：账本落地后 rule-track 的身份变成"prep 时刻的 producer"，目标形态清晰，避免改两遍。行为等价靠现有全量测试 + 分歧句用例回放守。

### Phase 8 · 信号轴归拢（登记工序立名；P6 落地后任意时点，勿与在飞 P6 同批文件并行）

1. `resolution/signal/` 立域（文件名走人话，2026-08-10 用户纠正 markup/corpus 两个行话名）：`markers.ts`（消息标记：盖章+验章）← `infra/utils/message-markup.util.ts` 整文件含写入侧——登记处有盖章权；`self-report.ts`（自陈判定）+ `dialogue.ts`（对话读取原语：取文本/问答对/应答词表）← `evidence/corpus.ts` 按消费者拆分（前者供 rule-track/admission 圈语料，后者供 *-confirmation/identity-gates 识问答对）；`visual/` ← `resolution/visual/*` 整目录平移，引用面同步改 `@resolution/signal/visual`。
2. `stripMessageDecorations`（时间+引用复合剥离）自 candidate/student-identity 并回 signal/markers。
3. ESLint 收紧：撤销 resolution→`@infra/utils` 例外（前提核查：candidate/geo 无其余 infra/utils 依赖，date.util 消费点先查清）；`infra/utils` 回归 date/string/object/fetch-timeout 四件套。
4. 依赖方向定案：signal 零出向（域内互引）；candidate/brand/geo →（解析前验章）signal；evidence → signal；memory/tools/agent/guardrail/channels → signal。
5. 文档刷新：CLAUDE.md 架构树（三道工序）、evidence/README、visual-fact-pipeline.md 路径。
6. 验收：`grep -rn "infra/utils/message-markup" src tests` 为空；`ls src/infra/utils` 只剩四件套；三大件全绿。零行为变更（纯搬迁 + 篱笆收紧）。

### Phase 9 · 域契约收口（types 约定；P8 之后，纯类型搬迁零行为）

背景（2026-08-11 用户质询"四个登记处返回结构不一样"）：resolution 导出物分三类——**原语**（串进串出，不套信封）、**登记/解析产物**（形状不必同，契约位置必须同）、**通货**（claim 唯一，不变式①）。⚠️ 反模式点名：不得以"统一返回结构"为名造万能 `SignalResult<T>` 信封——那是第八套信封复辟；统一只发生在契约位置与共享词表。

1. **每域一份 `types.ts` 约定**：被域外 import 的 interface/type 必须住本域 types 文件；函数与域内中间形状不受限；单文件域（labor-form）豁免（index 即契约）。
2. 补缺清单：`signal/types.ts`（DialogueTurn / LocationShareCoordinates / **FieldOwnership 自 visual 升入**——"归谁"是信号轴公共先验，文本归属显式化时有家可归）；`candidate/types.ts`（CandidateFieldKey / CandidateFieldProvenance / CandidateCollectedField，memory 别名转发处同步改指）；evidence 半散收口（NameGateVerdict → claim.types 或 verdicts 段、MessageExtractionScope 归 admission 对外契约）。
3. 验收：逐域 `grep` 域外 import 的类型均出自 types 文件；三大件全绿；无任何运行时行为变更。

## 5. 待裁决清单（需要产品/技术拍板，非工程问题）

> D0（治理层居所）已于 2026-08-08 讨论裁决，不在此列：**实现归 resolution/evidence，主权与编排归 memory**（§2.0）。
> **落地状态（2026-08-10）**：D1/D2/D3 已随第一 campaign 按建议口径落地——D1 sheet 优先 + 文本兜底；D2 去重累积、候选人明确「不限」才清；D3 LLM 裸 city 降为 medium（invite 门/群资源块放行面收紧）。仍待拍：D4（shadow→enforce）、D5（enrichment 性别）、D6（visual 零读者 key）、D7（县级市开关）、D8（turn-finalizer 消费承诺——将由 P6 回合账本直接兑现）。

**已结（4/8，勿再讨论）：**

| # | 结论 | 落地凭据 |
|---|---|---|
| D1 | ✅ sheet 优先 + 文本兜底 | 第一 campaign 落地（signal/self-report） |
| D2 | ✅ 去重累积、候选人明确「不限」才清 | 第一 campaign 落地 |
| D3 | ✅ LLM 裸 city 降为 medium（放行面收紧） | 第一 campaign 落地 |
| D8 | ✅ 由 P6 结构性兑现——`generator.agent.ts:355` `ctx.ledger.drain()` 即当年承诺的收尾消费 | P6 回合账本 |

**8-11 全部拍毕（后四项裁决记录）：**

| # | 裁决 | 执行去向 |
|---|---|---|
| D4 | ✅ 发版后 shadow **重新**积累（旧数据跨大版本作废：name 逃生口扩 4 条、rule-track claim 化已改变拒因分布），观察 ≥7 天、该拒率达标后翻 `CANDIDATE_FACT_ADJUDICATION_MODE=enforce` | 发版后围观流程，用户终审翻开关 |
| D5 | ✅ 入档，认 `gender_source='system'` 语义；候选人自陈永远可覆盖 system 值 | 收尾-5 |
| D6 | ✅ 砍死键、A2/B2 承诺解绑另行立项；执行修正：**砍 7 留 8**——publisher/store 是保护 brand 的分流槽（砍除即发布方劫持回归），零读者也保留 | 收尾-6 |
| D7 | ✅ 先测后开：对照 spec 产出开/关两态差异表，凭差异表终审「默认开启并删开关」 | 收尾-7（不翻开关，只出报告） |

## 6. 非目标与接受的代价

**不做：**
- `SessionFactValue` / `brand_state` 的 Redis 落盘格式**不**迁移（三态兼容照旧）；统一发生在「进出档案的裁决通货」层，存储格式与引擎解耦。
- long-term 沉淀链路与 Supabase 表结构不动。两条独立债 2026-08-11 讨论清账：`session-job-matching`（岗位指代解析寄居 memory）**清偿**——纯搬迁入 `resolution/job/`（收尾-3）；`active_booking` **改判「暂住，带迁居触发条件」**（收尾-4）——先清死字段（四个 @deprecated 字段零业务读者：接口 + store 归一化删除，零存储迁移），再立界碑：暂住理由 = 纯指针 + 访问同构；**迁居触发条件** = 出现按工单反查候选人需求或工单状态回流立项，任一出现即迁 biz 独立表（一行一工单）；硬纪律 = 禁增业务字段。注：初判引用的「零存储迁移底线」是 campaign 范围约束而非永久法则，已修正。
- 不新增 src 根目录。

**接受的代价：**
- Phase 1 的解析器合一与 Phase 5 的 brand 上底盘都是行为变更，分别靠分歧句用例清单、金测试+shadow_diff 守，不是零风险；每字段口径选择需在 PR 里逐条可见。
- resolution 内部出现 evidence→解析工序 的单向依赖（裁决要调解析器复算），域内分层比 brand/geo 时代复杂一档。
- 勘探的消费侧扇面（precheck/booking/生成 sections/守卫/复聊逐点读哪份真相）未做成独立报告，Phase 3 动 admission chain 前需对 session.service 调用方做一次定向核对。
- 一气呵成的代价：单次发版承载全部行为变更，回归归因难度集中；靠分歧句用例 + 金测试 + 发版后围观清单（fact_adjudication/拒绝率/shadow_diff）+ 整体回滚兜底。campaign 期间需要并发会话冻结窗口。

## 7. 与两个在途专项的关系

- **候选人收资证据化**（claim 引擎）：本方案认定它就是统一底盘的前身——当年把 brand/city 摘出去的理由（"语义不同"）只在策略层成立、不在底盘层成立（§3① 映射表为证）。改居所（memory/facts/candidate → resolution/evidence），升格为全部字段的裁决内核：city（P3 首发）、rule 轨与 visual 授权域（P3/P4）、brand（P5）逐步成为它的 producer/policy。shadow→enforce 仍按原方案观测判据走（D4）。
- **图片信息识别**（visual pipeline）：生产侧（两个生产者、finalize、懒补写）零改动；消费侧的授权域与语料判定并入统一准入层，v10.40.0 的行为语义不变、居所变。附录 A 仍是字段白名单唯一权威，D6 裁决后同步刷新。

## 附录 B · 2026-08-08 域划分讨论纪要（裁决过程留档）

1. **「断环需要 evidence 出 memory」论据被修正**：环的成因是解析器住在 tools；Phase 1 迁走解析器后环即断，与 evidence 位置无关。evidence 归属由此成为纯粹的职责问题。
2. **brand/city 先例对照**成为关键证据：brand 四阶段各一居所（全库最健康）；city 解析层最干净（7 月 geo 治理）而治理层 0 居所（四份手写让位散在 session.service:977/1230/1523/349）——证明「字段解析 ≠ 字段治理」，做一半会让另一半在执行点野蛮生长。
3. **「可信判据留 memory」立场的演化**：起点是"memory 自带证据链故裁决归它"；经过"resolution 输出必须可信"（一度把 resolution 定义放得过大、架空 memory 之虞）→ 最终收敛为**主权/实现分离**：memory 的证据链是裁决结论的归档副本，判断本身是无运行时的纯函数库。定音句出自用户本人："resolution 域本应该就是给 memory 服务的。"
4. **「一套说辞、三个策略、分期上底盘」的初稿被用户否决**——"brand 永久豁免"式表述正是历史上产生分叉的思维（发布方剔除修两遍、简历判据两版为证），修正为三条不变式（§2.0）：一个引擎、策略是参数不是方言、每期验收=旧实现删除。
5. **快照先例**确立"判断可现场做、结论必须回档"纪律：precheck→booking 经 Redis 快照交接，即"轮内裁决经 memory 消费"的现行实现。

## 附录 C · resolution 消费域全景（P5 终态，"改完之后谁调谁"）

共 7 个消费域。改造前后**消费域名单不增不减**，改的是每个消费点"怎么拿"（四处净变化见表后注）。

| 消费域 | 调用点 | 场景 | 用的子域 | 四类归属（§2.0） |
|---|---|---|---|---|
| **memory** | session.service `extractAndSave` | 轮末事实入档：语料+LLM 产物+存量 → 裁决链 → 落档 | evidence（引擎+合并表+city 策略）、candidate（rule-track producer） | 现场判断→回档 |
| | memory-lifecycle / turn-finalizer | 轮末副作用统一出口：品牌状态迁移、工具确权城市落档 | evidence（brand/city 策略行） | 现场判断→回档 |
| | brand-state / candidate-snapshot 薄出口 | 只剩存取，语义全在 evidence | evidence | （执行点） |
| | formatters/fact-lines | 档案读模型渲染（④的唯一供数口） | labor-form/brand 展示词表 | 词表借用 |
| **agent 运行时** | preparation + tool-context.builder | **轮内判决实例的穿线者**：备注品牌 seed、定位分享锚点（一次逆解析）、turnVisualFactSheets 挂载 | brand、geo、visual | 不变式④的协调者 |
| | context sections（hard-constraints 等） | prompt 渲染：把 memory 供的事实用词表格式化 | labor-form、brand | 词表借用 |
| **tools** | precheck / booking | 轮内 claim 裁决（基线经 memory、结论回档快照）＋快照对账闸＋姓名闸 | evidence、candidate | 现场判断→回档 + 动作授权 |
| | invite-to-group + 城市门 | 拉群前城市出处判定（消费共享的 turn 判决实例） | geo、evidence（出处档） | 动作授权 |
| | geocode.tool | 地理歧义策略 + unique 确权（onCityResolved 回档） | geo | 现场判断→回档 |
| | job-list / brand-query / search | 查询构造：本轮意图 → 海绵查询参数（消费共享判决实例，不再自行重解析） | brand、geo、labor-form | 试探性使用 |
| | save-image-description.tool | **生产侧**：vision 产出 → finalize 三道登记手续 | visual | 证物登记（生产者） |
| **guardrail** | brand-name-errors / summer-worker 规则 | 出站对账：draft 回复 vs 工具结果的品牌名/用工形式核对 | brand 归一、labor-form | 词表借用 |
| | review-packet.builder | 语义评审证据包（走共享 sheet 实例，不再手搓） | visual | 共享判决实例 |
| **channels** | image-description.service（P1 兜底） | 生产侧：漏调/降级/懒补写时的 vision 描述 + finalize | visual | 证物登记（生产者） |
| | image-brand-backfill | 接管期图片的品牌补写（持锁、经引擎、回档） | brand producer | 现场判断→回档 |
| **biz** | group-task 群标签匹配 | 运营手打标签归一（借 geo 唯一归一器） | geo 归一 | 词表借用（非档案用途） |
| | user/candidate-profile-enrichment | 外部接口性别值归一 | candidate 归一器 | 词表借用 |
| **observability** | observer.interface 事件契约 | brand_state_change / fact_adjudication 事件 payload 类型 | evidence/brand 类型 | 类型借用（编译期） |

结构要点：

1. **两个协调者客户地位特殊**：memory（跨轮）与 agent 运行时（轮内）不只消费，还分发判决实例——前者归档供下游读，后者挂回合上下文供 tools/guardrail 共用；其余五域是纯下游。
2. **只有 memory 与 tools 碰裁决工序（evidence）**，其余只碰解析工序的词表与归一，一条事实也不产——"事实产品线 memory 独家经销"的体现。
3. **生产者是独立角色**：save-image-description.tool 与 image-description.service 调 visual 是给自己产的证物办登记（finalize），位于数据流上游，不是消费判断。
4. **对照现状的净变化仅四处**：biz 群标签删自造归一器改借 geo（P3）；guardrail packet 从手搓改共享实例（P0-5）；job-list 查询侧从重复解析改消费共享判决（P5）；brand/city 治理调用从散装 if 改经引擎策略行（P3/P5）。
