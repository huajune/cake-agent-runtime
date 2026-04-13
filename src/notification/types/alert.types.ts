import { AlertLevel } from '@enums/alert.enum';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';

export interface AlertContext {
  errorType: string;
  error?: Error | string | unknown;
  conversationId?: string;
  userMessage?: string;
  contactName?: string;
  apiEndpoint?: string;
  fallbackMessage?: string;
  scenario?: string;
  extra?: Record<string, unknown>;
  level?: AlertLevel;
  title?: string;
  message?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
  atAll?: boolean;
  atUsers?: FeishuReceiver[];
}
