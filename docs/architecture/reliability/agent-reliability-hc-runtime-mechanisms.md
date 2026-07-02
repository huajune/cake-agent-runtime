# HC-1/2/3 Runtime 机制设计

> 状态：实现级机制设计（已启动落地，见"实现进展"）
> 日期：2026-06-24
> 父文档：[agent-reliability-refactor-2026-06.md](./agent-reliability-refactor-2026-06.md) §12 未决硬约束
> 目的：把 §12 的三条硬约束（声明）变成**可实现的 runtime 机制**——具体到改哪个函数、数据形状、控制流、边界。三者落定后方可进入实现。

前置事实（已核实）：
- runner `stopWhen` 已改为 any-tool 短路：任意 tool result `output.shortCircuited===true` 即停 loop，`skip_reply` 仍保留无条件短路（[runner.service.ts](../../../src/agent/runner/agent-runner.service.ts)）。
- `request_handoff` 工具**在工具内** `interventionService.dispatch(...)`（pause+告警）并返回 `{dispatched:true, shortCircuited:true}`（[request-handoff.tool.ts:194-228](../../../src/tools/request-handoff.tool.ts#L194)）。
- booking 现在信任模型入参 `prechecked.nextAction`（[booking.tool.ts:273](../../../src/tools/duliday-interview-booking.tool.ts#L273)）；候选人字段经 `buildKnownFieldMap`（profile/sessionFacts）+ `applyCandidateFieldOverride`（**模型入参** candidateName 等）合成（[precheck.tool.ts:480-495](../../../src/tools/duliday-interview-precheck.tool.ts#L480)）。
- 副作用工具集（replay 阻断）= `{invite_to_group, duliday_interview_booking}`（[reply-workflow.service.ts:51](../../../src/channels/wecom/message/application/reply-workflow.service.ts#L51)）。

实现进展（2026-06-24）：
- 已新增 `AgentInvokeParams.toolMode: 'scenario' | 'readonly' | 'none'`，`AgentPreparationService` 物理过滤工具；`readonly` 禁副作用工具，`none` 返回空 toolset。
- 已新增 `AuthoritativeSessionState` 骨架与 `SessionService.getAuthoritativeState()`，其中 `recalledJobIds:Set<number>` 来自 presented/current/candidate pool；`collectedFields` 暂不把 LLM session facts 当权威。
- precheck/booking 已使用 `context.isRecalledJobId(jobId)` 做成员判定；booking 的 jobId 无召回出处路径已升级为 `{shortCircuited:true, gateRejected:true, reasonCode:'job_id_not_recalled'}`。
- `reply-workflow` 已把 booking gate 短路映射到 outcome 层 handoff 派发：先写 handoff 底账，`duplicate` 跳过重复 dispatch，`failed` 仍 fail-safe pause+告警；`request_handoff` 迁移期仍由工具内 dispatch，避免双派发。
- `HandoffRecorderService.record()` / `HandoffEventsRepository.insertHandoffEvent()` 已升级为三态 `inserted | duplicate | failed`。
- 未完成：完整 `TurnOutcome` 类型抽象、独立 `BookingGuardrail.evaluatePrecheck()`、候选人字段 parser/normalizer、HC-1 revise 回路与 `reviseFeedback/committedSideEffects`。

---

## HC-1：副作用后 revise → 只能无工具文本重写

### 机制

**1. 副作用提交判定（纯函数，runner 内）**
```ts
const SIDE_EFFECT_TOOLS = new Set(['invite_to_group', 'duliday_interview_booking',
  'duliday_modify_interview_time', 'duliday_cancel_work_order']);  // 凡真改外部系统的

// ⚠️ 不能用 key presence 判失败：booking 成功结果**显式带 `errorType: null`**
// （[booking.tool.ts:794](../../../src/tools/duliday-interview-booking.tool.ts#L794)），`'errorType' in r` 对成功也为 true，
// 会把成功预约误判成"无副作用"→ revise 走全量重跑 → 重复 booking。必须用正向成功信号判定。
function isToolSuccess(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  if (r.success === true || r.dispatched === true || r.workOrderId != null) return true; // 正向信号
  return false; // 其余（含 typeof r.errorType === 'string' 的 buildToolError）一律非成功
}
function hasCommittedSideEffect(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some(tc => SIDE_EFFECT_TOOLS.has(tc.toolName) && isToolSuccess(tc.result));
}
```

**2. runner.runTurn 的 revise 分支**
```ts
// output 守卫返回 revise 时
if (decision === 'revise') {
  if (hasCommittedSideEffect(draft.toolCalls)) {
    // 副作用已提交：禁止重跑工具 → 无工具文本重写（≤1）
    const rewritten = await this.generator.invoke({
      ...params, toolMode: 'none',          // ← 见下"接缝"：物理空 toolset，不靠 prompt
      reviseFeedback: decision.violations,
      committedSideEffects: summarize(draft.toolCalls),  // 告诉它"已约/已拉群"，只改措辞
      deferTurnEnd: true,
    });
    return this.afterRewrite(rewritten, draft);   // 再过 output 守卫；仍 revise/block → block(保留已发生的副作用，转人工)
  }
  // 无副作用：可全量重跑（≤1）
  if (reviseBudget-- > 0) return this.runGenerateAndGuard({ ...params, reviseFeedback: decision.violations });
  return this.toBlock(draft);
}
```

### 接缝（需新增，否则会退化成 prompt 约束）
现 `AgentInvokeParams`（[agent-run.types.ts:29](../../../src/agent/agent-run.types.ts#L29)）**没有** tools/reviseFeedback/committedSideEffects，toolset 是 `AgentPreparationService` 内按 scenario 物理构建的。HC-1 必须落到真实接缝：
- 新增 `toolMode: 'scenario' | 'readonly' | 'none'`（或更细 `allowedTools?: string[]`）：`AgentPreparationService` 据此**物理构建完整/只读/空 toolset**——`'readonly'` 仅保留查岗位/读状态等无副作用工具，禁 `booking/invite/modify/cancel`；`'none'` 不注册任何工具，模型即使想调也无工具可调。
- 新增 `reviseFeedback?: GuardViolation[]` / `committedSideEffects?: string`：注入提示让模型只改措辞、知晓"已约/已拉群"。
- **关键**：空 toolset 由 preparation 层物理保证，**不能**只在 prompt 写"不要再调工具"——那又回到模型自证。

### 边界
- `toolMode:'none'` 由 runner 经 preparation 注入，保证**物理不可能**再触发副作用（不依赖模型自觉）。
- 无工具重写后再过 output 守卫；若仍 `revise`/`block` → 终态 `block`（转人工），**不再循环**。
- 已提交的副作用（booking 成功）**保留**，不因回复被重写/拦截而回滚——HC-4 的"已发生副作用"状态照常落。
- ⚠️ **重写结果不含 booking/invite toolCalls**（`toolMode:'none'`），但 output guard 的 `unsupported_commitment` 要靠 `toolCalls.result` 判"已约好"是否有据。故 `afterRewrite` 必须用 **`draft.toolCalls ∪ rewritten.toolCalls`** 一起审查（否则把"已约好"误判为无据 → 误 block）；最终 outcome 也要**携带 draft 的已提交副作用**供 HC-4 记忆与下游使用。

---

## HC-2：权威字段 evidence 准入

### 机制

**1. 每个权威字段带 provenance**
```ts
type FieldProvenance = 'user_text' | 'booking_writeback' | 'llm_extract' | 'model_arg';
interface CollectedField<T = string> { value: T; provenance: FieldProvenance; evidence?: string; at: number; }
// AuthoritativeSessionState.collectedFields: Partial<Record<CandidateFieldKey, CollectedField>>
```

**2. 来源 → provenance 映射（写入点）**
| 来源 | provenance | 是否权威 |
|---|---|---|
| 候选人消息确定性解析（regex/parser 抽 "姓名：X 电话：Y"、纯数字电话、身份证等） | `user_text` | ✅ |
| booking 成功后 API 回写的字段 | `booking_writeback` | ✅ |
| sessionFacts.interview_info（turn-end LLM 抽取） | `llm_extract` | ⚠️ 草稿 |
| precheck/booking 的模型入参 `candidateName/...`（`applyCandidateFieldOverride`） | `model_arg` | ❌ 草稿 |

**3. BookingGuard 准入**
```ts
const AUTHORITATIVE = new Set<FieldProvenance>(['user_text', 'booking_writeback']);
function isFieldAuthoritative(f?: CollectedField): boolean { return !!f && AUTHORITATIVE.has(f.provenance); }
// gate 计算 missingFields 时：provenance ∉ AUTHORITATIVE 的字段视为"未提供"
// → 缺真名/缺确定性字段 → reject_collect（要求候选人确认/补发），而非放行
```

**4. `jobId` 也必须有 provenance（不止候选人字段）**
生产实例 [[project_precheck_jobid_hallucination]]：空会话约面意向下 precheck/booking **凭空编 jobId**，靠 `job_not_found` 侥幸接住，臆造号一旦撞真岗位即 P0（近 30 天越界 10 次）。这与候选人字段是**同一自证类**，HC-2 必须覆盖：
- ⚠️ 现有接缝只有 `hasRecalledJobs(): boolean`（"召回过**任意**岗位"，[tool.types.ts:81](../../../src/types/tool.types.ts#L81)），booking 也只拦"一个岗位都没召回过"（[booking.tool.ts:301](../../../src/tools/duliday-interview-booking.tool.ts#L301)）——**只要本会话召回过任意岗位，模型仍可另编一个真实 jobId 通过**。
- 必须把接缝升级成**成员判定**：`isRecalledJobId(jobId): boolean` / `recalledJobIds: Set<number>`（turn-start presentedJobs ∪ lastCandidatePool ∪ currentFocusJob ∪ 本轮 onJobsFetched）。
- `!isRecalledJobId(jobId)` → 视为**模型臆造 → reject_hard（转人工）**，不得用它重算 precheck 后放行。**阶段 1a 依赖里补这项状态切片**。

### 字段映射表（到可构造 booking payload 的粒度）
仅判"缺不缺"不够——`allow` 分支要能生成 booking 真实 payload（Sponge 枚举化字段 + 岗位补充标签，见 [booking.tool.ts:134](../../../src/tools/duliday-interview-booking.tool.ts#L134)）。每个字段定义 parser（原文→值）+ normalizer（值→Sponge 枚举）+ evidence + booking arg：

| CandidateFieldKey | parser（user_text） | normalizer → booking arg | 备注 |
|---|---|---|---|
| name | 真名解析（排昵称/"我是X"） | string → `name` | 真名校验，[[feedback_booking_nickname_vs_legal_name]] |
| phone | 11 位手机号正则 | string → `phone` | 确定性强 |
| age | 数字 | int → `age` | LLM 仅草稿；allow 需 user_text |
| gender | 男/女 | enum → `genderId`(1=男,2=女) | normalizer 必需 |
| education | 学历词 | Sponge enum → `educationId` | 自由文本→枚举映射 |
| healthCert | 有/无但接受办/无且不接受 | Sponge enum → `hasHealthCertificate`(**1/2/3，非 0/1**) | [sponge.enums.ts:60](../../../src/sponge/sponge.enums.ts#L60) |
| householdProvince | 户籍省名 | **省名→ID** → `householdRegisterProvinceId`(**数字 ID，非字符串**) | [booking.tool.ts:155](../../../src/tools/duliday-interview-booking.tool.ts#L155)；红线筛选关键 |
| height/weight | 数字 | int → `height`/`weight` | 部分岗位要求 |
| supplementAnswers | 岗位补充标签问答 | Record → `supplementAnswers` | 按岗位 customerLabel 动态，[[feedback_screening_label_vs_collection_field]] |

> ⚠️ normalizer 必须对齐 **Sponge 枚举/ID 契约**（健康证 1/2/3、户籍是 `householdRegisterProvinceId` 数字、性别 1/2）——这是 `allow` 分支能正确构造 payload 的关键；按"0/1""字符串省名"实现会直接写错 booking 入参。
> **准入收敛**：所有字段 LLM 来源（`llm_extract`/`model_arg`）仅作草稿/预填；要进 booking `allow`，**必须 `user_text` evidence 或 `booking_writeback`**（与 §HC-2 准入白名单一致，不破例）。

### 改造点
- 新增 `tools/shared/candidate-field-parser.ts`：对候选人**原文**做确定性解析+归一 → `user_text` provenance 写入权威态。
- ⚠️ **parser 必须在 BookingGuard 判定前一定运行**（防模型跳过 precheck 直调 booking 时 guard 读到 stale/empty 权威字段 → 误拒或退回依赖模型参数）。两种落点择一：① turn-start/preparation 解析**当前** user 原文并 patch 权威态；② BookingGuard 自身在 gate 首步解析当前消息并 patch 后再判。推荐 ② 兜底 ①（preparation 解析 + gate 再校一次），保证 guard 看到的一定是最新 evidence。
- precheck 的 `applyCandidateFieldOverride`（模型入参）**不再写权威态**，仅作 `model_arg` 草稿供对话展示/预填；BookingGuard 不据此判"已提供"。
- 呼应 [[feedback_booking_nickname_vs_legal_name]]：真名必须 `user_text`/`booking_writeback`，模型"我是XX"的入参不算。

---

## HC-3：hard-reject 短路由 runtime 保证

### 机制（复用现成 shortCircuit，不造新基建）

**1. BookingGuardrail 只读判定**（已设计）：`gate()` 返回 `{decision:'reject_hard', reasonCode}`，**无任何 dispatch**。

**2. booking 工具据 verdict 返回短路 result**
```ts
// duliday-interview-booking.tool execute 首行
const verdict = await bookingGuardrail.gate({
  jobId,
  sessionRef,
  requestedInterviewTime,
  currentUserMessages,  // HC-2：当前轮候选人原文，供 gate 内 parser 兜底解析+写权威态
  turnId,               // 解析/写状态/幂等的事务关联
});
if (verdict.decision === 'reject_hard') {
  return { shortCircuited: true, gateRejected: true, reasonCode: verdict.reasonForHandoff };  // ← 不 dispatch、不 booking
}
if (verdict.decision === 'reject_collect') return buildToolError({ ... });   // 可重试收资
// allow → 执行真实 booking
```

**3. runner stopWhen 改为通用短路（推荐）**
```ts
// 现：shortCircuitByToolResult('request_handoff')
// 改：任意工具 output.shortCircuited===true 即停 —— request_handoff 自然纳入，未来 gate 自动覆盖
const shortCircuitOnAnyToolResult = ({ steps }) =>
  (steps[steps.length-1]?.toolResults ?? []).some(r => isShortCircuitedToolResult(r.output));
```

**4. runner 把短路结果映射成 handoff outcome；intervention 由 outcome 层 dispatch**
```ts
// runner 收尾：若末步有 gateRejected 短路 → TurnOutcome.kind='handoff'
// outcome 处理层（reply-workflow 或其后继）见 handoff → interventionService.dispatch({kind, reasonCode})
```

### 为什么不在 booking 工具内 dispatch
- 保持 **gate 只读、tool 只判不执行 intervention**：dispatch（pause 托管+告警）是有副作用的动作，集中到 outcome 层，便于统一观测/幂等/在 shadow 或测试链路里禁用。
- 注：现有 `request_handoff` 是**在工具内** dispatch 的（legacy）。HC-3 走 outcome 层；二者迁移期并存，后续把 request_handoff 也收敛到 outcome 层 dispatch（统一）。
- 关键不变量：**短路是 runtime 强制的**（stopWhen 见 `shortCircuited` 即停），模型无法在 hard-reject 后继续生成绕过——这正是"不交给模型"。

### handoff 的元数据与幂等契约（必须补，否则重放会重复 pause+告警）
现 `request_handoff` 用稳定 turnId 做幂等键 `${chatId}:handoff:${turnId}`，保证 Bull retry / 崩溃重放只 pause+告警一次（[request-handoff.tool.ts:159](../../../src/tools/request-handoff.tool.ts#L159)）。outcome 层新路径必须用**同等幂等键**，否则重复暂停托管+告警。
```ts
// TurnOutcome 扩展（父文档 §5.3 同步）
interface TurnOutcome {
  kind: 'reply' | 'skipped' | 'blocked' | 'handoff';
  // ... 原字段
  handoff?: {
    reasonCode: string; reason?: string;
    sourceToolCall: string;                          // 'duliday_interview_booking' | 'request_handoff'
    idempotencyKey: string;                          // `${chatId}:handoff:${turnId}` —— 与现有一致
    alreadyDispatched?: boolean;                     // request_handoff 工具内已 dispatch → true；outcome 层据此跳过
  };
}
```
**幂等落点**：`InterventionService.dispatch` 本身**不接收/不消费幂等键**，只查 `alreadyPaused`（[intervention.service.ts:75](../../../src/biz/intervention/intervention.service.ts#L75)）——不足以防重放。真正幂等的是 `HandoffEventsRepository.insertHandoffEvent`（按 `corp_id + idempotency_key` upsert）。

`handoff_events` 写入结果必须保持三态，不能退回布尔 `false=重复/失败/熔断/DB不可用` 混合语义。若按"false 就跳过 dispatch"实现，**Supabase 故障时会静默不暂停、不告警**（漏人工介入，P0）：
```ts
type HandoffWriteOutcome = 'inserted' | 'duplicate' | 'failed';
const r = await handoffRecorder.record({ idempotencyKey, reasonCode, ... });
if (r === 'duplicate') return;                       // 真重复 → 跳过 dispatch
await interventionService.dispatch({ pauseTargetId, kind, reasonCode });  // inserted 正常 dispatch
if (r === 'failed') logger.error('handoff 底账写入失败，已 fail-safe dispatch', { idempotencyKey }); // failed → 仍 dispatch + 高危告警/指标
```
即 **duplicate 才跳过；failed 一律 fail-safe dispatch（宁可重复也不漏人工）+ 打高危日志/指标**。当前实现已用原生 `upsert(... ignoreDuplicates).select('idempotency_key')` 区分 inserted/duplicate/error。

**迁移期防双 dispatch（P0）**：现有 `request_handoff` 工具**已在工具内 dispatch**（[request-handoff.tool.ts:194](../../../src/tools/request-handoff.tool.ts#L194)）。outcome 层 **只处理 `sourceToolCall==='duliday_interview_booking'`（gate hard-reject）路径**；`sourceToolCall==='request_handoff'` 标记 `alreadyDispatched`、**不进入 outcome dispatch**，否则会重复 pause+告警。待后续把 request_handoff 也收敛到 outcome 层时再统一。

---

## 三者交互的一处合点

`reject_hard`（HC-3）短路 → 本回合**无对外 reply**（handoff outcome）；此时 HC-1 的 revise 不触发（没有要审的 reply）；HC-4 的记忆二分：**不写"对用户说过"**，但若该回合更早已成功 booking（理论上不会与 hard-reject 同回合，但 modify/cancel 可能），其副作用状态仍按 HC-4(b) 落。三条约束在 outcome 层汇合，由 `TurnOutcome.kind` 统一驱动后续（投递/转人工/记忆）。

---

## 落定检查单（进入实现的门槛）

- [ ] HC-1：`isToolSuccess` 用**正向信号**（`success/dispatched/workOrderId`），**不可用 `'errorType' in r`**（成功带 `errorType:null`）；`hasCommittedSideEffect` 覆盖 booking/invite/modify/cancel；runner revise 分支；**已完成接缝一部分**：`AgentInvokeParams.toolMode:'scenario'|'readonly'|'none'` + preparation 物理建只读/空 toolset；未完成 `reviseFeedback?` + `committedSideEffects?`、`afterRewrite` 用 `draft.toolCalls ∪ rewritten.toolCalls` 审查。
- [ ] HC-2：`CollectedField.provenance` 模型骨架已建；候选人原文 parser+normalizer（`user_text`，**parser 须在 BookingGuard 前运行**）未落；**字段映射表对齐 Sponge 契约**未落；**jobId 成员判定** `isRecalledJobId(jobId)`/`recalledJobIds:Set` 已落；precheck `model_arg` 降级草稿与 BookingGuard `AUTHORITATIVE` missing 判定未落。
- [ ] HC-3：已完成 booking jobId gate hard-reject `{shortCircuited,gateRejected,reasonCode}`、runner **any-tool 短路**、handoff 底账三态、迁移期仅 booking-gate outcome dispatch 且 `request_handoff` 不重复 dispatch；未完成通用 `TurnOutcome.handoff` 类型抽象与完整 BookingGuardrail。
