/**
 * shadow 对照「一致」计数器（§15.6 差异率门禁的分母）。
 *
 * 一致是常态（日均数百次），逐次落库会把事件表冲成计数器，所以按批落。但纯按批会让
 * 分母在低流量日**结构性不可测**：周末 5–15 回合/天永远攒不满一批，当天分母恒为 0，
 * 差异率算出来是 NULL 或凭空 100%（2026-07-21 观测期实测踩到，当天 agreements 只落了
 * 一批 100，而 diff 覆盖全天，事件级差异率虚高到 19%）。
 *
 * 所以落库点是**两个条件取先到者**：
 * - 攒满 batchSize —— 高流量下限制事件量；
 * - 距上次落库超过 maxLagMs —— 低流量下保证当天计数当天落，分母始终可算。
 *
 * 另外落库的是**实际计数**而非批大小常量：一旦允许不满批落库，写死常量会直接虚报分母。
 */
export class ShadowAgreementCounter {
  private pending = 0;
  private total = 0;
  private lastFlushAtMs: number;

  constructor(
    private readonly batchSize: number,
    private readonly maxLagMs: number,
    nowMs: number = Date.now(),
  ) {
    this.lastFlushAtMs = nowMs;
  }

  /**
   * 记一次一致。返回本次应落库的计数；0 表示尚未到落库点。
   * 调用方拿到非 0 即发事件，`batchSize` 字段填这个返回值。
   */
  record(nowMs: number = Date.now()): number {
    this.pending += 1;
    this.total += 1;
    const batchFull = this.pending >= this.batchSize;
    const staleEnough = nowMs - this.lastFlushAtMs >= this.maxLagMs;
    if (!batchFull && !staleEnough) return 0;
    return this.flush(nowMs);
  }

  /**
   * 进程退出前把剩余计数交出去（部署重启每实例最多丢 batchSize-1 的历史缺口）。
   * 返回 0 表示没有待落计数。
   */
  drain(nowMs: number = Date.now()): number {
    return this.flush(nowMs);
  }

  /** 累计一致次数（仅日志用，不参与门禁计算）。 */
  get totalCount(): number {
    return this.total;
  }

  private flush(nowMs: number): number {
    const flushed = this.pending;
    this.pending = 0;
    this.lastFlushAtMs = nowMs;
    return flushed;
  }
}

/** 攒满即落的批大小。 */
export const SHADOW_AGREEMENT_BATCH = 100;

/** 落库最大滞后：低流量日靠它保证当天分母当天落。 */
export const SHADOW_AGREEMENT_MAX_LAG_MS = 5 * 60 * 1000;
