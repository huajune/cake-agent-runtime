# 记忆体系 CoALA 对齐（上下文治理二期）

> 状态：**二期收官（2026-08-21 用户"一口气执行到底"批准后当日完成）**——M1 关闭（观察项）、M1-B ✅、M2 ✅、M2-B ✅（DB 迁移测试库已验、生产随发版）、M2-C ✅、M3 ✅；M4 观察项。
> **M5 追加批（2026-08-25 已完成）**：短期结构定格与咨询生命周期对齐——收官后用户审树重开的结构议题（五乱源 + 层合并两问）逐条裁定，见工作包 M5。
> 理论基础：[principles/context-engineering-principles.md](../principles/context-engineering-principles.md)（C1~C9）+ [glossary](../principles/glossary.md)「CoALA 记忆四分法」词条 + CoALA（arXiv 2309.02427，见 [industry-sources](../principles/industry-sources.md)）。
> 一句话：**一期给程序记忆减肥，二期给程序记忆上户口**——让 procedural 层享受与情景/语义层同等的记忆治理待遇。
> 续篇：三期（上下文装配编译器，2026-08-24 设计）在 [context-assembly-compiler.md](./context-assembly-compiler.md)——二期管"记忆住哪、叫什么"（存储侧），三期管"记忆怎么编译进 prompt"（装配侧），互不重开对方议题。

## 一、背景与动因

CoALA 对照复盘（2026-08-21，结论已录治理方案行业对照第 5 条）：本库四层记忆**功能完备**（settlement ≈ consolidation gate、无向量 RAG 是裁定非缺口），但存在一处命名错位与一个结构盲区：

**待遇差异表**（二期要抹平的东西）：

| 记忆类型 | 容量控制 | 压缩/沉淀 | 按需加载 |
|---|---|---|---|
| 情景（聊天窗口/摘要） | ✅ 120 条/24K 字符 | ✅ settlement | ✅ recall_history |
| 语义（facts/档案） | ✅ schema+cap（P1-3 补齐） | ✅ 沉淀+整组覆盖 | 部分 |
| **程序（手册/description/DB 策略）** | ✅ 一期补：台账+膨胀哨兵 | ✅ 台账批次删减（procedural refinement） | ✋ 裁定不做（M1 关闭，2026-08-21） |

命名错位：`procedural.service.ts` 存的是 currentStage（流程书签，process state），行业 procedural memory 指"怎么做事的知识"——已登记 glossary，二期 M2 搭车改名。

## 二、工作包

### M1 程序记忆分层供给 → **✋ playbook 抽取裁定关闭（2026-08-21 用户拍板），降为观察项**

- **关闭裁定**：净收益核算为负——① C8（造假引导）用户裁定**留常驻**（诚信红线，拉取失败=教唆造假级事故，~800 字符常驻代价可接受）；② 剩余候选段（截图簇 P2/P4/P5、结伴分流、C7 后半）合计仅 ~2K 字符，却需两套机制（模型拉取 + 代码条件注入）+ 新工具 description 常驻 + 拉取失败新风险——用户裁定"这么复杂不如不抽取"，采纳。
- **程序层的实际待遇维持一期机制**：容量=台账+膨胀哨兵；沉淀=台账批次删减循环（即 LangMem 语义的 procedural refinement，一期已运转）；按需加载=**裁定不做**（本条即裁定记录）。
- **观察项（重启条件）**：手册再度膨胀触发哨兵告警、或出现新的大块低频规程（>3K 字符且触发率低）时，重启 playbook 评估——届时沿用本节留存的设计约束：注册表+确定性加载统计做退役、禁止 LLM 定期重写（社区警示 arXiv 2607.26637："持续用 LLM 重写记忆库会退化到低于无记忆基线"）、拉取内容进 messages 后缀不碰前缀缓存（C5）。

### M1-B 程序记忆的逻辑收拢（索引 + 互链，2026-08-21 设计，**待批准执行**）

用户观察：procedural 层物理分散（手册/description/状态机/DB 策略），代码组织未体现认知轴。设计裁定：

- **物理分散维持**——它是判定树的正确后果（规则贴消费者，反口径漂移；B2 漂移实证恰因规则离工具太远）；业界同构（CLAUDE.md/skills/AGENTS.md 均就近散布，无"程序记忆总目录"实践）；程序记忆是横切关注点，标准解法=注册表+纪律，非物理归拢。
- **补齐逻辑视图**：① 台账升格为「程序记忆索引」（procedural memory index）——定位声明改写，成为该记忆层唯一总目录（容量/沉淀/放置治理的挂载点）；② 六居所头部加自我声明锚注（手册/final-check/各大 description/booking 共享规则各一行注释指回台账）——认知轴在代码里**可导航**。
- 改动面：台账文首定位段 + 约 6 处一行注释，零行为变更。

### M2 命名对齐（搭车批）

- ✅ **改名已执行（2026-08-21，用户裁定不等搭车直接改）**：`procedural.service/types` → `stage-state.*`，类/类型/字段全量（StageStateService/StageState/stageState），18 文件；Redis key（本就叫 `stage:`）与 test-suite fixture 契约键 `setup.procedural` 保留兼容；README/CLAUDE.md/glossary 同步；typecheck + 2,958 测试绿。
- **改名范围裁定（2026-08-21）：只改"程序记忆"这一处，不做 CoALA 全量改名**。依据双轴框架：短期/会话/长期是**生命周期轴**命名，语义准确且 short-term/long-term 本身就是行业标准词（会话记忆混含事实+工作台，改成 semantic 反而不准确）；唯独"程序记忆"是**冒用知识类型轴行业术语**装生命周期内容的真错位。全量改名 = 把准确的生命周期名换成不准确的类型名，且违反"搭车改名不专车改名"规约。
- ✅ **settlement → consolidation 已更名（2026-08-21，用户复议后执行）**：复议发现与薪资结算域同词冲突（settlementPeriodList/结算周期守卫），同库双义过"误导"门槛——与 procedural 同性质。env 键与 DB RPC 名保留兼容。
- **改名门槛口径（本轮定稿）**：改名标准是"名字错误或误导"（错位/同库冲突），不是"与行业分类词不同"。长期层内容名（profile_facts/preference_facts/summary）**不改**——内容名信息量大于类别标签、业界 store 也按内容命名、且为生产表列名；类型词汇只用于文档归类与**新增实体**命名（playbook 库 → procedural-*）。
- **业界命名轴查证（2026-08-21，LangGraph/LangMem 分类法）**：主流是**复合轴**——顶层按生命周期/作用域（short-term thread-scoped / long-term namespace），长期层内部才按知识类型分 semantic/episodic/procedural；没有主流框架用类型轴做顶层目录（Letta 用 OS 存储层级轴、Mem0 用 scope 轴）。本库顶层命名与业界同构，"只修错位不全改"裁定获行业形态追认。LangMem 将 procedural 定义为"可随反馈精炼的系统指令"——从源头追认"手册=程序记忆"与台账批次删减循环（=procedural refinement）。
- **M3/M1 命名指引（由此新增）**：分家与 playbook 落地后，**长期层内部采用类型词汇**——profile/preferences 归 semantic、summary 归 episodic、playbook 库归 procedural——达成"顶层生命周期、层内类型"的 LangGraph 完整形态。

### M2-B 长期层 CoALA 结构分组（A3）——✅ **已执行（2026-08-21，含 DB 迁移测试库验证）**

> 执行记录：类型全量（JobIntentFacts/SessionSummaries/SemanticMemory/EpisodicMemory/LongTermMemory/WorkingMemory 抽独立文件）；运行时 `longTerm.semantic.{profile, jobIntent}` 分组；DB 三列迁移 `20260821210000` 已推**测试库**并通过**三 RPC 真实写入回读验证**（置信度守卫 written/skipped 语义完好、摘要追加 bySession 水位正确）；生产 push 随下周发版同批。

用户裁定：命名对齐行业分类词本身就是目标（推翻此前"仅错误/误导才改"口径，原口径划线保留于 M2 节）。经三轮讨论定稿的目标形态：

```ts
interface LongTermMemory {
  semantic: {
    profile: UserProfileFacts;          // 字段短名（上下文已限定主体）+ 类型全名（全局命名空间需限定）
    jobIntent: JobIntentFacts;          // 原 preference_facts——软偏好/硬约束/时间可用性混装，
                                        // "preferences" 软语义曾与通融式推荐 badcase 同向误导，更名对齐域词"求职意向"
  };
  episodic: {
    sessionSummaries: SessionSummaries; // 原 SummaryData——修正单复数失实（实为按会话分段的摘要集 recent[]+archive）
  };
  // procedural 分组——仅当 playbook 观察项重启并落地时加入，不预留空槽
  origin?: { fromOtherConversation: true };
}
```

**设计裁定记录**：
1. A3 结构分组（用户选定）：分类词住结构层、内容词住叶子层，双轴都可见；episodic 单成员也包对象——对称性 + M4（relevantEpisodes）等可预见扩展位；
2. 排除项：字段名不用 userProfile（口吃式冗余）、不用 candidateProfile（memory 模块 API 是 userId 口径，换词造成主体混用）、episodic 叶子不叫 episodes（原始 episode 在 chat_messages，此处是蒸馏摘要）；
3. **B2 DB 列迁移随发版同批**：`profile_facts→semantic_profile`、`preference_facts→semantic_job_intent`、`summary_data→episodic_session_summaries`，含两个 RPC 函数 DROP+CREATE；migration 先推测试库验证，生产 push 与下周发版严格同批（仓库纪律：只推迁移不发代码=事故源）；
4. 范围：限长期层内部；顶层四层名（短期/会话/长期/阶段状态）维持不动（业界复合轴同构，见 M2 查证）；
5. 执行纪律：全库测试 + typecheck 一步不省（settlement 批的教训：域内测试不够，误改薪资域枚举靠全库回归才兜住）。

**M2-B 追加项：Working Memory 类型命名（2026-08-21 设计，待批准与主体同批执行）**：
`PreparedAgentContext` → `WorkingMemory`——prepare() 的产物（finalPrompt + promptBlocks + normalizedMessages + tools）正是 CoALA 语义的本轮工作记忆本体，泛名换精确分类名；**不改** `preparation.service`/`prepare()`（流程阶段名，且职责超出装配——booking 上下文/群资源/账号身份/阶段解析均在内，服务改名会让部件独占概念）；**不改** `finalPrompt`（内容名准确，是成分非全体）。类型注释标注边界：覆盖初始装配，回合内经 prepareStep 的工具结果增长在 generator 侧。

**M3 登记项（随本设计新增）**：① jobIntent 内部软/硬/时间三分（preferences/constraints/availability）——软硬分离在结构上根治"硬约束被当偏好淡化"的暗示，与 M3 分家同性质合并做；② `lastSettledBySession`/`lastSettledMessageAt` 是 consolidation 水位簿记，混在摘要数据里名实有瑕，M3 一并考虑挪位。

### M2-C memory 模块目录按生命周期轴重组（2026-08-21 设计，**待批准执行**）

用户观察：services/ 平铺，目录结构未体现四层结构图。目标：代码树 = 结构图。

- ~~混合形态（防过碎：单件层留 services/ 平铺）~~ **二次修正（2026-08-21 用户审树后裁定：一致性 > 防碎）**：混合形态执行时走了样——"平铺"被放进 services/ 子目录而非模块根，使 services/ 沦为语义空洞的第五分类（两个层 + 两个跨层服务混住，与 session/、long-term/ 层目录不同深不同义）。终态改为**四层全对称目录**（short-term/、session/、stage-state/、long-term/，各带自己的 types），跨层服务（lifecycle/enrichment）平铺模块根，services/ 目录取消；types/ 仅留跨层的 memory-runtime 与 confidence-rank。
- 留根部/共享位：facade（memory.service）、lifecycle（跨层编排）、stores/、formatters/、memory-runtime.types（跨层）。
- **图上三悬空元素的组织落点（2026-08-21 追加设计）**：
  ① **Working Memory 立目录**：`src/agent/generator/working-memory/` = preparation.service + working-memory.types（原 PreparedAgentContext）+ 原 preparation-utils/* 全部迁入——装配车间整体归位；
  ② **procedural 的 prompt 侧物理仓**：`context/prompts/` → `context/procedural/`（该目录本就只装手册+final-check，即 prompt 侧程序记忆；工具描述/DB 策略仍就近散布由 M1-B 互链覆盖）；
  ③ **两舱落到文件级**（M3 范围升级）：session.service 拆 `session/facts.service.ts`（事实舱）+ `session/workbench.service.ts`（工作台舱）；brand-state 归事实舱域、candidate-snapshot 归工作台域。
- 性质：纯 git mv + import 路径更新，零行为变更（M3 拆分除外——拆分是结构改造走 M3 批）；先例=工具层目录终态重排（cdd173a2，"散件跟主人走"）；全库测试 + typecheck 闸。

### M3 会话记忆"事实/工作台"分家——✅ **已执行（2026-08-21）**

- 实现形态：`session/facts.service.ts`（事实舱=状态所有者：状态存取/事实读写/LLM 提取/已发生事件——**invitedGroups/terminal/活动水位按裁定归此舱**）+ `session/workbench.service.ts`（工作台舱：candidatePool/presentedJobs/**currentFocusJob**/lastJobListQuery，状态 IO 经事实舱）+ **SessionService 保留为薄 facade**（1:1 委托，公共 API 不变——26 个跨域注入点零波及，与 memory.service facade 惯例同构）。
- 验证：全库 6,768 测试 + typecheck 0 + lint:check 全绿（含 eslintrc 豁免路径随文件搬家同步）。
- 遗留登记（不在本批）：jobIntent 软/硬/时间三分、consolidation 水位簿记挪位——等收资契约 v2 或下次记忆域批次；`active_booking` 冻结区未触碰。

### M5-深审：两个智能点（2026-08-25，框架完工后的细节专项）

> 执行结果：实锤五条全落（含追加发现的 RPC 水位原子性修复）；archive 追加化曾作为过渡态落地，随后由裁定四整体裁撤；brand_ids 审计结论=**三通道各有实职维持现状**（多品牌 ID 工具参数通道，退役条件见审计文档）；gender_source 审计结论=**化石但承重**（预填安全闸，三步迁移路径登记，不可直删）。审计详情：[memory-intelligence-deep-review-audit.md](./memory-intelligence-deep-review-audit.md)。裁定一与裁定四均已于 2026-08-25 完成。

> 对象：extraction.prompt.ts（会话事实生产线）与 consolidation.service.ts（长期蒸馏炉）——全库仅有的两处 LLM 参与记忆写入的地方。查证式深读，实锤与裁定如下。

**背景事实（查证 2026-08-25）**：收资批已将轮末抽取职权收窄为"表单外软事实"（preferences/brand_intents/labor_form_intent），身份资料唯一写入口 = `saveCompletedCollectionFacts`（仅 booking 办结调用、仅收 high 信封）。sessionFacts 与收资表单是**交集关系互不包含**：交集=身份类字段（CandidateFieldKey 同词表、两种投影：办理格 vs 事实信封）；表单独有=契约自定义槽位；sessionFacts 独有=preferences+brand。

**实锤修复清单（无歧义，随批执行）**：
1. consolidation 摘要失败写占位符 `（摘要生成失败）` 且照推水位 = 永久静默丢失，违反第 3 条护栏——改 throw 交 Bull 重试（事实写入幂等）；
2. compressArchive 失败 fallback 旧 archive = 溢出摘要静默蒸发——同款改 throw；
3. `mergePreferences` 同值复述刷新 extractedAt（incoming 无条件覆盖 + [已有偏好] 注入邀请回声）——污染三期 3.7 新鲜度决胜；修法：merge 层用 isSameFactValue，**同值保留旧信封**；
4. 摘要 prompt 升级：固定骨架（求职目标/关键约束/进展与结果/未决事项）+ 保留可检索标识符（jobId/门店/日期）——"压缩必须可恢复"落地；超 120 条尾段截断须在摘要条目标注；
5. 回归测试钉死 `saveFacts` 的 interview_info 整体替换疑点（booking 写 high 后跑一轮纯偏好抽取，身份不得被冲）；死参数（_turnHints/_toolFacts/退役 provenance corpus）收口。

**裁定一（2026-08-25 用户拍板）——未成单保底走方案 a**：收资表单**逐格回流**——每落一格以 medium 信封写 sessionFacts（写入者仍是收资域），办结统一升 high；consolidation 提拔链路从此真实存在（此前"办结才回流"使半途弃单字段随表单消亡，即用户复议时指出的记忆丢失）。归收资契约 v2 批执行，与该域"勿抢跑"裁定对齐后动工。

**裁定二（待拍，推荐追加化）**：archive 从"LLM 全量重写 blob"改**追加段列表**——每次只压新溢出为一个新段，已有段冻结（复印件代际退化归零，arXiv 2607.26637 警示；event-sourcing 同构；封顶用确定性淘汰最老段，不用 LLM 重写）。备选=限频重写（退化变慢不消失，不推荐）。

**裁定四（2026-08-25 经完整讨论后用户拍板）——SessionSummaries 单层化 + 水位搬家——✅ 已完成（2026-08-25）**：

- **目的定位（讨论定稿）**：消息窗口管近 7 天原文，episodic 管 7 天之外的历史摘要，两者拼成完整记忆；一条简单摘要即可，不做结构化落点/自动注入等扩展（场景①登记为产品侧未来项）。
- **结构**：`episodic.sessionSummaries: SummaryEntry[]`——recent/archive 二分**取消**（个人助手无界记忆样板误植到有界咨询域；生产实证 archive 非空仅 20/13,830 行），且 **SessionSummaries 包装类型整体退役**（2026-08-25 追问定稿：壳的存在理由是曾装 recent+archive+水位三样，水位搬走 archive 裁撤后只剩单字段，壳删、字段直接为数组；DB 列 JSON 同步为裸数组，旧形状懒迁移）。组名 episodic 与叶子名 sessionSummaries 均按 A3 裁定保留（单成员组=对称性+扩展位；叶子不叫 episodes=此处是蒸馏摘要非原始 episode）。**滚动单条方案否决**（每次沉淀重写全文=复印件退化+时间线压扁+失败恢复复杂化）；已写入条目永不再被 LLM 触碰。
- **容量**：上限 20 段、确定性淘汰最老。回头客论证：年 4~6 回 × 150 字 = 20 段可装 3~5 年完整履历；archive 合并反而糊掉回头客最值钱的时间线演变。淘汰损失趋零（semantic 档案与意向快照仍在）。
- **60 天硬约束**：chat_messages 仅保留 60 天（DATA_CLEANUP_CHAT_DAYS）——预计算摘要是 60 天外唯一 episodic 痕迹，**用户裁定失忆不可接受**，沉淀时预计算保留（写侧成本=保险费，按需现算方案否决）。
- **水位搬家**：lastSettledMessageAt/lastSettledBySession 是 consolidation 的工作书签非记忆内容，迁出摘要结构 → 独立 jsonb 列 `consolidation_watermarks`（M2-B"名实有瑕"登记清账）；RPC 同名 DROP+CREATE，一条 UPDATE 原子写两列（追加 episode + 推水位），失败整体不动——昨日的"失败恢复现场"补偿逻辑随之删除。
- **存量与契约**：旧 recent 反转并入裸数组、旧 archive 段转无标识符 entry 插入头部、旧水位迁新列，全部读边界懒迁移；`episodic_session_summaries` 列名不动（episodic 层仍在）；新迁移已推测试库并完成真实写入回读验证，生产与 M2-B 列名迁移同发版。
- **类型边界（2026-08-25 追问定稿）**：三个类型三种命运——`LongTermMemory`（记忆聚合，召回面）**不含水位**、维持 A3 嵌套形态（运行时用结构表达双轴，DB 用前缀表达同一双轴，是一个设计的两种投影，不拍平）；`ConsolidationWatermarks` 独立类型，仅 consolidation 管线消费，永不召回注入；DB 行形状（四列俱全）只活在 supabase.store 存储适配层，行 ≠ 记忆。

### M4 观察项（登记不承诺）

- 跨会话相关片段检索（episodic 的 relevance 取路，CoALA 图中 "RAG for relevance"）：单人数据量小、settlement 摘要已粗粒度覆盖，暂不做；记录于此防遗忘，若未来出现开放域知识（岗位知识库问答）再评估。

### M5 短期结构定格：咨询生命周期对齐——✅ **已完成（2026-08-25）**

> 缘起：收官后用户审树重开——五个残留乱源 + 两个结构问（"stage-state/session-state 为何分开""short-term 为何只有聊天记录"）。经作用域勘定逐条裁定定格。方法论修正：行业词（short-term/long-term/CoALA 类型词）保留为顶层名与 glossary 学习地图，**不再硬套**——层语义以本库自己的 key 维度与 TTL 数字为准。

**作用域勘定（2026-08-24 查证）**：代码 session = chatId = 候选人×bot 关系（无限期存续）；业务"会话" = 咨询段（闲置间隙划界）——**session 双义登记 glossary**。原 2d TTL / 1d 沉淀间隙使跨咨询段记忆滞留 short-term（配置注释明言"隔天回来仍有 facts"是设计意图），且旧段"既在窗口又已沉淀"的层间时间重叠是混淆根因。完整作用域梯五档：轮（working-memory 现编不存）、咨询段（无存储层，仅计算边界：trimToCurrentSessionSegment 防串味 + consolidation 蒸馏单位）、chat 关系（short-term 实际所在）、候选人×bot 关系的长期档（long-term——原跨 bot 共享，第 8 条追裁改为不共享；候选人跨 bot 维只存在于业务系统）、租户/全局（strategy_config/手册/sponge，各归其域）。

**裁定与终态**（用户 2026-08-24 逐条拍板）：

1. ✅ **顶层保持 short-term / long-term**（完成：2026-08-25）；short-term = **一个咨询生命周期**的伞目录。层内两档 TTL：message-window 7 天（故意比会话长——回访可召回原文），其余会话状态 3 天；TTL 归属写在 short-term.types 分节注释与 README，不靠文件名前缀表达（~~08-24"session- 前缀=3 天组"约定~~随扁平化裁定作废）：

```
src/memory/
├── memory.service.ts / memory.module.ts / memory.config.ts   # ① 模块同名三件（NestJS 惯例）
├── lifecycle.service.ts / enrichment.service.ts          # ② 跨层编排两件（原 memory- 前缀结巴修复；类名保留全称）
├── recall.types.ts                                       # ③ memory 对外召回契约单一文件（2026-08-25 合并裁定：主链 MemoryRecallContext
│                                                         #   **召回形状镜像两层结构（08-25 追加）**：shortTerm{ messageWindow, sessionState, stage }
│                                                         #   + turnHints（轮 sidecar）+ longTerm{ semantic }——旧顶层并列形状退役；
│                                                         #   会话 hash 字段正名为 sessionState；episodic 摘要按需走
│                                                         #   recall_history 不进默认召回（注释说明不留空槽，A3 先例）
│                                                         #   + 复聊 ReengagementSessionState 两节合一；前身 memory-runtime.types（"runtime"泛名退役）
│                                                         #   与 reengagement-recall.types（原 reengagement-session-state.types，08-24 查证为
│                                                         #   recallForProactiveFollowUp 消费契约归根）；类型名全部不动。根部四组韵律：
│                                                         #   同名三件/编排/契约/共享件，每组≤3 文件各答得出"你是哪组的"
├── confidence-rank.ts / fact-lines.formatter.ts          # ④ 跨层共享件（词表+格式化；消费方查证：跨层+跨模块属实）
├── short-term/                    # ═ 一个咨询生命周期 ═ 内部一律平铺（2026-08-25 扁平化裁定，见下）
│   ├── short-term.types.ts        # 单一类型文件 = 结构的唯一表达处（原 session-facts/message-window/stage-state 三处类型合一，
│   │                              #   分节：窗口 / SessionFacts 信封（含 brand 域字段）/ 工作台与阶段 / hash 总契约 WeworkSessionState）
│   ├── message-window.service.ts  # 原始消息窗口，7 天（类 ShortTermService→MessageWindowService）
│   ├── session-state.service.ts   # 结构化状态薄门面，3 天（原 session.service；类→SessionStateService，27 注入点机械改）
│   │                              #   2026-08-25 正名：旧 semantic 门面名退役——其罩不住 workbench（working 态），
│   │                              #   且类型词按方法论裁定退出文件名；现名对齐其拥有的 hash 契约类型 WeworkSessionState
│   ├── facts.service.ts           # 事实舱：状态所有者/事实读写/提取编排/已发生事件（M3 职责不动）
│   ├── workbench.service.ts       # 工作台舱：候选池/已展示/焦点岗位/查询签名 + 阶段指针（原 stage-state 并入，2026-08-24 追裁；
│   │                              #   advance_stage 单写入口不变；Redis key `stage:` 与 fixture 键 `setup.procedural` 规约 4 保留；StageStateService 类退役）
│   ├── brand-state.service.ts     # 品牌写路径（reducer 唯一写者；brand 并入 SessionFacts 见第 8 条，文件独立仅剩行数工程理由）
│   ├── extraction.prompt.ts       # 事实生产线的 prompt
│   └── session-key.ts             # 本层 Redis hash key 唯一构造
├── long-term/                     # 与 short-term 同构（服务平铺 + 单 types）：long-term.service + consolidation.service + long-term.types
│                                  #   semantic{ profile, jobIntent } + episodic{ sessionSummaries }（A3 结构不动）
└── stores/                        # memory 自用底座与长期层域店（redis.store / deep-merge / store.types / supabase.store）
                                   #   collection-form.store 已随域迁出 tools/collection（2026-08-25 存储宪法修正，见下）
```

   **collection-form 全套迁出 memory → `src/tools/collection/`（2026-08-25 终裁，含存储宪法修正）**：辩经定论——"保管的会话状态"正主是 session hash（SessionStateService 名下），收资单据不在其中、不经门面、不进召回注入、消费方全在工具侧，实为收资状态机的工作单据。**存储宪法修正（用户裁定）**：~~"会话态持久化归 memory 垄断"~~过宽——① resolution 永远零 IO（判定纯函数层，公证处不管仓库）；② **memory 只存记忆系统自己的东西**（窗口/session hash/长期档——supabase.store 与 redis.store/deep-merge 自用底座留下）；③ **各域单据自持存储**（用 infra Redis 底座，TTL 自配——收资默认 3 天，与会话对齐是口径不是耦合）。据此 service **与 store** 一并迁 tools/collection（~~08-25 早间"store 留 memory"半切方案~~同日推翻）；"丢了算事故" key 清单是文档制度不受搬家影响，key 照登。终版分工：**resolution/collection 判定（纯）· tools/collection 流程+单据存取（全）· memory 与收资零瓜葛**。key 补维议题仍归收资契约 v2。

   **归属判据四句（2026-08-25 与用户对齐定稿；README 收尾批带入正式文档）**：纯判定 → resolution；只活在工具调用边界内的动作与状态机 → tools（"给大模型提供工具"只是门面，tools 完整定义 = Agent 动作层：模型可见契约 + 确定性实现体，收资状态机即"代码化的 procedural"，业界对应 12-Factor "Tools are structured outputs"）；跨回合持续的记忆与 session hash 管辖状态 → memory；业务数据所有权 → biz。域是纵向切片、层是横向网格，同名目录（如两处 collection/）= 一个域在不同层的切片，隔开的实证依据：resolution/collection 有守卫/候选人域/海绵/岗位渲染四个流程外消费方。

   **扁平化裁定（2026-08-25，推翻 08-24"两舱升格子目录"）**：层目录内一律平铺——**目录承载作用域，结构由类型文件承载**（short-term.types 内 WeworkSessionState→SessionFacts→… 的类型嵌套即结构图，比目录精确且免人肉维护）；两文件目录与舱子目录全部撤销；短期/长期两层同构（N 服务 + 1 同名 types），恢复"每层一个同名 types"韵律。舱概念不消失：降级为文件名前缀（facts.* / workbench.*）+ M3 服务职责拆分。原"类型拆分"工作取消（拆分改合并，active_booking 冻结区风险随之消失）。
   tests/ 按镜像原则同步：`tests/memory/short-term/` 平铺。

   **类型词落点映射（2026-08-25 定稿；README 收尾批带入正文，glossary CoALA 词条同步）**——对齐的正确形态是"映射可查"而非"改名换姓"，每个类型词只住在"恰好装满"的那一级：

   | CoALA 词 | 落点 |
   |---|---|
   | episodic 原料 | message-window（+ chat_messages） |
   | semantic | facts 舱（会话内）+ long-term.semantic{ profile, jobIntent }（跨段） |
   | working | workbench 舱（含阶段指针）+ generator/working-memory（每轮现编） |
   | episodic 蒸馏 | long-term.episodic{ sessionSummaries } |
   | procedural | 不在 memory：手册 / 工具 description / 收资状态机（tools/collection），台账做索引 |

2. ✅ **时间对齐**（完成：2026-08-25）：`MEMORY_SESSION_TTL_DAYS` 2→3、`MEMORY_SETTLEMENT_GAP_DAYS` 1→3——**episode 边界 = 状态生命周期**，层间重叠消除。7d/3d/3d 三个数写进 README 层定义；"短期 ≠ 单次咨询"（窗口跨段是设计意图）明示。
3. ✅ **沉淀改定时触发**（完成：2026-08-25；"3 天自动沉淀"）：不等回访——每回合结束注册/刷新 delay≈3d 的沉淀 job（同 debounce 模式），触发时校验闲置确实达标；幂等靠 `lastSettledBySession` 水位。**防丢护栏（用户点名踩过的坑）**：facts TTL 加余量（3d+12h）保证沉淀读取先于过期；沉淀失败重试 + 告警落观测（不许静默）；README 警句"facts 过期则长期画像字段不会恢复"随本批改写为"定时沉淀保证读在过期前"。
4. ✅ **long-term profile 的定位与写入**（完成验证：2026-08-25；复议改定，~~08-24"只记报名级"收窄~~已推翻）：长期记忆的定位是**从聊天中尽可能多地沉淀信息供模型使用的召回底座，不是公证档案**——正确性由字段信封（confidence/source）表达，消费侧分级把关（工具上下文只 unwrap high 不变；prompt 全量注入带置信度标注，低置信由模型自行判断追问）。据此 `semantic_profile` 保持**双写入路径**：① consolidation 从 sessionFacts 提拔身份字段（**原步骤保留**，透传原章通常 medium）——未成单候选人的已收信息不因 3 天 TTL 丢失（08-24 收窄方案的记忆丢失缺陷即此，复议动因）；② 报名成功 booking 写入（high）——**最高置信来源而非唯一来源**；置信度守卫合并保证高置信粘住、低不覆盖高。jobIntent 快照与 sessionSummaries 不变；存量不清洗。**收资表单沉淀处置**：单据本体不沉淀（3 天过期作废，"重开表是预期"）；字段值经 saveCompletedCollectionFacts→sessionFacts→consolidation 以 medium 沉淀进 profile，回访带值求证复确认可经 EXPLICIT_UPGRADE_FIELDS 升 high，报名成功则直接 high 写入。
5. ✅ **ruleFacts 更名 turnHints**（完成：2026-08-25；用户裁定：与 facts 区分度差）：运行时字段/类型更名；名字表达轮作用域 + hint 零权威轴（glossary hint 命名规约），"规则高置信但未过回合末验证管线"写进类型注释；prompt 标签 `[本轮解析线索]` 等按规约 4 保留；三期编译器 source 本就名 turn-hints，天然同构。
6. ✅ **组装时冲突裁决指针**（完成：2026-08-25）：long-term semantic vs 会话 facts、turnHints vs facts 的实现归三期编译器：[context-assembly-compiler.md](./context-assembly-compiler.md) 3.7，已由用户逐条裁定，M5 仅登记指针，本批未改三期代码。
7. ✅ **long-term 跨 bot 不共享**（完成：2026-08-25；2026-08-24 追裁）：长期记忆键加 bot 维（原 `(corpId, userId)` 跨 bot 共享 → 候选人×bot 关系维）——memory 模块整体成为**关系维记忆**：两层同轴，只按形态（原料/蒸馏）与寿命（3d/持久）区分；候选人跨 bot 的业务事实仍走业务系统（ops_events/带外工单核验），不受影响。**随之退役**：跨会话来源研判 `detectCrossConversationOrigin` + `[历史背景｜来自此前咨询]` 泛指口径渲染（同关系内"上次咨询"是自然语境）；originSessionId/originBotId 血缘的跨 bot 归因用途降级为排障字段；`lastSettledBySession` 多会话水位退化为单会话。**执行决策两项**：① bot 标识选型对齐「换 wxid 致账号裂两行」已知坑（imBotId 会轮换），须用稳定维度，执行时查证；② DB `agent_long_term_memories` 加 bot 维列 + 存量处置——有血缘的按 originBotId/bySession 拆分归属，无血缘存量降级只读或冻结，先探数据量再定。Redis 缓存 key 加维（新 key 起用、旧 key 自然过期）；memory.service 长期 API 补 bot 入参。收资表单 key 无 bot 维的同类问题并入「收资契约 v2」议题（本裁定增强其补维一致性论据）。
8. ✅ **brand 并入 SessionFacts 结构**（完成：2026-08-25；2026-08-24 追裁）：顶层 `brand_state` 与 facts 平级是品牌改造的迁移债，品牌真相是候选人事实，归 SessionFacts 域字段，**字段名定为 `facts.brand`**（2026-08-24 追裁：`_state` 后缀在顶层平级时代的区分职责由类型名 PersistedBrandState 承担，字段回归内容词；改名搭懒迁移同步完成。事件流名 brand_state_change、trace 步骤名 apply_brand_state、BrandStateService 文件/类名按规约 4 不跟改）。**写入纪律原样保留**——reducer 仍是唯一写者、收尾时机与"提取失败不跳过"语义不变、极性状态机仍在 resolution/evidence/brand-policy；防踩踏是构造性的：提取 schema 自 S9 恒无品牌字段，守卫合并永不触碰该域，apply_brand_state 排在 extract_facts 之后。落库懒迁移（读到顶层旧字段即搬入 facts，先例 §9.4），Redis key 不变。**结构原样搬入不套标准事实信封**——PersistedBrandState（currentBrand/excludedBrands/updatedAtMs）是状态机裁决产物非提取信封，历史走 brand_state_change 事件流不入状态，执行时勿"归一化"成 {value,confidence,source,evidence}。文件层面 brand-state.service 保留为舱内品牌写路径（并入则 facts.service 破千行违反 ~500 行约定），独立性降级为行数工程理由。

**闸门（✅ 2026-08-25 通过）**：第 1、5 条 + 抽屉/结巴按纯结构批完成；第 2 条按配置批完成；第 3、4 条行为链路已覆盖 delayed job 触发、闲置复核、重试告警与 profile 双路置信度守卫。各实现批均通过 typecheck、lint 与全库测试；DB 迁移只推送测试库并完成真实写入回读，生产库未 push。badcase 率继续按发版后观测口径验收。

## 二·五、终态代码组织架构图（全部批次完成后的验收基准）

> 验收方式：拿本图走 `tree`，每个框指到一个真实路径；拿任何路径反查，图上有它的框。
> ⚠️ M5（2026-08-24）重排了 `src/memory/` 子树——该子树以 M5 节的树为准；本图其余部分（generator / procedural 侧）仍有效。
> 标注：✅=已落地；Ⓑ=M1-B、Ⓒ=M2-C、Ⓐ=M2-B（A3）、Ⓜ=M3 交付。

```
src/memory/                                  ═══ 记忆四层（生命周期轴做目录）═══
├── memory.service.ts                        # Facade：onTurnStart/onTurnEnd 唯一入口（不动）
├── memory.module.ts / memory.config.ts      # 窗口 120 条/24K ✅
├── memory-lifecycle.service.ts              # 跨层编排（读四层/写回/触发沉淀）——不属任何层，平铺根
├── memory-enrichment.service.ts             # 跨层丰富——同上
├── short-term/                              # ① 短期窗口 ✅（service + types 同居）
├── stage-state/                             # ③ 阶段状态（原"程序记忆"）✅（service + types 同居）
├── session-state/                           # ② 会话状态（原 session/，2026-08-21 三次修正：scope 名两头不靠，与 stage-state 平行）✅
│   ├── session.service.ts                   #    薄 facade：1:1 委托两舱，26 注入点零波及 ✅
│   ├── facts.service.ts                     #    事实舱（semantic）：状态所有者/事实读写/提取/已发生事件 ✅
│   ├── workbench.service.ts                 #    工作台舱（working state）：candidatePool/presentedJobs/
│   │                                        #    currentFocusJob/lastJobListQuery，覆盖写+cap ✅
│   ├── brand-state.service.ts               #    品牌真相=事实，归事实舱域 Ⓒ
│   ├── candidate-snapshot.service.ts        #    precheck→booking 事务快照，归工作台域 Ⓒ
│   ├── session-key.ts / session-facts.types.ts  # 类型跟层走 Ⓒ
├── long-term/                               # ④ 长期记忆 Ⓒ
│   ├── long-term.service.ts                 #    semantic{ profile, jobIntent } Ⓐ
│   │                                        #    episodic{ sessionSummaries } Ⓐ
│   ├── consolidation.service.ts             #    沉淀管道（原 settlement）✅名 Ⓒ归位
│   └── long-term.types.ts                   #    LongTermMemory A3 结构 Ⓐ
├── stores/                                  # 跨层基础设施（redis/supabase/deep-merge，留共享位）
├── formatters/                              # fact-lines 等（留共享位）
└── types/                                   # memory-runtime（跨层）+ stage-state.types 留此

src/agent/generator/                         ═══ Working Memory 装配 + procedural prompt 仓 ═══
├── working-memory/                          # Working Memory 装配车间 Ⓒ
│   ├── preparation.service.ts               #    prepare() → WorkingMemory（服务名不改：流程名准确）
│   ├── working-memory.types.ts              #    WorkingMemory 类型（原 PreparedAgentContext）Ⓒ
│   └── （原 preparation-utils/* 全部迁入：conversation-normalizer、
│         memory-block.formatter、tool-context.builder、turn-ledger 等）
├── context/
│   ├── procedural/                          # ⑤ procedural 的 prompt 侧物理仓（原 prompts/）Ⓒ
│   │   ├── candidate-consultation.md        #    手册（互链锚注 → 程序记忆索引）Ⓑ
│   │   └── candidate-consultation-final-check.md  # recitation 收口段 Ⓑ
│   ├── sections/ + scenarios/               # 12 段组装体系（不动）
│   └── context.service.ts
└── generator.agent.ts                       # 回合内 WM 增长：prepareStep 工具结果累积（不动）

═══ ⑤ procedural 散布侧（就近放置，判定树裁定；逻辑收拢靠索引）═══
src/tools/*.tool.ts 的 DESCRIPTION            # 工具绑定规则（首行锚注 → 索引）Ⓑ
src/tools/collection/                         # 收资状态机（代码化的 procedural）
strategy_config（DB）                         # red-lines/stage_goals（Dashboard 编辑，台账登记纪律）
docs/prompt-rule-ledger.md                    # ★ 程序记忆索引：该层唯一总目录 Ⓑ
                                              #   （容量=台账+哨兵 / 沉淀=批次删减 / 放置=判定树）
```

## 三、明确不做

1. **向量库/RAG**：封闭 schema + 单人小数据量，确定性召回严格优于 top-k 模糊检索（P11 同源裁定）。
2. **手册进 DB**：会制造第二个零 review 居所，违反 C8。
3. **模型自管记忆**（Letta 式 agent 自编辑记忆）：本库裁定代码 pipeline 沉淀更可控。

## 四、风险与回归闸

| 风险 | 缓解 |
|---|---|
| ~~playbook 拉取时机错误~~ | 已随 M1 关闭裁定消解（2026-08-21） |
| M2 改名波及 import 面广 | 纯机械改动，pathspec 分批 + typecheck/test 兜底 |
| M3 触碰 session-facts.types.ts 大类型文件 | 与收资状态机契约对齐推进，避开 active_booking 冻结区 |

## 五、验收

1. **待遇表口径（随 M1 关闭修订）**：程序层容量=台账+哨兵（一期已给✅）；沉淀=台账批次删减循环（✅ 已运转）；按需加载=裁定不做（✋ 记录在案）。M2-B 结构落地 + M3 分家完成即验收。
2. badcase 率不回升为唯一硬约束；基线 SQL 前后对比可解释（沿一期验收口径，不设量化 KPI）。
3. 全库无"程序记忆"错位表述（代码命名、README、architecture 文档与 glossary 一致）。
