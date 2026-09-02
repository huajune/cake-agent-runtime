# 记忆与状态全局视图

> 这是定位“某个状态在哪里、由谁读写”的排障入口。记忆细节见
> [记忆系统架构与数据流](./memory-architecture.md)，当前实现权威见
> [`src/memory/README.md`](../../src/memory/README.md)。

## 1. 一张图看全局

```text
候选人 × bot 聊天关系（sessionId = chatId）
│
├─ 原始消息
│   ├─ Supabase chat_messages                         长期事实源
│   └─ Redis memory:short_term:chat:{chatId}          3d 热缓存
│        └─ 每轮投影为 shortTerm.messageWindow        查询窗 7d
│
├─ Short-term 会话状态
│   ├─ Redis factsv2:{corpId}:{userId}:{sessionId}    3d + 12h
│   │    ├─ facts（含 facts.brand）
│   │    └─ workbench（岗位池、展示、焦点、查询签名）
│   └─ Redis stage:{corpId}:{userId}:{sessionId}      3d
│        └─ 当前阶段指针
│
├─ 当前轮进程内状态
│   ├─ turnHints / Snapshot enrichment
│   ├─ Prompt 共享裁决视图
│   └─ TurnLedger / ToolBuildContext
│        └─ 回合结束后选择性写入 short-term
│
├─ Long-term 候选人 × bot 关系档
│   ├─ Redis long-term:{corpId}:{userId}:{botUserId}  2h 缓存
│   └─ Supabase agent_long_term_memories              持久
│        ├─ semantic_profile
│        ├─ semantic_job_intent
│        ├─ episodic_session_summaries（最多 20 段）
│        └─ consolidation_watermarks（独立工作水位）
│
├─ 预约兼容业务指针（不属于三维长期记忆）
│   └─ Supabase agent_long_term_memories.active_booking
│        └─ (corpId, userId)，bot_user_id IS NULL
│
└─ Tools 业务单据（不属于 memory）
    ├─ collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}
    └─ collection-form-current:{corpId}:{userId}:{botUserId}:{jobId}
         └─ 整实体表单 + 当前办理人定位指针，3d
```

## 2. 维度口径

| 标识           | 含义                                          | 使用处                                          |
| -------------- | --------------------------------------------- | ----------------------------------------------- |
| `corpId`       | 企业租户                                      | 所有候选人状态的第一隔离维                      |
| `userId`       | 候选人身份                                    | short-term、long-term、工具单据                 |
| `sessionId`    | 当前 `chatId`，代表候选人 × bot 聊天关系      | 消息窗口、`factsv2:`、`stage:`、水位 bySession  |
| `botUserId`    | 托管账号稳定 `wecomUserId`                    | long-term 三维关系、collection form 显式 bot 维 |
| `imBotId`      | 可能轮换的渠道账号标识                        | 渠道调用和血缘排障，不作长期主键                |
| `candidateRef` | 收资表单办理人引用，可能由 session 升为手机号 | collection form 实体 key                        |
| `jobId`        | 岗位标识                                      | 收资表单与岗位工具                              |

`factsv2:` 与 `stage:` 没有单独写出 `botUserId`，因为 `sessionId = chatId` 已经携带
候选人 × bot 的聊天隔离。long-term 与 collection form 不能只靠聊天 key 定位，因而显式包含
稳定 `botUserId`。

## 3. Redis key 清单

| Key 形态                                                               | 类型  | 内容                                 | TTL                    | 所有者                                            |
| ---------------------------------------------------------------------- | ----- | ------------------------------------ | ---------------------- | ------------------------------------------------- |
| `memory:short_term:chat:{chatId}`                                      | list  | 带 provenance 的原始消息热缓存       | 3 天                   | `MessageWindowService`                            |
| `factsv2:{corpId}:{userId}:{sessionId}`                                | hash  | facts + workbench                    | 3 天 + 12 小时安全余量 | `SessionFactsService` / `SessionWorkbenchService` |
| `stage:{corpId}:{userId}:{sessionId}`                                  | value | `{ currentStage }`                   | 3 天                   | `SessionWorkbenchService`                         |
| `long-term:{corpId}:{userId}:{botUserId}`                              | value | 当前候选人 × bot 的长期关系行缓存    | 2 小时                 | `LongTermService`                                 |
| `collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}` | value | 完整 `BookingCollectionForm` 快照    | 3 天                   | `CollectionFormStore`（tools）                    |
| `collection-form-current:{corpId}:{userId}:{botUserId}:{jobId}`        | value | 当前办理人的 `candidateRef` 定位指针 | 3 天                   | `CollectionFormStore`（tools）                    |

`factsv2:` 使用 hash 字段级原子写，但 Redis 不支持 hash field TTL，所以同一 key 内的 facts 与
workbench 一起享有 12 小时安全余量。`stage:` 和 collection form 严格按 3 天过期。

消息热缓存也按 3 天过期，但它不是 7 天回看窗口的权威来源。缓存 miss 时，
`MessageWindowService` 仍从 `chat_messages` 查询最近 7 天并原子回填；命中时同样只取 7 天内的条目。
list 只由回填创建：`ChatSessionService` 的写路径用 `RPUSHX` 追加、key 不存在即跳过，
保证任何非空 list 都是「完整快照 + 后续追加」，而不是作废后半路建出的残缺片段。

collection form 已完整迁入 `src/tools/collection/`：TTL 常量、key builder、整实体写入和
定位指针都由工具域维护，不依赖 `MemoryConfig`，也不再写进 `factsv2:`。

## 4. Supabase 持久状态

| 表 / 列                                               | 主维度                                               | 作用                       | 读取方式                                               |
| ----------------------------------------------------- | ---------------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| `chat_messages`                                       | `chatId` + message                                   | 原始聊天事实源             | short-term 每轮查询最近 7 天；consolidation 按水位扫描 |
| `agent_long_term_memories.semantic_profile`           | `(corp_id, user_id, bot_user_id)`                    | 9 字段候选人身份档案       | 每轮默认召回                                           |
| `agent_long_term_memories.semantic_job_intent`        | 同上                                                 | 最新求职意向快照           | 每轮默认召回                                           |
| `agent_long_term_memories.episodic_session_summaries` | 同上                                                 | 咨询段摘要数组，最多 20 段 | 仅 `recall_history` 显式读取                           |
| `agent_long_term_memories.consolidation_watermarks`   | 同上，内部再按 `sessionId`                           | 已处理消息边界             | 只供 consolidation 幂等控制                            |
| `agent_long_term_memories.active_booking`             | `(corp_id, user_id)` 的 `bot_user_id IS NULL` 兼容行 | 当前工单定位指针           | preparation 结合业务系统实时状态生成预约上下文         |
| `message_processing_records.post_processing_status`   | message / processing record                          | 回合末各写入步骤状态       | 排障与告警                                             |

`consolidation_watermarks` 与咨询摘要是独立列：摘要因 20 段上限淘汰旧条目时，工作水位仍保留，
不会导致旧消息被重新处理。

`active_booking` 是暂存于同表无 bot 兼容行的业务指针，不进入 `MemoryRecallContext` 的
semantic 契约，也不属于三维长期关系档；preparation 单独读取它并结合工单系统实时状态生成
Prompt 上下文。收资表单仍由 tools 独立持有。

## 5. 进程内回合状态

以下对象有意不直接对应 Redis key：

| 状态                | 生产者                                        | 消费者                                 | 是否持久化                     |
| ------------------- | --------------------------------------------- | -------------------------------------- | ------------------------------ |
| `turnHints`         | preparation 的规则 producer                   | 共享裁决、Prompt、工具、回合末事实提取 | 不直接持久化；采信后并入 facts |
| enriched snapshot   | `SnapshotEnrichmentService`                   | 共享裁决与当轮消费                     | 否                             |
| Prompt 共享裁决视图 | `adjudicatePromptMemory()`                    | `memory`、`turn-hints` sections        | 否                             |
| `TurnLedger`        | preparation 创建，岗位/地理/图片等工具追加    | runner、`onTurnEnd()`                  | 只持久化被采用的结果           |
| `ToolBuildContext`  | `buildToolContext()`                          | 本轮工具集合                           | 否                             |
| `promptBlocks`      | `ContextService.compose()` + preparation 尾块 | AI SDK、测试与进程内调试               | 当前不单独写入 MPR，不是记忆源 |

`SnapshotEnrichmentService` 是备料，不是另一条档案写路径。它可以让当轮 Prompt 和工具获得
补齐线索，但不会越过候选人档案域的置信度与来源纪律。

## 6. 谁读、谁写

| 数据               | 回合开始读                | 回合中消费                                   | 回合结束写                                      |
| ------------------ | ------------------------- | -------------------------------------------- | ----------------------------------------------- |
| 消息窗口           | `MessageWindowService`    | `normalizedMessages`、事实提取输入、地理锚点 | 入站消息链写 `chat_messages`；memory 只维护缓存 |
| session facts      | `SessionStateService`     | Prompt、工具、共享裁决                       | `extract_facts`、工具确权、品牌 reducer         |
| workbench          | `SessionStateService`     | 岗位 provenance、防复读、焦点岗位            | 岗位池、查询签名、助手投影、失效岗位剔除        |
| stage              | `SessionWorkbenchService` | 当前阶段策略、`advance_stage`                | `advance_stage` 校验后立即覆盖写                |
| profile / intent   | `LongTermService`         | Prompt；profile high 供工具                  | consolidation；profile 另有报名 high 写入       |
| episodic summaries | 默认不读                  | `recall_history` 按需                        | 闲置 3 天后的 consolidation                     |
| watermarks         | consolidation 任务读      | 不进入 Prompt / 工具                         | 与新增摘要原子推进                              |
| collection form    | collection tools          | 预检、报名、修改流程                         | collection tools 整实体覆盖写                   |

`invitedGroups` 随 session facts 召回，但写入时机与一般回合收尾不同：
`GroupInviteService` 只有在确认候选人已在群中或邀请成功后才即时写入，避免把未发生动作记成事实。

## 7. 排障速查

| 症状                      | 先查                                         | 再查                                                         |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| 7 天内历史消息缺失        | `memory:short_term:chat:{chatId}` provenance | `chat_messages` 时间边界、120 条 / 24,000 字符裁剪           |
| 候选人事实或岗位状态丢失  | `factsv2:` 对应 hash 字段                    | `post_processing_status` 的具体步骤与 TTL                    |
| 当前阶段不对              | 独立 `stage:` key                            | `advance_stage` ledger、阶段过期后的老用户兜底               |
| 品牌反复或串值            | `facts.brand`                                | `apply_brand_state` trace、三条品牌解析输入                  |
| 档案存在但当前账号读不到  | 三维 long-term cache key                     | Supabase `bot_user_id`、调用方是否误传 `imBotId`             |
| profile 旧值不被覆盖      | 字段 confidence                              | medium 不覆盖 high 的 SQL rank 守卫                          |
| 意向清除失败              | 本段快照是否生成显式空值                     | consolidation 的整组覆盖写入                                 |
| 摘要未生成或重复          | delayed job、DB 最新消息时间                 | `consolidation_watermarks.bySession`、Bull 重试与失败事件    |
| 收资进度丢失              | `collection-form:` 实体 key                  | `collection-form-current:` 指针及 tools 写路径               |
| Prompt 与工具看到的值不同 | `promptBlocks` 与 ToolBuildContext           | Prompt 可展示待确认值，工具默认只采 high，这是刻意的信任差异 |

## 8. 边界不变量

- short-term 由 7 天消息窗口与 3 天会话状态组成；长期是候选人 × bot 的持久关系档。
- `turnHints`、快照补料、共享裁决和 ledger 都是回合内状态，不升级为存储层。
- `facts.brand` 位于 session facts 内，品牌 reducer 是唯一持久写者。
- episodic summaries 是最多 20 段的单层数组，新增后不再由 LLM 改写。
- consolidation 水位单独存放，只控制处理边界。
- collection form 属于 tools，具有显式 bot 维、独立 TTL 与事故恢复责任。

## 相关文档

- [Memory 当前实现权威](../../src/memory/README.md)
- [记忆系统架构与数据流](./memory-architecture.md)
- [候选人档案域架构](./candidate-profile-domain.md)
- [Agent 运行时架构](./agent-runtime-architecture.md)
