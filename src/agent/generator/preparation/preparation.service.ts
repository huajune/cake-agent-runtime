import { Injectable, Logger, Optional } from '@nestjs/common';
import { MemoryConfig } from '@memory/memory.config';
import { AlertLevel } from '@enums/alert.enum';
import { toErrorMessage } from '@infra/utils/error.util';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { PromptInjectionDetector } from '../../guardrail/input/prompt-injection-detector';
import { PromptSecurityObserverService } from '../../guardrail/input/prompt-security-observer.service';
import { ContextService } from '../context/context.service';
import { type GeneratorInvokeParams } from '../generator.types';
import { normalizeConversationWithCorpus } from './conversation-normalizer';
import { normalizeTurnInput } from './turn-input-normalizer';
import { TurnDataLoaderService } from './turn-data-loader.service';
import { resolveTurnContext } from './turn-context-resolver';
import { ToolRuntimeBuilderService } from './tool-runtime-builder.service';
import { renderPromptBlocks } from '../context/sections/section.interface';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';
import type { WorkingMemory } from './preparation.types';

export type { WorkingMemory } from './preparation.types';

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

    const input = normalizeTurnInput(params, this.memoryConfig.sessionWindowMaxChars);
    const sources = await this.dataLoader.load(params, input);
    const { messages: normalizedMessages, corpusBlocks: conversationCorpusBlocks } =
      normalizeConversationWithCorpus({
        callerKind: params.callerKind,
        memoryWindow: sources.memory.shortTerm.messageWindow,
        passedMessages: input.truncatedMessages,
        enableVision: options?.enableVision ?? false,
        imageUrls: params.imageUrls,
        imageMessageIds: params.imageMessageIds,
        visualMessageTypes: params.visualMessageTypes,
      });

    const injectionAssessment = this.injectionDetector.detectMessages(normalizedMessages);
    if (injectionAssessment.detected) {
      void this.securityObserver.record(
        params.userId,
        injectionAssessment,
        input.currentUserMessage ?? '',
      );
    }

    const resolved = resolveTurnContext({
      params,
      normalizedInput: input,
      sources,
      normalizedMessages,
      conversationCorpusBlocks,
      nowMs: Date.now(),
    });
    const composed = this.context.compose({
      ...resolved.composeParams,
      inputSecurityInstruction: injectionAssessment.detected
        ? PromptInjectionDetector.GUARD_INSTRUCTION
        : undefined,
    });
    const runtime = this.toolRuntimeBuilder.build({
      params,
      normalizedInput: input,
      sources,
      resolved,
      normalizedMessages,
      conversationCorpusBlocks,
    });

    // 测试替身/旧调用方可能只返回 systemPrompt；生产 ContextService 始终给出逐块标签。
    const promptBlocks: PromptCorpusBlock[] = composed.promptBlocks?.length
      ? composed.promptBlocks
      : [
          {
            id: 'system-prompt',
            domain: 'teaching',
            role: 'system',
            content: composed.systemPrompt.trim(),
          },
        ];
    const finalPrompt = renderPromptBlocks(promptBlocks);
    this.checkFinalPromptBloat(finalPrompt, {
      sessionId: params.sessionId,
      userId: params.userId,
      scenario,
    });

    return {
      finalPrompt,
      promptBlocks,
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
