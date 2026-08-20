# 二次主动回复流水线（reengagement / 复聊）

**最后更新**：2026-08-20
**代码居所**：`src/agent/reengagement/`

> 复聊是**独立链路**：系统决定何时主动找候选人，话术由 LLM 实时生成。
> 产品侧的场景定义、内容规范与验收口径见 [复聊功能产品说明](../product/reengagement.md)。

---

## 1. 定性与链路位置

**场景驱动的 LLM 智能复聊**——系统决定何时主动发起，话术不固化模板。

⚠️ **复聊不复用主链路 generator**：早期设计曾计划复用 `runner.runTurn`，现行实现是专用的 `ReengagementAgent`（`reengagement.agent.ts`，`LlmExecutorService` + zod schema 的一次性 completion 调用）。因此主链路的 guardrail / 记忆 / 观测**不是自动继承的**，复聊侧的等价保障各自显式实现。

```
锚点事件（turn-end / ops-events 写入点）
    │  computeFireAt(scenario, anchorAt) → 绝对时间戳
    │
    ├─ OnboardingSweepCron（每 15 分钟扫近 48h interview.passed）
    ▼
Bull delayed job（jobId 幂等：sessionId:scenarioCode:anchorEventId）
    │
    ▼  到点
FollowUpTaskProcessor
    ├─ ① 停止条件 shouldStop（读复聊会话快照，调 LLM 之前）
    ├─ ② 频控：24h 内 sent 状态 ≤ 2
    ├─ ③ 9–21 窗口二次确认（防 delay 漂移）→ 越界则 reschedule
    ├─ ④ ReengagementAgent.compose()  ← 不开放工具
    ├─ ⑤ 投递 + 触达底账 outbox 状态机
    └─ ⑥ 推店升档：仅 markSent 成功后确定性调用 GroupInviteService
              │
              ▼
        reengagement_touch_records（全生命周期落库）
```

---

## 2. 触发：事件锚点为主，cron sweep 为辅

**不轮询全量会话**，而是在锚点事件发生时排一个 Bull delayed job：

```ts
const fireAt = computeFireAt(scenario, anchorAt); // 绝对时间戳，已对齐 9–21 窗口
await reengagementQueue.add(
  'follow-up',
  { sessionRef, scenarioCode, anchorEventId, anchorAt },
  {
    jobId: `${sessionRef.sessionId}:${scenarioCode}:${anchorEventId}`, // 同锚点不重复排程
    delay: Math.max(0, fireAt - Date.now()), // ⚠️ Bull delay = 相对 ms，不是绝对 fireAt
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
  },
);
```

唯一的短窗 sweep 是入职跟进：`OnboardingSweepCronService` 每 15 分钟查询近 48 小时的 `ops_events(interview.passed)`，按事件的 `occurred_at` 排 `post_interview_onboarding` D+3 任务。稳定锚点 `wo{workOrderId}:pass` 使同一事件跨轮扫描只产生一个 Bull job；`READ_ONLY_PREVIEW=true` 时不扫描、不排程。该 sweep 只消费已存在的业务事件，不轮询全量会话。

**窗口对齐**：先算 `anchorAt + resolveDelay(...)`，落在 <9:00 推到当日 9:00、>21:00 推到次日 9:00（时区 `Asia/Shanghai`，与 group-task cron 一致）。fire 时再 `inWindow(now)` 二次确认。

---

## 3. 场景注册表

| code                       | 锚点事件                               | 延迟                    | 目标                                                        |
| -------------------------- | -------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `opening_no_reply`         | `agent.opening_sent`                   | +15min                  | 轻量确认是否还在看机会，并继续询问所在位置                  |
| `address_missing`          | 最终回复已投递且请求位置/地址          | +30min                  | 提醒发定位以便就近推荐                                      |
| `store_presented_no_reply` | 最终回复已投递且展示岗位               | +30min                  | 承接该岗位询问考虑得如何                                    |
| `booking_incomplete`       | 最终采纳回合 precheck `collect_fields` | +30min                  | 提醒补齐剩余资料                                            |
| `interview_reminder`       | `booking.succeeded`                    | 依 `interviewTime` 计算 | 按面试形式提醒；**AI 面试提醒在线完成，线下面试才提醒到店** |
| `post_interview_followup`  | `booking.succeeded`                    | 依 `interviewTime` 计算 | 面试后回访                                                  |
| `post_interview_onboarding` | `interview.passed`                    | +3d                     | 面试后回访家族的入职跟进；未入职时确定性转人工              |
| `new_job_for_waiting`      | 岗位上线事件（**外部**）               | 事件驱动                | 暂无岗位的候选人有新岗位时主动告知                          |

⚠️ `new_job_for_waiting` 的外部事件源尚未接入——该场景保留在 registry 中，事件源就绪后只需调用 scheduler。

`interview_reminder` 在二期拥有两个同 code 档位：默认到场档仍使用原任务身份；报名日至面试日相差至少 3 个上海日历天时，额外排面试前 2 天确认档，任务锚点追加 `:d2` 后缀并在 payload 标记 `touchVariant=d2_confirm`。变体的延迟与灰度分别读取既有 map 的 `interview_reminder:d2` 子键，缺省延迟 2880 分钟、缺省灰度关闭，且不回退 `interview_reminder` 主场景开关。改期时两个档位按实时工单独立重排，确认档重新核验报名间隔。

`store_presented_no_reply` 不新增场景 code。会话状态用 `storePresentationRounds` 单独累计推店轮次；第 2 轮起任务 payload 标记 `escalateToGroupInvite=true`。独立灰度子键 `store_presented_no_reply:invite` 缺省关闭且不回退主场景开关，关闭时在生成前移除有效升档标记，退化为普通推店未回文案。

`post_interview_onboarding` 归入面试后回访家族，但因锚点不同使用独立 registry code。processor 对 `interview.passed` 走专属状态分派，不进入预约有效性检查或面试时间校准：`面试成功` 才生成触达，`上岗成功` 静默停止，`上岗失败/已离职` 直接落人工介入底账并告警，其余状态按工单回退停止。真实消息 `markSent` 后才排 +48h `wo{id}:onboarding_check` 复核；复核任务只查工单并告警，不经过触达闸、不发送消息。人工介入调用 `HandoffRecorderService + GeneralHandoffNotifierService`，不调用会暂停托管的 `InterventionService`。

---

## 4. 停止条件

### 4.1 基础停止条件（调 LLM 之前，读复聊会话快照）

- `state.terminal ∈ {booked, handed_off, rejected, onboarded}` → 停；
- 候选人明确拒绝 → 停；
- **锚点后候选人已回话** → 场景已不成立 → 停；
- 场景特定 `stopUnless(state)`：`address_missing` 但 location 已有、`booking_incomplete` 但字段已齐 → 停。

### 4.2 「已回话」的水位判定（防被 timeout 消息误停）

⚠️ 直接比较 `lastCandidateMessageAt > anchorAt` 会被**静默丢弃的消息**骗过——候选人回了话但那一轮 timeout 没人处理，复聊却认为「已回话」而停止，候选人从此再无人跟进。

现行判据用**处理水位 + 在途宽限**：

```
候选人回话无人搭理 ⟺ 入站时间 > lastProcessedCandidateMessageAt 水位 且 已过在途宽限
```

- **只有回合成功收尾**（正常回复或有意沉默）才推进 `lastProcessedCandidateMessageAt` 水位；
- **在途宽限**覆盖 debounce 合并窗口——候选人刚回话时消息可能还在合并中，超过宽限仍未推进水位，才认定回话被静默丢弃。

### 4.3 带外工单核验（`oob-work-order.ts`）

真人招募经理的带外操作（手工约面、拒绝面试）或候选人已面试的事实**只存在于海绵工单里**。`pre_booking` 类场景若只认 Agent 自建的 terminal 态，会对带外工单全盲——已被经理拒面 / 已面试过的候选人仍被持续追问。

该模块把同一 source of truth（海绵工单）接到 `pre_booking` 侧；`post_booking` 场景另有到点核验 `checkBookingInvalidAtFire`。

> **面试时间口径**：工单 `interviewTime` 只是窗口起点；**聊天里明确约定的时间优先于工单**。拦截即终局，不补发。

---

## 5. 投递与幂等

### 5.1 主动回合禁用副作用工具

复聊 Agent 只负责提醒 / 答疑，**不替候选人报名或自主拉群**。现行 `ReengagementAgent` 不开放任何工具——这是物理约束，不靠 prompt。推店未回升档的拉群属于 processor 投递后的确定性编排，不改变 Agent 的工具边界。

### 5.2 outbox 状态机

```
reserved → delivery_attempted → sent / failed / unknown
```

| 状态                 | 语义与处置                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `reserved`           | 已占位，可重试                                                                                              |
| `delivery_attempted` | **「外部平台可能已经发出」区间——不得盲目重投**；必须依赖渠道侧幂等（`idempotencyKey`）或走补偿查询/人工核对 |
| `sent`               | 投递成功；`reserve()` 命中 `sent` 直接跳过                                                                  |
| `unknown`            | `markSent` 落库失败时置此状态并**告警**，不可简单置 `failed` 重投                                           |

这样同时杜绝「写了底账却没发出」和「发出了但落库失败导致重复发」。

**频控 24h ≤ 2** 按 `sessionId` 统计近 24h 底账中 **`sent` 状态**的条数——`reserved`/`failed`/`unknown` 不计，否则投递失败重投会被误算成多次触达。

### 5.3 shadow 模式

`shadow = !this.delivery || runtime.reengagementShadow`——**无投递端口绑定时强制 shadow**，否则读运行时配置（与总开关同一次读取）。

⚠️ 「不 deliver」≠「无副作用」：主动回合已物理禁用工具，shadow 只是再叠加「不投递」。**两者缺一不可**。

### 5.4 可复用的确定性拉群边界

`GroupInviteService` 统一封装选群、成员实时预检、容量刷新、企微邀请及补拉 bot 重试、`invitedGroups` 记忆和 `group.invited` 运营底账。主链 `invite_to_group` 工具仍自己持有 `bookingSucceeded` / city / timing 回合意图闸，只把通过闸门的请求交给该 service。

这是 processor / cron 可以调用的业务服务，**不是给 `ReengagementAgent` 开放的工具**；复聊 Agent 仍保持物理无工具。

推店升档的调用点固定在 outbox `markSent` 成功之后：processor 读取会话事实中的意向城市，以主动回合 `batchId` 作为 `turnKey` 调用 service。成功（含 `alreadyInGroup`）追加 `group_invite_result` 触达事件并清理本会话其余 `pre_booking` 在途任务；失败记录 `invite_failed:{reason}`，缺城市记录 `invite_skipped:no_city`，两者均不重试、不回滚已发送文案。由于调用语句位于投递成功分支内部，shadow、非 reply、明确投递失败和 unknown 分支物理不可达。

---

## 6. 可观测性

全生命周期落 `reengagement_touch_records`（`biz/monitoring`），Dashboard 的 `/reengagement` 页面默认候选人视角。

- 命中场景、停止原因、生成话术、投递状态全程留痕；
- `unknown` 状态是最需关注的档——它意味着「可能已发出但账没记上」；
- 数据清理：NULL `generated_text`（>N 天）+ DELETE 整行（>M 天），见 `data-cleanup.service.ts`。

---

## 7. 模块与依赖

```
src/agent/reengagement/
├── scenario-registry.ts        # FollowUpScenario[] 配置 + computeFireAt + 水位判据
├── anchor.service.ts           # 锚点事件识别 → 调 scheduler
├── follow-up-scheduler.service.ts  # queue.add(delay)；可选 @Cron sweep
├── follow-up.processor.ts      # @Processor：到点 → 停止条件 → compose → deliver
├── reengagement.agent.ts       # 专用生成器（LlmExecutor + zod schema，不复用主 generator）
├── touch-ledger.service.ts     # 触达底账（频控 + outbox 幂等状态机，Redis）
├── oob-work-order.ts           # pre_booking 带外工单核验
└── booking-context.ts          # 面试上下文装配

依赖：BullModule(REENGAGEMENT_QUEUE) | SessionService（复聊会话快照）| LlmExecutorService
      | ReengagementTrackingService（底账落库）| SystemConfigService（运行时开关）
      | ChannelDeliveryPort（可选注入）
```

---

## 相关文档

- [复聊功能产品说明](../product/reengagement.md) — 场景、触发/停止规则、内容规范、灰度、指标与验收口径
- [Agent 运行时架构](./agent-runtime-architecture.md) — 主链路回合模型与硬约束
- [群任务通知流水线](./group-task-pipeline.md) — 另一条定时主动触达链路
