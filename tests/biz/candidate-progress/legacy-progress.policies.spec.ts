import {
  evaluateOutOfBandWorkOrders,
  isSnapshotEligibleWorkOrder,
  isLegacyPostBookingActive,
  hasLegacyOpenWorkOrders,
  legacyTerminalStops,
  isRecentSameJobBooking,
} from '@biz/candidate-progress/policies/legacy-progress.policies';

describe('legacy reader windows stay independent', () => {
  const now = Date.parse('2026-10-21T04:00:00Z');
  it.each([
    ['约面成功', '2026-10-20 12:00', '2026-10-22 12:00', true, true, true, true],
    ['约面成功', '2026-09-01 12:00', '2026-10-01 12:00', false, false, true, true],
    ['面试成功', '2026-10-20 12:00', '2026-10-20 12:00', false, true, false, true],
    ['上岗成功', '2026-10-20 12:00', '2026-10-20 12:00', false, true, false, false],
    ['约面取消', '2026-10-20 12:00', '2026-10-22 12:00', false, false, false, false],
  ])(
    '%s retains context/OOB/reminder/clear-booked differences',
    (status, signup, interview, context, oob, reminder, open) => {
      const order = {
        workOrderId: 1,
        currentStatus: status as string,
        signUpTime: signup as string,
        interviewTime: interview as string,
      };
      expect(isSnapshotEligibleWorkOrder(order, now)).toBe(context);
      expect(Boolean(evaluateOutOfBandWorkOrders([order], now))).toBe(oob);
      expect(isLegacyPostBookingActive(order.currentStatus)).toBe(reminder);
      expect(hasLegacyOpenWorkOrders([order])).toBe(open);
    },
  );
  it('keeps exact strict 30-minute dedup edge and unbounded terminal reader', () => {
    expect(
      isRecentSameJobBooking(
        { work_order_id: 1, linked_at: new Date(now - 1800000).toISOString(), job_id: 2 },
        2,
        now,
      ),
    ).toBe(false);
    expect(legacyTerminalStops('booked', 'pre_booking')).toBe(true);
    expect(legacyTerminalStops('booked', 'post_booking')).toBe(false);
  });
});
