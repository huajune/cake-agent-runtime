import { sanitizeBrandName } from '@tools/duliday/sanitize-brand-name.util';

describe('sanitizeBrandName', () => {
  describe('passthrough', () => {
    it('returns input unchanged when no 独立日 present', () => {
      expect(sanitizeBrandName('保险：公司不购买')).toBe('保险：公司不购买');
      expect(sanitizeBrandName('')).toBe('');
    });

    it('keeps 独立客 as-is', () => {
      expect(sanitizeBrandName('我是独立客招聘的')).toBe('我是独立客招聘的');
    });
  });

  describe('natural phrase mapping → 公司', () => {
    it('replaces 独立日购买保险 with 公司购买保险', () => {
      expect(sanitizeBrandName('福利：独立日购买保险')).toBe('福利：公司购买保险');
    });

    it('replaces 独立日不购买 with 公司不购买', () => {
      expect(sanitizeBrandName('保险：独立日不购买')).toBe('保险：公司不购买');
    });

    it('handles 独立日提供 / 不提供 / 承担 / 报销 / 补贴 / 发放 / 安排', () => {
      expect(sanitizeBrandName('独立日提供员工餐')).toBe('公司提供员工餐');
      expect(sanitizeBrandName('住宿：独立日不提供')).toBe('住宿：公司不提供');
      expect(sanitizeBrandName('独立日承担社保费用')).toBe('公司承担社保费用');
      expect(sanitizeBrandName('独立日支付当月工资')).toBe('公司支付当月工资');
      expect(sanitizeBrandName('独立日报销路费')).toBe('公司报销路费');
      expect(sanitizeBrandName('独立日补贴交通')).toBe('公司补贴交通');
      expect(sanitizeBrandName('独立日发放节日福利')).toBe('公司发放节日福利');
      expect(sanitizeBrandName('独立日安排培训')).toBe('公司安排培训');
    });
  });

  describe('fallback → 独立客', () => {
    it('replaces standalone 独立日 with 独立客', () => {
      expect(sanitizeBrandName('我是独立日招聘的')).toBe('我是独立客招聘的');
      expect(sanitizeBrandName('独立日介绍来的')).toBe('独立客介绍来的');
      expect(sanitizeBrandName('就说是独立日推荐的')).toBe('就说是独立客推荐的');
    });

    it('replaces 独立日 followed by punctuation / latin / space', () => {
      expect(sanitizeBrandName('独立日 app 上看到的')).toBe('独立客 app 上看到的');
      expect(sanitizeBrandName('独立日，你们家')).toBe('独立客，你们家');
      expect(sanitizeBrandName('独立日.')).toBe('独立客.');
      expect(sanitizeBrandName('独立日（DuLiDay）')).toBe('独立客（DuLiDay）');
    });

    it('replaces 独立日 at end of string', () => {
      expect(sanitizeBrandName('我们是独立日')).toBe('我们是独立客');
    });
  });

  describe('preservation of legitimate 独立日X compounds', () => {
    it('keeps 独立日报', () => {
      expect(sanitizeBrandName('订阅独立日报')).toBe('订阅独立日报');
    });

    it('keeps 独立日历 / 独立日记 / 独立日志 / 独立日期 / 独立日刊 / 独立日光 / 独立日程', () => {
      expect(sanitizeBrandName('独立日历查询')).toBe('独立日历查询');
      expect(sanitizeBrandName('记在独立日记里')).toBe('记在独立日记里');
      expect(sanitizeBrandName('查看独立日志')).toBe('查看独立日志');
      expect(sanitizeBrandName('选定独立日期')).toBe('选定独立日期');
      expect(sanitizeBrandName('独立日刊出版')).toBe('独立日刊出版');
      expect(sanitizeBrandName('独立日光浴')).toBe('独立日光浴');
      expect(sanitizeBrandName('安排独立日程')).toBe('安排独立日程');
    });
  });

  describe('mixed content', () => {
    it('handles multiple occurrences in one string', () => {
      expect(
        sanitizeBrandName(
          '福利：独立日购买保险，长期稳定后视情况提供员工餐。去门店说独立日介绍来的。',
        ),
      ).toBe('福利：公司购买保险，长期稳定后视情况提供员工餐。去门店说独立客介绍来的。');
    });
  });
});
