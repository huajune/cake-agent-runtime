# 二次主动回复（reengagement / 复聊）实现方案

> 状态：实现级设计（评审稿）
> 日期：2026-06-24
> 父文档：[agent-reliability-refactor-2026-06.md](./agent-reliability-refactor-2026-06.md) §5.4 / 阶段 4
> 需求来源：「蛋糕触发二次主动回复需求」
> 依赖：阶段 0（`runner` 抽离）+ 阶段 3（权威会话状态 + 停止条件信号）。**这两步未落地前，复聊只能做 shadow（只排程不发）。**

## 0. 定性

场景驱动的 LLM 智能复聊：**系统决定何时主动找候选人**，话术由 LLM 实时生成（需求文档话术仅作 few-shot 风格参考，不固化模板）。**复聊回合复用 `runner` → 天然继承全部 guardrail / 记忆 / 观测**，不另起发送系统。

## 1. 触发机制：事件锚点 delayed job 为主，cron sweep 为辅

复聊触发**不轮询全量会话**，而是**在锚点事件发生时排一个 Bull delayed job**（复用 group-task 的 `queue.add(name, data, {delay})` 套路）：

```ts
// 在锚点事件处 hook（turn-end / ops-events 写入点）
const fireAt = computeFireAt(scenario, anchorAt);                    // 绝对时间戳（§4，已对齐 9-21 窗口）
await reengagementQueue.add('follow-up', { sessionRef, scenarioCode, anchorEventId, anchorAt }, {
  jobId: `${sessionRef.sessionId}:${scenarioCode}:${anchorEventId}`, // 幂等：同锚点不重复排程（Bull 同 jobId 去重）
  delay: Math.max(0, fireAt - Date.now()),                          // ⚠️ Bull delay = 相对 ms，不是绝对 fireAt
  attempts: 2, backoff: { type: 'fixed', delay: 30_000 },
});
```

- 锚点事件多数**已存在**为 ops_events：`agent.opening_sent`、`agent.replied`、booking 成功；其余（岗位展示、收资开始）按需补事件。
- **外部事件类**（"暂无岗位后有新岗位上线"）无法事件锚点到具体候选人 → 需一个 cron sweep 或岗位上线事件 × 等待候选人匹配，**复杂度高，后开**（与父文档"外部状态强依赖的后开"一致）。

## 2. 数据模型

```ts
// 场景结构化配置（非 prompt 常量）
interface FollowUpScenario {
  code: string;
  anchorEvent: string;            // 'agent.opening_sent' | 'agent.replied' | 'booking.succeeded' | ...
  triggerDelayMs: number | ((ctx: { anchorAt: number; state: AuthoritativeSessionState }) => number); // 相对锚点延迟；面试前提醒等依赖 interviewTime，ctx 给 state
  objective: string;             // 跟进目标（喂 runner 的 proactive directive）
  requiredEvidence: string[];    // 排程前/触发时必须具备的权威状态字段
  stopUnless: (state) => boolean;// 场景仍成立的条件（不成立则丢弃，见 §3）
  generationPolicy: string;      // 语气与禁止项（不夸大/不承诺/不骚扰/拒绝即止）
}

// Bull job payload
interface FollowUpJob { sessionRef: SessionRef; scenarioCode: string; anchorEventId: string; anchorAt: number; }
```

## 3. TaskProcessor：到点 → 代码校验 → 复用 runner → 投递

```ts
@Processor(REENGAGEMENT_QUEUE)
class FollowUpTaskProcessor {
  async process(job: Job<FollowUpJob>) {
    const { sessionRef, scenarioCode, anchorAt } = job.data;
    const scenario = this.registry.get(scenarioCode);
    const state = await this.session.getAuthoritativeState(sessionRef);

    // 1) 停止条件（代码，调 LLM 之前）——见 §3.1
    if (this.shouldStop(scenario, state, anchorAt)) return;          // 丢弃，不触发
    // 2) 频控：24h ≤ 2（查触达底账）
    if ((await this.touchLedger.countIn24h(sessionRef)) >= 2) return;
    // 3) 9-21 窗口二次确认（防 delay 漂移 / Bull 延迟）
    if (!inWindow(Date.now())) return await this.reschedule(job);    // 推到下一窗口

    // 4) 构造主动回合 → 复用 runner（继承 guardrail/记忆/观测）
    const outcome = await this.runner.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', scenarioCode,
        directive: this.buildDirective(scenario, state) },          // 目标 + 可用上下文，不给固定话术
      // ⚠️ 主动回合禁用副作用工具：复聊只提醒/答疑，不替候选人报名/拉群。
      // 经 preparation 物理建无副作用 toolset（复用 HC-1 的 toolMode），不靠 prompt。
      toolMode: 'readonly',
      context,
    });

    // 5) 投递 + 触达底账（outbox 状态机：reserved → delivery_attempted → sent/failed）
    if (outcome.kind === 'reply') {
      const key = `${sessionRef.sessionId}:${scenarioCode}:${anchorAt}`;
      const slot = await this.touchLedger.reserve(key);             // reserved | duplicate_sent | duplicate_inflight
      if (slot === 'duplicate_sent') return;                        // 真已发过 → 跳过
      // duplicate_inflight（上次 deliver 前失败/崩）→ 可恢复；若已 attempted，需走渠道幂等查询/补偿，不能盲重投
      try {
        await this.touchLedger.markDeliveryAttempted(key);          // 进入"可能已发出"区间
        await this.delivery.deliver(outcome, { idempotencyKey: key }); // ChannelDeliveryPort：要求渠道侧幂等
        await this.touchLedger.markSent(key);                       // 投递成功才置 sent
      } catch (e) {
        await this.touchLedger.markFailedOrUnknown(key, e);         // 若 deliver 后状态不明 → unknown，交补偿，不盲重投
        throw e;                                                    // 抛出让 Bull 重试（attempts=2）
      }
    }
    // outcome 为 skipped/blocked/handoff（被 guardrail 拦/转人工）→ 不发，照常记观测
  }
}
```

### 3.1 停止条件 shouldStop（在调 LLM 前，读权威状态）
- `state.terminal ∈ {booked, handed_off, rejected, onboarded}` → 停。
- 候选人明确拒绝（state 里的拒绝标记 / hardConstraint）→ 停。
- **`state.lastCandidateMessageAt > anchorAt`** → 候选人在锚点后已回过话，场景已不成立（如"开场未回复"但其实回了）→ 停。
- 场景特定 `stopUnless(state)`：如 `address_missing` 但 location 已有 → 停；`booking_incomplete` 但 collectedFields 已齐 → 停。

## 4. 9-21 时间窗 + 频控

- **窗口对齐**：`computeFireAt(scenario, anchorAt): number`（返回**绝对时间戳**）：先算 `anchorAt + resolveDelay(scenario.triggerDelayMs, ctx)`，落在 <9:00 → 推到当日 9:00；>21:00 → 推到次日 9:00（时区 `Asia/Shanghai`，与 group-task cron 一致）。排程时 **Bull `delay = max(0, fireAt - now)`（相对 ms）**，别把绝对 fireAt 当 delay。fire 时再 `inWindow(now)` 二次确认防漂移。
- **频控 24h ≤ 2**：按 `sessionId` 统计近 24h 触达底账中 **`sent` 状态**的条数（`reserved`/`failed`/`unknown` 不计——否则投递失败重投会被误算成多次触达）；达上限丢弃。
- **幂等（outbox 状态机）**：排程层 Bull `jobId=${sessionId}:${scenarioCode}:${anchorEventId}` 去重；发送层触达底账 `reserved → delivery_attempted → sent/failed/unknown`。`reserve()` 命中 `sent` 跳过；命中 `reserved` 可重试；一旦进入 `delivery_attempted`，就处于"外部平台可能已经发出"区间，**不得盲目重投**，必须依赖 `ChannelDeliveryPort.deliver(..., { idempotencyKey })` 的渠道侧幂等，或走补偿查询/人工核对后再决定。`markSent` 落库失败不能简单置 `failed` 重投，应置 `unknown` 并告警。这样同时杜绝"写了底账却没发出"和"发出了但落库失败导致重复发"。

## 5. 7 个需求场景 → 锚点/延迟/停止 映射

| code | 锚点事件 | 延迟 | stopUnless（仍成立） |
|---|---|---|---|
| `opening_no_reply` | `agent.opening_sent` | +15min | 锚点后无候选人回复 |
| `address_missing` | `agent.replied`(location 空) | +N min | location 仍空 |
| `store_presented_no_reply` | 岗位/门店展示（需补事件） | +N h | 锚点后无回复 |
| `booking_incomplete` | 收资开始（需补事件） | +N h | collectedFields 仍不齐 |
| `interview_reminder` | `booking.succeeded` | `interviewTime - 1h` | 面试未取消 |
| `post_interview_followup` | `booking.succeeded` | `interviewTime + ~1h` | — |
| `new_job_for_waiting` | **岗位上线事件**（外部，后开） | 事件驱动 | 候选人仍在等待池 |

## 6. 模块与 DI（agent 能力，非 biz）

复聊是"Agent 主动发起回合"的能力（见父文档分层），归 `agent/reengagement/`；调度用 infra 的 Bull、投递用 `ChannelDeliveryPort`：

```
agent/reengagement/
  scenario-registry.ts        FollowUpScenario[] 配置
  follow-up-scheduler.ts      锚点事件 → queue.add(delay)；可选 @Cron sweep
  follow-up.processor.ts      @Processor：到点 → 停止条件 → runner.runTurn → deliver
  touch-ledger.*              触达底账（频控 + outbox 幂等状态机）
依赖：BullModule.registerQueue(REENGAGEMENT_QUEUE) | SessionService(权威状态) |
      TurnRunner(阶段0) | ChannelDeliveryPort | ops-events(锚点 hook)
```

## 7. Shadow mode（第一版必跑）

`SHADOW=true` 时 processor 走完停止条件 + runner.runTurn，但**不 deliver**，只记"本应发 X / 命中场景 Y / 停止原因 Z"。⚠️ **"不 deliver" ≠ "无副作用"**：主动回合已用 `toolMode:'readonly'` 物理禁用 booking/invite/modify（§3 step 4），shadow 只是再叠加"不投递"。两者缺一不可——只跳过 deliver、不禁副作用工具，generator 仍可能在 loop 内真报名/真拉群。验证：① 触发命中率（该发的发了吗）；② 停止条件正确（不该发的拦住了吗，尤其"候选人已回"）；③ guardrail 对主动话术的拦截率。验证通过再按场景灰度开真发：先 `opening_no_reply` / `booking_incomplete` / `interview_reminder`（事件锚点明确）；`new_job_for_waiting` 最后。

## 8. 待落定 / 风险

- **[阻塞] 依赖 runner（阶段 0）+ 权威状态停止条件（阶段 3）**：前者提供复用接缝，后者提供 `lastCandidateMessageAt/terminal` 等停止信号。两者未落地前只能 shadow。
- **[P0 待核实] 平台主动发消息限制**：企微/托管平台对"候选人长时间未回时主动发消息"可能有时间窗/频次限制（如外部联系人 48h 规则）。复聊的本质就是沉默后主动触达——**必须先确认托管平台 send API 是否允许、有何配额**，否则发不出去或触发风控。
- **[补事件] `store_presented_no_reply`/`booking_incomplete` 缺现成锚点事件**，需在岗位展示工具 / 收资流程补 ops_events。
- **[跨渠道] 小程序**：复聊触发逻辑渠道无关，但投递走对应 `ChannelDeliveryPort`；小程序若是同步请求-响应，"主动推送"需走客服消息接口（与企微不同），归各渠道适配器。

## 9. 落定检查单

- [ ] FollowUpScenario 配置 + 7 场景锚点/延迟/stopUnless 表
- [ ] scheduler：锚点事件 hook + `queue.add` 幂等 jobId + `computeFireAt`（绝对 fireAt）+ Bull `delay=max(0, fireAt-now)`（相对 ms）
- [ ] processor：shouldStop（terminal/已回/拒绝/场景特定）→ 频控 → runner.runTurn(**toolMode:'readonly'**) → deliver + 触达底账
- [ ] 触达底账 **outbox 状态机** reserved→delivery_attempted→sent/failed/unknown（频控只数 sent；attempted 后靠渠道幂等/补偿，防丢消息也防重复发送）
- [ ] shadow = toolMode:'readonly'（禁副作用）+ 不 deliver（两者缺一不可）
- [ ] shadow mode 开关 + 命中/停止/拦截观测
- [ ] **平台主动发消息限制核实**（阻塞真发）
- [ ] 补 `store_presented` / `booking_incomplete` 锚点事件
