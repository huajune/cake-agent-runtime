---
tags: [prompt工程, agent, 学习]
source: src/agent/generator/context/
---

# Prompt Section 动态组装体系

## 解决什么问题

本项目不把 system prompt 维护成一个不可拆的大模板，而是把模型可见内容拆成有序、可独立测试的
Prompt Section。`ContextService` 依据场景清单确定性构建 block，`PreparationService` 负责准备数据并
完成回合级 system 尾块，最后统一降维为 AI SDK 的 `instructions`。

核心边界是：**计算归 preparation，呈现与排布归 sections**。装配过程零 LLM，存储结构不会因为
prompt 展示裁决而改变。

## 当前目录与 14 个叶子 Section

```text
src/agent/generator/context/
├── context.service.ts
├── final-prompt-example.md
├── scenarios/
│   └── scenario.registry.ts
└── sections/
    ├── section.interface.ts
    ├── static.section.ts
    ├── procedural/
    │   ├── candidate-consultation.md
    │   ├── channel.section.ts
    │   ├── final-check.section.ts
    │   ├── identity.section.ts
    │   ├── red-lines.section.ts
    │   ├── stage-strategy.section.ts
    │   └── thresholds.section.ts
    ├── semantic/
    │   └── memory.section.ts
    └── working/
        ├── datetime.section.ts
        ├── group-inventory.section.ts
        ├── hard-constraints.section.ts
        └── turn-hints.section.ts
```

`candidate-consultation` 场景注册 13 个 section，终序是：`identity`、`base-manual`、`channel`、
`stage-overview`、`red-lines`、`thresholds`、`memory`、`turn-hints`、`hard-constraints`、
`datetime`、`group-inventory`、`stage-strategy`、`final-check`。其中 `final-check` 是复合
section（发送前防线统一规则表），经 `buildBlocks` 产出次末位的 `final-check` 常驻自检块与
末位按命中出现的 `critical-turn-guard` 动态硬禁令块——块级终序与合并前一致。

`section.interface.ts` 是契约，`static.section.ts` 是静态资产适配器；两者是基础设施，不参加知识
分类。目录只跟真实住户走，没有空分类目录。

## 两根正交分类轴

第一根轴是知识主类型，决定文件住哪：

| 类型       | 判断问题                   | 当前内容                                                     |
| ---------- | -------------------------- | ------------------------------------------------------------ |
| procedural | 它是否告诉模型如何行动？   | 手册、渠道规范、身份人格、红线、阈值、阶段策略、关键回合禁令 |
| semantic   | 它是否呈现候选人事实？     | 历史档案、会话事实、岗位与工单上下文的 `memory` 渲染         |
| working    | 它是否只服务当前轮工作台？ | 当前时间、本轮增量、本轮查询约束、按当前城市选出的群库数据   |

第二根轴是模型语料域，由 `PROMPT_SECTION_DOMAIN_REGISTRY` 封闭登记：

| 语料域      | 用途                | 例子                                 |
| ----------- | ------------------- | ------------------------------------ |
| teaching    | 行为教学与约束      | 手册、身份、红线、阶段策略           |
| evidence    | 候选人相关证据      | memory、turn-hints、hard-constraints |
| tool_result | 确定性外部/运行结果 | datetime、group-inventory            |

知识类型和语料域不能合并成一个字段：例如 `hard-constraints` 的目录归类是 working，但模型语料域
是 evidence。所有模型可见叶子都必须在语料域注册表中有牌照。

## 从召回到模型调用

```text
memory.onTurnStart()
  → snapshot enrichment
  → 对话消息归一化
  → prompt-memory-adjudicator 生成共享裁决视图
  → memory.section 渲染档案/会话/岗位/工单
  → ContextService 按场景清单构建 PromptCorpusBlock[]
  → PreparationService 插入 input guard / 主动跟进尾块
  → renderPromptBlocks() 统一降维
  → AI SDK: instructions + messages + tools
```

preparation 下的辅助文件负责召回后的计算：共享裁决、对话归一化、工具上下文、工具集过滤、回合
账本和快照补全。sections 只接收已经准备好的上下文，负责标签、字段行和最终排布。

`SnapshotEnrichmentService` 紧接 `memory.onTurnStart()` 调用，但属于 generator 备料，不属于 memory
lifecycle；memory 域只负责召回、存储与回合收尾。

## system 段序

候选人咨询场景的模型可见终序为：

1. 开篇人设：`identity`。它属于配置档，但变更极低频，前置对缓存代价近似为零。
2. 稳定内容与配置：`base-manual → channel → stage-overview → red-lines → thresholds`。
3. 动态事实与阶段：`memory → turn-hints → hard-constraints → datetime → group-inventory → stage-strategy`。
4. recitation 收口：section 终序只有 `final-check`（复合 section）；它固定产出
   `final-check` 常驻块，规则命中时再在内部追加 `critical-turn-guard` 子块。

`stage-overview` 展示全阶段地图且不读取 `currentStage`；`stage-strategy` 只展示当前阶段，因此留在动态
尾部。`final-check` 的常驻自检块虽是静态文本，但位置承担发送前自检功能，因此放在当前阶段策略之后。
空 section 不产生 block。输入安全 guard 在 preparation 中插到 `final-check` 的条件子块
`critical-turn-guard` 之前，主动跟进
directive 则追加到全部场景 block 之后。

这些内容全部保持 system 语义，通过 `instructions` 传入。记忆、当前阶段和本轮线索不会伪装成
候选人消息。`messages` 只承载归一化的对话历史与多模态消息，`tools` 由 AI SDK 单独序列化。

## 共享冲突裁决

`adjudicatePromptMemory()` 是 preparation 阶段的唯一 prompt 展示裁决入口。它生成共享的
`PromptMemoryAdjudication`，由 `memory.section` 与 `turn-hints.section` 同时消费：

- 权威链：本轮 accepted > 当前会话 accepted > 历史档案 historical_unconfirmed。
- 跨作用域先按权威链裁决；置信度只在同一作用域内比较。
- 同层同置信度时比较归一后的 `updatedAt / extractedAt`；任一时间缺失则保守保持输入顺序。
- 跨层同值只在权威位置展示一次；异值展示胜者，并保留“档案记 X，本次称 Y”冲突说明。
- 本轮 hint 与权威 fact 同值时去重，异值进入“待确认更新”块，新增值正常展示。

这是 prompt-only 副本，既不回写记忆，也不替换工具和回合账本消费的原始 `turnHints`。
`TurnHintsSection` 没收到共享裁决视图会直接抛错，避免渲染路径私自再裁决。

## promptBlocks 与模型可见标签

每个非空 section 先成为：

```ts
interface PromptCorpusBlock {
  id: string;
  domain: 'teaching' | 'evidence' | 'tool_result';
  role: 'system';
  content: string;
}
```

`renderPromptBlocks()` 是唯一降维点：按顺序 trim 非空内容，再以两个换行连接为 `finalPrompt`。
在此之前，`id / domain / role / content` 始终保留，便于测试、观测和 promptBlocks diff 审计。

模型可见内层标签也是契约，例如 `[用户档案]`、`[历史求职意向]`、`[记忆冲突裁决]`、
`[会话记忆]`、`[本轮解析线索]`、`[本轮待确认线索]`、`[当前阶段策略]`。代码搬迁或外层排序
不得顺手改掉这些标签。

## 配置与内容资产边界

- `candidate-consultation.md`：稳定的全局工作手册、工具通用原则和固定业务解释口径。
- `final-check.section.ts`（`FINAL_CHECK_RULES`）：发送前防线统一规则表——`trigger='always'`
  的常驻自检项与 `trigger='turn'` 的本轮动态硬禁令同表登记。
- `strategy_config.role_setting / persona`：角色、人设与表达风格。
- `strategy_config.red_lines / thresholds`：可运营调整的业务底线与数值约束。
- `strategy_config.stage_goals`：全阶段地图和当前阶段目标、成功标准、CTA 与禁止行为。
- 工具 description：与单个工具调用强绑定的契约；例如入群的行业参数与无群处理规则。
- `memory / turn-hints / hard-constraints / datetime / group-inventory`：每轮准备出的事实与结果。

分层原则是：工具专属规则放工具 description，跨工具的稳定原则放手册，运营口径放策略配置，
每轮事实放动态 section。群库 section 只展示数据，操作指令由手册和 `invite_to_group` description
承载，避免数据块变成未受台账覆盖的教学入口。

## 缓存与稳定性

主聊走 Qwen 隐式前缀缓存，当前代码没有显式缓存断点，也没有 provider 缓存适配层。领先稳定前缀
以低频变化的 `identity` 开篇，再接手册、渠道、阶段总览和配置规则；字节级测试会用不同时间、记忆
和当前阶段输入对拍，保证其中不混入轮变化内容。`final-check` 常驻自检块为发挥 recitation 收口功能
固定在场景次末位，虽是静态文本，但不计入领先缓存前缀。

tools 也参与供应商前缀。普通文本回合的固定工具键顺序、description 和 input schema 已有稳定性
测试；图片、简历与 MCP 工具是按上下文或注册状态变化的已知动态边界。治理要求是先报告边界，
不要为了缓存命中擅自改变工具可用性。

## 维护与测试纪律

- 排序只改 `SCENARIO_SECTIONS` 的显式清单，并同步顺序断言和本页文档。
- 新增模型可见 section 时，同步 `ContextService.registerSections()`、场景清单、语料域注册表和
  prompt surface census 测试。
- `sections/procedural/` 下每个 `.ts` 与 `.md` 都必须带 `prompt-rule-ledger` 锚点。
- 领先稳定前缀与静态 `final-check` 必须通过跨轮字节相等和时间/记忆/阶段污染断言。
- 呈现搬迁必须有输出字节不变测试；共享裁决只能由 preparation 计算一次。
- 完整装配示例见
  [`src/agent/generator/context/final-prompt-example.md`](../../src/agent/generator/context/final-prompt-example.md)。

## 学习要点

- Prompt Section 类似可组合 UI：每块单一职责、由上下文驱动、按注册表确定性排列，但最终产物仍是
  一个有严格 role 边界的 system prompt。
- prompt 不是越长越可靠。确定性解析、共享裁决和工具契约承担硬逻辑，模型只消费已经摆好的证据与
  教学内容。
- 目录分类解决“内容归谁”，语料域标签解决“模型该如何理解”，稳定段位解决“供应商前缀能否复用”；
  三者互补，不能互相替代。
