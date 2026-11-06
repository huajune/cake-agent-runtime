import { readHttpFailureCodes, describeHttpFailure } from '@infra/client-http/http-request-error';

const BEFORE_CONNECTION_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/** Only failures before connecting prove that no send request reached the provider. */
export class ReplySendError extends Error {
  constructor(
    readonly unknownResult: boolean,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ReplySendError';
  }
}

export function classifyReplySendError(error: unknown): ReplySendError {
  if (error instanceof ReplySendError) return error;
  const codes = readHttpFailureCodes(error);
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
