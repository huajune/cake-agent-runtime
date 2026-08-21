# 上下文工程原则（Context Engineering Principles）

> 实证基础：2026-08-20/21 生产基线实测 + 三个事故标本 + 2026-08-21 业界检索对照。
> 裁定记录：2026-08-21 三轮共 8 条用户裁定（原始过程见 [context-engineering-governance.md](../todo/context-engineering-governance.md)）。
> 配套现状：[knowledge-base/05-Prompt-Section动态组装体系](../knowledge-base/05-Prompt-Section动态组装体系.md)；执行清单：[todo/context-engineering-governance.md](../todo/context-engineering-governance.md)。

## 0. 一句话版本

每回合进入模型的每个 token 都在花注意力预算——**成本问题交给缓存解决，注意力问题只能靠"放对地方、按需披露、定期防腐"解决**。本文档规定内容的放置、瘦身、防腐与缓存四类纪律。

## 1. 实证基线（本文档权威性的来源）

**生产量测（2026-08-20，近 7 天 7,618 回合）**：平均 104,890 token/回合（p50 74,804 / p95 232,833）。单步输入按字符拆解：**~98% 是静态固定成本**（Section 组装产物 38.6K 字符占 52.8% + 工具 description 31.7K 占 43.4%），对话历史仅 ~1.7%——而当时全部控量闸门（60 条 / 12,000 字符）都作用在那 1.7% 上。

**三个事故标本**（每条原则背后都站着至少一个）：

| 标本 | 事实 | 教训 |
|---|---|---|
| 张漪 case（chat `69a13e919d6d3a463b0a37c6`） | 提取 reasoning 全文随每字段重复注入，单轮 system prompt 撑到 27K+ 字符，靠 badcase 反查才发现 | 无测长无告警的通道必然静默膨胀 |
| precheck 描述 13,517 → 729 字符（2026-08，收资状态机 #1023 接管） | 40+ 条硬规则实为"用自然语言写的状态机转移表"，badcase 修复逐条垒成；状态机用代码接管行为后描述归零头 | 行为逻辑寄生提示词是最大膨胀源 |
| 守卫硬规则 30 → 10 条（2026-07~10 大下线） | 同一单向棘轮病在守卫层的表现 | 只有加法算子的系统必然腐烂 |

## 2. 九条原则

### C1 注意力预算是第一稀缺资源，成本交给缓存

裁剪的排序依据是**内容对规则遵循度的稀释程度**（重复指令 > 已失效规则 > 低价值教学 > 单纯字节量），不是字节数，更不是钱——DashScope 隐式缓存自动生效（命中 2 折），钱的问题一半已自动解决，注意力稀释不会。
区分两种 rot：**context rot**（上下文越长、模型性能越衰减，业界实证）治法是瘦身与披露；**内容腐烂**（规则老化失效）治法是 C7 防腐纪律。两者并存，不可混为一谈。

### C2 前缀稳定性优先（mask, don't remove）

收敛模型行为用 **activeTools 屏蔽**，不用动态增删工具定义；组装顺序**静态在前、动态在后**；序列化必须确定性（键序不稳会静默打断前缀缓存）。**缓存命中率（`usage.prompt_tokens_details.cached_tokens`）是生产 agent 第一健康度指标**（Manus 主张，本库采纳）。
推论：任何"按状态注入/分片"类方案都要先回答"它打碎多少前缀"——76KB 手册按 stage 分片即因此被裁定降级（2026-08-21）。

### C3 行为逻辑归代码，提示词只留原则

precheck 标本证明：返回值设计得足够可执行（渲染好的模板 + 明确 nextAction），行为教学就整体消失——13.5K 描述删掉的不是废话（每条都是事故换的），是"用提示词承载业务逻辑"这个架构决定本身。评估任何巨型 description / 手册段落时，第一个问题不是"哪句能删"，而是"**哪些内容可以变成代码或返回值设计**"。

### C4 约束只准住一处（放置判定树）

约束居所实测有六处、三种变更纪律（手册 PR+review / description 代码无尺寸压力 / red-lines·thresholds·stage-strategy 走 DB 零 review / hard-constraints 等代码动态 / final-check / 守卫 rules）。新约束按树归位：

```
新约束 →
├─ 出站结果形态可确定性判定（假宣称/泄漏词等）→ 守卫 hard-rule（只拦完成时态）
└─ 生成时行为约束：
   ├─ 与单一工具强绑定 → 该工具 description
   ├─ 与单一阶段强绑定 → stage-strategy（DB）
   ├─ 跨工具跨阶段的人格/红线 → red-lines（DB）
   └─ 跨工具的操作规程 → 手册
```

铁律：**同一约束只准住一处**；"教"（prompt）与"拦"（守卫）允许成对存在，但规则台账必须互链。

### C5 渐进披露 = 按需拉取，不是分片注入

两者都叫"渐进披露"，缓存代价截然不同：**拉取**（模型调工具取内容，进 messages 后缀）不碰前缀；**分片注入**（按状态改 system prompt）打碎前缀。本库先例：长期摘要走 `recall_history` 拉取（对）；手册低频规程的出路是 playbook 拉取化（P3-4 实验），不是分片。

### C6 末尾复诵（recitation）是设计，不是冗余

final-check 置于 prompt 末尾 ≈ Manus recitation——把收口要求拉进模型最近注意力窗。精简它须按此视角评估，禁止"并入前缀省一段"式优化。

### C7 四个烂源各配一条纪律

| 烂源 | 机理 | 纪律 |
|---|---|---|
| 单向棘轮 | badcase 修复只加不减，无反向压力 | 规则台账 + finalPrompt 膨胀告警哨兵 |
| 规则与证据失联 | 规则入 prompt 即与来源 badcase 断链，事后不敢删 | 加规则必须登记来源/日期（台账必经） |
| 时效规则无 TTL | 临时口径无过期标注（标本：暑假工 2026 暑期临时规则） | 临时规则必须标注过期日期，过期即删 |
| 职责迁移不回收 | 代码接管行为后无人删 prompt 侧教学 | 接管行为的 PR 必须同批回收对应教学 |

### C8 每个内容居所必须有变更纪律

三种变更纪律分裂本身是设计缺陷；**零 review 的居所（DB 阶段策略文本，Dashboard 可改）是最危险居所**——它每回合渲染进 prompt 却从未被审计过。任何新增内容居所必须同时回答"谁审、怎么审、多大算超"。

### C9 harness 两分法与松绑就绪（2026-08-21 裁定）

Agent = Model + Harness，而 bitter lesson 正在 harness 上应验：模型持续吸收脚手架（思维链→推理模型、
工具编排→工具训练、检索管道→长上下文），"为 2026 年模型能力打造的 harness 是一件 2026 年的文物"。
但 harness 分两种，折旧规律**相反**：

| | 判断替代型 | 不变量保障型 |
|---|---|---|
| 干什么 | 替模型思考：SOP、强制流程、二次审查模型输出的链路 | 维护业务事实与安全：校验、公证、事务、去重、管道 |
| 折旧 | 随模型能力折旧，模型越强越碍事 | **不随模型折旧**（编码业务不变量，非模型弱点补丁） |
| 处置 | 松绑对象，须自带退场机制 | 保留甚至加强 |
| 本库 | 手册 SOP 规则群、守卫 LLM 语义审查（enforce 已关）、repair 链（已宣告破产待复盘）、turn-hints 教学块 | 收资状态机、P11 裁决权、booking guards、debounce 管道、记忆 pipeline、"完成时态假宣称"类确定性拦截 |

三条纪律：

1. **新增判断替代型 harness 必须自带退场机制**（shadow 档 / 开关 / 分批删+回归闸）——本库先例：守卫 enforce/shadow 双档、硬规则 30→10 批次下线、P3 删规则证据门控；
2. **折旧率按实际在跑的模型计**：本库主模型 qwen3.7-plus 非前沿、且未与本 harness 共同后训练（业界敢激进松绑的两个前提均不具备），松绑一律证据门控，禁止跟风拆；
3. **禁止反向松绑**：不得以"模型变强了"为由把业务真值维护交还模型。C3 与松绑同向（都让 prompt 变薄），反模式是两个极端——用 harness 替模型思考（过度绑）、让模型维护业务真值（过度松）。

与 Claude Code 设计哲学同构："信任模型的局部判断，把执行关进高度确定性、最小侵入的操作 harness"——本库 P11（模型作证、代码公证、本人终审）即此形状。

## 3. 骨架健康清单（业界对照，2026-08-21 检索）

本库已与业界前沿一致、**禁止倒退**的设计：

| 本库设计 | 业界对应 | 来源 |
|---|---|---|
| prepareStep activeTools 屏蔽 + 13 工具常挂 | Manus "mask, don't remove" | Manus 博客 |
| final-check 置末尾 | recitation（todo.md 复诵） | Manus 博客 |
| 四层记忆（session facts / 短期窗口 / 长期+archive） | Letta/MemGPT OS 式分层（core/recall/archival）；且本库代码 pipeline 沉淀比模型自管更可控 | MemGPT 论文系 |
| settlement 空闲摘要 | Anthropic compaction | Anthropic 工程博客 |
| `recall_history` 按需拉取 | structured note-taking 读取侧 | Anthropic 工程博客 |
| 收资状态机接管行为 | "接口设计取代行为教学"（Claude 5 世代六规则之二） | Anthropic Claude 5 博客 |
| 工具结果不跨回合、跨轮靠精简摘要承接 | append-only + 外部化上下文 | Manus 博客 |

## 4. Skill / 工具 / MCP 分工

业界共识："**Skills hold the procedure, Tools take the actions, MCP provides the access**"——Skill 是按需加载的程序性知识包（启动只载 name+description 元数据，命中才读全文），工具是回合内可调用的动作函数，MCP 是外部系统的标准化接入协议。MCP 公认痛点恰是上下文问题：**接入即全量载入工具定义**。
本库映射：有工具（13 常挂 + 2 动态注入）与 MCP 客户端（`src/mcp`），无 skill 机制；skill 式拉取是 C5 的实现路径（P3-4 实验项）。

## 附：行动清单去向

一次性治理（P0-P3 共 14 项）与常设防腐机制（F1-F5）全部在 [todo/context-engineering-governance.md](../todo/context-engineering-governance.md)；台账建成后（F1）本文档 C7 的登记纪律以台账为执行载体。

## 附：业界资料（2026-08-21 检索）

- [The New Rules of Context Engineering for Claude 5 Generation Models（Anthropic）](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
- [Effective context engineering for AI agents（Anthropic）](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [千问模型的 Context Cache 功能（阿里云百炼）](https://help.aliyun.com/zh/model-studio/context-cache)
- [Virtual context management with MemGPT and Letta](https://www.leoniemonigatti.com/blog/memgpt.html)
- [Skills vs MCP Explained: AI Agent Tools Guide](https://duet.so/guides/agent-skills-101-tools-vs-mcp-vs-skills)
- [MCPs vs Agent Skills: Understanding the Difference](https://www.damiangalarza.com/posts/2026-02-05-mcps-vs-agent-skills/)
- [Context Engineering: A Practical Guide for AI Agents（Sourcegraph）](https://sourcegraph.com/blog/context-engineering)
- [AI Agent Harness, 3 Principles for Context Engineering, and the Bitter Lesson Revisited](https://hugobowne.substack.com/p/ai-agent-harness-3-principles-for)（C9：模型吸收 harness 的折旧论）
- [Hidden Technical Debt of AI Systems: Agent Harness](https://leehanchung.github.io/blogs/2026/05/08/hidden-technical-debt-agent-harness/)
- [Scaffolding is coping not scaling — lessons from Codex（LinearB 播客）](https://linearb.io/dev-interrupted/podcast/openai-codex-thibault-sottiaux-agentic-autonomy)
- [Dive into Claude Code: The Design Space of AI Agent Systems](https://arxiviq.substack.com/p/dive-into-claude-code-the-design)（"信任局部判断+确定性执行 harness"的出处）
