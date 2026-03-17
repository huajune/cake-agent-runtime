import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { ScenarioType } from '@enums/agent.enum';
import { StrategyConfigService as BizStrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import {
  StrategyConfigRecord,
  StrategyPersona,
  StrategyRedLines,
  StageGoalConfig,
} from '@shared-types/strategy-config.types';

/**
 * 系统提示词服务
 *
 * 职责：
 * 1. 从 .md 文件加载基础提示词
 * 2. 从 Supabase 获取策略配置（persona / redLines / stageGoals）
 * 3. 组装最终 systemPrompt = persona + basePrompt + redLines
 * 4. 提供 stageGoals 供工具上下文使用
 */
@Injectable()
export class SystemPromptService implements OnModuleInit {
  private readonly logger = new Logger(SystemPromptService.name);
  /** scenario → 基础 prompt 文本（从 .md 文件加载） */
  private readonly basePrompts = new Map<string, string>();
  private readonly profilesBasePath: string;

  constructor(private readonly strategyConfigService: BizStrategyConfigService) {
    const devPath = join(__dirname, 'profiles');
    const prodPath = join(__dirname, '..', '..', 'agent', 'profiles');
    this.profilesBasePath = existsSync(devPath) ? devPath : prodPath;
  }

  async onModuleInit() {
    await this.loadBasePrompts();
  }

  // ==================== Prompt 组装 ====================

  /**
   * 一次调用返回组装后的 systemPrompt + stageGoals
   * orchestrator 主入口
   */
  async compose(scenario: string): Promise<{
    systemPrompt: string;
    stageGoals: Record<string, StageGoalConfig>;
  }> {
    const basePrompt = this.basePrompts.get(scenario) ?? '';

    const config = await this.strategyConfigService.getActiveConfig();

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

  /**
   * 获取已加载的场景列表（调试用）
   */
  getLoadedScenarios(): string[] {
    return Array.from(this.basePrompts.keys());
  }

  // ==================== 私有方法 ====================

  private async loadBasePrompts(): Promise<void> {
    try {
      const promptFile = join(
        this.profilesBasePath,
        'candidate-consultation',
        'system-prompt-v2.md',
      );
      const content = await this.readTextFile(promptFile);
      if (content) {
        this.basePrompts.set(ScenarioType.CANDIDATE_CONSULTATION, content);
      }
      this.logger.log(`基础提示词加载完成，共 ${this.basePrompts.size} 个场景`);
    } catch (error) {
      this.logger.error('基础提示词加载失败', error);
    }
  }

  private buildStageGoalsMap(config: StrategyConfigRecord): Record<string, StageGoalConfig> {
    const result: Record<string, StageGoalConfig> = {};
    for (const stage of config.stage_goals.stages) {
      result[stage.stage] = stage;
    }
    return result;
  }

  private buildPersonaText(persona: StrategyPersona): string {
    const dims = (persona.textDimensions || []).filter((d) => d.group === 'style' && d.value);
    if (dims.length === 0) return '';

    const sections: string[] = ['# 人格设定'];
    for (const dim of dims) {
      sections.push(`## ${dim.label}\n${dim.value}`);
    }
    return sections.join('\n\n');
  }

  private buildRedLinesText(redLines: StrategyRedLines): string {
    if (!redLines?.rules || redLines.rules.length === 0) return '';
    const rulesText = redLines.rules.map((rule) => `- ${rule}`).join('\n');
    return `# 红线规则（以下行为绝对禁止）\n${rulesText}`;
  }

  private async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      if (!existsSync(filePath)) {
        this.logger.warn(`文件不存在: ${filePath}`);
        return undefined;
      }
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      this.logger.error(`读取文本文件失败: ${filePath}`, error);
      return undefined;
    }
  }
}
