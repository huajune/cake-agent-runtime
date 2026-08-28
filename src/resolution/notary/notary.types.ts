/** 共享机械公证原语的统一结果；不携带任何聚合状态或写入权。 */
export interface NotaryCheckResult<TReason extends string = string> {
  accepted: boolean;
  reason?: TReason;
  detail?: string;
}
