/**
 * 转人工触发底账（handoff_events）写入侧类型。
 *
 * 读取侧（转人工原因/阶段分析）由 conversion-analytics 模块独立实现。
 */
export type HandoffWriteOutcome = 'inserted' | 'duplicate' | 'failed';

export interface RecordHandoffInput {
  corpId: string;
  chatId: string;
  userId?: string | null;
  /** 转人工原因代码（request_handoff 的 8 个枚举之一，text 无约束可扩展）。 */
  reasonCode: string;
  /** Agent 给的原话原因。 */
  reason?: string | null;
  /** Agent 给的建议动作。 */
  actionAdvice?: string | null;
  /** 触发时会话阶段（程序性 currentStage）。 */
  stage?: string | null;
  botImId?: string | null;
  /** modify_appointment 等场景关联的工单 ID（来自 latest_booking）。 */
  workOrderId?: number | null;
  /** 去重键：同 (corpId, idempotencyKey) 仅记一次。 */
  idempotencyKey: string;
  occurredAt?: Date;
}
