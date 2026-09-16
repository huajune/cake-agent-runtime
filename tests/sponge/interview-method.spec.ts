import {
  INTERVIEW_METHODS,
  parseInterviewMethod,
  requiresStoreVisit,
} from '@sponge/interview-method';

describe('interview-method（海绵后台四值单选）', () => {
  it('四个枚举值原样归一', () => {
    for (const method of INTERVIEW_METHODS) {
      expect(parseInterviewMethod(method)).toBe(method);
    }
  });

  it('只容忍空白与 ai 大小写差异', () => {
    expect(parseInterviewMethod(' 线下面试 ')).toBe('线下面试');
    expect(parseInterviewMethod('AI 面试')).toBe('AI面试');
    expect(parseInterviewMethod('ai面试')).toBe('AI面试');
  });

  it('枚举外的写法一律 null，不做同义词映射', () => {
    expect(parseInterviewMethod('线上面试')).toBeNull();
    expect(parseInterviewMethod('门店面试')).toBeNull();
    expect(parseInterviewMethod('到店面试')).toBeNull();
    expect(parseInterviewMethod('线上初筛后线下复试')).toBeNull();
    expect(parseInterviewMethod('')).toBeNull();
    expect(parseInterviewMethod(null)).toBeNull();
    expect(parseInterviewMethod(undefined)).toBeNull();
    expect(parseInterviewMethod(3)).toBeNull();
  });

  it('只有线下面试需要到店，未知方式不按到店处理', () => {
    expect(requiresStoreVisit('线下面试')).toBe(true);
    expect(requiresStoreVisit('AI面试')).toBe(false);
    expect(requiresStoreVisit('电话面试')).toBe(false);
    expect(requiresStoreVisit('视频面试')).toBe(false);
    expect(requiresStoreVisit(null)).toBe(false);
    expect(requiresStoreVisit(undefined)).toBe(false);
  });
});
