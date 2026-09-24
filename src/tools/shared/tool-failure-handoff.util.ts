import type { ToolBuildContext } from '@shared-types/tool.types';
import { HANDOFF_REASON_LABELS } from '@enums/handoff-reason.enum';

/**
 * 取消/改约工具失败时自带的转人工副作用（PRD R5.1 第 1 条）。
 *
 * 此前失败回执同时要求模型「说一句『我让同事帮你确认一下』」并「调 request_handoff」——后者一调用
 * 本轮就无回复，两条互斥；模型多数选了说话不调工具，运行时再按承诺对账补一次 other 介入，
 * 岗位/工单/阶段全空。现在失败回执直接携带 general_handoff 意图：由 outcome 统一出口在回复投递后
 * 落底账 + 暂停 + 告警（原因码 modify_appointment，带工单号/岗位/失败原因），模型只需如实告知。
 *
 * 不传 idempotencyKey：统一出口按 `${chatId}:handoff:${traceId}` 生成，同一工单隔天再失败仍能触发。
 */
export interface ToolFailureHandoffSideEffect {
  kind: 'general_handoff';
  source: 'agent_tool';
  origin: 'tool_failure';
  alertLabel: string;
  reasonCode: 'modify_appointment';
  reason: string;
  actionAdvice: string;
  workOrderId: number;
  jobId: number | null;
  stage: string | null;
  botImId?: string;
  recordHandoff: true;
}

export function buildToolFailureHandoffSideEffect(params: {
  context: ToolBuildContext;
  action: '取消' | '改约';
  workOrderId: number;
  errorType: string;
  failureReason: string;
  /** 改约场景：候选人想改到的新时间，写进 reason 让运营直接照办。 */
  requestedInterviewTime?: string;
}): ToolFailureHandoffSideEffect {
  const { context, action, workOrderId } = params;
  const jobId =
    context.archive.currentFocusJob?.jobId ?? context.archive.activeBookingJobIds?.[0] ?? null;
  const candidateMessage = context.turnInput.currentUserMessage?.trim();
  const reasonParts = [
    `候选人要求${action}工单 ${workOrderId}，自助${action}失败（${params.errorType}：${params.failureReason}）`,
  ];
  if (params.requestedInterviewTime) reasonParts.push(`想改到：${params.requestedInterviewTime}`);
  if (candidateMessage) reasonParts.push(`候选人原话：「${candidateMessage.slice(0, 200)}」`);
  return {
    kind: 'general_handoff',
    source: 'agent_tool',
    origin: 'tool_failure',
    alertLabel: HANDOFF_REASON_LABELS.modify_appointment ?? '改约/取消自助失败',
    reasonCode: 'modify_appointment',
    reason: reasonParts.join('｜'),
    actionAdvice: `请在海绵后台手动${action}工单 ${workOrderId}，并回复候选人结果。`,
    workOrderId,
    jobId,
    stage: context.archive.currentStage ?? null,
    botImId: context.session.botImId,
    recordHandoff: true,
  };
}

/** 报名失败的原因码：海绵拒绝语义能分出名额满/重复报名，其余算系统卡点（T6）。 */
export function classifyBookingFailure(
  result: Record<string, unknown> | undefined,
): 'duplicate_signup' | 'booking_capacity_full' | 'system_blocked' {
  const message = [result?.apiMessage, result?.reason, result?._outcome, result?.message]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join(' ');
  if (/已报名|重复报名/u.test(message)) return 'duplicate_signup';
  if (/上限|已满|名额/u.test(message)) return 'booking_capacity_full';
  return 'system_blocked';
}

/**
 * 报名失败只记底账、不再重复告警的介入意图（PRD R5.2「报名失败类介入先落介入底账」）。
 *
 * booking 工具失败时已自行暂停托管并发过预约失败卡片（28 天 82 张不在 handoff_events 里），
 * 这里用 recordOnly 让 outcome 出口只写 handoff_events / ops_events，不再暂停、不再发第二张卡。
 * 幂等键与 booking.failed 运营事件同源（会话 + 岗位 + 时段）。
 */
export interface BookingFailureRecordIntent {
  kind: 'general_handoff';
  source: 'agent_tool';
  origin: 'booking_failure';
  alertLabel: string;
  reasonCode: ReturnType<typeof classifyBookingFailure>;
  reason: string;
  actionAdvice: string;
  workOrderId: null;
  jobId: number;
  stage: string | null;
  botImId?: string;
  idempotencyKey: string;
  recordHandoff: true;
  recordOnly: true;
}

export function buildBookingFailureRecordIntent(params: {
  context: ToolBuildContext;
  jobId: number;
  interviewTime: string | undefined;
  errorType: string;
  failureReason: string;
}): BookingFailureRecordIntent {
  const { context, jobId } = params;
  const reasonCode = classifyBookingFailure({ message: params.failureReason });
  const candidateMessage = context.turnInput.currentUserMessage?.trim();
  const reasonParts = [`报名提交失败（${params.errorType}：${params.failureReason}）`];
  if (candidateMessage) reasonParts.push(`候选人原话：「${candidateMessage.slice(0, 200)}」`);
  return {
    kind: 'general_handoff',
    source: 'agent_tool',
    origin: 'booking_failure',
    alertLabel: HANDOFF_REASON_LABELS[reasonCode] ?? '报名失败',
    reasonCode,
    reason: reasonParts.join('｜'),
    actionAdvice: '报名工具已暂停托管并发过预约失败卡片；本条只记底账，按卡片处理即可。',
    workOrderId: null,
    jobId,
    stage: context.archive.currentStage ?? null,
    botImId: context.session.botImId,
    idempotencyKey: `${context.session.sessionId}:booking_failed:${jobId}:${params.interviewTime ?? 'wait_notice'}`,
    recordHandoff: true,
    recordOnly: true,
  };
}

/** 失败回执给模型的统一指令：如实说暂时处理不了、已转同事，不再要求调 request_handoff。 */
export function buildToolFailureReplyInstruction(action: '取消' | '改约'): string {
  return (
    `${action}未成功，这边已自动转给同事跟进（不要再调用 request_handoff，也不要重试${action}）。` +
    `请以真人招募者口吻如实告诉候选人：这次${action}我这边暂时处理不了，已经转给同事跟进，稍后会联系你；` +
    `不要透露接口报错/技术细节，不要谎称已${action}。`
  );
}
