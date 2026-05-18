import {
  buildOnSiteScript,
  formatInterviewTimeForReply,
} from '@tools/duliday/booking-reply-format.util';

describe('formatInterviewTimeForReply', () => {
  it('formats YYYY-MM-DD HH:mm:ss to natural Chinese with weekday', () => {
    // 2026-05-19 是周二（用真实日历核对）
    expect(formatInterviewTimeForReply('2026-05-19 13:30:00')).toBe('5月19日（周二）13:30');
  });

  it('drops leading zeros from month/day but keeps HH:mm padding', () => {
    expect(formatInterviewTimeForReply('2026-01-05 09:05:00')).toBe('1月5日（周一）09:05');
  });

  it('passes through unrecognized format as-is', () => {
    expect(formatInterviewTimeForReply('明天下午')).toBe('明天下午');
    expect(formatInterviewTimeForReply('2026/05/19 13:30')).toBe('2026/05/19 13:30');
  });
});

describe('buildOnSiteScript', () => {
  it('embeds candidate name + job name and 独立客 self-reference (badcase keciu6u6)', () => {
    expect(
      buildOnSiteScript({ candidateName: '李紫兰', jobName: '前厅服务员' }),
    ).toBe('到店跟前台/店长说"独立客招聘介绍来的，姓名 李紫兰，应聘 前厅服务员"');
  });

  it('uses 独立客 not 独立日 (memory: brand-name canon)', () => {
    const script = buildOnSiteScript({ candidateName: '张三', jobName: '洗碗工' });
    expect(script).toContain('独立客');
    expect(script).not.toContain('独立日');
  });

  it('skips missing candidateName gracefully', () => {
    expect(buildOnSiteScript({ candidateName: '', jobName: '服务员' })).toBe(
      '到店跟前台/店长说"独立客招聘介绍来的，应聘 服务员"',
    );
    expect(buildOnSiteScript({ candidateName: null, jobName: '服务员' })).toBe(
      '到店跟前台/店长说"独立客招聘介绍来的，应聘 服务员"',
    );
  });

  it('skips missing jobName gracefully', () => {
    expect(buildOnSiteScript({ candidateName: '张三', jobName: null })).toBe(
      '到店跟前台/店长说"独立客招聘介绍来的，姓名 张三"',
    );
  });

  it('returns at least the self-reference when both fields are missing', () => {
    expect(buildOnSiteScript({ candidateName: null, jobName: null })).toBe(
      '到店跟前台/店长说"独立客招聘介绍来的"',
    );
  });
});
