# 候选人档案域架构

**最后更新**：2026-08-26
**代码居所**：`src/resolution/`、`src/memory/`、`src/agent/generator/preparation/`

> 本文只描述当前实现。记忆的存储与生命周期见
> [memory-architecture.md](./memory-architecture.md)，全局状态定位见
> [memory-and-state.md](./memory-and-state.md)，收资表单见
> [collection-form-machine.md](./collection-form-machine.md)。

## 1. 域边界

候选人档案链路遵守三条规则：

1. **判断归 resolution**：字段解析、来源核验、值等价与冲突裁决写成零 IO 的确定性函数。
2. **状态归 memory**：跨回合事实、工作台和候选人 × bot 长期关系档由 memory 持有。
3. **本轮只判一次**：preparation 生成 `turnHints`、共享 Prompt 裁决视图与 `TurnLedger`，
   Prompt、工具和回合末写入消费同一份结果，不各自重扫一套规则。

`resolution/` 没有 Nest module、service 或存储所有权。它可以被 memory、preparation、tools、
guardrail 与 channels 调用；调用方决定判断发生的时机，并对需要跨轮保留的结论负责。

```text
候选人消息 / 图片 / 工具回执
             │
             ▼
resolution：解析 + 证据裁决（纯函数）
             │
       ┌─────┴──────────┐
       ▼                ▼
TurnLedger / Prompt 视图  memory：short-term / long-term
       │                │
       └──── tools / Agent / guardrail 消费
```

收资表单是工具业务单据，不属于候选人记忆。它由 `src/tools/collection/` 独立编排和存储，
只在字段确权或预约成功时把适合跨回合保留的事实写回 memory。

## 2. 一条事实的生命周期

| 阶段     | 回答的问题                             | 当前居所                                                              |
| -------- | -------------------------------------- | --------------------------------------------------------------------- |
| 解析     | 文本、定位或工具回执表达了什么标准值？ | `src/resolution/{candidate,brand,geo,labor-form,job,signal}/`         |
| 裁决     | 来源是否可信、值是否等价、冲突采用谁？ | `src/resolution/evidence/`                                            |
| 轮内共享 | Prompt 与工具本轮应看到什么？          | preparation 的 `turnHints`、`prompt-memory-adjudicator`、`TurnLedger` |
| 存储     | 状态存哪、存多久、怎样并发更新？       | `src/memory/short-term/`、`src/memory/long-term/`                     |
| 使用     | 哪个动作可以消费哪种置信度？           | Prompt sections、tools、guardrail；高风险动作另过 action gate         |

同一字段允许不同 producer 有不同优先级，但不允许消费点另写一套字段语义。
Prompt 可把历史 profile 以“历史待确认”姿态展示，工具默认只消费满足动作门槛的值；
这是一条有意的信任差异，不是两套事实。

## 3. 当前代码地图

```text
src/resolution/
├── signal/          # 消息、引用、视觉、附件、定位等信号协议
├── candidate/       # 姓名、手机号、年龄、性别、学历等候选人字段解析
├── brand/           # 品牌目录、匹配、极性与状态裁决
├── geo/             # 地理归一、行政区与歧义处理
├── labor-form/      # 用工形式识别与展示归一
├── job/             # 岗位指代与焦点岗位消解
└── evidence/
    ├── claim.types.ts   # claim 与来源词汇
    ├── engine.ts        # 出处、强度、冲突三步裁决
    ├── policies.ts      # turn-hint 字段策略
    ├── admission.ts     # 入档准入
    ├── notary.ts        # 确定性公证
    ├── merge.ts         # rule 与 model 结果合并
    ├── profile.ts       # 有效档案视图
    └── producers/       # 各信号渠道的 claim producer

src/agent/generator/preparation/
├── preparation.service.ts
├── turn-ledger.ts
├── prompt-memory-adjudicator.ts
├── snapshot-enrichment.service.ts
└── tool-context.builder.ts

src/memory/
├── lifecycle.service.ts
├── fact-lines.formatter.ts
├── short-term/
│   ├── session-state.service.ts   # 对外薄门面
│   ├── facts.service.ts           # facts 与 hash 状态
│   ├── workbench.service.ts       # 岗位工作台与阶段指针
│   └── brand-state.service.ts     # facts.brand 唯一写者
└── long-term/
    ├── long-term.service.ts
    └── consolidation*.ts
```

## 4. Claim、裁决与存储信封

裁决层的通货是 `CandidateFactClaim`：字段、值、`set/exclude/clear` 操作、producer、
证据原文与时间。根来源词汇只在 `claim.types.ts` 定义：

```text
candidate_quote / rule / model / system / manual / archive
```

`engine.ts` 对同一批 claim 做确定性裁决，产出有效 profile 与逐项决策。
memory 中的 `SessionFactValue` / `UserProfileFactValue` 是落盘信封，只保存当前采用值及
`confidence / source / evidence / extractedAt`，不重新定义裁决规则。

当前实现不是“所有字段只走一个大入口”：

- 一般候选人字段由规则 producer、模型抽取、`admission` 与 `merge` 组合；
- 城市有专用的 `adjudicateCityClaims()`；
- 品牌复合状态由 `BrandStateService` 调用 `adjudicateBrandState()`；
- preparation 另用 `adjudicatePromptMemory()` 解决 session、历史 profile 与 turnHints 的
  **呈现冲突**，它不写存储。

这些路径共享 claim、来源与等价比较原语，但承担的时机和数据形状不同。文档和评审不得把
“共享底盘”误写成一个并不存在的统一 runtime service。

## 5. 回合内数据流

```text
PreparationService.prepare()
  1. 归一化 messages，选出本轮连续 user 消息
  2. produceTurnHints() 运行规则 producer
  3. MemoryService.onTurnStart() 读取两层记忆
  4. SnapshotEnrichmentService 只补本轮缺失线索，不落档
  5. adjudicatePromptMemory() 生成 memory 与 turnHints 的共享呈现视图
  6. createTurnLedger() 保存本轮可供工具消费/追加的判决
  7. ContextService 与 ToolRegistryService 分别消费共享视图和 ToolBuildContext

TurnFinalizer → MemoryLifecycleService.onTurnEnd()
  1. 只对最终采用的回合投影助手文本与岗位工作台
  2. 从候选人消息、视觉证据和 ledger 抽取/合并 session facts
  3. 更新品牌状态
  4. 刷新 idle consolidation job
```

被 Replay 丢弃的生成结果会 `discard()` 对应 `TurnFinalizer`，不会把未投递文本写成
“已经告诉过候选人”的事实。

## 6. 两层档案与置信度

### 6.1 Short-term

`factsv2:{corpId}:{userId}:{sessionId}` 保存 session facts 与岗位工作台，
`stage:{corpId}:{userId}:{sessionId}` 保存阶段指针。业务口径是 3 天，`factsv2:` 另加
12 小时安全余量，保证 delayed consolidation 先读取再过期。

事实通常使用带来源信封；`facts.brand` 直接保存 `PersistedBrandState`，由
`BrandStateService` 统一裁决和写入。

`preferences.brand_ids` 仍是独立的短期多品牌查询线索：Prompt 把它提示给模型，由模型决定
是否映射为 `duliday_job_list.brandIdList`；它不等同于单值 `facts.brand.currentBrand`，也不会
自动进入长期 profile。

`interview_info.gender_source` 只保留旧 session 的兼容读取。新 producer 已把来源写进
`gender` 自身信封并停止生产 sibling；最终删除条件见
[memory compatibility cleanup](../todo/memory-compatibility-cleanup.md)。

### 6.2 Long-term

长期关系档按 `(corpId, userId, botUserId)` 隔离：

- `semantic_profile`：9 个候选人身份字段；
- `semantic_job_intent`：最新求职意向快照；
- `episodic_session_summaries`：单层摘要数组，最多 20 段；
- `consolidation_watermarks`：独立幂等水位。

consolidation 从 session facts 提拔档案通常写 medium；booking 成功可写 high。
高置信值不能被低置信值覆盖。历史 profile 在新会话中属于 historical unconfirmed：
可以帮助检索和发起确认，但不能压过本轮或当前 session 的候选人自陈。

## 7. 消费与动作门槛

| 消费面                      | 可用信息                                        | 约束                                                   |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Prompt                      | session、历史 profile、turnHints 的共享裁决视图 | 同值只展示权威一处；异值标“历史待确认/待确认更新”      |
| job search                  | 档案与本轮 ledger                               | 可使用待确认线索做可逆检索，回复中不得伪装成已确认事实 |
| booking / invite / location | 工具上下文与 action-confidence gate             | 关键字段必须满足对应动作门槛；模型参数本身不是证据     |
| guardrail                   | 最终文本、工具调用及共享证据                    | 只做校验/修复，不回写第二套候选人档案                  |
| consolidation               | session facts 与消息原文                        | 分别更新 profile、intent、episode，并推进水位          |

动作门槛集中在 `src/tools/shared/action-confidence.ts` 及各工具的确定性 precheck。
动作拒绝是本轮执行结论；只有产生新的候选人事实时才需要回写 memory。

## 8. 与收资表单的边界

`BookingCollectionForm` 是“当前办理到哪里”的工具单据，key 含显式 bot 维：

```text
collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}
collection-form-current:{corpId}:{userId}:{botUserId}:{jobId}
```

表单负责字段契约、确认与提交状态；memory 负责跨回合候选人事实。两者可以互相读取经过
准入的值，但不能把表单实体塞入 `factsv2:`，也不能把长期 profile 当作已由候选人本轮确认。

## 9. 排障顺序

1. **模型看到错值**：查 preparation 的 memory snapshot、`turnHints` 与共享 Prompt 裁决视图。
2. **工具拿到错值**：查 `ToolBuildContext`、`TurnLedger` 与 action-confidence gate。
3. **下一轮记住了未说过的话**：查投递结局和 `TurnFinalizer` 是否只 settle 一次。
4. **短期事实被错误覆盖**：查 `SessionFactsService` 对应字段 producer、admission 与 merge。
5. **长期档案串 bot**：查 `botUserId` 是否为稳定 `wecomUserId`，以及三维关系行。
6. **收资重复或串人**：转查 tools 的 collection-form 实体 key 与 current pointer，不查 memory。

## 10. 相关文档

- [Memory 当前实现](../../src/memory/README.md)
- [记忆系统架构与数据流](./memory-architecture.md)
- [记忆与状态全局视图](./memory-and-state.md)
- [收资表单域架构](./collection-form-machine.md)
- [品牌解析架构](./brand-resolution.md)
- [地理解析架构](./geo-resolution.md)
- [Prompt 规则台账](../prompt-rule-ledger.md)
