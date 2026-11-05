import {
  describeHttpFailure,
  readHttpFailureCodes,
  safeHttpFailureDetail,
} from '@infra/client-http/http-request-error';
import { sanitizeHttpError } from '@infra/client-http/http-log-sanitizer';

describe('safe HTTP failure diagnostics', () => {
  it.each([
    [429, 'ERR_BAD_REQUEST', 'http_error:429:ERR_BAD_REQUEST'],
    [undefined, 'ETIMEDOUT', 'transport_error:ETIMEDOUT'],
    [undefined, 'ECONNRESET', 'transport_error:ECONNRESET'],
  ])('preserves status/code without retaining Axios context: %s %s', (status, code, detail) => {
    const original = Object.assign(new Error('request failed token=secret-value'), {
      isAxiosError: true,
      code,
      config: { headers: { Authorization: 'secret-value' } },
      request: { body: 'candidate-private-text' },
      response: status ? { status, data: 'candidate-private-text' } : undefined,
    });
    const sanitized = sanitizeHttpError(original, ['secret-value']);
    expect(describeHttpFailure(sanitized)).toBe(detail);
    expect(readHttpFailureCodes(sanitized)).toEqual({
      ...(status ? { httpStatus: status } : {}),
      transportCode: code,
    });
    for (const field of ['config', 'request', 'response', 'cause'])
      expect(sanitized).not.toHaveProperty(field);
    expect(sanitized.stack).not.toContain('secret-value');
    expect(JSON.stringify(sanitized)).not.toContain('candidate-private-text');
  });

  it('ignores malformed codes and free-text persisted evidence', () => {
    expect(
      readHttpFailureCodes(
        Object.assign(new Error('failure'), {
          isAxiosError: true,
          code: 'Bearer secret-value',
          response: { status: 999 },
        }),
      ),
    ).toEqual({});
    expect(safeHttpFailureDetail('provider_business_error:-8')).toBe('provider_business_error:-8');
    expect(safeHttpFailureDetail('http_error:503:ERR_BAD_RESPONSE')).toBe(
      'http_error:503:ERR_BAD_RESPONSE',
    );
    expect(safeHttpFailureDetail('transport_error:ECONNRESET')).toBe('transport_error:ECONNRESET');
    expect(safeHttpFailureDetail('provider_business_error:403; token=secret')).toBeUndefined();
    expect(safeHttpFailureDetail('upstream echoed candidate-private-text')).toBeUndefined();
  });
});
