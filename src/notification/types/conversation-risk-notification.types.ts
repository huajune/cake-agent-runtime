import type { WeworkSessionState } from '@memory/types/session-facts.types';

export interface ConversationRiskNotificationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ConversationRiskNotificationPayload {
  riskLabel: string;
  summary: string;
  reason: string;
  botImId?: string;
  contactName?: string;
  chatId: string;
  pausedUserId: string;
  currentMessageContent: string;
  recentMessages: ConversationRiskNotificationMessage[];
  sessionState: WeworkSessionState | null;
}
