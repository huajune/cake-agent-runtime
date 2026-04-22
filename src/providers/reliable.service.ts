import { Injectable, Logger } from '@nestjs/common';
import { RegistryService } from './registry.service';
import { DEFAULT_RELIABLE_CONFIG, ErrorCategory, ReliableConfig } from './types';

/**
 * 容错模型服务 — Layer 2: retry + fallback + 模型降级
 *
 * 对标 ZeroClaw src/providers/reliable.rs 的 ReliableProvider。
 *
 * 三层容错（从内到外）：
 * 1. 重试 — 同一模型指数退避重试（retryable 错误）
 * 2. 模型降级 — primary 失败后按 fallback 链逐个尝试
 * 3. 错误分类 — 区分 retryable / non_retryable / rate_limited
 */
@Injectable()
export class ReliableService {
  private readonly logger = new Logger(ReliableService.name);

  constructor(private readonly registry: RegistryService) {}

  isModelAvailable(modelId: string): boolean {
    try {
      this.registry.resolve(modelId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 错误分类（对标 ZeroClaw classify_error）
   *
   * - non_retryable: 401/403/404, 认证/模型不存在/余额不足
   * - rate_limited: 429
   * - retryable: 5xx, timeout, 网络错误
   */
  classifyError(err: unknown): ErrorCategory {
    if (!(err instanceof Error)) return 'retryable';

    const msg = err.message.toLowerCase();
    const statusMatch = msg.match(/(\d{3})/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    // Non-retryable: auth, not found, bad request, business limits
    if ([401, 403, 404, 400].includes(status)) return 'non_retryable';
    if (
      msg.includes('invalid api key') ||
      msg.includes('unauthorized') ||
      msg.includes('model not found') ||
      msg.includes('insufficient balance') ||
      msg.includes('out of credits') ||
      msg.includes('plan does not include')
    ) {
      return 'non_retryable';
    }

    // Rate-limited
    if (status === 429) return 'rate_limited';
    if (msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limited';

    // Everything else is retryable (5xx, timeout, network)
    return 'retryable';
  }

  getRetryConfig(config?: Partial<ReliableConfig>): ReliableConfig {
    return { ...DEFAULT_RELIABLE_CONFIG, ...config };
  }

  shouldRetry(category: ErrorCategory, attempt: number, config?: Partial<ReliableConfig>): boolean {
    const cfg = this.getRetryConfig(config);
    if (category === 'non_retryable') return false;
    return attempt < cfg.maxRetries;
  }

  getBackoffMs(attempt: number, err: unknown, config?: Partial<ReliableConfig>): number {
    return this.calculateBackoff(attempt, this.getRetryConfig(config), err);
  }

  private calculateBackoff(attempt: number, cfg: ReliableConfig, err: unknown): number {
    // 检查 Retry-After header（从错误信息中解析）
    if (err instanceof Error) {
      const retryAfterMatch = err.message.match(/retry.after[:\s]+(\d+)/i);
      if (retryAfterMatch) {
        const retryAfterMs = parseInt(retryAfterMatch[1], 10) * 1000;
        return Math.min(retryAfterMs, 30_000); // cap 30s
      }
    }

    // 指数退避: base * 2^(attempt-1), capped at max
    const backoff = cfg.baseBackoffMs * Math.pow(2, attempt - 1);
    return Math.min(backoff, cfg.maxBackoffMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
