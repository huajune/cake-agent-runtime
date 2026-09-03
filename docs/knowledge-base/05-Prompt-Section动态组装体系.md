---
tags: [prompt工程, agent, 学习]
source: src/agent/generator/context/
---

# Prompt Section 动态组装体系

## 一句话理解

Cake 不把 system prompt 当成一个不可拆的大字符串，而是把它编译成一组带身份的
`PromptCorpusBlock`：Resolver 先给出本轮唯一的 `PromptModel`，Section 只做同步渲染，
Compiler 再依据 `PromptSlot + Manifest` 排序、降维和生成观测元数据。

这套设计要解决四个问题：

1. 事实读取、事实裁决和模型文案不再混在一起；
2. 证据、教学规则和工具结果在降维前仍可区分；
3. 安全块的位置由类型表达，不靠 `findIndex + slice` 插缝；
4. Prompt 改动可以按 block 定位、测试和观测，而不只看到一整段字符串。

## 真实数据流

```text
normalizeTurnInput()
  → TurnDataLoaderService.load()        统一读取 Redis / Supabase / 海绵 / 群 / 配置
  → normalizeConversationWithCorpus()  生成模型 messages 与带来源语料块
  → PromptInjectionDetector            只产生结构化 assessment
  → resolveTurnContext()               事实裁决并投影 PromptModel / ToolContextModel
  → ContextService.compose()
      → Section.build(PromptModel)      同步纯渲染
      → compilePromptProgram()          slot 排序、block 展开、指标计算
      → renderPromptBlocks()            唯一字符串降维点
  → AI SDK instructions
```

边界口诀：**Loader 取数，Resolver 定案，Section 表达，Compiler 排序，Preparation 编排。**

## 目录与核心契约

```text
src/agent/generator/context/
├── context.service.ts
├── context.types.ts
├── final-prompt-example.md
└── sections/
    ├── section.ts
    ├── procedural/
    ├── semantic/
    └── working/
```

### PromptModel：已裁决的模型视图

`PromptModel` 不是数据库实体集合，也不包含提前拼好的 `memoryBlock`。它只暴露 Section 真正需要的
类型化视图：identity、strategy、memory、group inventory、turn hints、hard constraints、security
和 critical-turn instructions。

这意味着 Section 看不到两份待冲突裁决的事实，也不应该知道 Redis key、Supabase 表或海绵响应格式。

### PromptSection：同步纯渲染

```ts
interface PromptSection {
  readonly id: string;
  readonly domain: 'teaching' | 'evidence' | 'tool_result';
  readonly slot: PromptSlot;
  readonly dynamic: boolean;
  build(model: PromptModel): PromptCorpusBlock[];
}
```

- `build()` 不能返回 Promise，从类型上封死每轮偷偷做 IO；
- 空数组表示该条件块本轮不出现；
- 复合 Section 可以返回多个 block，例如 memory 会展开为候选人记忆、实时群状态和预约上下文；
- `dynamic` 表示内容是否随回合变化，供观测和缓存分析使用。

### PromptCorpusBlock：降维前的语义身份

```ts
interface PromptCorpusBlock {
  id: string;
  domain: 'teaching' | 'evidence' | 'tool_result';
  role: 'system';
  content: string;
}
```

`id` 用于差异定位，`domain` 用于指令—数据审计，`role` 保证这些内容不会伪装成候选人消息。
只有 `renderPromptBlocks()` 会把结构压成最终 `instructions` 字符串。

## 三根互不替代的分类轴

| 轴            | 回答的问题                   | 例子                                         |
| ------------- | ---------------------------- | -------------------------------------------- |
| 代码目录      | 这类知识由谁维护？           | procedural / semantic / working              |
| corpus domain | 模型应把它当作什么？         | teaching / evidence / tool_result            |
| prompt slot   | 它在编译结果的哪个阶段出现？ | evidence / final-recitation / critical-guard |

例如 `hard-constraints` 住在 working 目录，因为它服务当前轮；domain 是 evidence，因为它陈述已经裁决的
事实；slot 是 evidence，因为它必须在工作上下文和最终复诵之前出现。三个答案都正确，但含义不同。

domain 不再维护一份容易漂移的中央注册表，而由每个 Section 的类型声明直接负责；Compiler 读取该声明
生成 block metrics。

## Manifest 与 Slot 如何共同排序

当前 slot 顺序只有一个权威：

```text
stable-instructions
→ strategy
→ evidence
→ working-context
→ final-recitation
→ input-security
→ critical-guard
```

`SCENARIO_PROMPT_MANIFEST` 只回答“这个场景有哪些 Section”，同 slot 内保持 manifest 顺序；跨 slot
一律由 `PROMPT_SLOT_ORDER` 决定。因此新增一个安全尾块时，不需要调用方知道 `final-check` 的数组下标。

候选人咨询场景的实际终序是：

```text
identity → base-manual → channel → stage-overview
→ red-lines → thresholds
→ candidate-memory / realtime-group-status / booking-context
→ turn-hints → hard-constraints
→ datetime → group-inventory → stage-strategy
→ final-check → input-guard（按需）→ critical-turn-guard（按需）
```

注意：manifest 中登记的是 `memory` Section，但它可以展开为三个独立 evidence block，所以 Section 数量
和最终 block 数量不是同一个概念。

## Memory 为什么要拆成三个 block

过去 `memoryBlock` 混合了长期档案、会话事实、实时群核验和预约工单。它们的来源、时效和权威并不相同：

- `candidate-memory`：历史档案与当前会话事实，必须遵守跨层冲突裁决；
- `realtime-group-status`：本轮实时核验结果，禁止被历史记忆替代；
- `booking-context`：进行中预约；`none` 与“读取失败所以 hidden”语义严格不同。

拆块不是为了让 Prompt 更长，而是为了在同一 system role 内保留证据边界，并能独立观察某个来源是否
缺失或膨胀。

## Prompt Injection 如何进入 Prompt

这里有三个独立职责：

1. `PromptInjectionDetector` 只检查角色劫持、提示词泄露和系统标记；
2. `resolveTurnContext()` 把 assessment 投影成不含完整输入的 `PromptSecurityView`；
3. `InputSecuritySection` 在命中时生成 `input-guard`，Observer 另外负责 trace 和告警。

模型提示属于软防线：它提高模型服从系统指令的概率，但不能替代工具参数校验、权限、业务状态机、
幂等、副作用门禁和输出守卫。

## 共享冲突裁决

`adjudicatePromptMemory()` 是 Prompt 展示裁决入口，`resolveHardConstraintsPromptView()` 负责把高置信
会话事实与本轮线索合并成查询约束。主要原则：

- 当前候选人明确表达高于当前会话已确认事实，高于历史档案；
- 同一作用域才比较置信度和时间；
- 同值去重，异值保留解释但只允许一个当前胜者；
- 待确认异值不能直接覆盖已确认事实；
- Prompt 投影不回写存储，真正回写仍走 memory lifecycle。

Prompt 与工具使用同一次 Resolver 结果，避免模型看到“北京”，工具却继续按“上海”执行。

## 可观测性

Compiler 返回：

- `blocks` 与最终 `rendered`；
- `orderHash`：由 `slot:id:domain` 序列计算；
- `blockMetrics`：每块字符数、slot、domain、dynamic；
- `dynamicBlockIds`。

`turn_preparation` 记录这些结构元数据、总字符数、token 粗估、各准备阶段耗时和工具数量；
`turn_data_sources` 记录逐源状态、耗时与观测时间。观测不额外保存完整 block 正文，避免复制敏感内容。

排查顺序通常是：来源有没有读到 → Resolver 有没有裁决成视图 → Section 有没有出块 → 顺序 hash 是否
变化 → 工具是否正确发牌 → 模型看到后是否仍违背。

## 维护纪律

新增或修改 Section 时：

1. 选择正确目录，并声明 `id / domain / slot / dynamic`；
2. 只消费 `PromptModel`，不得查询外部服务或再次裁决事实；
3. 在 `ContextService.registerSections()` 注册；
4. 在 `SCENARIO_PROMPT_MANIFEST` 加入目标场景；
5. 补 Section 输出、block id/domain/slot 顺序和最终 Prompt 兼容测试；
6. procedural 规则同步更新 [Prompt 规则台账](../prompt-rule-ledger.md)。

禁止重新引入：预渲染大字符串字段、异步 Section、中央 domain 双登记、Preparation 数组插缝、把动态
system 信息塞进 user messages、为了缓存命中而擅自删工具或事实。

## 延伸阅读

- [Agent Runtime 架构](../architecture/agent-runtime-architecture.md)
- [回合装配边界重构方案](../todo/agent-turn-assembly-refactor.md)
- [最终 Prompt 示例](../../src/agent/generator/context/final-prompt-example.md)
- [Prompt 规则台账](../prompt-rule-ledger.md)
