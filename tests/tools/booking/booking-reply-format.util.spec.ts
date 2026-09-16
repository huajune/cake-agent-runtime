import {
  buildOnSiteScript,
  formatInterviewTimeForReply,
  resolveInterviewReceiptMode,
  resolveManualInterviewGroupHandling,
} from '@tools/booking/booking-reply-format.util';

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
    expect(buildOnSiteScript({ candidateName: '李紫兰', jobName: '前厅服务员' })).toBe(
      '到店跟前台/店长说"独立客招聘介绍来的，姓名 李紫兰，应聘 前厅服务员"',
    );
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

describe('resolveInterviewReceiptMode（海绵四值单选，不读备注分类）', () => {
  it('线下面试才附到店脚本', () => {
    expect(resolveInterviewReceiptMode('线下面试')).toBe('on_site');
  });

  it('AI / 电话 / 视频面试一律远程（生产 chat 6a9f7db6：到店脚本随 AI 面试回执发出）', () => {
    expect(resolveInterviewReceiptMode('AI面试')).toBe('remote');
    expect(resolveInterviewReceiptMode('电话面试')).toBe('remote');
    expect(resolveInterviewReceiptMode('视频面试')).toBe('remote');
  });

  it('面试方式缺失时既不附到店脚本也不附线上提醒', () => {
    expect(resolveInterviewReceiptMode(null)).toBe('unknown');
    expect(resolveInterviewReceiptMode(undefined)).toBe('unknown');
  });
});

describe('resolveManualInterviewGroupHandling', () => {
  it('识别面试群人工补发流程并生成本人连续口径', () => {
    const result = resolveManualInterviewGroupHandling({
      interviewRemark:
        '让人选添加佛山面试群，备注好名字＋手机号码，在群里发腾讯会议链接，请在规定时间入会',
    });

    expect(result).toEqual(
      expect.objectContaining({
        required: true,
        delivery: 'manual',
        groupNameHint: '佛山面试群',
      }),
    );
    expect(result?.candidateGuide).toContain('我这边接着发你邀请');
    expect(result?.candidateGuide).toContain('备注好姓名+手机号');
    expect(result?.candidateGuide).not.toMatch(/工作人员|运营|人工|机器人/);
  });

  it('普通线上面试不触发面试群人工补发', () => {
    expect(
      resolveManualInterviewGroupHandling({
        flowDescription: '面试官先电话沟通，合适后通知下一步',
      }),
    ).toBeNull();
  });
});
