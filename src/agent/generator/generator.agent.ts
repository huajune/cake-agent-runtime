/** Agent 执行编排：prepare -> model -> turn end lifecycle。 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hasToolCall, stepCountIs, type generateText } from 'ai';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { MemoryService } from '@memory/memory.service';
import { PreparationService, type PreparedAgentContext } from './preparation.service';
import type { AgentError } from '@shared-types/agent-error.types';
import {
  buildSideEffectBlockNotice,
  buildToolCallLimitNotice,
  collectCalledToolNames,
  computeResultCount,
  computeToolCallStatus,
  findSucceededSideEffectTools,
  findToolsExceedingLimit,
  isShortCircuitedToolResult,
  MAX_SAME_TOOL_CALLS_PER_TURN,
} from './tool-call-analysis';

/**
 * 跳过本轮回复的沉默工具名。
 *
 * 约束：
 * - 只能在本轮尚未发生任何其它工具调用时使用（prepareStep 互斥）
 * - 一旦被调用，stopWhen 立即结束本轮 loop，不再进入下一步
 */
const SKIP_REPLY_TOOL_NAME = 'skip_reply';

/** 候选人可见正文被写在 tool-call step 时，低于这个长度的中间片段通常只是“我先查下”。 */
const SUBSTANTIVE_STEP_TEXT_MIN_CHARS = 80;

/** 模型偶发把阶段流转状态当成最终回复；这类文本绝不能作为候选人可见内容。 */
const INTERNAL_STATUS_TEXT_PATTERNS: RegExp[] = [
  /阶段已切换|阶段切换到|阶段推进到|已切换到[^。！？\n]{0,30}阶段/,
  /等待候选人(?:反馈|回应|回复|确认|提供|补充)[^。！？\n]{0,30}(?:意向|信息|结果|选择)/,
  /当前阶段策略|阶段成功标准|effectiveStageStrategy|nextStage|currentStage|fromStage/,
];

/**
 * stopWhen 条件：当任意工具的 toolResult 标记 `shortCircuited: true` 时结束本轮 loop。
 *
 * ⚠️ AI SDK 的 toolResult 取值用 `.output` 而非 `.result`（与 buildRunResult 中的取法一致）。
 */
const shortCircuitByAnyToolResult = ({
  steps,
}: {
  steps: Array<{ toolResults?: Array<{ output?: unknown }> }>;
}): boolean => {
  const lastStep = steps[steps.length - 1];
  return (lastStep?.toolResults ?? []).some((r) => isShortCircuitedToolResult(r.output));
};

/** prepareStep 函数类型（沿用 ai SDK，本地不必锁死 TOOLS 泛型）。 */
type PrepareStepFn = NonNullable<Parameters<typeof generateText>[0]['prepareStep']>;
import type {
  GeneratorThinkingConfig,
  GeneratorInvokeParams,
  GeneratorRunResult,
  AgentStepDetail,
  GeneratorStreamResult,
  AgentToolCall,
} from './generator.types';
export type {
  GeneratorInputMessage,
  GeneratorInvokeParams,
  GeneratorRunResult,
  AgentStepDetail,
  GeneratorStreamResult,
  AgentToolCall,
  AgentToolCallStatus,
} from './generator.types';

@Injectable()
export class GeneratorAgent {
  private readonly logger = new Logger(GeneratorAgent.name);

  /** thinking token 预算，>0 时启用 extended thinking */
  private readonly thinkingBudgetTokens: number;
  /** 输出 token 上限 */
  private readonly maxOutputTokens: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly preparation: PreparationService,
    private readonly memoryService: MemoryService,
    private readonly llm: LlmExecutorService,
  ) {
    this.thinkingBudgetTokens = parseInt(
      this.configService.get('AGENT_THINKING_BUDGET_TOKENS', '0'),
      10,
    );
    this.maxOutputTokens = parseInt(this.configService.get('AGENT_MAX_OUTPUT_TOKENS', '4096'), 10);
    if (this.thinkingBudgetTokens > 0) {
      this.logger.log(`Extended thinking 已启用, budgetTokens=${this.thinkingBudgetTokens}`);
    }
    this.logger.log(`maxOutputTokens=${this.maxOutputTokens}`);
  }

  /** 非流式执行入口。 */
  async invoke(params: GeneratorInvokeParams): Promise<GeneratorRunResult> {
    const enableVision = this.llm.supportsVisionInput({
      role: ModelRole.Chat,
      modelId: params.modelId,
      disableFallbacks: params.disableFallbacks,
    });
    const ctx = await this.preparation.prepare(params, 'invoke', { enableVision });

    if (ctx.normalizedMessages.length === 0) {
      throw this.createEmptyMessagesError(ctx);
    }

    try {
      let agentRequest: Record<string, unknown> | undefined;
      const stepStartMs = Date.now();
      const stepEndWallclocks: number[] = [];
      const r = await this.llm.generate({
        role: ModelRole.Chat,
        modelId: params.modelId,
        disableFallbacks: params.disableFallbacks,
        thinking: this.resolveThinkingConfig(params.thinking),
        system: ctx.finalPrompt,
        messages: ctx.normalizedMessages,
        tools: ctx.tools,
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: [
          stepCountIs(ctx.maxSteps),
          hasToolCall(SKIP_REPLY_TOOL_NAME), // skip_reply 无条件短路
          shortCircuitByAnyToolResult, // 任意工具 shortCircuited=true 即短路
        ],
        prepareStep: this.buildPrepareStep(ctx),
        onStepFinish: () => {
          stepEndWallclocks.push(Date.now());
        },
        onPreparedRequest: async (request) => {
          agentRequest = request;
          if (params.onPreparedRequest) {
            await Promise.resolve(params.onPreparedRequest(request));
          }
        },
      });

      if (r.reasoningText) {
        this.logger.debug(`Thinking: ${r.reasoningText.substring(0, 200)}...`);
      }
      this.logger.log(`Loop 完成: steps=${r.steps.length}, tokens=${r.usage.totalTokens}`);

      let result = this.buildRunResult({
        text: r.text,
        reasoningText: r.reasoningText,
        responseMessages: r.response?.messages as Array<Record<string, unknown>> | undefined,
        steps: r.steps,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
        agentRequest,
        memorySnapshot: ctx.memorySnapshot,
        stepStartMs,
        stepEndWallclocks,
        toolExecutionTimings: ctx.toolExecutionTimings,
      });

      result = this.restoreDroppedCandidateText(result);
      result = await this.recoverEmptyTextResult(result, ctx, params);

      this.attachTurnEnd(result, ctx, params.messageId, result.text, params.deferTurnEnd);

      return result;
    } catch (err) {
      const agentError = this.enrichAgentError(err, ctx);
      this.logger.error('Agent 执行失败', agentError);
      throw agentError;
    }
  }

  /** 流式执行入口。 */
  async stream(
    params: GeneratorInvokeParams & {
      onFinish?: (result: GeneratorRunResult) => Promise<void> | void;
    },
  ): Promise<GeneratorStreamResult> {
    const enableVision = this.llm.supportsVisionInput({
      role: ModelRole.Chat,
      modelId: params.modelId,
      disableFallbacks: params.disableFallbacks,
    });
    const ctx = await this.preparation.prepare(params, 'stream', { enableVision });

    if (ctx.normalizedMessages.length === 0) {
      throw this.createEmptyMessagesError(ctx);
    }

    try {
      let agentRequest: Record<string, unknown> | undefined;
      const stepStartMs = Date.now();
      const stepEndWallclocks: number[] = [];
      const streamResult = await this.llm.stream({
        role: ModelRole.Chat,
        modelId: params.modelId,
        disableFallbacks: params.disableFallbacks,
        thinking: this.resolveThinkingConfig(params.thinking),
        system: ctx.finalPrompt,
        messages: ctx.normalizedMessages,
        tools: ctx.tools,
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: [
          stepCountIs(ctx.maxSteps),
          hasToolCall(SKIP_REPLY_TOOL_NAME), // skip_reply 无条件短路
          shortCircuitByAnyToolResult, // 任意工具 shortCircuited=true 即短路
        ],
        prepareStep: this.buildPrepareStep(ctx),
        onStepFinish: () => {
          stepEndWallclocks.push(Date.now());
        },
        onPreparedRequest: async (request) => {
          agentRequest = request;
          if (params.onPreparedRequest) {
            await Promise.resolve(params.onPreparedRequest(request));
          }
        },
        onFinish: ({ usage, steps, text }) => {
          this.logger.log('流式完成, 步数: ' + steps.length + ', Tokens: ' + usage.totalTokens);
          let result = this.buildRunResult({
            text,
            reasoningText: undefined,
            steps,
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens,
            },
            agentRequest,
            memorySnapshot: ctx.memorySnapshot,
            stepStartMs,
            stepEndWallclocks,
            toolExecutionTimings: ctx.toolExecutionTimings,
          });
          result = this.restoreDroppedCandidateText(result);
          this.attachTurnEnd(result, ctx, params.messageId, result.text, params.deferTurnEnd);
          if (params.onFinish) {
            Promise.resolve(params.onFinish(result)).catch((err) =>
              this.logger.warn('流式完成回调执行失败', err),
            );
          }
        },
      });

      return { streamResult, entryStage: ctx.entryStage, agentRequest };
    } catch (err) {
      const agentError = this.enrichAgentError(err, ctx);
      this.logger.error('Agent 流式执行失败', agentError);
      throw agentError;
    }
  }

  private resolveThinkingConfig(requestThinking?: GeneratorThinkingConfig) {
    if (requestThinking) return requestThinking;
    if (this.thinkingBudgetTokens <= 0) return undefined;
    return {
      type: 'enabled' as const,
      budgetTokens: this.thinkingBudgetTokens,
    };
  }

  /**
   * 构造 prepareStep 钩子：动态屏蔽工具以收敛本轮行为。
   *
   * 三类屏蔽规则：
   * 1. **同名工具调用超限**：单轮同一工具 ≥ MAX_SAME_TOOL_CALLS_PER_TURN 次时屏蔽
   *    （典型如 duliday_job_list 用不稳定字段反复扩面）。
   * 2. **skip_reply 互斥**：本轮只要已经调用过任何其它工具，禁止再调 skip_reply——
   *    沉默只能发生在完全没有业务动作的轮次，已有动作后的沉默属于误用。
   * 3. **副作用工具成功后屏蔽**：booking/invite/cancel/modify 本轮已成功执行一次后
   *    禁止重复调用（防重复提交预约等）；失败后的重试不受限（允许修正参数自纠错）。
   *
   * 屏蔽方式 = activeTools 白名单移除 + system 末尾拼拦截说明。备选方案 stopWhen
   * 会直接结束整轮，可能导致没有最终回复输出；prepareStep 让模型仍能用其他工具或
   * 文本完成本轮。
   */
  private buildPrepareStep(ctx: PreparedAgentContext): PrepareStepFn | undefined {
    const baseTools = Object.keys(ctx.tools ?? {});
    if (baseTools.length === 0) return undefined;
    const baseSystem = ctx.finalPrompt;
    const sessionId = ctx.sessionId;
    const logger = this.logger;

    return ({ steps }) => {
      const overused = findToolsExceedingLimit(steps, MAX_SAME_TOOL_CALLS_PER_TURN);

      // 本轮已调用过业务工具（非 skip_reply 自身）→ 屏蔽 skip_reply
      const called = collectCalledToolNames(steps);
      const hasBusinessAction = [...called].some((name) => name !== SKIP_REPLY_TOOL_NAME);
      const skipReplyBlocked =
        hasBusinessAction && baseTools.includes(SKIP_REPLY_TOOL_NAME) ? [SKIP_REPLY_TOOL_NAME] : [];

      // 副作用工具本轮已成功执行 → 屏蔽，防止重复提交
      const sideEffectBlocked = findSucceededSideEffectTools(steps).filter((name) =>
        baseTools.includes(name),
      );

      const blocked = Array.from(new Set([...overused, ...skipReplyBlocked, ...sideEffectBlocked]));
      if (blocked.length === 0) return {};

      const activeTools = baseTools.filter((name) => !blocked.includes(name));
      const noticeParts: string[] = [];
      const overuseNotice = buildToolCallLimitNotice(
        overused.filter((name) => !sideEffectBlocked.includes(name)),
        MAX_SAME_TOOL_CALLS_PER_TURN,
      );
      if (overuseNotice) noticeParts.push(overuseNotice);
      if (skipReplyBlocked.length > 0) {
        noticeParts.push(
          `⚠️ 系统拦截：本轮已发生业务工具调用，不可再调用 \`${SKIP_REPLY_TOOL_NAME}\`。沉默仅适用于本轮完全无业务动作且候选人仅发确认词的场景。`,
        );
      }
      const sideEffectNotice = buildSideEffectBlockNotice(sideEffectBlocked);
      if (sideEffectNotice) noticeParts.push(sideEffectNotice);
      const system =
        noticeParts.length > 0 ? `${baseSystem}\n\n${noticeParts.join('\n')}` : baseSystem;

      logger.warn(
        `工具调用硬截断: blocked=${blocked.join(',')} stepCount=${steps.length} sessionId=${sessionId}`,
      );

      // activeTools 在 SDK 内部要求是 keyof TOOLS；这里 TOOLS 是 ToolSet 索引签名，
      // 直接用 string[] 在运行时一致，仅做类型 cast。
      return {
        activeTools: activeTools as Array<string | number | symbol>,
        system,
      };
    };
  }

  /**
   * 统一触发回合结束收尾。
   *
   * 记忆收尾不阻塞主响应；失败只记日志，避免把模型成功回复拖慢或放大成整轮失败。
   */
  private async runTurnEndLifecycle(
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      | 'corpId'
      | 'userId'
      | 'sessionId'
      | 'messageId'
      | 'botImId'
      | 'normalizedMessages'
      | 'contactName'
    > & {
      turnState: {
        candidatePool: Parameters<MemoryService['onTurnEnd']>[0]['candidatePool'];
        imageBrandResolutions: Parameters<MemoryService['onTurnEnd']>[0]['imageBrandResolutions'];
      };
    },
    assistantText?: string,
  ): Promise<void> {
    await this.memoryService.onTurnEnd(
      {
        corpId: ctx.corpId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        botImId: ctx.botImId,
        normalizedMessages: ctx.normalizedMessages,
        candidatePool: ctx.turnState.candidatePool,
        contactName: ctx.contactName,
        imageBrandResolutions: ctx.turnState.imageBrandResolutions,
      },
      assistantText,
    );
  }

  private dispatchTurnEndLifecycle(
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      | 'corpId'
      | 'userId'
      | 'sessionId'
      | 'messageId'
      | 'botImId'
      | 'normalizedMessages'
      | 'contactName'
    > & {
      turnState: {
        candidatePool: Parameters<MemoryService['onTurnEnd']>[0]['candidatePool'];
        imageBrandResolutions: Parameters<MemoryService['onTurnEnd']>[0]['imageBrandResolutions'];
      };
    },
    assistantText?: string,
  ): void {
    void this.runTurnEndLifecycle(ctx, assistantText).catch((err) =>
      this.logger.warn('记忆生命周期执行失败', err),
    );
  }

  /**
   * 根据 deferTurnEnd 决定是 fire-and-forget 立即触发，还是把触发器暴露给调用方。
   *
   * 延迟模式用于 replay：首次生成结果可能被后续合并消息丢弃，若立即触发
   * projectAssistantTurn/extractFacts 会把「本应丢弃」的首次回复写进 session 记忆，
   * 污染下一轮 recall。
   */
  private attachTurnEnd(
    result: GeneratorRunResult,
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      'corpId' | 'userId' | 'sessionId' | 'botImId' | 'normalizedMessages' | 'contactName'
    > & {
      turnState: {
        candidatePool: Parameters<MemoryService['onTurnEnd']>[0]['candidatePool'];
        imageBrandResolutions: Parameters<MemoryService['onTurnEnd']>[0]['imageBrandResolutions'];
      };
    },
    messageId: string | undefined,
    assistantText: string,
    deferTurnEnd: boolean | undefined,
  ): void {
    const lifecycleCtx = { ...ctx, messageId };
    if (!deferTurnEnd) {
      this.dispatchTurnEndLifecycle(lifecycleCtx, assistantText);
      return;
    }

    let consumed = false;
    result.runTurnEnd = async (opts?: { includeAssistantText?: boolean }) => {
      if (consumed) return;
      consumed = true;
      // includeAssistantText=false：回复未真实送达（守卫拦截/沉默/投递失败），
      // 只跑用户侧收尾（事实提取等），不把未送达文本投影成助手轮次。
      const includeAssistantText = opts?.includeAssistantText !== false;
      await this.runTurnEndLifecycle(
        lifecycleCtx,
        includeAssistantText ? assistantText : undefined,
      );
    };
  }

  private buildRunResult(params: {
    text: string;
    reasoningText?: string;
    responseMessages?: Array<Record<string, unknown>>;
    steps: Array<{
      text?: string;
      reasoningText?: string;
      finishReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      response?: { timestamp?: Date | string | number };
      toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
      toolResults?: Array<{ toolCallId: string; output?: unknown }>;
    }>;
    usage: GeneratorRunResult['usage'];
    agentRequest?: Record<string, unknown>;
    memorySnapshot?: GeneratorRunResult['memorySnapshot'];
    /**
     * 本轮 generate/stream 开始的 wallclock 时间（`Date.now()`）。
     * 作为第 0 步的"上一步结束时间"锚点。
     */
    stepStartMs?: number;
    /**
     * 每个 step 结束的 wallclock 时间（通过 Vercel AI SDK `onStepFinish` 记录）。
     * 提供毫秒级精度；若不提供，回退到 `step.response.timestamp`（可能是秒级精度，
     * 导致 durationMs 出现 1000ms 整数倍的假象）。
     */
    stepEndWallclocks?: number[];
    /**
     * toolCallId → 工具 execute 真实耗时（由 preparation 的 timing wrapper 记录）。
     * 命中时 AgentToolCall.durationMs 用真实执行时间；缺失时退回步骤墙钟近似。
     */
    toolExecutionTimings?: Map<string, number>;
  }): GeneratorRunResult {
    const agentSteps: AgentStepDetail[] = [];
    const toolCalls: AgentToolCall[] = [];

    let prevStepEndMs: number | undefined = params.stepStartMs;
    params.steps.forEach((step, stepIndex) => {
      const wallclockEnd = params.stepEndWallclocks?.[stepIndex];
      const stepEndMs = wallclockEnd ?? this.extractTimestampMs(step.response?.timestamp);
      const stepDurationMs =
        prevStepEndMs !== undefined && stepEndMs !== undefined
          ? Math.max(stepEndMs - prevStepEndMs, 0)
          : undefined;

      const stepToolCalls: AgentToolCall[] = [];
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          const tr = step.toolResults?.find((t) => t.toolCallId === tc.toolCallId);
          const result = (tr as { output?: unknown } | undefined)?.output;
          const resultCount = computeResultCount(result);
          const status = computeToolCallStatus(
            result,
            resultCount,
            undefined,
            undefined,
            tc.toolName,
          );
          // 优先用 timing wrapper 记录的真实执行耗时；
          // 缺失时退回旧近似（单工具步的步骤墙钟，含 LLM 思考时间）
          const executionMs = params.toolExecutionTimings?.get(tc.toolCallId);
          const durationMs =
            executionMs ??
            (stepDurationMs !== undefined && step.toolCalls.length === 1
              ? stepDurationMs
              : undefined);

          const call: AgentToolCall = {
            toolName: tc.toolName,
            args: ((tc as { input?: unknown }).input ?? {}) as Record<string, unknown>,
            result,
            resultCount,
            status,
            durationMs,
          };
          stepToolCalls.push(call);
          toolCalls.push(call);
        }
      }

      agentSteps.push({
        stepIndex,
        text: step.text || undefined,
        reasoning: step.reasoningText || undefined,
        toolCalls: stepToolCalls,
        usage:
          step.usage && step.usage.totalTokens !== undefined
            ? {
                inputTokens: step.usage.inputTokens ?? 0,
                outputTokens: step.usage.outputTokens ?? 0,
                totalTokens: step.usage.totalTokens,
              }
            : undefined,
        durationMs: stepDurationMs,
        finishReason: step.finishReason,
      });

      if (stepEndMs !== undefined) prevStepEndMs = stepEndMs;
    });

    return {
      text: params.text,
      reasoning: params.reasoningText || undefined,
      responseMessages: params.responseMessages,
      steps: params.steps.length,
      agentSteps,
      toolCalls,
      usage: params.usage,
      agentRequest: params.agentRequest,
      memorySnapshot: params.memorySnapshot,
    };
  }

  /**
   * AI SDK 多步 loop 中，模型可能先生成一大段候选人可见正文，再在同一个 step 调工具
   * （典型是 `advance_stage`）。最终 `generateText().text` 只包含最后一个无工具 step 的文本，
   * 导致前面正文只留在 `steps[n].text` / 后台流水里，没有真正投递给候选人。
   *
   * 这里把“足够长的中间候选人正文”恢复进最终 text，并丢弃明显的内部阶段状态回声。
   */
  private restoreDroppedCandidateText(result: GeneratorRunResult): GeneratorRunResult {
    if (result.agentSteps.length <= 1) return result;

    const fragments: string[] = [];
    let hasSubstantiveNonFinalText = false;
    const lastIndex = result.agentSteps.length - 1;

    for (const step of result.agentSteps) {
      const text = this.normalizeStepText(step.text);
      if (!text || this.isInternalStatusText(text)) continue;

      const isFinalStep = step.stepIndex === lastIndex;
      if (!isFinalStep) {
        if (!this.isSubstantiveStepText(text)) continue;
        hasSubstantiveNonFinalText = true;
      }

      this.addRestoredFragment(fragments, text);
    }

    if (!hasSubstantiveNonFinalText) return result;

    const restoredText = fragments.join('\n\n').trim();
    if (!restoredText || restoredText === result.text.trim()) return result;

    this.logger.warn(
      `检测到候选人正文落在 tool-call step，已恢复最终回复: sessionTextChars=${result.text.length}, restoredTextChars=${restoredText.length}`,
    );

    return { ...result, text: restoredText };
  }

  private normalizeStepText(text: string | undefined): string {
    return (text ?? '').replace(/\r\n/g, '\n').trim();
  }

  private isSubstantiveStepText(text: string): boolean {
    return text.length >= SUBSTANTIVE_STEP_TEXT_MIN_CHARS;
  }

  private isInternalStatusText(text: string): boolean {
    return INTERNAL_STATUS_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  }

  private addRestoredFragment(fragments: string[], text: string): void {
    for (let i = fragments.length - 1; i >= 0; i -= 1) {
      const existing = fragments[i];
      if (existing === text || existing.includes(text)) return;
      if (text.includes(existing)) {
        fragments.splice(i, 1);
      }
    }

    fragments.push(text);
  }

  /**
   * 工具链偶发会以“有 reasoning / 有 tool results，但最终 text 为空”结束。
   *
   * 这类结果直接抛给上层会导致用户只收到兜底话术；这里做一次无工具文本恢复：
   * - 不再开放工具，避免重复预约/拉群等副作用
   * - 把已执行工具结果压缩成 transcript，让模型只补一条候选人可见回复
   * - 恢复失败时保留原空结果，让上层按既有异常链路处理
   */
  private async recoverEmptyTextResult(
    result: GeneratorRunResult,
    ctx: PreparedAgentContext,
    params: GeneratorInvokeParams,
  ): Promise<GeneratorRunResult> {
    if (result.text.trim().length > 0) return result;
    // 已短路则不做空文本恢复（短路语义=本轮不再对外投递回复）：
    // - skip_reply：无条件短路
    // - 其他工具：仅当返回值标记 shortCircuited 时算短路；HANDOFF_NO_BOOKING（false）
    //   不算短路，booking gate hard-reject（true）算短路。
    const didShortCircuit = result.toolCalls.some((call) => {
      if (call.toolName === SKIP_REPLY_TOOL_NAME) return true;
      return isShortCircuitedToolResult(call.result);
    });
    if (didShortCircuit) {
      return result;
    }

    this.logger.warn(
      `Agent 返回空文本，尝试无工具恢复: sessionId=${ctx.sessionId}, steps=${result.steps}`,
    );

    try {
      const recoveryUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      const recovery = await this.llm.generate({
        role: ModelRole.Chat,
        modelId: params.modelId,
        disableFallbacks: params.disableFallbacks,
        thinking: { type: 'disabled', budgetTokens: 0 },
        system: `${ctx.finalPrompt}\n\n[空响应恢复模式]\n只输出一条候选人可见的中文回复。不要提系统、工具、模型、thinking、恢复或异常。不要调用工具。`,
        prompt: this.buildEmptyTextRecoveryPrompt(result, ctx),
        maxOutputTokens: Math.min(this.maxOutputTokens, 800),
      });

      const text = recovery.text?.trim() ?? '';
      recoveryUsage.inputTokens = recovery.usage.inputTokens ?? 0;
      recoveryUsage.outputTokens = recovery.usage.outputTokens ?? 0;
      recoveryUsage.totalTokens = recovery.usage.totalTokens ?? 0;

      if (!text) {
        this.logger.warn(`空文本恢复仍未产出回复: sessionId=${ctx.sessionId}`);
        return result;
      }

      this.logger.log(
        `空文本恢复成功: sessionId=${ctx.sessionId}, tokens=${recoveryUsage.totalTokens}`,
      );

      return {
        ...result,
        text,
        responseMessages: [
          ...(result.responseMessages ?? []),
          ...((recovery.response?.messages as Array<Record<string, unknown>> | undefined) ?? []),
        ],
        steps: result.steps + 1,
        agentSteps: [
          ...result.agentSteps,
          {
            stepIndex: result.agentSteps.length,
            text,
            reasoning: recovery.reasoningText || undefined,
            toolCalls: [],
            usage: recoveryUsage,
            finishReason: 'empty-text-recovery',
          },
        ],
        usage: {
          inputTokens: result.usage.inputTokens + recoveryUsage.inputTokens,
          outputTokens: result.usage.outputTokens + recoveryUsage.outputTokens,
          totalTokens: result.usage.totalTokens + recoveryUsage.totalTokens,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `空文本恢复失败: sessionId=${ctx.sessionId}; ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return result;
    }
  }

  private buildEmptyTextRecoveryPrompt(
    result: GeneratorRunResult,
    ctx: PreparedAgentContext,
  ): string {
    const transcript = result.agentSteps.map((step) => ({
      stepIndex: step.stepIndex,
      finishReason: step.finishReason,
      text: step.text ? this.truncateForPrompt(step.text, 1000) : undefined,
      reasoning: step.reasoning ? this.truncateForPrompt(step.reasoning, 1200) : undefined,
      toolCalls: step.toolCalls.map((call) => ({
        toolName: call.toolName,
        args: call.args,
        status: call.status,
        resultCount: call.resultCount,
        result: this.truncateForPrompt(this.safeJsonStringify(call.result), 5000),
      })),
    }));

    return [
      '上一轮工具链已经执行完，但最终没有产出可发送文本。',
      '下面是候选人与招募经理的当前对话上下文，以及刚执行过的工具调用摘要。',
      '请基于当前对话和下面的工具调用摘要，直接补一条候选人可见回复。',
      '要求：',
      '- 只输出回复正文，不要解释内部过程。',
      '- 如果工具结果显示 requestedDate.status=unavailable，必须明确说明不可约原因，并给最近可选替代时间。',
      '- 不要编造工具结果，不要承诺已经预约成功。',
      '',
      '对话上下文：',
      this.truncateForPrompt(this.formatMessagesForRecovery(ctx.normalizedMessages), 8000),
      '',
      '工具调用摘要：',
      this.truncateForPrompt(this.safeJsonStringify(transcript), 14000),
    ].join('\n');
  }

  private formatMessagesForRecovery(messages: PreparedAgentContext['normalizedMessages']): string {
    return messages
      .map((message) => {
        const content = this.stringifyMessageContent(message.content);
        return `${message.role}: ${content}`;
      })
      .join('\n');
  }

  private stringifyMessageContent(content: unknown): string {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part !== 'object' || part === null) return String(part);

          const typedPart = part as Record<string, unknown>;
          if (typeof typedPart.text === 'string') return typedPart.text;
          if (typeof typedPart.content === 'string') return typedPart.content;
          if (typeof typedPart.type === 'string') return `[${typedPart.type}]`;
          return this.safeJsonStringify(typedPart);
        })
        .join('');
    }

    if (content === undefined || content === null) return '';
    return this.safeJsonStringify(content);
  }

  private safeJsonStringify(value: unknown): string {
    try {
      const json = JSON.stringify(value, null, 2);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }

  private truncateForPrompt(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
  }

  private extractTimestampMs(value: unknown): number | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private createEmptyMessagesError(
    ctx: Pick<
      PreparedAgentContext,
      'sessionId' | 'userId' | 'normalizedMessages' | 'memoryLoadWarning'
    >,
  ): AgentError {
    return this.enrichAgentError(
      new Error(
        `messages 为空，无法调用 LLM | sessionId=${ctx.sessionId}` +
          ` | memoryWarning=${ctx.memoryLoadWarning ?? 'none'}`,
      ),
      ctx,
    );
  }

  private enrichAgentError(
    err: unknown,
    ctx: Pick<
      PreparedAgentContext,
      'sessionId' | 'userId' | 'normalizedMessages' | 'memoryLoadWarning'
    >,
  ): AgentError {
    const error =
      err instanceof Error ? (err as AgentError) : (new Error(String(err)) as AgentError);

    error.isAgentError = true;
    error.agentMeta = {
      ...(error.agentMeta ?? {}),
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      messageCount: ctx.normalizedMessages.length,
      memoryLoadWarning: ctx.memoryLoadWarning,
      modelsAttempted: error.agentMeta?.modelsAttempted,
      lastCategory: error.agentMeta?.lastCategory,
    };

    return error;
  }
}
