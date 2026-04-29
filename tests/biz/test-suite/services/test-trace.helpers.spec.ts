import {
  coerceMemoryAssertions,
  coerceMemorySetup,
  normalizeIdList,
  normalizeSourceTrace,
  parseJsonObject,
  stringifyTraceJson,
} from '@biz/test-suite/services/test-trace.helpers';

describe('test-trace.helpers', () => {
  describe('normalizeIdList', () => {
    it('should split mixed separators, trim values, and deduplicate ids', () => {
      expect(normalizeIdList(['bad-1, bad-2', 'bad-1；bad-3|bad-4', null])).toEqual([
        'bad-1',
        'bad-2',
        'bad-3',
        'bad-4',
      ]);
    });

    it('should return an empty list for empty input', () => {
      expect(normalizeIdList(undefined)).toEqual([]);
      expect(normalizeIdList(null)).toEqual([]);
      expect(normalizeIdList(' , ; | ')).toEqual([]);
    });
  });

  describe('normalizeSourceTrace', () => {
    it('should merge nested and legacy source trace fields into a compact trace', () => {
      expect(
        normalizeSourceTrace({
          sourceTrace: {
            badcaseIds: ['bad-1'],
            chatIds: ['chat-1'],
            raw: { existing: true, emptyList: [] },
          },
          sourceBadCaseIds: ['bad-1,bad-2'],
          sourceChatIds: ['chat-2'],
          sourceAnchorMessageIds: ['msg-1；msg-2'],
          sourceTraceIds: ['trace-1', 'trace-1'],
          raw: { importedBy: 'feishu', emptyObject: {} },
        }),
      ).toEqual({
        badcaseIds: ['bad-1', 'bad-2'],
        chatIds: ['chat-1', 'chat-2'],
        anchorMessageIds: ['msg-1', 'msg-2'],
        traceIds: ['trace-1'],
        raw: {
          existing: true,
          importedBy: 'feishu',
        },
      });
    });

    it('should return null when no trace fields survive compaction', () => {
      expect(normalizeSourceTrace({ raw: {}, notes: [] })).toBeNull();
      expect(normalizeSourceTrace(null)).toBeNull();
    });
  });

  describe('stringifyTraceJson', () => {
    it('should stringify compacted trace-like values', () => {
      expect(
        stringifyTraceJson({
          badcaseIds: ['bad-1'],
          raw: { keep: 'value', drop: undefined, empty: [] },
        }),
      ).toBe('{\n  "badcaseIds": [\n    "bad-1"\n  ],\n  "raw": {\n    "keep": "value"\n  }\n}');
    });

    it('should return null for empty values', () => {
      expect(stringifyTraceJson(undefined)).toBeNull();
      expect(stringifyTraceJson({ empty: [], nested: {} })).toBeNull();
    });
  });

  describe('parseJsonObject', () => {
    it('should parse JSON objects and reject non-object JSON', () => {
      expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
      expect(parseJsonObject('[1,2]')).toBeNull();
      expect(parseJsonObject('"text"')).toBeNull();
    });

    it('should return null for blank or invalid JSON', () => {
      expect(parseJsonObject('')).toBeNull();
      expect(parseJsonObject('not-json')).toBeNull();
      expect(parseJsonObject(null)).toBeNull();
    });
  });

  describe('memory fixture coercion', () => {
    it('should accept object fixtures and reject arrays or scalars', () => {
      const setup = { currentStage: 'job_matching' };
      const assertions = { mustRecall: ['上海'] };

      expect(coerceMemorySetup(setup)).toBe(setup);
      expect(coerceMemorySetup([])).toBeNull();
      expect(coerceMemorySetup('stage')).toBeNull();
      expect(coerceMemoryAssertions(assertions)).toBe(assertions);
      expect(coerceMemoryAssertions([])).toBeNull();
      expect(coerceMemoryAssertions(null)).toBeNull();
    });
  });
});
