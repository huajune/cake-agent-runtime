/**
 * 运营事件底账（ops_events）写入侧类型。
 *
 * 读取侧（转化分析）由 conversion-analytics 模块独立实现，不复用本文件。
 * 事件清单与 idempotency_key 设计见 docs/product/ops-data-and-sponge-integration.md 三、四章。
 */

/** 13 个蛋糕产品事件名。 */
export const OPS_EVENT_NAMES = [
  'friend.added',
  'agent.opening_sent',
  'candidate.engaged',
  'candidate.message_received',
  'agent.replied',
  'job.recommended',
  'precheck.passed',
  'booking.succeeded',
  'booking.failed',
  'group.invited',
  'handoff.triggered',
  'interview.passed',
  'candidate.hired',
] as const;

export type OpsEventName = (typeof OPS_EVENT_NAMES)[number];

/**
 * 运营事件写入结果（三态）。
 *
 * 调用方据此区分「重复」与「失败」——二者都不是首次插入，但语义截然不同：
 * - `inserted`：本次首次写入（投影 +1）。
 * - `duplicate`：幂等键已存在（DB 可达，业务上已记过，无需重试）。
 * - `failed`：客户端不可用 / 熔断 OPEN / RPC 异常（写入状态未知，**可重试**）。
 *
 * 旧的 boolean 接口（`recordEvent`）把 `duplicate` 与 `failed` 都折叠成 false，
 * 对「首条插入返回值=语义判定」的调用方（如开场白判定）是隐患，故新增本三态接口。
 */
export type OpsEventWriteResult = 'inserted' | 'duplicate' | 'failed';

/** 记录一个运营事件的入参。occurredAt 缺省时由 recorder 取当前时间。 */
export interface RecordOpsEventInput {
  corpId: string;
  eventName: OpsEventName;
  /** 去重键：同 (corpId, eventName, idempotencyKey) 仅记一次。各事件公式见设计文档 3.3。 */
  idempotencyKey: string;
  /** 事件实际发生时间（业务时间）。RPC 内部据此按 Asia/Shanghai 算 report_date。 */
  occurredAt?: Date | string;
  botImId?: string | null;
  managerName?: string | null;
  groupName?: string | null;
  sourceChannel?: string | null;
  userId?: string | null;
  chatId?: string | null;
  payload?: Record<string, unknown> | null;
}

/** 记录候选人消息 + 检测首条破冰的入参。 */
export interface RecordCandidateMessageInput {
  corpId: string;
  chatId: string;
  /** 企微 message_id，作为 candidate.message_received 的幂等键。 */
  messageId: string;
  occurredAt?: Date | string;
  botImId?: string | null;
  managerName?: string | null;
  groupName?: string | null;
  sourceChannel?: string | null;
  userId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface CandidateMessageResult {
  /** candidate.message_received 是否真正写入（false=重复或失败）。 */
  messageRecorded: boolean;
  /** 本条是否触发了首条破冰（candidate.engaged）。 */
  engaged: boolean;
}

/**
 * 待轮询入职状态的工单（已 booking.succeeded、尚未 candidate.hired）。
 * 由 15min 海绵状态轮询 cron 消费，candidate.hired 后即从待轮询集合移除。
 */
export interface PendingHireWorkOrder {
  workOrderId: number;
  corpId: string;
  /** 透传自 booking.succeeded，供 interview.passed/candidate.hired 的 cohort 归属。 */
  userId: string | null;
  chatId: string | null;
  botImId: string | null;
}

/** daily_ops_report 在某时间范围内的计数汇总（仪表盘业务卡 / KPI 用）。 */
export interface DailyOpsReportSums {
  friendsAdded: number;
  openingSent: number;
  breakIce: number;
  candidateMessage: number;
  agentReply: number;
  jobRecommend: number;
  precheckPass: number;
  bookingSuccess: number;
  bookingFail: number;
  groupInvite: number;
  handoff: number;
  interviewPass: number;
  /** 命中的投影行数（=0 表示该范围运营投影尚无数据，调用方据此决定是否回退旧数据源）。 */
  rowCount: number;
}

/** daily_ops_report 单行（每日每 bot 投影），供飞书日报 cron 读取。 */
export interface DailyOpsReportRow {
  report_date: string;
  bot_im_id: string;
  manager_name: string | null;
  group_name: string | null;
  friends_added_count: number;
  agent_opening_sent_count: number;
  break_ice_count: number;
  candidate_message_count: number;
  agent_reply_count: number;
  job_recommend_count: number;
  precheck_pass_count: number;
  booking_success_count: number;
  booking_fail_count: number;
  group_invite_count: number;
  handoff_count: number;
  interview_pass_count: number;
  candidate_summary: string | null;
  booking_brands: string[] | null;
}
