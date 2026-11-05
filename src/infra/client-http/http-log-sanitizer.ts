import { ProviderBusinessError } from './provider-business-error';
import { HttpRequestError, readHttpFailureCodes } from './http-request-error';

const REDACTED = '[REDACTED]';
const SENSITIVE_QUERY_KEY =
  /^(?:token|accesstoken|refreshtoken|idtoken|apikey|key|secret|clientsecret|password|passwd|authorization|auth|signature|sig|credential)$/i;

/** Log-only copy: never alter the URL sent to the provider. */
export function redactHttpUrl(url: string): string {
  return url
    .replace(/(\/\/)[^/?#@]*@/g, `$1${REDACTED}@`)
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator: string, key: string) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        // An invalid key cannot safely be classified; omit its value from logs.
        return `${separator}${key}=${REDACTED}`;
      }
      const normalized = decoded.replace(/[^a-z0-9]/gi, '');
      return SENSITIVE_QUERY_KEY.test(normalized) ? `${separator}${key}=${REDACTED}` : match;
    });
}

/** Remove known credentials even when an upstream error echoes them outside a URL. */
export function redactHttpErrorText(text: string, secrets: readonly string[]): string {
  let sanitized = text;
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
  }
  for (const secret of [...forms].sort((left, right) => right.length - left.length))
    sanitized = sanitized.split(secret).join(REDACTED);
  return redactHttpUrl(sanitized);
}

/** Public send errors must not carry Axios request/response objects or a secret-bearing cause. */
export function sanitizeHttpError(error: unknown, secrets: readonly string[] = []): Error {
  if (error instanceof Error) {
    const message = redactHttpErrorText(error.message, secrets);
    if (error instanceof ProviderBusinessError && Number.isSafeInteger(error.code))
      return new ProviderBusinessError(error.code, message);
    const codes = readHttpFailureCodes(error);
    if (codes.httpStatus !== undefined || codes.transportCode !== undefined)
      return new HttpRequestError(message, codes.httpStatus, codes.transportCode);
    const stack = error.stack ?? '';
    const carriesContext = Object.getOwnPropertyNames(error).some(
      (key) => !['name', 'message', 'stack'].includes(key),
    );
    if (
      !carriesContext &&
      message === error.message &&
      redactHttpErrorText(stack, secrets) === stack &&
      redactHttpErrorText(error.name, secrets) === error.name
    )
      return error;
    // No cause: it would retain the original request and its credentials for downstream logging.
    return new Error(message);
  }
  return new Error(
    typeof error === 'string' ? redactHttpErrorText(error, secrets) : 'HTTP request failed',
  );
}
