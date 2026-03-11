import { Injectable, Logger } from '@nestjs/common';
import { StrategyConfigService as BizStrategyConfigService } from '@biz/strategy';
import {
  StrategyConfigRecord,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
  StageGoalConfig,
} from './strategy-config.types';

/**
 * 策略配置 Service（Agent 层）
 *
 * 职责：
 * - 通过 SupabaseStrategyConfigService 获取策略配置（含缓存）
 * - 将结构化数据组装为系统提示词文本
 * - 提供阶段目标供工具上下文使用
 */
@Injectable()
export class StrategyConfigService {
  private readonly logger = new Logger(StrategyConfigService.name);

  constructor(private readonly agentConfigService: BizStrategyConfigService) {}

  // ==================== 配置读写 ====================

  /**
   * 获取当前激活的完整策略配置
   */
  async getActiveConfig(): Promise<StrategyConfigRecord> {
    return this.agentConfigService.getActiveConfig();
  }

  /**
   * 更新人格配置
   */
  async updatePersona(persona: StrategyPersona): Promise<StrategyConfigRecord> {
    return this.agentConfigService.updatePersona(persona);
  }

  /**
   * 更新阶段目标
   */
  async updateStageGoals(stageGoals: StrategyStageGoals): Promise<StrategyConfigRecord> {
    return this.agentConfigService.updateStageGoals(stageGoals);
  }

  /**
   * 更新红线规则
   */
  async updateRedLines(redLines: StrategyRedLines): Promise<StrategyConfigRecord> {
    return this.agentConfigService.updateRedLines(redLines);
  }

  // ==================== Prompt 组装 ====================

  /**
   * 从人格结构化数据生成提示词文本
   */
  async getPersonaPromptText(): Promise<string> {
    const config = await this.agentConfigService.getActiveConfig();
    return this.buildPersonaText(config.persona);
  }

  /**
   * 从红线规则生成提示词文本
   */
  async getRedLinesPromptText(): Promise<string> {
    const config = await this.agentConfigService.getActiveConfig();
    return this.buildRedLinesText(config.red_lines);
  }

  /**
   * 组装最终系统提示词：persona + basePrompt + redLines
   */
  async composeSystemPrompt(basePrompt: string): Promise<string> {
    const config = await this.agentConfigService.getActiveConfig();

    const personaText = this.buildPersonaText(config.persona);
    const redLinesText = this.buildRedLinesText(config.red_lines);

    const parts: string[] = [];

    if (personaText) {
      parts.push(personaText);
    }

    if (basePrompt) {
      parts.push(basePrompt);
    }

    if (redLinesText) {
      parts.push(redLinesText);
    }

    return parts.join('\n\n');
  }

  /**
   * 获取阶段目标供工具上下文使用
   * 返回以 stage 为 key 的映射
   */
  async getStageGoalsForToolContext(): Promise<Record<string, StageGoalConfig>> {
    const config = await this.agentConfigService.getActiveConfig();
    return this.buildStageGoalsMap(config);
  }

  /**
   * 一次查询同时返回组装后的 systemPrompt 和 stageGoals
   * 避免 prepareRequestParams 中两次串行 getActiveConfig()
   */
  async composeSystemPromptAndStageGoals(basePrompt: string): Promise<{
    systemPrompt: string;
    stageGoals: Record<string, StageGoalConfig>;
  }> {
    const config = await this.agentConfigService.getActiveConfig();

    const personaText = this.buildPersonaText(config.persona);
    const redLinesText = this.buildRedLinesText(config.red_lines);

    const parts: string[] = [];
    if (personaText) parts.push(personaText);
    if (basePrompt) parts.push(basePrompt);
    if (redLinesText) parts.push(redLinesText);

    return {
      systemPrompt: parts.join('\n\n'),
      stageGoals: this.buildStageGoalsMap(config),
    };
  }

  // ==================== 私有方法 ====================

  private buildStageGoalsMap(config: StrategyConfigRecord): Record<string, StageGoalConfig> {
    const result: Record<string, StageGoalConfig> = {};
    for (const stage of config.stage_goals.stages) {
      result[stage.stage] = stage;
    }
    return result;
  }

  /**
   * 构建人格提示词文本
   *
   * 从 textDimensions 组装沟通风格提示词
   */
  private buildPersonaText(persona: StrategyPersona): string {
    const dims = (persona.textDimensions || []).filter((d) => d.group === 'style' && d.value);
    if (dims.length === 0) return '';

    const sections: string[] = ['# 人格设定'];

    for (const dim of dims) {
      sections.push(`## ${dim.label}\n${dim.value}`);
    }

    return sections.join('\n\n');
  }

  /**
   * 构建红线规则提示词文本
   */
  private buildRedLinesText(redLines: StrategyRedLines): string {
    if (!redLines?.rules || redLines.rules.length === 0) {
      return '';
    }

    const rulesText = redLines.rules.map((rule) => `- ${rule}`).join('\n');
    return `# 红线规则（以下行为绝对禁止）\n${rulesText}`;
  }
}
