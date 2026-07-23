import {
  buildOnSiteScript,
  formatInterviewTimeForReply,
  isOnlineInterview,
} from '@tools/duliday/booking/booking-reply-format.util';

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

describe('isOnlineInterview (badcase chat 6a5f3080 线上面试误发到店话术)', () => {
  it('detects online from interviewType 线上/视频/电话', () => {
    expect(isOnlineInterview({ interviewType: '线上面试' })).toBe(true);
    expect(isOnlineInterview({ interviewType: '视频面试' })).toBe(true);
    expect(isOnlineInterview({ interviewType: '电话面试' })).toBe(true);
  });

  it('detects online from remark 腾讯会议 signal (badcase 原文形态)', () => {
    expect(
      isOnlineInterview({
        interviewType: null,
        interviewRemark:
          '让人选添加佛山面试群，备注好名字＋手机号码，在群里发腾讯会议链接，请在规定时间入会',
      }),
    ).toBe(true);
  });

  it('detects online from flowDescription 线上面试 signal', () => {
    expect(
      isOnlineInterview({ interviewType: null, flowDescription: '线上面试，24小时出结果' }),
    ).toBe(true);
  });

  it('defaults to offline when no signal at all (keciu6u6 到店脚本不回归)', () => {
    expect(isOnlineInterview({})).toBe(false);
    expect(isOnlineInterview({ interviewType: '到店面试', interviewRemark: '带好健康证' })).toBe(
      false,
    );
  });

  it('explicit offline method wins over online words in remark (混合流程按到店)', () => {
    expect(
      isOnlineInterview({
        interviewType: '线下面试',
        interviewRemark: '先线上初筛，通过后到店复试',
      }),
    ).toBe(false);
  });

  it('does not treat unrelated remark words as online', () => {
    expect(
      isOnlineInterview({ interviewType: null, interviewRemark: '到店找店长，带身份证' }),
    ).toBe(false);
  });

  describe('先电话后到店两段式（badcase 6a608ad4/6a607170 沈阳必胜客双面投诉）', () => {
    it('detects phone-first flow from remark 先电话沟通 (badcase 原文形态)', () => {
      // 岗位面试方式字段未下发（interviewType undefined），信号只在 processRemark 原文里
      expect(
        isOnlineInterview({
          interviewType: undefined,
          interviewRemark: '面试官先电话沟通，合适的会通知线下门店面试',
        }),
      ).toBe(true);
    });

    it('detects phone-first variants 电话初面/电话沟通后', () => {
      expect(isOnlineInterview({ interviewRemark: '电话初面通过后安排到店' })).toBe(true);
      expect(isOnlineInterview({ interviewRemark: '电话沟通后再约门店时间' })).toBe(true);
    });

    it('does NOT misfire on 保持电话畅通 (到店岗常见提醒，keciu6u6 不回归)', () => {
      expect(
        isOnlineInterview({ interviewRemark: '到店面试请保持电话畅通，有变动会电话联系' }),
      ).toBe(false);
    });
  });
});
