import { findCollapsedSameBrand } from '@/channels/wecom/message/utils/same-brand-collapse-guard.util';

describe('findCollapsedSameBrand', () => {
  it('flags badcase laybqxn4 pattern: same brand twice with same wage', () => {
    expect(findCollapsedSameBrand('有肯德基，17-27.5 元、肯德基，17-27.5 元可以选')).toBe(
      '肯德基',
    );
  });

  it('flags 5-char brand collapse', () => {
    expect(findCollapsedSameBrand('成都你六姐有岗、成都你六姐也有岗')).toBe('成都你六姐');
  });

  it('does not flag when store name differentiates same brand', () => {
    expect(
      findCollapsedSameBrand('肯德基绿地缤纷城店时薪 24 元，肯德基徐汇日月光店时薪 26 元'),
    ).toBeNull();
    expect(findCollapsedSameBrand('奥乐齐金山店离你 4.7 公里，奥乐齐徐汇店离你 8 公里')).toBeNull();
  });

  it('does not flag when area marker exists between mentions', () => {
    // 中间有"路/号"等区域标记
    expect(
      findCollapsedSameBrand('肯德基在斜土路那家时薪 24，肯德基在徐汇区方向时薪 26'),
    ).toBeNull();
  });

  it('does not flag when brand mentioned only once', () => {
    expect(findCollapsedSameBrand('有肯德基绿地缤纷城店在招')).toBeNull();
  });

  it('does not flag when brands are far apart (>30 chars between)', () => {
    // 中间填充非重复且无店/路/号等门店标记字的内容；总长跨度 > 30
    const long =
      '肯德基绿地缤纷城店时薪 24 元起。这家会安排培训和上岗指导，福利齐全。' +
      '肯德基徐汇日月光店时薪 26 元起';
    expect(findCollapsedSameBrand(long)).toBeNull();
  });

  it('does not flag for plain repeated phrases that are not brands', () => {
    // 正常重复语：不应误伤（中间有"啊"等非汉字符号也不算分隔）
    // 注意：本检测会对所有 3+ 字汉字片段重复触发；这是已知"宁误杀"取舍。
    // 这里的 case 是想验证至少 2 字内常见词不被误杀（保险线）。
    expect(findCollapsedSameBrand('好的我看一下')).toBeNull();
  });

  it('returns null for empty / short content', () => {
    expect(findCollapsedSameBrand('')).toBeNull();
    expect(findCollapsedSameBrand('好')).toBeNull();
    expect(findCollapsedSameBrand('好的')).toBeNull();
  });
});
