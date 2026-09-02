import { Injectable, Logger, Optional } from '@nestjs/common';
import { MemoryConfig } from '@memory/memory.config';
import { AlertLevel } from '@enums/alert.enum';
import { toErrorMessage } from '@infra/utils/error.util';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { PromptInjectionDetector } from '../../guardrail/input/prompt-injection-detector';
import { PromptSecurityObserverService } from '../../guardrail/input/prompt-security-observer.service';
import { ContextService } from '../context/context.service';
import type { ModelMessage, ToolSet } from 'ai';
import type { TurnLedger } from '@shared-types/turn.types';
import type { CorpusBlock, PromptCorpusBlock } from '@shared-types/corpus.types';
import { type AgentMemorySnapshot, type GeneratorInvokeParams } from '../generator.types';
import { normalizeConversationWithCorpus, normalizeTurnInput } from './conversation-normalizer';
import { TurnDataLoaderService } from './turn-data-loader.service';
import { resolveTurnContext } from './turn-context-resolver';
import { ToolRuntimeBuilderService } from './tool-context.builder';
import { AgentTracerService } from '@observability/agent-tracer.service';

/**
 * Working Memory（CoALA 语义）：prepare() 返回的单轮工作台，不是持久化记忆层。
 */
export interface WorkingMemory {
  finalPrompt: string;
  promptBlocks: PromptCorpusBlock[];
  normalizedMessages: ModelMessage[];
  conversationCorpusBlocks: CorpusBlock[];
  memoryLoadWarning?: string;
  tools: ToolSet;
  corpId: string;
  userId: string;
  sessionId: string;
  botUserId?: string;
  botImId?: string;
  maxSteps: number;
  entryStage: string | null;
  ledger: TurnLedger;
  contactName?: string;
  memorySnapshot?: AgentMemorySnapshot;
  /** toolCallId → 工具 execute 的真实执行耗时（毫秒）。 */
  toolExecutionTimings: Map<string, number>;
}

/**
 * 回合准备门面：输入归一化 → 外部源快照 → 对话归一化 → 事实裁决 → Prompt 编译 → 工具运行时。
 *
 * 具体 IO、事实规则、Prompt 渲染和工具装配分别由专属组件承担；本类只维持阶段顺序、
 * WorkingMemory 契约与出口级观测。
 */
@Injectable()
export class PreparationService {
  private readonly logger = new Logger(PreparationService.name);

  constructor(
    private readonly memoryConfig: MemoryConfig,
    private readonly dataLoader: TurnDataLoaderService,
    private readonly context: ContextService,
    private readonly injectionDetector: PromptInjectionDetector,
    private readonly securityObserver: PromptSecurityObserverService,
    private readonly toolRuntimeBuilder: ToolRuntimeBuilderService,
    @Optional() private readonly alertNotifier?: AlertNotifierService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  async prepare(
    params: GeneratorInvokeParams,
    mode: 'invoke' | 'stream',
    options?: { enableVision?: boolean },
  ): Promise<WorkingMemory> {
    const scenario = params.scenario ?? 'candidate-consultation';
    const maxSteps = params.maxSteps ?? 10;
    this.logger.log(
      `Agent ${mode}: callerKind=${params.callerKind}, userId=${params.userId}, corpId=${params.corpId}, sessionId=${params.sessionId}, scenario=${scenario}`,
    );
    const startedAt = Date.now();
    const phaseDurationsMs: Record<string, number> = {};
    try {
      const input = measurePhase(phaseDurationsMs, 'normalize_input', () =>
        normalizeTurnInput(params, this.memoryConfig.sessionWindowMaxChars),
      );
      const sources = await measureAsyncPhase(phaseDurationsMs, 'load_sources', () =>
        this.dataLoader.load(params, input),
      );
      const { messages: normalizedMessages, corpusBlocks: conversationCorpusBlocks } = measurePhase(
        phaseDurationsMs,
        'normalize_conversation',
        () =>
          normalizeConversationWithCorpus({
            callerKind: params.callerKind,
            memoryWindow: sources.memory.shortTerm.messageWindow,
            passedMessages: input.truncatedMessages,
            enableVision: options?.enableVision ?? false,
            imageUrls: params.imageUrls,
            imageMessageIds: params.imageMessageIds,
            visualMessageTypes: params.visualMessageTypes,
          }),
      );

      const injectionAssessment = this.injectionDetector.detectMessages(normalizedMessages);
      if (injectionAssessment.detected) {
        void this.securityObserver.record(params.userId, injectionAssessment);
      }

      const resolved = measurePhase(phaseDurationsMs, 'resolve', () =>
        resolveTurnContext({
          params,
          normalizedInput: input,
          sources,
          normalizedMessages,
          conversationCorpusBlocks,
          injectionAssessment,
          nowMs: Date.now(),
        }),
      );
      const composed = measurePhase(phaseDurationsMs, 'compile_prompt', () =>
        this.context.compose(resolved.promptModel),
      );
      const runtime = measurePhase(phaseDurationsMs, 'build_tools', () =>
        this.toolRuntimeBuilder.build({ resolved }),
      );

      const finalPrompt = composed.systemPrompt;
      this.checkFinalPromptBloat(finalPrompt, {
        sessionId: params.sessionId,
        userId: params.userId,
        scenario,
      });
      this.tracer?.emit({
        type: 'turn_preparation',
        userId: params.userId,
        status: 'success',
        totalDurationMs: Date.now() - startedAt,
        phaseDurationsMs,
        prompt: {
          totalChars: finalPrompt.length,
          estimatedTokens: Math.ceil(finalPrompt.length / 4),
          orderHash: composed.orderHash,
          blocks: composed.blockMetrics,
          dynamicBlockIds: composed.dynamicBlockIds,
        },
        tools: {
          available: runtime.availableToolCount,
          active: runtime.activeToolCount,
        },
      });

      return {
        finalPrompt,
        promptBlocks: composed.promptBlocks,
        normalizedMessages,
        conversationCorpusBlocks,
        memoryLoadWarning: sources.memory._warnings?.join('; '),
        tools: runtime.tools,
        corpId: params.corpId,
        userId: params.userId,
        sessionId: params.sessionId,
        botUserId: params.botUserId,
        botImId: params.botImId,
        maxSteps,
        entryStage: resolved.entryStage,
        ledger: runtime.ledger,
        contactName: params.contactName,
        memorySnapshot: resolved.memorySnapshot,
        toolExecutionTimings: runtime.toolExecutionTimings,
      };
    } catch (error) {
      this.tracer?.emit({
        type: 'turn_preparation',
        userId: params.userId,
        status: 'failure',
        totalDurationMs: Date.now() - startedAt,
        phaseDurationsMs,
        error: toErrorMessage(error).slice(0, 300),
      });
      throw error;
    }
  }

  /** finalPrompt 出口膨胀哨兵；发送告警失败不影响主回合。 */
  private checkFinalPromptBloat(
    finalPrompt: string,
    scope: { sessionId: string; userId: string; scenario: string },
  ): void {
    const thresholdChars = 60_000;
    if (finalPrompt.length <= thresholdChars) return;
    this.logger.warn(
      `[prepare] finalPrompt 膨胀: length=${finalPrompt.length} > ${thresholdChars}, sessionId=${scope.sessionId}`,
    );
    void this.alertNotifier
      ?.sendAlert({
        code: 'agent.prompt_bloat',
        severity: AlertLevel.WARNING,
        summary: `finalPrompt 长度 ${finalPrompt.length} 字符，超过 ${thresholdChars} 阈值（正常 p-max ~43K）`,
        source: { subsystem: 'agent', component: 'preparation', action: 'prepare' },
        scope: { sessionId: scope.sessionId, userId: scope.userId, scenario: scope.scenario },
        dedupe: { key: 'agent.prompt_bloat' },
      })
      .catch((error) => {
        this.logger.warn(`[prepare] finalPrompt 膨胀告警发送失败: ${toErrorMessage(error)}`);
      });
  }
}

function measurePhase<T>(durations: Record<string, number>, phase: string, run: () => T): T {
  const startedAt = Date.now();
  try {
    return run();
  } finally {
    durations[phase] = Date.now() - startedAt;
  }
}

async function measureAsyncPhase<T>(
  durations: Record<string, number>,
  phase: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    durations[phase] = Date.now() - startedAt;
  }
}
