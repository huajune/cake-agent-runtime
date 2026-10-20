# Jev（TypeSafe System One 决策模型）能否用于 Cake Agent Runtime 的可行性调研

> 调研日期 2026-10-08。本文只做文献/合同/仓库研究与设计评审，**未实际调用 Jev API（无 key）**；
> 本项目量级取自生产 7 天窗口（取数日 2026-09-24），外部事实全部带来源，见文末 Sources。
> 证据等级标注：**官方** = TypeSafe 官方文档/法律文本；**独立实测** = 第三方可复现仓库/论文；**传闻** = 单一博客/社区说法；**推断** = 本文据前述事实推演。

---

## 1. 执行摘要（1 分钟版）

**结论：现在不接入 Jev，任何候选都不进生产（含 shadow）。**

| 问题 | 答案 |
| --- | --- |
| 能不能用 | **技术上能接（裸 HTTP 20 行），架构上没有合法落位。** 10 条候选经三路对抗审查（裁定 / 能力 / 价值）全部驳回，0 条通过、0 条有条件通过。 |
| 用在哪 | **哪也不用。** 投递热路径被 [M-rt-1]/[T-4]/[T-6] 字面封死；异步与离线环虽不被封，但每一处都有"复用现有 LLM 调用"的零新供应商替代，Jev 的增量为零。 |
| 先做什么 | 做候选评审时顺带发现的 **非 Jev 修法**，研究建议清单在 §7.5（§4.2 的"正解"列是它的摘要）。例如：删复聊 `decision` 冗余字段、动态禁令 location/salary 改靶、沉淀摘要改 `generateStructured` + `z.enum`、群通知渲染结构化字段并落库、`request_handoff` 描述相邻码边界。这些是研究时的粗估，未立项或承诺排期。 |
| 别做什么 | 别建 Jev 客户端、别升 `ai` 包只为 `experimental_decide`、别签境外处理者、别为 Jev 建标注流程、别建"Jev 与 LLM 并跑对账"（撞 [T-2]⑤/[T-6] 明文禁 shadow diff）。 |
| 什么时候重议 | 同时满足：① 某决策点有 **现查可得的 badcase 量级**（不是防御式痛点）；② 该点确认 **无法搭现有 extract_facts / 主 Agent 顺风车**；③ 法务对候选人文本出境出具书面口径；④ 用自有中文样本证明 Jev 比已接入的 qwen-flash/deepseek-v4-flash 结构化输出 **显著更准**（≥5pp，配对检验）。四条缺一不重议；是否满足由用户按 [M-tax] 快环豁免评审裁定，结论入 `docs/principles/bitter-lessons.md`（见 §5.1）。 |

**三句话讲清为什么**

1. **架构层面**：本仓库的"语义判定三分法"（[T-1]）只有三格——格式就解析、标签就复用现有 LLM、距离才检索。Jev 产出的是标签，而标签格的正解被明文钉死为"搭现有抽取调用"（[T-2]），且"不再建设 shadow diff、第二模型仲裁或并行语义评分链"。Jev 要进来必须先改这张表，这是架构级裁定，不是实现选择。
2. **能力层面**：Jev 官方自认的弱点（字面解读、不算数、日期当文本、多跳弱、对注入不鲁棒、CJK 不如英文）恰好覆盖本项目候选决策点的核心难点——中文否定/婉拒、"此后未再确认"的缺席推定、面试时间先后、候选人原话即对抗面。独立实测给出的中文数字都是几十到几百条的小样本（推理型任务 0.60–0.68 来自 n=55 / n=34 的单人标注子集、XNLI −11.2pp、礼貌权威式注入带偏 65%、86% 置信度饱和为 1.00），只能支持"方向不利"，不能支持精确差值；但方向与本项目难点一致。
3. **价值层面**：在本项目量级（约 1,318 回合/天）下 Jev 与 qwen-flash 单次成本都是厘级（¥0.0007 vs ¥0.0005），**成本从不是变量**；真正的账是 2–5 人日工程 + 数百条双人标注 + PIPL 出境法务 + 一个"限额两周内 tokens/s 收紧 2.5× 且可不经通知再变、无 SLA、责任上限 $50"的新境外处理者，去换一个每条候选都能用一行代码或一次现有调用替代的信号。

**合规一句话**：候选人对话送 TypeSafe = 个人信息出境到美国托管处理者，其 DPA 只有 EU SCC/UK Addendum、无 PIPL 机制、默认保留期无天数、ZDR 仅企业经销售（官方）。未取得法务书面口径前，**连离线重放生产原文都不允许**。

---
## 2. Jev 是什么，以及它的硬约束

**一句话解释**：Jev 是 TypeSafe AI 的"非生成式决策模型"——你给它一段文本（`state`）和若干封闭问题，它一次前向计算并行回答全部问题，只返回概率分布，不写一个字。三种问题原语：`choice`（≤255 选一，带 `confidence`）、`score`（2–10 级有序打分）、`noul`（0–1 的"是"概率，无独立置信度）。它像一个"只会勾选、不会写字"的分类器，卖点是快（有源实测：CJ-Bench 284ms、judgekit 中文 ~890ms、Gateway 370ms；网传"官方 70–500ms"的来源页本次未复现，按传闻处理）、便宜（只计输入）、输出永远合法。

### 2.1 契约与限额（证据等级：官方，2026-10-08 读取）

| 项 | 值 | 对本项目的含义 |
| --- | --- | --- |
| 端点 | `POST https://api.typesafe.ai/v1/systemone`，Bearer 鉴权；仅 JSON，无流式 | 20 行 fetch 即可接；与 `ai@7.0.37` 零耦合 |
| 模型 | `jev-1.13.0`（`jev-latest`/`jev-preview` 同指向）；"9/24 后无新版"来自 jevreport.com 与搜索摘要（**独立/搜索摘要**，未直接抓官方 changelog） | 阈值标定后应 pin 版本号，不用别名；接入前用 `GET /v1/models` 实测 |
| 上下文 | 64k/请求；**32k = state + 最长问题**；state 可为纯文本 / JSON 对象 / 文本数组，不支持图片音频 | 本项目回合均值 81k token、p50 51k，**整段对话装不下**，只能送裁剪后的切片 |
| 价格 | $0.042 / 百万输入 token，输出免费 | 1,318 回合/天 × 2k state ≈ $3/月；成本不是变量 |
| Token 计数 | **无 tokenizer / 计数端点**，只能事后读响应 `usage.input_tokens` | 这是"汉字/token 比零证据"的根因；容量与成本结论必须先实测 |
| 速率 | 100K tok/s、80 rps，"动态调整、可不经通知变更"；09-24 页面为 250K tok/s、1,200 rpm | tokens/s 两周内收紧 2.5×；请求数口径从 rpm 换成 rps（1,200 rpm = 20 rps vs 80 rps），**不可比**；本项目峰值 <0.05 rps 不触限，但回放评测要限速 |
| 错误 | 文档 401/422/429/**529 Overloaded**；429/529 官方建议指数退避；**实测无 key 返回 403**（独立实测） | 异常映射别只认 401；529 要与 429 同档退避 |
| 组合置信度 | 多问组合时 `confidence` = 本次调用里**最不确定的一问**，不是各问概率乘积 | 代码合成多问结果时不要再乘一次 |
| 确定性 | 无 seed / temperature 参数，官方不承诺同输入同输出；独立实测同输入 50 次 15 种答案集（argmax 基本稳定） | 阈值附近 ±0.02 要复测抖动；不能当"可复算信号"（[G-1]） |
| 语言 | 英文为主训练语言；"CJK handled but not equally well" | 中文是官方自认短板 |
| 置信度 | choice：`(p_max − 1/n)/(1 − 1/n)`，是分布形状函数不是独立信号；noul 无字段；官方阈值 <0.5~0.6 转人工、>0.85~0.9 自动"仅供参考，须自标定" | 本项目任何阈值都要在自有标注集上重画曲线 |
| SDK | `@typesafe-ai/sdk@0.6.0`（Node≥20，默认 10s 超时、2 次重试 408/429/5xx、退避 500→5000ms，自定义 fetch 可挂代理） | 不要与 `providers/reliable` 重试叠加 |
| AI SDK 路径 | `@ai-sdk/typesafe-ai@3.0.16` 需 `ai ≥7.0.103`（`experimental_evaluate` 首发；7.0.128 改名 `decide`）；本项目 `ai@7.0.37` 已验证 dist 无此函数 | 走此路径必须升 `ai`，并回归 `llm-executor` 的 stopWhen/prepareStep 续接（该处有既有回归测试约束，见 `tests/llm/`） |

### 2.2 官方自认弱点（jev-1.13 jaggedness 页，官方）与本项目对应风险

| 弱点 | 官方规避法 | 独立实测补充 | 本项目落点 |
| --- | --- | --- | --- |
| 字面解读、否定/限定词按字面 | 把精确条件写进 criteria | 否定句翻转 +87%（news-bench） | "不是不想做早班""日结的暂时没排到哈"是常态 |
| 不会算术/计数/数值比较 | 算好再传、传命名桶 | 3-SAT 全答 satisfiable | 年龄、时薪、距离、班次时长一律代码算 |
| 日期当文本 | 代码离散成文字标签 | 无中文专项测试 | 面试时间先后、"此后未再确认"不能交给它 |
| 多跳/双重否定弱 | 指令直接、按名引用字段 | JEV-as-a-Judge：逻辑类明显弱 | "取消→此后未再确认"是两跳 |
| 无关上下文降准（context rot） | 代码先过滤 | 韩文整篇 62% vs 逐句 100%；40 行/请求破坏单行闸 | 12 题共用 5k state 是反模式 |
| 对注入不鲁棒 | "写清 criteria、上线前充分测试"（无结构性防护） | 礼貌权威式注入带偏 65%；伪"已预批"拦截 0.76→0.48 | 候选人原话与 Agent 自产岗位卡都是对抗面 |
| 选项顺序敏感、偏好首项 | 换序复核 | 价值判断类 +0.37；中文路由换序翻转 1.9–2.9%（README）vs 28%（转述，冲突） | 每个 choice 要双向跑 |
| 不能生成 | 抽取改为对候选项的 choice | — | 不产 quote，过不了 [P9]/[P11] 出处门 |

**官方没说、独立实测补的三条**（独立实测，多源一致）：① 置信度域内饱和——86% 可答项 confidence 恰为 1.00，conf≥0.95 仍放进 47% 不可答项，强制不确定项只承认 49.7%；② 概率非严格确定——同输入 50 次得 15 种答案集（std 0.001–0.015），但 argmax 基本稳定；③ 稀有阳性系统性偏 yes——civil_comments 审计 ECE 0.16–0.21，Platt 缩放可修但需 ≥100 条自有标注。

### 2.3 中文证据现状（独立实测，样本都小）

| 来源 | 任务 | 数字 |
| --- | --- | --- |
| zh-decision-bench（378 条，单人标注；业务子集 n=15–34） | 语音指令路由 / 客服路由 / 紧急度 / 升级判定 | 0.960 / 0.882 / 0.676（n=34）/ 0.600（n=55）；ECE 0.035–0.164；置信区间很宽 |
| judgekit（130 条） | 工单路由+情感+垃圾+紧急度 | 97.7%（09-20）或 96.2%（vev 09-23），两处口径不一 |
| Chinese-Jev 论文 CJ-Bench | 中文通用 | 闭源 Jev 68.35%、ECE 11.45% |
| jev-cyrillic-audit 15 语全景 | XNLI | 中文较英文 −11.2pp、ECE +0.075；MASSIVE 意图 −1.5pp 不显著 |
| awesome-jev-zh 维护者 15 工单（传闻） | 部门+紧急度 | 14/15；12/15 置信度 1.00 |

读法：**简单意图路由可到 0.9+，有序评分与需要推理的判断掉到 0.6–0.68，置信度在中文上更饱和、更不可靠**。没有任何招聘/用工领域的中文评测；没有任何人公布过汉字/token 比、32k 长状态衰减曲线、中文注入测试。

### 2.4 合规与可得性（官方法律文本 + 独立）

| 项 | 事实 | 等级 |
| --- | --- | --- |
| 托管 | Privacy Policy："The Services are hosted in the United States"；无区域选择 | 官方 |
| 训练 | 不用 Input 训练/微调；但 MCA §4.3 允许从客户数据派生 Telemetry 用于产品改进 | 官方 |
| 保留期 | "as long as reasonably necessary"，**无天数**；终止后可随时删除也可留在备份 | 官方 |
| 出境机制 | DPA 只有 EU SCC Module 2 + UK IDTA；**无 PIPL/中国标准合同** | 官方 |
| ZDR | 仅企业客户经 sales@，门槛未公开 | 官方 |
| SLA/责任 | AS IS，无 uptime SLA；责任上限 12 个月费用或 $50 取大；加州法 | 官方 |
| AUP | 不限制招聘/高风险自动决策，也不承诺任何配合 | 官方 |
| 稳定性 | 09-20~28 九天内 4 起 API 事故（09-21 间歇不可用、09-23/24 延迟升高、09-28 流量劣化）+ 1 起控制台不可用（09-20~29，不影响 API）；10 月无；第三方 uptime 99.829% | 官方/独立 |
| 可得性 | 09-22 暂停注册 → 09-27/28 重开但新用户无免费额度；自助支付方式官方零公开 | 独立 |
| 大陆直连 | **零公开实测**；仅一条未引源的"未向大陆开放"说法；国内中转站不承载 | 传闻 |
| PIPL 落点 | 候选人姓名/手机号/住址出境需机制 + 单独同意 + PIA；年内 <10 万人非敏感可豁免三程序但仍需告知与同意（一般性法律常识，非法律意见） | 推断 |

子处理商名单、SOC 2 报告内容、默认保留天数、ZDR 条款：**本次均未能从公开材料核实**。

### 2.5 生态里别人怎么用（独立实测为主，单一项目口径）

生态共识是 **Jev 只做"判"，生成与业务规则留在代码/LLM**。与本项目有关的五条：

1. **拆原子问、代码合成**：jev-phishing-bench 单一复合问 62.6%，拆成 5 个原子 noul 并在 1,000 封上拟合权重后另 1,000 封达 95.0%；但最强单信号 89.4% 仍低于一条正则 91.8%。读法：Jev 擅长信号分解，不擅长复合判断——而本项目候选的核心问题（"取消且此后未再确认""先拒 A 再要 B"）都是复合问。
2. **置信度必须自标定**：civil_comments 审计（8,000 次）原生概率系统性偏 yes、ECE 0.16–0.21，Platt 缩放需 ≥100 条自有标注；jevcal 把阈值写 lock 文件、Jev 升版即 CI 失败。本项目无一候选能凑够逐题 ≥100 正例（§4.4）。
3. **出站守卫有人做、无人给数**：tripwire 对 100% 流量一次 7 项检查 ~100ms，但自述"无真实准确率数据"，并要求 block precision >95% 才放到用户面前；官方 llm_guardrails cookbook 同样没有误报率。与本项目 [T-4]"Output 不调第二模型"直接冲突，且无数据可借。
4. **轮次结束判断只在语音场景有数**：veris.ai 600 次模拟通话抢话率 52%→11%，但任务通过率不变、中位回复时延 2.1s→4.6s；IM 文本 debounce 场景零公开数字。本项目 debounce 候选在 triage 阶段即丢弃（附录 A `chan:chan-debounce-turn-complete`）。
5. **中文 IM 与 HR 项目全是单机副驾、无评测**：JevBystander / jev-chat-jarvis / work-with-jev 只弹提示不发送；HR 侧全是简历端（resurface 用 choice 选"证据行 ID"规避不能生成引文），**没有候选人沟通侧**的先例。JevBystander 90 次中英题目 AB 显示中文题目不比英文差（0.945 vs 0.938）。

与本项目裁定冲突的模式：生态普遍的"shadow 先跑再 enforce"（fazer-ai #1135、tripwire）撞 [T-6] 禁 shadow diff；"Jev 审 LLM 回复"撞 [T-4]/[L2]；"低置信本身充当兜底、不设 none_of_the_above"（官方 intent-routing 示例）撞 [M-tax] 缺席推定归零。可借用的只有"证据行选择代替引文生成"（resurface）与"原子问 + 代码合成"两条，且仍受 [T-2] 顺风车优先约束。

---

## 3. 本项目既有裁定对"模型判断放哪里"的限制

本仓库过去一年积累的裁定（`docs/principles/rules-vs-semantics-design-philosophy.md`、`bitter-lessons.md`、`docs/architecture/semantic-decision-taxonomy.md`、`guardrail-quality-system.md` 与用户记忆）对"能不能再加一个判定器"有一套完整的准入程序。下表只列对 Jev 有裁决力的条目，并标注 **理由是否依赖模型类型**——如果理由是"慢/贵/生成不可控"，Jev 可能缓解；如果理由是别的，Jev 同样受约束。

**代号速查**（§3/§4 反复引用；前缀 T=语义判定三分法文档、P/D=规则与语义设计哲学、L/M=苦涩教训与元规律、G=守卫质量体系、C/CL=内容防腐与 CLAUDE.md、M-xxx=用户记忆裁定）：

| 代号 | 一句大白话 |
| --- | --- |
| T-1 / T-2 / T-2.2 | 判断分三格：格式就解析、标签就搭现有抽取调用、距离才检索；不另开同步分类调用；同一轮不许第二个判定器改写第一个的结论 |
| T-4 / G-1 / G-4 / G-2 | 出站守卫只做确定性对账，不调第二个模型；规则面由 catalog 唯一定义，新规则先观察再升档 |
| T-5 / D-3 | 报名、取消、拉群、暂停托管这类不可逆动作，最后一道门必须是确定性代码 |
| T-6 | 五条禁令：不新增输入分类 LLM、输出 reviewer、shadow 对照；不用新观测或人工标注流程替代代码边界 |
| M-rt-1 / L4 / M-rt-2 | 投递路径上不加实时模型判断（理由不是慢，是信号二手、目标函数被换、动作不可逆）；唯一例外是同参数重掷一次 |
| M-tax | 独立判定器要单独过"快环豁免评审"；"没提到就判否"这类缺席推定不采信；案卷不全时模型判断天花板低 |
| M1 / L2 / L5 / M5 / M-ledger | 再叫一个模型去审另一个模型，不提升真值；这种机制已被拆过，再建须书面论证"不是换名重建"并入台账 |
| L10 / L11 / M-regex / L12 | 不为一小类短答开第二条放行路径；不给单个字段写专用语义分类器；接口字段先问是不是枚举 |
| P2 / P6 / P7 / D-5 / D-6 | 能靠构造避免的错不靠检查；规则命中即生成层欠债；开放语言交给主模型或交互 |
| P5 / P8 / P10 / M-obs | 没人消费的信号就是死遥测；观测先行、靠数据升档；不为分析预建评估产品；观测必须落库不能只打日志 |
| P9 / P11 / P11-notary / L5 | 模型作证要附逐字引文，代码只做封闭比对，候选人本人终审；每种错法都要有便宜出口 |
| M4 / C9 / M-fallback | 新机制入场要 badcase 实证、在场要能退；替模型做判断的 harness 会随模型进步折旧 |
| C4 / C8 / CL-prompt | 同一约束只住一处；每个内容居所要有变更纪律；职责迁移必须回收 prompt 教学 |
| G-6 / G-tier / G-newform | 新守卫规则要封闭词形或结构化外生信号；修复方式由规则档位派生；新形态只加检测走现有 repair |
| CL-reeng / L8 / M-window / M-human / M-types / RE2 | 复聊是独立一次结构化调用；记忆窗口由记忆域自控；真人介入看消息来源不看语义；枚举单一收拢；"真人已发过"按来源切片 |

| 裁定 | 一句话 | 理由依赖模型类型？ | 对 Jev 的直接后果 |
| --- | --- | --- | --- |
| [T-1] 三分法口诀 | 答案是格式就解析、是标签就复用现有 LLM、是距离才检索 | 否 | 三分法里**没有"独立分类器"这一格**；Jev 进来要先改表 |
| [T-2] 封闭标签搭现有抽取调用 | 不新增同步 LLM 调用；schema 枚举 + 逐字 quote；"不再建设 shadow diff、第二模型仲裁或并行语义评分链" | 部分（延迟/成本）+ 主旨"不分叉第二条语义通道"（否） | 同步分类用法被否；`score` 原语 = "并行语义评分链"；不产 quote 过不了第 1 点 |
| [T-4]/[G-1]/[G-4] Output 边界 | Output 不调第二模型、不运行 semantic reviewer/shadow、**连 observe 规则都不准猜开放语义** | 否 | Jev 进出站守卫三个位置（首审/observe 影子/二审）全部封死 |
| [T-6] 五禁 | 不新增输入分类 LLM、输出 reviewer、shadow diff；不用新观测/人工标注流程替代代码边界 | 否 | Jev 评估最想要的"并跑对账"被禁；入站分类被禁 |
| [M-rt-1] 实时反馈循环行不通 | 快环只准确定性动作；四点理由：存量先被削减 / **增量是二手信号被原始证据封顶** / 目标函数替换 / 不可逆 | 否——四条没有一条是延迟 | Jev 读同一批证据，其判定是推导不是新观测；快只缓解延迟，而延迟不在四条里 |
| [M-tax] 三分法重设计 | 第二档=抽取顺风车非独立仲裁器；独立仲裁器"须单独过快环豁免评审"；**缺席推定型指控采信度归零**；语义 shadow 失败病根是案卷不完整 | 否 | Jev 是独立仲裁器形态；noul 的"没提到→判否"结构上不可采信；32k state 必然是不完整案卷 |
| [M1]/[L2]/[M5]/[M-ledger] | 二次模型链不提升真值只提升表面合规；LLM 审 LLM 已 shadow 长跑后整体删除；拆除记账防换名重建 | 否 | "Jev 审主模型输出"是 L2 换名；提议者必须书面论证"为什么不是 L2/L5/L10/L11 重建"，若理由只有"更快更便宜"即属换名 |
| [P11] 裁决权宪法 | 模型作证须附 quote、代码公证封闭比对、本人终审；没有第五种身份 | 否 | Jev 不能附 quote，无法"作证"；唯一合规身份是"提示便签"，而便签需要有消费者 |
| [D-3]/[P8]/[G-2] | 出站拦截三条件缺一只能 observe；新规则 observe 入场、≥2 周判例 + 精确率 ≥90% 才升档 | 否（对 Jev 友好） | 任何 Jev 判定点都得 observe 入场、按本库数据重测 |
| [M4]/[C9] | 机制入场须 badcase 实证、在场须可退；判断替代型 harness 随模型折旧必须自带退场 | 否 | Jev 判定点属判断替代型；准入清单 = badcase 实证 + 开关 + 可量化退场判据 |
| [L4] | 投递路径 LLM 实时判断延迟与可靠性均不可接受 | 部分（延迟可缓解，可靠性不可缓解） | Jev 注入不鲁棒、中文薄，"可靠性"半条仍在 |
| [L3]/[M-rt-2] | 带反馈的重写破产；同参 regenerate 是唯一例外 | 否 | Jev 不写字不会成为 rewriter；"Jev 判坏→触发 replan"是少数可能有位置的点，但须以规则 action 形式进 catalog（[G-tier]），且仍撞 T-4 |

**由此得到 Jev 在本项目的"合法空位地图"**（推断，综合上表）：

| 链路位置 | 是否有合法空位 | 封门的裁定 | 若有空位，附带条件 |
| --- | --- | --- | --- |
| 入站审查（风险/注入分类） | 无 | T-6①、D-3、T-5 | — |
| 生成前（prompt 便签、路由） | 极窄 | T-2（搭顺风车优先）、M-tax（独立仲裁器须快环豁免评审）、C9 | 便签必须有消费者；须 badcase 实证；须论证非换名 |
| 工具层闸门（precheck/booking 二审） | 无 | T-5、P11、L10、T-2.2 | — |
| 出站守卫（首审/observe/二审） | 无 | T-4、G-1、G-4、L2 | — |
| 投递路径任何实时裁决 | 无 | M-rt-1 | 唯一例外是同参 regenerate 的触发信号，且仍需进 catalog |
| 轮末异步（extract_facts、记忆沉淀） | 名义上有，实际为零 | T-2（标签挂进现有 extract_facts）、T-2.2（同轮不得第二判定器重解释） | 只剩"现有调用失败/降级"的分支，而该分支流量实测为 0 |
| 复聊异步链 | 名义上有 | CL-reeng/L8（独立轻链本就是一次结构化 LLM 调用）、T-2⑤ | 替换而非叠加；法务先行；需 badcase 实证 |
| cron/离线审计 | 有（M-tax 明列"离线环调模型"为空位） | T-1（标签复用现有 LLM）、T-6⑤（不用人工标注流程替代代码边界）、P10 | 必须比"现有 Claude scheduled task / deepseek-v4-flash 批量判"更好，否则 T-1 直接否 |

一句话：**热路径被字面封死；冷路径没被封，但冷路径上每个位置都有一个零新供应商、能附 quote 的现成替代**。这就是 10 条候选全部驳回的结构性原因，与 Jev 做得好不好关系不大。

---

## 4. 逐候选判定

### 4.1 筛选过程

扫描六个子系统（guard / gen / reeng / chan / tools / offline）共 **70 条**决策点，triage 选出 10 条（另 15 条并入入选项，45 条逐条写了丢弃理由，见 **附录 A**），覆盖同步投递（#2/#3/#4/#6）、异步（#1/#5/#8）、离线批（#7）、cron 审计（#9/#10）四类链路，并刻意放入两条"原语最贴合但正面撞裁定"的诱饵（#5/#6）。每条先由设计者写 state/questions/阈值/试点方案并自评（verdict + fit 0–10），再由三位独立审查者分别从 **裁定合规**、**Jev 能力**、**反事实价值** 对抗审查，并在仓库与生产库核实关键数字。

### 4.2 总表

| # | 决策点 | 链路 | 设计自评 | 裁定审 | 能力审 | 价值审 | 结论 | 正解（非 Jev） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 复聊发送前语义停止条件（blockReason 12 枚举） | 异步 Bull | conditional / 5 | 驳回(major) | 驳回(major) | 驳回(fatal) | **驳回** | 删 schema `decision` 冗余字段，代码由 `blockReason` 派生；观测 ≥2 周 |
| 2 | 关键轮动态硬禁令：regex 粗召回 + noul 精判 | 生成前同步 | weak / 3 | 驳回(major) | 驳回(fatal) | 驳回(fatal) | **驳回** | location/salary 规则改 `candidate_side` 或删；post_interview 改结构化外生信号 |
| 3 | 收资短答是否确认复述 / 是否改口 | 工具层同步 | weak / 3 | 驳回(fatal) | 驳回(major) | 驳回(fatal) | **驳回** | 用现成 `recap_confirmation_rejected` 事件算底账；74 次 `recap_not_required` 走 description 收口 |
| 4 | 候选人最后一条消息是否需要回复 | 生成前同步 | reject / 2 | 驳回(fatal) | 驳回(major) | 驳回(major) | **驳回** | 空产物兜底 `random=false` 或同参 regenerate 一次；复聊待答闸修 timeout 丢消息 |
| 5 | 【诱饵】轮末软事实标签：品牌极性/用工形式 | 轮末异步 | weak / 2 | 驳回(fatal) | 驳回(fatal) | 驳回(fatal) | **驳回** | 配 `AGENT_EXTRACT_FALLBACKS`；补 labor_form 规则兜底写入的落库事件 |
| 6 | 【诱饵】出站 observe 档句级极性/时态/意图 | 出站同步 | reject / 2 | 放行（设计已 reject） | 驳回(fatal) | 放行（设计已 reject） | **驳回** | 按 [P6]/[P8] 用 SQL 复盘 5 条 observe 哨兵 14 天命中，<70% 直接降档/下线 |
| 7 | 咨询段沉淀：求职 vs 非求职（+episode 边界） | 离线 Bull | weak / 3 | 驳回(fatal) | 驳回(fatal) | 驳回(fatal) | **驳回** | 摘要生成改 `generateStructured`，scope 进 `z.enum`，删 `SCOPE_LINE_PATTERN`；scope/fail-open 落库 |
| 8 | 群通知出站缺口：事实出处 noul + 敏感条款 noul | cron 异步 | conditional / 4 | 驳回(major) | 驳回(major) | 驳回(fatal) | **驳回** | 群通知只渲染结构化字段（含 `figure` 枚举）、不渲染 `remark`；生成消息落库 + 确定性数字/门店对账 |
| 9 | 转人工 reason_code 与对话事实一致性核对 | cron | weak / 4 | 驳回(major) | 驳回(major) | 驳回(major) | **驳回** | 修 `request_handoff` description 相邻码边界；周任务抽样 20→60（随机 20 + other/salary 定向 40） |
| 10 | 守卫命中档案离线判真/假阳 + 修复回归形态 | cron | weak / 4 | 驳回(major) | 驳回(major) | 驳回(fatal) | **驳回** | 同 5 问加进现有 weekly-guardrail-analysis 任务或 deepseek-v4-flash 批量脚本（可附 quote） |

**统计**：10 条全部驳回；30 张审查票中 28 张驳回、2 张"放行"只因设计稿本身已自判 reject。没有任何一条拿到"有条件通过"。表中"正解"列是摘要，完整的非 Jev 研究建议清单在 §7.5。

### 4.3 跨候选共性反驳（四条，几乎每张票都提到）

1. **Jev 不产 quote，过不了出处门**（[P9]/[P11]/[L5]）：本仓库对任何模型产出的语义标签都要求逐字引文以便代码公证；Jev 结构上只能回答"是哪一类"，不能回答"依据哪句话"。
2. **缺席推定归零**（[M-tax]）：候选里最有价值的问题（"此后未再确认""没提到→不需要回复""source 里找不到依据"）全是"state 里没出现 → 判否"，而 Jev 不识"不可答"（conf≥0.95 仍放 47% 不可答项），这类判定在本仓库裁定上采信度为零。
3. **中文精度证据薄且方向不利**：候选的核心难点集中在否定/婉拒/时态/多跳，正是中文独立实测掉档最重的象限（0.60–0.68、XNLI −11.2pp、否定翻转 +87%）；没有任何招聘领域中文评测，必须用 `guardrail_review_records` / 人工审计金标自测——而自测本身撞 [T-6]⑤。
4. **数据出境无口径**：DPA 无 PIPL 机制、保留期无天数、大陆直连未实测；法务未裁定前连离线重放生产原文都不能做（每张票的放行条件都有这一条）。

### 4.4 逐条设计要点与关键反驳

#### #1 复聊发送前语义停止条件 — 驳回

- **设计要点**：在 `follow-up.processor` 到点、确定性预检之后、`ReengagementAgent` LLM 调用之前加一次 Jev 请求；12 道 noul/choice 并行（候选人取消 / 经理取消或婉拒 / 已有结果 / 已报告面完 / 已问结果 / 当天已提醒 / 已另行确认 / 未开始 / 聊天约定时间 / 放弃入职 / 已入职 / 最新表态），代码把时间关系预离散成"面试时间之后的经理消息"等命名切片；block ≥0.85、clear ≤0.30、中间回落现状 LLM。state ≈5k token；设计稿估 ≤300 touch/天、≈$2/月（生产实测 ≈8/天，见下）。
- **代表性问题**（原文节选）：`manager_cancelled_interview`："招募经理是否已告诉候选人不用参加这一次面试——包括明确说取消、已经招满、不合适，也包括在了解候选人条件后给出否定性结论的婉拒——**并且此后招募经理没有再重新确认面试继续进行**？"
- **一句话致命伤**：痛点可以靠删一个冗余字段定义性归零，而 Jev 要替代的那两道难题（婉拒、"此后未再确认"）正是它最弱的多跳 + 缺席推定。
- **关键反驳**：
  - 价值假设被零成本修法击穿：痛点"decision/blockReason 矛盾"源于 schema 里 `decision` 冗余于 `blockReason`（`src/agent/reengagement/reengagement.agent.ts` describe 自述派生关系、`ReengagementAgent` 已按 blockReason 兜底）；删字段由代码派生即可让矛盾率定义性归零，设计 notes 自认"应先做"。
  - 量级证伪（生产库实测）：近 30 天 post_booking 到达 LLM 环节 ≈243 次（sent 207 + 语义 skip 36 ≈ 8/天），非设计估的 ≤300/天；语义 skip ≈1.2/天，且无一条 badcase 实证现状 LLM 在这 36 条上误判（[M4]/[L1] 入场须实证）。
  - 两道核心题是"最新表态→取消→此后未再确认"的多跳 + 缺席推定，正中官方弱项与 [M-tax] 归零；中文推理型判断实测 0.60–0.68，设计自认 0.60–0.68。每题独立阈值要求正例 ≥30，12 题 ≥360 正例，而 30 天语义 skip 总量 100–200，多数题正例个位数，阈值不可标定。
  - Jev 判 clear 后 LLM 纯生成失去"写文案时顺便发现停止条件"的兜底，假阴直接变误发，风险方向与目标相反。
  - 裁定：[T-2]⑤/[T-6] 禁 shadow diff，设计阶段 1"并跑 2 周只落库"字面即 shadow diff；[M-tax] 独立仲裁器须快环豁免评审；[L8]/[CL-reeng] 的理由是"独立轻链更便宜更稳"，加一次境外外呼降低"稳"。
- **若仍要重议的硬门**：先删 `decision` 字段观测 4 周给出误发绝对量；误发 ≥10 起/周且现状 LLM 不可修才重议第二判定器；法务书面放行；两道难题离线精确率 ≥0.90 且不确定带 ≤25%，否则自动放弃。

#### #2 关键轮动态硬禁令 regex 粗召回 + noul 精判 — 驳回

- **设计要点**：`PreparationService` 构造 `normalizedMessages` 后、`resolveTurnContext()` 前，仅在正则命中时发一次 Jev（6 道 noul：纹身自陈 / 性别自报 / 裸数字=年龄 / 面试后状态 / 面试日期 / 地址来自候选人），p ≤ τ_suppress 则抑制注入；硬超时 1200ms，超时按现状注入；state = 候选人侧近 12 条 ≈2.5–4k token。
- **一句话致命伤**：假阳大头已被改靶吃掉，剩下的仍是一行改靶能修的；真正交给 Jev 的残余量每天个位数，且 state 剔除了判断所需的 assistant 上一轮。
- **关键反驳**：
  - 痛点基线已失效：76%/69/52 是 0920 改靶前数字，PR#1339（0924 已在 origin/develop）把 post_interview 改 `candidate_side`、health_cert 加 `(?!健康证)`，SQL 估算 post_interview 69→5（−93%）、health_cert 52→19（−63%），合计 121→24 ≈80% 假阳消失；剩余 location 122/200、salary"工资"仍是 `combined` 靶，一行改靶即修，而方案明文"不扩不缩召回"，对它们零作用。
  - 仓库核实：tattoo/bare_number/gender/interview_date 规则 target 本就是 `current`，不读 Agent 文本；设计把"剔除 Agent 文本"当主要增量实际不成立。`bare_number` 的真判据"刚被问过年龄"依赖 assistant 上一轮，而 state 剔除 assistant 文本——Jev 不识信息不足，会给高置信假答。
  - 标定不可行：`agent_invocation` 7 天即 NULL（migration 20260706171000），"近 30 天重放"不成立；tattoo/gender 日真阳个位数。judgekit 中文 ~890ms vs 1200ms 硬超时，p95 大概率回落。
  - 裁定：[T-6]①③双命中；[C9] 已定性整个动态禁令层是替 qwen 的折旧 harness，再叠境外判定器是为折旧层续命；[C4]/[CL-prompt] 每条规则同时有 regex pattern 与 noul criteria = 同一约束两处居所。
- **若仍要重议的硬门**：先完成确定性改靶并用 mpr 实测残余语义假阳率 >20% 且每天 >100 回合；给出一个现在可查、与假阳禁令因果绑定的业务指标；tattoo/gender 先按 [T-2] 挂进 extract_facts 试过；按 [C9] 先给整个禁令层写退场指标。

#### #3 收资短答绑定（是否确认复述 / 是否改口） — 驳回

- **设计要点**：设计者已自降为 offline_only；state = 送达的复述全文 + 紧邻 assistant 组 + 候选人短答（≈600 token）+ 代码旗标 `has_pending_question_outside_recap`；两道 noul（`confirms_recap`、`is_correction`）+ 一道 `reply_target` choice；若被迫在线只做 precheck 回执里的 observe 便签。
- **一句话致命伤**：生产 30 天 102 次 recap 拒绝里零条是"读错短答"，而"是否确认"的第二条判定路径正是 [L10] 已废除的形态。
- **关键反驳**：
  - 代码核实：`src/resolution/notary/recap-confirmation.ts` 明写"不判断同意/否定/礼貌语义"，`src/resolution/collection/form-writes.ts` 改口只能由模型显式声明，`src/tools/duliday-interview-precheck.tool.ts` 纠正优先；三个 pain_evidence（0819/0916/6a8d583b）均已确定性闭环，无活跃 badcase。
  - 生产库实测：近 30 天 `recap_confirmation_rejected` 共 102 次（≈3.4/天）：`recap_not_required` 74、`already_affirmed` 17、`snapshot_mismatch` 11、`correction` 0——全是结构/状态机形态，**零条是"读错好的"**。
  - 裁定：Jev noul"是否确认"正是 [L10] 废除的"为一小类短答分叉第二条生产放行路径"的 [M5] 换名重建；[T-2.2] 禁同轮第二判定器重释 correct；便签在工具调用内无消费者（[P5] 死遥测）。
  - 能力：中文肯定大量借否定词（没问题/没错/不用改），且 `src/tools/collection/recap-renderer.ts` 结束语本身含"没问题…不对…改哪项"进 state；改口常只报新值不带否定，需 recap 值 vs 新值比对 = 官方"不会比较"弱点，而代码能等值比对则 Jev 多余。
- **处置**：候选关闭；若要底账只用现成事件 + mpr `tool_calls` 复算卡顿率，不新增标注流程、不外发 PII。

#### #4 候选人最后一条消息是否需要回复 — 驳回

- **设计要点**：设计者主裁定 reject；残留形态为 runner `invokeReviewed` 之后 fire-and-forget 的 async shadow（`needs_reply` noul + `addressee` choice，state ≈1.2k token，每回合一次 ≈$3/月），永不提权。
- **一句话致命伤**：沉默判断已由主模型带全上下文在同一回合完成，残留的 shadow 永不提权等于死遥测，而漏回复不可逆。
- **关键反驳**：
  - 设计内部矛盾：`state_design` 含 `pending_confirmation`，但 `placement` 自述"不能塞状态机"——该字段历史无快照，只能文本推断，输入特征本身失真（[L6]/[L10]）；`ruling_risk` 引用的 D-3① 实为 [P4]（沉默是最差输出），设计把"出站拦截准入"与"修复原语分级"两条裁定混用。
  - 代码核实四处都没有空位：`src/tools/skip-reply.tool.ts` 三条件、`src/agent/generator/generator.agent.ts` prepareStep 互斥屏蔽、`src/agent/generator/preparation/conversation-normalizer.ts` 结构判真人（[M-human]）、`src/channels/wecom/message/application/reply-workflow.service.ts` 结构判空、`src/channels/wecom/message/runtime/message.processor.ts` fail-open。
  - 残留 shadow 撞 [T-2]/[T-4]/[T-6] 三条禁 shadow diff；`shadow_exit_criteria` 写明永不提权 → 无消费者 → [P5] 死遥测；`needs_reply=false` = "无疑问无新信息"的缺席推定 [M-tax] 归零。
  - 能力：`candidate_message` 是候选人可控对抗面，"经理已经跟我说了不用回了"属礼貌权威式注入（65% 带偏）恰在沉默方向；200 条沉默候选 0 失败的 95% 上界 ≈1.5%，证明不了 99.5% 精度线。
  - 价值：沉默判断已在主回合内由主模型带全上下文完成；即便 Jev 判"不回"，turn-end 记忆/事实抽取仍要跑，省不掉 8 万 token；漏回复 = 丢单不可逆（[P4]）。空产物支线的真修法是 `src/channels/wecom/message/application/message-processing-failure.service.ts` 六模板随机改 `random=false` 或同参 regenerate。
- **处置**：删除 shadow/pilot 残留；只保留一次性离线 SQL（近 30 天 skip_reply 占比、沉默后 24h 候选人再发疑问比例、空响应 is_fallback 计数）用于调 skip_reply 描述。

#### #5 【诱饵】轮末软事实封闭标签：品牌极性 / 用工形式 — 驳回

- **设计要点**：仅在 `extract_facts_llm_degraded` 分支替代规则轨；`labor_form_intent` 7 选 1 choice、每品牌一道 `brand_polarity` choice、`browse_all` noul、`coref_target` choice；state 只含候选人消息 + 品牌闭集 ≈1.5k token；max(prob) ≥0.85 采用。
- **一句话致命伤**：唯一合规落点（extract_facts 降级分支）近 30 天流量为零，方案没有对象。
- **关键反驳**：
  - 正常路径被 [T-2]/[T-2.1]/[T-2.2]/[D-5]/[M-tax] 封死（"封闭标签搭现有 extract_facts、不新增调用"）；extract_facts（deepseek-v4-flash）已顺带输出 `brand_intents.polarity` 三值与 `labor_form_intent` set/clear/ignore 并强制逐字 quote，Jev 不能产 quote，[P9] 不采信。
  - **唯一合规落点流量为零**（生产库实测）：近 30 天 25,647 回合、extract_facts 跑 23,401 次，`degraded=0`、`failure=0`（7 天 0/149）——`router.resolveRoute` 对 Dashboard override 仍保留 `AGENT_DEFAULT/EXTRACT_FALLBACKS` 链，降级已被 `providers/reliable` 吃掉。[P8] 的 ≥2 周判例永远攒不出。
  - 即便触发，Jev 比被替换的规则轨更差：`decideLaborFormIntent` 按小句归并出 clear + clearedValues[]，7 选 1 choice 丢掉被排除值，无法表达"不要暑假工，普通兼职就行"；无 abstain 让 ignore 兼任"无法判断"（去 abstain 后 ECE 0.793）；"假期工"需按日期判暑/寒；`coref_target` 位置指代实测 0.42。
- **处置**：方案作废；零代码替代是配 `AGENT_EXTRACT_FALLBACKS`（如 deepseek-v4-flash → qwen-flash → qwen3.7-plus），并补 labor_form 规则兜底写入的观测事件落库。
- **若仍要重议的硬门**：先用 `message_processing_records` 查近 30 天 `extract_facts_llm_degraded` 回合数——<1% 或日均 <15 回合直接作废；配好三模型降级链跑两周后降级率仍持续 >3% 才重开；重开时 choice 必须保留 `clearedValues` 语义（拆成 set 问 + 每形式一道 clear noul 由代码合成）、显式加"无法判断"选项与 ignore 分离、`coref_target` 与 `brand not_mentioned` 不得作为写入依据；按 [M-ledger] 书面论证非 L11 换名重建并过 [M-tax] 评审；法务放行出境。

#### #6 【诱饵】出站 observe 档句级极性/时态/意图分类 — 驳回

- **设计要点**：设计者自判 reject，只留"离线对照"退路：每条规则独立 state（命中单句 + 一行结构化真值，≤1.2k token），7 道问题（结算承诺类型/范围、保险句类型、推荐越界品牌、完成时态 vs 复述、候选人报名意图、隐性人机暗示）；若硬做则每日 cron 扫 ≈50–100 命中。
- **一句话致命伤**：observe 档命中不改任何投递、升档路径被 [T-4]/[G-2] 封死，所以 Jev 判得再准对任何现有指标的增量恒为零。
- **关键反驳**：
  - [T-4] 原文"Output 不调用第二个模型、不运行 semantic reviewer/shadow、不通过 observe 规则猜开放语义"把首审同步 / observe 影子 / 二审三位置字面封死；[G-1]"只对可复算信号裁决"——同 state 50 次得 15 种答案集不可复算；语义审查器 PR#1045 已删，再建即 [L2] 换名。
  - 仓库核实：catalog 24 ruleId、observe 档恰 5 条；observe 命中落 `guardrail_review_records`，7 天 179−90 ≈ 89 行 observe-only ≈13/天；runner `:290 shouldRepair` 排除 observe，**命中不改任何投递**——Jev 测准到 100% 也不会让任何现有指标动一格，升档路径被 [T-4]/[G-2] 封死。
  - 能力：7 问里 4 问正中弱项——否定语序+范围限定（仓库 `NEGATION_PREFIX/SUFFIX` 两套词表正是为"日结的暂时没排到哈"而存在）、中文无形态时态、"先拒 A 再要 B 取最后意图"是多跳+顺序；5 个哨兵 90 天 300–800 行分 7 问每问 <120，达不到 ≥300/问。
  - 价值：2000 条双标 ≈2 人日 > 90 天全部 observe 命中总量，撞 [T-6]⑤；真要测精度，已接入的 qwen-flash json_schema 即可。
- **处置**：按 [P6] 执行 `SELECT unnest(first_rule_ids), count(*) FROM guardrail_review_records WHERE created_at > now()-interval '14 days' GROUP BY 1`，对 5 条哨兵按命中数/人工假阳率决定降档或删除；隐性人机暗示缺口按 catalog `:115` 归主 Agent prompt。

#### #7 咨询段沉淀：求职 vs 非求职（+episode 边界） — 驳回

- **设计要点**：Bull memory-consolidation 队列内、摘要 LLM 调用之后，仅在 `parsed.scope===null`（fail-open）时咨询 Jev；`episode_scope` 三选 choice + `candidate_states_already_working` noul + `topic_switch_present` noul；state = 末尾 ≤120 条消息（具名主语）≈6–20k token。
- **一句话致命伤**：范围标签已由同一次抽取调用顺带产出，Jev 只能进 fail-open 分支，而该分支用 `generateStructured` + `z.enum` 一行即可归零。
- **关键反驳**：
  - 现状已是顺风车：`src/memory/long-term/consolidation.service.ts` 同一次 Extract 调用首行给范围（[T-1]/[T-2] 正解）；Jev 只能进 fail-open 分支，而 `src/llm/llm-executor.service.ts` 已有 `generateStructured`，scope 放进 `z.enum` 一行即归零该分支——Jev 边际价值 ≈0。
  - 出口不对称（[P11-notary]）：误判非求职 = 水位已推、摘要永久缺失不可逆；误判求职 = 20 段滚动淘汰可逆；阈值必须偏求职，Jev 决策空间被压没。
  - 能力：中文无显性时态，"工资几号发/社保交不交"求职前后都会问，criteria 靠"已入职后"区分 = 隐含多跳；6k 中文 ≈12–20k Jev token，超出全部公开 benchmark（≤3.7k）无衰减曲线；三选项无 abstain；episode 边界需"切换点在第几条"的位置判断，位置指代 0.42→0.15，设计自认不能驱动分段。
  - 痛点"永久占 20 段配额"无 SQL 实证：scope 现只进 logger（[M-obs] 违规），满配比例从未查过。
- **处置**：摘要生成改 `generateStructured`，scope 进 `z.enum(['job_seeking','other'])`，删 `SCOPE_LINE_PATTERN`；scope/fail-open/消息数/截断落库；episode 边界维持 7 天时间窗，从 Jev 候选移除。

#### #8 群通知出站审查缺口：事实出处 noul + 敏感条款 noul — 驳回

- **设计要点**：cron 慢环 `handlePrepare` 内两处：A）生成后逐行 `line_unsupported_claim` / `line_is_benefit_section` noul（observe，不拦）；B）`sanitizePublicText` 内按段送 Jev（`social_insurance_stance` / `student_stance` / `unpaid_or_forfeit_clause` choice，每段一请求 ≈600 token），替代 12 条敏感正则，正则永久 fallback + P≥0.15 保险带。合计 3–4 人日。
- **一句话致命伤**：敏感条款来源字段本就是封闭枚举（能不渲染 `remark` 就没有分类问题），且通道每周百余条、运营人眼 100% 预览、零事故记录——没有可测的痛点。
- **关键反驳**：
  - P2 构造侧未问第一问：`src/tools/job-list/hard-requirements.util.ts` 显示海绵 `hiringRequirement.figure` 是**封闭枚举**，`student_stance` 是对已结构化字段再分类（[L12] 字面命中）；`extractHiringRequirement` 只剩 `remark` 自由文本，"能否不渲染 remark"设计未问。
  - "不提敏感政策"已住 3 处（`src/biz/group-task/prompts/part-time-job.prompt.ts` 规则 13 + BadCase 末条 + `SENSITIVE_PUBLIC_COPY_PATTERNS` 正则），Jev criteria 成第 4 处（[C4]/[CL-prompt]）；B 写明 shadow 双跑 + 正则永久 fallback，撞 [T-6]/[T-2.2]/[P6] 规则面净增。
  - 量级与痛点（仓库核实）：兼职群 cron 仅工作日 13:30 一次、小贴士周六一次（`src/biz/group-task/services/group-task-scheduler.service.ts`），≈50–150 条/周；每条正式发送同时推飞书预览给运营（`src/biz/group-task/services/notification-sender.service.ts`），**人眼已 100% 过目**；12 条敏感正则自 PR#76 一次写就从未改过，docs/memory/台账零群通知 badcase——pain_evidence 是防御式写法，不是事故。群任务无任何落库表，设计自认"现在量不出来"。
  - 能力：A 的"source 里找不到依据"是缺席/不可答判定，Jev 最差处；一次 state 含 source + 15–25 行，对每行 noul 其余全是无关上下文。B 本质是中文极性翻转（Jev 弱项）；中文置信饱和使 0.05 步长扫 P-R 取 τ 退化为 argmax；criteria 字面只列"社保/五险一金"，商家写"不买保险""社会保险"会被字面判 unrelated；按标点切段后"期间不计薪"丢指代。
  - 岗位商业文本 shadow 期即出境到无 SLA/无 PIPL 的美国处理者。
- **处置**：先做 Jev 无关部分——群通知只渲染结构化字段、评估不渲染 remark；生成消息落库（复用 ops_events 或既有表）+ 确定性数字/门店名/薪资单位对账；跑 ≥4 周拿到真实编造/敏感泄漏基线，基线为零则候选关闭。只有现有正则召回实测 <0.85 且飞书预览历史能找到 ≥3 条实际上群的敏感短句才重开 B，且基线对照必须是已接入的 qwen-flash/`generateStructured`。

#### #9 转人工 reason_code 与对话事实一致性全量核对 — 驳回

- **设计要点**：周任务前置排序步；state = 触发前 ≤12 条对话（岗位卡替换占位符）+ 工具调用摘要 + 预约状态 ≈2k token；`blind_reason_code` 17 路 choice 双向跑 + 5 道正向 noul；分 consistent / suspect / uncertain 三桶，suspect 进人工复核队列；周 30–60 行，≤$0.06/周；1 迁移 + ~300 行 cron。
- **一句话致命伤**：审计者（Jev 中文 17 路自估 0.70–0.85）不比被审者（生产码 0.74–0.89）准，分歧行里"生产确实错"约四成，请人复核一半是白看。
- **关键反驳**：
  - 审计者精度低于被审者：设计自估 Jev 中文 17 路 0.70–0.85（zh-decision-bench 升级判定 0.600、CJ-Bench 68.35%），生产码精确率 0.74–0.89；按 0.75/0.85 独立误差算，分歧行中"生产确实错"仅 ≈0.41，低于 pass line 0.50——"请人再看一半是白看"。
  - 未核实收益：10-08 周报的 other 占比变化缺少可追溯查询和台账记录，已移除口述数字，不用于证明拆码收益或支持 go/no-go；精确率 0.89→0.74 的根因被 19 条人读直接定位为 `request_handoff` description 相邻码边界——[P6] 命中即生成层欠债。
  - 判码核心是时态：`onboarding_paperwork` / `interview_result_inquiry` / `employment_affairs` 的 `not_for` 全是"还没面试/入职"，正中"日期当文本+多跳"；20 条 `not_for` 全是否定式；`suspect` 判据 p(recorded) ≤0.20 是缺席推定。
  - 标定不可行：200 条/17 码 ≈12 条每码，"按码分组画 10 桶可靠性曲线"无统计意义；`human_handoff_request` 是系统码（enum `:297`，非 toolSelectable）却入 choice，argmax 永不等于工具记录码 → 结构性假 suspect。设计引用的"10-08 5/19=0.263"同样不在 quality-metrics-ledger；`handoff_events` 周量按生产 8 周实测为 62–275 条（70/153/170/240/275/260/121/62，中位约 160），设计估 50–100 偏低，替代方案的覆盖率算术随之失真。
  - 裁定：[M1]/[L2]/[M5] 再叫一次模型审另一次模型输出；[T-6]⑤ 200 条标注 + 新列 + 新 cron 服务一个 20 条周样本；[C4] criteria 成 30 码目录第二居所。
- **处置**：先修 `request_handoff` description 相邻码边界与 promise-reconciliation 残余 other，观测 ≥2 周；零代码替代——周任务抽样 20→60（随机 20 + other/salary_admin_inquiry 定向 40）跑 4 周；若仍要自动核对，判官用已接入的国内模型（qwen-flash/deepseek-v4-flash json_schema + 引文）在同一 cron 位实现。

#### #10 守卫命中档案离线判真/假阳 + 修复回归形态 — 驳回

- **设计要点**：离线 cron（脚本版 1–2 人日，src 版 +1 人日）读 `guardrail_review_records`，state = 规则 description + 脱敏 user_message + first_reply + revised_reply + 工具回执桶 ≈1.8k token；5 问（首版是否以客服口吻断言 / 是否转述或否认 / 修复版是否仍断言 / 修复版是否新增无依据事实 / 是否翻转有岗→无岗），代码合成 4 选 1；≈15 行/天，$0.04/月。
- **一句话致命伤**：现状审计已经是一个能读原文、能附引文的 LLM 任务，同 5 问直接并入即可；Jev 不能附引文，人读量一点不减。
- **关键反驳**：
  - [T-1] 答案是标签就复用现有 LLM：现状审计已是 Claude scheduled task 读三段原文（SKILL.md `:145-162`），extract 角色 deepseek-v4-flash 已接入；同 5 问直接并入该任务或批量脚本，成本同量级、**可附 quote**、无新出境处理者。
  - "自带金标"经核只有 57 trace 且多为已下线规则，等于没有；`guardrail_review_records` 已有死列 `semantic_reviews`（迁移 20260716），再加同形 `offline_adjudication` 列即 [L2] 换名；[L2] 病根（[M-tax] 第 8 点）是案卷不完整——本设计 state 明文剔除对话历史/档案/岗位卡，案卷比被删的 reviewer 更薄。
  - 能力：24 条规则里 14 条是工具回执/出处类（`job_fact_without_provenance` 118 命中、`settlement_cycle_mismatch` 43 等），真/假阳 = 回复事实对账工具输出的跨文档多跳，两条还要日期先后；Q1/Q3 的 criteria 是"rule.description 所描述的内容"这类指针式间接引用；目标假阳类是否定/复述语境（SKILL.md `:49`），否定翻转 +87%；300 行/12 规则 → 每规则 ~12 条 repaired 行，逐规则×问题标定不可行；90 天内 11 条规则下线 3 条新增需反复重标。
  - 价值：唯一指标"每规则精确率样本覆盖 5 条/周→100%"不是业务指标；30 天仅 438 行、全量人读按 45 秒/行每月 ~5.5 小时，而方案要 4–5 人日 + 300 行标注 + 一次迁移（迁移须与发版同步，见 CLAUDE.md）；审计任务本身已断更（accuracy 报告停 08-17），Jev 不解决断更只新增一条会断更的仪表。
- **处置**：零代码先把同 5 问加进现有 weekly-guardrail-analysis / guardrail-accuracy-audit 任务跑 2 周，证明"全量判"确实改变了某条规则的升降档决定；否则不立项。若仍要评估 Jev：仅做一次性 300 行离线盲测对照 deepseek-v4-flash（自动采信桶一致率 ≥90%、覆盖 ≥60%、不低于基线 −2pp 且稳定率更高），不建 cron、不加列、不做迁移；Q4/Q5 两版比对从 Jev 范围删除；任何模型全量计数在周报须标"先验（未人审）"，不得驱动 [P8] 升降档。

---

## 5. 重议前提满足后的最小验证路径（当前不启动）

本节与 §1 的"别做什么"不冲突：§1 的禁令是现状结论，本节只回答"如果四条重议前提（§1）将来都满足了，最省钱的验证路径长什么样"，供届时评审直接套用，**当前没有任何一步被授权启动**。核心约束：**不建 shadow diff、不进生产路径、不新建评估产品**（[T-2]⑤/[T-6]/[P10]），所以闭环只能是"离线重放 → 人工金标对照 → 过线才谈下一步"，而"下一步"仍要单独过 [M-tax] 快环豁免评审。

### 5.1 最小闭环（三步，每步有终止线）

| 步 | 做什么 | 输入 | 通过线 | 不过线 | 成本 |
| --- | --- | --- | --- | --- | --- |
| 0 前置 | 法务书面口径（PIPL 出境机制 / 单独同意 / ZDR 条款 / 保留期）；大陆生产机到 `api.typesafe.ai` 的 TCP/TLS 可达性与 1000 次 p95 | — | p95 ≤1.2s、错误率 ≤2%、法务放行 | 任何一项不过 → 全部终止 | 0.5 人日 + 法务 |
| 1 离线重放 | 对**一个**决策点、**全量去标识**后的历史样本（姓名/手机号/住址/年龄一律占位），固定 `model=jev-1.13.0`，并发 ≤3、限速 ≤5 rps；每个 choice 双向换序跑；同时跑已接入的 deepseek-v4-flash / qwen-flash `json_schema` 作基线 | 300–600 条双人标注（κ≥0.75），阳性每类 ≥30 | 自动采信桶（max(prob) ≥ 自标定阈值）精确率 ≥0.90、覆盖 ≥60%；换序翻转 ≤3%；中文礼貌式注入对照组带偏 ≤10%；**显著优于基线 ≥5pp（McNemar p<0.05）** | Jev 出局；结论入 bitter-lessons（"不是换名重建"的论证一并写） | 1–2 人日 + <$1 token + 标注 |
| 2 豁免评审 | 过线后按 [M-tax] 单独过快环豁免评审；按 [M-ledger] 逐条写明为何不是 L2/L5/L10/L11 换名重建；question/criteria 登记 prompt-rule-ledger；确定退场判据与 kill switch | 步 1 报告 | 用户裁定 | 不裁定不进任何在线阶段 | 评审会 |

**谁裁定、入哪本账**：步 0/1 的通过线由数据说话，步 2 由用户按 [M-tax] 快环豁免评审裁定；任一步不过线，即按 [M-ledger] 在 `docs/principles/bitter-lessons.md` 入账"Jev 不立项"及论证（含该决策点的样本量、精确率与对照基线数字），本报告作为附件引用。过线进入步 2 后的结论无论通过与否，同样入该台账。

**不要做的**：在线 shadow（禁）、每日 cron 比对（[P10] 预建评估产品）、新表/新列（[P5] 死遥测，且迁移须与发版同步）、用 Jev 结果驱动 [P8] 升降档。

### 5.2 标定方法要点（来自官方与独立实测，均为推断性建议）

- 用 `max(probabilities)` 而非官方 `confidence` 字段（choice 置信度只是分布形状公式且 86% 饱和为 1.00）；noul 用 p 的双阈值留不确定带。
- 每个 choice 必含 `none_of_the_above / 无法判断`（去 abstain 后不可答项准确率 0.950→0.000）。
- 每题单独阈值、不跨题复用（中文 ECE 0.035–0.164 按任务漂移）；阈值附近 ±0.02 复测抖动（std 0.001–0.015）。
- 否定/时态/"最后意图"类问题拆成正向字面子问由代码 AND/OR 合成；"此后未再确认"类顺序判断全部切到代码，由代码定位最近一条消息切片后只问单跳正向 noul。
- state 只喂候选人侧文本，剔除 Agent 自产岗位卡/系统语/我方模板结束语（我方文本会被当成候选人表态，例如 `src/tools/collection/recap-renderer.ts` 结束语含"没问题/不对"）。
- 先用 `usage.input_tokens` 实测本项目汉字/token 比，再写容量与成本结论（目前零证据）。

### 5.3 成本估算（本项目量级，取数 2026-09-24，7 天窗口）

| 项 | 数字 | 来源 |
| --- | --- | --- |
| Token 费 | 1,318 回合/天 × 2k state ≈ $3/月；复聊 post_booking 到达 LLM 环节 ≈8 touch/天 × 5k ≈ $0.05/月（设计稿估 ≤300/天 ≈ $2/月，已被 §4.4 #1 的生产库实测证伪）；守卫审计 438 行/月 ≈ $0.04/月 | 官方单价 × 生产实测量（复聊 30 天窗口，取数 10-08） |
| 一次性离线重放 | 300–600 条 × ≤5k ≈ <$1 | 同上 |
| 工程 | 客户端 + 开关 + 熔断 + 观测事件 + 脱敏：脚本版 1–2 人日；src 版 3–5 人日；走 `@ai-sdk/typesafe-ai` 另加 `ai` 升级回归 | 各设计稿 `engineering` 字段 |
| 标注 | 300–600 条双人 ≈ 1–2 人日；每次 jev 版本/state builder 变更重标 | 设计稿 + civil_comments 审计（≥100 条才能 Platt） |
| 法务 | PIPL 出境机制 + ZDR 谈判 + 中国标准合同附件（TypeSafe 无现成） | research-compliance |
| 隐性 | 限额"可不经通知变更"（两周内 tokens/s 收紧 2.5×）、无 SLA、模型月度升级需回归、新内容居所（question/criteria）的 review 纪律 | 官方 + [C8] |

**结论**：钱从来不是账本上的主项；主项是人日、法务与一个新的折旧型 harness 的终身维护。

---

## 6. 替代方案对照

"同样的封闭判断用什么做"——按本项目已接入的栈与量级（约 1,318 回合/天），以"2k token 状态 + 5 个判断"为单位：

**表 6-1 判定与能力**

| 方案 | 判定 | 能力 | 中文（证据等级） |
| --- | --- | --- | --- |
| **不做** | **本次 10 条候选的实际结论**：每条都有一个零新依赖修法 | — | — |
| **deepseek-v4-flash（extract 角色已在用）** | **封闭标签的正解落点**（[T-2] 顺风车） | prompt 模拟封闭判断；可附 quote；`generateStructured` 已存在（`src/llm/llm-executor.service.ts`） | 原生中文 |
| **qwen3.7-flash / qwen-flash 非思考 + `json_schema` strict** | **若真需要独立判定时的默认基线**；但多数候选连它都不需要（搭现有调用即可） | 同上；无原生校准（需 logprobs 或输出分数再校准） | 原生中文最强；与主模型同家族 |
| **Jev（API 直连 / OpenRouter）** | **不采用**（§4） | 三原语原生、分布输出；不算数/不多跳/不产 quote | 路由 0.88–0.98、推理型 0.60–0.68（独立小样本，业务子集 n=15–55） |
| **Laya-multilingual 自建（GPU）** | **不建议现在建**；仅作"合规要求数据不出境 + 已攒 ≥1 万条标注"时的私有化预案 | 三原语、`/v1/systemone` 兼容；**必须微调**（基座零样本 typed-decisions 0.362，低于多数类基线 0.461） | 零样本中文业务路由 0.62 vs Jev 0.88（三份小样本的推断综合）；简繁翻转 12.8%（独立）；**准确率 0.766 vs 0.727、ECE 0.081/0.213 等对比全部来自 Laya 自己的 README/模型卡，厂商自报、利益相关，且自认未实测 Jev** |
| Laya CPU（ONNX / `@receptron/laya`） | 同上 | 同上 | 同上 |
| Kev / decider / AgentJev | 不考虑 | 三原语 | **无中文证据** |
| bge-reranker-v2-m3 | 只做召回重排，不能替代 | 仅相关性 yes/no | 中文可用 |

**表 6-2 延迟 / 成本 / 接入 / 合规 / 维护**

| 方案 | 延迟 | 单次成本 | 接入 | 合规 | 维护 |
| --- | --- | --- | --- | --- | --- |
| 不做 | 0 | 0 | 0 | — | 0 |
| deepseek-v4-flash | ≈0.5–0.7s（匿名实测推算） | ≈¥0.0025–0.005（峰谷） | 最低：已接入 | 国内 | 低；峰谷价进成本告警 |
| qwen-flash + `json_schema` | ≈1.5–2.5s（TTFT 未核） | ≈¥0.0005 | 最低：已有 `DASHSCOPE_API_KEY` + `@ai-sdk/openai-compatible`，走 providers 三层 | 国内 | 低；prompt 漂移需守卫 |
| Jev | 有源实测 284–890ms（中文）；"官方 70–500ms"未复现（传闻）；大陆直连未测 | ≈¥0.0007 | 低（20 行 fetch）；OpenRouter 端点仍 alpha | 出境、无 PIPL、保留期未定 | 限额随时变、月度升级回归 |
| Laya GPU | 33–72ms（T4，厂商自报） | GPU ¥877–2,500/月 ÷ 请求数 ≈ ¥0.02–0.06/次，比 API 贵 30–80 倍 | 中：Python + GPU + 微调流水线 | 全私有、唯一不出境 | 高：PyPI 周更、自拟温度 |
| Laya CPU | 5 问 0.25–1s（官方 vs 社区差 4 倍） | ≈0 边际 | 中：Node 多语支持待验、1.7GB 权重 | 全私有 | 高 + 与主服务争 CPU |
| Kev / decider / AgentJev | GPU 20–300ms | ≥T4 月费 | 中高 | 全私有 | 高 |
| bge-reranker-v2-m3 | CPU ~20–27ms/对 | ≈0 | 低中 | 全私有 | 低 |

**三点读法**：
1. 成本列全是厘级，**成本不是决策变量**；分水岭是中文准确率/校准、延迟形态（一次前向 vs 解码 JSON）、出境与维护。
2. 本项目 5 秒聚合窗口 + 异步回合的形态下，LLM 路径的秒级延迟可接受；Jev 唯一差异化（亚秒延迟 + 原生分布）在异步/离线环不兑现。
3. "Laya 私有化"是唯一能解出境问题的路径，但当前量级下每次摊 ¥0.02–0.06，且零样本不可用；把它留作预案，前置条件是先攒出标注集。

---

## 7. 未决问题

按"谁能回答"分组。标 ★ 的是重议 Jev 前必须先有答案的硬门。

### 7.1 需要向 TypeSafe 书面确认（privacy@ / sales@）
- ★ 默认（非 ZDR）模式下请求体与响应的实际保留天数；Privacy Policy/DPA 均只写 "reasonably necessary"。
- ★ ZDR 授予条件（最低消费 / 合同期 / 是否覆盖日志与 Telemetry / 是否写入 DPA 附件）。
- ★ 是否愿签中国标准合同或在 DPA 附加 PIPL 条款。
- 子处理商名单与 SOC 2 Type II 内容（trust.typesafe.ai 为 JS 渲染未读到）；底层云厂商与推理托管方。
- 自助账号支付方式（信用卡 / 中国发卡行 / 对公发票）——官方零公开，本次禁止注册未验证。
- 限流从 250K tok/s / 1,200 rpm 收紧到 100K / 80 rps 的原因与后续走向；是否承诺 argmax 确定性；官方 70–500ms 延迟的来源页。

### 7.2 需要法务裁定
- ★ 候选人对话（含姓名/手机号/住址/年龄）出境到美国托管处理者的 PIPL 路径：机制、单独同意、PIA。
- ★ env 中已配的 Anthropic / OpenRouter / Gemini 境外 key 是否当前承载生产候选人数据——决定 Jev 是"首次出境"还是"新增处理者"。
- 去重后年度涉及候选人数是否低于 10 万人非敏感 / 1 万人敏感的豁免线；手机号是否按敏感口径。
- 若用 noul/score 直接影响候选人结果，是否触及 PIPL 第 24 条自动化决策。

### 7.3 需要本项目自测（无公开数据）
- ★ 中文每汉字平均消耗多少 input token（跑 `usage.input_tokens`）——决定 32k 能装几轮与真实成本。
- ★ 大陆生产机到 `api.typesafe.ai` 的直连可达性与 P50/P99。
- 本项目中文守卫/路由任务上 Jev 的真实准确率与 confidence 分布；状态含 Agent 自产岗位卡 + 候选人回声时，中文礼貌式注入带偏率。
- 中文置信度饱和是否普遍、是否让阈值无法拟合；中文有序 score 0.6–0.68 能否靠 2–3 档粗粒度 + 自校准提升到可用。
- qwen3.7-flash / qwen-flash 非思考 + `json_schema` strict 在 2.3k 输入 / 100 token 输出下的真实 TTFT 与端到端延迟；百炼/DeepSeek 对 `logprobs` 的支持范围。
- `ai` 7.0.37→7.0.133 对 `llm-executor` stopWhen/prepareStep 续接的实际影响（CHANGELOG 无 stopWhen 条目，但有 tool-choice 强制与 streamRetries 变更）。

### 7.4 外部证据口径冲突（待原作者澄清）
- zh-decision-bench 换序/繁体翻转率：README 1.9%/1.7% vs 转述 28%/12.8%。
- judgekit 同一 130 条集 Jev 为 97.7% 还是 96.2%（jev-latest 漂移 / 模板 / 数据版本）。
- Chorylee7 引用的"中文客服 64–65.2%"原始出处。
- Laya ECE 0.081 vs 0.213 两处口径（首页 vs 模型卡）。

### 7.5 非 Jev 研究建议清单（候选评审顺带发现；§1"先做什么"与 §4.2"正解"列均引用本节）

以下十项是 2026-10-08 调研快照中的候选建议，尚未分配负责人、排期或验收标准，**不是已确认待办或当前实现状态的权威来源**。采纳前须重新核对代码、问题证据与已有任务；确认采纳后再进入正式任务系统，记录负责人、状态、完成标准和验证结果。

- #1 删复聊 `ReengagementOutput.decision` 字段、代码由 `blockReason` 派生，用 `agent_invocation.outputCorrection` 量 4 周基线。
- #2 `location_reference_needs_grounding` / `salary_account_no_fabricated_policy` 改 `candidate_side` 或删除，mpr 复测 PR#1339 之后的块覆盖率；按 [C9] 给整个动态禁令层写退场指标。
- #3 74 次 `recap_not_required` 走 precheck description / 回执 hint 收口。
- #4 空产物兜底 `random=false` 删第 6 条模板；复聊待答闸修 timeout 丢消息。
- #5 配 `AGENT_EXTRACT_FALLBACKS`；补 labor_form 规则兜底写入的落库事件。
- #6 5 条 observe 哨兵按 14 天命中与人工假阳率降档/下线；结论登记 `feedback_guardrail_rules_offlined`。
- #7 摘要生成改 `generateStructured` + `z.enum`，删 `SCOPE_LINE_PATTERN`；scope/fail-open/消息数落库；先 SQL 量满配 20 段候选人占比。
- #8 群通知只渲染结构化字段、不渲染 `remark`；生成消息落库 + 确定性对账；跑 4 周拿基线。
- #9 修 `request_handoff` description 相邻码边界；周任务抽样 20→60；10-08 周报数字核实来源、分母和窗口后入 quality-metrics-ledger，入账前不得在其他文档引用。
- #10 同 5 问加进现有 weekly-guardrail-analysis；裁定清理死列 `semantic_reviews`；恢复断更的 accuracy 报告。

---

## 8. 方法与局限

### 8.1 方法
1. **六个研究角度**并行：官方契约逐页复核（api / primitives / confidence / jaggedness / models / cookbooks / legal）；接入路径（官方 SDK / `@ai-sdk/typesafe-ai` / OpenRouter / Laya / classifier.dev）含 npm 与 CHANGELOG 核对；独立证据与弱点（几十个审计仓库 + 4 篇 arXiv，侧重中文）；可得性与合规（法律文本原文 + 状态页 + PIPL 一般性规则）；替代方案（国内 LLM 结构化输出 / Laya / Kev / decider / reranker / GPU 价）；生态用法模式（官方 pattern + IM / 客服 / HR / 轮次判断项目）。
2. **裁定清单**：从 `docs/principles`、`docs/architecture`、CLAUDE.md 与用户记忆整理 60+ 条对"模型判断放哪里"有裁决力的条目，逐条标注理由是否依赖模型类型。
3. **候选扫描 → triage → 设计 → 三路对抗审查**：70 条 → 10 条；每条设计稿含 state / questions / 阈值 / fallback / 试点方案 / 自评；裁定、能力、价值三位审查者独立出票，并在仓库（行号）与生产库（SQL，按 CLAUDE.md 查询红线限窗）核实关键数字。
4. **证据分级**：官方 / 独立实测 / 传闻 / 推断四级；本项目数字标注取数日期。

### 8.2 局限
- **未实际调用 Jev API**（无 key，本次禁止注册）。所有能力判断基于官方文档与第三方证据；中文独立证据全是 40–378 条、单人标注的小样本，与本项目"招聘对话 + 企微语境"分布差异未知。本报告的能力结论是**方向性**的，不能支持精确差值。
- 本项目量级取自 2026-09-24 的 7 天窗口（9,228 回合、179 次守卫审查、3,820 次复聊触达）；没有改用 2026-10-08 的 7 天窗口，是因为该窗口落在国庆假期、只有 35 回合，不具代表性；个别审查者在 10-08 另查了 30 天生产库（extract_facts 降级 0 次、recap 拒绝 102 次、post_booking 到达 LLM ≈243 次），两套取数日期不同，文中已分别注明。
- 六个研究角度均有产出，但部分页面抓取失败（trust.typesafe.ai 子处理商、OpenRouter 模型页 404、yibie/awesome-jev 主 README、DeepSeek 官方价格页、vercel.com/ai-gateway），相关数字降级为搜索摘要或聚合站口径，已在 Sources 标注。
- 法律部分为一般性法律常识，非法律意见。
- 本报告不替代 [M-tax] 快环豁免评审；若将来有人要重议，须按 §5.1 步 2 重新走程序。

---

## 9. Sources

### TypeSafe 官方（契约 / 模型 / 法律）
- API 参考：https://docs.typesafe.ai/api.md
- 原语总览与三原语页：https://docs.typesafe.ai/primitives.md ｜ https://docs.typesafe.ai/primitives/choice.md ｜ https://docs.typesafe.ai/primitives/score.md ｜ https://docs.typesafe.ai/primitives/noul.md
- state 概念页：https://docs.typesafe.ai/concepts/state.md ｜ 构建指南：https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- 置信度：https://docs.typesafe.ai/confidence.md
- 模型/限额/价格/语言：https://docs.typesafe.ai/models.md（2026-10-08 读取；09-24 版限额见编排者种子事实）
- jev-1.13 弱点页：https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- Patterns：https://docs.typesafe.ai/patterns/confidence-routing.md ｜ https://docs.typesafe.ai/patterns/intent-routing.md
- Cookbooks：https://docs.typesafe.ai/cookbooks/llm_guardrails.md ｜ https://docs.typesafe.ai/cookbooks/function_calling.md ｜ https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md ｜ https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md ｜ https://docs.typesafe.ai/cookbooks/classification_using_confidence.md ｜ https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md
- JS SDK：https://docs.typesafe.ai/sdk/javascript.md ｜ https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md ｜ https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md ｜ 源码 https://github.com/typesafe-ai/typesafe-sdk-js
- 法律：https://docs.typesafe.ai/legal.md ｜ Privacy Policy https://typesafe.ai/legal/privacy-policy ｜ MCA https://typesafe.ai/legal/mca ｜ DPA https://typesafe.ai/legal/data-processing ｜ AUP https://typesafe.ai/legal/acceptable-use-policy ｜ Terms https://typesafe.ai/legal/terms
- 状态页：https://status.typesafe.ai/ ｜ https://status.typesafe.ai/incidents
- 官方 X 公告（正文经 WebFetch 402 未直读，日期取自多家独立报道）：https://x.com/typesafeai/status/2101786156572823624

### 接入路径（npm / Vercel AI SDK / OpenRouter / Laya）
- `@ai-sdk/typesafe-ai` README：https://raw.githubusercontent.com/vercel/ai/main/packages/typesafe-ai/README.md
- `ai` CHANGELOG（7.0.103 新增 `experimental_evaluate`、7.0.128 改名 `decide`）：https://raw.githubusercontent.com/vercel/ai/main/packages/ai/CHANGELOG.md ｜ decide 源码 https://raw.githubusercontent.com/vercel/ai/main/packages/ai/src/decide/decide.ts ｜ https://raw.githubusercontent.com/vercel/ai/main/packages/ai/src/decide/index.ts
- OpenRouter 社区指南：https://openrouter.ai/docs/guides/community/jev ｜ 博客 https://openrouter.ai/blog/insights/what-is-jev/（模型页 https://openrouter.ai/typesafe/jev-1.13 本次 404）
- Vercel AI Gateway（官方页被拦，独立站转述）：https://systemonemodels.org/integrations/vercel/
- classifier.dev：https://classifier.dev/developers
- LiteLLM 透传：https://docs.litellm.ai/docs/pass_through/typesafe
- Laya：https://github.com/NandhaKishorM/laya ｜ https://laya.convaiinnovations.com/ ｜ https://huggingface.co/convaiinnovations/laya ｜ https://huggingface.co/convaiinnovations/laya-multilingual ｜ https://huggingface.co/convaiinnovations/laya-typed-decisions ｜ CPU 复测 https://huggingface.co/convaiinnovations/laya/discussions/12
- Laya 第三方：https://github.com/receptron/laya ｜ https://github.com/enlotec/laya-serve ｜ https://huggingface.co/Adkid/laya-cn-a ｜ https://systemonemodels.org/models/laya/
- 其他开源复现：https://github.com/jaredpalmer/kev ｜ https://github.com/Mapika/decider ｜ https://github.com/malevrigns/agent-jev ｜ https://github.com/umstek/zero-shot-ie-bench/pull/4 ｜ https://pinggy.io/blog/best_open_source_jev_alternatives_self_hosted_decision_models/
- bge-reranker-v2-m3：https://huggingface.co/BAAI/bge-reranker-v2-m3

### 独立实测 / 论文（能力、校准、注入、中文）
- willkelly/jev-evaluation（123,805 次请求；置信度饱和、礼貌注入 65%、位置指代 0.42、3-SAT）：https://github.com/willkelly/jev-evaluation
- jujumilk3/jev-calibration-audit（去 abstain ECE 0.793；50 次 15 种答案集）：https://github.com/jujumilk3/jev-calibration-audit
- nibzard/decision-model-benchmark（强制不确定仅认 49.7%）：https://github.com/nibzard/decision-model-benchmark ｜ 转述 https://github.com/vamsikrishna2421/jev-usecases
- awesome-jev-robustness 汇总（JevOut 61.4%、news-bench 否定 +87%、OOD ECE 4.4×、换序）：https://github.com/Yifan-Lan/awesome-jev-robustness ｜ https://github.com/Chorylee7/JEV
- civil_comments 校准审计（ECE 0.16–0.21、Platt）：https://github.com/Adilmp/does-jev-confidence-mean-anything ｜ jevcal https://github.com/abhixhek/jevcal
- NeuralTrust 安全评述（伪预批 0.76→0.48；SOC 2 见 Vanta）：https://neuraltrust.ai/blog/jev-typesafe-ai-security
- arXiv：Rafe & Das 2609.24052 https://arxiv.org/abs/2609.24052 ｜ JEV-as-a-Judge 2609.26550 https://arxiv.org/abs/2609.26550 ｜ Chinese-Jev / CJ-Bench 2609.36965 https://arxiv.org/html/2609.36965 ｜ Jev-Mem 2609.23986 https://arxiv.org/abs/2609.23986
- 中文：CodyQin/zh-decision-bench https://github.com/CodyQin/zh-decision-bench ｜ judgekit https://github.com/lexingtonhibiki/judgekit ｜ typesafe-ai/skills issue #3 https://github.com/typesafe-ai/skills/issues/3 ｜ Xiaooolong/vev https://github.com/Xiaooolong/vev ｜ awesome-jev-zh https://github.com/yzfly/awesome-jev-zh（含 PR#7）｜ 阿里云开发者社区 https://developer.aliyun.com/article/1766844
- 多语：AHTOOOXA/jev-cyrillic-audit https://github.com/AHTOOOXA/jev-cyrillic-audit ｜ marcosmartinez/jev-acento https://github.com/marcosmartinez/jev-acento
- 长上下文空缺：jevbench #49 https://github.com/fstandhartinger/jevbench/issues/49 ｜ #187 https://github.com/fstandhartinger/jevbench/issues/187 ｜ longjev https://github.com/avshalomd/longjev
- 其他：Simon Willison https://simonwillison.net/2026/Sep/21/jev/ ｜ LangSmith 评估器译文 https://www.cnblogs.com/itech/p/23115716 ｜ harrymunro/jev-laya-benchmark https://github.com/harrymunro/jev-laya-benchmark ｜ awesome 列表 https://github.com/AnotiaWang/awesome-jev ｜ https://github.com/cobanov/awesome-jev

### 生态用法模式
- 守卫：tripwire https://github.com/noelzappy/tripwire ｜ jev-phishing-bench https://github.com/anisselbd/jev-phishing-bench
- 路由/升级：dabit3/jev-experiments（agent-assist、jev-voice-turn）https://github.com/dabit3/jev-experiments ｜ jev-oncall https://github.com/mingleiw/jev-oncall ｜ fazer-ai/agents #1135 https://github.com/fazer-ai/agents/issues/1135 ｜ JevRouter https://github.com/BillionsBobby/JevRouter
- 轮次判断：veris.ai https://veris.ai/blog/jev-turn-detection ｜ kelpie #96 https://github.com/guedesdiogo/kelpie/issues/96 ｜ Jev_steer_or_queue https://github.com/Larkspur-Wang/Jev_steer_or_queue ｜ jev-voice-browser https://github.com/moritzkremb/jev-voice-browser
- 记忆/压缩/重排：fast-jev-compaction https://github.com/tamaratran/fast-jev-compaction ｜ jev-reranker https://github.com/hotchpotch/jev-reranker
- 中文 IM：JevBystander https://github.com/Nisaka520/JevBystander（题目语言 AB：docs/实验-题目语言AB.md）｜ jev-chat-jarvis https://github.com/jev-chat/jev-chat-jarvis ｜ work-with-jev https://github.com/Adkid-Zephyr/work-with-jev ｜ wechat-jev-assistant https://github.com/yushen100/wechat-jev-assistant
- HR：resurface https://github.com/dolevhayut/resurface ｜ nanami-0713/jev-resume-screening https://github.com/nanami-0713/jev-resume-screening ｜ jev-resume-disqualifier https://github.com/AiPersonacademy/jev-resume-disqualifier

### 可得性 / 合规 / 价格（独立或聚合站，等级见正文）
- 注册与额度时间线：https://aifront-page.com/typesafe-ai-reopens-jev-sign-ups-free-credit-suspended/ ｜ https://jevwiki.ai/wiki/entities/typesafe-console.md ｜ https://flaviocopes.com/jev-api-key/ ｜ https://jevmodel.org/get-jev/ ｜ https://www.orcarouter.ai/blog/jev-typesafe-system-one-what-we-know
- 条款评述：https://wunderlandmedia.com/typesafe-ai-jev-terms-of-service-gdpr ｜ https://opper.ai/provider/typesafe
- uptime 第三方：https://piehost.com/status/typesafe.ai ｜ https://statusfield.com/services/typesafe-ai/incidents
- 大陆可达性（传闻级）：https://toolin.ai/tools/typesafe-ai ｜ https://www.eggstriker.com/blog/jev-typesafe-system-one-2026 ｜ https://ai-bot.cn/jev ｜ https://hub.baai.ac.cn/view/58173
- PIPL：https://chinagateway.pro/glossary/cross-border-data-transfer.html ｜ https://www.freshfields.com/en/our-thinking/blogs/risk-and-compliance/china-cross-border-data-transfers-revised-requirements-for-security-assessment-102j5lm ｜ https://www.china-briefing.com/news/china-cross-border-data-transfer-certification/
- 国内模型价格：阿里云百炼 https://help.aliyun.com/zh/model-studio/model-pricing ｜ qwen3.7-flash https://help.aliyun.com/zh/model-studio/qwen3-7-flash ｜ 结构化输出 https://help.aliyun.com/zh/model-studio/qwen-structured-output ｜ DeepSeek V4-Flash（官方页本机被拦，聚合站口径）https://devtk.ai/en/models/deepseek-v4-flash/ ｜ https://developer.aliyun.com/article/1731293 ｜ 延迟 https://cloud.tencent.com/developer/article/2659300
- GPU 价格（开发者社区/比价站列表价）：https://developer.aliyun.com/article/1708787 ｜ https://developer.aliyun.com/article/1710959 ｜ https://developer.aliyun.com/article/1714433 ｜ https://www.txyfwq.com/gpu/gpujiage.html ｜ https://cloud.tencent.com/document/product/1108/55463

### 本仓库与生产库（内部）
- 裁定来源：`docs/principles/rules-vs-semantics-design-philosophy.md`、`docs/principles/bitter-lessons.md`、`docs/principles/context-engineering-principles.md`、`docs/architecture/semantic-decision-taxonomy.md`、`docs/architecture/guardrail-quality-system.md`、`CLAUDE.md`、用户记忆（`feedback_no_realtime_feedback_loop`、`project_semantic_taxonomy_redesign` 等）
- 候选评审引用的代码位置均以仓库相对路径内联于 §4（移除易过期行号，关键符号可在对应文件检索）；生产库数字来自 `message_processing_records` / `reengagement_touch_records` / `guardrail_review_records` / `agent_execution_events` / `handoff_events`（取数日 2026-09-24 七天窗口；审查者补查 2026-10-08 三十天窗口，文中分别注明）
- 中间产物：45 条丢弃候选及理由已并入本文附录 A；候选扫描 `map-*.json`、`cand-1..10.json`、`design-1..10.json`、六份 `research-*.md` 未入库，位于本次会话 scratchpad `jev/` 目录，关键结论均已在正文引用

---

## 附录 A：triage 阶段丢弃的 45 条候选（id + 一行理由）

70 条扫描候选中，10 条入选（§4），15 条作为同族并入入选项（各候选的 `merged_from`），以下 45 条在 triage 阶段丢弃。理由分四类：① 判定对象本身是对抗输入或 Jev 自认弱项（注入、多跳、计数、时序）；② 已有确定性裁定或结构化信号接管；③ 无痛点量化 / 无 badcase 实证；④ 同族已由入选候选代表。编号前缀对应扫描子系统：guard / gen / reeng / chan / tools / offline。

| 候选 id | 丢弃理由 |
| --- | --- |
| `guard:guard-input-risk-intercept` | 命中=不可逆暂停托管+告警，候选人原话本身是对抗输入而 Jev 自认对 state 内注入不鲁棒；残障判定明令禁推断式识别；D-3/T-5 不可逆门保持确定性，最多 observe，收益不如 cand-2/4。 |
| `guard:guard-input-prompt-injection` | 用自认『对注入指令不鲁棒』的模型判注入是结构性矛盾；动作仅 observe、真实命中极少，收益=告警精度。 |
| `guard:guard-output-job-fact-provenance` | 数字出处对账用确定性集合比对更便宜，Jev 不能算术、跨午夜区间弱；仅零查岗工具轮触发量小；『表述等价』子问题已在 cand-8 的 fact_in_source 中代表。 |
| `guard:guard-output-discrimination-leak` | P0 红线须 fail-closed 确定性规则；state 含候选人敏感属性需 ZDR/PIPL 评估（DPA 无中国机制）；召回 7% 的问题面未验证，先补样本再谈模型。 |
| `guard:guard-output-fraud-coaching` | 两步条件=multi-hop，Jev 自认弱项；诚信 P0 只能影子；命中极少无标注集。 |
| `guard:repair-second-review-sendability` | 非开放文本判断，由规则 tier 派生（feedback_guard_repair_mode_is_rule_tier），Jev 无用武之地。 |
| `guard:guard-open-semantic-quality-gap` | 正面撞 L2（LLM 语义审查 shadow 长跑后整体删除）与 L4/T-4；作为诱饵已由 cand-6 代表，且其数据底座由 cand-10 提供。 |
| `gen:simulated-tool-exchange-leak` | 判定对象是 reasoning 原文（伪工具指令密集）恰是 Jev 注入弱项，且常超 state 预算；已知形态正则已覆盖，增量只在未知形态。 |
| `gen:empty-text-recovery-grounding` | 路线选择是硬编码顺序；『恢复文本是否引入无出处事实』更该按 P2 构造约束（禁用工具补话已裁定）解决，state 6k 偏大；需求侧已被 cand-4（是否该回复）覆盖。 |
| `gen:handoff-promise-reconciliation` | 时态/双重否定是 Jev 自认弱项；原因码全 other 的根因在 agent/tools 层产码，审计侧由 cand-9 代表。 |
| `gen:dangling-check-reply` | 仅 repair 路径 7 天 90 次、规则已下线只剩残留点；形态好但量太小不值得独立接入，可并入 cand-10 离线重判时顺带标注。 |
| `gen:direct-silence-leak-classification` | state 恰是模型泄漏的内部指令文本（注入不鲁棒）；判定顺序是人工优先级，每形态独立正则且 G-newform 裁定只加检测走现有 repair。 |
| `gen:repair-adoption-and-fail-open` | 现判据改为规则 ID 集合差是裁定结果（feedback_guard_repair_mode_is_rule_tier）；两版语义比较触 M1/L3；离线角度已并入 cand-10。 |
| `gen:entry-stage-and-stage-advance` | 无阶段误判量化证据；stage_goals 动态配置可做 choice criteria 但影响 dynamic slot 与 advance_stage 工具契约，缺 badcase 实证（M-fallback）。 |
| `gen:llm-error-classification` | 外部网络判断不应再依赖外部网络；应改结构化 error 字段，候选自评不建议 Jev。 |
| `gen:prompt-section-relevance-pruning-gap` | 已有反向裁定：成本交给前缀缓存、注意力靠瘦身与代码接管（C2）；按需裁剪会打缓存。 |
| `reeng:reeng-anchor-store-presented` | 需实体链接（回复→jobId），且 CL-reeng/anchor 口径多次收窄；更该按 P2 让 job_list 工具回执直接登记展示岗位而非回扫文本。 |
| `reeng:reeng-anchor-asks-for-location` | 单句 noul 形态好，但 address_missing 场景灰度中、修法已按句切分；量化误判率缺失，先观测；可后续并入 cand-4 同类『回复语用』评估。 |
| `reeng:memory-fact-conflict-and-staleness` | 时效判断 Jev 不能算时长；冲突裁决城市已有确定性优先级；其余字段『是否改口』已由 cand-3 的 is_correction 代表。 |
| `reeng:memory-recall-relevance-selection` | 无误召回 badcase 证据（候选自评『没做』而非『痛点』）；rerank 需逐条打分，score 是 Jev 最弱原语。 |
| `chan:chan-debounce-turn-complete` | Jev 不能数时间间隔、需预离散化；语音场景证据显示任务通过率不变且回复时延翻倍（research-patterns ③）；无本项目拆轮 badcase 量化。 |
| `chan:chan-replay-on-new-messages` | 重跑占比无统计，先补数据；『新消息是否改变回复适用性』需两段文本并列=多跳弱项；错误代价仅是多一次生成。 |
| `chan:chan-human-takeover-signal` | M-human 裁定真人介入=MOBILE_PUSH 来源白名单非语义判断；暗号『~』是有意绕开语义；误判会误暂停托管（不可逆）。 |
| `chan:chan-inbound-filter-rules` | 9 条结构化等值规则，无文本语义，候选自评非 Jev 场景。 |
| `chan:chan-pause-resume-readiness` | 恢复托管是不可逆门（T-5/D-3），到期恢复不经 resumeUser 且闭环率不可测；先修 handoff_events 回填再谈判定；state 1.5k 但需读真人消息。 |
| `chan:chan-outbound-segment-structure-class` | 错误代价低（分段难看）但在最靠近用户、最在意延迟的点加外呼不划算；更应按 P2 让生成以最终形态渲染结构块。 |
| `chan:chan-vision-image-kind-and-ownership` | 需先经视觉模型转文字（Jev 无图像），且 vision 分类错误率无数据，拆分收益未知；与 tools:resume-and-visual-fact-structuring 同族一并搁置。 |
| `chan:chan-friend-greeting-vs-real-engagement` | 只影响漏斗分母不影响回复，低风险低收益；作为『中文短文本 noul 精度试点』可在 cand-10 校准完成后顺带做，不独立立项。 |
| `chan:chan-file-attachment-is-resume` | 仅文件名信息量不足，模型也难做对；更好的修法是让工具读文件。 |
| `tools:collection-option-literal-match` | 三分法已归『封闭标签复用 extract_facts/主 Agent』；公证要求 sourceText 逐字出处，Jev 不产 quote 是硬缺口（P9/P11）。 |
| `tools:collection-health-cert-five-state` | 候选人侧两不定态刻意留空追问不猜（交互设计解决）；岗位侧关键词表无误判率台账；均无痛点量化。 |
| `tools:job-student-requirement-and-identity` | 岗位 remark 判读属结构解析边界，刚于 v11.12.1 修完三段断链且 is_student 落库待 10-01 核验，先看修复效果；候选人侧『唯一识别器』合约禁宽松判定。 |
| `tools:job-schedule-semantic-and-constraint` | 0920/0924 用户裁定：早/中/晚班是运营口径，口径未定前不动判定；排他 vs 可用性 noul 待口径后再评。 |
| `tools:job-category-soft-rank` | 只影响排序非硬过滤，无误排序台账；score/rerank 是 Jev 最弱原语。 |
| `tools:geo-ambiguous-place-city-adjudication` | geo 域裁定纯确定性零 LLM；enforce 冲突策略已终审 no-go（零正样本）；『城市是否候选人自己要去』缺口需先有样本。 |
| `tools:resume-and-visual-fact-structuring` | 已是结构化输出+quote+公证形态；值是开放字符串，Jev 只能做『字段有无证据』前筛，收益薄。 |
| `tools:identity-name-shape-and-tool-intent-gates` | 不可逆动作前的确定性门，官方裁定保留；Jev 最多二审信号；敏感筛选宽口径误报代价低、精度要求低。 |
| `offline:test-suite-execution-verdict` | checkpoint 是自由文本（§4 待办 2），须先结构化为可判断言；对照工具返回核事实=multi-hop 弱项；相似度评分器已删。 |
| `offline:regression-turn-review` | 口径页已裁定回归线退役；真人回复当标准答案等三硬伤会被 Jev 继承。 |
| `offline:badcase-error-category` | 样本池约 119 条且人工复核在环，自动分类价值低；『人工/非Agent归因』类需跨表证据单靠文本会错；写入侧白名单已止住污染。 |
| `offline:badcase-root-cause-layer` | 多表多跳推理、稀疏表缺行语义解释，Jev 弱项；目前由 Claude Code agent 完成且不在运行时内。 |
| `offline:badcase-priority-tier` | score 是最弱原语；P0 判据需对照工具返回；样本小。 |
| `offline:badcase-cluster-dedup` | 簇摘要含大量无关上下文降准；28 簇规模下人工/Claude 判重成本可承受。 |
| `offline:conversion-dropoff-reason-gap` | 无标签集（运营未定义）、输入含时间线需预折叠；纯缺口无数据。 |
| `offline:blacklist-candidate-flagging-gap` | 运营决策、取消托管不可逆、自动化价值未论证；reason 为自由字符串无枚举。 |
