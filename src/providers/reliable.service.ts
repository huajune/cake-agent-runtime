import { boundedModelAttempts } from '@infra/config/constants/runtime-retry.constants';
import { Injectable, Logger } from '@nestjs/common';
import { exponentialBackoffMs } from '@infra/utils/async.util';
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
 * 3. 错误分类 — 供应商不可用或限流时直接跨供应商，输出错误保留有限重试
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
   * - non_retryable: 400/401/403/404, 参数错误/认证/模型不存在/余额不足
   * - rate_limited: 429
   * - provider_unavailable: 5xx、超时和连接错误，直接切供应商
   * - retryable: 可重试的输出或校验错误
   */
  classifyError(err: unknown): ErrorCategory {
    // DOMException and SDK errors may originate in the fetch implementation's realm.
    if (typeof err !== 'object' || !err) return 'retryable';
    const name = 'name' in err ? err.name : undefined;
    const msg =
      'message' in err && typeof err.message === 'string' ? err.message.toLowerCase() : '';
    const cause = 'cause' in err ? err.cause : undefined;
    const causeName =
      cause && typeof cause === 'object' && 'name' in cause ? cause.name : undefined;

    // AI SDK 会在请求发往 provider 前抛出 InvalidPromptError。
    // 这类本地参数错误不会因重复调用恢复，应停止当前模型的重试。
    if (name === 'AI_InvalidPromptError' || msg.startsWith('invalid prompt:')) {
      return 'non_retryable';
    }

    const httpStatus = 'statusCode' in err ? err.statusCode : undefined;
    const status =
      typeof httpStatus === 'number' ? httpStatus : Number(msg.match(/\b([45]\d{2})\b/)?.[1]);

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

    if (
      status === 408 ||
      (status >= 500 && status < 600) ||
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      causeName === 'TimeoutError' ||
      causeName === 'AbortError' ||
      /headers time(?:out|d out)|connect time(?:out|d out)|cannot connect to api|fetch failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|request timed? ?out|request timeout|operation was aborted due to timeout/.test(
        msg,
      )
    )
      return 'provider_unavailable';

    return 'retryable';
  }

  getRetryConfig(config?: Partial<ReliableConfig>): ReliableConfig {
    return {
      ...DEFAULT_RELIABLE_CONFIG,
      ...config,
      maxRetries: boundedModelAttempts(config?.maxRetries),
    };
  }

  shouldRetry(category: ErrorCategory, attempt: number, config?: Partial<ReliableConfig>): boolean {
    const cfg = this.getRetryConfig(config);
    return category === 'retryable' && attempt < cfg.maxRetries;
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
    return exponentialBackoffMs(attempt, cfg.baseBackoffMs, cfg.maxBackoffMs);
  }
}
