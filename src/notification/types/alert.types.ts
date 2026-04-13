import { AlertLevel } from '@enums/alert.enum';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';

export type AlertTrigger = 'http' | 'cron' | 'process' | 'queue' | 'tool' | 'manual';

export interface AlertSource {
  subsystem: string;
  component: string;
  action: string;
  trigger?: AlertTrigger;
}

export interface AlertScope {
  scenario?: string;
  corpId?: string;
  userId?: string;
  contactName?: string;
  chatId?: string;
  sessionId?: string;
  messageId?: string;
  batchId?: string;
}

export type AlertDeliveryState = 'none' | 'partial' | 'fallback_sent' | 'failed';

export interface AlertImpact {
  userMessage?: string;
  fallbackMessage?: string;
  userVisible?: boolean;
  deliveryState?: AlertDeliveryState;
  requiresHumanIntervention?: boolean;
}

export interface AlertDiagnostics {
  error?: Error | string | unknown;
  errorName?: string;
  errorMessage?: string;
  stack?: string;
  category?: string;
  modelChain?: string[];
  totalAttempts?: number;
  messageCount?: number;
  memoryWarning?: string;
  dispatchMode?: string;
  payload?: Record<string, unknown>;
}

export interface AlertRouting {
  atAll?: boolean;
  atUsers?: FeishuReceiver[];
}

export interface AlertDedupe {
  key: string;
}

export interface AlertContext {
  code: string;
  severity?: AlertLevel;
  summary?: string;
  occurredAt?: string;
  source: AlertSource;
  scope?: AlertScope;
  impact?: AlertImpact;
  diagnostics?: AlertDiagnostics;
  routing?: AlertRouting;
  dedupe?: AlertDedupe;
}
