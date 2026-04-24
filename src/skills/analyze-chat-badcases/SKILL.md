---
name: analyze-chat-badcases
description: 抽样分析招聘 Agent 的生产对话质量，或分析 BadCase / GoodCase 反馈样本池中提交的样本，识别问题并协作修复，生成针对性测试集验证修复。用于以下场景：用户提到"分析生产对话"、"找 badcase"、"分析昨天/今天提交的 badcase"、"进入反馈验证 SOP"、"Agent 表现怎么样"、"对话回归"、"质量审计"、"候选人流失分析"、"抽查最近的聊天"，或任何涉及招聘 Agent 对话质量改进的闭环任务。即使用户没有显式说"分析 badcase"，只要他们在讨论 Agent 对话问题并想动手改进，就应该用这个 skill。
---

# Analyze Chat Badcases

产品能力：收集生产对话或反馈样本 → LLM 分析 → 协作修复 → 生成针对性测试集 → 跑测试验证。

## 业务语境

- 招聘 Agent（不要预设细分赛道/目标，让数据说话）
- 失败代价：候选人流失、需要招募经理人工介入

## 数据源

**生产 Supabase 直连**（只读）：
- MCP 工具：`mcp__supabase__execute_sql`
- `project_id`: `uvmbxcilpteaiizplcyp`

两张核心表按 `message_id` 1:1 join：`chat_messages`（完整对话）+ `message_processing_records`（每 turn 工具调用/记忆/异常）。

字段含义见 `references/schema.md`——在 Step 2 读完原始数据后需要参考。

**飞书反馈样本池**：
- `BadCase / GoodCase` 是反馈样本池，不是正式测试资产
- 表配置来自 `FEISHU_BITABLE_BADCASE_*` / `FEISHU_BITABLE_GOODCASE_*`
- 常用字段别名见 `src/biz/feishu-sync/bitable-sync.service.ts` 的 `feedbackFieldAliases`
- 按提交时间分析时，优先用 `提交时间 / 创建时间 / 咨询时间` 做时间窗口；如果字段不存在，再用飞书记录元数据的创建时间兜底

**飞书角色分工**：
- `BadCase / GoodCase`：样本池，只保存证据、观察和候选素材
- `测试集 / 验证集`：正式数据集，只能由本 skill 策展、确认后再导入
- `资产关联`：内部血缘表，自动记录样本池和正式数据集之间的关联边

不要把样本池里的记录机械搬运成正式数据集，也不要依赖手动勾选字段决定是否入库。

反馈修复测试验证链路遵循 `docs/workflows/feedback-repair-test-validation-v2.md`：反馈只进样本池，正式测试资产只能由本 skill 策展、用户确认后导入。

## 执行步骤

### Step 0. 选择入口

先判断用户要分析的是哪类来源：

- 用户说"昨天/今天提交的 badcase"、"反馈验证 SOP"、"反馈样本"、"BadCase 表"：走飞书反馈样本池入口，按用户指定时间窗口读取 `BadCase`，必要时同步读取相关 `GoodCase`
- 用户说"最近聊天"、"生产对话抽样"、"抽查最近 N 个候选人"：走生产 Supabase 抽样入口
- 用户没有说清楚来源但提到"提交"或"反馈"：默认走飞书反馈样本池入口，不要退回随机抽样生产对话

时间窗口必须明确写成绝对日期。例如当前日期是 2026-04-23 时，"昨天和今天"应解释为 2026-04-22 00:00:00 到 2026-04-23 23:59:59（使用用户本地时区）。

### Step 1A. 飞书反馈样本池读取

读取 `BadCase` 表中指定时间窗口内提交的记录，整理为统一样本结构：

- `badcaseId`: 优先取 `问题ID / 用例名称 / record_id`
- `submittedAt`: `提交时间 / 创建时间 / 咨询时间`
- `category`: `分类 / 错误分类`
- `status`: `状态`
- `priority`: `优先级`
- `source`: `来源`
- `chatId`: `chatId / 会话ID`，没有独立字段时从备注里的 `chatId:` 提取
- `candidateName / managerName`
- `userMessage`
- `chatHistory`
- `remark`

如果记录只有片段、没有完整对话，但有 `chatId`，再回查生产 Supabase 的 `chat_messages` 补齐完整会话；如果没有 `chatId`，只能基于 `chatHistory` 和备注分析，并在报告里标注证据不足。

### Step 1B. 生产对话抽样

默认抽最近 15 个候选人完整对话。用户指定了其他数量就按用户说的。

直接用 `queries/latest-chats.sql`：把文件内容读出来，把 `:sample_size` 替换成实际数字，通过 `mcp__supabase__execute_sql` 执行。

一次 SQL 拿全所有 turn，不要循环调多次。

### Step 2. 分析

按 `chat_id` 把原始行拼成对话流水（user/assistant 交替），然后判断每条对话里 Agent 的表现。

**不预设分析维度**——结合业务语境自己识别问题、自己归类命名。预设维度会让你只看见已知问题、错过真正有价值的新发现。

字段不理解时查 `references/schema.md`，尤其 `anomaly_flags` / `tool_calls` / `memory_snapshot` 这三个 JSONB 字段是判案主要依据。

### Step 3. 产出分析报告

在对话里直接输出 markdown。模板：

```markdown
# 对话分析报告（chat × N）

## 概要
- 样本范围：{时间范围}
- 总 turn / assistant turn 数 / 失败率 / 平均时延
- 有 anomaly_flags 的 turn 比例
- 有 fallback 的 turn 比例

## 问题分类

### [你自己命名的问题]
- 触发样本：chat_id={xxx}, chat_id={xxx}
- 典型片段（引用 2~3 行对话原文）
- 判断理由
- 修复方向：具体到代码位置 / prompt 段落 / 工具实现

## 整体观察
（对这批样本的整体判断）
```

### Step 4. 与用户对齐

展示报告后问：哪些问题优先修？修复方向是否认同？按用户回答决定下一步。

**不要跳过这步直接改代码**——用户可能有你看不到的上下文（业务优先级、上线计划、已知正在修的问题）。

### Step 5. 实施修复

按常规开发流程：
- Read 相关代码定位问题点
- 改代码 / prompt / 工具实现
- 遵循 `.claude/agents/code-standards.md`
- 业务规则（红线、阶段目标等）在 `src/biz/strategy/`，需要时去读，不要硬编码进 skill

### Step 6. 生成针对性测试集（草稿）

**针对本次修复的问题类型**生成用例，不是 badcase 全量档案。

正式资产策展闸门：
- `BadCase / GoodCase` 只是证据样本池，不是高质量测试资产；不要把样本池记录按 1:1 原样搬成 `测试集 / 验证集`
- 生成草稿前必须先对样本做 `保留 / 重写 / 合并 / 删除` 分层，并把分层结论展示给用户
- `保留`：已有输入、上下文、检查点、期望行为都清楚，且能稳定自动评审
- `重写`：保留源证据，但需要把“历史事故描述”改写成原子化场景、明确检查点和失败判定
- `合并`：多个 BadCase 暴露同一个根因，例如地址识别、岗位硬约束、约面截止、报名字段等；应合并成一个根因簇，再拆成少量代表性用例
- `删除`：无有效用户输入、无可验证行为、只是占位文本/乱码/重复噪音，例如“改改改改”
- 默认不要追求“84 个 BadCase 生成 84 个验证样本”；更合理的是先按根因簇压缩，再扩成 20~35 条原子测试集和 8~15 条代表性回归验证样本
- 只有通过这个质量闸门的草稿，才允许进入用户确认和导入步骤

验证集专用闸门：
- `conversationCases` 不是“更长的 scenarioCase”。`验证集` 可以来自 BadCase 策展、重写或补全后的多轮回归样本；判断标准是它是否需要多轮状态回放，而不是是否逐字等于原始生产对话
- BadCase 只有单条用户消息、事故备注、截图转写片段、或 0-3 行短上下文时，默认只能生成 `scenarioCases`，不能生成 `conversationCases`
- 能进入 `验证集` 的样本必须满足：有足够完整的 `conversation`，能解析出至少 2 个用户侧 turn 和 2 个 Agent/招募经理侧 turn，且当前问题依赖跨轮上下文、记忆延续、已展示岗位、已收集报名字段、或预约流程状态；角色名不要求固定为“候选人/招募经理”，只要双方发言边界可识别即可
- 缺少 `chatId` 但有完整对话文本时，可以作为验证集草稿，但 `remark` 必须写明“无 chatId，无法回查生产工具流水”；涉及动态事实时优先降级为 `scenarioCases`
- 如果原始 BadCase 只是“最后一句 + 人工评价”，即使 `chatHistory` 字段里包含后续真人回复，也不要把它直接放进验证集；先截断到事故发生前，并判断是否仍然有完整回归价值
- 删除或不进入验证集的常见样本：寒暄开场、无意义输入、只有单轮问答、只验证一句话术、无法判断 Agent 应该做什么、只能靠历史真人回复复刻才能得分
- 每个根因簇最多先沉淀 1-3 条代表性 `conversationCases`；剩余变体放进 `scenarioCases`，避免验证集被同质样本污染

优先整理成两类 JSON 草稿，方便 Step 8 直接导入：

1. `scenarioCases`：用于导入 `测试集`
- `caseId`: 稳定 ID，同一条用例后续迭代必须保持不变
- `caseName`: 用例名称
- `category`: 问题分类（对应 Step 3 的问题名）
- `userMessage`: 最后一条用户输入
- `chatHistory`: 多轮上下文（可选）
- `checkpoint`: 核心检查点（可选）
- `expectedOutput`: 自然语言描述期望行为
- `sourceType`: `从BadCase生成 / 手工新增 / 从GoodCase提炼 / 线上回捞`
- `sourceBadCaseIds`: 关联 badcase ID 列表（可选）
- `sourceGoodCaseIds`: 关联 goodcase ID 列表（可选）
- `sourceChatIds`: 关联 chat_id 列表（可选）
- `participantName / managerName / consultTime`: 追溯信息，可选
- `remark`: 策展备注，可选
- `enabled`: 是否启用，默认 `true`

2. `conversationCases`：用于导入 `验证集`
- `validationId`: 稳定 ID，同一条验证样本后续迭代必须保持不变
- `validationTitle`: 验证标题，必须概括根因和关键上下文，不要只写随机 caseName 或“真实生产对话回归样本”
- `conversation`: 足够回放该 BadCase 根因的多轮对话记录；只能包含到待验证问题发生时所需的上下文，不要把后续真人补救、人工评语、或目标答案混进对话正文
- `chatId`: 主 chat_id；有真实生产来源时优先提供，BadCase 策展/重写样本无法提供时在 `remark` 解释证据边界
- `participantName / managerName / consultTime`: 对话元信息，可选
- `sourceType`: `真实生产 / 从BadCase沉淀 / 从GoodCase沉淀 / 人工补充`
- `sourceBadCaseIds / sourceGoodCaseIds / sourceChatIds`: 溯源信息，可选
- `remark`: 策展备注，必须写清关键观察 turn、为什么需要整段回归、动态事实边界、以及是否缺少 chatId / 工具流水
- `enabled`: 是否启用，默认 `true`

动态工具数据边界：
- `conversation` 里的历史真人回复默认只是复盘参考，不等于硬期望回复
- 涉及岗位库存、距离、面试时间、薪资、年龄/健康证门槛等会由 `duliday_job_list / geocode / duliday_interview_precheck` 实时生成的数据时，不要把历史下一句写成固定事实断言
- 需要稳定自动评审时，优先在 `expectedOutput` 写成 `核心检查点：...` / `期望行为：...` 这类行为断言，例如“必须先 geocode 再查岗；回复要基于本轮工具结果，不得声称历史岗位仍在/已满”
- 如果只能沉淀真实对话样本而不能稳定断言，就在 `remark` 标注“动态工具数据，仅用本轮工具结果评审，历史回复只作参考”
- 对于工具生成的岗位/距离/预约结论，真人历史回复只能用于理解当时发生了什么；真正的评审事实锚点必须来自本轮工具结果或显式 mock 的工具快照

上下文与记忆完整性闸门：
- `chatHistory` 不是装饰字段；它必须覆盖当前用户消息之前、会影响 Agent 判断的关键上下文，尤其是候选人已经给过的城市/区域/商圈、年龄、性别、健康证、学历、可上班时间、岗位/品牌偏好、已拒绝原因、已展示岗位、当前焦点岗位、已预约信息
- 默认不要生成 0-3 行的多轮场景测试；除非这是明确的首轮开场/单轮查岗场景，且 `remark` 必须写明“首轮场景：无历史上下文”或“单轮查岗，事实锚点来自本轮工具结果”
- 对于“已给信息后不得反复询问”“候选人追问/拒绝/确认”“约面字段收集”“岗位硬约束延续”等场景，`chatHistory` 通常应保留 4-10 个关键 turn；必要时保留更多，但只能截到当前用户消息之前，不能把目标答案或后续真人回复塞进去

正式资产复核清单：
- 每条 `scenarioCase` 必须能回答“最后一条用户输入是什么、要验证哪个原子行为、失败判定是什么”，不能只保存一段历史事故描述
- 每条 `conversationCase` 必须能回答“保留整段真实上下文的价值是什么、哪些 turn 是关键观察点、哪些事实只能由本轮工具结果决定、为什么不能降级成 scenarioCase”
- `expectedOutput` 不要写成历史真人回复的复刻稿；如果包含具体门店、薪资、距离、面试时间、库存等事实，必须能追溯到本轮工具调用结果或显式 mock 快照
- 评审弹窗里看到“Agent 调工具生成了当前事实，但期望回复来自历史人工话术”时，优先判定为资产建模问题，先修测试资产或评审提示，不要直接归因 Agent 幻觉
- 资产导入前抽查重复字段和无效字段，例如 `验证标题展示` 与 `验证标题` 重复、默认 `多行文本` 空列残留；正式表结构要保持最少但够用

已有正式资产审计与修订 SOP：
- 用户要求“看飞书里已有测试集/验证集是否适合测试”“review 测试集和验证集”“重写不合适 case”时，读取正式 `测试集 / 验证集` 表，不要只看本地草稿或源 `BadCase`
- 审计输出必须分层：`基本符合 / 需修订后可用 / 不适合直接跑`；不要把“来自 BadCase 策展”误判为不合格，重点判断是否可执行、可稳定评审、边界是否清楚
- `测试集` 审计项：是否有 `caseId / caseName / userMessage / checkpoint 或 expectedOutput`，`chatHistory` 是否足够支撑当前行为，动态事实是否写明以本轮工具结果为准，是否混入后续人工补救或评审文本
- `验证集` 审计项：是否有 `validationId / validationTitle / conversation`，是否至少有 2 个用户侧 turn 和 2 个 Agent/招募经理侧 turn，是否确实需要跨轮状态回放，是否混入后续人工补救、人工评语、目标答案或事故复盘文本
- 验证集角色名不要求固定为“候选人/招募经理”；判断 turn 数时要贴近 `src/evaluation/conversation-parser.service.ts` 的解析逻辑：固定角色名、真实昵称、以及 `CongLingKaiShi...` 等 Agent 名都应被识别。不要用过窄脚本把真实昵称误判成 `U0/A0`
- 缺少 `chatId` 不是 BadCase 策展样本的硬淘汰条件，但 `remark` 必须写明“无 chatId，无法回查生产工具流水”；有动态事实时更要写清工具边界
- 不适合直接跑的常见正式资产处理：单轮问答误入验证集时，降级到 `scenarioCase` 或补写成多轮行为断言；混入后续人工补救时，截断到事故发生前；只能靠历史回复得分时，改成 `期望行为:` 断言
- 批量修订正式资产时，保留原 `caseId / validationId / 来源BadCaseID / 来源类型`，避免破坏血缘；只重写标题、检查点、预期行为、上下文、conversation、remark 等资产内容
- 修订后必须清空旧执行结果：`测试状态=待测试`，清 `最近测试时间 / 测试批次 / 错误原因 / 评审摘要 / 最近执行ID`；验证集还要清 `相似度分数 / 最低分 / 评估摘要 / 事实正确 / 提问效率 / 流程合规 / 话术自然`
- 正式资产里出现手机号、身份证、精确个人隐私时，写入或重写前必须脱敏成测试值，例如 `13800000000`；保留业务语义，不保留真实敏感信息
- 修订完成后要重新全量审计正式表，确认 `问题数=0` 或列出剩余问题；不要只凭更新接口成功就结束

动态事实断言模板：
- `测试集 expectedOutput` 推荐写法：`期望行为：... 具体门店、距离、薪资、岗位要求、预约结果以本轮 geocode / job_list / precheck / booking 工具结果为准；不得复刻历史人工话术。`
- `验证集 conversation` 推荐写法：把历史 Agent 轮写成 `期望行为: ...`，让多轮状态可回放，但不把历史下一句当固定答案
- `remark` 推荐写法：`关键观察 turn：...；动态事实边界：... 只按本轮工具结果评审；无 chatId，无法回查生产工具流水。`
- 首轮话术、单轮查岗、短上下文硬约束这类 case 可以没有长历史，但 `remark` 必须明确“首轮/单轮/短上下文设计”，避免被误判为上下文缺失

在对话里用 markdown 或 JSON 展示全量草稿，等用户确认后再入库。

### Step 7. 用户对话确认

用户会说"这条删""这条改""加一条 xxx"。直接在对话里迭代，不需要飞书、不需要独立审核流程。

### Step 8. 导入 test-suite

test-suite 模块已有 HTTP 接口。端点速查见 `references/test-suite-api.md`。调用前 Read 对应 DTO 文件确认契约。

导入前先确保：
- 本次要导入的内容已经在对话里经过用户确认
- `测试集 / 验证集` 只包含本轮策展后的正式资产
- 不要假设 `BadCase / GoodCase` 会自动同步到正式数据集
- 不要使用 `data/badcase/badcase.json` + `scripts/import-badcase-to-feishu.ts` 生成或导入验证集；该脚本是旧的测试集导入工具，只会写 `testSuite` 表，不能代表验证集资产已生成
- 如果本轮有 `conversationCases`，导入前必须逐条展示 `validationId / validationTitle / 关键观察 turn / 是否有 chatId / 动态事实边界`，并让用户确认

导入时使用：
- `POST /test-suite/datasets/scenario/import-curated`：把 `scenarioCases` 幂等 upsert 到 `测试集`
- `POST /test-suite/datasets/conversation/import-curated`：把 `conversationCases` 幂等 upsert 到 `验证集`

注意：
- 同一 `caseId / validationId` 会更新原记录，不会重复创建
- 如果内容发生变化，系统会把旧的 `测试状态 / 批次 / 分数` 等执行结果清回 `待测试`
- 如果 payload 完全一致，导入应保持幂等，不重复重置
- 导入时会自动同步 `资产关联` 表，不需要手工维护来源关系

### Step 9. 跑测试

调 test-suite 批次执行端点，轮询结果。输出：
- 通过率
- 未通过用例清单 + 失败原因
- 若通过率不理想，回 Step 5 继续迭代

创建测试批次时，`batchName` 只写可读的业务标题，不要带工作流标签：

- 推荐：`2026-04-24 用例测试` / `2026-04-24 场景补跑 bc-xxx` / `2026-04-24 回归验证`
- 避免：`反馈验证 SOP 2026-04-24 用例测试`
- `反馈验证 SOP` 只是操作流程名，不是批次标题的一部分

人工评审时要把“系统记录”和“飞书回写”一起收口：
- 场景测试执行 `PATCH /test-suite/executions/:id/review` 后，应自动把 `测试集` 的 `测试状态 / 最近测试时间 / 测试批次 / 错误原因 / 评审摘要` 回写到飞书
- 回归验证执行 `PATCH /test-suite/conversations/turns/:executionId/review` 后，应自动把 `验证集` 的 `测试状态 / 最近测试时间 / 测试批次 / 相似度分数 / 最低分 / 评估摘要` 回写到飞书
- 回归验证批次统计必须按验证样本聚合 turn 级评审：任一 turn 人审失败则整条验证样本失败，任一 turn 待评审则整条验证样本待评审；不要只用平均相似度判断整条样本通过
- `pass_rate` 在回归验证里代表平均相似度，不等同于通过率；对用户报告时同时给出 `通过样本数 / 失败样本数 / 待评审样本数`
- 批量评审/批量执行后必须做全量对账，不要只抽样：`测试集` 记录数和本地 `test_executions` 去重 case 数一致，`验证集` 记录数和本地 `test_conversation_snapshots` 一致，且没有 `待测试` 残留
- 如果发现本地已完成但飞书仍是 `待测试`，先按本地批次结果补写飞书，再回写源 `BadCase` 状态；不要基于未对齐的飞书状态更新样本池
- 如果飞书字段已更新但线上页面没变，不要误判为回写失败；`https://cake.duliday.com/web/test-suite` 读的是生产 test-suite 数据库，不是飞书表

评审弹窗展示信息时，优先使用 test-suite 当前执行记录里已经稳定保存的上下文：
- 用户消息 / 历史上下文 / 预期输出 / 实际输出 / 工具调用 / 人工评审状态与备注
- 只有当正式资产能稳定关联到源 `chatId / messageId` 时，才再深挖 `message_processing_records`
- 不要默认把生产消息处理流水整段塞进评审弹窗；否则容易混入不属于测试执行的数据噪音

如果用户明确要求把结果同步到线上页面 `https://cake.duliday.com/web/test-suite`，不要只停留在测试环境数据库或飞书回写：
- 先确认批次评审状态已经稳定
- 再运行 `pnpm sync:test-suite:prod -- <batchId...>` 把这轮批次同步到生产 test-suite 数据库
- 该页面的数据源是生产库里的 `test_batches / test_executions / conversation source`，不是飞书表本身

### Step 10. 回写反馈样本池状态

跑完测试后，必须把本轮涉及的源 `BadCase / GoodCase` 样本收尾回写；不要只更新 `测试集 / 验证集 / 资产关联`。

回写源样本池前必须先确认正式测试资产已全量对齐：
- `测试集` 中本轮 `来源BadCaseID` 对应记录不应再停留在 `待测试`
- `验证集` 中本轮 `来源BadCaseID` 对应记录不应再停留在 `待测试`
- 只有 `测试集=通过` 且 `验证集=通过` 的源样本才能写 `已解决`
- 如果场景测试已通过但回归验证失败或低于阈值，源 `BadCase` 写 `待验证`，并在 `修复说明` 中写明失败批次和需要人工复核

BadCase 推荐状态流转：
- 刚收集、尚未分析：`待分析`
- 已确认问题但未修：`待修复`
- 正在修代码 / prompt / 工具：`修复中`
- 修复已完成、测试还没跑：`待测试`
- 测试已跑但还需人工确认：`待验证`
- 定向测试/回归验证已通过，或已确认无需继续处理：`已解决`
- 样本已失效：`已过时`

回写字段优先级：
- `状态`：按上面的状态流转写入
- `根因层`：`prompt / stage / tool / data / memory / workflow / policy / unknown`
- `修复说明`：写清修复文件/策略、正式用例 ID、验证批次 ID、是否有残余风险
- `最近复现时间`：本轮最终验证或复跑时间
- `复现次数`：只有本轮确实统计过复现次数时再写，不要编造

如果本轮导入了正式资产，应在 `修复说明` 里写明 `caseId / validationId / recordId / batchId`，因为源样本池本身不一定有专门的关联字段；正式血缘关系仍以 `资产关联` 表为准。

### Step 11.（可选）广播

询问用户："要不要把这次分析+修复+验证结果发飞书群？"

是则使用飞书告警 service（`src/infra/feishu/`）发 markdown 消息。

## 判断边界

**你被期望做**：
- 判断对话好坏（招聘语境 + 业务常识）
- 归类问题模式，自己命名
- 读代码定位、改代码
- 生成测试用例并根据用户反馈迭代

**你不要做**：
- 不要跳过 Step 4 / Step 7 直接改代码或入库——用户需要审查闸门
- 不要把 `BadCase / GoodCase` 当成正式测试资产表，它们只是样本池
- 不要依赖任何手动勾选字段来决定是否进入 `测试集 / 验证集`
- 不要硬编码红线清单；业务规则在 `src/biz/strategy/`，要用时去读
- 不要把 SQL 原始结果直接丢给用户——先按 chat_id 聚合成对话流水再分析
- 不要在任何文件里写 `API_GUARD_TOKEN` 的值
- 不要把 `agent_invocation` 列拉出来——90% 是重复 system prompt，爆 context 还没信息量

## 参考文件

- `queries/latest-chats.sql` — 生产对话抽样 SQL，Step 1B 直接用
- `references/schema.md` — 两表字段含义 + anomaly_flags / tool_calls / memory_snapshot JSONB 结构
- `references/test-suite-api.md` — test-suite 端点速查，Step 8/9 用
- `docs/workflows/feedback-repair-test-validation-v2.md` — 反馈修复测试验证链路 V2，定义样本池、正式测试资产和血缘关系边界
