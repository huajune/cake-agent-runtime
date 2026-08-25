# 上下文治理三期——上下文装配编译器（Context Assembly Compiler）

> 状态：**设计定稿，待整体评审（2026-08-24）**——本文档是三期唯一权威；评审通过前不动代码。
> 理论基础：二期 [memory-coala-alignment.md](./memory-coala-alignment.md) + [glossary](../principles/glossary.md)「CoALA 记忆四分法」词条 + 本期八路源码级调研（source 台账见 [industry-sources.md](../principles/industry-sources.md) 第八节）。
> 一句话：**把 prompt 装配从"手工排序的字符串袋子"改造成"typed memory sources → 确定性编译器"**——记忆分类学、缓存段位、容量治理全部上类型，治理从纪律升级为构造即正确。

## 一、背景与动因

用户观察（2026-08-24，本期起点）：上下文有很多 section，但完全没按记忆分类学组装——strategy_config 实为 procedural memory，在装配层根本体现不出来。要的不是最小修法（元数据注解），是彻底改成专业形态。

现状三个业余点（注解救不了，需结构改造）：

1. **来源、类型、顺序三者焊死**：`SCENARIO_SECTIONS` 手写有序名单；`policy` / `runtime-context` 等聚合 section 只是"括号"，既不表达记忆类型也不表达排序理由——顺序为什么是这样，答案只活在注释里。
2. **memoryBlock 是不透明字符串**：`memory-block.formatter` 把 semantic（档案/事实）+ episodic（跨会话口径）+ working（水位提示）预渲染成一坨字符串再交 compose——分类学在进装配层之前就被抹掉。
3. **治理靠纪律不靠构造**：procedural 内容进 prompt 不需要出示台账登记，漏网只能靠人眼（group-inventory 内嵌指令实证漏网一处）。

## 二、行业调研对照（2026-08-24，八路源码级）

调研方法：八个并行子代理，clone HEAD 精读真实源码（非 README/博客），统一问卷（分类轴/装配顺序/缓存/模型可见结构/预算治理/记忆转换管线）。对象横跨两个阵营：个人开发者爆款（OpenClaw b13baca3、ZeroClaw、ElizaOS v2.0.3-beta、Cline v4 monorepo + v3.39.2 对照）与框架/专职记忆系（Letta archive 分支、OpenHands→software-agent-sdk、Mem0、LangMem、CrewAI），另加实践文一路（Manus/Anthropic/12-Factor/priompt/HumanLayer/Amp）。

**仓库状态勘误**（防后来者按旧地图找路）：Letta 主仓已清空迁 letta-code，V1 完整源码在 `archive` 分支；OpenHands 主仓已变前端，agent 实现在 OpenHands/software-agent-sdk；Cline v4 重写为 SDK monorepo，v3 组件化架构已废；Mem0 与 CrewAI 的"教科书版本"均被现行主线推翻重写；ZeroClaw 是独立 Rust 项目（社区重写竞品），非 OpenClaw 改名。

### 五条跨项目收敛的共识（各自独立演化出同一形态）

| # | 共识 | 关键证据（项目 :: 源码位置） |
|---|---|---|
| 1 | **确定性编译器是终态**：装配层零 LLM，config 即真相源，构建期校验 + snapshot 锁输出 | Cline v3 `variants/generic/config.ts` builder DSL + `validateVariant({strict})`；Letta `Memory.compile()` 纯函数 + 产物级幂等变更检测；ElizaOS v2 renderer + cache-plan；ZeroClaw `system_prompt.rs` 显式定序 |
| 2 | **缓存稳定性是类型属性，且要有物理边界**：稳定前缀/易变尾部二分，断点确定性计算 | OpenHands `section.py::CacheTier.STATIC/DYNAMIC` + 字节级测试钉死 static 块零动态内容；ElizaOS provider 声明 `cacheStable`→稳定段合入唯一 system、动态段合入 user 消息→段 hash 算断点；OpenClaw `SYSTEM_PROMPT_CACHE_BOUNDARY` 显式标记，每段归位注释以"是否破坏逐字节前缀"为准绳；Manus：KV-cache 命中率是生产第一指标（10 倍价差） |
| 3 | **LLM 不当承重墙**：两家用主线重写投票——Mem0 砍掉 ADD/UPDATE/DELETE 仲裁（prompt 尚在、主线零引用）退到纯追加+md5 去重；CrewAI 删光老四类重写，LLM 只留抽取与高相似仲裁两点 | 另证：Cline/ZeroClaw 溢出恢复禁用 LLM 摘要（"恢复不能依赖另一次 LLM 成功"）；OpenClaw Dreaming=确定性门（分数/召回次数/来源污点）→LLM 只产内容→校验失败回退 append-only；ElizaOS facts 检索**故意零向量**（BM25+置信度×时间衰减）——本库 P11/快慢环/无向量裁定全部获行业互证 |
| 4 | **模型可见分区标签是普遍实践，且标签要"载重"** | Letta `<label><description><metadata>` 含 chars_current/limit 用量；OpenHands `<MEMORY>` / `<UNTRUSTED_CONTENT>` 防注入包裹；ElizaOS `# Conversation Messages (n retained)`（括号注释自称 load-bearing，防模型全史断言）；CrewAI 注入文本明写"记忆可能不完整勿单独依赖" |
| 5 | **没有容量治理，组件化只是让膨胀更体面**（Cline 用一次全量重写换来的话） | Cline v3 组件化巅峰（12 段×9 变体）v4 整体抛弃缩到 ~60 行——组件化解决"谁能改哪段"，不解决"该不该有这段"；Letta block limit 从硬校验退化成 prompt 提示（默认放宽 100K 字符），预算实质失守；OpenHands skills 注入无预算无仲裁；OpenClaw 超限静默丢段 |

### 明确不抄（行业已证伪或单用户特权）

- **block 级 priority 竞价**：priompt 作者自省"给一切标 priority 是 anti-pattern，priority 可能是错误抽象"；按类记账（我们的账本）恰是他想加而没做的 `<max>` 形态。
- **按模型族的变体矩阵**：Cline v3→v4 教训，矩阵复杂度失控。
- **模型自管记忆/自改规程**：OpenClaw 模型自改 AGENTS.md/skills 是单用户玩具特权，多租户不可审计；本库台账制度是相反且正确的方向（二期"明确不做"第 3 条维持）。

## 三、终态设计

### 3.1 目录与模块

```
src/agent/generator/context/
├── context.service.ts                 # 薄 facade，compose() 签名不变（规约6：唯一调用方零波及）
├── compiler/
│   ├── context-compiler.ts            # sources → typed blocks → 排序策略 → 渲染（零 LLM 纯函数）
│   ├── ordering.policy.ts             # 三键排序：(placement 槽位, stability 档, 组内固定序)
│   └── capacity-ledger.ts             # 分类容量账本：逐块记账 + 确定性截断 + breadcrumb + 观测事件
├── block.types.ts                     # ContextBlock 可判别联合（见 3.2）
├── sources/                           # ═ 记忆类型轴做目录，与 src/memory/ 的生命周期轴对偶 ═
│   ├── procedural/                    #   manual / strategy-policy(persona+red-lines+stage-goals)
│   │   └── ...                        #   / channel-norms / final-check / group-invite-rules(自 group-inventory 拆出)
│   ├── semantic/                      #   candidate-memory(档案/意向/会话事实) / group-inventory(纯数据)
│   ├── episodic/                      #   cross-conversation-origin(跨会话口径/摘要引用)
│   └── working/                       #   turn-hints / hard-constraints / stage-pointer / clock
├── scenarios/scenario.registry.ts     # 场景 = source 集合（无序！顺序归编译器）
└── procedural/*.md                    # 手册物理仓不动（二期 M2-C 终态）
```

### 3.2 ContextBlock 类型契约

```ts
type Placement = 'system-stable' | 'system-config' | 'message-dynamic' | 'tail-recitation';

type ContextBlock =
  | {
      memoryType: 'procedural';
      ledgerKey: string;               // prompt-rule-ledger 锚点，CI 不变量校验必须存在
      placement: 'system-stable' | 'system-config';
      stability: 'static' | 'config';
      id: string; label: string; description?: string;
      text: string;
    }
  | {
      memoryType: 'semantic' | 'episodic' | 'working';
      placement: 'system-config' | 'message-dynamic' | 'tail-recitation';
      stability: 'session' | 'turn';
      id: string; label: string;
      text: string;
      budget?: { maxItems?: number; maxCharsPerItem?: number; maxChars: number };  // 条目级四元组（抄 ZeroClaw）
    };
```

要点：

- **procedural 不带台账键编译不过**（可判别联合），配 CI 不变量测试：遍历全部注册 source，每个 `ledgerKey` 必须能在 [prompt-rule-ledger.md](../prompt-rule-ledger.md) 解析到锚点——台账从"必经登记处（靠自觉）"升级为 correct-by-construction。
- **placement × stability 合法组合由编译器校验**：static/config 只准进 system 段；turn 级禁入 system-stable（防在稳定前缀中间抖动，OpenHands 字节级测试同款保证）。
- **渲染契约抄 Letta**：统一模板输出 label/description/内容，"怎么用"（description）与"是什么"（text）分离。
- **source 三通道抄 ElizaOS**：`produce()` 同时产 `blocks`（进 prompt）与 `data`（结构化，供工具上下文复用同源不重查）；与既有 domain 轴（teaching/evidence/tool_result）正交并存。

### 3.3 排序与段位

`ordering.policy.ts` 纯函数三键排序，输出逐字节确定：

1. **placement 槽位固定序**：system-stable → system-config →（消息序列）→ message-dynamic → tail-recitation；
2. **stability 档**：static → config → session → turn（同槽位内）；
3. **组内固定序**：source 注册表内声明的 index。

段位语义（本期新增轴，调研共识 #2 的直接产物）：

- `system-stable`：手册、策略红线、渠道规范、**工具目录**（Manus：工具定义禁随阶段增删，按阶段限工具走编排层拦截/mask，不动定义）；
- `system-config`：账号身份等改配置才变的内容；
- `message-dynamic`：记忆召回（档案/会话记忆/本轮线索）——**移出 system prompt，进消息侧**（ElizaOS Tier-2 / ZeroClaw 同款；先例：两家独立演化出"易变记忆不进 system"）；
- `tail-recitation`：阶段目标/收资清单等"当前焦点"，每轮重写在 context 尾部（Manus todo.md 结论：对抗 lost-in-the-middle；final-check 已是 suffix recitation，本段与其去重后并存）。
- cache breakpoint 显式落在 system-stable 末尾与最后一条 user 消息（OpenHands/Cline 双先例；per-provider 适配，非 Anthropic 供应商按其缓存语义降级为 no-op）。

### 3.4 预算与治理（承重墙，非配菜——调研共识 #5）

- **编译器内硬强制**：带 budget 的块由编译器确定性截断，Letta 的教训（limit 退化成 prompt 提示=预算失守）禁止重演；
- **截断必须留痕**：breadcrumb 行注明截断了什么、保留检索标识符（记忆 key/记录 id）供 just-in-time 召回——不可逆丢弃禁止（ZeroClaw"丢失永不静默"+ Anthropic 可恢复压缩）；
- **分类容量账本**：编译器每轮 emit 各 memoryType 的字符/token 占比与截断事件进 `agent_execution_events`——procedural 膨胀哨兵升级为四类账本，"这轮 prompt 里多少是规程、多少是事实"可查询可趋势；
- **超支语义 fail-open**：截断低稳定区 + 告警，不拒绝装配（生产投递链路不许 fail-closed 断流）。

### 3.5 观测

- 分类容量账本事件（3.4）；
- **provider 实报 cache usage 落观测**（cache read/write tokens，Cline 先例：用实报不用本地估算）——先量出当前每回合缓存命中基线，B5 段位重排以此验收：收益拿数字验，不拿信仰验。

### 3.6 场景注册表

场景退化为 **source 集合（无序）**；顺序、段位、预算全归编译器。复聊（reengagement）**不纳入**本编译器——独立链路裁定维持（2026-08-20），仅共享 block 类型定义。

### 3.7 组装时冲突裁决（2026-08-24 用户逐条裁定，随 B6 批执行）

记忆各层对同一字段可能各执一词。裁决在编译器内**确定性**执行（复用 `resolution/evidence` 合并原语，不新造第二套；LLM 不参与——共识 #3）：

| 字段类 | 裁决规则 |
|---|---|
| 身份档案类（姓名/电话/健康证…） | **与意向类同规则**（2026-08-25 随 M5 第 4 条复议统一——profile 为多置信来源底座，报名级写入天然 high 即权威，权威性来自置信度而非来源特权）：取高置信度，同置信度新鲜度决胜；异值渲染胜者 + "档案记 X，本次称 Y"冲突标注 |
| 意向类（城市/品牌/岗位/班次/薪资…） | **取高置信度**（用户裁定，推翻设计稿的"本次优先"）；同置信度以新鲜度（extractedAt）决胜——平局时本次会话自然胜出 |

渲染规则：同字段**同值去重**，只渲染权威一处（消灭 `[用户档案]` 与 `[会话记忆]` 的远距复读）；同字段**异值渲染胜者 + 冲突标注**。工具上下文改为消费编译器合并产物（source 三通道的 data 面），同源不重查，高置信 unwrap 语义不变。

**turnHints（原 ruleFacts，二期 M5 更名）与 facts**：存储侧单写入口**不变**——回合末 `mergeRuleAndLlmFacts` + 置信度守卫是唯一落库路径，prompt 侧预裁决永远只是展示层。组装侧做同字段 diff：同值去重只渲染已确认版；异值标"待确认更新"、不静默覆盖（turnHints 未过验证管线）；新增字段正常展示。效果：`[本轮解析线索]` 从平行 sidecar 变为相对 `[会话记忆]` 的**增量块**。

## 四、批次计划

B1–B3 输出逐字节不变（golden test 锁），纯结构落地；B4/B5 是行为批，各自独立过闸。

| 批 | 内容 | 闸门 |
|---|---|---|
| B1 | 编译器 + block.types + 三键排序策略；现有 section 机械包装成带元数据的 source | golden test：同输入下渲染输出逐字节等于现状 |
| B2 | memoryBlock 拆 typed blocks（memory-block.formatter 从"产字符串"改"产 blocks"） | 同上，逐字节不变 |
| B3 | 治理硬化：ledgerKey 强制 + 台账 CI 不变量 + 预算硬强制（四元组/breadcrumb）+ group-inventory 拆块与台账补登 + 分类容量/缓存命中落观测 | 全库测试 + 台账解析测试；观测事件真实写入验证 |
| B4 | 模型可见类型骨架：顶层横幅（如 `# 工作规程` / `# 你知道的事实` / `# 过往经历` / `# 本轮状态`）+ 载重标头（计数/窗口性/可信边界）+ 候选人来源内容的 untrusted 结构化包裹；内层契约标签（`[会话记忆]` 等）按规约 4 保留 | test-suite 回归 + badcase 基线 SQL 对比 + mpr promptBlocks 前后 diff 审计 |
| B5 | 段位重排：message-dynamic 移出 system、tail-recitation 段上线、显式 cache breakpoint | 同 B4 闸门 + B3 量出的缓存命中基线前后对比 |
| B6 | 组装时冲突裁决（3.7）：跨层同字段 diff/同值去重/胜者+冲突标注、turnHints 增量块 | 同 B4 闸门（改模型可见内容）；与 B4/B5 次序可互换 |

## 五、明确不做

1. **priority 竞价 / 动态取舍算法**（priompt 证伪；账本按类记账即可）；
2. **按模型族变体矩阵**（Cline v4 教训；本库多 provider 差异收在 llm-executor 层）；
3. **LLM 参与装配或溢出恢复**（共识 #3；恢复路径必须确定性）;
4. **运行时模型自管记忆**（二期裁定维持，OpenClaw 案例强化）;
5. **向量 RAG**（二期裁定维持，ElizaOS facts 零向量再证）。

## 六、待评审裁定项（评审时逐条拍板）

> 3.7 冲突裁决已于 2026-08-24 由用户逐条裁定（含"意向类取高置信度"对设计稿的修正），不在此列。

- **D1（最大行为变更）**：B5 记忆召回移出 system 进消息侧——两家先例支持、缓存收益最大，但改模型可见位置，风险最高。批准与否、以及是否要求先跑 shadow 对比（同 prompt 两种排布离线对拍）。
- **D2**：B4 横幅文案与 untrusted 包裹的覆盖范围（候选人自陈召回是否全包；与既有 instruction-data separation 机制的边界）。
- **D3**：预算超支 fail-open（截断+告警）的兜底语义确认（3.4 已按 fail-open 设计）。
- **D4**：tail-recitation 的内容归属——阶段目标/收资清单进尾部段后，手册内对应教学是否同批删减（防腐纪律：同一约束只准住一处）。
- **D5**：B1 golden test 的样本来源——现有测试 fixtures 之外，是否加一批 mpr 真实 prompt 回放对拍。

## 七、风险与回归闸

| 风险 | 缓解 |
|---|---|
| B1/B2 重构面广、并发会话冲突 | 纯机械改动 pathspec 分批；golden test 逐字节锁 |
| B4/B5 改模型行为 | 独立批次独立闸门；promptBlocks 全量落 mpr 可前后审计；badcase 基线 SQL 对比 |
| 规约 4 契约破坏 | 模型可见内层标签、Redis key、fixture 键一律保留兼容 |
| 非 Anthropic 供应商缓存语义差异（全角色模型运行时可配） | breakpoint 打点 per-provider 适配，不支持则 no-op；收益验收看实报 usage |
| 台账 CI 不变量误伤（台账重构改锚点） | 锚点解析器与台账文首判定树同步维护，解析失败报具体键名 |

## 八、验收

1. 拿 3.1 终态图走 `tree`，每个框指到真实路径；任何路径反查图上有框（二期体例）。
2. 台账 CI 不变量绿：全部 procedural block 的 ledgerKey 可解析。
3. 分类容量账本与缓存命中率在观测侧可查询、可趋势。
4. badcase 率不回升为唯一硬约束（沿一/二期口径，不设量化 KPI）；B5 附加缓存命中率前后对比报告。

## 附：同分支相邻待办（不属本文档批次）

- README/glossary 双轴地图补写（业界三轴 + memory vs state 之辨 + 双管线图；glossary CoALA 词条出处修正：四分法是 CoALA 对 Tulving 1972（episodic/semantic）+ Baddeley 1974（working）+ 内隐记忆/ACT-R（procedural）三条传统的工程化统一，非单一出处）。
- memory/ 结构定格与五乱源清理已升格为**二期 M5**（[memory-coala-alignment.md](./memory-coala-alignment.md) 工作包 M5，2026-08-24 逐条裁定）：short-term 伞目录（message-window / session-semantic，阶段指针并入 workbench）、7d/3d/3d 时间对齐、定时沉淀、profile 双写入路径（沉淀 medium + 报名 high，08-25 复议定稿）、ruleFacts→turnHints——不再是本文档待办。
