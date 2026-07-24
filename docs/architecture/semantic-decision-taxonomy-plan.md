# 语义判定三分法：全链路盘点与迁移方案

> 2026-07-24 | 状态：待评审
>
> 背景：BadCase 治理过程中暴露出一个系统性架构问题——大量**语义仲裁**（候选人是否确认了姓名、是否在拒绝暑假工、是否辱骂、是否想换品牌）由**正则/词表**承担。每个 badcase 修一轮词表（#684 → #715 姓名句式已是第二轮补丁），词表越长越脆，长尾永远追不完。本方案按三分法原则对全链路判定点做一次性盘点定性，并给出分档迁移计划。

## 1. 三分法原则

| 判定类型 | 特征 | 正确形态 | 理由 |
|---|---|---|---|
| **结构/格式信号** | 键值对、时间后缀、引用块、手机号、错误码、枚举 | **正则/结构解析（保持）** | 格式封闭、确定性可回归测试，LLM 反而引入不稳定 |
| **极性/意图二分类** | "是不是确认""是不是拒绝""是不是辱骂"——开放自然语言归入封闭标签集 | **受限 LLM 分类器（迁移）** | 表达方式无限、标签集封闭。注意**不用向量**：极性对嵌入距离不敏感（"我是暑假工"与"我不是暑假工"余弦极近） |
| **相似度/检索** | 语义重复、别名模糊匹配、案例聚类 | **向量匹配（引入）** | 判定本质是"距离"，不是"标签"；embedding 恰好建模距离 |

判档口诀：**答案是格式 → 正则；答案是标签 → LLM 分类器；答案是距离 → 向量。**

一条关键的不对称性补充：**误报/漏报代价不对称的点可以不迁移**。例如 critical-turn-guard 触发误报只是多注入一条提示词禁令（无害），保持宽松正则即可；而 booking 姓名闸门误拒直接造成候选人死锁转人工（badcase g4ytra23 / 6a609570），这类"判错即事故"的点才是迁移优先级最高的。

## 2. 全链路盘点

盘点范围：`agent/guardrail`（input + output rules）、`tools`（precheck / booking / job-list / invite / cancel）、`memory/facts` + `memory/services`、`resolution/brand` + `resolution/geo`、`channels/wecom/message`、`agent/reengagement`、`agent/generator/preparation-utils`。

处置标记：**保持** = 正则/结构正确形态；**收缩** = 保留高置信核心句式，长尾交语义档；**迁仲裁** = 争议路径引入受限 LLM 分类器；**向量** = 引入 embedding 相似度。

### 2.1 结构/格式信号（保持正则，✅ 形态正确）

| 判定点 | 位置 | 说明 |
|---|---|---|
| 手机号/年龄/身高/体重/学历/中文数字解析 | `memory/facts/high-confidence-facts.ts` | 格式封闭 |
| 结构化姓名 `姓名：X` / 键值表单 | `high-confidence-facts.ts:815`、`name-guard.ts:63` | 键值契约 |
| 引用块剥离、时间后缀注入/剥离、撤回/表情/位置消息 | `channels/wecom/message/message-parser.util.ts`、`name-guard.ts:27` | 渠道格式契约（7-15 时间后缀击穿教训：**所有整句锚定判定前必须先剥该后缀**，已固化为规范） |
| 品牌ID契约行 `品牌ID：N`、目录索引构建、NFKC 归一 | `resolution/brand/brand-matcher.ts:57`、`catalog-index.ts`、`brand-normalize.ts:65` | 格式契约 |
| 地理白名单扫描全家族（最长优先、区→城反推、县级市→地级市、显式"XX市"表） | `resolution/geo/*` | 封闭白名单，是本仓库确定性设计的正面样板 |
| 占位手机号/示例姓名清单（张三/138xxxx8000） | `memory/facts/placeholder-identity.ts` | 封闭清单，抽取示例回声闸门 |
| 面试时间窗口数学、错误码解析、THINK 标签剥离 | `tools/duliday/*`、守卫 sanitizer | 结构计算 |
| 消息过滤规则（isSelf/来源枚举/黑名单/群聊/空内容） | `channels/wecom/message/application/filter-rules` | 枚举判定 |
| 复聊锚点的工具结果判定（booking/cancel/invite 成功、terminal 态） | `reengagement/anchor.service.ts:240-268`、`scenario-registry.ts` stopUnless | 结构化工具结果，不碰自然语言 |
| 转人工精确词（"转人工"/"转接人工"+短语紧凑判定） | `guardrail/input/risk-intercept.service.ts` | 封闭词表快轨（开放变体见 2.2） |
| labor-form 枚举归属/层级匹配（matchesLaborForm） | `memory/facts/labor-form.ts:33-134` | 封闭枚举 |
| fact-merge 值相等/采纳判定 | `memory/facts/fact-merge.util.ts` | 结构 |

**结论：这一类占盘点总量约一半，全部保持现状。** 三分法不是"正则都不对"，而是让正则只干正则该干的事。

### 2.2 极性/意图二分类（当前正则越权，迁受限 LLM 仲裁档）

按事故密度与不可逆性排优先级：

| 优先级 | 判定点 | 位置 | 当前形态与问题 | 处置 |
|---|---|---|---|---|
| **P1** | **姓名确认解锁**（"是不是在确认这个名字"） | `tools/shared/precheck-core.ts`：`AFFIRMATIVE_ANSWER_RE`、问句尾缀白名单、`isNameProvidedAfterAsk` | 两轮词表补丁（#684/#715）仍靠"对吧/吗/本名"穷举；漏一个句式=候选人死锁转人工（g4ytra23、6a609570）。不可逆 booking 路径。 | **迁仲裁（试点）**：正则维持快轨，闸门即将 reject 时调仲裁器复核，见 §3.2 |
| **P1** | **用工形式意向三态**（set/clear/ignore） | `memory/facts/labor-form.ts:165-330`：14 个正则常量互相打架（不确定/招聘限制疑问/经历叙述/长期否定/前后置否定窗口） | 单文件 badcase 密度全仓最高（6a334d26/6a61c97c/6a61d124…），每例加一个豁免正则 | **迁仲裁（第二批）**：整句 → `{set(x)\|clear\|ignore}` 单分类器替换全部意图正则；枚举归属词表保留 |
| **P2** | 品牌极性否定窗口 | `resolution/brand/polarity-rules.ts:67-101`：前置/后置否定、"还招人吗"豁免、指示代词排斥 | 窗口字符数硬编码，跨小句否定漏判 | **迁仲裁**：品牌命中（保持正则）后的极性归类（positive/negative/browse_all）交分类器 |
| **P2** | 输入层辱骂/投诉/风险识别 | `guardrail/input/risk-intercept.service.ts` 词表 | 开放脏话变体、谐音、方言追不完（Aron 案） | **迁仲裁**：精确词快轨保留，词表未命中但可疑（短句+情绪信号）走分类器 |
| **P2** | 转人工开放变体 | 同上 `HUMAN_HANDOFF_SHORT_KEYWORDS` | "叫个真人来""能不能人和我说"类漏判 | 同上：快轨+仲裁兜底 |
| **P2** | 出站守卫语义重规则**收缩** | `guardrail/output/rules/`：discrimination-leaks（11+ 分支）、identity-fraud-coaching、insurance-policy-claims、store-status-speculation、summer-worker-alternative-upsell、handoff-promises、false-promises | 硬规则层被迫承担语义审查，分支持续膨胀；而**第二档 LLM 语义评审已存在**（shadow 已开、精度~80%） | **不新建仲裁器**：收缩硬规则到高置信核心句式，长尾语义显式划给 llm-reviewer，补齐其评审清单（含 B-1 disease A 的 settlement 口径核对） |
| **P3** | 复聊触达 gating 的回复语义判定 | `reengagement/anchor.service.ts:277-375`：presentedStore/asksForLocation/asksForCollectionDetails | 正则判"上一条回复是否在索要定位/收资"，误判=骚扰触达（复聊语义审计 0721 错误率~31%） | **迁仲裁**：离线调度路径，无延迟压力，最适合 LLM 化 |
| **P3** | 岗位焦点意图（hasFocusIntent/换一批） | `memory/services/session-job-matching.ts:165-171` | 词表 | 迁仲裁（低量） |
| P3 | 高置信提取器中"要求 vs 自述"歧义（age/gender/student/health_cert 五态/schedule 硬约束） | `high-confidence-facts.ts:921-1274` | 规则轨是快轨，本就有 LLM 抽取轨兜底 | **收缩**：规则轨退守结构化/无歧义形态，歧义句式让位 LLM 抽取轨（不新建仲裁器） |
| P3 | 品牌昵称/时间语境/自介假阳排除族 | `brand-matcher.ts:243-323` | 每类假阳一个排除正则 | 暂保持（误报已可控），品牌命中量大、仲裁成本高；观察脏别名门槛（PR #577）效果后再议 |

**明确不迁**（误报代价不对称，正则宽松即可）：`generator/preparation-utils/critical-turn-guard.rules.ts` 全部 8 条——误触发仅多注入一条禁令提示，保持正则并放宽召回。

### 2.3 相似度/检索（引入向量）

| 场景 | 现状 | 处置 |
|---|---|---|
| **语义复读检测** | `repeated-reply.rule.ts` bigram≥0.9 只抓逐字复读；catalog 明示残留"语义相同但措辞重写的重复检测不到"（B7/C9 治理只掐死了逐字层） | **向量试点**：出站回复 embedding 与近 N 条已发回复算余弦，≥阈值 → observe 落档，累积样本后定 enforce 档位 |
| 品牌同音/模糊回指 | `resolution/brand/fuzzy-recall.ts` 拼音重叠 0.7+汉字 0.3 | 拼音本质就是为中文同音设计的相似度，**保持**；embedding 作为 P3 增强实验（AB 对比拼音基线） |
| 岗位回指打分 | `session-job-matching.ts` includes 计分制 | P3：门店/岗位名 embedding 检索替换计分制（badcase 密度低，不急） |
| BadCase 聚类与回归检索 | 人工按池分层（本次治理是手工聚类 3300+ 条） | **离线向量化**：badcase 描述+对话摘要入 pgvector，新告警自动召回相似历史案例与既有修复，替代逐条人工归类 |
| 测试资产去重 | curated 集人工挑选 | 同上顺带解决（同簇资产合并） |

## 3. 目标架构：三档判定体系

```
                    ┌─ 第1档 正则/结构（同步，<1ms）
候选人文本/出站文本 ─┤     命中高置信快轨 → 直接判定
                    ├─ 第2档 受限 LLM 仲裁器（同步，仅争议路径，~1-2s）
                    │     快轨无法裁决/即将做高代价动作 → 分类器复核
                    └─ 第3档 向量相似度（同步检索或离线）
                          复读检测 / 案例召回 / 别名增强
```

### 3.1 第 2 档：受限 LLM 仲裁器的硬约束

仲裁器不是"再调一次大模型随便问"。每个仲裁器必须满足：

1. **封闭输出**：只准输出枚举标签（如 `confirmed | denied | unrelated`），走 structured output / tool-call 强制 schema；输出解析失败 = 降级。
2. **最小输入窗口**：只喂判定所需的最近 2-4 条消息 + 一句待判定问题，不喂全量上下文（省成本、防注入、稳输出）。
3. **确定性降级**：超时（建议 2s 硬上限）/异常/解析失败时回落到当前正则判定结果——**永不比现状差**。
4. **只在争议路径调用**：快轨能判的不进仲裁。以姓名闸门为例：正则放行 → 直接放行（零增量成本）；正则要 reject → 才调仲裁器复核。增量调用量 = 现状的拦截量，天然可控。
5. **模型路由**：走 `providers` 现有角色路由，新增 `AGENT_ARBITER_MODEL` 角色（小快模型，如 Haiku 档），Dashboard 可换（复用 PR #616 全角色运行时可配置机制）。
6. **不可逆路径规则**：仲裁器只能把"拒绝"翻成"放行"或反向——**不允许仲裁器直接触发不可逆动作**；booking 提交仍需闸门链全绿。
7. **全量观测**：每次仲裁落 `agent_execution_events`（eventType=`semantic_arbiter`，payload 含输入窗口摘要、标签、耗时、与正则判定的 diff），与 traceId join。shadow 期只记 diff 不改判。

### 3.2 试点：姓名确认仲裁器（P1，1 周）

选它试点的理由：事故最痛（死锁转人工）、路径最窄（只在 name gate 即将 reject 时触发）、标签最简单（三分类）、降级最安全（维持现状拒绝）、且 #715 已宣布是**最后一轮词表补丁**。

```
evaluateBookingNameGate 即将 reject
  → 取最近 4 条消息 + 待确认姓名
  → 仲裁器：candidate 是否已确认 "X" 为其真实姓名？
     confirmed → 放行（覆盖 reject）
     denied / unrelated → 维持 reject
  → shadow 1 周（只落 diff 不改判）→ 复盘 diff → enforce
```

enforce 后：`AFFIRMATIVE_ANSWER_RE`、问句尾缀白名单、`isNameProvidedAfterAsk` 冻结不再扩表（保留作快轨），新句式一律由仲裁器接住。`countRealNameAsks ≥2 → handoff` 保底逻辑不变。

### 3.3 第二批仲裁器（P2，2-3 周）

按 §2.2 表格顺序推进：labor-form 意向三态 → 品牌极性 → 输入层风险/转人工兜底 → 复聊 anchor 判定。每个仲裁器独立 shadow→enforce，模板复用试点的降级/观测骨架（抽象成 `SemanticArbiterService` 基座：schema 校验 + 超时降级 + 事件落库）。

同期做**收缩**项：出站硬规则语义分支划给 llm-reviewer（更新其评审清单与 reason_code），高置信提取器歧义句式让位 LLM 抽取轨。

### 3.4 向量档落地（P2 起步，P3 扩展）

1. **基建**：Supabase 开 pgvector 扩展；`providers` 注册 embedding 角色（`AGENT_EMBED_MODEL`）；新表 `text_embeddings(scope, ref_id, content_hash, vector)`。
2. **首个场景：语义复读**（observe-only）——出站前查近 N 条已发回复余弦相似度，落 `repeated_reply_semantic` observe 档；用 C9 治理的存量数据回放定阈值。
3. **第二场景：badcase 相似案例召回**（离线）——飞书池新告警入库时自动附"相似历史案例 + 关联修复 PR"，直接服务治理流程。
4. P3 实验：品牌 embedding vs 拼音基线 AB、岗位回指检索。

## 4. 治理规则（长期有效）

1. **词表冻结原则**：凡已被仲裁器覆盖的判定点，对应词表/正则**冻结**——新 badcase 不再加词表分支，先看仲裁器 diff 档案，模型判错就改仲裁器提示词/换模型档。防止两套机制同时膨胀。
2. **新判定点准入评审**：新增任何文本判定前先过三分法（答案是格式/标签/距离？）+ 代价不对称分析（误报和漏报哪个是事故？）。评审记录写在 PR 描述里。
3. **不可逆路径确定性优先**：booking 提交、取消工单、拉群、暂停托管的最终闸门必须有确定性层，LLM 只能出现在"复核放行"位，不能出现在"独立放权"位。
4. **回归资产**：每个仲裁器上线时把其替换掉的词表命中样本转成 test-suite curated 集（本次 T1/T2 的 22 条资产是基线），shadow diff 中的翻案样本持续补入。
5. **成本闸**：仲裁器调用量/耗时进 Dashboard 观测；单会话仲裁调用设上限（建议 3 次/回合），超限走降级。

## 5. 度量与验收

| 指标 | 基线 | 目标 |
|---|---|---|
| 姓名死锁类 badcase（同题追问≥2 后转人工） | 16 chat 受影响簇 + 6a609570 | 试点 enforce 后 2 周清零 |
| labor-form 意向误判 badcase | 7 月已知 4 例 | 第二批 enforce 后月增 0 |
| 仲裁器 shadow 一致率（与正则判定） | — | 记录用于定 enforce 时点；翻案样本 100% 人工复核 |
| 仲裁 p95 延迟 / 单回合调用数 | — | <2s / ≤3 |
| 语义复读 observe 命中 | bigram 档 day1 = 0（逐字层已掐死） | 累积 2 周样本后评估 enforce |
| 词表膨胀速率 | #684→#715 两轮/两周 | 冻结点位词表零增长 |

## 6. 与既有工作的关系

- **不推翻**出站守卫三档架构（hard-rules → llm-reviewer → sanitizer）——它本来就是三分法的雏形，问题只是第 1 档越权膨胀；本方案是把同样的分档纪律推广到输入侧、记忆侧、工具闸门侧。
- **不推翻**品牌解析零 LLM 设计——品牌**命中**是格式/检索问题（正则+拼音正确），只有**极性**是二分类（迁仲裁）。
- #715 合并后即为姓名词表冻结点；试点仲裁器在其上叠加。
