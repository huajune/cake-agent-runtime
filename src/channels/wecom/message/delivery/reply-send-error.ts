import { readHttpFailureCodes, describeHttpFailure } from '@infra/client-http/http-request-error';
import {
  WECOM_SEND_ERROR_CODE,
  WECOM_SEND_FAILURE_REASON,
  type WecomSendFailureReason,
} from '@shared-types/wecom-api.types';

const BEFORE_CONNECTION_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/** Only failures before connecting prove that no send request reached the provider. */
export class ReplySendError extends Error {
  constructor(
    readonly unknownResult: boolean,
    readonly retryable: boolean,
    message: string,
    readonly failureReason?: WecomSendFailureReason,
  ) {
    super(message);
    this.name = 'ReplySendError';
  }
}

export function classifyReplySendError(error: unknown): ReplySendError {
  if (error instanceof ReplySendError) return error;
  const codes = readHttpFailureCodes(error);
  if (codes.providerCode === WECOM_SEND_ERROR_CODE.HOSTING_UNAVAILABLE) {
    // 明确拒收无需立即重试；独立复聊生命周期在托管恢复后续发。
    return new ReplySendError(
      false,
      false,
      describeHttpFailure(error),
      WECOM_SEND_FAILURE_REASON.HOSTING_UNAVAILABLE,
    );
  }
  const beforeConnection =
    codes.httpStatus === undefined && BEFORE_CONNECTION_CODES.has(codes.transportCode ?? '');
  return new ReplySendError(!beforeConnection, beforeConnection, describeHttpFailure(error));
}

export function isRetryableReplyEvidence(detail: string | undefined): boolean {
  const prefix = 'transport_error:';
  return Boolean(
    detail?.startsWith(prefix) && BEFORE_CONNECTION_CODES.has(detail.slice(prefix.length)),
  );
}
