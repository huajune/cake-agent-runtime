/**
 * 二次触发（reengagement 复聊）触达追溯记录
 *
 * 一行 = 一次触达的完整生命周期（touch_key 幂等），随状态推进原地更新，
 * events 数组保留全轨迹。对应表 reengagement_touch_records。
 */

/** 生命周期状态（列表页终态摘要，值与 DB status 列一致） */
export enum ReengagementTouchStatus {
  /** 已排程，等待到点 */
  Scheduled = 'scheduled',
  /** 排程前预检停止（未入队） */
  Skipped = 'skipped',
  /** 到点时总开关关闭，丢弃 */
  Disabled = 'disabled',
  /** 到点时停止条件命中（候选人已回话/已终态/场景不再成立） */
  Stopped = 'stopped',
  /** 频控丢弃（24h 已达上限） */
  FrequencyBlocked = 'frequency_blocked',
  /** 9-21 窗口外，改期等待新到点 */
  Rescheduled = 'rescheduled',
  /** Redis 触达槽撞重（已发过/在途），跳过 */
  Duplicate = 'duplicate',
  /** shadow 分支：生成了文案但不投递（终态） */
  Shadow = 'shadow',
  /** 已投递 */
  Sent = 'sent',
  /** 生成非 reply、入队失败或投递明确失败 */
  Failed = 'failed',
  /** 投递后状态不明，需人工核对渠道侧 */
  Unknown = 'unknown',
}

/** 状态流转事件名（events 数组元素的 event 字段，值与 DB 落库一致） */
export enum ReengagementTouchEventName {
  Scheduled = 'scheduled',
  SchedulePrecheckStopped = 'schedule_precheck_stopped',
  EnqueueError = 'enqueue_error',
  FiredButDisabled = 'fired_but_disabled',
  Stopped = 'stopped',
  FrequencyBlocked = 'frequency_blocked',
  RescheduledOutOfWindow = 'rescheduled_out_of_window',
  ShadowGenerated = 'shadow_generated',
  ReserveDuplicate = 'reserve_duplicate',
  Reserved = 'reserved',
  OutcomeNotReply = 'outcome_not_reply',
  DeliveryAttempted = 'delivery_attempted',
  Sent = 'sent',
  DeliveryUnknown = 'delivery_unknown',
}

/** 状态流转轨迹项（events jsonb 数组元素） */
export interface ReengagementTouchEvent {
  /** ISO 时间戳 */
  at: string;
  /** 事件名（见 ReengagementTouchEventName） */
  event: ReengagementTouchEventName | string;
  /** 附加信息（原因、新 fireAt、reserve 结果等） */
  detail?: Record<string, unknown>;
}

/** DB 行（snake_case，与表结构一致） */
export interface ReengagementTouchDbRecord {
  id?: number;
  created_at?: string;
  updated_at?: string;
  touch_key: string;
  session_id: string;
  user_id?: string | null;
  corp_id?: string | null;
  scenario_code: string;
  anchor_event_id?: string | null;
  anchor_at?: string | null;
  job_id?: string | null;
  status: ReengagementTouchStatus;
  decision_reason?: string | null;
  shadow?: boolean | null;
  fire_at?: string | null;
  scheduled_at?: string | null;
  fired_at?: string | null;
  sent_at?: string | null;
  outcome_kind?: string | null;
  generated_text?: string | null;
  reserve_result?: string | null;
  error?: string | null;
  events?: ReengagementTouchEvent[];
}

/** 单次落库调用的输入：非空字段覆盖对应列，event 追加到轨迹 */
export interface RecordReengagementTouchInput {
  touchKey: string;
  sessionId?: string;
  userId?: string;
  corpId?: string;
  scenarioCode?: string;
  anchorEventId?: string;
  anchorAt?: number;
  jobId?: string;
  status?: ReengagementTouchStatus;
  decisionReason?: string;
  shadow?: boolean;
  fireAt?: number;
  scheduledAt?: number;
  firedAt?: number;
  sentAt?: number;
  outcomeKind?: string;
  generatedText?: string;
  reserveResult?: string;
  error?: string;
  event?: { event: string; detail?: Record<string, unknown> };
}

/** 列表查询筛选条件 */
export interface ReengagementTouchFilters {
  startDate?: string;
  endDate?: string;
  status?: ReengagementTouchStatus;
  scenarioCode?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

/** 统计 RPC 返回行 */
export interface ReengagementTouchStatsRow {
  status: string;
  scenario_code: string;
  cnt: number;
}

/** 候选人视角查询筛选条件 */
export interface ReengagementCandidateFilters {
  startDate?: string;
  endDate?: string;
  scenarioCode?: string;
  sessionId?: string;
  /** 只看有待发任务（scheduled/rescheduled 且 fire_at 未到）的候选人 */
  pendingOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** 候选人视角 RPC 返回行：每 (session, scenario) 最新一次触达 + 分页元信息 */
export interface ReengagementCandidateOverviewRow {
  session_id: string;
  user_id: string | null;
  corp_id: string | null;
  scenario_code: string;
  touch_key: string;
  status: string;
  decision_reason: string | null;
  shadow: boolean | null;
  fire_at: string | null;
  sent_at: string | null;
  anchor_at: string | null;
  outcome_kind: string | null;
  updated_at: string;
  /** 该候选人全场景的最新活动时间（候选人排序键） */
  session_latest_at: string;
  /** 满足筛选的候选人总数（窗口计数，每行相同） */
  total_sessions: number;
}

/** 候选人视角聚合结果（服务层按 session 分组后的形态） */
export interface ReengagementCandidateSummary {
  sessionId: string;
  userId: string | null;
  corpId: string | null;
  /** 全场景最新活动时间（ISO） */
  latestAt: string;
  /** 最近的一个待发任务（scheduled/rescheduled 且 fire_at 未到）；无则 null */
  nextTouch: { scenarioCode: string; touchKey: string; fireAt: string } | null;
  /** 各场景当前态（每场景最新一次触达），按场景 code 排序 */
  scenarios: Array<{
    scenarioCode: string;
    touchKey: string;
    status: string;
    decisionReason: string | null;
    shadow: boolean | null;
    fireAt: string | null;
    sentAt: string | null;
    outcomeKind: string | null;
    updatedAt: string;
  }>;
}
