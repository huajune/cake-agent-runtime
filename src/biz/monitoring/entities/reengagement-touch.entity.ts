/**
 * 二次触发（reengagement 复聊）触达追溯记录
 *
 * 一行 = 一次触达的完整生命周期（touch_key 幂等），随状态推进原地更新，
 * events 数组保留全轨迹。对应表 reengagement_touch_records。
 */

/** 生命周期状态（列表页终态摘要） */
export type ReengagementTouchStatus =
  | 'scheduled' // 已排程，等待到点
  | 'skipped' // 排程前预检停止（未入队）
  | 'disabled' // 到点时总开关关闭，丢弃
  | 'stopped' // 到点时停止条件命中（候选人已回话/已终态/场景不再成立）
  | 'frequency_blocked' // 频控丢弃（24h 已达上限）
  | 'rescheduled' // 9-21 窗口外，改期等待新到点
  | 'duplicate' // Redis 触达槽撞重（已发过/在途），跳过
  | 'shadow' // shadow 分支：生成了文案但不投递（终态）
  | 'sent' // 已投递
  | 'failed' // 生成非 reply、入队失败或投递明确失败
  | 'unknown'; // 投递后状态不明，需人工核对渠道侧

/** 状态流转轨迹项（events jsonb 数组元素） */
export interface ReengagementTouchEvent {
  /** ISO 时间戳 */
  at: string;
  /** 事件名：scheduled / fired / stopped / delivery_attempted / sent ... */
  event: string;
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
