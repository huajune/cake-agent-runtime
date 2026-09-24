import type { SignupWorkOrderItem } from '@sponge/sponge.types';

/** 海绵工单来源：AI=蛋糕/AI 建单；SUPPLIER=供应商后台（真人）建单，即带外工单。 */
export type BookingSnapshotSignupSource = 'AI' | 'SUPPLIER' | null;

/**
 * 本轮预约快照里的一张在途工单。
 *
 * 快照是「查到就用、不落库」的每轮读视图：字段只是海绵返回的投影，加上两个蛋糕侧
 * 确定性判定——带外与否（signupSource）和本人校验（ownedByCandidate）。
 */
export interface BookingSnapshotEntry {
  workOrder: SignupWorkOrderItem;
  workOrderId: number;
  jobId: number | null;
  brandName: string | null;
  jobName: string | null;
  /** 海绵 `yyyy-MM-dd HH:mm`；等通知单为空。 */
  interviewTime: string | null;
  signUpTime: string | null;
  signupSource: BookingSnapshotSignupSource;
  /** 工单行/顶层候选人姓名（海绵登记）。 */
  candidateName: string | null;
  /**
   * 本人校验结果：海绵登记姓名与会话事实/长期档案姓名一致才为 true。
   * false 的工单只渲染，不排提醒、不放行取消改约。
   */
  ownedByCandidate: boolean;
}

/** 快照读取结果三态；skipped/failed 都不能当成"没有工单"。 */
export type BookingSnapshotLoadResult =
  | {
      status: 'ok';
      entries: BookingSnapshotEntry[];
      /** 海绵顶层候选人姓名（本人校验用）。 */
      candidateName: string | null;
      fromCache: boolean;
      fetchedAt: number;
    }
  | { status: 'skipped_no_token' }
  | { status: 'skipped_no_phone' }
  | {
      status: 'failed';
      error: string;
      /** 同账号连续失败开断中（或本次即触发开断），本轮没有/不再打海绵。 */
      circuitOpen?: boolean;
    };

/** Redis 缓存体（按手机号+托管账号）；同时按候选人身份镜像一份供出站守卫读。 */
export interface BookingSnapshotCacheRecord {
  entries: BookingSnapshotEntry[];
  candidateName: string | null;
  fetchedAt: number;
}
