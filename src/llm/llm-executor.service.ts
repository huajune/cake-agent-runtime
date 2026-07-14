import { Injectable, Logger, Optional } from '@nestjs/common';
import { Output, generateText, streamText } from 'ai';
import { RegistryService } from '@providers/registry.service';
import { ReliableService } from '@providers/reliable.service';
import { RouterService } from '@providers/router.service';
import { supportsVision, type ReliableConfig } from '@providers/types';
import type { AgentError } from '@shared-types/agent-error.types';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { z } from 'zod';
import { type LlmThinkingConfig, ModelRole } from './llm.types';

export interface LlmGenerateOptions extends Omit<Parameters<typeof generateText>[0], 'model'> {
  role?: ModelRole | string;
  modelId?: string;
  fallbacks?: string[];
  disableFallbacks?: boolean;
  config?: Partial<ReliableConfig>;
  thinking?: LlmThinkingConfig;
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
}

export interface LlmGenerateStructuredOptions<TSchema extends z.ZodTypeAny>
  extends Omit<LlmGenerateOptions, 'output'> {
  schema: TSchema;
  outputName?: string;
}

export interface LlmStreamOptions extends Omit<Parameters<typeof streamText>[0], 'model'> {
  role?: ModelRole | string;
  modelId?: string;
  fallbacks?: string[];
  disableFallbacks?: boolean;
  thinking?: LlmThinkingConfig;
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
}

type StructuredGenerateResult<TSchema extends z.ZodTypeAny> = Awaited<
  ReturnType<typeof generateText>
> & {
  output: z.infer<TSchema>;
};

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

const VISIBLE_THINK_TAG_PATTERN = /<\/?think\s*>/i;
const OPAQUE_NUMERIC_REPLY_PATTERN = /^\d{12,}$/;

interface ExecutionPlan {
  role: ModelRole | string;
  primaryModelId: string;
  fallbackModelIds: string[];
}

@Injectable()
export class LlmExecutorService {
  private readonly logger = new Logger(LlmExecutorService.name);

  constructor(
    private readonly router: RouterService,
    private readonly registry: RegistryService,
    private readonly reliable: ReliableService,
    @Optional()
    private readonly tracer?: AgentTracerService,
  ) {}

  async generate(options: LlmGenerateOptions): Promise<Awaited<ReturnType<typeof generateText>>> {
    const { config, onPreparedRequest, thinking, ...routeOptions } = options;
    const plan = this.resolveExecutionPlan(routeOptions);
    const attempts: string[] = [];
    let lastRawError: unknown = null;
    const requiresVisionInput = this.hasVisionInput(routeOptions.messages);

    await this.emitPreparedRequest(plan, routeOptions, thinking, onPreparedRequest);

    let previousModelId: string | undefined;
    for (const modelId of this.iterateCandidateModels(plan)) {
      if (requiresVisionInput && !supportsVision(modelId)) {
        attempts.push(`${modelId}: 模型不支持图片输入`);
        continue;
      }
      if (!this.reliable.isModelAvailable(modelId)) {
        attempts.push(`${modelId}: provider未注册`);
        continue;
      }

      const model = this.registry.resolve(modelId);
      const effectiveThinking = this.resolveRequestThinking(modelId, thinking, requiresVisionInput);
      const providerOptions = this.buildProviderOptions(modelId, effectiveThinking);
      const params = this.buildGenerateParams(routeOptions, providerOptions);
      const retryConfig = this.reliable.getRetryConfig(config);

      this.emitModelAttempt(plan, modelId, previousModelId, attempts.at(-1));
      previousModelId = modelId;

      for (let attempt = 1; attempt <= retryConfig.maxRetries; attempt += 1) {
        try {
          const result = await generateText({
            ...params,
            model,
            maxRetries: 0,
          } as Parameters<typeof generateText>[0]);
          this.assertUsableChatResult(result, plan.role);
          return result;
        } catch (err) {
          lastRawError = err;
          const category = this.reliable.classifyError(err);
          const message = err instanceof Error ? err.message : String(err);
          attempts.push(
            `${modelId} attempt ${attempt}/${retryConfig.maxRetries}: ${category}; ${message}`,
          );

          if (!this.reliable.shouldRetry(category, attempt, retryConfig)) {
            break;
          }

          const backoff = this.reliable.getBackoffMs(attempt, err, retryConfig);
          this.logger.warn(
            `${modelId} 重试 ${attempt}/${retryConfig.maxRetries}, 等待 ${backoff}ms`,
          );
          await this.sleep(backoff);
        }
      }
    }

    throw this.buildExhaustedError(plan, attempts, lastRawError);
  }

  async generateStructured<TSchema extends z.ZodTypeAny>(
    options: LlmGenerateStructuredOptions<TSchema>,
  ): Promise<StructuredGenerateResult<TSchema>> {
    const { schema, outputName = 'StructuredOutput', ...rest } = options;
    const result = await this.generate({
      ...rest,
      output: Output.object({
        schema,
        name: outputName,
      }),
    });

    if (!result.output) {
      throw new Error('No structured output returned');
    }

    return result as StructuredGenerateResult<TSchema>;
  }

  async stream(options: LlmStreamOptions): Promise<ReturnType<typeof streamText>> {
    const { onPreparedRequest, thinking, ...routeOptions } = options;
    const plan = this.resolveExecutionPlan(routeOptions);
    const requiresVisionInput = this.hasVisionInput(routeOptions.messages);
    await this.emitPreparedRequest(plan, routeOptions, thinking, onPreparedRequest);

    let lastError: Error | undefined;
    let previousModelId: string | undefined;
    for (const modelId of this.iterateCandidateModels(plan)) {
      if (requiresVisionInput && !supportsVision(modelId)) {
        lastError = new Error(`模型不支持图片输入: ${modelId}`);
        continue;
      }
      if (!this.reliable.isModelAvailable(modelId)) {
        lastError = new Error(`模型不可用: ${modelId}`);
        continue;
      }

      try {
        this.emitModelAttempt(plan, modelId, previousModelId, lastError?.message);
        previousModelId = modelId;
        const effectiveThinking = this.resolveRequestThinking(
          modelId,
          thinking,
          requiresVisionInput,
        );
        return streamText({
          ...this.buildStreamParams(
            routeOptions,
            this.buildProviderOptions(modelId, effectiveThinking),
          ),
          model: this.registry.resolve(modelId),
        } as Parameters<typeof streamText>[0]);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;
        this.logger.warn(`流式初始化失败，尝试下一个模型: ${modelId}; ${err.message}`);
      }
    }

    throw this.buildExhaustedError(plan, lastError ? [lastError.message] : [], lastError);
  }

  async generateSimple(params: {
    systemPrompt: string;
    userMessage: string;
    role?: ModelRole | string;
    modelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
    thinking?: LlmThinkingConfig;
  }): Promise<string> {
    const { systemPrompt, userMessage, role, modelId, fallbacks, disableFallbacks, thinking } =
      params;
    const result = await this.generate({
      role,
      modelId,
      fallbacks,
      disableFallbacks,
      thinking,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    return result.text;
  }

  supportsVisionInput(options: {
    role?: ModelRole | string;
    modelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
  }): boolean {
    const plan = this.resolveExecutionPlan(options);
    // Whether to build the primary request as multimodal should be decided by the
    // primary model. Requiring every fallback to support vision disables image
    // parts whenever a text-only fallback is configured, forcing unnecessary
    // pre-agent image description even though the normal path can see images directly.
    return supportsVision(plan.primaryModelId);
  }

  private resolveExecutionPlan(options: {
    role?: ModelRole | string;
    modelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
  }): ExecutionPlan {
    const role = options.role ?? ModelRole.Chat;
    const route = this.router.resolveRoute({
      role,
      overrideModelId: options.modelId,
      fallbacks: options.fallbacks,
      disableFallbacks: options.disableFallbacks,
    });

    return {
      role,
      primaryModelId: route.modelId,
      fallbackModelIds: route.fallbacks ?? [],
    };
  }

  private iterateCandidateModels(plan: ExecutionPlan): string[] {
    return Array.from(new Set([plan.primaryModelId, ...plan.fallbackModelIds].filter(Boolean)));
  }

  private emitModelAttempt(
    plan: ExecutionPlan,
    modelId: string,
    previousModelId: string | undefined,
    reason?: string,
  ): void {
    this.tracer?.emit({
      type: 'model_call',
      modelId,
      role: String(plan.role),
    });

    if (modelId === plan.primaryModelId) return;
    this.tracer?.emit({
      type: 'model_fallback',
      fromModel: previousModelId ?? plan.primaryModelId,
      toModel: modelId,
      reason: reason ?? 'previous_model_failed',
    });
  }

  private hasVisionInput(messages: LlmGenerateOptions['messages']): boolean {
    if (!Array.isArray(messages)) return false;
    return messages.some((message) => {
      const content = message.content;
      if (!Array.isArray(content)) return false;
      return content.some((part) => part && typeof part === 'object' && part.type === 'image');
    });
  }

  /**
   * DashScope 的标准 `reasoning_content` 已由 @ai-sdk/openai-compatible 分离。
   * 线上 badcase 表明 Qwen deep-thinking 图片回合仍可能把畸形 `<think>` 写进 content；
   * 在该组合稳定前仅关闭图片回合 thinking，文本回合保持原配置。
   */
  private resolveRequestThinking(
    modelId: string,
    thinking: LlmThinkingConfig | undefined,
    hasVisionInput: boolean,
  ): LlmThinkingConfig | undefined {
    if (hasVisionInput && modelId.startsWith('qwen/') && thinking?.type === 'enabled') {
      return { type: 'disabled', budgetTokens: 0 };
    }
    return thinking;
  }

  /**
   * Treat malformed candidate-facing chat completions as retryable provider failures so the
   * existing same-model retry/fallback chain can regenerate with the original images and tools.
   * Output guardrail keeps the same checks as defense in depth for any path that bypasses here.
   */
  private assertUsableChatResult(
    result: Awaited<ReturnType<typeof generateText>>,
    role: ModelRole | string,
  ): void {
    if (role !== ModelRole.Chat) return;
    const text = result.text?.trim() ?? '';
    if (!text) return;

    if (VISIBLE_THINK_TAG_PATTERN.test(text)) {
      throw new Error('Invalid model response: visible chat text contains <think> markup');
    }
    if (OPAQUE_NUMERIC_REPLY_PATTERN.test(text)) {
      throw new Error('Invalid model response: visible chat text is an opaque numeric identifier');
    }
  }

  private buildProviderOptions(
    modelId: string,
    thinking?: LlmThinkingConfig,
  ): ProviderOptions | undefined {
    const [provider] = modelId.split('/');
    if (!provider || !thinking) return undefined;

    const isDeepMode = thinking.type === 'enabled';
    const budgetTokens = thinking.budgetTokens > 0 ? thinking.budgetTokens : 1024;

    if (!isDeepMode) {
      switch (provider) {
        case 'deepseek':
          return { deepseek: { thinking: { type: 'disabled' } } } as ProviderOptions;
        case 'google':
          return { google: { thinkingConfig: { thinkingLevel: 'minimal' } } } as ProviderOptions;
        case 'openai':
          return { openai: { reasoningEffort: 'minimal' } } as ProviderOptions;
        case 'qwen':
          return { qwen: { enable_thinking: false } } as ProviderOptions;
        default:
          return undefined;
      }
    }

    switch (provider) {
      case 'anthropic':
        if (this.requiresAdaptiveAnthropicThinking(modelId)) {
          return {
            anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
          } as ProviderOptions;
        }
        return { anthropic: { thinking: { type: 'enabled', budgetTokens } } } as ProviderOptions;
      case 'deepseek':
        return { deepseek: { thinking: { type: 'enabled' } } } as ProviderOptions;
      case 'google':
        return {
          google: {
            thinkingConfig: {
              thinkingBudget: budgetTokens,
              thinkingLevel: 'high',
            },
          },
        } as ProviderOptions;
      case 'openai':
        return { openai: { reasoningEffort: 'high' } } as ProviderOptions;
      case 'qwen':
        return { qwen: { enable_thinking: true, reasoningEffort: 'high' } } as ProviderOptions;
      case 'moonshotai':
      case 'ohmygpt':
      case 'gateway':
      case 'openrouter':
        return { openai: { reasoningEffort: 'high' } } as ProviderOptions;
      default:
        return undefined;
    }
  }

  private requiresAdaptiveAnthropicThinking(modelId: string): boolean {
    const anthropicModelId = modelId.split('/').pop() ?? modelId;
    const match = /^claude-(?:opus|sonnet)-4-(\d+)/.exec(anthropicModelId);
    return match ? Number(match[1]) >= 7 : false;
  }

  private buildGenerateParams(
    options: Omit<LlmGenerateOptions, 'config' | 'onPreparedRequest' | 'thinking'>,
    providerOptions?: ProviderOptions,
  ): Omit<Parameters<typeof generateText>[0], 'model'> {
    const {
      role: _role,
      modelId: _modelId,
      fallbacks: _fallbacks,
      disableFallbacks: _disable,
      ...params
    } = options;
    return providerOptions ? { ...params, providerOptions } : params;
  }

  private buildStreamParams(
    options: Omit<LlmStreamOptions, 'onPreparedRequest' | 'thinking'>,
    providerOptions?: ProviderOptions,
  ): Omit<Parameters<typeof streamText>[0], 'model'> {
    const {
      role: _role,
      modelId: _modelId,
      fallbacks: _fallbacks,
      disableFallbacks: _disable,
      ...params
    } = options;
    return providerOptions ? { ...params, providerOptions } : params;
  }

  private async emitPreparedRequest(
    plan: ExecutionPlan,
    options:
      | Omit<LlmGenerateOptions, 'config' | 'onPreparedRequest' | 'thinking'>
      | Omit<LlmStreamOptions, 'onPreparedRequest' | 'thinking'>,
    thinking: LlmThinkingConfig | undefined,
    handler?: (request: Record<string, unknown>) => Promise<void> | void,
  ): Promise<void> {
    if (!handler) return;

    const request: Record<string, unknown> = {
      modelId: plan.primaryModelId,
    };

    if (plan.fallbackModelIds.length > 0) {
      request.fallbackModelIds = plan.fallbackModelIds;
    }

    const params =
      'maxSteps' in options
        ? {
            system: options.system,
            messages: options.messages,
            maxOutputTokens: options.maxOutputTokens,
            maxSteps: options.maxSteps,
            toolNames: Object.keys(options.tools ?? {}),
          }
        : {
            system: options.system,
            messages: options.messages,
            prompt: options.prompt,
            maxOutputTokens: options.maxOutputTokens,
          };

    Object.assign(request, params);

    const effectiveThinking = this.resolveRequestThinking(
      plan.primaryModelId,
      thinking,
      this.hasVisionInput(options.messages),
    );
    const providerOptions = this.buildProviderOptions(plan.primaryModelId, effectiveThinking);
    if (providerOptions) {
      request.providerOptions = providerOptions;
    }

    await Promise.resolve(handler(request));
  }

  private buildExhaustedError(
    plan: ExecutionPlan,
    attempts: string[],
    lastRawError: unknown,
  ): AgentError {
    const trail = attempts.length > 0 ? attempts.join('\n  ') : '无可用模型';
    const error = new Error(`所有模型均失败:\n  ${trail}`) as AgentError;
    const lastCategory = lastRawError ? this.reliable.classifyError(lastRawError) : 'retryable';
    error.isAgentError = true;
    error.agentMeta = {
      ...(this.getExistingAgentMeta(lastRawError) ?? {}),
      modelsAttempted: this.iterateCandidateModels(plan),
      totalAttempts: attempts.length,
      lastCategory,
    };
    error.apiKey = this.getApiKey(lastRawError);
    return error;
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
