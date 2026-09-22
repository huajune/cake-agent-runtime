import {
  bookingEventSource,
  findOwnedSnapshotWorkOrder,
  resolveBookingOwnership,
} from '@tools/booking/booking-ownership.util';

describe('booking-ownership.util', () => {
  const refs = [
    {
      workOrderId: 1,
      jobId: 10,
      source: 'out_of_band' as const,
      signupSource: 'SUPPLIER' as const,
      ownedByCandidate: true,
    },
    {
      workOrderId: 2,
      jobId: 20,
      source: 'out_of_band' as const,
      signupSource: 'SUPPLIER' as const,
      ownedByCandidate: false,
    },
    { workOrderId: 3, jobId: 30, source: 'active_booking' as const },
  ];

  it('指针里的工单直接视同自有', () => {
    expect(
      resolveBookingOwnership({ workOrderId: 9, pointerWorkOrderIds: [9], snapshotRefs: [] }),
    ).toEqual({
      owned: true,
      via: 'active_booking',
    });
  });

  it('快照里通过本人校验的工单视同自有；未通过的只渲染（identity_mismatch）；不在快照的拒绝', () => {
    expect(
      resolveBookingOwnership({ workOrderId: 1, pointerWorkOrderIds: [], snapshotRefs: refs }),
    ).toMatchObject({
      owned: true,
      via: 'snapshot',
    });
    expect(
      resolveBookingOwnership({ workOrderId: 2, pointerWorkOrderIds: [], snapshotRefs: refs }),
    ).toMatchObject({
      owned: false,
      reason: 'identity_mismatch',
    });
    expect(
      resolveBookingOwnership({ workOrderId: 4, pointerWorkOrderIds: [], snapshotRefs: refs }),
    ).toEqual({
      owned: false,
      reason: 'not_in_snapshot',
    });
    // 指针路径的引用（ownedByCandidate=undefined）也视同自有
    expect(
      resolveBookingOwnership({ workOrderId: 3, pointerWorkOrderIds: [], snapshotRefs: refs }),
    ).toMatchObject({
      owned: true,
      via: 'snapshot',
    });
  });

  it('findOwnedSnapshotWorkOrder 过滤掉本人校验未通过的引用', () => {
    expect(findOwnedSnapshotWorkOrder(refs, 1)?.workOrderId).toBe(1);
    expect(findOwnedSnapshotWorkOrder(refs, 2)).toBeUndefined();
    expect(findOwnedSnapshotWorkOrder(undefined, 1)).toBeUndefined();
  });

  it('事件来源：SUPPLIER 建单为 oob，其余为 ai', () => {
    expect(bookingEventSource(refs[0])).toBe('oob');
    expect(bookingEventSource(refs[2])).toBe('ai');
    expect(bookingEventSource(undefined)).toBe('ai');
  });
});
