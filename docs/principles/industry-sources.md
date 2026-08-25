# 行业经验引用库（Industry Sources Ledger）

> 定位：本库历次架构重构与原则立宪所引用的行业经验**总索引**——开源项目、官方文档、技术博客、论文、访谈。
> 价值不在链接本身，在**每条 source → 本库落点**的映射：它支撑了哪条裁定、哪个原则、哪个机制。
> 维护纪律：**每次行业调研（检索/精读后形成结论）都必须把真正支撑了结论的 source 入库**——搜到但没用上的不入；
> 各文档的"业界资料"附录保留就地引用，本库是唯一汇总索引。条目带检索日期，链接失效划线保留（体例同 rules-vs-semantics 修订）。
> 两类特殊标注：**〔补引〕**=结论先于引用——裁定当时未记出处，事后按结论定向检索行业对应理论补挂；
> **〔git 回收〕**=当年确实引用过、随文档删除而佚失，从 git 历史挖回。

## 一、上下文工程与缓存（2026-08-20/21 检索）

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [The New Rules of Context Engineering for Claude 5 Generation Models（Anthropic）](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models) | 官方博客 | 治理方案的起点：六规则逐条研判（governance 第二节）；"删 80% 系统提示无性能损失"的松绑实证 |
| [Effective context engineering for AI agents（Anthropic）](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 官方工程博客 | C1 注意力预算概念来源；compaction/note-taking/sub-agents 三策略与本库 settlement/recall_history 的对照；context rot 概念；三期追加落点：可恢复压缩（截断留标识符供 just-in-time 召回）、"最小高信号集"预算观（[context-assembly-compiler.md](../todo/context-assembly-compiler.md) 3.4） |
| [Context Engineering Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | 技术博客（一线产品复盘） | C2 全条：KV-cache 命中率第一指标（P0-1b 升格依据）、mask-don't-remove（追认 P2-1 裁定）、确定性序列化；C6 recitation（final-check 的存在依据）；三期追加落点：工具目录进稳定前缀、tail-recitation 段、10 倍缓存价差的段位轴依据（[context-assembly-compiler.md](../todo/context-assembly-compiler.md) 3.3） |
| [千问模型的 Context Cache 功能（阿里云百炼）](https://help.aliyun.com/zh/model-studio/context-cache) | 官方文档 | P0-1a 全部结论：隐式缓存自动开启/命中 2 折/tools 参与前缀/显式缓存 5 分钟 TTL（裁定不做显式） |
| [Virtual context management with MemGPT and Letta](https://www.leoniemonigatti.com/blog/memgpt.html) | 技术博客（论文解读） | 四层记忆 ≈ OS 式分层（core/recall/archival）的骨架健康对照；"代码 pipeline 沉淀比模型自管更可控"的比较基准 |
| [Cognitive Architectures for Language Agents（CoALA，arXiv 2309.02427）](https://arxiv.org/pdf/2309.02427) | 论文 | 〔补引〕记忆四分法（working/episodic/semantic/procedural）的学理源头——四层记忆复盘（2026-08-21）的对照基准："程序记忆"命名错位诊断、"procedural 层从未进记忆治理框架"洞察、settlement ≈ consolidation gate 的对应 |
| [Memory overview（LangChain/LangGraph 官方文档）](https://docs.langchain.com/oss/python/concepts/memory) | 官方文档 | 〔补引〕**命名轴裁定的行业查证**：主流复合轴形态——顶层 short-term(thread-scoped)/long-term(namespace)、长期内分 semantic/episodic/procedural；本库"顶层生命周期轴不改名"裁定的同构依据 |
| [LangMem SDK for agent long-term memory（LangChain）](https://www.langchain.com/blog/langmem-sdk-launch) | 官方博客 | 〔补引〕procedural memory="可随反馈精炼的系统指令"——追认"手册=程序记忆"发现与台账批次删减循环（procedural refinement）；二期 M1 playbook 库的行业对应物 |
| [Context Engineering: A Practical Guide（Sourcegraph）](https://sourcegraph.com/blog/context-engineering) | 技术博客 | "selection before compression"——与注意力优先裁定同构 |
| [Context Engineering AI Agents Guide（mem0）](https://mem0.ai/blog/context-engineering-ai-agents-guide) | 技术博客 | 四类挑战框架（poisoning/overload/token/performance）佐证三元目标划分 |
| [Agent Memory: An Anatomy（HN 讨论，2026-08）](https://news.ycombinator.com/item?id=48287808) | **社区论辩** | 认知科学分类法被质疑"低信号密度/过度拟人化/缺必要性论证"——佐证"类型轴当词汇表不当目录"裁定与兜底边界原则（机制入场须实证）；评论区 skills repo × 自动记忆层协同之问 = 二期 M1 议题的社区独立提出 |
| [When Agent Memory Becomes a Platform Concern（HN 讨论，2026-08）](https://news.ycombinator.com/item?id=48021710) | **社区论辩** | harness 派（Harrison Chase/Sarah Wooders）vs 平台派（规模化需 provenance/RBAC/审计）之争——本库站位：memory 在 harness 内但自建了平台派要的治理能力（血缘/置信度合并/公证），跨 bot 共享长期记忆即微型 platform concern 的已解案例 |
| [Filesystem-Based Memory for LLM Agents（arXiv 2607.26637）](https://arxiv.org/abs/2607.26637) | 论文 | 文件式记忆首个系统研究（管理/检索/执行三角色）；**关键警告："持续用 LLM 重写记忆库会退化到低于无记忆基线"**——L 系"模型自管记忆"裁定的新证 + 二期 M1 playbook 退役必须用确定性加载统计而非 LLM 重写的依据 |
| [Your AI Agent's Memory Is Just a File? That's the Problem（mem0）](https://mem0.ai/blog/your-ai-agents-memory-is-just-a-file-thats-the-problem) | 技术博客（论辩反方） | 文件式记忆之争的结构化存储侧立场——本库生产记忆走 Redis+Supabase 结构化（多用户产品记忆），与 AGENTS.md 文件式（开发者工具记忆）是两种场景，争论双方各占一域 |

## 二、Harness 与松绑（2026-08-21 检索）

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [AI Agent Harness & the Bitter Lesson Revisited（Hugo Bowne-Anderson）](https://hugobowne.substack.com/p/ai-agent-harness-3-principles-for) | 技术博客 | C9 折旧论核心："模型吸收 harness"的历史轨迹（CoT→推理模型、工具编排→工具训练、检索→长上下文）；"2026 年的 harness 是 2026 年的文物" |
| [Hidden Technical Debt of AI Systems: Agent Harness（Hanchung Lee）](https://leehanchung.github.io/blogs/2026/05/08/hidden-technical-debt-agent-harness/) | 技术博客 | C9：harness 作为技术债的框架 |
| [Scaffolding is coping, not scaling — Codex 团队访谈（LinearB Dev Interrupted）](https://linearb.io/dev-interrupted/podcast/openai-codex-thibault-sottiaux-agentic-autonomy) | **访谈** | C9：OpenAI 侧激进松绑立场的一手陈述 |
| [Dive into Claude Code: The Design Space of AI Agent Systems](https://arxiviq.substack.com/p/dive-into-claude-code-the-design) | 论文解读 | C9 保留派立场："信任模型局部判断 + 确定性最小侵入执行 harness"——与 P11 同构的判定依据；"模型与 harness 共同后训练"前提（我们不具备，故证据门控） |
| [What Is the Agent Harness?（MindStudio）](https://www.mindstudio.ai/blog/agent-harness-scaffolding-matters-more-than-model) | 技术博客 | Agent = Model + Harness 定义；TerminalBench"只换 harness 移动 20+ 名次"的今日重要性实证 |
| [Agent Harness Engineering（Addy Osmani）](https://addyosmani.com/blog/agent-harness-engineering/) | 技术博客 | harness 工程全景概览 |
| [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) | 开源清单 | harness 生态检索地图（工具/模式/评测/记忆/MCP/权限/观测） |

## 三、Skill / 工具 / MCP（2026-08-21 检索）

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [Skills vs MCP Explained: AI Agent Tools Guide（duet.so）](https://duet.so/guides/agent-skills-101-tools-vs-mcp-vs-skills) | 技术博客 | 分工共识句"Skills hold the procedure, Tools take the actions, MCP provides the access"（C 系原则第 4 节） |
| [MCPs vs Agent Skills: Understanding the Difference](https://www.damiangalarza.com/posts/2026-02-05-mcps-vs-agent-skills/) | 技术博客 | MCP"接入即全量载入"痛点——P3-4 拉取式披露的反面论证 |
| [Progressive Disclosure Might Replace MCP（MCPJam）](https://www.mcpjam.com/blog/claude-agent-skills) | 技术博客 | skill 元数据先行、命中才读全文的机制细节（P3-4 原型参照） |
| [Agent Skills for LLMs: Architecture, Acquisition, Security（arXiv 2602.12430）](https://arxiv.org/html/2602.12430v3) | 论文 | skill 生态的学术综述与安全面 |

## 四、守卫、幻觉与引用验证（2026-08-12 检索；就地引用见 [prompt-example-hygiene.md](./prompt-example-hygiene.md)）

支撑示教四原则与四层防线的一批；逐条与防线的对应见该文档正文。

| 来源 | 类型 |
|---|---|
| [StruQ: Defending Against Prompt Injection with Structured Queries](https://sizhe-chen.github.io/StruQ-Website/) | 论文（结构化语料分域 BL2 的理论近亲） |
| [Introducing Citations on the Anthropic API](https://www.anthropic.com/news/introducing-citations-api) | 官方文档（公证器/引文验证思路对照） |
| [Cited but Not Verified（arXiv 2605.06635）](https://arxiv.org/pdf/2605.06635) | 论文 |
| [CiteCheck: Retrieval-Grounded Detection of Citation Hallucinations（arXiv 2605.27700）](https://arxiv.org/pdf/2605.27700) | 论文 |
| [langchain4j: Native "Canary Word" Guardrail（OWASP LLM07:2025）](https://github.com/langchain4j/langchain4j/issues/4587) | 开源 issue（出站 canary 扫描的业界对应） |
| [LLM guardrails: Best practices（Datadog）](https://www.datadoghq.com/blog/llm-guardrails-best-practices/) | 技术博客 |
| [Introducing LangExtract（Google）](https://developers.googleblog.com/introducing-langextract-a-gemini-powered-information-extraction-library/) | 官方博客（抽取链路对照） |
| [Task Contamination: LMs May Not Be Few-Shot Anymore（arXiv 2312.16337）](https://arxiv.org/pdf/2312.16337) | 论文（⚑ 示例回声的最近行业近亲） |
| [Multi-Layered Framework for LLM Hallucination Mitigation（MDPI）](https://www.mdpi.com/2073-431X/14/8/332) | 论文 |

## 五、裁决权与模型自纠的边界（2026-08-21 补引检索——L3/L5/P11 的学理支撑）

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [Large Language Models Cannot Self-Correct Reasoning Yet（Huang et al., ICLR'24）](https://arxiv.org/abs/2310.01798) | 论文 | 〔补引〕**L3 repair 破产的学理**：无外部反馈的自我纠正不改善输出、甚至更糟——repair 链"再叫一次模型"注定失败的独立实证；M1 二次模型链天花板 |
| [LLMs Can Self-Correct with Key Condition Verification（EMNLP'24）](https://aclanthology.org/2024.emnlp-main.714/) | 论文 | 〔补引〕**P11 代码公证的学理反面印证**：引入外部确定性校验后自纠才有效——"模型作证、代码公证"分工的文献支撑 |
| [Self-Preference Bias in LLM-as-a-Judge（arXiv 2410.21819）](https://arxiv.org/pdf/2410.21819) | 论文 | 〔补引〕**L5/P11**：LLM 裁判的自偏好偏差——模型仲裁 72.3% 假阳的行业同类观测 |
| [BabelJudge: Measuring LLM-as-a-Judge Reliability（arXiv 2606.22329）](https://arxiv.org/pdf/2606.22329) | 论文 | 〔补引〕L5/L2：位置/冗长/自增强偏差的系统性测量——语义审查 enforce 从未够格的学理背景 |

## 六、编排、多代理与守卫形态（〔git 回收〕自已删调研文档 + 补引）

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [Building effective agents（Anthropic）](https://www.anthropic.com/research/building-effective-agents) | 官方研究博客 | 〔git 回收〕**workflows vs agents、最简编排优先**——收资状态机（L6）、复聊确定性模板链（L8）的方向依据 |
| [Cognition vs Anthropic：Don't Build Multi-Agents 之争（smol.ai 综述）](https://news.smol.ai/issues/25-06-13-cognition-vs-anthropic) | 行业论辩综述 | 〔git 回收〕单主链上下文完整性 vs 多代理并行——本库单 generator 主链 + 独立轻链（复聊）的站位参照 |
| [How and when to build multi-agent systems（LangChain）](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems) | 技术博客 | 〔git 回收〕论辩另一方：多代理的适用边界 |
| [Multi-agent orchestration patterns in production（Beam.ai）](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production) | 技术博客 | 〔git 回收〕生产级编排模式清单 |
| [Multi-Agent in Production in 2026: What Actually Survived（M. Lanham）](https://medium.com/@Micheal-Lanham/multi-agent-in-production-in-2026-what-actually-survived-f86de8bb1cd1) | 技术博客 | 〔git 回收〕多代理模式的生产存活率复盘 |
| [OpenAI Agents SDK — Guardrails](https://openai.github.io/openai-agents-python/guardrails/) | 官方文档 | 〔git 回收〕输入/输出守卫的业界标准形态——出站三档结构的同类物 |
| [NVIDIA NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails) | 开源项目 | 〔补引〕确定性 rails 的开源代表——P8 发牌制"确定性规则拦确定性形态"的业界对应 |
| [2026 Agentic Coding Trends Report（Anthropic）](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) | 行业报告 | 〔git 回收〕agentic 趋势背景材料 |

## 七、基础库与工程规范（长期有效）

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [Vercel AI SDK](https://ai-sdk.dev/) | 开源框架官方文档 | 全部 LLM 执行层（generateText/prepareStep/stopWhen）；v7 升级三坑随 PR #827 |
| [Bull](https://github.com/OptimalBits/bull) / [NestJS Queues](https://docs.nestjs.com/techniques/queues) | 开源库/官方文档 | 消息 debounce 队列（bull-queue-guide） |
| [Conventional Commits](https://www.conventionalcommits.org/) | 规范 | 提交与 semver 发版约定 |

## 八、上下文装配编译器调研（2026-08-24 八路源码级调研）

> 支撑 [context-assembly-compiler.md](../todo/context-assembly-compiler.md)（上下文治理三期）的全部裁定。本节特点：**source 主体是开源仓库源码**（clone HEAD 精读，非文档转述），落点均指向该文档的共识编号（#1~#5）与批次（B1~B5）。仓库状态勘误（Letta 迁库/OpenHands 迁 SDK/Cline 断代/Mem0·CrewAI 主线推翻教科书版）记录在该文档第二节。

| 来源 | 类型 | 本库落点 |
|---|---|---|
| [OpenHands software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | 开源仓库源码 | 共识 #1/#2：`CacheTier.STATIC/DYNAMIC` 段级类型 + 字节级测试钉死 static 块（B1/B3 直接先例）；condensation 落 typed event（tombstone）可审计重放；反面：skills 注入无预算无仲裁（B3 承重墙论据） |
| [Letta（archive 分支）](https://github.com/letta-ai/letta) | 开源仓库源码 | 共识 #1/#4：`Memory.compile()` 零 LLM 纯函数 + 产物级幂等变更检测（B1）；`<label><description><metadata>` 载重渲染契约（3.2/B4）；反面：block limit 从硬校验退化成 prompt 提示=预算失守（3.4 硬强制的直接依据） |
| [ElizaOS（v2）](https://github.com/elizaOS/eliza) | 开源仓库源码 | 共识 #1/#2：provider 三通道（text/values/data，3.2 source 接口原型）、`cacheStable` 声明→stable 合入唯一 system/dynamic 合入 user 消息→段 hash 确定性算断点（B5 先例）；facts 检索故意零向量+置信度×时间衰减（无向量裁定再证）；反面：全局裸整数 position 排序（三键排序的反面论据） |
| [Cline（v3.39.2 + v4 monorepo）](https://github.com/cline/cline) | 开源仓库源码 | 共识 #1/#5：v3 组件注册表+声明式 config+构建期严格校验+snapshot 锁输出（B1 形态范本）；v4 整体抛弃的教训"组件化不解决该不该有这段"（B3 账本升格承重墙的核心论据）；压缩先无损后有损、溢出恢复禁 LLM；预算判断用 provider 实报 usage（3.5） |
| [OpenClaw](https://github.com/openclaw/openclaw) | 开源仓库源码 | 共识 #2/#3：`SYSTEM_PROMPT_CACHE_BOUNDARY` 显式物理边界+归位注释以字节稳定为准绳（3.3）；pre-compaction memory flush（幂等闸+三重护栏）；Dreaming 确定性门→LLM 产内容→回退 append-only 三明治；`[Untrusted daily memory]`+引用围栏防注入包裹（B4）；反面：模型自改 AGENTS.md/skills、静默截断——单用户特权清单（明确不做 #3/#4） |
| [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) | 开源仓库源码 | 共识 #2/#3：记忆召回前缀拼最后一条 user 消息而非 system（B5 先例）；条目级预算四元组（条数/单条/总量/相关度下限+pinned 豁免，3.2 budget 字段原型）；溢出拒绝摘要、整回合裁剪+breadcrumb"丢失永不静默"（3.4）；注入策略按回合来源键控；防记忆投毒 skip set |
| [Mem0（主线）](https://github.com/mem0ai/mem0) | 开源仓库源码 | 共识 #3 头号证据：教科书级 LLM ADD/UPDATE/DELETE 仲裁被主线废弃（prompt 尚在、零引用），退到纯追加+md5 确定性去重+linked_memory_ids 读时消解；细节：给 LLM 看整数 id 存 UUID 防幻觉引用 |
| [LangMem](https://github.com/langchain-ai/langmem) | 开源仓库源码 | ReflectionExecutor 去抖+新消息取消旧反思（与本库 debounce/consolidation 同构）；prompt optimizer=程序记忆作为可版本迭代的 prompt 资产（台账批次删减循环的自动化对照物，M1 观察项重启时的参照）；反面：增删改全权 LLM 工具调用，三家中离确定性管线最远 |
| [CrewAI（重写版 memory）](https://github.com/crewAIInc/crewAI) | 开源仓库源码 | 共识 #3：老四类（ShortTerm/LongTerm/Entity/External）整体删除重写，LLM 只留抽取+高相似门控仲裁两点；确定性复合分读出（0.5 语义+0.3 时近半衰+0.2 重要度，权重进 config 带 match_reasons）——记忆召回排序的可抄样板；注入文本明写"记忆可能不完整勿单独依赖"（B4 载重标头） |
| [12-Factor Agents（HumanLayer）](https://github.com/humanlayer/12-factor-agents) | 开源方法论 | Factor 3 "Own your context window"：上下文=typed event thread 的确定性序列化——typed blocks 的学理原型；Factor 9 已解决错误可移出窗口（与 Manus 保留错误轨迹的矛盾按"在途保留/闭环清除"消解，回合边界=闭环边界） |
| [priompt（Cursor/Anysphere）](https://github.com/anysphere/priompt) | 开源仓库源码 | **反面教材主证**：作者自省"给一切标 priority 是 anti-pattern"；无缓存意识的 priority 裁剪产非确定性前缀——"明确不做 #1"的直接依据；其想加未做的 `<max>`（scope 内 token 上限）正是分类容量账本形态 |
| [Advanced Context Engineering for Coding Agents（HumanLayer）](https://www.humanlayer.dev/blog/advanced-context-engineering) | 技术博客 | 上下文利用率保持 40-60%；质量排序"正确性>完整性>大小>轨迹"（错的信息比缺的更糟）——账本阈值与截断取舍的参照 |
| [Context Management（Amp/ampcode.com）](https://ampcode.com/guides/context-management) | 官方指南 | 反过度设计：500 行硬截断在生产够用、更少 context 通常更好——B3 预算实现从简的依据；handoff 用副模型蒸馏开新线程 |

## 附：与相邻文档的关系

- 各原则文档（[context-engineering-principles](./context-engineering-principles.md)、[prompt-example-hygiene](./prompt-example-hygiene.md)）的"业界资料"附录 = 就地引用；本库 = 汇总索引 + 落点映射，两者并存不冲突。
- [glossary.md](./glossary.md) A 层管"行业**术语**的学习地图"；本库管"行业**文献**的引用台账"——查概念去 glossary，查出处来这里。
- 新增流程：行业调研形成结论 → source 入本库（带日期与落点）→ 结论所在文档的附录保留就地引用。
