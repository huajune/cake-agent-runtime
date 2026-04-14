import {
  AlertContext,
  AlertDiagnostics,
  AlertImpact,
  AlertScope,
  AlertSource,
} from '@notification/types/alert.types';

export interface IncidentNotification {
  source: AlertSource;
  error: unknown;
  code?: string;
  summary?: string;
  severity?: AlertContext['severity'];
  scope?: AlertScope;
  impact?: AlertImpact;
  diagnostics?: Omit<AlertDiagnostics, 'error'>;
  dedupe?: AlertContext['dedupe'];
}
