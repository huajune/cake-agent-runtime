import { detectInterviewSlotAvailabilityMismatch } from '@agent/guardrail/output/rules/interview-slot-availability.rule';
import type { AgentToolCall } from '@agent/generator/generator.types';

function precheckCall(requestedDate?: string): AgentToolCall {
  return {
    toolName: 'duliday_interview_precheck',
    args: {},
    status: 'ok',
    result: {
      success: true,
      nextAction: 'select_interview_time',
      interview: {
        ...(requestedDate ? { requestedDate: { value: requestedDate, status: 'available' } } : {}),
        bookableSlots: [
          {
            date: '2026-09-04',
            registrationDeadline: '2026-09-04 10:00',
            bookingAllowed: true,
          },
          {
            date: '2026-09-07',
            registrationDeadline: '2026-09-07 10:00',
            bookingAllowed: true,
          },
          {
            date: '2026-09-08',
            registrationDeadline: '2026-09-08 10:00',
            bookingAllowed: true,
          },
        ],
      },
    },
  };
}

describe('detectInterviewSlotAvailabilityMismatch', () => {
  it('catches the production badcase: later dates shown while the earliest valid slot is omitted', () => {
    const reply =
      '现在已经19:47，9月4日当天10点的报名截止过了。所以可以选9月7日或9月8日，且需要提前一天报名。';

    expect(detectInterviewSlotAvailabilityMismatch(reply, [precheckCall()])).toEqual(
      expect.objectContaining({ ruleId: 'interview_slot_availability_mismatch' }),
    );
  });

  it('catches a same-day registration deadline rewritten as previous-day registration', () => {
    const reply = '可约9月4日和9月7日，记得提前一天报名。';

    expect(detectInterviewSlotAvailabilityMismatch(reply, [precheckCall()])?.label).toContain(
      '提前一天报名',
    );
  });

  it('allows rendering the authoritative slots and same-day deadline as returned', () => {
    const reply = '最近可约9月4日、9月7日和9月8日，都是面试当天10:00前报名。';

    expect(detectInterviewSlotAvailabilityMismatch(reply, [precheckCall()])).toBeNull();
  });

  it('allows omitting earlier alternatives when the candidate explicitly requested a later date', () => {
    expect(
      detectInterviewSlotAvailabilityMismatch('9月7日可以约，面试当天10点前报名。', [
        precheckCall('2026-09-07'),
      ]),
    ).toBeNull();
  });
});
