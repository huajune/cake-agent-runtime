import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';

describe('error.util', () => {
  describe('toErrorMessage', () => {
    it('takes the message from an Error', () => {
      expect(toErrorMessage(new Error('supabase down'))).toBe('supabase down');
    });

    it('stringifies non-Error throwables（第三方 SDK 常抛字符串/对象）', () => {
      expect(toErrorMessage('boom')).toBe('boom');
      expect(toErrorMessage(404)).toBe('404');
      expect(toErrorMessage(null)).toBe('null');
      expect(toErrorMessage(undefined)).toBe('undefined');
    });
  });

  describe('toErrorStack', () => {
    it('prefers the stack when present', () => {
      const error = new Error('boom');
      expect(toErrorStack(error)).toBe(error.stack);
      expect(toErrorStack(error)).toContain('boom');
    });

    it('falls back to the message when the Error carries no stack', () => {
      const error = new Error('no stack here');
      error.stack = undefined;
      expect(toErrorStack(error)).toBe('no stack here');
    });

    it('stringifies non-Error throwables', () => {
      expect(toErrorStack({ code: 500 })).toBe('[object Object]');
    });
  });
});
