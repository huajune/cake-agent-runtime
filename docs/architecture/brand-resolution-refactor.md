# BrandResolution 全链路改造方案

> 状态：**v5（2026-07-16 实施后修订）**——Phase 1–4 已全量实施并随 v10.12.0 上线（PR #561，2026-07-15）；本版收录上线后 48h 内的实施偏离与事故修订（§17）  
> 前版：v4（2026-07-14 全量代码核查重评：品类展开赦免收紧 / 异步补写时序防护 / 过渡期旧兜底门控 / 写入点与守卫切换点清单补全 / 观测落点修正 / 现状口径校正）；v3（2026-07-13 评审迭代）  
> 分支：`codex/brand-resolution`（已合入 develop）；热修 `fix/brand-alias-collapse-hotfix2`（PR #577）  
> 本文自 v5 起为**已实施系统的权威规格**：正文描述终态设计，实施偏离与事故修订集中在 §17，新变更先改文档再改码。

## 1. 背景

当前系统在用户消息、微信昵称、图片识别结果、会话记忆以及工具模型参数中都会接触到品牌信息，但各入口缺少统一的品牌标准化和意图语义。

已经观察到的典型问题包括：

- 未命中品牌库的微信昵称被模型当成品牌，例如 `Gattouzo`；
- `不要肯德基`、`除了肯德基都可以` 可能被提取成正向品牌偏好；
- 品牌别名在事实提取、工具入口和守卫中分别处理，结果不一致；
- `preferences.brands` 长期做数组并集，过期品牌持续影响后续查询；
- 工具将模型原始 `brandAliasList` 当成权威品牌事实；
- 出站守卫读取模型原始参数，而不是工具实际采用的标准化品牌条件；
- 短别名和冲突别名缺少统一的上下文门槛及歧义表达。

本次改造不是只修复 `Gattouzo` 单点问题，而是建立一条统一、可解释、可审计的品牌识别链路。

## 2. 已确认的业务事实

### 2.1 `contactName` 的真实语义

当前企微链路中的 `contactName` 表示候选人的微信昵称。项目内没有独立的 `contact_remark` 字段——该命名全库仅剩工具来源枚举一处字面量（`brandAliasSource: 'contact_remark'`），属历史误会，随 Phase 3.4 档位废除自然消失，无独立修正工作量。

关键业务事实（最终裁定）：**部分候选人在添加微信好友时，会自己把微信昵称改写为“昵称 + 品牌/门店”**（如“小王 肯德基五角场”）——品牌信息是候选人本人写上去的，不是运营维护的备注；但只有部分候选人这么做，其余人的昵称就是普通昵称。因此：

- `contact_name` 不能统一视为低可信来源；
- 唯一、明确命中品牌库时，它是强品牌线索；
- 未命中品牌库时，它只是普通昵称，不得推断为品牌；
- 短别名、冲突别名和模糊命中不得直接成为高置信品牌。

例如：

| 微信昵称 | 品牌库结果 | 处理 |
| --- | --- | --- |
| `肯德基-上海` | 标准名唯一命中 | 高置信品牌线索 |
| `KFC松江` | 唯一别名命中肯德基 | 高置信品牌线索 |
| `奥乐齐-杨浦` | 标准名安全包含 | 高置信品牌线索 |
| `Gattouzo` | 无命中 | 不产生品牌结果 |
| `全家幸福` | 短别名且上下文不足 | 不识别 |
| 冲突别名 | 对应多个品牌 | 标记歧义，不直接使用 |

### 2.2 图片识别是独立品牌来源

当前项目同时存在多模态 Vision 和图片描述回写链路。招聘截图、招聘海报、岗位卡片中可能提取出品牌名及品牌 ID。

图片中识别出的品牌就是候选人的正向品牌意向：

- 仅发送岗位截图：图片中的品牌按 `positive` 处理；
- 图片配文“这个还有吗”：品牌仍为正向意向，同时用户文字表达询问；
- 图片配文“这个不考虑”：用户当前明确的排斥意图优先于图片正向意向。

图片来源统一命名为 `image_description`，不命名为 `image_ocr`，因为现有能力不仅是字符 OCR，也包含视觉理解。

## 3. 改造目标

1. 建立统一 `BrandResolution`，输出标准品牌、品牌 ID、来源、匹配方式、意图极性、置信度和歧义。
2. 所有品牌名称和别名均通过品牌库验证，优先使用品牌 ID。
3. 正确区分正向、排斥和不限品牌（“换个品牌”归入排斥、询问/提及类归入正向，见 6.3）。
4. 微信昵称命中品牌库后作为会话品牌状态的初始值（seed）：首轮推荐即按该品牌启动，此后与对话表达的品牌完全同权演进，不覆盖用户后续明确表达。
5. 图片识别品牌保留独立来源，并按候选人正向品牌意向处理。
6. 工具通过明确的 `brandFilterMode` 执行品牌过滤，不再通过空数组猜测意图。
7. 会话品牌由永久并集改为当前主品牌 + 排斥品牌两字段（历史由观测事件流回放，不入状态）。
8. 出站守卫读取工具归一化后的品牌查询元数据，不再信任模型原始参数。
9. 增加可观测信息，能回答“品牌从哪里来、为什么命中、最后应用了什么”。

## 4. 非目标

第一版不做以下事项：

- 不建设通用 Entity Resolution 或 Domain 框架；
- 不提前实现地址解析；
- 不允许大模型脱离品牌库猜测或创造标准品牌；图片转写（多模态主 Agent 回写或独立 Vision 服务，见 10.1）仍负责从图片中识别品牌、品牌 ID 等可见信息；
- `resolve()` 解析管线内部不做拼音、编辑距离等模糊匹配；生产已有的 0 结果同音回指（`brand-fuzzy-match.util`，aliasFuzzyMatch）广义上也是品牌归一化，因此归入品牌域居所（`resolution/brand/fuzzy-recall.ts`，见 5.1），但作为独立管线**保持行为不动**、不并入 `resolve()`——两者候选集、置信契约、触发条件均不同，见 8.3；
- 不一次性强制迁移全部 Redis 存量数据；
- 不让 `BrandResolution` 负责会话存储、工具调用或回复生成。

## 5. 架构位置

### 5.1 单一居所原则

品牌归一化/匹配的私有实现目前散在**七处**（全量清点，含各自私有的归一化函数——`normalizeForBrandMatch` 在 memory、`normalizeKeyword` 在 tools、`normalizeClaimedBrand` 在 guardrail，三套规则各自演化，这就是「同一品牌名多处判断结果不一致」的结构性原因）：

| 现状位置 | 逻辑 | 终态归属 |
| --- | --- | --- |
| `memory/facts/high-confidence-facts.ts` | `normalizeForBrandMatch` / `buildExactMatchTokens` / 品牌降噪词表 | 迁入 `brand-normalize.ts`，成为**全库唯一**归一化实现 |
| 同上 | `getBrandMatchAssets` 目录索引构建 | 迁入 `catalog-index.ts`（改名，逻辑即现有实现） |
| 同上 | `detectBrandAliasHints` 别名匹配 + 品类兜底 | 匹配主体迁入 `brand-matcher.ts`，品类段迁入 `category-expansion.ts`；memory 留适配层（过渡期），最终删除 |
| 同上 | `mergeDetectedBrands` 永久并集 | **删除**，由 `brand-state.reducer.ts` 取代 |
| `tools/duliday/job-list/brand-fuzzy-match.util.ts` | 0 结果同音回指 | 迁入 `fuzzy-recall.ts`（逻辑不变，只换居所） |
| `tools/duliday/job-list/search.util.ts` | `filterJobsToRequestedBrands` 私有包含匹配（`normalizeKeyword` + **单向** `brandName.includes(alias)` 含剥门店后缀重试；代码注释明确刻意不做反向匹配） | 入口标准化（8.2）后过滤条件是品牌 ID/标准名，本地过滤退化为**等值比较**；私有包含匹配策略废弃，不迁移 |
| `tools/utils/sanitize-brand-name.util.ts` | 对外公司名规范化：把历史名“独立日”统一改写为“独立客”（含自然短语映射与合法词白名单），**非**泛化的品牌错名修正 | 迁入 `sanitize-brand-name.ts`（逻辑不变，只换居所；它治理的是本公司对外称谓而非候选人品牌，归入品牌域取“文本品牌治理同居所”的宽口径） |
| `agent/generator/preparation.service.ts` | `deriveContactBrandAliases` 昵称品牌校验 | 改为调用 `BrandResolutionService.resolve(nickname, 'contact_name')` |
| `agent/guardrail/output/rules/brand-name-errors.rule.ts` | `normalizeClaimedBrand` 私有归一化 + 直读模型 `brandAliasList` 对账 | 归一化改 import `brand-normalize.ts`；对账数据源改 queryMeta（第 11 节） |

终态硬规则：

1. **品牌的归一化、识别、标准化、极性、品类、回指、状态迁移规则，只允许存在于 `resolution/brand`**——包括看似不起眼的文本归一化原语，任何模块不得再私有实现 normalize / includes 匹配；
2. memory 管存储与锁，tools 管消费与查询，guardrail 管对账，三者只 import；
3. Phase 4 收尾时全库 grep 审计（`normalizeForBrandMatch|normalizeClaimedBrand|normalizeKeyword.*brand` 等），确认旧散点全部删除或改为 re-export，防止双实现残留。

### 5.2 文件布局

按职责预先拆分（而不是先塞一个大 service 再说），每个文件单一职责、可独立测试。**每个文件都标注来源：绝大部分是既有代码迁移归位，真正新写的只有四个**：

```text
src/resolution/brand/
├── brand-resolution.types.ts      # 新增：全部类型契约（来源/匹配方式/极性/结果/queryMeta）
├── brand-resolution.service.ts    # 新增：DI 门面（注入 SpongeService，薄封装，无业务逻辑）
├── brand-normalize.ts             # 迁移：normalizeForBrandMatch / buildExactMatchTokens / 降噪词表
│                                  #   （自 memory/facts/high-confidence-facts.ts）
├── catalog-index.ts               # 迁移：getBrandMatchAssets 目录索引构建（同上，改名归位，非新概念）
├── brand-matcher.ts               # 迁移：detectBrandAliasHints 匹配主体（同上）+ 新增置信度档位
├── category-expansion.ts          # 迁移：detectBrandAliasHints 的品类兜底段 + 品类词典（同上）
├── polarity-rules.ts              # 新增：极性确定性规则轨（模式清单集中在此，一处维护）
├── brand-state.reducer.ts         # 新增：SessionBrandState 纯 reducer：(prevState, resolutions[]) → nextState
├── fuzzy-recall.ts                # 迁移：0 结果同音回指（自 tools/duliday/job-list/brand-fuzzy-match.util.ts）
└── sanitize-brand-name.ts         # 迁移：对外公司名规范化“独立日”→“独立客”（自 tools/utils/sanitize-brand-name.util.ts）

tests/resolution/brand/            # 镜像结构，逐文件对应 spec；迁移文件连同既有 spec 一起搬
```

分工要点：

- `brand-resolution.service.ts` 只做「取目录 → 调纯函数 → 返回」，所有逻辑在纯函数模块里，单测不需要 NestJS 容器；
- **状态迁移规则（9.3）实现为 `brand-state.reducer.ts` 纯 reducer**：规则集中一处、顺序无关性可直接单测；memory 侧只负责「持锁读 `brand_state` → 调 reducer → 写回」，不含任何迁移规则。这与第 4 节非目标不冲突——reducer 定义迁移规则，不做存储；
- `fuzzy-recall.ts` 与解析主链路物理分居：它不被 `resolve()` 调用，只被工具在 0 结果时显式调用，目录结构上就能看出「解析」与「查询失败补救」是两条链路；
- 端到端时序见 5.3 总览。
- **所有 LLM 调用都不在本目录**，`resolution/brand` 是纯确定性代码。品牌链路上有两个 LLM 触点，居所与角色各不相同：
  - 图片转写（图片 → 文字描述，含“品牌ID：10239”行）做的是**感知转写**、不做品牌认定；转写者有两个可能身份（多模态主路径=主 Agent 工具回写、兼容路径=channels 独立 Vision 服务，见 10.1），产出统一为 `image_description` 来源，经 `resolve()` 走与文字消息同一条确定性匹配，解析时机统一在 turn-finalizer（10.2）；
  - 极性 LLM 轨（fact-extraction 扩展输出极性）属 memory，做的是**语义判断**；其输出的品牌名必须回调 `resolution/brand` 验证后才能进 reducer（6.3.1）。
  - 共同原则：LLM 只产出候选文本或极性判断，**品牌实体是否成立一律由本目录的目录验证裁定**——即第 4 节“不允许 LLM 脱离品牌库创造标准品牌”在代码组织上的落法。品牌链路全部四个 LLM 触点（含主 Agent、守卫语义档）的权限边界见 6.6 全景表。

依赖方向：

```text
Sponge 品牌目录
        ↓
resolution/brand
        ↓
memory / agent preparation / tools / guardrail
```

`resolution/brand` 不反向依赖 SessionService、具体工具、Prompt、Redis 或 Guardrail。

### 5.3 端到端链路总览

一轮回合中品牌信息的完整流转。两个时间锚点：**回合准备**解析文字类来源，**turn-finalizer** 解析图片来源并统一写状态——品牌状态一轮只在收尾写一次：

```text
【接入】channels/wecom
  文本消息 ──────────────→ 存历史
  图片消息 ─┬ 主模型多模态 → 存历史(带类型标识)，不转写
            └ 不支持vision → 独立Vision预转写，描述落历史
  Debounce 静默窗口合并成一轮
        ↓
【回合准备】preparation / memory.onTurnStart          ← 锚点一
  resolve(用户文字, 'user_text')     规则轨定极性（前置高置信识别），目录匹配定实体
  resolve(昵称, 'contact_name')   目录验证；首轮 brand_state 不存在时
                                   seed 为 currentBrand（仅一次，见 9.4）
  读 SessionBrandState → Prompt Section 注入品牌状态
        ↓
【主 Agent 回合】generator
  看文字+原图(多模态)+品牌状态提示
  调 save_image_description → 描述回写（含“品牌ID：10239”）
    └ execute 内同步 resolve(描述) → 图片品牌挂回合上下文（10.2）
  调 duliday_job_list → 传 brandIdList/brandAliasList
        ↓
【工具入口】tools（8.2）
  入口标准化：别名→标准品牌→优先ID；未验证/歧义/低置信 → rejected
  brandFilterMode 入参只描述查询形态（8.1）：
    传了品牌            → enforce/exclude 按品牌查（brandSource=model_input）
    品牌与 mode 皆省略  → 会话品牌兜底：currentBrand（昵称品牌经首轮 seed 已在其中），
                          命中按 enforce 执行并披露（brandSource=session_state）
    clear / browse_all  → 无品牌查询（策略放宽 / 候选人明确不限）
  查询执行；口误0结果 → fuzzy-recall 回指建议（8.3）
  产出 queryMeta（filterMode + brandSource，审计可区分“模型要的”与“兜底给的”）
        ↓
【出站守卫】guardrail（第 11 节）
  硬规则 + 语义档只读 queryMeta 对账
        ↓
【turn-finalizer / memory.onTurnEnd】统一副作用出口    ← 锚点二
  extract_facts（LLM 轨）             极性判断+指代链接，品牌名回目录验证（6.3.1）
  复用回合上下文中的图片品牌解析结果    缺描述→异步补写（10.3，重新持锁+过期即弃）
  汇总本轮全部结果 → reducer 批量应用（先 positive 后 negative，
                     排在 extract_facts 之后且不因其失败跳过，同一串行步骤序列）
  → 持租约锁写 facts hash 单字段 brand_state（9.1）
        ↓
【观测】brand_state_change（状态变化时才落，第 12 节）
  查询审计随 agent_invocation 在流水表；解析可离线重放（纯函数）

【下一轮】会话品牌兜底从 currentBrand 拉回品牌
```

（图为终态链路。过渡期另有 `preferences.brands` 只读投影供未迁移的 Prompt Section 读取，见 9.2，Phase 4.4 随迁移完成删除，不属于终态架构。）

四条贯穿性规则：

1. **实体裁定只有一处**：`resolve()` 的目录验证；四个 LLM 触点（6.6）产出的只是候选文本/极性/参数；
2. **状态写入只有一扇门**：turn-finalizer 里的 reducer；准备阶段、工具、守卫全部只读；
3. **当轮行为与跨轮状态解耦**：当轮查什么靠主 Agent 判断 + 入口标准化 + 会话品牌兜底，不等图片解析；图片品牌进状态服务的是下一轮；
4. **审计一条线**：三类事件同 trace_id 落库，任何品牌行为可回答“从哪来、为什么命中、最后用了什么”。

## 6. BrandResolution 设计

### 6.1 来源

```ts
export type BrandResolutionSource =
  | 'user_text'
  | 'contact_name'
  | 'image_description';
```

会话记忆是结构化状态，不属于原始解析来源；模型工具参数也不是用户事实来源，因此不加入该类型。

### 6.2 匹配方式

```ts
export type BrandMatchType =
  | 'brand_id'
  | 'canonical_exact'
  | 'alias_exact'
  | 'alias_containment'
  | 'category_expansion';
```

匹配方式记录的是「这条结果靠什么证据在品牌库命中」，决定置信度档位（7.4），并随 queryMeta 落观测，供误判归因——分类轴是证据形态，因为**证据形态决定误判时的修法**：`alias_containment` 是唯一放弃词边界的档（安全性靠长别名白名单人工维护），误判了收紧白名单；`alias_exact`/`canonical_exact` 的误判只能来自品牌库收录了坏名称，修法是清理库数据。修法不同的档位不合并，否则归因只能靠置信度数字反推：

| 匹配方式 | 含义 | 例子 |
| --- | --- | --- |
| `brand_id` | 文本中直接出现品牌 ID | 图片描述中的“品牌ID：10239”（见第 10 节格式契约） |
| `canonical_exact` | 归一化后与标准名完全相等 | “肯德基” → 肯德基 |
| `alias_exact` | 归一化后与唯一别名完全相等 | “KFC” → 肯德基 |
| `alias_containment` | 安全长别名以子串形式出现在整句中 | “我要瑞幸咖啡的兼职” → 瑞幸咖啡 |
| `category_expansion` | 品类词展开为品类下一组品牌 | “咖啡” → 品类内每个品牌一条结果 |

三个补充说明：

**什么叫“归一化后相等”**：匹配前先把文本清洗成统一形态——大写变小写、全角变半角、去掉空格和分隔符（完整规则见 7.1）。这样“KFC”“kfc”“K F C”清洗后是同一个字符串，都能对上品牌库里的 KFC。清洗只为对比用，展示给人看的 `matchedText` 仍保留原文。

**长别名和短别名的匹配规则为什么不同**：

- “瑞幸咖啡”这种长名字，出现在句子中间就算命中——“我要瑞幸咖啡的兼职”能认出瑞幸咖啡。几个字连在一起出现，基本不可能是巧合；
- “全家”这种短名字（同时也是日常词），必须是候选人独立说出的词才算命中——说“想去全家”算，说“我们全家都可以”不算，那里的“全家”只是日常用语的一部分。如果短名字也按“出现在句中就算”，7.3 列的误判案例（“我们全家都可以”“给我来一份工作”）全都会发生。

**查不到就不猜**：品牌库里对不上的词，一律不当成品牌，不做“长得像”“读音像”的猜测。原因是解析结果会被系统当成事实使用——写进会话记忆、决定查哪些岗位、被守卫拿来对账。事实必须能指着品牌库说“就是这一条”；对不上的（如微信昵称 `Gattouzo`）宁可不认。查询失败后的同音口误猜测（“刘姐妹”→“成都你六姐”）是另一条独立链路，猜完必须问候选人确认才作数，详见 8.3；解析层将来是否放宽引入受控模糊匹配，等 Phase 4 拿到线上未命中率数据再决策。

**`category_expansion`（品类展开）**：

- 触发条件：文本命中品类词（如“咖啡”）且未命中任何具体品牌；命中具体品牌时只返回该品牌，不展开品类；
- 输出：每个品类品牌一条独立结果，`matchType='category_expansion'`，`matchedText` 为品类词原文，极性默认 `positive`；
- 作用范围：仅当轮查询扩展（多品牌 enforce 召回），不写入会话主品牌、**也不解除排斥**（9.3 第 1 步——“咖啡”没有点名瑞幸，谈不上赦免“不要瑞幸”）；展开出的查询品牌列表须**先减去会话 `excludedBrands`**，被排斥品牌不得经品类词回流查询；
- 生效来源：`user_text` 与 `image_description`；`contact_name` 不做品类展开（“咖啡爱好者”不是品牌意向）；
- 该能力承接现有 `detectBrandAliasHints` 内的品类兜底（迁移映射见 5.1）。**当轮行为与线上一致**（前置高置信识别本就在 onTurnStart 运行，已上线的咖啡品类召回当轮不回归）；**跨轮行为是刻意变化**：现状品类品牌经永久并集持久化、次轮起参与工具兜底，新设计品类不入状态、次轮兜底不再携带——是否给品类偏好独立状态位，列为遗留决策点（第 16 节）。

### 6.3 意图极性

```ts
export type BrandIntentPolarity =
  | 'positive'
  | 'negative'
  | 'browse_all';
```

| 用户表达 | 极性 | 说明 |
| --- | --- | --- |
| “我想去肯德基” | `positive` | 明确正向意向 |
| “肯德基还招吗” | `positive` | 查询即意向 |
| “你刚才说的肯德基” | `positive` | 回应推荐也是兴趣信号 |
| “不要肯德基” | `negative` | 明确排斥 |
| “换个品牌” | `negative`（品牌为空） | 品牌为空的排斥指向当前主品牌（见 9.3） |
| “品牌不限” | `browse_all` | 明确取消品牌限制 |

**默认极性是 `positive`**（业务裁定）：候选人在求职对话里主动提到一个品牌，就视为兴趣信号——不感兴趣不会提。不设中性的“仅提及”档位。

防误判不靠中性档，靠三道闸门：

1. 匹配层的短别名/上下文门槛（7.3）拦截“我们全家都可以”类假命中，走不到极性判断；
2. 显式否定规则优先（6.3.1），“不要肯德基”不会落成正向；
3. 状态机是**替换式更新**而非旧的永久并集（第 9 节）：即使“我朋友在肯德基上班”被记为兴趣，候选人下一句真实意向立刻覆盖、表达排斥立刻清除——单次误判的影响从“永久”降为“一轮”。

设计取舍（刻意不做 6 值细分）：“换个品牌”语义上就是排斥当前主品牌，不值得独立的 `switch`；“还招吗”类查询在招聘场景就是意向表达，独立 `inquiry` 会迫使状态层维护“最近查询品牌 + TTL”这类补丁字段；“仅引用/提及”类按业务裁定归入 `positive`，不设 `mention`/`reference` 中性档。

`contact_name` 唯一命中品牌库时输出 `positive`——这是候选人**加好友时自己写上的**目标品牌/门店，就是他的明确品牌意向（业务裁定）。处理方式：**作为会话品牌状态的初始值（seed）**——`brand_state` 首次初始化时将其设为 `currentBrand`，首轮推荐即按该品牌启动（提示词附“宜先与候选人轻确认是否看该品牌岗位”的指引，交模型执行，不做硬机制）；此后它与对话表达的品牌完全同权：被新意向替换、被排斥、被“品牌不限”清空。**seed 仅在 `brand_state` 不存在时执行一次**，状态一旦存在（哪怕被 browse_all 清成空值）永不重新 seed——“清空后被昵称锁回”在结构上不可能发生。

`image_description` 中识别出的品牌默认输出 `positive`。如果同一轮用户文字明确表达排斥，应用层以当前用户文字的 `negative` 结果覆盖图片正向结果。

### 6.3.1 极性判定技术路线

极性判定采用**规则 + LLM 双轨**，品牌名标准化必须过品牌库：

1. **确定性规则**处理高置信模式，维护有限清单：“不要X”“除了X（都行/都可以）”“品牌不限/都行/随便”“换个品牌/换一家”，以及**指示代词排斥**“这个/那个不考虑”“不要这个”“这家算了”（输出品牌为空的 `negative`——按 9.3 执行顺序，同轮图片 positive 先立主品牌、空品牌 negative 再把它移入排斥，“发截图 + 配文这个不考虑”这一最常见组合**无需 LLM 轨**即得到正确终态）。规则命中即定极性；
2. 其余极性语义由现有 **LLM 事实提取扩展输出极性**承担（LLM 管语义、目录管实体）：LLM 输出的品牌名必须经品牌库标准化验证，未命中即整条丢弃，不允许 LLM 创造标准品牌；
3. 两轨对同一品牌冲突时，**显式否定规则优先**（把“不要肯德基”落成 positive 的代价远高于漏掉一次 positive）；
4. 双轨都未给出明确极性但品牌命中时，按业务默认输出 `positive`（提及即兴趣，见 6.3）。

LLM 轨除了覆盖规则外的表达变体（“X就算了”“X干过了不去了”），还承担一个规则轨和目录匹配**结构上做不了**的职责——**指代链接**：候选人发 M Stand 海报配文“这个不考虑”，“这个”在品牌库中无从命中，规则轨产不出 negative(M Stand)；只有能读到完整上下文的 LLM 才能把“这个”“第一个”“你说的那家”链接到图片品牌或此前推荐的品牌。6.3 中“同轮排斥文字覆盖图片正向”的执行者就是 LLM 轨（链接后的品牌名同样必须过目录验证）。

**时序与降级**（对应现有 memory 生命周期）：

- 规则轨在 **onTurnStart** 运行（前置高置信识别），产出供当轮 Prompt hints 与解析使用；
- LLM 轨在 **onTurnEnd** 收尾的 `session_turn_end_updates` 串行步骤序列内运行（`extract_facts` 步骤，带缓存/跳过/降级），其极性与指代链接产出正好赶在品牌状态写入之前——**reducer 的应用必须排在 extract_facts 步骤之后**（同一串行序列内追加一步即可）。落位注意：该序列实体在 `memory-lifecycle.service.ts`（`turn-finalizer.ts` 只是触发薄层），且 onTurnEnd 顶层还有与之**并行**的 settlement 分支（`Promise.allSettled`），追加步骤别放错分支；
- **reducer 步骤不因 extract_facts 失败而跳过**：extract_facts 抛错或降级时，reducer 仍须以规则轨结果照常运行——否则当轮确定性解析出的 positive/negative（连同首轮 seed）随异常一起丢失；
- 当轮的查询行为不依赖 LLM 轨：主 Agent 直接读候选人原文自行理解，工具入口有标准化与会话品牌兜底；LLM 轨服务的是**状态沉淀**（跨轮记忆）；
- LLM 轨被跳过或降级时只剩规则轨，按第 4 条默认 positive；排斥表达漏判暂时落成 positive 的影响由替换式状态机限制在一轮内，并靠 Phase 4 的误判回归集持续补规则。

### 6.4 结果结构

```ts
export interface BrandCandidate {
  canonicalName: string;
  brandId: number | null;
}

export interface BrandResolution {
  canonicalName: string | null;
  brandId: number | null;

  matchedText: string | null;
  source: BrandResolutionSource;
  matchType: BrandMatchType | null;
  intentPolarity: BrandIntentPolarity;

  /** 规则评分，不代表统计概率 */
  confidence: number;

  ambiguous: boolean;
  candidates?: BrandCandidate[];
}
```

约定：

- 普通文本完全未命中品牌，也未命中品牌控制意图时返回空数组；
- `browse_all` 与品牌为空的 `negative`（“换个品牌”）可以没有具体品牌，此时 `canonicalName`、`brandId`、`matchedText` 和 `matchType` 可以为空；
- 别名对应多个品牌时，`canonicalName` 和 `brandId` 为空，`ambiguous=true`，候选项放入 `candidates`；
- 一句话可以返回多个结果，例如“肯德基不要，麦当劳可以”。

### 6.5 服务接口

```ts
@Injectable()
export class BrandResolutionService {
  constructor(private readonly spongeService: SpongeService) {}

  async resolve(
    text: string,
    source: BrandResolutionSource,
  ): Promise<BrandResolution[]>;
}
```

品牌目录由服务内部经 `SpongeService.fetchBrandList()` 获取（自带缓存），符合项目 DI 惯例，调用方不必各自拉目录。核心解析逻辑实现为**纯函数导出**（`resolveBrands(text, source, catalog)`），单测直接注入目录，Service 只是薄封装。第一版保持无会话状态：目录索引可按数组引用做轻量缓存，但不得持有任何会话数据。

### 6.6 品牌链路上的 LLM 全景

品牌链路共有四个 LLM 触点，各自的居所、时机与权限边界如下。`resolution/brand` 自身零 LLM 调用，是全部触点共同的确定性裁定关口：

| 触点 | 居所 | 时机 | 允许决定 | 禁止决定 | 失效时兜底 |
| --- | --- | --- | --- | --- | --- |
| 图片转写者（二选一） | 多模态主路径=主 Agent 经 `save_image_description` 回写；兼容/降级路径=channels 独立 Vision 服务 | 主路径回合内；兼容路径消息接入时（见 10.1） | 转写图片可见内容（品牌名/品牌ID/门店，含格式契约“品牌ID：10239”） | 不认定品牌：转写文本在 `save_image_description.execute` 内同步经 `resolve()` 目录验证、挂回合上下文（10.2），状态写入仍在 turn-finalizer | 漏调回写时 turn-finalizer 触发异步 Vision 补写（10.3） |
| 事实提取 LLM | memory `extractFacts` | onTurnEnd 收尾序列（回复后、品牌状态写入前；可跳过/可降级） | 极性判断 + 指代链接（6.3.1） | 不创造品牌名：输出必须过目录验证才进 reducer | 只剩规则轨，默认 positive；reducer 步骤照常运行 |
| 主 Agent LLM | agent/generator | 回合内 | 本轮工具查询传什么品牌参数；多模态主路径下直接看图传参 | 参数不是事实：入口标准化（8.2）校验重写，永不直接写状态 | 参数为空时走会话品牌兜底（8.1） |
| 守卫 LLM（语义档） | guardrail | 出站审查时 | 回复与工具实际行为是否对账一致 | 不做品牌匹配：只读 queryMeta（第 11 节），不读模型原始参数 | 确定性硬规则仍在（brand-name-errors） |

四行共守一条原则（第 4 节非目标的落法）：**LLM 产出的是候选文本、极性或参数，品牌实体是否成立一律由 `resolution/brand` 的目录验证裁定；品牌状态的写入一律经 9.3 的 reducer。**

## 7. 解析规则

### 7.1 目录索引

基于 `BrandItem[]` 建立：

- `brandId → 品牌`；
- 标准名归一化值 → 品牌；
- 别名归一化值 → 一个或多个品牌；
- 可安全做包含匹配的长别名集合；
- 短别名和冲突别名集合。

标准名和别名统一处理大小写、全半角、空格及常见分隔符，但原始 `matchedText` 必须保留。

**归一化实现契约（v5 事故修订）**：全半角统一必须以 **NFKC 折叠**实现在白名单过滤**之前**（`normalize('NFKC') → lowerCase → 剔除非 [a-z0-9一-龥]`）。迁移自旧实现的首版遗漏了折叠步骤，全角字符（"６姐"的"６"）被白名单直接删除、别名塌缩成单字词形，酿成 2026-07-16 "姐"批量误命中生产事故（§17.2）。

### 7.2 匹配优先级

```text
品牌 ID
  > 标准品牌名精确命中
  > 唯一别名精确命中
  > 安全的长别名包含命中
```

同一文本命中标准名和其别名时只返回一个标准化品牌结果。

### 7.3 短别名和冲突别名

- 短中文别名不得做任意子串包含；
- 短英文别名必须满足 token 边界；
- 日常词别名必须具备明确品牌或求职上下文；
- 同一别名对应多个品牌时不得直接选择其中一个；
- 冲突结果不得标记为高置信；
- 微信昵称中的短别名采用更严格门槛；
- 第一版不通过模糊匹配补救未命中品牌。

目录加固三规则（v5 事故修订，实现于 catalog-index，回归集 `tests/resolution/brand/catalog-hardening.spec.ts`）：

- **非标准名别名归一化后 <2 字符整体剔除**——品牌库实存 17 个单字别名（报/捞/红/匠/…含全角塌缩产物），单字词形在中文对话里是纯噪音源；品牌标准名本身不受限（单字品牌仍可整句全等命中）；
- **纯数字别名禁无边界子串包含**（ID 型别名如"10200"嵌在手机号/时间串里必然巧合命中），带边界的短词包含要求 ≥3 位（"711"保留、"71"不再命中"玫瑰街71号"）；
- **业态泛词入 `BRAND_GENERIC_ALIAS_BLOCKLIST`**（如 7-11 的别名"便利店"），降级为仅全等匹配。

品牌库别名由运营维护、质量不可假设（全角/单字/纯数字/泛词四类脏别名实测并存）：解析层必须对脏数据免疫，而不是依赖目录治理；目录治理作为独立运营事项另行推进。

必须覆盖的误判案例：

```text
“我们全家都可以” 不能命中“全家”
“给我来一份工作” 不能命中“来伊份”
“我报过名了”不能因为短别名命中品牌
```

### 7.4 置信度

`confidence` 是可解释的规则评分，不宣称为统计概率。第一版只使用少量固定档位：

| 匹配结果 | 建议评分 |
| --- | ---: |
| 品牌 ID 命中 | 1.0 |
| 标准名唯一精确命中 | 0.95 |
| 唯一别名精确命中 | 0.90 |
| 安全长别名包含命中 | 0.75 |
| 品类展开 | 0.75 |
| 冲突或上下文不足 | 不高于 0.40 |

**工具可执行阈值**：`confidence >= 0.75` 的无歧义结果才可形成品牌过滤条件；`<= 0.40` 一律进 rejected。档位设计上不产生 (0.40, 0.75) 区间的值，阈值即二分，不存在灰区行为。

来源不做统一的简单降权。特别是 `contact_name`，经品牌库唯一验证后可以是高置信品牌线索；来源主要影响意图解释和下游优先级。

### 7.5 多来源组合

BrandResolution 不在内部做跨来源合并。调用方分别解析（注意三路不在同一时刻：文字与昵称在回合准备，图片描述在回合收尾，见 5.3 两个锚点）：

```ts
resolve(userText, 'user_text');        // onTurnStart
resolve(wechatNickname, 'contact_name'); // onTurnStart
resolve(imageDescription, 'image_description'); // onTurnEnd，描述回写后
```

三路解析产出的是带来源标签的候选品牌信号，**岗位召回始终只有一次**：工具查询的品牌条件由应用层按下述优先级合并为单一结果（品类展开时为品牌列表），不存在三路各自查询再融合。

应用层按以下优先级决策：

```text
用户本轮明确表达
  > 当前会话主品牌（首轮由昵称品牌 seed 初始化，见 6.3、9.4）
  > 无品牌限制
```

图片品牌默认是正向意向。用户配文可以补充询问语义；如果配文明示排斥，则当前用户文字的排斥意图优先。

## 8. 工具品牌控制

### 8.1 BrandFilterMode

**建模原则：模式只描述查询形态，品牌来源单独记录。** 早期草案曾设 `inherit` 模式表示“沿用会话品牌”，评审裁定废除——兜底后实际执行的就是一个 enforce 查询，“沿用”不是查询形态，而是**品牌来源**；把来源编码成模式是维度混淆。生产代码已有正确先例（`brandAliasSource: 'input' | 'contact_remark' | 'session_facts' | 'none'` 四档），本方案将其扶正为 queryMeta 的 `brandSource` 字段。

```ts
/** duliday_job_list 入参（可选）；只描述查询形态 */
export type BrandFilterMode =
  | 'enforce'
  | 'exclude'
  | 'clear'
  | 'browse_all';

/** queryMeta 记录品牌来源（生产 brandAliasSource 的扶正）。
 *  昵称品牌不再是独立来源：它经 seed 进入 currentBrand（6.3），查询侧统一表现为 session_state。 */
export type BrandSource =
  | 'model_input'     // 模型显式传入
  | 'session_state'   // 会话品牌兜底：currentBrand（含昵称 seed 而来的首轮值）
  | 'none';           // 无品牌条件
```

| 模式 | 行为 |
| --- | --- |
| `enforce` | 仅查询指定品牌（列表非空时的默认语义，通常无需显式传） |
| `exclude` | 排除指定品牌 |
| `clear` | 模型有意放宽品牌条件（0 结果重查、探索别家）：不带品牌查询；不修改会话状态，不等于用户明确不限品牌 |
| `browse_all` | 用户明确不限品牌，查询所有品牌 |

**会话品牌兜底**（原 inherit 概念的归宿）：品牌列表为空且 mode 未传时，工具取 `currentBrand`（**仅此一档**——昵称品牌已在首轮经 seed 进入 currentBrand，见 6.3/9.4，无需独立档位；current 与 excluded 互斥由 reducer 不变量保证），命中即按 `enforce` 执行、`brandSource='session_state'`；为空则无品牌查询（`brandSource='none'`）。“browse_all 清空后被昵称锁回”在 seed 设计下结构上不可能：`brand_state` 一旦存在即不再 seed。

意图完整性的三个保障——兜底不是“系统篡改意图”：

1. **契约可见**：兜底语义写在工具 description 里（“省略品牌与 mode 时沿用会话品牌”），模型读得到。现状生产实现的真正问题是**未声明的静默注入**（模型不知道空 `brandAliasList` 会被备注品牌改写）——那才是篡改，本方案修的就是它；
2. **可覆盖**：模型的每种意图都有显式表达路径——想无品牌查询传 `clear`/`browse_all`，显式声明永远优先于兜底。否则会出现“策略要放宽、兜底强行拉回、永远查同一品牌永远 0 结果”的死循环；
3. **可追溯 + 知情**：`brandSource` 非 `model_input` 时，工具结果中向模型披露所用品牌与 `clear` 出口；审计按 `brandSource` 直接区分“模型要的”与“兜底给的”。

组合规则（入口执行）：

| 组合 | 生效查询 | brandSource |
| --- | --- | --- |
| 品牌列表非空（mode 未传或 `enforce`/`exclude`） | 按指定品牌查/排除；**天然向后兼容**存量调用（只传列表、不认识新字段） | `model_input` |
| 列表空 + mode 未传 | 会话品牌兜底：`currentBrand` 命中按 enforce 执行并披露；为空则无品牌查询 | `session_state` / `none` |
| 列表空 + `clear` / `browse_all` | 无品牌查询（二者语义与审计归因不同） | `none` |
| 列表空 + `enforce`/`exclude` | 矛盾组合，工具报错引导补品牌或改 mode | — |

- **兜底边界原则：只补“模型看不到的跨轮遗忘”，不干预“模型刚看过的本轮判断”**。仅 `currentBrand` 一档（badcase recvjFFKcZPsiC 实证；昵称品牌实证由 seed 承接——它已是 currentBrand 的一种来源）；本轮文字/图片是模型眼前的上下文，没传更可能是策略而非遗忘，不注入（图片品牌自下一轮起经 `currentBrand` 参与兜底）；
- 工具 description 须明确教模型两件事：兜底语义（省略品牌与 mode 即沿用会话品牌），以及“召回为空放宽重查时传 `filterMode='clear'`，不要只省略品牌参数”。

**`excludedBrands` 的查询侧地位（显式决策）**：兜底只读 `currentBrand`，被排斥品牌不会经兜底回流（current 与 excluded 互斥）；但无品牌查询（`session_state` 兜底落空或 `clear`/`browse_all`）的结果中仍可能出现被排斥品牌，是否避开推荐交由模型判断（提示词注入排斥语义，Phase 4.4 后生效）——当前设计为**提示词软约束**。查询侧是否追加确定性后过滤（`brandSource ∈ {session_state, none}` 时对结果减 `excludedBrands` 并在结果中披露；排斥同样是“跨轮遗忘”，在兜底边界原则之内）列为遗留决策点（第 16 节）。Phase 2 至 Phase 4.4 之间排斥状态只记录、无消费方——相对现状（完全不记排斥）无回归，此空窗可接受。

`clear` 与 `browse_all` 必须保持区别：前者是模型的单次查询策略（不动状态），后者是候选人的明确表达（reducer 清空状态）。

**`exclude` 的执行面限制**：Duliday 岗位接口没有品牌排除参数，第一版 `exclude` 只能在召回结果内做本地后过滤。受分页扫描上限影响（距离召回最多 200 条的已知问题），排除后可能出现“被排除品牌占满前几页、目标岗位被截断”的召回空洞——这是已知局限，不在第一版解决，但必须在 queryMeta 中如实记录 `filterMode='exclude'` 和实际过滤行为供审计。实际场景中 `excludedBrands` 主要与无品牌限制查询组合，有 `currentBrand` enforce 时基本不参与。

### 8.2 工具入口标准化

所有 `brandAliasList` 在工具入口统一通过品牌目录标准化：

1. 校验已有 `brandIdList`；
2. 将 `brandAliasList` 解析成唯一标准品牌；
3. 可以取得品牌 ID 时优先生成 `brandIdList`；
4. 没有 ID 时才保留标准品牌名；
5. 冲突、低置信或未命中项进入 rejected，不形成强制品牌过滤；
6. 保留模型原始参数用于审计，但不将其视为权威事实。

工具参数标准化是 BrandResolution 的消费方，不需要把 `tool_argument` 加入 `BrandResolutionSource`。工具可以复用服务内部公开的目录名称解析能力，或在后续确有复用需要时增加独立的 `resolveAliases` 方法。

### 8.3 与既有同音回指链路的关系

`brandAliasList` 硬过滤 0 结果时的拼音同音回指（对会话最近推荐品牌池做 pinyin 匹配，产出 `aliasFuzzyMatch`，badcase“刘姐妹”→“成都你六姐”）**广义上也是品牌归一化**，因此代码归入 `resolution/brand/fuzzy-recall.ts`（5.1）。但它是与 `resolve()` 并列的独立管线，不并入解析，三个实质差异：

1. **候选集**：`resolve()` 对整个品牌库匹配；回指只对本会话最近推荐过的少数品牌比对——它本质是回指消解（“你说的那个”指什么），依赖会话上下文，而 `resolve()` 刻意无状态；
2. **置信契约**：`resolve()` 产出可直接执行的品牌事实（≥0.75 放行）；回指产出的是**必须经候选人确认的猜测**——Agent 反问确认后，候选人的答复走正常 `resolve()` 链路成为 positive 事实，猜测本身永不直接成为事实；
3. **触发条件**：由“查询命中 0 结果”事件触发；若并入 `resolve()` 每条消息都跑，会在普通文本上持续产出低置信噪音，破坏“解析结果必须能溯源到品牌库”的确定性。

一句话：同一个品牌域（同居所、同审计出口），两条管线（确定性解析 vs 需确认的失败补救）。

衔接点在 queryMeta：回指建议纳入 `fuzzySuggestions` 字段（见第 11 节），出站守卫规则 `brand_alias_fuzzy_match_ignored` 切换数据源后改由 queryMeta 读取，否则守卫切换时这条规则会断数据源。

## 9. 会话品牌状态

将现有品牌数组永久并集改为：

```ts
export interface SessionBrandRef {
  canonicalName: string;
  brandId: number | null;
}

export interface SessionBrandState {
  currentBrand: SessionBrandRef | null;
  excludedBrands: SessionBrandRef[];
}
```

不设 `historicalBrands`（评审裁定）：被替换的品牌即遗忘——查询不过滤、提示词不注入，唯一设想用途是审计回放，而 `brand_state_change` 观测事件已完整记录每次状态迁移的前后快照，历史可从事件流回放，不需要状态里再存一份。模型若需要“他之前提过什么”，对话历史本身就在上下文里。

### 9.1 存储与并发

`SessionBrandState` 整体 JSON 序列化后存入现有会话状态 hash（`factsv2:{corpId}:{userId}:{sessionId}`）的**单一新字段** `brand_state`——不是独立 Redis key。复用 factsv2 的字段级写入（`patchSessionState` → `patchHash` 逐字段 HSET + 续 TTL）与 90s 租约锁（PR #455 体系）；读取搭 `getSessionState` 的 HGETALL 便车，不增加 Redis 往返；TTL 随 hash 整体的 `sessionTtl`。注意 `brand_state` 需注册进 `SessionFactsRedisContentSchema`（hash 读出后有 zod 校验，未注册字段会被丢弃）。

- 状态迁移（如“换个品牌”的“移入排斥 + 清空当前”）在回合处理持锁期间读改写完成，单字段原子替换，不产生复合更新中间态；
- **禁止**把 current/excluded 拆成多个 hash 字段——字段级合并会让事务性迁移出现半更新状态，这正是 debounce 并发下修过的 P0 坑型。

memory 侧的调用形状（`memory-lifecycle` 的 `session_turn_end_updates` 串行分支内、排在 extract_facts 之后追加一步且不因其失败跳过，全程在已持有的租约锁内——该锁是渠道层 simple-merge 的 90s 处理锁 + 心跳续期）：

```ts
const prev = JSON.parse(await hget(factsKey, 'brand_state'))
             ?? initBrandState();          // 首次初始化：旧数组末位 > 昵称品牌 seed > 空（9.4）
const next = reduceBrandState(prev, thisTurnResolutions);      // 纯函数，规则全在 reducer 内
await hset(factsKey, 'brand_state', JSON.stringify(next));     // 单字段原子替换
if (changed) emit('brand_state_change', { prev, next });       // 第 12 节观测
```

memory 侧不含任何迁移规则，只做“读-算-写”；`SessionBrandState` 的下游读方共四个且全部只读——下一轮的 Prompt Section、工具会话品牌兜底、`preferences.brands` 投影（过渡期）、观测事件。

### 9.2 单一写入方

现状 `preferences.brands` 有两个来源、**三处落笔**：LLM 事实提取抽出的品牌（extraction prompt 输出）；规则匹配经 `mergeDetectedBrands` 并入（`session.service` 的 extractFacts 内）；规则事实提取**内联直写**（`extractHighConfidenceFacts` 内 `facts.preferences.brands = ruleValue(...)`，经 `mergeRuleAndLlmFacts` 汇入）。品牌真相迁到 `SessionBrandState` 后，若任一旧路径继续写数组、其余走新状态，系统会同时存在两份内容不一致的品牌数据（Prompt 读旧、工具读新），必须杜绝——Phase 2.3 收口时**三处逐一点名**，漏一处即留下活写入方。

规则：**写品牌状态的路径全系统只有一条**。LLM 事实提取抽出的品牌不再直接落任何字段，先经品牌库验证（对不上库即丢弃）+ 极性判定，转换为标准 BrandResolution 结果，与用户文字/昵称/图片的解析结果一样走 9.3 的 reducer 进入 `SessionBrandState`。

`preferences.brands` 保留但改变性质：不再是独立存储，而是**由新状态现算的只读投影**（派生口径 = `currentBrand` 单元素数组，空状态为空数组），仅供 turn-hints / hard-constraints 等尚未迁移的 Prompt Section 过渡期读取；禁止任何路径直接写入。Section 迁移与投影删除已排期在 Phase 4.4，属于本次改造的收尾必做项，不留长期过渡层。

### 9.3 更新规则（reducer 算法）

reducer 拿到「上一轮状态 + 本轮全部解析结果」，按固定四步算出新状态。规则全部实现在 `brand-state.reducer.ts` 纯函数中（见 5.2），memory 侧不含任何迁移逻辑。

**第 0 步 · 过滤输入**：剔除 `contact_name` 来源的结果——昵称品牌不参与常规轮次的状态更新（否则这个每轮都在的静态值会不断把自己写回 currentBrand，覆盖对话演进）。它进入状态的唯一通道是**首次初始化 seed**（9.4）：`brand_state` 不存在时设为 currentBrand 的初始值，一次性、此后与普通品牌同权。

**第 1 步 · 应用全部 `positive`**（按来源排序：图片先、文字后）：

- 单品牌表达 → 替换 `currentBrand`，被替换的旧值直接丢弃（历史可从 `brand_state_change` 事件回放）；**同时将该品牌从 `excludedBrands` 移除**——候选人反悔（此前排斥过、如今又想去）即赦免，跨轮的新表达覆盖旧排斥。这与同轮排斥优先不矛盾：同轮内正负并存时先后顺序不可信（消息可能被 debounce 拆合），保守判排斥；跨轮 positive 是时序明确的新事件，按“最新表达为准”处理；
- 多品牌表达（“肯德基和麦当劳都可以”）或品类展开 → 拆两半处理：**不立主品牌**（候选人没说更想去哪个，系统不替他挑，`currentBrand` 不动，当轮按多品牌查询——注意多品牌查询由主 Agent 看原文传参执行，不经过状态机：reducer 跑在 turn-finalizer，此时本轮查询早已发生，见 5.3 贯穿性规则 3）；**显式命中的解除排斥照常**（若肯德基此前在 `excludedBrands`，现在他点名说“都可以”，黑名单必须移除——否则下轮兜底跳过肯德基、排除过滤筛掉肯德基岗位，系统行为与他刚说的话矛盾）。原则：**显式**正向表达（`matchType ≠ category_expansion`，即候选人点名或图片可见的品牌）一律解除该品牌的排斥，无论是否成为主品牌；**品类展开产出的 positive 不解除排斥**——“咖啡”没有点名瑞幸，谈不上赦免“不要瑞幸”（6.2 同步规定品类查询列表须减去 excludedBrands）。

单/多品牌表达的判别规则（reducer 的实现判据）：**同一来源的 positive 结果 ≥2 条，或任一结果 `matchType='category_expansion'`，即为多品牌表达**；同来源恰 1 条 positive 即为单品牌表达（“肯德基不要，麦当劳可以”的 user_text 正向只有麦当劳 1 条，正常替换）。跨来源不算多品牌——图片 positive(A) + 文字 positive(B) 按“图片先、文字后”逐来源各自应用替换，文字赢。实现上两个操作解耦：解除排斥对每个**显式命中**的 positive 品牌执行（`category_expansion` 除外，见上），立主品牌仅单品牌表达时执行。边界行为：debounce 把“肯德基呢”“麦当劳也看看”两条消息合并成一轮时，合并文本解析出 2 条 positive，按此规则不立主品牌——这是刻意的保守选择，与本节“同轮内先后顺序不可信”的论证一致。

**第 2 步 · 应用全部 `negative`**：

- 有品牌 → 加入 `excludedBrands`；若恰是 `currentBrand` 则同时清空它；
- 品牌为空（“换个品牌”）→ 把 `currentBrand` 移入 `excludedBrands` 并清空；没有 `currentBrand` 就什么都不做。

**第 3 步 · 应用 `browse_all`**：清空 `currentBrand` 和 `excludedBrands`。

这个执行顺序**自动保证**三条性质，无需额外规则：

1. 结果与说话顺序无关——“肯德基不要，麦当劳可以”和倒过来说，都得到 current=麦当劳、excluded=[肯德基]（negative 永远最后应用）；
2. 同一品牌同轮又要又不要时，排斥赢（同上）；
3. 图文并发时文字赢——发 M Stand 截图 + 配文“有没有瑞幸”，current=瑞幸（文字后应用，覆盖图片）。

状态的两个读取方（均为只读，规则在各自章节）：提示词注入 `currentBrand` + `excludedBrands`（Phase 4.4 迁移后的终态口径；迁移前旧投影只有扁平数组，排斥语义缺失）；工具会话品牌兜底读 `currentBrand`（8.1；current 与 excluded 互斥由上述迁移规则保证——排斥即清空，兜底不可能拉回刚排斥的品牌，查询侧无需再过滤）。

### 9.4 兼容迁移

**存量数据面只有 Redis facts hash**（品牌状态无 DB 表，本次改造零数据库迁移）。处理方式为**懒迁移**，不做批量刷数：

- **初始化时机**：`brand_state` 不存在时执行一次（`initBrandState`）。注意 seed 状态需在**首轮回合准备阶段**即构造并生效（注入提示词、供工具兜底——业务要求首轮推荐就按昵称品牌启动），持久化仍随收尾 reducer 统一落盘（prevState = seed 状态），不破坏“写入只在收尾”的单一出口；不再来消息的会话永不初始化，也无需初始化；
- **初始化优先级**：旧 `preferences.brands` 末位品牌 > 已验证昵称品牌 seed > 空状态。旧数组末位是对话表达（时点晚于加好友的昵称），优先；两者皆无则空。旧数组其余品牌直接丢弃（无极性无时序，不值得继承）。依据：旧数组按 append 顺序构建（`mergeDetectedBrands` 为 `[...existing, ...detected]`），末位 ≈ 最近表达的品牌（已知误差：并集去重保首现，复提旧品牌不会把它挪到末位——`[肯德基, 麦当劳]` 后再提肯德基，末位仍是麦当劳；接受该误差，即使继承偏了，替换式状态机一轮内即被真实表达纠正）；若一个都不继承，存量候选人在模型忘传品牌的轮次会失去会话品牌兜底，badcase recvjFFKcZPsiC（想找大米先生被跨品牌推荐）将在存量会话整体复发；继承的品牌即使恰为过期/误判，替换式状态机也保证一轮内被真实表达纠正；
- 迁移期间保留 `preferences.brands` 兼容读取（9.2 投影）；禁止继续用旧数组反向驱动永久并集；旧字段残值留在 Redis 无害，Phase 4.4 删投影时停写并清理。

## 10. 图片品牌处理

### 10.1 图片描述的两条产出路径（现状事实）

图片的文本描述有两个可能的产出者，取决于主聊天模型是否支持 vision（`accept-inbound-message` 按 `supportsVisionInput` 分流）：

| 路径 | 条件 | 描述产出者 | 产出时机 |
| --- | --- | --- | --- |
| **多模态主路径**（生产常态） | 主模型支持 vision | 主 Agent 回合内调 `save_image_description` 工具回写 DB | **回合内**（Agent 决策阶段） |
| 文本兼容路径 | 主模型不支持 vision | 独立 Vision 服务预转写（awaitVision 等待完成再进 Agent） | 回合前 |
| 运行时降级 | 多模态调用失败 | 独立 Vision 服务转写后文本重跑 | 回合内重试时 |

关键推论：**多模态主路径下，回合准备时刻图片描述尚不存在**，`resolve(描述, 'image_description')` 无法在准备阶段执行。两个产出者共享同一格式契约（招聘截图标题中 `[10239]` → 输出“品牌ID：10239”行，两侧 prompt 均已约定）；无论谁产出，来源统一为 `image_description`。

### 10.2 解析执行点与状态写入点分离

图片品牌的**解析执行点在 `save_image_description.execute` 内**，**状态写入点在 turn-finalizer**：

- 主路径下，模型回合内调 `save_image_description` 落描述时，execute（确定性代码）立即同步执行 `resolve(description, 'image_description')`，解析结果挂到**回合上下文**——当轮即有确定性的图片品牌事实，用途限于两处**不干预模型行为**的消费方：
  - 出站守卫跑在全部工具调用之后，可拿该结果对账“回复是否偏离了候选人发来的图片品牌”；
  - turn-finalizer 复用它写状态（下方第三条）。
  - 注意它**不进当轮查询兜底**：模型刚看过图，没按图片品牌查更可能是策略而非遗忘，注入即篡改工具调用意图（8.1 兜底边界原则）；图片品牌自下一轮起经 `currentBrand` 参与兜底；
- 兼容路径下描述回合前已就绪，准备阶段即解析，同样挂回合上下文；
- **状态写入仍只在 turn-finalizer**：reducer 复用回合上下文里的解析结果（不重复解析），与 extractFacts 的极性/指代链接结果（“这个不考虑”→ negative）汇合后批量应用，“先 positive 后 negative”语义处理同轮覆盖；
- 模型既没传品牌也没调描述工具时，当轮无确定性锚点（提示词驱动的固有残余），由 10.3 异步补写保住下一轮状态，并靠观测盯漏调率。

### 10.3 描述缺失兜底

主路径的描述回写靠工具提示词驱动（“你必须调用”），模型可能忘调——该图品牌将永远进不了状态。兜底：turn-finalizer 检测本轮图片消息缺描述时，触发一次异步 Vision 补写（复用 `ImageDescriptionService`），补写完成后走同一条 `resolve` → reducer 链路落状态。

补写落状态是**处理锁外的异步晚到写**，必须带两道防护，否则会出现“旧图片信号覆盖新表达”的时间倒流（turn N 发 M Stand 截图但模型漏调描述；turn N+1 候选人说“M Stand 不要”进 excludedBrands；补写此后才完成，若径直进 reducer，positive(M Stand) 会解除排斥并立回主品牌）：

1. **重新持锁**：补写落状态前必须重新获取该会话的处理锁（复用渠道层 90s 租约锁语义，被占则等待重试），维持 9.1 “状态迁移在持锁期间完成”的单一门约束；
2. **过期即弃**：图片解析结果携带产生轮次（turn 序号 / 消息时间戳），reducer 拒绝应用早于 `brand_state` 最后变更轮次的补写结果——晚到旧信号只弃不写，宁可丢一次图片品牌，不做时间倒流。

“图片无描述”漏调率与“补写过期丢弃”均落观测计数（落点见第 12 节），持续监控。

### 10.4 实现约束

- **图片消息的识别必须结构化——注意这是新增工作，非既有能力**：现状存储只有企微原始 `messageType` 数字编码，“图片描述 vs 用户文字”的区分靠 `[图片消息]`/`[表情消息]` 内容前缀（独立 Vision 服务与 `save_image_description` 两处产出）。新链路判定“本轮是否有图片消息 / 是否缺描述”必须以结构化 `messageType` 为准，前缀仅作为描述文本的渲染约定沿用、不得作为判定依据；该实现项排入 Phase 2.1，无数据库变更；
- **格式契约双侧同步**：“品牌ID：10239”行的约定同时存在于独立 Vision 服务的 prompt 与 `save_image_description` 工具的 description，修改必须两处同步，BrandResolution 按此格式提取 `brand_id`；
- 品牌 ID 在图片标题中出现时优先使用 ID；图片品牌默认 positive、可持久化为正向意向，同轮用户文字明确排斥时以用户文字优先（6.3、9.3）。

### 10.5 完整示例：候选人发岗位截图（多模态主路径）

候选人（昵称“小王”）发 Boss 直聘 M Stand 截图，配文“这个还有吗”：

1. **接入**：图片消息回调 → 过滤 → 存历史（带消息类型标识）→ 立即 200。主模型支持 vision，**不做预转写**；
2. **Debounce**：图片与配文合并为同一轮；
3. **回合准备**：`resolve("这个还有吗", 'user_text')` → 无品牌字面、空结果；`resolve("小王", 'contact_name')` → 库无命中、不产生品牌（首轮 `brand_state` seed 为空状态，9.4）。此刻图片描述尚不存在，图片品牌**不在**本阶段解析；
4. **主 Agent 决策**（看得见原图）：调 `save_image_description` 回写描述（含“品牌ID：10239”行）——**execute 内同步 `resolve(描述)`，图片品牌 M Stand（brand_id 命中，1.0）挂回合上下文**；再调 `duliday_job_list`，理想传 `brandIdList=[10239]`；
5. **工具入口标准化**：`filterMode=enforce`，校验 ID；模型忘传品牌时 会话品牌兜底只看跨轮记忆（首轮 `currentBrand` 为空——昵称未命中、seed 为空，兜底无品牌查询；模型看图传参是主路径，兜底不注入本轮信号）；模型有意放宽则传 `clear`；乱传未验证品牌进 rejected。产出 queryMeta（applied=[10239]）；
6. **查询执行**：正常返回岗位；
7. **出站守卫**：对账 queryMeta——推荐了 applied 之外的品牌 → REPLAN；查到了却称“没找到” → 拦截；
8. **turn-finalizer（统一副作用出口）**：复用回合上下文中的图片品牌解析结果（第 4 步产出，不重复解析），与本轮其它来源结果一起进 reducer → `currentBrand = M Stand`。对照场景：配文为“这个不考虑”时，extractFacts 指代链接产出 negative(M Stand)，reducer 批量语义下 negative 优先，M Stand 进 excludedBrands。若模型漏调描述工具，触发 10.3 的异步补写兜底（只救下一轮状态）；
9. **投递 + 观测**：拟人化发送；本轮状态有变化，落一条 `brand_state_change` 事件（queryMeta 已随流水落库，无需重复）。下一轮候选人说“帮我约”，会话品牌兜底从 `currentBrand` 拉回 M Stand。

## 11. 出站守卫

**queryMeta 不是新增的运行时层**：工具返回值里现已存在 `result.queryMeta`（生产在跑，装着 storeMatchStrategy、distanceScanTruncated、scheduleFilter 等查询侧溯源），品牌散字段 `brandIdList` / `brandAliasList` / `brandAliasSource` / `rejectedNicknameBrandAliases` 也已在其中。本节的实际工作只是把品牌散字段收拢为其中的 `brand` 小节并类型化、补齐 rejected 原因，让守卫改读它。工具返回值整体就是喂回模型的 tool output（AI SDK 机制），因此模型天然可见 queryMeta——兜底披露即通过它送达。模型的原始请求参数不重复存——调用流水（`message_processing_records`）里本来就有。

```ts
export interface NormalizedBrandQueryMeta {
  /** 生效查询形态（enforce/exclude/clear/browse_all） */
  filterMode: BrandFilterMode;
  /** 品牌来源：模型显式传入 / 会话品牌兜底（含昵称 seed 而来的首轮值）/ 无品牌（审计区分“模型要的”与“兜底给的”） */
  brandSource: BrandSource;
  appliedBrandIds: number[];
  appliedCanonicalNames: string[];
  rejected: Array<{
    input: string;
    reason: 'unmatched' | 'ambiguous' | 'low_confidence';
    candidates?: BrandCandidate[];
  }>;
  /** 0 结果同音回指建议（既有 aliasFuzzyMatch 链路产出），见 8.3 */
  fuzzySuggestions?: Array<{
    brandName: string;
    inputAlias: string;
    score: number;
  }>;
}
```

出站守卫必须读取 `toolResult.queryMeta.brand`，不再直接读取模型原始 `brandAliasList`。

守卫侧共**三个**数据源切换点（同批切换，缺一即违背 6.6 “守卫只读 queryMeta”的承诺）：

- `requested_brand_mismatch`：由读 `args.brandAliasList` 改读 `appliedCanonicalNames` / `appliedBrandIds`（对账对象从“模型请求的”修正为“工具实际应用的”，本来就该如此）；
- `brand_alias_fuzzy_match_ignored`：由读 `toolResult.details.aliasFuzzyMatch` 改读 `queryMeta.brand.fuzzySuggestions`；
- **语义档 review packet**：`review-packet.builder` 现直读模型原始 `call.args.brandAliasList` 构造 `requestedBrands` 喂给守卫 LLM——同批改读 `queryMeta.brand`（applied + rejected）。前两条是硬规则，这条在语义档取数层，最容易被遗漏。

需要校验（**不新增守卫规则**——守卫硬规则刚经历大规模下线，勿重加是既定裁定；以下校验点全部由现存两条规则换数据源承接，或由语义档自然覆盖）：

- 回复声称查询了某品牌，但工具实际没有应用该品牌（`requested_brand_mismatch` 改读 applied 后天然覆盖）；
- 用户要求指定品牌，工具结果却返回其它品牌且回复未说明（同上）；
- 高置信唯一别名已标准化，但回复忽略标准品牌结果（`brand_alias_fuzzy_match_ignored` 改读 fuzzySuggestions 后覆盖）；
- 被拒绝的昵称或模型别名不得成为品牌不匹配守卫的权威依据（改读 queryMeta 后自动成立——rejected 不在 applied 里）。

## 12. 可观测性

观测必须**落库**而不只打日志（项目既定原则：shadow 判例/守卫命中/降级必须可查询）。复用现有 observability 体系（AgentTracer → CompositeObserver → PersistingObserver），落 `agent_execution_events`，与 `message_processing_records` 同 `trace_id` 可 join。

**长期事件只新增一个：`brand_state_change`**——会话品牌状态迁移的前后快照 + 触发它的解析结果（含来源/匹配方式/极性）。仅在状态实际变化时写入，多数轮次零行。它是品牌链路上唯一**不可重放**的信息（状态迁移依赖前态），并承担 `historicalBrands` 删除后的历史回放职责。落库实现注意：`PersistingObserver` 有持久化白名单（`ALWAYS_PERSISTED_EVENT_TYPES`，非白名单且非 tool_call 的事件直接丢弃）——新事件除加入 `AgentEvent` union 外**必须同时注册白名单**，否则事件发了不落库，正好踩“观测不能只打日志”的红线。异步补写（10.3）晚到落状态时同样发本事件。

另设一个**临时事件：`brand_resolution_shadow_diff`**（新旧并行对比期专用，随旧路径下线一并删除，见 15.6）：新旧路径对同一输入的命中结果不一致时落一条（原文 + 两侧结果 + 目录版本），一致时仅计数不落行。它不违背“只存不可再得”纪律——**品牌目录随时间变化，事后离线重放无法复现当时的目录状态**，差异现场必须在线记录；15.6 的差异率门禁与逐条归因都以此事件为数据源。

刻意不落的两类（遵循事件表“只存不可再得的结构化事实、不当日志表”的既有纪律）：

- 解析结果不单独落事件：`resolve()` 是纯函数，误判归因时拿候选人原文 + 品牌目录**离线重放**即可精确复现，可重放的信息不在线记录（shadow diff 是唯一例外，理由如上：目录时变）；
- queryMeta 不单独落事件：它是工具结果的一部分，已随 `agent_invocation` 落在 `message_processing_records` 流水中，同 trace 可查，重复落库即浪费（现有 `tool_call` 事件也是同一纪律——仅副作用/出错/慢调用才入事件表）。

轻量计数类观测（10.3 的“图片无描述”漏调率、“补写过期丢弃”数）不新增事件类型。~~走日志聚合或现有 step 统计~~（**v5 修订**：本环境无日志聚合渠道，"走日志聚合"假设不成立，违背"观测不能只打日志"既定原则——已改为：补写"过期丢弃"与"锁竞争放弃"两类设计上罕见的异常升级为**飞书告警**；补写成功侧由 `brand_state_change(late=true)` 事件覆盖；漏调净残留用数据侧兜底查询（`chat_messages` 中裸 `[图片消息]` 占位计数）。Logger 仅作辅助排障。日志与事件都不得把“模型传入的别名”与“工具实际应用的品牌”混为同一字段。

## 13. 实施顺序

### Phase 1：解析层

1. 创建 `src/resolution/brand`，同步更新 CLAUDE.md 架构图与分层约束（`resolution/` 只依赖 `sponge/`，可被 memory/agent/tools/guardrail 依赖，禁止反向）；
2. 按 5.2 文件布局实现统一类型和无状态解析服务（types / service 门面 / catalog-index / brand-matcher / polarity-rules / category-expansion 各就各位，不先塞单文件后拆）；
3. 接入品牌目录标准名、别名、ID 索引，**含品类展开**（`category_expansion`）；
4. 实现意图极性：确定性规则轨先行，LLM 事实提取扩展极性输出在 Phase 2 接入；
5. 完成短别名、冲突别名、品类词和昵称回归测试；
6. 让现有 `detectBrandAliasHints` 通过适配方式消费新解析结果，暂时保持旧接口兼容——适配层必须保持品类兜底行为不回归（已上线的咖啡品类召回）。

### Phase 2：会话和准备阶段

1. 用户文字、微信昵称在回合准备阶段调用 BrandResolution；图片描述的解析与状态更新挂 turn-finalizer（多模态主路径下描述是回合内工具产物，准备阶段不存在，见 10.2），并实现描述缺失的异步 Vision 补写兜底（10.3：重新持锁 + 过期即弃两道防护）；图片消息判定改用结构化 `messageType`、不得靠内容前缀（10.4，新增工作）；
2. 引入新的会话品牌状态：迁移规则实现为 `brand-state.reducer.ts` 纯 reducer（见 5.2），memory 侧持锁读 facts hash 单字段 `brand_state` → 调 reducer → 写回（见 9.1）；reducer 步骤不因 extract_facts 失败而跳过（6.3.1）；
3. 停止 `preferences.brands` 永久并集——**三处写入点逐一收口**（LLM 提取输出、`mergeDetectedBrands` 并入、`extractHighConfidenceFacts` 内联直写，见 9.2），LLM 事实提取的品牌输出经状态机统一写入，旧字段改为只读投影；
4. **过渡期护栏（与本阶段同版上线）**：工具内旧 contact_remark 兜底档按 `brand_state` 存在性门控——状态已存在（seed 已发生）即禁用旧昵称兜底，避免旧兜底无视新状态把昵称品牌注回查询（否则“换个品牌 / browse_all 之后被昵称锁回”在 Phase 2→3 空窗期整段复活）；等价做法是把 Phase 3.5 提前到本阶段执行；
5. 保持旧会话数据兼容读取，首次初始化按“旧并集末位 > 已验证昵称品牌 seed > 空”一次性写入 `currentBrand`（见 9.4）。

（原 v3 的 2.4“修正 contact_remark 命名”撤销独立工作项：该命名全库仅剩工具来源枚举一处字面量，随 Phase 3.4 档位废除自然消失，见 2.1。）

### Phase 3：工具入口

1. 引入 `brandFilterMode`；
2. 标准化所有 `brandAliasList`；
3. 优先转成 `brandIdList`；
4. 记录 applied/rejected 品牌元数据；现有工具 details 里的 `brandAliasSource` 局部变量被 `queryMeta.brandSource` 吸收替代（`input→model_input`；`contact_remark` 档**废除**——昵称品牌经 seed 进入 `currentBrand`，查询侧统一表现为 `session_state`，该错误命名随档位一并消失（见 2.1）；`session_facts→session_state`，读取点同步从旧并集数组换成 `SessionBrandState.currentBrand`）——注意不是纯改名：现状兜底无条件触发，新设计受 mode 门控（`clear`/`browse_all` 旁路）；
5. 删除工具内的昵称品牌兜底逻辑分叉（含未经品牌库验证的部分）——昵称品牌统一在首轮准备阶段经 BrandResolution 验证后 seed 进状态，工具侧不再存在昵称档（若 Phase 2.4 已按门控/提前方案处理，此处为收尾删除）；
6. 将 `brand-fuzzy-match.util` 原样迁入 `resolution/brand/fuzzy-recall.ts`，工具改从新路径 import，回指建议写入 queryMeta 的 `fuzzySuggestions`（行为不变，只换居所 + 接线）；
7. `sanitize-brand-name.util` 原样迁入 `resolution/brand/sanitize-brand-name.ts`；
8. 入口标准化落地后，`filterJobsToRequestedBrands` 的本地过滤从私有包含匹配退化为品牌 ID/标准名**等值比较**，废弃 `normalizeKeyword` + 单向 includes 策略。

### Phase 4：守卫和观测

1. 出站守卫改读标准化查询元数据——**三个切换点同批**：两条硬规则 + 语义档 review packet 的 `requestedBrands` 取数（见第 11 节切换映射）；守卫私有的 `normalizeClaimedBrand` 改 import `brand-normalize.ts`；
2. `brand_state_change` 事件落 `agent_execution_events`（长期唯一新增事件，**须同步注册 PersistingObserver 持久化白名单**；另有并行对比期临时事件 `brand_resolution_shadow_diff`，随旧路径下线删除，见第 12 节）；
3. 建立线上误判和漏判回归集；
4. **Prompt Section 迁移**：turn-hints / hard-constraints 等改读 `SessionBrandState`。唯一前置依赖是 Phase 2（状态已在写，投影与状态本就是同一份数据），**不受 15.6 观测门控，随主线执行**。注意这不是机械替换：提示词展示口径从“品牌数组”变为“当前主品牌 + 排斥品牌”（排斥语义首次可显式注入提示词），需过测试集验证提示词效果。迁移前需清点投影的全部读方（含 Dashboard/test-suite 等 Prompt 之外的消费方），全部迁完即删除 `preferences.brands` 投影，9.2 的过渡期到此结束；
5. 全库 grep 审计品牌归一化/匹配私有实现残留（见 5.1 终态硬规则 3），旧散点全部删除或改为 re-export；
6. 观察稳定后再决定是否引入受控模糊匹配。

## 14. 测试计划

### 14.1 BrandResolution 单元测试

- 标准品牌名正向识别；
- 唯一别名识别，例如 `KFC → 肯德基`；
- 品牌 ID 识别；
- “想去KFC看看”；
- “不要肯德基”；
- “除了肯德基都可以”；
- “肯德基和麦当劳都可以”；
- “肯德基不要，麦当劳可以”；
- “品牌不限”输出 `browse_all`；
- “换个品牌”输出品牌为空的 `negative`；
- “肯德基还招吗”输出 `positive`；
- “你刚才说的肯德基”输出 `positive`；
- “我朋友在肯德基上班”按业务默认输出 `positive`；
- `Gattouzo` 微信昵称不产生品牌；
- `肯德基-上海` 微信昵称产生高置信品牌；
- `KFC松江` 微信昵称归一化为肯德基；
- “我们全家都可以”不误判；
- “给我来一份工作”不误判；
- 冲突别名返回 ambiguity；
- 图片品牌默认 positive；
- 图片中的品牌 ID 优先解析（“品牌ID：10239”格式契约）；
- “咖啡”品类词展开为品类品牌、matchType 为 `category_expansion`；
- 品类词与具体品牌同现时只返回具体品牌，不展开品类；
- “这个不考虑”“不要这个”输出品牌为空的 `negative`（指示代词排斥规则轨，6.3.1）；
- （v5 增补，目录加固回归）全角别名折叠（“６姐”→“6姐”、“７-１１”→“711”）；“姐，…”称呼语不命中任何品牌；门牌号“玫瑰街71号”不命中 7-11；手机号不巧合命中纯数字别名；“便利店”泛词不做包含命中；单字别名剔除后“我报过名了”不误判——见 `catalog-hardening.spec.ts`。

### 14.2 会话测试

- 新品牌替换当前主品牌；
- 排斥品牌不进入正向品牌；
- 排斥过的品牌在后续轮次被正向表达 → 移出 excluded、成为 current（反悔即赦免）；
- “换个品牌”把当前主品牌移入排斥并清空，下一轮会话品牌兜底不返回被排斥品牌（含由昵称 seed 而来的品牌——不会被重新 seed 锁回）；
- 不限品牌清空当前和排斥品牌；
- 首轮 `brand_state` 不存在且昵称品牌已验证 → seed 为 `currentBrand`，首轮推荐即按该品牌启动；
- seed 后昵称品牌与普通品牌同权：候选人表达新品牌即替换、表达排斥即进 excluded、说不限即清空；
- `brand_state` 已存在时（含被 browse_all 清成空值后）永不重新 seed，昵称品牌不再进入状态；
- 图片品牌可以更新当前主品牌；同轮用户文字明确排斥或切换时以用户文字为准；
- 图片品牌状态更新发生在 turn-finalizer（多模态主路径描述回合内产出后）；模型漏调 `save_image_description` 时触发异步补写并最终落状态；
- 同轮“肯德基不要，麦当劳可以”与“麦当劳可以，肯德基不要”产生相同状态（批量应用顺序无关）；
- 同轮图片 positive(A) + 文字 positive(B) → current=B、A 被替换丢弃（文字优先于图片）；
- 多品牌正向表达与品类展开不写 `currentBrand`；但其中品牌若在 `excludedBrands` 中则照常移除（解除排斥无条件执行）；
- debounce 合并的两条单品牌消息（“肯德基呢”+“麦当劳也看看”）同轮解析出 2 条 positive → 判为多品牌表达，`currentBrand` 不动；
- 旧 `preferences.brands` 数据懒迁移：末位品牌初始化为 `currentBrand`、其余丢弃；空数组初始化为空状态；
- 存量会话迁移后首轮，模型忘传品牌时会话品牌兜底仍能兜到旧末位品牌（recvjFFKcZPsiC 场景不回归）；
- `brand_state` 单字段读改写在租约锁内完成（并发合并回归）；
- 品类展开不解除排斥：“不要瑞幸”后说“咖啡”，瑞幸仍在 `excludedBrands`，且品类查询列表已减去瑞幸（6.2/9.3）；
- 异步补写过期即弃：补写结果轮次早于 `brand_state` 最后变更轮次时不应用（M Stand 图漏调 → 下一轮排斥 M Stand → 补写晚到，排斥不被赦免，10.3）；
- extract_facts 步骤抛错/降级时，reducer 仍以规则轨结果照常运行并落状态（6.3.1）；
- 同轮图片 positive(A) + 指示代词排斥（“这个不考虑”）→ A 先立主品牌、空品牌 negative 再将其移入排斥，终态 excluded=[A]（纯规则轨，无需 LLM）；
- 同轮多张不同品牌截图 → `image_description` 来源 ≥2 条 positive，判多品牌表达，`currentBrand` 不动。

### 14.3 工具测试

- 所有别名统一转标准品牌；
- 可用时优先使用品牌 ID；
- `enforce/exclude/clear/browse_all` 与会话品牌兜底行为正确；
- 未命中昵称不得进入工具过滤；
- 会话品牌兜底仅 `currentBrand` 一档（昵称品牌经 seed 已在其中），本轮文字/图片信号不注入查询；
- 会话品牌兜底触发时，工具结果向模型披露所用品牌及 `clear` 覆盖方式；
- queryMeta 正确记录 `brandSource`（model_input / session_state / none）；首轮由昵称 seed 而来的兜底记为 `session_state`；
- `filterMode='clear'` 时不触发任何兜底（0 结果放宽重查不被拉回原品牌）；
- 冲突别名不得强制查询；
- queryMeta 正确记录 applied/rejected；
- 用户当前明确品牌（模型显式传参）优先于会话品牌兜底（含首轮昵称 seed 值）；
- Phase 2 过渡期护栏：`brand_state` 已存在时旧 contact_remark 兜底档不触发（“换个品牌”后不被昵称锁回，Phase 2.4）。

### 14.4 守卫测试

- 守卫只读取标准化查询元数据；
- 原始模型别名被拒绝后不触发错误品牌守卫；
- 实际应用品牌与回复品牌不一致时拦截；
- 合法的跨品牌推荐说明不会被误拦截；
- `brand_alias_fuzzy_match_ignored` 从 `fuzzySuggestions` 取数后行为与现状一致（回指建议被忽略仍能拦截）；
- 语义档 review packet 的 `requestedBrands` 来自 `queryMeta.brand`、不再读模型原始参数（第 11 节第三切换点）。

## 15. 上线与兼容策略

1. 先以兼容适配方式接入现有事实提取，不立即删除旧字段；
2. 新旧结果并行记录一段时间（数据落点：第 12 节临时事件 `brand_resolution_shadow_diff`），对比品牌命中差异；
3. 工具先记录标准化结果，再切换为以标准化结果执行查询；
4. 守卫最后切换数据源，避免工具尚未完整提供 queryMeta 时产生误拦截；
5. 线上重点观察未命中率、冲突率、昵称品牌采用率、品牌过滤后零结果率和跨品牌回复率；
6. **旧匹配路径下线以观测指标为准而非固定时间**：旧的局部品牌别名判断是新旧并行对比的对照组，须待新旧命中差异率低于阈值（建议 2%，待定）且持续 7 天后才物理删除，差异样本必须逐条归因（新对旧错 / 旧对新错 / 语义歧义），不能只看比率达标；差异率与归因样本的数据源是第 12 节的临时事件 `brand_resolution_shadow_diff`（品牌目录时变，离线重放无法复现当时目录，必须在线记录），旧路径删除时事件同批下线。注意该指标门**只管旧匹配路径的删除**：Prompt Section 迁移与投影删除（Phase 4.4）等收尾项都在主线内直接执行，不等观测窗口。收尾不执行完，本次改造不算完结，不允许投影长期滞留。

## 16. 评审结论与遗留决策点

v2 修订已定口径（原评审重点 1–7 的处理）：

1. `contact_name` 唯一命中按 `positive`（~~但永不写入会话状态，仅会话品牌兜底求值~~——处理方式已被 v3 第 13 条 seed 裁定取代）；
2. 图片品牌默认 `positive`，同轮明确排斥文字优先——维持原案，补充消息类型标识与 Vision 格式契约两个实现约束（第 10 节）；
3. 极性由 6 值简化为 3 值（`positive/negative/browse_all`）：`switch` 并入品牌为空的 `negative`；`inquiry`、`reference` 及判不准场景统一按业务默认 `positive`（提及即兴趣）；防误判靠匹配门槛 + 否定规则优先 + 替换式状态机，不设中性档（6.3）；
4. 品类展开**纳入第一版** BrandResolution（`category_expansion`），不做“暂停”——现有品类兜底长在 `detectBrandAliasHints` 内部，不承接即回归（6.2）；
5. 维持单一 `currentBrand`；多品牌正向表达与品类展开不写状态，仅当轮查询（9.3）；
6. 档位维持，可执行阈值定为 ≥0.75 执行 / ≤0.40 rejected 的二分（7.4）；
7. 兼容周期改为观测指标退出条件，不定固定时间（15.6）。

v3 迭代新增已定口径：

8. `SessionBrandState` 只保留 `currentBrand` + `excludedBrands` 两字段，`historicalBrands` 删除（历史由 `brand_state_change` 事件流回放）；投影口径即 `currentBrand` 单元素数组（第 9 节）；
9. `BrandFilterMode` 四值只描述查询形态，`inherit` 模式废除——“沿用会话品牌”是品牌来源不是模式，由 queryMeta 的 `brandSource` 记录（扶正现有 `brandAliasSource`，8.1、Phase 3.4）；
10. 兜底边界原则：会话品牌兜底仅 `currentBrand` 一档（badcase 实证；昵称品牌实证由 seed 承接，见第 13 条），只补跨轮遗忘、不注入本轮信号；兜底须知情披露 + `clear` 出口（8.1）；
11. 极性 LLM 轨定为**扩展现有 `extractFacts` 输出 schema**：已核实它在 onTurnEnd 收尾序列内每轮至多一次、自带缓存与“纯应答轮”跳过，零新增调用量，产出时机先于品牌状态写入（6.3.1）。实施验证条款：若 schema 扩展实测拖累提取质量，降级为独立提取调用；
12. 图片品牌解析执行点在 `save_image_description.execute` 内（当轮供守卫对账），状态写入在 turn-finalizer；守卫不新增规则，现存两条换数据源（10.2、第 11 节）；
13. **昵称品牌升级为会话品牌状态的初始值（seed，取代 v2 第 1 条的“永不写状态、仅查询时求值”）**：昵称是候选人加好友时自己写上的明确品牌意向，`brand_state` 首次初始化时将其写入 `currentBrand`，首轮推荐即按该品牌启动（提示词建议轻确认）；此后与对话品牌完全同权（可被替换/排斥/清空），状态一旦存在永不重新 seed——“browse_all 清空后被昵称锁回”在结构上不可能，原“已知理论边界”论述整段删除；会话品牌兜底相应从两档缩为 `currentBrand` 一档（6.3、8.1、9.3、9.4）。

v4 修订（2026-07-14 全量代码核查重评）新增已定口径：

14. **品类展开收紧**：品类展开产出的 positive **不解除排斥**（“咖啡”没点名瑞幸，谈不上赦免），且品类查询列表须先减去 `excludedBrands`（6.2、9.3）——修复 v3 规则组合下“品类词赦免被排斥品牌并把它带回查询”的漏洞；其“跨轮不入状态”导致的品类偏好记忆退化升格为遗留决策点；
15. **异步补写两道时序防护**：重新持锁 + 按轮次“过期即弃”，杜绝锁外晚到写造成的旧图片信号覆盖新表达（10.3）——修复 v3 未设防的时间倒流竞争；
16. **Phase 2 过渡期护栏**：工具旧 contact_remark 兜底按 `brand_state` 存在性门控（或将 Phase 3.5 提前），堵住 Phase 2→3 空窗期“换品牌/browse_all 后被昵称锁回”复活（13）；
17. **实施清单补全**（对照代码核查）：`preferences.brands` 实为两来源**三处落笔**、Phase 2.3 逐一收口（9.2）；守卫数据源切换点为**三处**（两条硬规则 + 语义档 review packet 取数，第 11 节）；`brand_state_change` 须注册 `PersistingObserver` 持久化白名单，否则发而不落（第 12 节）；图片消息结构化判定是新增工作而非既有能力（10.4）；
18. **对比门禁的数据落点**：新增临时事件 `brand_resolution_shadow_diff`（品牌目录时变、不可离线重放，随旧路径下线删除），15.6 的差异率与逐条归因以此为源（第 12 节）；
19. **规则轨补指示代词排斥**（“这个不考虑”类 → 品牌为空 negative），配合 reducer 执行顺序，使“截图 + 排斥配文”组合无需 LLM 轨即得到正确终态；reducer 步骤不因 extract_facts 失败跳过（6.3.1）；
20. **现状口径校正**：`filterJobsToRequestedBrands` 为单向 includes 而非双向（5.1）；`sanitize-brand-name` 语义是“独立日→独立客”公司名规范化（5.1）；`brandAliasSource` 现状为含 `'none'` 的四档（8.1）；收尾序列实体在 `memory-lifecycle.service.ts`、onTurnEnd 顶层两分支并行（6.3.1、9.1）；`contact_remark` 命名全库仅剩枚举字面量一处，原 Phase 2.4 撤销并入 Phase 3.4，2.4 位置改为过渡期护栏（2.1、13）；“末位≈最近”存在去重保首现的已知误差（9.4）。

## 17. v5 实施后修订记录（2026-07-16）

Phase 1–4 已按 v4 规格全量实施（PR #561，v10.12.0 上线）。上线后 48h 内的偏离与事故修订：

1. **实施状态**：13 项验收条件全部达成；显式排除项（观测窗口/旧路径删除/生产数据操作）按约未做。旧匹配路径以 `legacyDetectBrandAliasHints` / `legacyNicknameBrandMatch` 形态保留为 shadow 对照组，随 §15.6 指标门下线；
2. **全角别名塌缩事故（P0）**：上线第 2 天由 `brand_resolution_shadow_diff` 事件发现——"６姐"塌缩成单字"姐"，候选人称呼语被批量误判为品牌意向并污染 `currentBrand`（shadow 对照组设计首战立功）。修复三规则见 §7.1/§7.3（PR #577）；污染会话清理靠 HDEL `brand_state` 字段触发懒重建；
3. **观测口径修订**：轻量计数"走日志聚合"假设不成立，升级飞书告警 + 数据侧查询（§12）；
4. **投影保留口径**：`preferences.brands` 只读投影在 Prompt Section / 工具迁移完成后仍保留，服务 Dashboard / test-suite 等未迁读方；删除时点待读方清点后定，不设固定期限（§9.2 的"不允许长期滞留"降格为跟踪项）；
5. **每轮解析成本**：目录索引 memoize 按 brandData 引用复用（30 分钟缓存期内零重建），实测无性能回归。

仍需评审会确认的遗留决策点（三项）：

1. 新旧命中差异率的下线阈值与观察窗口（建议 2% / 7 天）；
2. **品类偏好的跨轮记忆**：现状品类品牌经永久并集持久化、次轮起参与工具兜底；新设计品类不入状态，次轮起只能靠模型读对话历史自行延续。接受该退化，还是给品类偏好独立状态位（如 `currentCategory`）？（6.2）
   （v5 注记：并行分支正在演进规格外的 `category_default` 方案——品类词默认只出品类默认品牌、表达"看看别的"才全展开，matchType 新增 `category_default` 档（置信 0.85）。该方案尚未合入 develop，评审时与本决策点一并裁定。）
3. **`excludedBrands` 的查询侧强制**：维持提示词软约束（Phase 4.4 后生效），还是在 `brandSource ∈ {session_state, none}` 的查询上追加确定性后过滤 + 结果披露？（8.1）
