import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { BookingCardRenderer } from '@notification/renderers/booking-card.renderer';

describe('BookingCardRenderer', () => {
  let renderer: BookingCardRenderer;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

  beforeEach(() => {
    cardBuilder = {
      buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
    } as unknown as jest.Mocked<FeishuCardBuilderService>;

    renderer = new BookingCardRenderer(cardBuilder);
  });

  it('should render success booking cards with normalized interview time', () => {
    const result = renderer.buildInterviewBookingCard({
      contactName: 'wx_alice',
      candidateName: 'Alice',
      phone: '13800138000',
      genderLabel: '女',
      ageText: '23岁',
      botUserName: '招募经理A',
      brandName: '来伊份',
      storeName: '五角场店',
      jobName: '店员',
      jobId: 88,
      interviewTime: '2026-04-13 07:30:00',
      toolOutput: {
        success: true,
        message: '预约成功',
        booking_id: 'BK-1001',
      },
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });

    expect(result.isFailure).toBe(false);
    expect(result.card).toEqual(
      expect.objectContaining({
        title: '🎉 面试预约成功',
        color: 'green',
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect(result.card.content as string).toContain('**候选人信息**');
    expect(result.card.content as string).toContain('微信昵称：wx_alice');
    expect(result.card.content as string).toContain('姓名：Alice');
    expect(result.card.content as string).toContain('电话：13800138000');
    expect(result.card.content as string).toContain('托管账号：招募经理A');
    expect(result.card.content as string).toContain('面试时间：2026-04-13 07:30');
    expect(result.card.content as string).toContain('预约编号：BK-1001');
    expect(result.card.content as string).toContain('**结果**：预约成功');
  });

  it('should append interview type to the success title when provided', () => {
    const result = renderer.buildInterviewBookingCard({
      candidateName: 'Carol',
      phone: '13700137000',
      interviewTime: '2026-04-24 14:00',
      interviewType: 'AI面试',
      toolOutput: { success: true },
    });

    expect(result.card).toEqual(expect.objectContaining({ title: '🎉 面试预约成功 · AI面试' }));
  });

  it('should append interview type to the failure title when provided', () => {
    const result = renderer.buildInterviewBookingCard({
      candidateName: 'Dave',
      phone: '13600136000',
      interviewTime: '2026-04-24 14:00',
      interviewType: '线上面试',
      toolOutput: { success: false, error: '名额已满' },
    });

    expect(result.card).toEqual(
      expect.objectContaining({ title: '🚨 面试预约失败 · 线上面试 · 需要人工介入' }),
    );
  });

  it('should render failure booking cards with fallback result details', () => {
    const result = renderer.buildInterviewBookingCard({
      contactName: 'wx_bob',
      candidateName: 'Bob',
      phone: '13900139000',
      botUserName: '招募经理B',
      interviewTime: '2026-04-13 19:00',
      toolOutput: {
        success: false,
        error: '名额已满',
        errorList: ['门店无可约时间', { code: 'CAPACITY_FULL' }],
        notice: '请人工跟进',
        traceId: 'trace-xyz-789',
      },
      atAll: true,
    });

    expect(result.isFailure).toBe(true);
    expect(result.card).toEqual(
      expect.objectContaining({
        title: '🚨 面试预约失败 · 需要人工介入',
        color: 'red',
        atAll: true,
      }),
    );
    expect(result.card.content as string).toContain('预约失败，请尽快跟进处理');
    expect(result.card.content as string).toContain('⚠️ 该用户已暂停托管');
    expect(result.card.content as string).toContain('微信昵称：wx_bob');
    expect(result.card.content as string).toContain('托管账号：招募经理B');
    expect(result.card.content as string).toContain('原因：名额已满');
    expect(result.card.content as string).toContain('返回信息：请人工跟进');
    expect(result.card.content as string).toContain('门店无可约时间');
    expect(result.card.content as string).toContain('CAPACITY_FULL');
    expect(result.card.content as string).toContain('traceId：trace-xyz-789');
  });

  it('should render cancellation cards as private-chat operation notifications', () => {
    const card = renderer.buildInterviewCancellationCard({
      contactName: 'wx_cancel',
      candidateName: 'Eve',
      phone: '13500135000',
      botUserName: '招募经理C',
      brandName: '奥乐齐',
      storeName: '凯德晶萃广场',
      jobName: '分拣打包',
      interviewTime: '2026-07-07 13:00:00',
      workOrderId: 446652,
      cancelReason: '面试距离远',
      cancelReasonDesc: '候选人觉得距离有点远，不考虑了',
      userMessage: '不考虑了',
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });

    expect(card).toEqual(
      expect.objectContaining({
        title: '⚠️ 面试预约已取消 · 需要人工确认',
        color: 'orange',
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect(card.content as string).toContain('候选人已取消面试预约');
    expect(card.content as string).toContain('**候选人信息**');
    expect(card.content as string).toContain('微信昵称：wx_cancel');
    expect(card.content as string).toContain('姓名：Eve');
    expect(card.content as string).toContain('**岗位信息**');
    expect(card.content as string).toContain('原面试时间：2026-07-07 13:00');
    expect(card.content as string).toContain('工单号：446652');
    expect(card.content as string).toContain('**取消信息**');
    expect(card.content as string).toContain('取消原因：面试距离远');
    expect(card.content as string).toContain('用户消息：不考虑了');
    expect(card.content as string).not.toContain('异常消息');
    expect(card.content as string).not.toContain('错误分类');
    expect(card.content as string).not.toContain('诊断载荷');
  });
});
