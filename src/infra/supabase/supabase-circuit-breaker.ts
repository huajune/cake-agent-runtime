import { Logger } from '@nestjs/common';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * 进程级共享熔断器，保护所有 Supabase 调用。
 *
 * 背景：2026-06-04 生产事故——数据库连接池被打满返回 522 后，各 Repository
 * 对失败查询「零退避」地疯狂重试，把一次抖动放大成全面雪崩，单纯重启都压不住。
 *
 * 本熔断器让「任意一个」Repository 观察到的连续瞬时故障，能让「所有」Repository
 * 在冷却窗口内快速失败、停止打 DB，从根上阻断重试风暴；DB 恢复后用单个探针
 * 自动半开试探、成功即恢复。
 *
 * 状态机：
 *   CLOSED ──(连续失败≥阈值)──▶ OPEN ──(冷却到期)──▶ HALF_OPEN
 *   HALF_OPEN ──(探针成功)──▶ CLOSED ／ ──(探针失败)──▶ OPEN
 *
 * 注意：仅「瞬时/连接类」故障（522/503/cloudflare/fetch failed/econnreset…）计入失败；
 * 业务错误（唯一冲突、not found 等）说明 DB 可达，记为成功，不会误跳闸。
 */
export class SupabaseCircuitBreaker {
  private readonly logger = new Logger('SupabaseCircuitBreaker');

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;
  private lastRejectionLogAt = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly openDurationMs = 10_000,
    private readonly rejectionLogIntervalMs = 2_000,
  ) {}

  /**
   * 调用前询问是否放行。
   * - CLOSED：放行
   * - OPEN：冷却未到 → 拒绝（不打 DB）；冷却到期 → 进入 HALF_OPEN 放一个探针
   * - HALF_OPEN：仅允许一个探针在途，其余拒绝
   */
  canRequest(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.openDurationMs) {
        this.state = 'half-open';
        this.halfOpenProbeInFlight = true;
        this.logger.warn('熔断器冷却到期，进入 HALF_OPEN，放行一个探针请求');
        return true;
      }
      return false;
    }

    // half-open
    if (this.halfOpenProbeInFlight) {
      return false;
    }
    this.halfOpenProbeInFlight = true;
    return true;
  }

  /** 调用完成且 DB 可达（即便返回业务错误）→ 记成功 */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.logger.log('熔断器探针成功，恢复 CLOSED');
    }
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
  }

  /** 瞬时/连接类故障 → 记失败，必要时跳闸 */
  recordFailure(): void {
    this.consecutiveFailures += 1;

    if (this.state === 'half-open') {
      this.trip();
      return;
    }
    if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.trip();
    }
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  getState(): CircuitState {
    return this.state;
  }

  /** OPEN 期间节流拒绝日志，避免每个被拒请求都刷一行 */
  shouldLogRejection(): boolean {
    const now = Date.now();
    if (now - this.lastRejectionLogAt >= this.rejectionLogIntervalMs) {
      this.lastRejectionLogAt = now;
      return true;
    }
    return false;
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.halfOpenProbeInFlight = false;
    this.logger.error(
      `熔断器跳闸 OPEN（连续 ${this.consecutiveFailures} 次瞬时故障），` +
        `${this.openDurationMs}ms 内快速失败、停止打 DB，避免重试风暴`,
    );
  }
}

/** 进程级共享单例：所有 Repository 共用同一个熔断器 */
export const supabaseCircuitBreaker = new SupabaseCircuitBreaker();
