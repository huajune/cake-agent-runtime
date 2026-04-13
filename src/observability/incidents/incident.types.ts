import { AlertLevel } from '@enums/alert.enum';

export interface IncidentNotification {
  source: string;
  error: unknown;
  title?: string;
  errorType?: string;
  level?: AlertLevel;
  apiEndpoint?: string;
  extra?: Record<string, unknown>;
}
