# 上下文治理三期——装配层轻量化（终版）

> 状态：**轻量化终裁定稿（2026-08-25）**。本文档是三期唯一权威；此前的"typed sources → 确定性编译器"设计已整体退役（历程见第二节，编号对照见第八节）。
> 关系：二期管"记忆住哪、叫什么"（已收官，终态见 src/memory/README.md，过程见 git 历史 memory-coala-alignment.md），三期管"记忆怎么进 prompt"（装配侧）。
> 一句话：**三期最终 = 三个轻量批**——归类（零行为）、冲突裁决（内容去重与标注）、system 内重排（缓存收益，记忆不出系统通道）。建议执行顺序：批一 → 批三 → 批二（让重排对拍的样本反映去重后的终态内容）。

## 一、有效方案（全部内容就这三件）

### 批一：归类批（零行为变化，纯 git mv）

1. `context/sections/` 按知识类型立四个子目录（procedural / semantic / episodic / working），section 文件按主类型归位——"strategy_config 是 procedural 但装配层体现不出来"的原始诉求**由目录结构达成，零字段零运行时痕迹**（~~字段标注方案~~ 2026-08-25 用户裁定否决："结构承载语义"用到底）。混合型 section 按主导类型归位、文件头注释说明。
   与 memory 侧"类型词不当目录名"裁定不冲突：那条针对作用域轴实体（按活多久分家，类型只做映射）；sections 的实体是知识内容块，类型即其天然主分类轴。
2. 排序维持**显式有序清单**（现状机制），清单逐项加类型/稳定档注释——十几个块的顺序，人可读清单优于策略函数。
3. 一个 grep 级测试：`sections/procedural/` 与 `context/procedural/` 下每个文件必含 prompt-rule-ledger 锚点注释，缺失即红（group-inventory 内嵌教学漏网先例的防线）。

### 批二：system 内重排批（真收益所在）

目标：**system 静态前缀逐字节稳定**，静态大头命中前缀缓存（Manus 10 倍价差账）。

- 段位思想（设计语言，非运行时元数据；**全部在 system 内部**）：`静态段`（手册/渠道规范/工具目录，前置）→ `配置段`（策略红线/账号身份）→ `动态段`（记忆召回块 + 当前阶段策略，**置 system 末尾**——阶段策略离生成点更近且不再炸中部缓存，D4 注意力与缓存双赢；全阶段一览静态地图留静态段）。
- memoryBlock 的拆分只在本批重排时顺手做，不做通用 block 化。
- **⚠️ 2b（记忆进消息侧）已否决（2026-08-25 用户第四刀）——信任拓扑不匹配**：所引先例（ZeroClaw/OpenClaw 个人助手、OpenHands 编码 agent）的 user 通道属于**主人/操作者**（最高信任方），系统资料入 user 消息无风险；本库是**面向候选人的客户对话 agent**，user 通道是外部对抗暴露面——系统内容灌入候选人角色通道 = 亲手拆掉 D2 立的"role 即围栏"防线（且候选人可模仿数据块样式文本制造新注入面，截图夺号族的攻击面复刻）。ElizaOS 虽同拓扑但恰是被公开注入打穿的反面案例。**D2 与 2b 自相矛盾，2b 出局；历史消息缓存那部分收益的价钱是拆围栏，不赚。**
- **批二终态（2026-08-25 用户定稿七条）**：①保留记忆、实时状态等动态内容的 **system 语义**（不改通道）；②system 拆"**稳定前缀 + 动态尾部**"；③稳定前缀末端设**厂商支持的显式缓存断点**；④"记忆搬进 synthetic user"的 2b 方案**撤销**；⑤ElizaOS、ZeroClaw **降级为实现观察**，不再作为本库搬家的决策依据（信任拓扑不匹配）；⑥**OpenHands 的 system 双 block 是更直接的正面先例**（static block 打 cache_prompt + dynamic_context 同在 system 内，字节级测试钉死 static 纯净——与本批终态同构且系刻意设计）；⑦**条件重开登记**：若生产数据证明"历史消息缓存损失"仍是主要成本，作为独立议题重开评估，**不得预先牺牲角色语义**。回滚＝改回装配顺序，不涉数据。
- **执行闸门（三步走，数据自动去留，无人工裁定点）**：①离线对拍——抽 20~30 条真实回合（promptBlocks 在 mpr 齐全）+ test-suite 场景集，两种排布各生成回复对比，系统性劣化即止损不动代码；②按托管账号灰度，验 badcase 基线不回升；③全量 + 缓存命中率前后对比报告（基线用一期 P0 已落的缓存命中埋点）。
- 契约：模型可见内层标签（`[会话记忆]` `[用户档案]` 等）保留不动。

### 批三：组装冲突裁决批（2026-08-25 用户裁定升格执行，~~登记待批~~）

语义已由用户逐条裁定（2026-08-24/25）。实施位置：`working-memory/memory-block.formatter` 渲染前的确定性预裁决函数（复用 `resolution/evidence` 的 isSameFactValue 等原语，零 LLM）。闸门：改模型可见内容 → test-suite 回归 + badcase 基线 + mpr promptBlocks 前后 diff 审计。

| 规则 | 内容 |
|---|---|
| 字段裁决 | 身份类与意向类同规则：**取高置信度**，同置信度以新鲜度（extractedAt）决胜——平局时本次会话自然胜出（长期 profile 为多置信来源底座，报名级写入天然 high 即权威，权威来自置信度非来源特权） |
| 渲染 | 同字段**同值去重**只渲染权威一处（消灭 `[用户档案]` 与 `[会话记忆]` 远距复读）；**异值渲染胜者 + 冲突标注**（"档案记 X，本次称 Y"） |
| turnHints vs facts | 存储侧单写入口不变（回合末合并管线是唯一落库路径）；组装侧同字段 diff：同值去重、异值标"待确认更新"不静默覆盖、新增正常展示——`[本轮解析线索]` 从平行 sidecar 变增量块 |

前置依赖：mergePreferences 同值保留旧信封已落地（M5-深审实锤 3），新鲜度决胜的时间锚可信。

## 二、动因与历程（为什么终版长这样）

1. **原始诉求（2026-08-24）**：section 未按记忆分类学组装，strategy_config 的 procedural 身份不可见；用户要求"彻底改成专业方式"。
2. **编译器设计**：八路源码调研后产出"typed sources → 确定性编译器"方案（ContextBlock 联合类型/三键排序策略/预算截断机/容量账本/六批次），并通过 D1~D5 评审。
3. **三连刀缩编（2026-08-25）**：用户以"机制按域真实规模选型"原则连续裁掉三个样板误植——archive（为 0.14% 的行建压缩系统）、untrusted 围栏（为架构上不存在的场景建防线）、**编译器本身**（为十几个 section、单场景注册表、单维护者的 prompt 建 Cline/priompt 量级的港口）。三期收敛为本文档第一节。
4. **通用判据（入账，两问）**：一切外来机制先过两问——①**它伺候的规模在本域真实存在吗**（archive/围栏/编译器三刀）；②**它的信任拓扑和本域一致吗**（第四刀：个人助手/编码 agent 的 user 通道坐着主人，客户对话 agent 的 user 通道是对抗暴露面——同一个"记忆拼进 user 消息"，在前者是优化、在后者是拆围栏）。

## 三、行业调研对照（依据库，industry-sources 第八节的锚点；2026-08-24 八路源码级）

调研对象：个人开发者爆款（OpenClaw、ZeroClaw、ElizaOS v2、Cline v3+v4）、框架/专职记忆系（Letta、OpenHands→agent-sdk、Mem0、LangMem、CrewAI）、实践文（Manus/Anthropic/12-Factor/priompt/HumanLayer/Amp）。仓库状态勘误：Letta 主仓清空迁 letta-code（V1 在 archive 分支）；OpenHands 实现迁 software-agent-sdk；Cline v4 重写抛弃 v3 组件化；Mem0 与 CrewAI 的教科书版本均被主线推翻；ZeroClaw 是独立 Rust 项目非 OpenClaw 改名。

### 五条跨项目收敛的共识

| # | 共识 | 关键证据 |
|---|---|---|
| 1 | **确定性装配是终态**：装配层零 LLM，config 即真相源 | Cline v3 组件注册表+构建期校验；Letta `Memory.compile()` 纯函数；ElizaOS v2 renderer+cache-plan；ZeroClaw 显式定序 |
| 2 | **缓存稳定性要有物理边界**：稳定前缀/易变尾部二分 | OpenHands `CacheTier` + 字节级测试；ElizaOS `cacheStable`→stable 合入唯一 system、dynamic 合入 user 消息；OpenClaw `SYSTEM_PROMPT_CACHE_BOUNDARY` 显式标记；ZeroClaw 记忆注入拼最后一条 user 消息 |
| 3 | **LLM 不当承重墙** | Mem0 砍 LLM 增删改仲裁退回 additive+md5；CrewAI 删类型轴四类重写；Cline/ZeroClaw 溢出恢复禁 LLM；ElizaOS facts 检索故意零向量 |
| 4 | **模型可见标签要"载重"** | Letta `<label><description><metadata>` 含用量；ElizaOS "(n retained)" 自称 load-bearing；CrewAI 注入文本明写"记忆可能不完整" |
| 5 | **没有容量治理，组件化只是让膨胀更体面** | Cline v3 组件化巅峰被 v4 整体抛弃；Letta block limit 退化成 prompt 提示；OpenHands skills 注入无预算；OpenClaw 静默截断 |

### 明确不抄

1. **block 级 priority 竞价**（priompt 作者自省"给一切标 priority 是 anti-pattern"）；2. **按模型族变体矩阵**（Cline v4 教训）；3. **模型自管记忆/自改规程**（OpenClaw 单用户特权，多租户不可审计）。

> 缩编后的消化结论：共识 #1/#3/#5 由本库既有形态满足（装配本就零 LLM；台账+哨兵即容量治理）；共识 #2 由批二实现；共识 #4 的"载重标头"随登记项冲突裁决顺带（横幅骨架已退役）。

## 四、评审裁定记录（D1~D5 终态）

| 项 | 终态 |
|---|---|
| D1 记忆召回移出 system | ⚠️ **核心动作（2b 进消息侧）当日晚间被否决**（信任拓扑不匹配，见批二节）；D1 残余=system 内重排并入批二，三步走闸门保留 |
| D2 untrusted 包裹 | ✅ **整体撤回**——防注入已有三层结构防线（resolution 公证写入路径 / role 即围栏 / evidence 全文不进 prompt），围栏是"生文本进 system"架构的样板，本库架构性无此场景；条件登记：未来若有新功能注入候选人自由文本到 system 段，按 instruction-data separation 宪法就地加围栏 |
| D3 预算 fail-open | ✋ 随预算截断机退役而作废 |
| D4 tail-recitation 归属 | ✅ 议题重框定：收资清单半边被收资状态机吸收（清单=工具输出）；手册删减半边不适用（无新重复）；余下裁定=阶段策略段按段位搬尾，并入批二 |
| D5 golden 回放样本 | ✋ 随 golden 阵仗退役而作废 |

## 五、明确不做（终版）

编译器 / ContextBlock 联合类型 / 排序策略函数 / budget 截断机 / 容量账本子系统 / golden 回放阵仗 / B4 横幅骨架 / priority 竞价 / 模型族变体矩阵 / LLM 参与装配或溢出恢复 / 运行时模型自管记忆 / 向量 RAG（后四条为原设计裁定沿袭）。

## 六、验收

1. 批一：标注齐全可 grep；台账锚点测试绿；零行为（现有测试全绿即证）。
2. 批二：三步走各闸留痕（对拍报告、灰度 badcase 基线、命中率前后对比）；badcase 率不回升为唯一硬约束。
3. 批三：test-suite 回归 + badcase 基线；同字段复读在 promptBlocks diff 中可见消除。

## 七、附：同分支相邻待办

1. **memory 侧（二期 + M5）已收官**：过程记录见 git 历史 `docs/todo/memory-coala-alignment.md`（2026-08-25 收官删除）；终态见 [src/memory/README.md](../../src/memory/README.md)；字段级遗留（gender_source 批 B、brand_ids 退役条件、观察项）见 [memory-intelligence-deep-review-audit.md](./memory-intelligence-deep-review-audit.md)。
2. **⚠️ 生产 DB 迁移待随发版同批 push**：`20260821210000`（长期层列名 CoALA 改名）与 `20260825025701` / `20260825050239` / `20260825055058` / `20260825063752`（长期 bot 维 / 摘要拍平与水位列 / 身高体重键框 / 懒迁移修复）——测试库已完成真实写入回读验证，生产未 push。仓库纪律：只发代码不推迁移（或反之）是事故源。
3. **一期基线复测**：一期（P0/P1/P3 批）发版后重跑基线 SQL（mpr `token_usage` 近 7 天 + `agent_invocation.request.agentRequest` 分字段测长），并取 `agent_steps` 里 `cachedInputTokens` 的缓存命中率首个真实值。一期文档已收官删除，SQL 口径见 git 历史 `docs/todo/context-engineering-governance.md` 第一节。

## 八、沿革与编号对照（供 industry-sources 第八节等旧引用解析）

| 旧编号 | 现状 |
|---|---|
| B1（编译器+typed blocks+三键排序+golden） | 退役；分类学可见诉求由**批一**以标注达成 |
| B2（memoryBlock 拆 typed blocks） | 退役；拆分并入**批二**搬家时顺手做 |
| B3（ledgerKey 强制+CI+预算硬强制+账本） | 缩编：台账锚点 grep 测试入**批一**；预算机与账本退役（域内无无界块，一期哨兵已覆盖总量） |
| B4（横幅骨架+载重标头+untrusted 包裹） | 退役（围栏=D2 撤回；载重标头随登记项顺带） |
| B5（段位重排） | 存续 = **批二** |
| B6（组装冲突裁决 3.7） | 存续 = **批三**（2026-08-25 升格执行） |
| 3.2 ContextBlock / 3.3 三键排序 / 3.4 预算治理 | 退役；3.3 的段位思想以设计语言存续于批二 |
| 3.7 冲突裁决语义 | 存续，全文见第一节登记项 |
