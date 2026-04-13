import { Injectable, Logger } from '@nestjs/common';
import { LanguageModel, generateText, streamText } from 'ai';
import { RegistryService } from './registry.service';
import { DEFAULT_RELIABLE_CONFIG, ErrorCategory, ReliableConfig } from './types';
import type { AgentError } from '@shared-types/agent-error.types';

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

  /**
   * 带容错的 generateText 调用
   *
   * @param modelId - 主模型 ID (provider/model)
   * @param fallbacks - 降级模型 ID 列表
   * @param params - generateText 参数（不含 model）
   * @param config - 容错配置
   */
  async generateText(
    modelId: string,
    params: Omit<Parameters<typeof generateText>[0], 'model'>,
    fallbacks?: string[],
    config?: Partial<ReliableConfig>,
  ): Promise<Awaited<ReturnType<typeof generateText>>> {
    const cfg = { ...DEFAULT_RELIABLE_CONFIG, ...config };
    const modelChain = [modelId, ...(fallbacks ?? [])];
    const attempts: string[] = [];
    let lastRawError: unknown = null;
    let lastCategory: ErrorCategory = 'retryable';

    for (const currentModelId of modelChain) {
      let model: LanguageModel;
      try {
        model = this.registry.resolve(currentModelId);
      } catch {
        attempts.push(`${currentModelId}: provider未注册`);
        continue;
      }

      for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
        try {
          return await generateText({ ...params, model } as Parameters<typeof generateText>[0]);
        } catch (err) {
          const category = this.classifyError(err);
          lastRawError = err;
          lastCategory = category;
          const msg = err instanceof Error ? err.message : String(err);
          attempts.push(
            `${currentModelId} attempt ${attempt}/${cfg.maxRetries}: ${category}; ${msg}`,
          );

          if (category === 'non_retryable') break;

          if (attempt < cfg.maxRetries) {
            const backoff = this.calculateBackoff(attempt, cfg, err);
            this.logger.warn(
              `${currentModelId} 重试 ${attempt}/${cfg.maxRetries}, 等待 ${backoff}ms`,
            );
            await this.sleep(backoff);
          }
        }
      }
    }

    const trail = attempts.join('\n  ');
    const error = new Error(`所有模型均失败:\n  ${trail}`) as AgentError;
    error.isAgentError = true;
    error.agentMeta = {
      ...(this.getExistingAgentMeta(lastRawError) ?? {}),
      modelsAttempted: modelChain,
      totalAttempts: attempts.length,
      lastCategory,
    };
    error.apiKey = this.getApiKey(lastRawError);
    throw error;
  }

  /**
   * 带容错的 streamText 调用
   * 流式无法重试中间状态，仅做模型降级（不做重试）
   */
  streamText(
    modelId: string,
    params: Omit<Parameters<typeof streamText>[0], 'model'>,
    fallbacks?: string[],
  ): ReturnType<typeof streamText> {
    const model = this.resolveWithFallback(modelId, fallbacks);
    return streamText({ ...params, model } as Parameters<typeof streamText>[0]);
  }

  /** 解析模型，主模型失败则尝试 fallback（仅解析阶段） */
  resolveWithFallback(modelId: string, fallbacks?: string[]): LanguageModel {
    try {
      return this.registry.resolve(modelId);
    } catch {
      if (!fallbacks?.length) throw new Error(`模型解析失败: ${modelId}, 无 fallback`);
      for (const fb of fallbacks) {
        try {
          this.logger.warn(`${modelId} 解析失败, 降级到 ${fb}`);
          return this.registry.resolve(fb);
        } catch {
          continue;
        }
      }
      throw new Error(`模型解析失败: ${modelId}, 所有 fallback 均失败`);
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

  private getExistingAgentMeta(error: unknown): AgentError['agentMeta'] | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const meta = (error as AgentError).agentMeta;
    return meta ? { ...meta } : undefined;
  }

  private getApiKey(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    return typeof (error as AgentError).apiKey === 'string'
      ? (error as AgentError).apiKey
      : undefined;
  }
}
