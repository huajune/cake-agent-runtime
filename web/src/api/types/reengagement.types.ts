// ==================== 二次触发追溯类型 ====================

/** 生命周期事件（仅详情接口返回） */
export interface ReengagementEvent {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
}

/** 二次触发触达记录 */
export interface ReengagementTouchRecord {
  /** 幂等键 sessionId:scenarioCode:anchorEventId */
  touch_key: string;
  session_id: string;
  user_id?: string | null;
  corp_id?: string | null;
  candidate_name?: string | null;
  manager_name?: string | null;
  bot_im_id?: string | null;
  scenario_code: string;
  /** 锚点时间（ISO） */
  anchor_at?: string | null;
  status: string;
  decision_reason?: string | null;
  shadow?: boolean | null;
  /** 计划触发时间 */
  fire_at?: string | null;
  scheduled_at?: string | null;
  fired_at?: string | null;
  sent_at?: string | null;
  /** reply / skipped / guardrail_blocked / handoff */
  outcome_kind?: string | null;
  reserve_result?: string | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  /** 投递该触达的主动回合批次 ID（= message_processing_records.message_id），未投递为空 */
  batch_id?: string | null;
  // 仅详情接口返回：
  generated_text?: string | null;
  events?: ReengagementEvent[];
}

/** 分组统计项（status x scenario_code） */
export interface ReengagementStatsItem {
  status: string;
  scenario_code: string;
  cnt: number;
}

/** 候选人某场景的当前态（该场景最新一次触达） */
export interface ReengagementCandidateScenario {
  scenarioCode: string;
  touchKey: string;
  status: string;
  decisionReason?: string | null;
  shadow?: boolean | null;
  fireAt?: string | null;
  sentAt?: string | null;
  outcomeKind?: string | null;
  updatedAt: string;
}

/** 候选人视角行：一行一个候选人（session），带各场景当前态与下一次待发任务 */
export interface ReengagementCandidateSummary {
  sessionId: string;
  userId?: string | null;
  corpId?: string | null;
  /** 候选人微信昵称（可能为空，回退显示 userId/sessionId） */
  candidateName?: string | null;
  /** 接管 bot 显示名（招募经理名） */
  managerName?: string | null;
  /** 接管 bot 系统 wxid */
  botImId?: string | null;
  /** 全场景最新活动时间（ISO，候选人排序键） */
  latestAt: string;
  /** 最近的一个待发任务（scheduled/rescheduled 且 fire_at 未到）；无则 null */
  nextTouch: { scenarioCode: string; touchKey: string; fireAt: string } | null;
  scenarios: ReengagementCandidateScenario[];
}

/** 候选人视角分页响应 */
export interface ReengagementCandidateOverview {
  total: number;
  candidates: ReengagementCandidateSummary[];
}

/** 复聊场景注册表条目（只读，来自后端 scenario-registry） */
export interface ReengagementScenario {
  code: string;
  /** 所属大阶段：报名后场景受 reengagementPostBookingEnabled 大开关额外约束 */
  phase: 'pre_booking' | 'post_booking';
  displayName: string;
  anchorEvent: string;
  anchorLabel: string;
  delayLabel: string;
  objective: string;
  generationPolicy: string;
  /** 场景级灰度默认值：运行时以托管配置 reengagementScenarioRollout 为准 */
  defaultRolloutEnabled: boolean;
}
