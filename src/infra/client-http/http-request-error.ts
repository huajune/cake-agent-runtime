import { isAxiosError } from 'axios';
import { ProviderBusinessError } from './provider-business-error';

export interface HttpFailureCodes {
  providerCode?: number;
  httpStatus?: number;
  transportCode?: string;
}

/** Transport codes are an open Node/Axios vocabulary, never upstream response text. */
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]{0,47}$/;

/** A sanitized HTTP failure without request, response, credentials or cause. */
export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly transportCode?: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

export function readHttpFailureCodes(error: unknown): HttpFailureCodes {
  if (error instanceof ProviderBusinessError && Number.isSafeInteger(error.code))
    return { providerCode: error.code };
  const httpStatus =
    error instanceof HttpRequestError
      ? error.httpStatus
      : isAxiosError(error)
        ? error.response?.status
        : undefined;
  const transportCode =
    error instanceof HttpRequestError
      ? error.transportCode
      : isAxiosError(error)
        ? error.code
        : undefined;
  return {
    ...(typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
    ...(typeof transportCode === 'string' && TRANSPORT_CODE.test(transportCode)
      ? { transportCode }
      : {}),
  };
}

/** Keep the existing business-code wire format; HTTP/network diagnostics are additive. */
export function describeHttpFailure(error: unknown): string {
  const codes = readHttpFailureCodes(error);
  if (codes.providerCode !== undefined) return `provider_business_error:${codes.providerCode}`;
  if (codes.httpStatus !== undefined)
    return `http_error:${codes.httpStatus}${codes.transportCode ? `:${codes.transportCode}` : ''}`;
  if (codes.transportCode) return `transport_error:${codes.transportCode}`;
  return 'external_call_did_not_return_terminal_evidence';
}

/** Persisted/adapter evidence may contain free text; only machine codes enter queue alerts. */
export function safeHttpFailureDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string') return undefined;
  if (/^provider_business_error:-?\d{1,16}$/.test(detail)) return detail;
  if (/^http_error:[1-5]\d{2}(?::[A-Z][A-Z0-9_]{0,47})?$/.test(detail)) return detail;
  if (/^transport_error:[A-Z][A-Z0-9_]{0,47}$/.test(detail)) return detail;
  return undefined;
}
