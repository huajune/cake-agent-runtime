# 记忆体系 CoALA 对齐（上下文治理二期）

> 状态：**二期收官（2026-08-21 用户"一口气执行到底"批准后当日完成）**——M1 关闭（观察项）、M1-B ✅、M2 ✅、M2-B ✅（DB 迁移测试库已验、生产随发版）、M2-C ✅、M3 ✅；M4 观察项。
> 理论基础：[principles/context-engineering-principles.md](../principles/context-engineering-principles.md)（C1~C9）+ [glossary](../principles/glossary.md)「CoALA 记忆四分法」词条 + CoALA（arXiv 2309.02427，见 [industry-sources](../principles/industry-sources.md)）。
> 一句话：**一期给程序记忆减肥，二期给程序记忆上户口**——让 procedural 层享受与情景/语义层同等的记忆治理待遇。

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

- **混合形态（2026-08-21 修正：防过碎，沿工具层终态"单件平铺、成簇立目录"惯例）**：只为成簇的层立目录——`session/`（6 文件：facts/workbench/brand-state/candidate-snapshot/session-key/types，M3 还会增长）、`long-term/`（3 文件：long-term/consolidation/types，**consolidation 归位**）；`short-term.service`（1 文件）与 `stage-state.service`（2 文件）留 services/ 平铺——**文件名即层名**，结构图对应不损失；import 改动面减半。
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

### M4 观察项（登记不承诺）

- 跨会话相关片段检索（episodic 的 relevance 取路，CoALA 图中 "RAG for relevance"）：单人数据量小、settlement 摘要已粗粒度覆盖，暂不做；记录于此防遗忘，若未来出现开放域知识（岗位知识库问答）再评估。

## 二·五、终态代码组织架构图（全部批次完成后的验收基准）

> 验收方式：拿本图走 `tree`，每个框指到一个真实路径；拿任何路径反查，图上有它的框。
> 标注：✅=已落地；Ⓑ=M1-B、Ⓒ=M2-C、Ⓐ=M2-B（A3）、Ⓜ=M3 交付。

```
src/memory/                                  ═══ 记忆四层（生命周期轴做目录）═══
├── memory.service.ts                        # Facade：onTurnStart/onTurnEnd 唯一入口（不动）
├── memory.module.ts / memory.config.ts      # 窗口 120 条/24K ✅
├── services/
│   ├── memory-lifecycle.service.ts          # 跨层编排（读四层/写回/触发沉淀）
│   ├── short-term.service.ts                # ① 短期窗口——单文件平铺，文件名即层名
│   └── stage-state.service.ts               # ③ 阶段状态（原"程序记忆"）✅名——同上
├── session/                                 # ② 会话记忆 ✅Ⓒ（目录）+ ✅Ⓜ（分舱）
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
