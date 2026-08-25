# `candidate-consultation` 最终 Prompt 装配示例

本文按 2026-08-26 的真实代码路径重生成，描述 `PreparationService.prepare()` 交给
AI SDK 的三份模型输入：`instructions`、`messages` 与 `tools`。

## 三条输入通道

```text
instructions = WorkingMemory.finalPrompt       // 全部 PromptSection 与回合级 system 尾块
messages     = WorkingMemory.normalizedMessages // 候选人/助手历史消息与多模态内容
tools        = WorkingMemory.tools              // 当前场景可用工具的 description + schema
```

Section 的动态内容仍属于 `instructions`（system 语义）。记忆、本轮线索、当前阶段、时间和群库
数据不会被搬进 `messages`。工具目录由 AI SDK 从 `tools` 独立序列化，也不拼进候选人消息。

## prepare() 装配链

```text
memory.onTurnStart()
  → SnapshotEnrichmentService.enrich()（有身份锚时，紧接召回）
  → normalizeConversationWithCorpus()
  → adjudicatePromptMemory()（一次生成共享裁决视图）
  → buildMemoryBlock()（只负责呈现共享视图）
  → ContextService.compose()（按场景清单生成 system promptBlocks）
  → 构建本轮 tools
  → 插入 input-guard / proactive-directive（按需）
  → renderPromptBlocks()（唯一降维点）
  → WorkingMemory
```

`SnapshotEnrichmentService` 是 generator 的备料步骤，不属于 memory lifecycle；
`prompt-memory-adjudicator` 负责计算，`sections/` 负责模型可见呈现与排布。

## 场景 Section 顺序

`SCENARIO_SECTIONS['candidate-consultation']` 当前包含 14 个模型可见叶子 section：

| 段位     | 顺序 | Section               | 知识归类   | 语料域      | 稳定性 / 省略条件                     |
| -------- | ---: | --------------------- | ---------- | ----------- | ------------------------------------- |
| 静态前缀 |    1 | `base-manual`         | procedural | teaching    | 固定手册                              |
| 静态前缀 |    2 | `final-check`         | procedural | teaching    | 固定发送前自检                        |
| 静态前缀 |    3 | `channel`             | procedural | teaching    | 渠道固定；私聊为空                    |
| 静态前缀 |    4 | `stage-overview`      | procedural | teaching    | 全阶段地图；不读取当前阶段            |
| 配置段   |    5 | `red-lines`           | procedural | teaching    | 随策略配置版本变化                    |
| 配置段   |    6 | `thresholds`          | procedural | teaching    | 随策略配置版本变化；无阈值时为空      |
| 配置段   |    7 | `identity`            | procedural | teaching    | 策略角色、人格与托管账号身份          |
| 动态尾部 |    8 | `memory`              | semantic   | evidence    | 档案、会话事实、岗位/工单等均空时省略 |
| 动态尾部 |    9 | `turn-hints`          | working    | evidence    | 本轮共享裁决增量为空时省略            |
| 动态尾部 |   10 | `hard-constraints`    | working    | evidence    | 本轮查询约束为空时省略                |
| 动态尾部 |   11 | `datetime`            | working    | tool_result | 每轮当前时间                          |
| 动态尾部 |   12 | `group-inventory`     | working    | tool_result | 无高置信城市或群库数据时省略          |
| 动态尾部 |   13 | `stage-strategy`      | procedural | teaching    | 只渲染当前阶段策略                    |
| 动态尾部 |   14 | `critical-turn-guard` | procedural | teaching    | 命中关键回合规则时才渲染              |

这里有两根互不替代的轴：目录表达知识主类型；`PROMPT_SECTION_DOMAIN_REGISTRY` 表达
teaching / evidence / tool_result 语料域。`static.section.ts` 和 `section.interface.ts` 是根目录
基础设施，不是知识 section。

空 section 不生成 block，因此一个普通私聊示例常见的结构化顺序是：

```text
base-manual
final-check
stage-overview
red-lines
thresholds
identity
memory                  （有内容时）
turn-hints              （有本轮增量时）
hard-constraints        （有本轮约束时）
datetime
group-inventory         （有城市群库数据时）
stage-strategy
critical-turn-guard     （命中时）
```

## 回合级尾块与最终顺序

`ContextService.compose()` 先产出场景 block。`PreparationService` 再按下式完成最终装配：

```text
finalPrompt = renderPromptBlocks(
  scenario blocks before critical-turn-guard
  + input-guard（输入安全检查未通过时）
  + critical-turn-guard（命中时）
  + proactive-directive（主动跟进回合时）
)
```

- `input-guard` 固定插在 `critical-turn-guard` 前，保持既有最终字节顺序。
- `critical-turn-guard` 是场景清单末位；未命中时不产生 block。
- `proactive-directive` 不属于场景 section，只在主动/复聊回合追加到最终 system 尾部。
- 已退役的 generator 重写回路不再产生额外尾块；修复由独立 `ReplyRepairAgent` 承担。

所有上述 block 都是 `role: system`。最终文本仅在 `renderPromptBlocks()` 处按两个换行连接，
但 `promptBlocks` 中的 `id / domain / role / content` 会保留给观测和审计。

## 模型可见的大致形态

```text
# 全局工作原则
...

# 回合 SOP
...

# 发送前自检（全部需通过）
...

[所有阶段概览]
...

[阶段推进提示]
...

# 红线规则（以下行为绝对禁止）
...

# 业务阈值
...

# 角色
...

# 账号身份
...

# 人格设定
...

[用户档案] / [历史求职意向] / [记忆冲突裁决] / [会话记忆]
...

[本轮解析线索] / [本轮待确认线索]
...

[本轮查询硬约束]
...

当前时间：2026年04月01日星期三 10:04

## 兼职群资源（按需）
...

[当前阶段策略]
...

⚠️ 安全提示...（按需）

# 本轮动态硬禁令（按需）
...

# 主动跟进回合（reengagement，按需）
...
```

这是形态示意，不保证所有条件块同时出现；真实顺序以场景注册表与 `promptBlocks` 为准。

## 共享记忆裁决与渲染

`adjudicatePromptMemory()` 在 preparation 阶段只计算一次，`memory` 与 `turn-hints` 共同消费：

- 权威链是本轮 accepted > 当前会话 accepted > 历史档案 historical_unconfirmed。
- 置信度和 `updatedAt` / `extractedAt` 归一时间键只在同一作用域内比较；时间缺失时保守保持。
- 跨层同值只保留权威一处；异值保留胜者，并在 `[记忆冲突裁决]` 显示“档案记 X，本次称 Y”。
- `turnHints` 与权威 facts 同值时去重，异值进入 `[本轮待确认线索]` 并标为“待确认更新”。
- `TurnHintsSection` 缺少共享裁决视图时直接抛错，不允许渲染层另算一份裁决。

`buildMemoryBlock()` 的可能顺序是：

1. 经品牌库核验的企微名称备注（按需）；
2. `[用户档案]`；
3. `[历史求职意向]`；
4. `[记忆冲突裁决]`（按需）；
5. `[会话记忆]`；
6. `[候选人当前所在兼职群]`（实时核验结果）；
7. `[当前预约信息]` 或 `[预约状态]`。

`[本轮解析线索]` 与 `[本轮待确认线索]` 不属于 `memoryBlock`，由独立的
`turn-hints` section 渲染。存储侧不消费裁决后的展示副本。

## 当前时间

`ContextService.compose()` 每次只生成一份 `currentTimeText`：`datetime` section 使用它，
静态资产中的 `{{CURRENT_TIME}}` 也统一替换为它，避免同一 prompt 出现两个时间来源。

## Qwen 隐式前缀缓存边界

当前实现不打显式缓存断点，也没有 provider 缓存适配层。收益来自 Qwen 自动的隐式前缀缓存：

- 静态前缀在同一场景、渠道和配置版本下不含时间、记忆或当前阶段标记；字节级测试锁定纯净性。
- 普通文本回合的固定工具集合顺序、description 与 input schema 已验证逐字节稳定。
- 图片回合会按需加入 `save_image_description`，简历回合会按需加入
  `read_resume_attachment`，MCP 工具会随注册/删除和注册顺序变化；这些是现存动态边界，
  本批只报告，不改变其行为。
