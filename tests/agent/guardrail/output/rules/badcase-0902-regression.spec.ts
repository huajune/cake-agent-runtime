import type { AgentToolCall } from '@agent/generator/generator.types';
import {
  detectBookingDoneClaimWithoutSubmission,
  detectCancelDoneClaimWithoutSubmission,
} from '@agent/guardrail/output/rules/booking-claim-reconciliation.rule';

const tc = (toolName: string, status?: string): AgentToolCall =>
  ({ toolName, args: {}, result: {}, status }) as unknown as AgentToolCall;

describe('booking/cancel 完成时态哨兵：条件从句不算回执', () => {
  it('wvr7pejq：零工具却宣称"预约成功"并给出面试地址 → 仍命中 observe', () => {
    const hit = detectBookingDoneClaimWithoutSubmission(
      '预约成功\n\n面试地址：浦东新区勤奋路103号，南汇大学城生活广场店\n\n记得带身份证，提前10分钟到',
      [],
    );
    expect(hit?.ruleId).toBe('booking_done_claim_without_submission');
    expect(hit?.action).toBe('observe');
  });

  it('"报名成功后会发你面试码"是条件从句，不是回执 → 不命中', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission(
        '视频面试很简单的，报名成功后会发你面试码，扫码进腾讯会议群，到点视频面试就行\n不用跑门店，手机就能操作\n你想选哪家店？我帮你约个时间',
        [],
      ),
    ).toBeNull();
  });

  it('"报名成功后会给你发面试码"同形态 → 不命中', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission(
        '不用去门店，AI 面试是线上做的\n\n报名成功后会给你发面试码，手机上直接完成就行\n\n先把资料发我，我帮你约明天的时段',
        [],
      ),
    ).toBeNull();
  });

  it.each(['报名成功以后我再通知你', '预约成功之后会收到短信', '报名成功的话我会第一时间告诉你'])(
    '条件从句变体不命中：%s',
    (text) => {
      expect(detectBookingDoneClaimWithoutSubmission(text, [])).toBeNull();
    },
  );

  it('"预约提交成功后"整词也走条件从句豁免 → 不命中', () => {
    expect(detectBookingDoneClaimWithoutSubmission('预约提交成功后会有短信', [])).toBeNull();
  });

  it('"已经帮你约好了"不带"成功"字样，条件从句豁免不误伤原口径 → 仍命中', () => {
    const hit = detectBookingDoneClaimWithoutSubmission(
      '对，面试是下周一（8月31日）13:00，已经帮你约好了',
      [],
    );
    expect(hit?.ruleId).toBe('booking_done_claim_without_submission');
  });

  it('precheck 未返回在途工单时不得豁免（asRecord 收窄失败返回 null 而非 undefined）', () => {
    const hit = detectBookingDoneClaimWithoutSubmission('预约成功，面试地址是……', [
      { toolName: 'duliday_interview_precheck', args: {}, result: {} } as unknown as AgentToolCall,
    ]);
    expect(hit?.ruleId).toBe('booking_done_claim_without_submission');
  });

  it('precheck 返回在途工单时才豁免（对既有工单的合法复述）', () => {
    const hit = detectBookingDoneClaimWithoutSubmission('预约成功，面试地址是……', [
      {
        toolName: 'duliday_interview_precheck',
        args: {},
        result: { duplicateBookingGuard: { workOrderId: 'WO_TEST_1' } },
      } as unknown as AgentToolCall,
    ]);
    expect(hit).toBeNull();
  });

  it('本轮有 booking 调用时依旧让位给 booking_receipt_mismatch', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('预约成功，面试地址是……', [
        tc('duliday_interview_booking', 'ok'),
      ]),
    ).toBeNull();
  });

  it('cancel 侧同形条件从句同样豁免，完成时态仍命中', () => {
    expect(detectCancelDoneClaimWithoutSubmission('取消成功后会发短信通知你', [])).toBeNull();
    expect(detectCancelDoneClaimWithoutSubmission('你之前的面试预约取消成功', [])?.ruleId).toBe(
      'cancel_done_claim_without_submission',
    );
  });
});
