import type { ToolBookingWorkOrderRef } from '@shared-types/tool.types';

/**
 * 工具侧的工单归属判定（取消/改约放行口径）：
 * - active_booking 指针里的工单：本联系人自建，直接视同自有；
 * - 本轮预约快照里的工单：通过本人校验（ownedByCandidate=true）即视同自有工单，
 *   不再要求登记手机号出现在候选人原话里（账号边界保证查得到的就是操作得了的）；
 * - 快照里有但本人校验未通过：只渲染，取消/改约一律转人工。
 */
export type BookingOwnership =
  | { owned: true; via: 'active_booking' | 'snapshot'; ref?: ToolBookingWorkOrderRef }
  | {
      owned: false;
      reason: 'not_in_snapshot' | 'identity_mismatch';
      ref?: ToolBookingWorkOrderRef;
    };

export function findSnapshotWorkOrder(
  refs: readonly ToolBookingWorkOrderRef[] | undefined,
  workOrderId: number,
): ToolBookingWorkOrderRef | undefined {
  return refs?.find((ref) => ref.workOrderId === workOrderId);
}

/** 快照里且本人校验通过的工单引用；指针路径的引用（ownedByCandidate=undefined）也视同自有。 */
export function findOwnedSnapshotWorkOrder(
  refs: readonly ToolBookingWorkOrderRef[] | undefined,
  workOrderId: number,
): ToolBookingWorkOrderRef | undefined {
  const ref = findSnapshotWorkOrder(refs, workOrderId);
  if (!ref) return undefined;
  return ref.ownedByCandidate === false ? undefined : ref;
}

export function resolveBookingOwnership(params: {
  workOrderId: number;
  pointerWorkOrderIds: readonly number[];
  snapshotRefs: readonly ToolBookingWorkOrderRef[] | undefined;
}): BookingOwnership {
  if (params.pointerWorkOrderIds.includes(params.workOrderId)) {
    return { owned: true, via: 'active_booking' };
  }
  const ref = findSnapshotWorkOrder(params.snapshotRefs, params.workOrderId);
  if (!ref) return { owned: false, reason: 'not_in_snapshot' };
  if (ref.ownedByCandidate === false) return { owned: false, reason: 'identity_mismatch', ref };
  return { owned: true, via: 'snapshot', ref };
}

/** 事件来源标记：供应商后台建单的工单（带外）后续取消/改约按来源单列统计。 */
export function bookingEventSource(ref: ToolBookingWorkOrderRef | undefined): 'oob' | 'ai' {
  return ref?.signupSource === 'SUPPLIER' ? 'oob' : 'ai';
}
