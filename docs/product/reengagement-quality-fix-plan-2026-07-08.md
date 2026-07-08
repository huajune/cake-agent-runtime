# 复聊质量修复方案

基于《复聊质量调研报告》（2026-07-08，86/91 条 shadow 样本，严格可用率 45.35%）。
本方案按代码链路定位根因，给出分优先级的修复清单与真发放开闸门。

## 根因定位（问题 → 代码）

### R1. 调度重复（25 条，占问题总量一半）

同一条"问定位"的开场回复会**同时**挂两个复聊任务：

- 开场投递成功 → 排 `opening_no_reply`（15 分钟，anchorEventId=`opening`）
- 同一条回复命中 `asksForLocation()` 正则 → `anchor.service.ts:152` 再排 `address_missing`（30 分钟）

两个任务锚点不同、jobId 不同，Bull 幂等去重不了；到点后生成的内容在候选人感知上是同一句追问。样本里 25 组重复 100% 是 `opening_no_reply → address_missing` 这一对。

现有防线都拦不住：频控只数 `sent`（shadow 全不计入，真发时第一条已 sent、第二条 24h≤2 也放行）；`shouldStop` 只看候选人是否回话。**缺同 session 触达冷却与场景互斥。**

### R2. 时间标记泄漏（10 条）

`[消息发送时间：…]` 是短期记忆注入时给每条历史消息追加的后缀（`message-parser.util.ts:356`），模型看到满屏历史都带这个标记，主动回合就会模仿输出。

被动路径在投递前有 `ReplyNormalizer` 清洗（`reply-workflow.service.ts:777`）；**复聊主动回合完全没走这层**——shadow 记录、未来的真发投递拿的都是 `outcome.reply.text` 原文。

### R3. 内部评审/上下文泄漏（2 条 reply + 2 条被守卫拦下）

主动回合的"user 消息"只是占位符 `[系统主动跟进]`（`agent-runner.service.ts:54`），模型面对的最后输入几乎全是 system 注入（阶段策略/记忆事实/评审指令），有时把回合理解成"自检/汇报"而不是"生成一条要发给候选人的消息"：

- `✅ 对话已完成，符合信任建立阶段要求：…`（判 reply，守卫没拦）
- `好的，我这边已经发过问候和询问位置的消息了，等候选人回复…`（对系统说话）
- 原样吐出工具结果 JSON / `<system>` 块（`internal_output_leak` 拦下了，但说明模型会走到这一步）

`buildProactiveDirective`（`preparation.service.ts:542`）没有"你的输出会原样发给候选人、只输出消息正文"的硬约束；`internal_output_leak` 词库未覆盖 `✅ 对话已完成`/`符合…阶段要求` 这类评审形态。

### R4. 轻场景生成长岗位推荐（8 条 job dump + 6 条超长）

主动回合 `toolMode:'readonly'` 只物理移除**副作用**工具，`duliday_job_list`/`geocode` 等查询工具仍在。`opening_no_reply`/`address_missing` 的 `generationPolicy` 只是一句软提示，模型顺手查岗就输出三段式岗位列表——与"轻量追问定位"的场景目标背道而驰。

### R5. interview_reminder 全军覆没（3/3 skipped）

面试提醒到点通常在次日早上（样本全部 09:02-09:03 触发），此时短期记忆已过 2h TTL → 历史为空 → generator 抛错 → 主动回合按 `skipped` 静默收敛（`agent-runner.service.ts:691` 注释明确了这条路径）。**最高价值、事实最齐全的场景 100% 无产出。**
（待确认：查当天 09:02-09:03 `[runTurn] generation 失败` 日志核实空历史原因。）

## 修复清单

### P0-1 同 session 触达冷却 + 场景互斥（修 R1）

双层防线：

1. **fire 时通用冷却**（兜底，覆盖未来所有场景对）：
   - `TouchLedgerService` 新增 `reengagement:lastReply:${sessionId}` 键；processor 生成出 `reply` 结果后写入（shadow 同样写，便于用 shadow 数据验证互斥效果）。
   - processor 在 `shouldStop` 之后、生成之前检查：距上次 reply 触达 < **2h** → skip，track 原因 `session_touch_cooldown`。
   - 只有 `reply` 计入冷却；`skipped`/`guardrail_blocked` 不算触达。
2. **排程时定向取消**（精确，修已知场景对）：
   - `anchor.service.handleDeliveredReplyAnchors` 排 `address_missing` 时，先 `queue.getJob(`${sessionId}:opening_no_reply:opening`)` 把未触发的开场跟进 remove 掉——两者用户感知等价，保留更具体的 `address_missing`。

### P0-2 主动回合输出清洗（修 R2）

把 `ReplyNormalizer` 的系统标记清洗挂进主动回合出口（两个位置二选一，推荐前者）：

- 注册为 output transform（`guardrail/output/transforms/` 机制已就位，参照 `district-level-distance.transform.ts`），仅主动回合启用；
- 或最少在 `follow-up.processor.runProactiveTurn` 拿到 outcome 后对 `reply.text` 清洗。

清洗后为空或仍含 `[消息发送时间`/`[t:`/`[当前时间` → 按 block 处理不发。shadow 记录存清洗后文本（另存原文入 evidence 便于追溯）。

### P0-3 主动回合专属泄漏守卫（修 R3）

- `internal_output_leak` 词库补充：`✅ 对话已完成`、`符合.{0,8}阶段要求`、行首 `✅/❌` 清单体、`<system>`、`【工具调用结果】`。
- 新增 proactive-only 规则 `proactive_meta_reply`（block，P0）：命中"对系统说话"形态——`我(这边)?已经发过`、`等(候选人|对方)回复`、`我先把.{0,6}(整理|梳理)`、`跟进要求[:：]` 等元话语。主动回合宁可不发，不发劣质内容，恢复路径可靠（下个锚点还会再排），符合 block 准入。

### P0-4 interview_reminder 模板化生成（修 R5）

面试提醒的事实全部在排程冻结数据 + 工单里（面试时间/门店/证件要求），不需要 LLM 自由生成：

- processor 对 `interview_reminder` 走**确定性模板**（时间 + 门店 + 带证件提醒），跳过 runTurn；模板无泄漏、无编造风险，且天然解决空历史问题。
- 顺带修通用问题：generator 对主动回合空短期历史不再抛错，回退"会话事实 + 长期画像 + directive"生成（其余场景次日触发同样受益，如 09:56 的 opening_no_reply skipped）。

### P1-5 轻场景生成约束（修 R4）

- `opening_no_reply` / `address_missing` 主动回合工具集收缩为空（场景注册表加 `proactiveTools: 'none'` 之类的声明，processor 透传）；没有查询工具就不可能生成接地岗位列表，`ungrounded_job_recommendation` 守卫兜住漏网的编造。
- 场景注册表补 `maxReplyChars`（这两个场景 ≤ 80）与 `forbidJobList: true`；输出守卫按场景元数据检查，超限 block。

### P1-6 重写 proactive directive（修 R3 根源）

`buildProactiveDirective` 增加硬约束：

> 你的输出会**原样发给候选人**。只输出这一条消息的正文；不要输出分析、评审、计划、对系统的确认；不要提阶段/策略/工具/规则。若当前不适合跟进，直接输出空内容（或调用 skip_reply）。

### P2-7 场景 expectedAsk 校验（修 missing_expected_ask，8 条）

场景注册表声明期望话术要素（如 `address_missing` 必须含定位/位置/商圈类引导词），守卫按 observe 起步收集精确率，达标后升 revise。

### P2-8 人工标注集

硬规则自动评估之外，抽 50 条 shadow 做语气/自然度人工标注，形成回归基线。

## 真发放开闸门

保持 shadow（P0 决议不变），修复合入后按同口径重跑 shadow 评估：

| 指标 | 当前 | 放开门槛 |
|------|------|----------|
| 严格可用率（任务合理 × 内容可发） | 45.35% | ≥ 85% |
| 重复任务率 | 27% | < 3% |
| 泄漏类硬错误（timestamp/internal） | 12 条 | 0 |
| interview_reminder 产出率 | 0% | 100%（模板） |

另：真发前 `ChannelDeliveryPort` 尚未绑定实现（全量 `no_delivery_port`）。实现投递端口时必须复用被动路径的 normalize + 分段 + 拟人化投递管道，不要另起裸投递链路——否则 P0-2 之外又多一个绕过清洗的出口。

## 验证方式

1. 单测：冷却/互斥（processor + anchor.service）、清洗 transform、守卫新规则、interview_reminder 模板。
2. shadow 回放：修复上线后跑 2-3 天 shadow，用问题清单同一套硬规则脚本复测。
3. 观测：`reengagement_touch_records` 新增 skip 原因 `session_touch_cooldown` 可在 /reengagement 页面直接看到互斥生效量。
