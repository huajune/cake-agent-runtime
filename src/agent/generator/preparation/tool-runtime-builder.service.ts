import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ModelMessage, ToolSet } from 'ai';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import type { CorpusBlock } from '@shared-types/corpus.types';
import type { TurnLedger } from '@shared-types/turn.types';
import type { GeneratorInvokeParams } from '../generator.types';
import type { NormalizedTurnInput } from './turn-input-normalizer';
import type { ResolvedTurnContext } from './turn-context-resolver';
import type { TurnSourceSnapshot } from './turn-data-loader.service';
import { createTurnLedger } from './turn-ledger';
import { buildToolContext } from './tool-context.builder';
import { resolveToolsForMode, wrapToolsWithTiming } from './tool-set.util';

export interface ToolRuntime {
  tools: ToolSet;
  ledger: TurnLedger;
  toolExecutionTimings: Map<string, number>;
}

/** 创建单轮可变运行时；只消费已加载、已裁决的数据，不执行新的外部读取。 */
@Injectable()
export class ToolRuntimeBuilderService {
  private readonly logger = new Logger(ToolRuntimeBuilderService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  build(input: {
    params: GeneratorInvokeParams;
    normalizedInput: NormalizedTurnInput;
    sources: TurnSourceSnapshot;
    resolved: ResolvedTurnContext;
    normalizedMessages: ModelMessage[];
    conversationCorpusBlocks: CorpusBlock[];
  }): ToolRuntime {
    const { params, normalizedInput, sources, resolved } = input;
    const ledger = createTurnLedger(resolved.ledgerSeed);
    if (sources.geoAnchor) {
      const anchor = sources.geoAnchor;
      ledger.recordGeoResolution({
        longitude: anchor.longitude,
        latitude: anchor.latitude,
        areaLevelQuery: false,
        areaName: null,
        city: anchor.city,
        district: anchor.district,
        evidence: anchor.evidence,
        source: 'location_share',
      });
      this.logger.log(
        `[prepare] 定位分享轮内锚点: city=${anchor.city}（invite 城市门 turn_geocode 档可用）`,
      );
    }

    const toolContext = buildToolContext({
      params,
      memory: sources.memory,
      normalizedMessages: input.normalizedMessages,
      conversationCorpusBlocks: input.conversationCorpusBlocks,
      visualSheetsByContent: sources.visualSheetsByContent,
      entryStage: resolved.entryStage,
      stageGoals: Object.fromEntries(
        sources.strategyConfig.stage_goals.stages.map((stage) => [stage.stage, stage]),
      ),
      thresholds: sources.strategyConfig.red_lines.thresholds ?? [],
      ledger,
      contactBrandAliases: sources.turnBrandContext.nicknameBrands,
      sessionBrandState: sources.turnBrandContext.state,
      currentUserMessage: normalizedInput.currentUserMessage,
      currentLaborFormIntent: normalizedInput.laborFormIntent,
      bookingWorkOrderJobIds: resolved.bookingWorkOrderJobIds,
    });
    const toolExecutionTimings = new Map<string, number>();
    const scenario = params.scenario ?? 'candidate-consultation';
    const scenarioTools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const tools = wrapToolsWithTiming(
      resolveToolsForMode(scenarioTools, params.toolMode ?? 'scenario', params.allowedToolNames),
      toolExecutionTimings,
      this.tracer,
    );
    return { tools, ledger, toolExecutionTimings };
  }
}
