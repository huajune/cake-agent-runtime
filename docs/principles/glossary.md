# 术语宪章（Glossary）——行业名做主名，自造词打旗

**最后更新**：2026-08-25（M5 两层记忆映射与 session 双义登记）

> 用途有二：**学习地图**（每个概念给出行业标准名与检索线索，顺藤能摸到文献）与
> **命名权威源**（新概念命名、后续代码对齐改名，以本表为锚）。
> 分三层：A 层=行业规范（直接用，可迁移知识）；B 层=概念是行业的、名字是我们借喻的；
> C 层=我们自造（⚑ 标记——孤僻的原因是业界还没名字，不是我们躲进方言）。

---

## A 层：行业规范（主名直接用原词）

| 行业名（中文对照） | 一句话定义 | 库内范本 | 检索线索 |
|---|---|---|---|
| **Guardrails**（守卫） | 对 LLM 应用分层设防：input / prompt / tool / output 四层 | `src/agent/guardrail/{input,tool,output}`；prompt 层见示教纪律 | OWASP LLM Top 10、NVIDIA NeMo Guardrails、Datadog guardrails |
| **Grounding**（证据锚定） | 模型输出必须锚定可验证的证据源 | `candidateClaims` 强制附 quote | Anthropic Citations API、grounded generation |
| **Citation verification**（引文校验） | 对模型给出的引用做确定性/检索校验——只生成引用不校验是不够的 | `evidence/notary.ts` 三问 | CiteCheck、CiteGuard |
| **Provenance / Attribution**（出处/归属） | 内容来源可追溯：谁产生的、经过什么管道 | 传输来源标记（`extractCandidateTexts`）、jobId 溯源闸 | data provenance、W3C PROV |
| **Canary values**（占位值/金丝雀值） | 注册的假值，永不应出现在合法输出；输出侧确定性扫描即测出泄漏 | 占位号黑名单 `PLACEHOLDER_PHONES` | canary tokens、OWASP LLM07:2025 |
| **Shadow mode**（影子模式） | 新逻辑并行计算、只落观测不改行为，攒精确率再切换 | 裁决 shadow、`semantic_track_diff`、语义审查 shadow | shadow deployment、dark launch |
| **Fail-open / fail-closed** | 防线自身失效时：放行＋告警（open）还是拒绝（closed） | P4 fail-open 兜底（可恢复违规不许静默收场） | fail-open security |
| **Event sourcing**（事件溯源） | 追加式不可变观测记录 + 由解析推导现值，不做可变覆盖——**"账本"的学名** | claim 账本、`agent_execution_events` | event sourcing、append-only log |
| **Human-in-the-loop（HITL）**（人在环） | 关键决策交给人终审——"本人终审"是它的数据主体版 | 确认流 `needs_confirmation`、转人工 handoff | HITL、user confirmation |
| **Controlled vocabulary**（受控词表） | 封闭标签集：身份由系统下发，模型只填判断——**"封闭词表"的学名** | `raise_risk_alert` 的 riskType enum、`CANDIDATE_CLAIM_FIELDS` | controlled vocabulary、taxonomy |
| **Correct-by-construction**（构造即正确） | 让错误在结构上不可能发生，而不是事后检查——P2 的学名 | 岗位卡代码渲染、删除 `value_not_derivable`（类型层不可表达） | correct by construction（形式化方法） |
| **Instruction-data separation**（指令-数据分离） | 教学/指令文本与证据/数据文本必须结构化分域，自然语言框架（"这是示例"）永远脆弱 | 抽取审计语料排除 system prompt | StruQ、Instruction Hierarchy、Spotlighting |
| **Fast path / slow path**（快环/慢环） | 投递路径只准确定性动作；聪明的东西进影子与离线环 | 快环裁定（2026-07-28） | fast path / slow path（系统工程） |
| **LLM-as-a-judge**（模型评审） | 用 LLM 对质量/语义做裁决，通常离线或旁路 | 语义审查器、复聊 judge、`evaluation/` | LLM-as-a-judge |
| **Few-shot / in-context examples**（上下文示例） | 用示例示教模型；示例选择是独立研究领域 | 示教四原则所辖的全部示例面 | in-context learning、example selection |
| **Structured outputs**（结构化输出） | 用 schema 约束模型输出形态 | 全部工具的 zod `inputSchema` | structured outputs、function calling |
| **Memory taxonomy: working / episodic / semantic / procedural**（CoALA 记忆四分法） | 按**知识类型**切分 agent 记忆：工作（本轮拼装）/ 事件 / 事实 / 程序性知识（"怎么做事"，可活在代码、提示词或模型参数里） | 本库顶层按**作用域轴**切两层（short-term=一个咨询生命周期 / long-term=候选人×bot 关系档，M5 终态 2026-08-25），类型词只在"恰好装满"的层级做映射，不做目录/文件名：episodic 原料↔message-window+chat_messages；semantic↔short-term facts 舱 + long-term.semantic{profile, jobIntent}；working↔workbench 舱（含阶段指针）+ generator/preparation 每轮现编；episodic 蒸馏↔long-term.episodic{sessionSummaries}；procedural 不在 memory=手册/工具 description/收资状态机（tools/collection），台账做索引。完整落点表见 src/memory/README.md「CoALA 类型映射」。⚠️ 命名迁移史：本库"程序记忆"（存 currentStage）实为 **process/stage state**，2026-08-21 更名 stage-state，2026-08-25 随 M5 并入 workbench 作阶段指针（Redis key `stage:` 与 fixture 键 `setup.procedural` 始终保留兼容）；semantic 类型词曾短暂进入门面名，因罩不住 working 态而退役——类型词当映射好用、当户口本必翻车（CrewAI 类型轴四类被主线整体删除为业界同证） | CoALA（arXiv 2309.02427）、Tulving 记忆分类、MemGPT/Letta |
| **Session（本库双义）** | 代码义与业务义必须在上下文中分清 | **代码义**：`sessionId = chatId`，表示候选人 × bot 关系，可跨多次咨询长期存续；**业务义**：一段连续咨询，由闲置 3 天计算划界，本身无独立存储层 | session scope、conversation episode、chat relationship |

## B 层：概念是行业的，名字是我们借喻的

| 我们的叫法 | 行业学名 | 说明 |
|---|---|---|
| 公证器 / `notary.ts` | **citation verification** | 比喻准确（验章验签、不管内容真假），文件名保留；**学习和检索用行业名** |
| 示教纪律 / example hygiene | few-shot **example selection**（研究领域）；prompt hygiene（业界非正式用语） | 文档名不改，检索走 example selection |
| 带值求证（`CandidatePrefillHint`） | prefill + HITL confirmation 的组合，无精确标准名 | 代码原生命名，保留 |
| 「模型作证、代码公证、本人终审」（P11） | attributed generation + deterministic verification + HITL confirmation | 句式是我们的，三个组件各有行业名 |
| ~~settlement~~ → consolidation / 沉淀（`consolidation.service.ts`） | **memory consolidation**（记忆巩固） | **2026-08-21 已更名对齐行业名**——动因：与本库薪资结算域（settlementPeriodList/结算周期守卫）同词冲突，同库双义过"误导"门槛。env 键 `MEMORY_SETTLEMENT_GAP_DAYS` 与 DB RPC `mark_long_term_settled_boundary` 保留兼容 |
| 苦涩教训台账 / bitter-lessons.md | Sutton **"The Bitter Lesson"**（人工结构终被通用方法+算力溶解） | 借其"人工结构会折旧"内核；本库语义更宽=一切交过学费的方向性证伪（含非算力原因），是复盘台账不是预言 |

## C 层：⚑ 自造词（业界空白区，我们先到了）

| ⚑ 词 | 定义 | 最近的行业近亲（为什么不够用） | 库内范本 |
|---|---|---|---|
| ⚑ **raise_risk_alert 模式**（曾拟名"在流分类器"） | 主模型 in-flow 经受控词表工具自主分类 + 确定性副作用：全上下文、零额外调用、判断附原话 | LLM-as-a-judge（通常离线）；Constitutional Classifiers（独立模型，无会话上下文） | `raise-risk-alert.tool.ts` |
| ⚑ **回声检查**（echo check） | 模型引文与我方已发消息全集做包含比对，命中转确认——防候选人抄我方模板被当自陈 | 2026-08 检索无公开对应物 | `notary.ts` `detectAgentEcho` |
| ⚑ **示例回声**（example echo） | 真值缺席时，教学示例值被模型当事实检索——M1 致幻机制 | Task contamination（相邻但不同）；抽取场景文献空白 | 示例回声族三轮事故（PR #730/#843/#1000） |
| ⚑ **发牌制** | 精确率驱动的规则准入与自动降档制度：判定权是租来的，租金是精确率 | guardrail monitoring/evaluation（无"准入-降档"制度概念） | P8、出站规则目录治理条款 |

## 使用规约

1. **新概念命名流程**：先查行业名（有则直接用并补进 A 层）→ 确无才自造，打 ⚑ 并登记本表。禁止不查就造。
2. **文档写作**：概念首次出现用「行业名（中文）」格式，如 "canary values（占位值）"；后文可只用中文。
3. **⚑ 词的退场机制**：业界后来出了标准名，本表划线改名对齐（修订体例同 rules-vs-semantics：保留原文＋日期）。
4. **代码对齐改名**（P11 改造 P3 尾项）以本表为唯一权威；搭车改名，不专车改名。
5. hint 类通道的命名与说明必须**同时**表达两轴：零权威（须经作证/确认才能成为事实）与如实可靠性（通常准确＋列明已知失效形态）。压塌任一轴都是误导——『高置信』膨胀权威轴（P9 教义化石），『疑似/猜测』通缩可靠性轴（2026-08-13 教训，本条出处）。
