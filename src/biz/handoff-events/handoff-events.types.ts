/**
 * 转人工触发底账（handoff_events）写入侧类型。
 *
 * 读取侧（转人工原因/阶段分析）由 conversion-analytics 模块独立实现。
 */
export type HandoffWriteOutcome = 'inserted' | 'duplicate' | 'failed';

/**
 * 介入来源标记（落 ops_events(handoff.triggered).payload.origin；handoff_events 表无独立列，
 * 同一来源的底账行还可按 idempotency_key 的 scope 段区分）。
 *
 * - agent_tool             request_handoff 工具
 * - output_guardrail       出站守卫无法安全放行
 * - input_guardrail        入站风险预检（辱骂/投诉/主动要人工/残障披露/结果追问）
 * - risk_alert_tool        raise_risk_alert 工具（模型语义判定的会话风险）
 * - promise_reconciliation 回复承诺「让同事跟进」但未调工具，终态对账补的介入
 * - tool_failure           取消/改约工具失败时自带的转人工
 * - booking_failure        报名工具失败暂停托管（只记底账不再重复告警）
 * - reengagement           复聊/入职巡检链路
 */
export type HandoffEventOrigin =
  | 'agent_tool'
  | 'output_guardrail'
  | 'input_guardrail'
  | 'risk_alert_tool'
  | 'promise_reconciliation'
  | 'tool_failure'
  | 'booking_failure'
  | 'reengagement';

export interface RecordHandoffInput {
  corpId: string;
  chatId: string;
  userId?: string | null;
  /** 转人工原因代码（request_handoff 的枚举之一，text 无约束可扩展）。 */
  reasonCode: string;
  /** Agent 给的原话原因。 */
  reason?: string | null;
  /** Agent 给的建议动作。 */
  actionAdvice?: string | null;
  /** 岗位数据缺口（salary_admin_inquiry）：落 handoff_events.missing_job_info + ops_events payload。 */
  missingJobInfo?: string[] | null;
  /** 触发时会话阶段（程序性 currentStage）。 */
  stage?: string | null;
  botImId?: string | null;
  /** modify_appointment 等场景关联的工单 ID（来自 active_booking）。 */
  workOrderId?: number | null;
  /**
   * 转人工当轮的焦点岗位 jobId：落 handoff_events.job_id + ops_events payload。
   *
   * 运营的「岗位数据缺口榜」「满岗信号榜」按它定位该改哪个岗位。无焦点岗位
   * （纯闲聊、开场即转人工）时为 null，属正常缺失。
   */
  jobId?: number | null;
  /** 介入来源标记；缺省按 agent_tool 记。 */
  origin?: HandoffEventOrigin | null;
  /** 去重键：同 (corpId, idempotencyKey) 仅记一次。 */
  idempotencyKey: string;
  occurredAt?: Date;
}
