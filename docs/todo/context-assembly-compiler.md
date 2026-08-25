# 上下文治理三期——装配层轻量化（终稿 v2）

> 状态：**终稿 v2（2026-08-26，经外部评审四 P1 修订 + "不过度设计"终裁）**。本文档是三期唯一权威；"typed sources → 确定性编译器"原设计已整体退役（历程见第二节，编号对照见第八节）。
> 关系：二期管"记忆住哪、叫什么"（终态见 [src/memory/README.md](../../src/memory/README.md)，过程在 git 历史）；三期管"记忆怎么进 prompt"。
> 一句话：**三批、零新增机制**——归类（git mv）、冲突裁决（一个纯函数）、system 内重排（一处顺序）。执行顺序：批一 → 批三 → 批二。

## 一、三批（全部内容）

### 批一：归类批（零行为）

1. `context/sections/` 立四个子目录 procedural / semantic / episodic / working，section 文件按主类型 git mv 归位（混合型按主导类型 + 文件头注释一句）。**不加任何 memoryType 字段或常量表**（字段方案 2026-08-25 裁定否决："结构承载语义"用到底）。
   ⚠️ 既有 `PROMPT_SECTION_DOMAIN_REGISTRY` 是另一根轴（语料域 teaching/evidence，指令-数据分离执法点，PR #1000 遗产）——不动、不合并、不混淆，两轴正交并存。
   与 memory 侧"类型词不当目录名"裁定不冲突：那条针对作用域轴实体；sections 的实体是知识内容块，类型即其天然主分类轴。
2. 排序维持显式有序清单，逐项加类型/稳定档注释，顺序一字不动。
3. 一个 grep 级测试：`sections/procedural/` 与 `context/procedural/` 下每文件必含 prompt-rule-ledger 锚点注释（group-inventory 内嵌教学漏网先例的防线）。

### 批三：组装冲突裁决批（一个纯函数）

- **实施位置（2026-08-26 经评审 P1-3 修正）**：裁决前移至 preparation 装配阶段，算一次**共享裁决视图**，供 memory-block、turn-hints 等各渲染处共同消费——原定的 memory-block.formatter 内实施管不到独立渲染的 turnHints。
- **规则（2026-08-26 经评审 P1-4 按档案域宪法重写）**：①**当前会话值优先于历史档案**——历史 profile 永远是"历史待确认"姿态（宪法裁决链：本轮 accepted > session accepted > profile historical_unconfirmed；改口 badcase 血债在案）；②**置信度只在同作用域内比较**；③时间锚归一：长期 `updatedAt` / 会话 `extractedAt` 映射为统一比较键，缺失回退保守（不判新鲜）。
  注：与"意向类取高置信度"裁定无冲突——consolidation 恒压 medium，长期意向永远不高于会话值，该条款在跨层比较中是空集。
- 渲染：同字段同值去重只渲染权威一处；异值渲染胜者 + 冲突标注（"档案记 X，本次称 Y"）；turnHints 与 facts 同字段 diff——同值去重、异值标"待确认更新"、新增正常展示。
- 存储侧零改动；模型可见内层标签保留。
- 闸门：test-suite 回归 + badcase 基线 + 抽 10 条 mpr promptBlocks 前后 diff 人工审计。

### 批二：system 内重排批（一处顺序）

- **改动就一件**：prepare() 的 system 装配顺序重排——静态段（手册/渠道规范/工具目录）前置，配置段（策略红线/账号身份）居中，动态段（记忆召回块 + 当前阶段策略）置 system 末尾；全阶段一览静态地图留静态段。动态内容保持 **system 语义**，一个字节不进 messages。
- **收益机制（Qwen 恒定前提，2026-08-26 定稿）**：主聊模型长期为 Qwen，其**隐式前缀缓存自动开启**（一期查证：命中 2 折、tools 参与前缀、无需请求侧标记）——稳定前缀重排后隐式缓存自动多命中，**零协议改动**。实现时顺眼确认工具序列化逐字节稳定（tools 在前缀内）。
- **验收 = 两个已有指标**：缓存命中埋点（cachedInputTokens）前后对比 + badcase 基线不回升。回滚 = revert 装配顺序，不涉数据。
- **2b（记忆进消息侧）已否决（2026-08-25）**：个人助手先例（ZeroClaw/OpenClaw）的 user 通道坐着主人，本库 user 通道是候选人（对抗暴露面）——系统内容入候选人角色通道 = 拆掉 D2"role 即围栏"防线。正面先例是 **OpenHands 的 system 双 block**（static 打缓存标记 + dynamic_context 同在 system 内，字节级测试钉死 static 纯净）。条件重开登记：若生产数据证明历史消息缓存损失仍是主要成本，独立议题重开，不得预先牺牲角色语义。

## 二、动因与历程

1. 原始诉求（08-24）：section 未按记忆分类学组装，strategy_config 的 procedural 身份不可见；用户要求彻底专业化。
2. 编译器设计经八路调研产出、过 D1~D5 评审，随后被连续裁定缩编至本形态。
3. **判据三问（入账）**：一切外来机制先过——①它伺候的规模在本域真实存在吗（archive/围栏/编译器三刀）；②它的信任拓扑和本域一致吗（第四刀：2b——个人助手的 user 通道坐主人，客户对话 agent 的 user 通道是对抗面）；③它假设的运行实况和本库一致吗（第五刀：外部评审揭示"Anthropic 断点"方案在 Qwen 主模型生产上会空转；第六刀："不过度设计"终裁裁掉实验阵仗与 lowering 层）。

## 三、行业调研对照（依据库，industry-sources 第八节锚点；2026-08-24 八路源码级）

调研对象：OpenClaw、ZeroClaw、ElizaOS v2、Cline v3+v4、Letta、OpenHands→agent-sdk、Mem0、LangMem、CrewAI + 实践文（Manus/Anthropic/12-Factor/priompt/HumanLayer/Amp）。仓库勘误：Letta 主仓迁 letta-code；OpenHands 实现迁 software-agent-sdk；Cline v4 抛弃 v3 组件化；Mem0/CrewAI 教科书版被主线推翻；ZeroClaw 非 OpenClaw 改名。

### 五条跨项目共识

| # | 共识 | 关键证据 |
|---|---|---|
| 1 | 确定性装配是终态：装配层零 LLM | Cline v3 注册表+构建期校验；Letta compile() 纯函数；ElizaOS renderer；ZeroClaw 显式定序 |
| 2 | 缓存稳定性要有物理边界：稳定前缀/易变尾部二分 | **OpenHands system 双 block + 字节级测试（本库正面先例）**；OpenClaw CACHE_BOUNDARY 标记；（ElizaOS/ZeroClaw 的 user 侧注入仅作实现观察，信任拓扑与本库不匹配） |
| 3 | LLM 不当承重墙 | Mem0 砍仲裁退 additive+md5；CrewAI 删类型轴四类；Cline/ZeroClaw 溢出恢复禁 LLM；ElizaOS facts 零向量 |
| 4 | 模型可见标签要"载重" | Letta metadata 含用量；ElizaOS "(n retained)"；CrewAI"记忆可能不完整" |
| 5 | 没有容量治理，组件化只是让膨胀更体面 | Cline v3→v4 整体抛弃；Letta limit 退化；OpenHands skills 无预算；OpenClaw 静默截断 |

### 明确不抄

priority 竞价（priompt 自省）；按模型族 prompt 变体矩阵（Cline v4 教训）；模型自管记忆（OpenClaw 单用户特权）。

> 消化结论：#1/#3/#5 由既有形态满足；#2 由批二实现；#4 随批三冲突标注顺带。

## 四、评审记录

**内部评审 D1~D5（2026-08-25）**：D1 核心动作（2b）当日否决，残余=批二重排；D2 untrusted 围栏整体撤回（三层结构防线已在：resolution 公证/role 即围栏/evidence 不进 prompt；条件登记：新功能若注入候选人自由文本到 system 段，按 instruction-data separation 就地加围栏）；D3/D5 随依附机器退役作废；D4 重框定后并入批二（阶段策略段置尾）。

**外部评审四 P1（2026-08-26，全部采纳）**：P1-1 断点无 provider 契约 → Qwen 恒定 + 隐式缓存化解，显式断点/lowering 层不做；P1-2 实验混淆变量 → 实验阵仗整体裁撤，验收退为两个已有指标；P1-3 批三位置管不到 turnHints → 裁决前移 preparation 共享视图；P1-4 优先级与档案域宪法冲突 → 按宪法重写（当前会话优先、同层比置信度）。

## 五、明确不做（终版）

编译器 / ContextBlock 类型体系 / 排序策略函数 / budget 截断机 / 容量账本 / golden 回放阵仗 / 横幅骨架 / untrusted 围栏 / **显式缓存断点与 provider lowering 层**（Qwen 恒定 + 一期"显式不做"裁定：5 分钟 TTL 不适配回合节奏）/ **A/B/C 实验阵仗与 cacheWrite 观测**（隐式模式无此概念）/ priority 竞价 / 模型族变体矩阵 / LLM 参与装配 / 模型自管记忆 / 向量 RAG。

## 六、验收

1. 批一：目录归位可见；台账锚点测试绿；现有全库测试原样绿。
2. 批三：test-suite 回归 + badcase 基线；promptBlocks diff 复读消除、零信息丢失。
3. 批二：cachedInputTokens 前后对比 + badcase 基线；回滚路径验证过（revert 即回）。

## 七、附：相邻待办

1. **memory 侧（二期+M5）已收官**：终态见 [src/memory/README.md](../../src/memory/README.md)；字段级遗留（gender_source 批 B、brand_ids 退役条件）见 [memory-intelligence-deep-review-audit.md](./memory-intelligence-deep-review-audit.md)。
2. **⚠️ 生产 DB 迁移待随发版同批 push（当前 5 个）**：`20260821210000`（长期列名）、`20260825025701`（bot 维）、`20260825050239`（摘要拍平+水位列）、`20260825055058`（身高体重键框）、`20260825063752`（懒迁移修复）——测试库均已真实写入回读验证。仓库纪律：只发代码不推迁移（或反之）是事故源。
3. **一期基线复测**：发版后重跑基线 SQL 并取 cachedInputTokens 首个真实值（口径见 git 历史 `context-engineering-governance.md`）。

## 八、沿革与编号对照（供 industry-sources 等旧引用解析）

| 旧编号 | 现状 |
|---|---|
| B1~B3（编译器/typed blocks/治理硬化） | 退役；归类诉求由**批一**目录达成，台账防线缩为 grep 测试 |
| B4（横幅+载重标头+围栏） | 退役 |
| B5（段位重排） | 存续 = **批二**（system 内重排，2b 已否决） |
| B6 / 3.7（冲突裁决） | 存续 = **批三**（位置与优先级经外部评审修正） |
| 3.2/3.3/3.4（类型契约/排序/预算） | 退役；段位思想以设计语言存续于批二 |
| D1~D5 | 终态见第四节 |
