# 记忆体系 CoALA 对齐（上下文治理二期）

> 状态：**已立项，启动条件已满足**（2026-08-21 立项；同日[一期收官](./context-engineering-governance.md)——全部项目已执行或已裁决），待用户批准启动。
> 理论基础：[principles/context-engineering-principles.md](../principles/context-engineering-principles.md)（C1~C9）+ [glossary](../principles/glossary.md)「CoALA 记忆四分法」词条 + CoALA（arXiv 2309.02427，见 [industry-sources](../principles/industry-sources.md)）。
> 一句话：**一期给程序记忆减肥，二期给程序记忆上户口**——让 procedural 层享受与情景/语义层同等的记忆治理待遇。

## 一、背景与动因

CoALA 对照复盘（2026-08-21，结论已录治理方案行业对照第 5 条）：本库四层记忆**功能完备**（settlement ≈ consolidation gate、无向量 RAG 是裁定非缺口），但存在一处命名错位与一个结构盲区：

**待遇差异表**（二期要抹平的东西）：

| 记忆类型 | 容量控制 | 压缩/沉淀 | 按需加载 |
|---|---|---|---|
| 情景（聊天窗口/摘要） | ✅ 60 条/12K 字符 | ✅ settlement | ✅ recall_history |
| 语义（facts/档案） | ✅ schema+cap（P1-3 补齐） | ✅ 沉淀+整组覆盖 | 部分 |
| **程序（手册/description/DB 策略）** | ✅ 一期补：台账+膨胀哨兵 | ❌ **二期 M1** | ❌ **二期 M1** |

命名错位：`procedural.service.ts` 存的是 currentStage（流程书签，process state），行业 procedural memory 指"怎么做事的知识"——已登记 glossary，二期 M2 搭车改名。

## 二、工作包

### M1 程序记忆分层供给（核心）

- **常驻核心**：决策优先级栈、全局工作原则、红线——保持静态前缀地位（C2 前缀稳定性）。
- **playbook 库**：低频规程按需拉取（承接一期 P3-4 实验结论），配**注册表 + 加载统计**——从未被拉取的 playbook 进退役候选。这是程序层第一次有自己的"settlement"（沉淀/退役机制）。
- **原一期 P3-4 实验项已裁定并入本包**（2026-08-21）：M1 第一阶段即 playbook 拉取原型 + 回归验证。候选段落（一期 P1-1 审计标记）：平台来源识别截图簇（P2/P4/P5）、造假引导 C8、结伴分流、C7 后半（AI 面试时段语义）——逐段做净收益核算（新工具 description 占预算），P1/P3 等文本触发的常驻规则不迁移。拉取内容进 messages 后缀，不碰前缀缓存（C5）。
- **社区警示（2026-08-21 检索，arXiv 2607.26637）**："持续用 LLM 重写记忆库会退化到低于无记忆基线"——playbook 库的整理与退役**必须用确定性信号**（加载统计、台账登记），禁止引入"LLM 定期重写 playbook"类机制；与 L 系"模型自管记忆"教训同源。

### M2 命名对齐（搭车批）

- ✅ **改名已执行（2026-08-21，用户裁定不等搭车直接改）**：`procedural.service/types` → `stage-state.*`，类/类型/字段全量（StageStateService/StageState/stageState），18 文件；Redis key（本就叫 `stage:`）与 test-suite fixture 契约键 `setup.procedural` 保留兼容；README/CLAUDE.md/glossary 同步；typecheck + 2,958 测试绿。
- **改名范围裁定（2026-08-21）：只改"程序记忆"这一处，不做 CoALA 全量改名**。依据双轴框架：短期/会话/长期是**生命周期轴**命名，语义准确且 short-term/long-term 本身就是行业标准词（会话记忆混含事实+工作台，改成 semantic 反而不准确）；唯独"程序记忆"是**冒用知识类型轴行业术语**装生命周期内容的真错位。全量改名 = 把准确的生命周期名换成不准确的类型名，且违反"搭车改名不专车改名"规约。
- ✅ **settlement → consolidation 已更名（2026-08-21，用户复议后执行）**：复议发现与薪资结算域同词冲突（settlementPeriodList/结算周期守卫），同库双义过"误导"门槛——与 procedural 同性质。env 键与 DB RPC 名保留兼容。
- **改名门槛口径（本轮定稿）**：改名标准是"名字错误或误导"（错位/同库冲突），不是"与行业分类词不同"。长期层内容名（profile_facts/preference_facts/summary）**不改**——内容名信息量大于类别标签、业界 store 也按内容命名、且为生产表列名；类型词汇只用于文档归类与**新增实体**命名（playbook 库 → procedural-*）。
- **业界命名轴查证（2026-08-21，LangGraph/LangMem 分类法）**：主流是**复合轴**——顶层按生命周期/作用域（short-term thread-scoped / long-term namespace），长期层内部才按知识类型分 semantic/episodic/procedural；没有主流框架用类型轴做顶层目录（Letta 用 OS 存储层级轴、Mem0 用 scope 轴）。本库顶层命名与业界同构，"只修错位不全改"裁定获行业形态追认。LangMem 将 procedural 定义为"可随反馈精炼的系统指令"——从源头追认"手册=程序记忆"与台账批次删减循环（=procedural refinement）。
- **M3/M1 命名指引（由此新增）**：分家与 playbook 落地后，**长期层内部采用类型词汇**——profile/preferences 归 semantic、summary 归 episodic、playbook 库归 procedural——达成"顶层生命周期、层内类型"的 LangGraph 完整形态。

### M2-B 长期层 CoALA 结构分组（A3 方案，2026-08-21 设计定稿，**待用户批准执行**）

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
  // procedural: { playbooks } —— M1 落地时加入，不预留空槽
  origin?: { fromOtherConversation: true };
}
```

**设计裁定记录**：
1. A3 结构分组（用户选定）：分类词住结构层、内容词住叶子层，双轴都可见；episodic 单成员也包对象——对称性 + M4（relevantEpisodes）与 M1（procedural 分组）的可预见扩展位；
2. 排除项：字段名不用 userProfile（口吃式冗余）、不用 candidateProfile（memory 模块 API 是 userId 口径，换词造成主体混用）、episodic 叶子不叫 episodes（原始 episode 在 chat_messages，此处是蒸馏摘要）；
3. **B2 DB 列迁移随发版同批**：`profile_facts→semantic_profile`、`preference_facts→semantic_job_intent`、`summary_data→episodic_session_summaries`，含两个 RPC 函数 DROP+CREATE；migration 先推测试库验证，生产 push 与下周发版严格同批（仓库纪律：只推迁移不发代码=事故源）；
4. 范围：限长期层内部；顶层四层名（短期/会话/长期/阶段状态）维持不动（业界复合轴同构，见 M2 查证）；
5. 执行纪律：全库测试 + typecheck 一步不省（settlement 批的教训：域内测试不够，误改薪资域枚举靠全库回归才兜住）。

**M3 登记项（随本设计新增）**：① jobIntent 内部软/硬/时间三分（preferences/constraints/availability）——软硬分离在结构上根治"硬约束被当偏好淡化"的暗示，与 M3 分家同性质合并做；② `lastSettledBySession`/`lastSettledMessageAt` 是 consolidation 水位簿记，混在摘要数据里名实有瑕，M3 一并考虑挪位。

### M3 会话记忆"事实/工作台"分家

- **语义事实**（facts：置信度合并、extractedAt 时间锚）与**工作台状态**（lastCandidatePool / presentedJobs / currentFocusJob / lastJobListQuery / invitedGroups：覆盖写+cap，P1-3 已加 cap）在类型与命名上分离，治理策略各归其位。
- ⚠️ 约束：`active_booking` 行为冻结裁定在先——涉及处仅零行为整洁化。

### M4 观察项（登记不承诺）

- 跨会话相关片段检索（episodic 的 relevance 取路，CoALA 图中 "RAG for relevance"）：单人数据量小、settlement 摘要已粗粒度覆盖，暂不做；记录于此防遗忘，若未来出现开放域知识（岗位知识库问答）再评估。

## 三、明确不做

1. **向量库/RAG**：封闭 schema + 单人小数据量，确定性召回严格优于 top-k 模糊检索（P11 同源裁定）。
2. **手册进 DB**：会制造第二个零 review 居所，违反 C8。
3. **模型自管记忆**（Letta 式 agent 自编辑记忆）：本库裁定代码 pipeline 沉淀更可控。

## 四、风险与回归闸

| 风险 | 缓解 |
|---|---|
| playbook 拉取时机错误（该拉不拉 → 行为退化） | P3-4 实验先行出证据；badcase 率不回升硬约束沿一期口径 |
| M2 改名波及 import 面广 | 纯机械改动，pathspec 分批 + typecheck/test 兜底 |
| M3 触碰 session-facts.types.ts 大类型文件 | 与收资状态机契约对齐推进，避开 active_booking 冻结区 |

## 五、验收

1. **待遇表三格补齐**：程序层的容量（一期已给）、沉淀（playbook 退役机制在位）、按需加载（拉取率统计可查）全部打勾。
2. badcase 率不回升为唯一硬约束；基线 SQL 前后对比可解释（沿一期验收口径，不设量化 KPI）。
3. 全库无"程序记忆"错位表述（代码命名、README、architecture 文档与 glossary 一致）。
