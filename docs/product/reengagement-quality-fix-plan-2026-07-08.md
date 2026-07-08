# 复聊质量修复方案

基于《复聊质量调研报告》（2026-07-08，86/91 条 shadow 样本，严格可用率 45.35%）。
按代码链路定位根因，核心结论：**调度层缺互斥（独立问题），生成层四类病灶是"复聊复用主流程 generator"这一个架构决定的结构性后果，方案是让复聊生成走独立链路，而不是继续给主流程打补丁。**

## 根因定位（问题 → 代码）

### R1. 调度重复（25 条，占问题总量一半）

同一条"问定位"的开场回复会**同时**挂两个复聊任务：

- 开场投递成功 → 排 `opening_no_reply`（15 分钟，anchorEventId=`opening`）
- 同一条回复命中 `asksForLocation()` 正则 → anchor.service 再排 `address_missing`（30 分钟）

两个任务锚点不同、jobId 不同，Bull 幂等去重不了；到点后生成的内容在候选人感知上是同一句追问。样本里 25 组重复 100% 是 `opening_no_reply → address_missing` 这一对。

现有防线都拦不住：频控只数 `sent`（shadow 全不计入，真发时第一条已 sent、第二条 24h≤2 也放行）；`shouldStop` 只看候选人是否回话。**缺同 session 触达冷却与场景互斥。**

### R2. 时间标记泄漏（10 条）——出口清洗已由 v8.0.0 覆盖，残留一个正则逃逸形态

`[消息发送时间：…]` 是短期记忆注入给历史消息加的后缀，模型看满屏历史都带标记就会模仿输出。

PR #457（7-07 17:14 合并，17:40 随 v8.0.0 发布）已把清洗重构为 `guardrail/output/outbound-reply-sanitizer.ts`，在 runner 出口 `classifyReviewedOutcome`（turn-outcome.ts）对所有渠道统一清洗，**主动回合已覆盖**。样本时间线吻合：10 条泄漏里 9 条在 v8 部署前（7-07 14:47~17:46）；唯一一条部署后的（7-08 10:41，清单 #48）收尾是全角 `】`，`TIME_MARKER_PATTERN` 要求 ASCII `]` 闭合，匹配不上逃逸了。

但这是出口"追着擦"：只要复聊上下文里还喂进带标记的历史，源头就一直在产出（见架构判断）。

### R3. 内部评审/元话语泄漏（2 条 reply + 2 条被守卫拦下）

主动回合的"user 消息"只是占位符 `[系统主动跟进]`，模型面对的最后输入几乎全是 system 注入（阶段策略/记忆事实/评审指令），有时把回合理解成"向系统汇报"而不是"生成一条发给候选人的消息"：

- `✅ 对话已完成，符合信任建立阶段要求：…`（判 reply，守卫没拦）
- `好的，我这边已经发过问候和询问位置的消息了，等候选人回复…`（对系统说话）
- 原样吐出工具结果 JSON / `<system>` 块（`internal_output_leak` 拦下了，但说明模型会走到这一步）

### R4. 轻场景生成长岗位推荐（8 条 job dump + 6 条超长）

主动回合 `toolMode:'readonly'` 只物理移除**副作用**工具，`duliday_job_list`/`geocode` 等查询工具仍在。`opening_no_reply`/`address_missing` 的 `generationPolicy` 只是一句软提示，模型顺手查岗就输出三段式岗位列表——与"轻量追问定位"的场景目标背道而驰。

### R5. interview_reminder 全军覆没（3/3 skipped）

面试提醒到点通常在次日早上（样本全部 09:02-09:03 触发），此时短期记忆已过 2h TTL → 历史为空 → generator 抛错 → 主动回合按 `skipped` 静默收敛（agent-runner.service 注释明确了这条路径）。**最高价值、事实最齐全的场景 100% 无产出。**

## 架构判断：R2-R5 是同一个架构决定的结构性后果

复聊当前复用主流程 `runner.runTurn`：完整咨询 system prompt + 阶段策略注入 + 带时间标记的短期历史窗口 + readonly 工具集，配一个 `[系统主动跟进]` 占位符。但这是两个任务：

- **主流程**：回应候选人的消息——需要阶段机器、工具、完整历史；
- **复聊**：从已知状态合成一句轻触达——没有新输入，事实全在会话状态/排程冻结数据里，输出是一条短消息。

把任务 B 塞进任务 A 的机器，病灶一一对应：模型对着 system 注入"汇报"（R3）、顺手查岗倾倒列表（R4）、模仿历史里的时间标记（R2 源头）、空历史直接抛错（R5）。继续在守卫词库/正则/directive 上打补丁，是给错误的架构修修补补。

**决定：复聊生成走独立链路，与主流程 generator 解耦。**

## 修复清单

### P0-1 同 session 触达冷却 + 场景互斥（修 R1，调度层，与生成链路无关）

双层防线：

1. **fire 时通用冷却**（兜底，覆盖未来所有场景对）：
   - `TouchLedgerService` 新增 `reengagement:lastTouch:${sessionId}` 键；只在 `markSent()` 确认真发成功时，与 slot=sent / sentList 同一 Redis 事务写入。
   - processor 在 `shouldStop` 之后、生成之前检查：距上次触达 < **2h** → skip，track 原因 `session_touch_cooldown`。
   - shadow / 投递失败 / unknown / skip / 校验不通过均不计入冷却，避免影子压制真发、失败投递压制后续、Bull 重试自杀。
   - 时间锚定场景（如 `interview_reminder` 面试前 1h）通过 scenario registry 声明 `sessionCooldownExempt`，不受跨场景冷却管辖。
2. **排程时定向取消**（精确，修已知场景对）：
   - registry 声明 `address_missing.supersedes = ['opening_no_reply']`，`opening_no_reply.canonicalAnchorEventId = 'opening'`。
   - anchor.service 只表达"当前场景要执行 supersedes"，Bull jobId 构造与删除统一归 scheduler，避免把 jobId 字符串格式耦合进 anchor。

### P0-2 复聊独立生成链路 ProactiveComposer（修 R2 源头 + R3 + R4 + R5）

新建 `src/agent/reengagement/proactive-composer.service.ts`，processor 不再调 `runner.runTurn`。分两档：

**模板档**（事实齐全场景，不走 LLM）：

- `interview_reminder`：面试时间/门店/证件要求全在排程冻结数据 + 工单里，确定性模板拼装。无泄漏、无编造、不受空历史影响，100% 产出。
- `booking_incomplete`：缺失字段清单来自 `collectedFields`，模板可覆盖。

**轻 LLM 档**（`opening_no_reply` / `address_missing` / `store_presented_no_reply` 等话术型场景）：

- 走 `completion.service` 一次性调用，**无工具、无多步**；
- 上下文按需喂：场景目标 + 会话事实摘要 + 最近 3-5 条**清洗后**的对话原文（剥掉所有系统标记）；
- 上下文必须从 memory 层的轻量 recall 读取，复用 Redis 短期窗口和 `formatExtractionFactLines` 事实渲染，不能由 composer 直接读 `chat_messages` 或自建 fact-lines 方言；
- 复聊专用短 prompt：一句人设 + 场景目标 + 硬约束（只输出一条 ≤80 字的消息正文，会原样发给候选人；不得出现岗位名/薪资/班次；无法生成合适跟进就输出 `SKIP`）；
- 空历史不是错误：摘要为空按冷启动口径生成，不再 skip。

**结构性收益**：上下文里根本不存在时间标记、阶段策略、工具——R2/R3/R4 的物料被釜底抽薪；单次触达从主流程的数万 token 降到千级，成本与延迟同步下降。

**出口校验**（轻量，替代整套消费级守卫）：

- `OutboundReplySanitizer.sanitize`（静态类直接调用）；
- 三条硬校验：长度 ≤ 场景阈值 / 调用共享 `detectOutputLeak` 泄漏原语 / 含场景期望要素（如 `address_missing` 必须含定位引导词，顺带修 missing_expected_ask 8 条）；
- 品牌口径走共享 `sanitizeBrandName`；完成时态假承诺走 `false-promises` 共享 helper，不在 composer 手抄规则子集；
- 任一不过 → 不发并 track 原因；下个锚点还会再来，恢复路径可靠。

**processor 侧保留不变**：shouldStop、到点海绵核验、频控、touch ledger、tracking 全在 processor，不受生成链路切换影响。

**真发历史写入**：真发投递成功后直接 `ChatSessionService.saveMessage()`，一次完成 DB + Redis 短期记忆镜像。复聊没有新候选人输入，不跑完整 turn-end 生命周期。

**投递身份**：job payload 冻结稳定身份（候选人昵称、botImId、imContactId/externalUserId、apiType）。投递 token 到点现取——⚠️ 要的是托管平台（Stride）发消息凭证，不是海绵 API token：企业级 API 统一用静态 `STRIDE_ENTERPRISE_TOKEN`（与 group-task 通知同源，不受回调 token 过期/bot 重登录影响），冻结 token 仅兜底；小组级 API 的 token 是回调下发的组级凭证，只能用排程时冻结值。

### P1-3 outbound-reply-sanitizer 正则硬化（主流程也受益）

`TIME_MARKER_PATTERN` 容忍全角 `】` 收尾与行尾断裂标记（清单 #48 的逃逸形态）；清洗后仅剩空串/符号残渣（`✅`、`【`）时按不可发处理。

### P1-4 internal_output_leak 词库补充（主流程防线）

`✅ 对话已完成`、`符合.{0,8}阶段要求`、行首 `✅/❌` 清单体、`【工具调用结果】`——主流程同样可能出现这些形态，词库补上；复聊侧已由独立链路结构性规避，不依赖此项。

### P2-5 复测口径

不做独立人工标注集。后续质量复测直接查 SQL 看完整复聊数据，按硬规则 + 业务侧观察判断是否继续收紧。

## 数据口径提醒

调研窗口（7-07 13:58 起）横跨 v8.0.0 部署点（7-07 17:40 发布），timestamp_leak 的 10 条里 9 条是部署前旧代码产生的。重跑评估应以 **v8 部署时间为起点重新切片**，否则高估当前泄漏率；反过来，重复任务/岗位倾倒/interview_reminder 全跳过在部署后依旧发生，是当前真实问题。

## 真发放开闸门

保持 shadow（P0 决议不变），修复合入后按同口径重跑 shadow 评估：

| 指标                                      | 当前                             | 放开门槛     |
| ----------------------------------------- | -------------------------------- | ------------ |
| 严格可用率（任务合理 × 内容可发）         | 45.35%（混入部署前样本，偏低估） | ≥ 85%        |
| 重复任务率                                | 27%                              | < 3%         |
| 泄漏类硬错误（timestamp/internal/元话语） | 持续发生                         | 0            |
| interview_reminder 产出率                 | 0%                               | 100%（模板） |

另：真发投递已通过 `WecomReengagementDeliveryService` 薄适配 `MessageDeliveryService`，复用被动路径分段 + 拟人化投递管道，不另起裸投递链路。

## 验证方式

1. 单测：冷却/互斥（processor + anchor.service）、composer 两档生成与出口校验、sanitizer 正则硬化、interview_reminder 模板。
2. 编译：`pnpm exec tsc --noEmit`。
3. 关键回归：`pnpm exec jest tests/agent/guardrail/output/false-promises.rule.spec.ts tests/channels/wecom/message/application/reply-workflow.service.spec.ts tests/channels/wecom/message/services/delivery.service.spec.ts tests/channels/wecom/message/services/pipeline.service.spec.ts tests/agent/reengagement --runInBand`。
4. 线上观测：直接查 SQL 看完整复聊数据；重点看 `session_touch_cooldown`、`composer_validation_failed`、`composer_false_promise`、`delivery_skipped:*`、`unknown`。
