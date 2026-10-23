import type { DuplicateSignupReason, SignupWorkOrderItem } from '@sponge/sponge.types';
import type { SpongeService } from '@sponge/sponge.service';
import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import { toErrorMessage } from '@infra/utils/error.util';
import {
  BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS,
  findCrossAccountDuplicate,
  isSnapshotEligibleWorkOrder,
  isWorkOrderOwnedByCandidate,
  type SnapshotDuplicateMatch,
} from './booking-snapshot.util';

/** 跨账号结果没有归属字段；必须用当前账号查询验证同一张工单，不能把“查得到”当成“能操作”。 */
export async function recoverDuplicateSignup(params: {
  spongeService: Pick<SpongeService, 'fetchSignupWorkOrders'>;
  phone: string;
  candidateName: string;
  tokenContext: SpongeTokenResolveContext | undefined;
  target: { jobId: number; brandName?: string | null };
  reason: DuplicateSignupReason;
  onFailure: (message: string) => void;
}): Promise<{ match?: SnapshotDuplicateMatch; ownedOrder?: SignupWorkOrderItem }> {
  const match = await findCrossAccountDuplicate(params);
  if (!match || params.reason === 'ownership_review') return { match };
  try {
    const current = await params.spongeService.fetchSignupWorkOrders(
      { phone: params.phone, onlyCurrentAccount: true },
      params.tokenContext,
      { timeoutMs: BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS, allowDefaultToken: false },
    );
    return {
      match,
      ownedOrder: current.workOrders.find(
        (order) =>
          order.workOrderId === match.workOrderId &&
          isSnapshotEligibleWorkOrder(order, Date.now()) &&
          isWorkOrderOwnedByCandidate(
            { rowCandidateName: order.candidateName, topCandidateName: current.candidateName },
            [params.candidateName],
          ),
      ),
    };
  } catch (error) {
    params.onFailure(toErrorMessage(error));
    return { match };
  }
}
