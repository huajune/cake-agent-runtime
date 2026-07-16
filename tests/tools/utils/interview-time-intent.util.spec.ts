import { isInterviewSlotAvailabilityInquiryOnly } from '@tools/utils/interview-time-intent.util';

describe('isInterviewSlotAvailabilityInquiryOnly', () => {
  it.each([
    '明天上午的面试还有吗',
    '上午还有场次吗',
    '周五有没有面试时段',
    '面 试 时 段 还 有 没 有',
  ])('identifies an availability-only inquiry: %s', (message) => {
    expect(isInterviewSlotAvailabilityInquiryOnly(message)).toBe(true);
  });

  it.each([
    '上午还有场次吗？有的话帮我改到上午',
    '明天的面试还有吗，我想换到明天',
    '周五有没有面试时段？那就约周五吧',
  ])('does not block a message that also explicitly requests a change: %s', (message) => {
    expect(isInterviewSlotAvailabilityInquiryOnly(message)).toBe(false);
  });

  it.each([
    '能不能改到上午',
    '那就约那个时间吧',
    '我想改个时间',
    '周五下午两点可以吗',
    '',
    undefined,
  ])('does not treat a non-availability message as an inquiry-only message: %s', (message) => {
    expect(isInterviewSlotAvailabilityInquiryOnly(message)).toBe(false);
  });
});
