import type { WeworkSessionState } from '@memory/types/session-facts.types';

export interface GeneralHandoffNotificationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * 通用人工介入告警 payload。
 *
 * 与 OnboardFollowup 区别：**不依赖 recruitmentCase**。
 * 适用场景：候选人需要人工介入（无群可拉、流程异常等）但当前会话还没有
 * onboard_followup case 时——比如 `request_handoff` 在 no_active_case 分支
 * 仍要把事件交给招募经理跟进，不能只暂停托管。
 */
export interface GeneralHandoffNotificationPayload {
  alertLabel: string;
  reason: string;
  summary?: string;
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
}
