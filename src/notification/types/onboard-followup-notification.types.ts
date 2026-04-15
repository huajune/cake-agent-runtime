import type { WeworkSessionState } from '@memory/types/session-facts.types';
import type { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';

export interface OnboardFollowupNotificationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface OnboardFollowupNotificationPayload {
  alertLabel: string;
  reason: string;
  botImId?: string;
  botUserName?: string;
  contactName?: string;
  chatId: string;
  pausedUserId: string;
  currentMessageContent: string;
  recentMessages: OnboardFollowupNotificationMessage[];
  sessionState: WeworkSessionState | null;
  recruitmentCase: RecruitmentCaseRecord;
}
