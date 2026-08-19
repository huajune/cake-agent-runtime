import type { WeworkSessionState } from '@memory/types/session-facts.types';

export interface GeneralHandoffNotificationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * 通用人工介入告警 payload。
 *
 * handoff 不区分 onboard/general（见 intervention.service），
 * 本 payload 是人工介入告警的唯一形状，不依赖任何 case 状态机。
 * 适用场景：候选人需要人工介入（无群可拉、流程异常等），事件要交给招募经理跟进，
 * 不能只暂停托管。
 */
export interface GeneralHandoffNotificationPayload {
  alertLabel: string;
  /**
   * 可选：完整覆盖卡片标题。缺省用 `🚨 候选人需人工介入 · {alertLabel}`。
   * 真人介入告警用它沿用原文案标题「🚨 真人介入聊天，已自动暂停托管」。
   */
  titleOverride?: string;
  /**
   * 转人工原因代码：多数来自 request_handoff 的枚举，但部分工具会直接构造 sideEffect 写入
   * 枚举外的值（如 booking 的 interview_group_invite_required），故类型留 string。
   * 卡片据此分时效等级；
   * 缺省（如真人介入告警）不分级。
   */
  reasonCode?: string;
  reason: string;
  actionAdvice?: string;
  /** 关联工单 ID（来自 active_booking）；有值时渲染在候选人信息区。 */
  workOrderId?: number | null;
  /**
   * 岗位数据缺口（salary_admin_inquiry）：候选人问到而岗位字段没有答案的
   * 信息点。有值时卡片渲染「岗位数据缺口」区块（含当前焦点岗位），供运营补录。
   */
  missingJobInfo?: string[];
  /**
   * 调用方所属企业 ID；用于识别测试/调试链路。
   * - 'test'  → TestExecutionService（含所有 badcase 回归批次）
   * - 'debug' → agent.controller /debug-chat
   * - 其他    → 真实企业（业务侧不会取这两个值）
   */
  corpId: string;
  botImId?: string;
  botUserName?: string;
  contactName?: string;
  chatId: string;
  pausedUserId: string;
  currentMessageContent: string;
  recentMessages: GeneralHandoffNotificationMessage[];
  sessionState: WeworkSessionState | null;
  /**
   * 可选：诊断载荷。以 JSON 代码块渲染在卡片末尾，便于排查命中链路
   * （botId / imBotId / imContactId / externalUserId / source / messageType 等原始字段）。
   */
  diagnostics?: Record<string, unknown>;
}
