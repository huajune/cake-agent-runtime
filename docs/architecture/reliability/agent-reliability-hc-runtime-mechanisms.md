# HC-1/2/3 Runtime 机制设计

> 状态：runtime 机制完成（当前分支）
> 日期：2026-06-24
> 父文档：[agent-reliability-refactor-2026-06.md](./agent-reliability-refactor-2026-06.md) §12 未决硬约束
> 目的：把 §12 的三条硬约束（声明）变成已落地的 runtime 机制——具体到函数、数据形状、控制流、边界。当前分支已具备进入后续增强阶段的基础。

前置事实（已核实）：
- generator `stopWhen` 已改为 any-tool 短路：任意 tool result `output.shortCircuited===true` 即停 loop，`skip_reply` 仍保留无条件短路（[generator.service.ts](../../../src/agent/generator/generator.service.ts#L118)）；`AgentRunnerService.invokeReviewed()` 已承接 output guardrail + 一次 revise 编排（[agent-runner.service.ts](../../../src/agent/runner/agent-runner.service.ts#L120)）。
- `request_handoff` 工具**在工具内** `interventionService.dispatch(...)`（pause+告警）并返回 `{dispatched:true, shortCircuited:true}`（[request-handoff.tool.ts](../../../src/tools/request-handoff.tool.ts#L194)）。
- booking 历史上信任模型入参 `prechecked.nextAction`；当前分支已补 jobId provenance gate、booking name gate 与 hard-reject runtime short-circuit。完整全量 `evaluatePrecheck` 仍可继续抽纯函数化，但不再是 HC-1/2/3 runtime 机制的阻塞项。
- replay 阻断工具集 = `{invite_to_group, duliday_interview_booking}`（[reply-workflow.service.ts](../../../src/channels/wecom/message/application/reply-workflow.service.ts#L58)）。更完整的 HC-1 副作用工具集以 [tool-call-analysis.ts](../../../src/agent/generator/tool-call-analysis.ts#L136) 的 `SIDE_EFFECT_TOOLS` 为准。

实现进展（2026-06-26）：
- 已新增 `GeneratorInvokeParams.toolMode: 'scenario' | 'readonly' | 'none'`，`PreparationService` 物理过滤工具；`readonly` 禁副作用工具，`none` 返回空 toolset。
- 已新增 `reviseFeedback` / `committedSideEffects` 注入与正向副作用判定：`isToolSuccess()` 只认 `success/accepted/dispatched/workOrderId` 等正向信号，避免 `errorType:null` 误判。
- 已新增 `TurnOutcome.kind='reply'|'skipped'|'blocked'|'handoff'` 与 handoff metadata（`reasonCode/sourceToolCall/idempotencyKey/alreadyDispatched`）。
- 已新增 `AuthoritativeSessionState` 与 `SessionService.getAuthoritativeState()`：`recalledJobIds:Set<number>` 来自 presented/current/candidate pool；`lastCandidateMessageAt` / `terminal` 已写入；`collectedFields` 仅投影有 provenance 的字段，不把模型工具参数当硬准入。
- precheck/booking 已使用 `context.isRecalledJobId(jobId)` 做成员判定；booking 的 jobId 无召回出处路径已升级为 `{shortCircuited:true, gateRejected:true, reasonCode:'job_id_not_recalled'}`。
- 已新增 `tools/shared/candidate-field-parser.ts` 与 booking name gate：候选人原文 parser 在工具上下文中可用，`"我是X"` 打招呼昵称不作为真实姓名 evidence。
- `reply-workflow` 已把 booking gate 短路映射到 outcome 层 handoff 派发：先写 handoff 底账，`duplicate` 跳过重复 dispatch，`failed` 仍 fail-safe pause+告警；`request_handoff` 迁移期仍由工具内 dispatch，避免双派发。
- `HandoffRecorderService.record()` / `HandoffEventsRepository.insertHandoffEvent()` 已升级为三态 `inserted | duplicate | failed`。
- 复聊/主动回合已消费这些机制：主动回合默认 `toolMode:'readonly'`；handoff/booking 终态写入 session，供主动触达停止条件使用。

---

## HC-1：副作用后 revise → 只能无工具文本重写

### 机制

**1. 副作用提交判定（纯函数，runner 内）**
```ts
const SIDE_EFFECT_TOOLS = new Set([
  'invite_to_group',
  'duliday_interview_booking',
  'duliday_modify_interview_time',
  'duliday_cancel_work_order',
  'send_store_location',
  'raise_risk_alert',
  'request_handoff',
]);  // 凡真改外部系统 / 外部投递 / 人工介入的

// ⚠️ 不能用 key presence 判失败：booking 成功结果**显式带 `errorType: null`**
// （[booking.tool.ts](../../../src/tools/duliday-interview-booking.tool.ts#L808)），`'errorType' in r` 对成功也为 true，
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

**2. runner.invokeReviewed 的 revise 分支**
```ts
// output 守卫返回 revise 时
if (decision === 'revise') {
  // 统一走无工具文本重写（≤1）：有副作用时防重复执行；无副作用时也避免 revise 变成新一轮业务决策。
  const rewritten = await this.generator.invoke({
    ...params, toolMode: 'none',          // ← 见下"接缝"：物理空 toolset，不靠 prompt
    reviseFeedback: decision.violations,
    committedSideEffects: summarize(draft.toolCalls) || undefined,  // 告诉它"已约/已拉群"，只改措辞
    deferTurnEnd: true,
  });
  return this.afterRewrite(rewritten, draft);   // 用 draft.toolCalls ∪ rewritten.toolCalls 再过 output 守卫；仍 revise/block → block
}
```

### 接缝（已落地，否则会退化成 prompt 约束）
- `toolMode: 'scenario' | 'readonly' | 'none'`：`PreparationService` 据此**物理构建完整/只读/空 toolset**。`readonly` 过滤副作用工具；`none` 不注册任何工具，模型即使想调也无工具可调。
- `reviseFeedback?: GuardViolation[]` / `committedSideEffects?: string`：注入提示让模型只改措辞、知晓"已约/已拉群"。
- **关键**：空 toolset 由 preparation 层物理保证，**不能**只在 prompt 写"不要再调工具"——那又回到模型自证。

### 边界
- `toolMode:'none'` 由 runner 经 preparation 注入，保证**物理不可能**再触发副作用（不依赖模型自觉）。
- 无工具重写后再过 output 守卫；若仍 `revise`/`block` → 终态 `block`（转人工），**不再循环**。
- 已提交的副作用（booking 成功）**保留**，不因回复被重写/拦截而回滚——HC-4 的"已发生副作用"状态照常落。
- **重写结果不含 booking/invite toolCalls**（`toolMode:'none'`），但 output guard 的 `unsupported_commitment` 要靠 `toolCalls.result` 判"已约好"是否有据。当前 `AgentRunnerService.invokeReviewed()` 已用 **`draft.toolCalls ∪ rewritten.toolCalls`** 审查二版，并让最终 result/outcome 携带 draft 的已提交副作用，供 HC-4 记忆与下游使用。

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
- 历史接缝只有"召回过任意岗位"的 boolean 判断，booking 也只拦"一个岗位都没召回过"——**只要本会话召回过任意岗位，模型仍可另编一个真实 jobId 通过**。
- 当前已把接缝升级成**成员判定**：`isRecalledJobId(jobId): boolean`（[tool.types.ts](../../../src/types/tool.types.ts#L92)）/ `recalledJobIds: Set<number>`（turn-start presentedJobs ∪ lastCandidatePool ∪ currentFocusJob ∪ 本轮 onJobsFetched）。
- `!isRecalledJobId(jobId)` → 视为**模型臆造 → reject_hard（转人工）**，booking 侧 defense-in-depth 已返回 `{ shortCircuited:true, gateRejected:true, reasonCode:'job_id_not_recalled' }`（[booking.tool.ts](../../../src/tools/duliday-interview-booking.tool.ts#L283)），不得用它重算 precheck 后放行。

### 字段映射表（到可构造 booking payload 的粒度）
仅判"缺不缺"不够——`allow` 分支要能生成 booking 真实 payload（Sponge 枚举化字段 + 岗位补充标签，见 [booking.tool.ts](../../../src/tools/duliday-interview-booking.tool.ts#L134)）。每个字段定义 parser（原文→值）+ normalizer（值→Sponge 枚举）+ evidence + booking arg：

| CandidateFieldKey | parser（user_text） | normalizer → booking arg | 备注 |
|---|---|---|---|
| name | 真名解析（排昵称/"我是X"） | string → `name` | 真名校验，[[feedback_booking_nickname_vs_legal_name]] |
| phone | 11 位手机号正则 | string → `phone` | 确定性强 |
| age | 数字 | int → `age` | LLM 仅草稿；allow 需 user_text |
| gender | 男/女 | enum → `genderId`(1=男,2=女) | normalizer 必需 |
| education | 学历词 | Sponge enum → `educationId` | 自由文本→枚举映射 |
| healthCert | 有/无但接受办/无且不接受 | Sponge enum → `hasHealthCertificate`(**1/2/3，非 0/1**) | [sponge.enums.ts](../../../src/sponge/sponge.enums.ts#L60) |
| householdProvince | 户籍省名 | **省名→ID** → `householdRegisterProvinceId`(**数字 ID，非字符串**) | [booking.tool.ts](../../../src/tools/duliday-interview-booking.tool.ts#L134)；红线筛选关键 |
| height/weight | 数字 | int → `height`/`weight` | 部分岗位要求 |
| supplementAnswers | 岗位补充标签问答 | Record → `supplementAnswers` | 按岗位 customerLabel 动态，[[feedback_screening_label_vs_collection_field]] |

> ⚠️ normalizer 必须对齐 **Sponge 枚举/ID 契约**（健康证 1/2/3、户籍是 `householdRegisterProvinceId` 数字、性别 1/2）——这是 `allow` 分支能正确构造 payload 的关键；按"0/1""字符串省名"实现会直接写错 booking 入参。
> **准入收敛**：所有字段 LLM 来源（`llm_extract`/`model_arg`）仅作草稿/预填；要进 booking `allow`，**必须 `user_text` evidence 或 `booking_writeback`**（与 §HC-2 准入白名单一致，不破例）。

### 改造点
- 已新增 `tools/shared/candidate-field-parser.ts`：对候选人**原文**做确定性解析+归一 → `user_text` provenance；booking name gate 在工具执行前读取当前消息做兜底判定。
- parser 已在工具上下文中可用；jobId gate 通过 `context.isRecalledJobId(jobId)` 同步读取 turn-start 与本轮 `onJobsFetched` 候选池，覆盖“先 job_list 再 precheck/booking”的同回合路径。
- precheck 的 `applyCandidateFieldOverride`（模型入参）仍只作为工具内对话草稿/预填；BookingGuard 的 jobId/name runtime gate 不据此放行。
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
现 `request_handoff` 用稳定 turnId 做幂等键 `${chatId}:handoff:${turnId}`，保证 Bull retry / 崩溃重放只 pause+告警一次（[request-handoff.tool.ts](../../../src/tools/request-handoff.tool.ts#L164)）。outcome 层新路径必须用**同等幂等键**，否则重复暂停托管+告警。
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
**幂等落点**：`InterventionService.dispatch` 本身**不接收/不消费幂等键**，只查 `alreadyPaused`（[intervention.service.ts](../../../src/biz/intervention/intervention.service.ts#L75)）——不足以防重放。真正幂等的是 `HandoffEventsRepository.insertHandoffEvent`（按 `corp_id + idempotency_key` upsert，见 [handoff-events.repository.ts](../../../src/biz/handoff-events/handoff-events.repository.ts#L37)）。

`handoff_events` 写入结果必须保持三态，不能退回布尔 `false=重复/失败/熔断/DB不可用` 混合语义。若按"false 就跳过 dispatch"实现，**Supabase 故障时会静默不暂停、不告警**（漏人工介入，P0）：
```ts
type HandoffWriteOutcome = 'inserted' | 'duplicate' | 'failed';
const r = await handoffRecorder.record({ idempotencyKey, reasonCode, ... });
if (r === 'duplicate') return;                       // 真重复 → 跳过 dispatch
await interventionService.dispatch({ pauseTargetId, kind, reasonCode });  // inserted 正常 dispatch
if (r === 'failed') logger.error('handoff 底账写入失败，已 fail-safe dispatch', { idempotencyKey }); // failed → 仍 dispatch + 高危告警/指标
```
即 **duplicate 才跳过；failed 一律 fail-safe dispatch（宁可重复也不漏人工）+ 打高危日志/指标**。当前实现已用原生 `upsert(... ignoreDuplicates).select('idempotency_key')` 区分 inserted/duplicate/error。

**迁移期防双 dispatch（P0）**：现有 `request_handoff` 工具**已在工具内 dispatch**（[request-handoff.tool.ts](../../../src/tools/request-handoff.tool.ts#L195)）。outcome 层只处理 booking gate hard-reject 路径；`request_handoff` 在 `TurnOutcome.handoff.alreadyDispatched=true` 时跳过 outcome dispatch，避免重复 pause+告警。后续如需把 request_handoff 也收敛到 outcome 层，可在同一 metadata 契约下迁移。

---

## 三者交互的一处合点

`reject_hard`（HC-3）短路 → 本回合**无对外 reply**（handoff outcome）；此时 HC-1 的 revise 不触发（没有要审的 reply）；HC-4 的记忆二分：**不写"对用户说过"**，但若该回合更早已成功 booking（理论上不会与 hard-reject 同回合，但 modify/cancel 可能），其副作用状态仍按 HC-4(b) 落。三条约束在 outcome 层汇合，由 `TurnOutcome.kind` 统一驱动后续（投递/转人工/记忆）。

---

## 落定检查单（进入实现的门槛）

- [x] HC-1：`isToolSuccess` 用**正向信号**（`success/dispatched/workOrderId`），**不可用 `'errorType' in r`**；`hasCommittedSideEffect` 覆盖 `SIDE_EFFECT_TOOLS`；`GeneratorInvokeParams.toolMode:'scenario'|'readonly'|'none'` + preparation 物理建只读/空 toolset；`reviseFeedback?` + `committedSideEffects?` 已注入；`draft.toolCalls ∪ rewritten.toolCalls` 已用于二次 output guard 审查并随最终 result/outcome 返回。
- [x] HC-2：`CollectedField.provenance` 骨架已建；候选人原文 parser/name gate 已落；jobId 成员判定 `isRecalledJobId(jobId)`/`recalledJobIds:Set` 已落；precheck/booking 的模型入参不构成 jobId/name runtime 准入 evidence。Sponge 全字段 normalizer 与全量 `evaluatePrecheck` 抽纯函数化属于后续增强。
- [x] HC-3：booking jobId gate hard-reject `{shortCircuited,gateRejected,reasonCode}`、runner **any-tool 短路**、`TurnOutcome.handoff`、handoff 底账三态、迁移期 request_handoff 防双 dispatch 均已完成。
