import { detectBookingReceiptMismatch } from '@agent/guardrail/output/rules/booking-receipt.rule';

/**
 * 形态 E（2026-08-06 badcase 0091mnfr）：工单已按某个具体日期建单，回复却没把这个
 * 日期告诉候选人。原案候选人选「周三下午2点」，工单落 2026-08-06（周四），回复只有
 * 「资料齐了，这就帮你提交预约」——含"预约"二字躲过形态 B（完全未播报），booking
 * 又成功所以形态 C（失败路径）不适用，候选人次日赶到门店下车才发现约错了天。
 */
describe('detectBookingReceiptMismatch — 形态 E：已建单但未告知日期', () => {
  const successBooking = (confirmed?: string) => [
    {
      toolName: 'duliday_interview_booking',
      status: 'ok',
      result: {
        success: true,
        ...(confirmed ? { _confirmedInterviewTimeHuman: confirmed } : {}),
      },
    } as never,
  ];

  it('已建单却只说"这就帮你提交预约"、未给日期 → REVISE', () => {
    const found = detectBookingReceiptMismatch(
      '资料齐了，这就帮你提交预约',
      successBooking('8月6日（周四）14:00'),
    );
    expect(found?.ruleId).toBe('booking_receipt_mismatch');
    expect(found?.action).toBe('revise');
    expect(found?.label).toContain('8月6日（周四）14:00');
    expect(found?.feedbackToGenerator).toContain('8月6日（周四）14:00');
  });

  it('回复给了月日即放行', () => {
    expect(
      detectBookingReceiptMismatch(
        '已经帮你约好啦，面试时间是 8月6日 下午两点，记得保持电话畅通',
        successBooking('8月6日（周四）14:00'),
      ),
    ).toBeNull();
  });

  it('回复只给了星期也放行（星期同样能让候选人核对）', () => {
    expect(
      detectBookingReceiptMismatch(
        '已经帮你约好啦，是周四下午两点，记得保持电话畅通',
        successBooking('8月6日（周四）14:00'),
      ),
    ).toBeNull();
  });

  it('“8月6号”写法同样放行', () => {
    expect(
      detectBookingReceiptMismatch(
        '已经帮你约上了，8月6号下午2点',
        successBooking('8月6日（周四）14:00'),
      ),
    ).toBeNull();
  });

  it('等通知岗位（无 _confirmedInterviewTimeHuman）不适用本形态', () => {
    expect(
      detectBookingReceiptMismatch('已经帮你报上名啦，面试官会电话联系你', successBooking()),
    ).toBeNull();
  });
});

/**
 * 形态 F（2026-08-06 badcase chat 6a1e42c5 trace …_1785977561594）：候选人要把面试从
 * 15:00 改到 15:30。precheck 已返回在途工单 455384 并在 _replyInstruction 点名
 * "改时间用 duliday_modify_interview_time（传该工单号）"，模型一个工具没调，
 * 回复却确认了"你说的15:30这个时间没问题"。工单至今是 15:00，候选人会按 15:30 到店白跑。
 *
 * 该轮首审只命中 handoff_promise_without_handoff（已于 8-11 下线；首版是"让同事帮你确认下"），
 * repair 把承诺洗成确认后二审无规则可拦——本规则补的就是这条路径。
 */
describe('detectBookingReceiptMismatch — 形态 F：在途工单未改约却确认新时间', () => {
  const precheckWithActiveOrder = (interviewTime = '2026-08-06 15:00') =>
    [
      {
        toolName: 'duliday_interview_precheck',
        status: 'ok',
        result: {
          duplicateBookingGuard: {
            workOrderId: 455384,
            currentStatus: '约面待确认',
            interviewTime,
          },
        },
      },
    ] as never[];

  const okModify = {
    toolName: 'duliday_modify_interview_time',
    status: 'ok',
    result: { success: true },
  } as never;

  it('生产原文：确认 15:30 但工单是 15:00 且未改约 → REVISE', () => {
    const found = detectBookingReceiptMismatch(
      '我是高雅琪，负责这边岗位对接的招聘经理。\n\n你说的15:30这个时间没问题。',
      precheckWithActiveOrder(),
    );
    expect(found?.ruleId).toBe('interview_time_change_unconfirmed');
    expect(found?.action).toBe('revise');
    expect(found?.label).toContain('455384');
    expect(found?.feedbackToGenerator).toContain('2026-08-06 15:00');
  });

  it.each(['3点半没问题', '下午3点半可以的', '就15:30，安排好了'])(
    '口语钟点写法 %s 同样命中',
    (reply) => {
      expect(detectBookingReceiptMismatch(reply, precheckWithActiveOrder())?.ruleId).toBe(
        'interview_time_change_unconfirmed',
      );
    },
  );

  it('本轮成功改约后放行——工单已经改了，确认是如实陈述', () => {
    expect(
      detectBookingReceiptMismatch('你说的15:30这个时间没问题。', [
        ...precheckWithActiveOrder(),
        okModify,
      ] as never[]),
    ).toBeNull();
  });

  it('复述工单既有时间不算改约，必须放行', () => {
    expect(
      detectBookingReceiptMismatch(
        '你后台已经登记好了，预约是今天下午15:00，这个时间没问题',
        precheckWithActiveOrder(),
      ),
    ).toBeNull();
  });

  it('没有在途工单时不判——正常首次约面确认时间是合法的', () => {
    expect(
      detectBookingReceiptMismatch('你说的15:30这个时间没问题。', [
        {
          toolName: 'duliday_interview_precheck',
          status: 'ok',
          result: { nextAction: 'ready_to_book' },
        },
      ] as never[]),
    ).toBeNull();
  });

  it('只复述工单、不确认任何钟点时放行', () => {
    expect(
      detectBookingReceiptMismatch(
        '你在这个岗位已经有一条约面记录了，我先帮你核对下',
        precheckWithActiveOrder(),
      ),
    ).toBeNull();
  });
});
