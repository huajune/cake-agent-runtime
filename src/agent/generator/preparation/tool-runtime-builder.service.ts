import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ToolSet } from 'ai';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import type { TurnLedger } from '@shared-types/turn.types';
import type { ResolvedTurnContext } from './turn-context-resolver';
import { createTurnLedger } from './turn-ledger';
import { buildToolContext } from './tool-context.builder';
import { resolveToolsForMode, wrapToolsWithTiming } from './tool-set.util';

export interface ToolRuntime {
  tools: ToolSet;
  ledger: TurnLedger;
  toolExecutionTimings: Map<string, number>;
  availableToolCount: number;
  activeToolCount: number;
}

/** 创建单轮可变运行时；只消费已加载、已裁决的数据，不执行新的外部读取。 */
@Injectable()
export class ToolRuntimeBuilderService {
  private readonly logger = new Logger(ToolRuntimeBuilderService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  build(input: { resolved: ResolvedTurnContext }): ToolRuntime {
    const { resolved } = input;
    const ledger = createTurnLedger(resolved.ledgerSeed);
    if (resolved.initialGeoResolution) {
      const anchor = resolved.initialGeoResolution;
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

    const toolContext = buildToolContext(resolved.toolModel, ledger);
    const toolExecutionTimings = new Map<string, number>();
    const { scenario, mode, allowedToolNames } = resolved.toolModel.selection;
    const scenarioTools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const selectedTools = resolveToolsForMode(scenarioTools, mode, allowedToolNames);
    const tools = wrapToolsWithTiming(selectedTools, toolExecutionTimings, this.tracer);
    return {
      tools,
      ledger,
      toolExecutionTimings,
      availableToolCount: Object.keys(scenarioTools).length,
      activeToolCount: Object.keys(selectedTools).length,
    };
  }
}
