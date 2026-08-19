import { asArray, asRecord, asRecordArray, isRecord, stripNullish } from '@infra/utils/object.util';

describe('stripNullish', () => {
  it('should remove null and undefined fields', () => {
    expect(stripNullish({ a: null, b: undefined, c: 'keep' })).toEqual({ c: 'keep' });
  });

  it('should remove empty strings', () => {
    expect(stripNullish({ a: '', b: 'hello' })).toEqual({ b: 'hello' });
  });

  it('should preserve 0 and false', () => {
    expect(stripNullish({ a: 0, b: false, c: null })).toEqual({ a: 0, b: false });
  });

  it('should remove empty arrays', () => {
    expect(stripNullish({ a: [], b: [1, 2] })).toEqual({ b: [1, 2] });
  });

  it('should remove objects that become empty after recursive cleaning', () => {
    expect(stripNullish({ a: { b: null, c: undefined }, d: 'keep' })).toEqual({ d: 'keep' });
  });

  it('should recursively clean nested objects', () => {
    const input = {
      name: 'test',
      meta: { score: 0, note: '', nested: { empty: null, value: 42 } },
    };
    expect(stripNullish(input)).toEqual({
      name: 'test',
      meta: { score: 0, nested: { value: 42 } },
    });
  });

  it('should clean arrays by removing empty items', () => {
    expect(stripNullish([null, 'a', '', undefined, 'b'])).toEqual(['a', 'b']);
  });

  it('should clean objects inside arrays', () => {
    const input = [{ a: null, b: 1 }, { c: null }, { d: 'ok' }];
    expect(stripNullish(input)).toEqual([{ b: 1 }, { d: 'ok' }]);
  });

  it('should return primitives as-is', () => {
    expect(stripNullish(42)).toBe(42);
    expect(stripNullish('hello')).toBe('hello');
    expect(stripNullish(true)).toBe(true);
    expect(stripNullish(false)).toBe(false);
    expect(stripNullish(0)).toBe(0);
  });

  it('should return null/undefined as-is (top-level)', () => {
    expect(stripNullish(null)).toBeNull();
    expect(stripNullish(undefined)).toBeUndefined();
  });

  it('should handle deeply nested structures', () => {
    const input = { a: { b: { c: { d: null } } }, e: 'keep' };
    expect(stripNullish(input)).toEqual({ e: 'keep' });
  });
});

describe('isRecord', () => {
  it('普通对象为真', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('null / 数组 / primitive 为假', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord(false)).toBe(false);
  });
});

describe('asRecord', () => {
  it('普通对象原样返回（同一引用）', () => {
    const input = { a: 1 };
    expect(asRecord(input)).toBe(input);
  });

  it('null / 数组 / primitive 一律降级为 null', () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord('')).toBeNull();
    expect(asRecord(0)).toBeNull();
    expect(asRecord(NaN)).toBeNull();
  });
});

describe('asRecordArray', () => {
  it('逐元素收窄，非对象元素丢弃', () => {
    expect(asRecordArray([{ a: 1 }, null, 'x', [1], { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('非数组输入返回空数组', () => {
    expect(asRecordArray({ a: 1 })).toEqual([]);
    expect(asRecordArray(null)).toEqual([]);
    expect(asRecordArray(undefined)).toEqual([]);
  });
});

describe('asArray', () => {
  it('数组原样返回（同一引用）', () => {
    const input = [1, 2];
    expect(asArray(input)).toBe(input);
  });

  it('非数组降级为空数组', () => {
    expect(asArray({ a: 1 })).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray('abc')).toEqual([]);
  });
});
