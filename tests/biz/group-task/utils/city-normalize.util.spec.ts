import { normalizeCity } from '@biz/group-task/utils/city-normalize.util';

describe('normalizeCity', () => {
  it('strips trailing 市 / 省', () => {
    expect(normalizeCity('北京市')).toBe('北京');
    expect(normalizeCity('上海市')).toBe('上海');
    expect(normalizeCity('重庆市')).toBe('重庆');
    expect(normalizeCity('广东省')).toBe('广东');
  });

  it('leaves already-normalized names untouched', () => {
    expect(normalizeCity('北京')).toBe('北京');
    expect(normalizeCity('上海')).toBe('上海');
    expect(normalizeCity('深圳')).toBe('深圳');
  });

  it('trims whitespace', () => {
    expect(normalizeCity(' 北京市 ')).toBe('北京');
    expect(normalizeCity('\t上海\n')).toBe('上海');
  });

  it('handles empty / null / undefined safely', () => {
    expect(normalizeCity('')).toBe('');
    expect(normalizeCity(null)).toBe('');
    expect(normalizeCity(undefined)).toBe('');
  });

  it('removes multi-suffix combinations defensively', () => {
    // 不会真见到 "北京市省" 这类输入，但函数本身得能容忍
    expect(normalizeCity('北京市市')).toBe('北京');
  });
});
