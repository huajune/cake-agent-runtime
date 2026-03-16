import { maskApiKey } from '@core/utils/string.util';

describe('string.util', () => {
  describe('maskApiKey', () => {
    describe('should return undefined for invalid inputs', () => {
      it('returns undefined when apiKey is undefined', () => {
        expect(maskApiKey(undefined)).toBeUndefined();
      });

      it('returns undefined when apiKey is null (cast as string)', () => {
        expect(maskApiKey(null as unknown as string)).toBeUndefined();
      });

      it('returns undefined when apiKey is empty string', () => {
        expect(maskApiKey('')).toBeUndefined();
      });

      it('returns undefined when apiKey is not a string (number)', () => {
        expect(maskApiKey(12345 as unknown as string)).toBeUndefined();
      });

      it('returns undefined when apiKey is not a string (object)', () => {
        expect(maskApiKey({} as unknown as string)).toBeUndefined();
      });
    });

    describe('should return "***" for short API keys (<=12 chars)', () => {
      it('masks a 1 character key', () => {
        expect(maskApiKey('a')).toBe('***');
      });

      it('masks a 6 character key', () => {
        expect(maskApiKey('abcdef')).toBe('***');
      });

      it('masks a 12 character key (boundary)', () => {
        expect(maskApiKey('123456789012')).toBe('***');
      });
    });

    describe('should mask API keys longer than 12 characters', () => {
      it('masks a 13 character key (just over boundary)', () => {
        const result = maskApiKey('1234567890123');
        expect(result).toBe('123456...890123');
      });

      it('masks a typical API key format', () => {
        // 'sk-1234567890abcdefghij' = 22 chars
        // first 6: 'sk-123', last 6: 'efghij'
        const result = maskApiKey('sk-1234567890abcdefghij');
        expect(result).toBe('sk-123...efghij');
      });

      it('masks a long API key', () => {
        // 65 chars total, last 6: 'DkwIn0'
        const longKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
        const result = maskApiKey(longKey);
        expect(result).toBe('eyJhbG...DkwIn0');
      });

      it('preserves exactly 6 characters at start and end', () => {
        const result = maskApiKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        expect(result).toBe('ABCDEF...UVWXYZ');
        expect(result?.startsWith('ABCDEF')).toBe(true);
        expect(result?.endsWith('UVWXYZ')).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('handles keys with special characters', () => {
        const result = maskApiKey('sk_live_abc123!@#$%^&*()xyz789');
        expect(result).toBe('sk_liv...xyz789');
      });

      it('handles keys with unicode characters', () => {
        const result = maskApiKey('key-with-emoji-test-data');
        expect(result).toBe('key-wi...t-data');
      });

      it('handles keys with spaces', () => {
        const result = maskApiKey('key with spaces inside it');
        expect(result).toBe('key wi...ide it');
      });
    });
  });
});
