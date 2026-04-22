import { Injectable, Logger } from '@nestjs/common';
import { Output, generateText, streamText } from 'ai';
import { RegistryService } from '@providers/registry.service';
import { ReliableService } from '@providers/reliable.service';
import { RouterService } from '@providers/router.service';
import { supportsVision, type ReliableConfig } from '@providers/types';
import type { AgentError } from '@shared-types/agent-error.types';
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
  ) {}

  async generate(options: LlmGenerateOptions): Promise<Awaited<ReturnType<typeof generateText>>> {
    const { config, onPreparedRequest, thinking, ...routeOptions } = options;
    const plan = this.resolveExecutionPlan(routeOptions);
    const attempts: string[] = [];
    let lastRawError: unknown = null;

    await this.emitPreparedRequest(plan, routeOptions, thinking, onPreparedRequest);

    for (const modelId of this.iterateCandidateModels(plan)) {
      if (!this.reliable.isModelAvailable(modelId)) {
        attempts.push(`${modelId}: provider未注册`);
        continue;
      }

      const model = this.registry.resolve(modelId);
      const providerOptions = this.buildProviderOptions(modelId, thinking);
      const params = this.buildGenerateParams(routeOptions, providerOptions);
      const retryConfig = this.reliable.getRetryConfig(config);

      for (let attempt = 1; attempt <= retryConfig.maxRetries; attempt += 1) {
        try {
          return await generateText({
            ...params,
            model,
            maxRetries: 0,
          } as Parameters<typeof generateText>[0]);
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
    await this.emitPreparedRequest(plan, routeOptions, thinking, onPreparedRequest);

    let lastError: Error | undefined;
    for (const modelId of this.iterateCandidateModels(plan)) {
      if (!this.reliable.isModelAvailable(modelId)) {
        lastError = new Error(`模型不可用: ${modelId}`);
        continue;
      }

      try {
        return streamText({
          ...this.buildStreamParams(routeOptions, this.buildProviderOptions(modelId, thinking)),
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
    return this.iterateCandidateModels(plan).every((modelId) => supportsVision(modelId));
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

    const providerOptions = this.buildProviderOptions(plan.primaryModelId, thinking);
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
