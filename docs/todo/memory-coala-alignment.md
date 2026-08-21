# 记忆体系 CoALA 对齐（上下文治理二期）

> 状态：**已立项，未启动**（2026-08-21 立项）。启动条件：一期收尾（[context-engineering-governance.md](./context-engineering-governance.md) 的 P3-2/P3-3/P3-4 证据批次完成），或用户明示提前。
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
- 依赖：P3-4 回归闸结论是本包的证据前置；拉取内容进 messages 后缀，不碰前缀缓存（C5）。

### M2 命名对齐（搭车批）

- `procedural.service.ts` / `procedural.types.ts` → stage-state 族命名；**Redis key 与存量数据零迁移**（只改代码层命名）；`src/memory/README.md`、architecture 文档同步；glossary 词条为唯一命名权威。

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
