import { Logger } from '@nestjs/common';

export type CircuitState = 'closed' | 'open' | 'half-open';

interface OperationCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenProbeInFlight: boolean;
  lastRejectionLogAt: number;
}

/**
 * 进程级共享、按操作隔离的熔断器，保护所有 Supabase 调用。
 *
 * 连接池打满返回 522 后，各 Repository 若对失败查询零退避重试，会把一次抖动放大成雪崩，
 * 重启都压不住。本熔断器按「表 + CRUD / RPC 函数」维护独立状态：同一操作连续出现瞬时
 * 故障时只阻断该操作，避免一个昂贵统计 RPC 连带切断无关的健康读写；冷却后各操作分别用
 * 单个探针自动半开试探、成功即恢复。
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
  private readonly circuits = new Map<string, OperationCircuit>();

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
  canRequest(operation: string): boolean {
    const circuit = this.getCircuit(operation);
    if (circuit.state === 'closed') {
      return true;
    }

    if (circuit.state === 'open') {
      if (Date.now() - circuit.openedAt >= this.openDurationMs) {
        circuit.state = 'half-open';
        circuit.halfOpenProbeInFlight = true;
        this.logger.warn(`熔断器冷却到期，进入 HALF_OPEN，放行一个探针请求 [${operation}]`);
        return true;
      }
      return false;
    }

    // half-open
    if (circuit.halfOpenProbeInFlight) {
      return false;
    }
    circuit.halfOpenProbeInFlight = true;
    return true;
  }

  /** 调用完成且 DB 可达（即便返回业务错误）→ 记成功 */
  recordSuccess(operation: string): void {
    const circuit = this.getCircuit(operation);
    if (circuit.state === 'half-open') {
      this.logger.log(`熔断器探针成功，恢复 CLOSED [${operation}]`);
    }
    circuit.state = 'closed';
    circuit.consecutiveFailures = 0;
    circuit.halfOpenProbeInFlight = false;
  }

  /** 瞬时/连接类故障 → 记失败，必要时跳闸 */
  recordFailure(operation: string): void {
    const circuit = this.getCircuit(operation);
    circuit.consecutiveFailures += 1;

    if (circuit.state === 'half-open') {
      this.trip(operation, circuit);
      return;
    }
    if (circuit.state === 'closed' && circuit.consecutiveFailures >= this.failureThreshold) {
      this.trip(operation, circuit);
    }
  }

  isOpen(operation: string): boolean {
    return this.getCircuit(operation).state === 'open';
  }

  getState(operation: string): CircuitState {
    return this.getCircuit(operation).state;
  }

  /** OPEN 期间节流拒绝日志，避免每个被拒请求都刷一行 */
  shouldLogRejection(operation: string): boolean {
    const circuit = this.getCircuit(operation);
    const now = Date.now();
    if (now - circuit.lastRejectionLogAt >= this.rejectionLogIntervalMs) {
      circuit.lastRejectionLogAt = now;
      return true;
    }
    return false;
  }

  private getCircuit(operation: string): OperationCircuit {
    const existing = this.circuits.get(operation);
    if (existing) return existing;

    const created: OperationCircuit = {
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: 0,
      halfOpenProbeInFlight: false,
      lastRejectionLogAt: 0,
    };
    this.circuits.set(operation, created);
    return created;
  }

  private trip(operation: string, circuit: OperationCircuit): void {
    circuit.state = 'open';
    circuit.openedAt = Date.now();
    circuit.halfOpenProbeInFlight = false;
    this.logger.error(
      `熔断器跳闸 OPEN [${operation}]（连续 ${circuit.consecutiveFailures} 次瞬时故障），` +
        `${this.openDurationMs}ms 内快速失败、停止该操作，避免重试风暴`,
    );
  }
}

/** 进程级共享单例：所有 Repository 共用同一个熔断器 */
export const supabaseCircuitBreaker = new SupabaseCircuitBreaker();
