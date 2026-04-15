import type { WeworkSessionState } from '@memory/types/session-facts.types';

export type ConversationRiskType = 'abuse' | 'complaint_risk' | 'escalation';

export interface ConversationRiskMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ConversationRiskContext {
  corpId: string;
  chatId: string;
  userId: string;
  pauseTargetId: string;
  messageId: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
  currentMessageContent: string;
  recentMessages: ConversationRiskMessage[];
  sessionState: WeworkSessionState | null;
}

export interface ConversationRiskDetectionResult {
  hit: boolean;
  riskType?: ConversationRiskType;
  riskLabel?: string;
  summary?: string;
  reason?: string;
  matchedKeywords?: string[];
  evidenceMessages?: ConversationRiskMessage[];
  analysisMode?: 'rules' | 'llm';
}

export interface ConversationRiskReviewSignal {
  suggestedRiskType: ConversationRiskType;
  summary: string;
  reason: string;
  matchedKeywords?: string[];
  evidenceMessages: ConversationRiskMessage[];
}

export interface ConversationRiskHandleResult {
  hit: boolean;
  paused: boolean;
  alerted: boolean;
  deduped?: boolean;
  reason?: string;
}
