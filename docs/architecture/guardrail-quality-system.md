# Guardrail 质量体系

**最后更新**：2026-08-26（按当前 catalog、OutputGuardrailService、Runner 修复链与观测表核实）

> 本文只解释 **Output 守卫的实时裁决、修复边界和质量闭环**，不是四个防线作用位的总览。
> 全系统有 Input / Prompt / Tool / Output 四个作用位；Input / Tool / Output 是 catalog
> 登记的三类执行 guardrail。完整边界见
> [安全护栏说明](./security-guardrails.md)。规则还是语义的放置判据见
> [确定性规则与语义理解的分工哲学](../principles/rules-vs-semantics-design-philosophy.md)。

---

## 1. 当前实时链

```text
Prompt 防线生成首版
  → Tool 门禁已经约束本轮动作
  → Runner 去时间标记
  → OutputGuardrailService
      ├─ HardRulesService：确定性规则
      ├─ SemanticReviewerService：按开关与触发条件 enforce / shadow
      └─ 聚合：pass | observe | revise | block
  → pass / observe：进入 outcome 分类
  → revise / block：
      ├─ 直达静默特例
      ├─ 确定性剥围栏 / 剥推理残文 / 拆 JSON 信封
      └─ ReplyRepairAgent 无工具重写，hard cap = 1
          → 二审
          → repair regression gate
          → pass / fail-open / guardrail_blocked
  → OutboundReplySanitizer
  → Replay 定局
  → 投递或提交人工介入副作用
```

分段所有权：

| 组件                             | 可以做什么                                              | 不能做什么                              |
| -------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `HardRulesService`               | 读取回复与已有证据，产出 contradiction 与动作           | 改写文本、重调工具、提交副作用          |
| `SemanticReviewerService`        | 基于裁剪证据包产出结构化 finding                        | 凭低置信结论 veto；直接发送告警或改文案 |
| `OutputGuardrailService`         | 合并规则与语义 verdict，处理 fail-open / fail-close     | 写候选人可见文本                        |
| `AgentRunnerService`             | 选择确定性修复或 `ReplyRepairAgent`，二审并收敛 outcome | 在 repair 中重进 Generator 或重做副作用 |
| `TurnOutcomeInterventionService` | 最终回合确定后提交暂停托管、handoff、告警等副作用       | 重新解释 guardrail 的业务判定           |

---

## 2. 确定性规则与动作

`output/rules/output-rule-catalog.ts` 是现行规则唯一权威。当前 **31 个 ruleId**：

| action    | 数量 | 首版是否可发 | 后续                                     |
| --------- | ---: | ------------ | ---------------------------------------- |
| `observe` |   11 | 是           | 留档；某些规则还会触发确定性补动作或去重 |
| `revise`  |   14 | 否           | 一次有界修复后再审                       |
| `block`   |    6 | 否           | 除直达静默外先自救一次，失败后硬拦       |

### 2.1 聚合与运行时覆盖

聚合优先级是 `block > revise > observe > pass`。动作不是风险等级的别名：规则的 priority、
recoverability、feedback policy 与最终收敛共同决定是否允许 fail-open。

运行时配置支持按 ruleId override，单轮读取同一份 `agent_reply_config` 快照，避免 hard rules 与
语义 reviewer 看到不同配置版本。override 也会写入档案标记，不能形成“关了但看不出来”的盲区。

### 2.2 规则发牌与生命周期

新增、删除或改动作时必须同时满足：

1. ruleId 在实现与 catalog 双向一致，catalog test 通过；
2. 有可复核的外生信号或封闭词形，不用正则猜开放语义；
3. 新规则默认 observe；升 revise / block 必须有生产判例与精确率证据；
4. 修改 Prompt 教侧配对时，同批更新 [Prompt 规则台账](../prompt-rule-ledger.md)；
5. 长期零命中、假阳超标或已被上游构造性修复的规则必须降档或退役。

### 2.3 修复回归的收敛牌

历史代码注释引用本节作为收敛依据。当前顺序固定为：① 最多修复一次；② 修复版二审；③ 只剩
可恢复 P1/P2 时允许有记录的 fail-open，P0 / 不可恢复问题失败则 block；④ regression gate
发现修复版相对首版退化时，首版具备 fail-open 资格就回退首版，否则两版都不投递。

### 2.4 `replan` 退役边界

带工具重进 Generator 的 `replan` 已从枚举和运行路径删除。未来若有规则希望“补取事实后修复”，
必须先修订本文并把取数与写字拆开：取数归 Generator 的受控只读路径，候选人可见文本仍只归
`ReplyRepairAgent`；不得直接恢复历史 replan。

---

## 3. 语义 reviewer

语义 reviewer 不是第三方“再想一遍”，它只能消费 `GuardrailReviewPacket` 中的已有证据。
当前证据面包括岗位列表、precheck、booking、geocode、已发定位、拉群回执和图片事实；finding
code 共 5 类，以 `SEMANTIC_REVIEW_FINDING_CODES` 为准。

### 开关与触发

- `outputGuardrailLlmEnabled=true`：满足高风险或 semantic contract 触发条件时，verdict 参与裁决；
- 未 enforce 且 `outputGuardrailSemanticShadowEnabled=true`：旁路运行，只记录不改行为；
- 两者都关：只运行确定性规则；
- 主控在托管配置 `agent_reply_config`，env 只提供 bootstrap 默认值；
- review 模型未配置时，语义档降为未开启并告警，避免高危回合因配置错误全部 fail-close。

### 可靠性边界

- 低置信 revise / block 在代码层降为 observe；
- 已提交副作用或承诺事实触发的高风险评审失败时 fail-close；
- 仅 semantic contract 触发的评审失败时 fail-open，回退确定性规则结论；
- shadow / enforce verdict 都进入守卫档案；`silent: true` advisory 不落生产判例。

语义 reviewer 的输入是裁剪证据包。任何“无证据”finding 都必须先排除证据字段遗漏或截断，
不能直接归因模型幻觉。

---

## 4. 修复不是第四个 guardrail 层

repair 是 Output 裁决后的**有界收敛策略**，不是独立防线，也不是质量重生成器。

### 4.1 当前可用路径

1. **确定性最小修复**：剥内部推理残文、Markdown 围栏或 JSON 信封；正文尽量逐字保留。
2. **受控文本重写**：`ReplyRepairAgent` 使用首版、违规项、红线、工具轨迹与 repair context，
   但不拥有工具。
3. **二审**：修复版使用首版工具轨迹再次执行 Output guard。
4. **回归闸**：比较首版与修复版，识别结构坍缩、结论极性反转、日期星期改错、
   booking 承诺降级和承诺升级。
5. **确定性收敛**：不可恢复 / P0 问题失败时 block；仅可恢复 P1/P2 残留时按代码规则 fail-open。

### 4.2 硬边界

- 修复最多一次；
- `replan` 已从运行路径与枚举退役；
- repair 不得重进 Generator，不得重新调用业务工具；
- 已提交副作用只作为只读事实进入 repair，不得重复执行；
- 直达静默、空修复、悬空承接句和回归命中必须有明确 `reasonCode`；
- 被丢弃首版不能写入 assistant 记忆，turn-end 只在最终投递结局确定后执行。

这组边界的目标不是证明“第二次生成一定更好”，而是让最坏情况有确定性上限并可归因。

---

## 5. 投递物与观测

| 数据面                                        | 记录内容                                            | 注意事项                                   |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| `message_processing_records.guardrail_output` | 回合级紧凑摘要                                      | 适合流水详情，不代替完整档案               |
| `guardrail_review_records`                    | 首版、首审、修复版、二审、最终裁决、语义 verdict    | 稀疏表；无守卫信号的 pass 回合通常没有记录 |
| `agent_execution_events`                      | `semantic_review` 运行次数、decision、finding codes | 用于覆盖率与运行健康度                     |
| `TurnOutcome.outputGuardrail`                 | 最终 decision、ruleIds、reasonCode、是否修复        | 渠道投递与副作用提交的运行时事实           |
| `message_processing_records.reply_preview`    | 最终候选投递物的观测副本                            | 做事后质量复核时应审它，而不是只审首版     |

不能用 `guardrail_review_records 行数 / 全部回合数` 直接解释成“守卫覆盖率”：该表本来就是
信号稀疏表。语义 reviewer 覆盖率应结合 `agent_execution_events`、开关状态和触发条件计算。

---

## 6. 质量闭环：快环与慢环

### 6.1 快环（仓内已实现）

实时投递路径负责：

- Prompt 降低首版违规；
- Tool 阻止不可逆错误动作；
- Output 对封闭形态与证据冲突做确定性裁决；
- semantic reviewer 只在明确开关与门控下运行；
- repair 一次有界，失败按风险确定性收敛；
- 全链路留下可按 traceId 关联的证据。

快环不得把新的 LLM 判断器直接串进发送必经路径，也不得让离线发现自动改写线上配置。

### 6.2 慢环（仓外流程，仓内无自动执行器）

仓库当前没有“每日全量扫描并自动修 Prompt / 规则”的 `src/**` 实现。离线复核由外部
skills / 运营流程消费 MPR、守卫档案、BadCase 与 test-suite 资产；其结果必须经过人工归因、
PR、测试与灰度后才能改变热路径。

建议的固定审计口径：

1. 按 ruleId 统计命中量、人工真阳、精确率、最终 block 与 fail-open；
2. 单独统计 repair 引入的回归形态与 `repair_exhausted*`；
3. 对 semantic reviewer 统计 eligible / executed / pass / finding / failure，而不是只看记录行；
4. 从 `reply_preview` 审最终投递物，并与工具事实、后续兑现结果对账；
5. badcase 归因后优先修 Prompt / 数据流 / 工具契约，只有封闭且高精度的形态才升级 guardrail；
6. 每次规则升降档都保留回滚点，并在 test-suite 加入对应真实判例。

---

## 7. 当前已知风险

- 语义 reviewer 默认关闭；关闭时不存在语义 veto，只剩确定性规则。
- 证据包是裁剪视图，新增工具证据若没有进入 packet，会制造“无证据”假阳。
- 一次 LLM rewrite 仍可能损伤首版未被点名的内容；二审与回归闸只覆盖已知形态。
- observe 不等于“问题已解决”，只表示当前回复仍被允许发送并留证。
- runtime override 可即时改变规则行为，排障必须同时查看当轮配置快照和 override marker。
- Prompt 是防线但没有最终裁决权；不能把 Prompt 测试通过当作 Tool / Output 可以删除的证据。

---

## 8. 沿革

2026-07 至 08 的生产审计证明，大面积正则与带工具 `replan` 会制造假阳、事实重掷和不可控
修复。随后系统完成规则降档/退役、`replan` 物理删除、ReplyRepairAgent 单写手收口、
二审与 repair regression gate。历史指标与当时的决策证据保留在
[规则与语义分工哲学](../principles/rules-vs-semantics-design-philosophy.md)、
[苦涩教训台账](../principles/bitter-lessons.md) 和对应 release notes；本文只描述当前终态。

---

## 相关代码

- `src/agent/guardrail/output/output-guardrail.service.ts`
- `src/agent/guardrail/output/hard-rules.service.ts`
- `src/agent/guardrail/output/rules/output-rule-catalog.ts`
- `src/agent/guardrail/output/llm/`
- `src/agent/guardrail/output/repair-regression.util.ts`
- `src/agent/guardrail/output/outbound-reply-sanitizer.ts`
- `src/agent/runner/agent-runner.service.ts`
- `src/agent/runner/turn-outcome.ts`
- `src/agent/reply-repair/reply-repair.agent.ts`
