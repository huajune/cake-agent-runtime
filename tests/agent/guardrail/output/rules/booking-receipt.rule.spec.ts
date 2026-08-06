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
