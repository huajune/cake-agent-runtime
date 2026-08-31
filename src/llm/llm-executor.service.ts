import { toErrorMessage } from '@infra/utils/error.util';
import { sleep } from '@infra/utils/async.util';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Output, generateText, streamText } from 'ai';
import { RegistryService } from '@providers/registry.service';
import { ReliableService } from '@providers/reliable.service';
import { RouterService } from '@providers/router.service';
import { supportsVision, type ReliableConfig } from '@providers/types';
import type { AgentError } from '@shared-types/agent-error.types';
import { AgentTracerService } from '@observability/agent-tracer.service';
import type { LlmAttemptTrace } from '@observability/observer.interface';
import { z } from 'zod';
import { type LlmThinkingConfig, ModelRole } from './llm.types';
import { ROLE_MODEL_OVERRIDES, type RoleModelOverridesProvider } from './role-model-overrides';

export interface LlmGenerateOptions extends Omit<Parameters<typeof generateText>[0], 'model'> {
  role?: ModelRole | string;
  modelId?: string;
  fallbacks?: string[];
  disableFallbacks?: boolean;
  config?: Partial<ReliableConfig>;
  thinking?: LlmThinkingConfig;
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
  /**
   * Validate lazy result fields while still inside the retry/fallback loop.
   * AI SDK structured output can throw only when `result.output` is accessed.
   */
  validateResult?: (result: Awaited<ReturnType<typeof generateText>>) => void;
  /**
   * 每次真实 provider 尝试（含同模型重试与降级）发起前回调。
   *
   * 失败尝试同样触发 onStepFinish，调用方须借此重置步骤墙钟锚，否则失败尝试的
   * 步末墙钟会错配到成功尝试的 steps 上。
   */
  onAttemptStart?: (info: { modelId: string; attempt: number }) => void;
}

export interface LlmGenerateStructuredOptions<TSchema extends z.ZodTypeAny>
  extends Omit<LlmGenerateOptions, 'output'> {
  schema: TSchema;
  outputName?: string;
  /**
   * schema 校验通过后的业务级校验：抛错即视为本次生成失败，走与 API 错误相同的
   * 重试/降级策略。用于拦截"结构合法但内容损坏"的输出（如约束解码截断）。
   */
  validateOutput?: (output: unknown) => void;
}

export interface LlmStreamOptions extends Omit<Parameters<typeof streamText>[0], 'model'> {
  role?: ModelRole | string;
  modelId?: string;
  fallbacks?: string[];
  disableFallbacks?: boolean;
  thinking?: LlmThinkingConfig;
  onPreparedRequest?: (request: Record<string, unknown>) => Promise<void> | void;
}

export type LlmGenerateResult = Awaited<ReturnType<typeof generateText>> & {
  /** 经重试/降级后真正成功返回结果的模型，而非调用方请求的首选模型。 */
  modelId: string;
};

type StructuredGenerateResult<TSchema extends z.ZodTypeAny> = LlmGenerateResult & {
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
    @Optional()
    @Inject(ROLE_MODEL_OVERRIDES)
    private readonly roleModelOverrides?: RoleModelOverridesProvider,
  ) {}

  async generate(options: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const { config, onPreparedRequest, onAttemptStart, thinking, validateResult, ...routeOptions } =
      options;
    const plan = await this.resolveExecutionPlanWithOverrides(routeOptions);
    const executionStartMs = Date.now();
    const trail: LlmAttemptTrace[] = [];
    let backoffTotalMs = 0;
    let lastRawError: unknown = null;
    const requiresVisionInput = this.hasVisionInput(routeOptions.messages);

    await this.emitPreparedRequest(plan, routeOptions, thinking, onPreparedRequest);

    let previousModelId: string | undefined;
    for (const modelId of this.iterateCandidateModels(plan)) {
      if (requiresVisionInput && !supportsVision(modelId)) {
        trail.push(this.buildSkippedAttempt(modelId, executionStartMs, '模型不支持图片输入'));
        continue;
      }
      if (!this.reliable.isModelAvailable(modelId)) {
        trail.push(this.buildSkippedAttempt(modelId, executionStartMs, 'provider未注册'));
        continue;
      }

      const model = this.registry.resolve(modelId);
      const effectiveThinking = this.resolveRequestThinking(modelId, thinking, requiresVisionInput);
      const providerOptions = this.buildProviderOptions(modelId, effectiveThinking);
      const params = this.buildGenerateParams(routeOptions, providerOptions);
      const retryConfig = this.reliable.getRetryConfig(config);

      this.emitModelAttempt(plan, modelId, previousModelId, this.formatAttempt(trail.at(-1)));
      previousModelId = modelId;

      for (let attempt = 1; attempt <= retryConfig.maxRetries; attempt += 1) {
        const attemptStartMs = Date.now();
        onAttemptStart?.({ modelId, attempt });
        try {
          const result = await generateText({
            ...params,
            model,
            maxRetries: 0,
          } as Parameters<typeof generateText>[0]);
          this.assertUsableChatResult(result, plan.role);
          validateResult?.(result);
          trail.push({
            modelId,
            attempt,
            startOffsetMs: attemptStartMs - executionStartMs,
            durationMs: Date.now() - attemptStartMs,
            status: 'success',
          });
          this.emitLlmExecution(plan, 'generate', modelId, trail, executionStartMs, backoffTotalMs);
          // 结果对象由 AI SDK 创建；附加路由层实际 modelId，供业务观测区分首选与 fallback。
          return Object.assign(result, { modelId });
        } catch (err) {
          lastRawError = err;
          const category = this.reliable.classifyError(err);
          const message = toErrorMessage(err);
          const entry: LlmAttemptTrace = {
            modelId,
            attempt,
            startOffsetMs: attemptStartMs - executionStartMs,
            durationMs: Date.now() - attemptStartMs,
            status: 'error',
            errorCategory: category,
            error: this.truncateErrorForTrace(message),
          };
          trail.push(entry);

          if (!this.reliable.shouldRetry(category, attempt, retryConfig)) {
            break;
          }

          const backoff = this.reliable.getBackoffMs(attempt, err, retryConfig);
          entry.backoffMs = backoff;
          backoffTotalMs += backoff;
          this.logger.warn(
            `${modelId} 重试 ${attempt}/${retryConfig.maxRetries}, 等待 ${backoff}ms`,
          );
          await sleep(backoff);
        }
      }
    }

    this.emitLlmExecution(plan, 'generate', null, trail, executionStartMs, backoffTotalMs);
    throw this.buildExhaustedError(plan, trail, lastRawError);
  }

  async generateStructured<TSchema extends z.ZodTypeAny>(
    options: LlmGenerateStructuredOptions<TSchema>,
  ): Promise<StructuredGenerateResult<TSchema>> {
    const { schema, outputName = 'StructuredOutput', validateOutput, ...rest } = options;
    const result = await this.generate({
      ...rest,
      output: Output.object({
        schema,
        name: outputName,
      }),
      // `output` is a lazy AI SDK getter. Access it before leaving generate() so
      // no-output failures use the same retry and model fallback policy as API errors.
      validateResult: (candidate) => {
        if (!candidate.output) throw new Error('No structured output returned');
        validateOutput?.(candidate.output);
      },
    });

    return result as StructuredGenerateResult<TSchema>;
  }

  async stream(options: LlmStreamOptions): Promise<ReturnType<typeof streamText>> {
    const { onPreparedRequest, thinking, ...routeOptions } = options;
    const plan = await this.resolveExecutionPlanWithOverrides(routeOptions);
    const executionStartMs = Date.now();
    const trail: LlmAttemptTrace[] = [];
    const requiresVisionInput = this.hasVisionInput(routeOptions.messages);
    await this.emitPreparedRequest(plan, routeOptions, thinking, onPreparedRequest);

    let lastError: Error | undefined;
    let previousModelId: string | undefined;
    for (const modelId of this.iterateCandidateModels(plan)) {
      if (requiresVisionInput && !supportsVision(modelId)) {
        trail.push(this.buildSkippedAttempt(modelId, executionStartMs, '模型不支持图片输入'));
        lastError = new Error(`模型不支持图片输入: ${modelId}`);
        continue;
      }
      if (!this.reliable.isModelAvailable(modelId)) {
        trail.push(this.buildSkippedAttempt(modelId, executionStartMs, 'provider未注册'));
        lastError = new Error(`模型不可用: ${modelId}`);
        continue;
      }

      const attemptStartMs = Date.now();
      try {
        this.emitModelAttempt(plan, modelId, previousModelId, this.formatAttempt(trail.at(-1)));
        previousModelId = modelId;
        const effectiveThinking = this.resolveRequestThinking(
          modelId,
          thinking,
          requiresVisionInput,
        );
        const streamResult = streamText({
          ...this.buildStreamParams(
            routeOptions,
            this.buildProviderOptions(modelId, effectiveThinking),
          ),
          model: this.registry.resolve(modelId),
        } as Parameters<typeof streamText>[0]);
        trail.push({
          modelId,
          attempt: 1,
          startOffsetMs: attemptStartMs - executionStartMs,
          durationMs: Date.now() - attemptStartMs,
          status: 'success',
        });
        this.emitLlmExecution(plan, 'stream', modelId, trail, executionStartMs, 0);
        return streamResult;
      } catch (error) {
        let err: Error;
        if (error instanceof Error) {
          err = error;
        } else {
          err = new Error(String(error));
        }
        lastError = err;
        trail.push({
          modelId,
          attempt: 1,
          startOffsetMs: attemptStartMs - executionStartMs,
          durationMs: Date.now() - attemptStartMs,
          status: 'error',
          errorCategory: this.reliable.classifyError(err),
          error: this.truncateErrorForTrace(err.message),
        });
        this.logger.warn(`流式初始化失败，尝试下一个模型: ${modelId}; ${err.message}`);
      }
    }

    this.emitLlmExecution(plan, 'stream', null, trail, executionStartMs, 0);
    throw this.buildExhaustedError(plan, trail, lastError);
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

  /**
   * 当前路由（primary + 降级链）是否有任一候选支持图片输入。
   *
   * 语义（2026-07-28 裁定）：只要链上存在认图候选就按多模态构建请求——纯文本主模型
   * （如 deepseek）会在生成时被 vision 闸门跳过，整轮落到链上首个认图候选亲眼看图，
   * 取代旧的「主模型不认图就预描述转文字」间接路径（信息保真更高、save_image_description
   * 回到一手描述）。链上全为纯文本模型时返回 false；该场景由 reply-workflow 的运行时
   * 兼容重跑兜底（入站预描述分支已于 2026-08-05 废弃）。
   */
  async supportsVisionInput(options: {
    role?: ModelRole | string;
    modelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
  }): Promise<boolean> {
    const plan = await this.resolveExecutionPlanWithOverrides(options);
    return this.iterateCandidateModels(plan).some((modelId) => supportsVision(modelId));
  }

  /**
   * 带运行时角色覆盖的路由解析。优先级：调用方显式 modelId > Dashboard 角色覆盖
   * （ROLE_MODEL_OVERRIDES，如 agent_reply_config.repairModelId）> AGENT_{ROLE}_MODEL
   * 环境变量。覆盖读取失败按无覆盖处理，绝不阻塞生成链路。
   */
  private async resolveExecutionPlanWithOverrides(options: {
    role?: ModelRole | string;
    modelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
  }): Promise<ExecutionPlan> {
    const effective = { ...options };
    const role = String(options.role ?? ModelRole.Chat);

    // 降级链覆盖：调用方未显式传 fallbacks 时，Dashboard 配置的链优先于环境变量链。
    if (effective.fallbacks === undefined && !effective.disableFallbacks) {
      try {
        const chain = await this.roleModelOverrides?.getFallbackChainOverride?.(role);
        if (chain?.length) {
          effective.fallbacks = chain;
        }
      } catch (error) {
        this.logger.warn(`读取降级链覆盖失败，回退环境变量链: role=${role}`, error);
      }
    }

    if (!effective.modelId?.trim() && this.roleModelOverrides) {
      try {
        const override = await this.roleModelOverrides.getRoleModelOverride(role);
        if (override) {
          return this.resolveExecutionPlan({ ...effective, modelId: override });
        }
      } catch (error) {
        this.logger.warn(`读取角色模型覆盖失败，回退环境变量路由: role=${role}`, error);
      }
    }
    return this.resolveExecutionPlan(effective);
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

  private buildSkippedAttempt(
    modelId: string,
    executionStartMs: number,
    reason: string,
  ): LlmAttemptTrace {
    return {
      modelId,
      attempt: 0,
      startOffsetMs: Date.now() - executionStartMs,
      durationMs: 0,
      status: 'skipped',
      error: reason,
    };
  }

  /** 尝试轨迹条目 → 单行可读文本（耗尽错误信息与 model_fallback reason 复用）。 */
  private formatAttempt(entry?: LlmAttemptTrace): string | undefined {
    if (!entry) return undefined;
    if (entry.status === 'skipped') return `${entry.modelId}: ${entry.error}`;
    const category = entry.errorCategory ? `${entry.errorCategory}; ` : '';
    return `${entry.modelId} attempt ${entry.attempt}: ${category}${entry.error ?? entry.status}`;
  }

  /** provider 错误可能携带响应体片段；事件表只留可归因的头部，全文归日志/异常链路。 */
  private truncateErrorForTrace(message: string): string {
    const MAX_LENGTH = 300;
    return message.length <= MAX_LENGTH ? message : `${message.slice(0, MAX_LENGTH)}…`;
  }

  /** 一次 llm-executor 调用收尾（成功或耗尽）时无条件发射尝试轨迹事件。 */
  private emitLlmExecution(
    plan: ExecutionPlan,
    mode: 'generate' | 'stream',
    finalModelId: string | null,
    attempts: LlmAttemptTrace[],
    executionStartMs: number,
    backoffTotalMs: number,
  ): void {
    this.tracer?.emit({
      type: 'llm_execution',
      role: String(plan.role),
      mode,
      primaryModelId: plan.primaryModelId,
      finalModelId,
      status: finalModelId !== null ? 'success' : 'exhausted',
      attemptCount: attempts.filter((entry) => entry.status !== 'skipped').length,
      totalDurationMs: Date.now() - executionStartMs,
      backoffTotalMs,
      attempts,
    });
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
    // 深度思考档位：缺省 high 保持历史行为；仅深度模式使用。
    const effort = thinking.effort ?? 'high';

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
            anthropic: { thinking: { type: 'adaptive' }, effort },
          } as ProviderOptions;
        }
        return { anthropic: { thinking: { type: 'enabled', budgetTokens } } } as ProviderOptions;
      case 'deepseek':
        return {
          deepseek: { thinking: { type: 'enabled' }, reasoningEffort: effort },
        } as ProviderOptions;
      case 'google':
        return {
          google: {
            thinkingConfig: {
              thinkingBudget: budgetTokens,
              thinkingLevel: effort,
            },
          },
        } as ProviderOptions;
      case 'openai':
        return { openai: { reasoningEffort: effort } } as ProviderOptions;
      case 'qwen':
        return { qwen: { enable_thinking: true, reasoningEffort: effort } } as ProviderOptions;
      case 'moonshotai':
      case 'ohmygpt':
      case 'gateway':
      case 'openrouter':
        return { openai: { reasoningEffort: effort } } as ProviderOptions;
      default:
        return undefined;
    }
  }

  private requiresAdaptiveAnthropicThinking(modelId: string): boolean {
    const anthropicModelId = modelId.split('/').pop() ?? modelId;
    const match = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?/.exec(anthropicModelId);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(match[2]);
    // 4.7+ 起 adaptive thinking + effort 成为推荐配置；5 系（Opus 5/Sonnet 5/Fable 5）默认自适应。
    return major > 4 || (major === 4 && minor >= 7);
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

    // 注意：多步循环早已从 maxSteps 迁移到 stopWhen，这里必须按 tools 是否存在分支；
    // 旧的 `'maxSteps' in options` 判断恒为 false，导致追溯快照永远缺 toolNames。
    const instructionSnapshot =
      options.instructions !== undefined
        ? { instructions: options.instructions }
        : { system: options.system };
    const params =
      options.tools && Object.keys(options.tools).length > 0
        ? {
            ...instructionSnapshot,
            messages: options.messages,
            maxOutputTokens: options.maxOutputTokens,
            toolNames: Object.keys(options.tools),
          }
        : {
            ...instructionSnapshot,
            messages: options.messages,
            prompt: 'prompt' in options ? options.prompt : undefined,
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
    attempts: LlmAttemptTrace[],
    lastRawError: unknown,
  ): AgentError {
    const lines = attempts
      .map((entry) => this.formatAttempt(entry))
      .filter((line): line is string => Boolean(line));
    const trail = lines.length > 0 ? lines.join('\n  ') : '无可用模型';
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
