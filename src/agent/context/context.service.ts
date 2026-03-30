/**
 * Context 服务 — 系统提示词组装
 *
 * 职责：按场景组合 PromptSection，输出最终 systemPrompt 字符串。
 * 调用方（channels、biz）通过 compose() 获取 prompt，再传给 AgentRunnerService / CompletionService。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { StrategyConfigService as BizStrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import {
  StrategyConfigRecord,
  StageGoalConfig,
  Threshold,
} from '@shared-types/strategy-config.types';
import { PromptSection, PromptContext } from './sections/section.interface';
import { IdentitySection } from './sections/identity.section';
import { RedLinesSection } from './sections/red-lines.section';
import { DateTimeSection } from './sections/datetime.section';
import { ChannelSection } from './sections/channel.section';
import { StageStrategySection } from './sections/stage-strategy.section';
import { ThresholdsSection } from './sections/thresholds.section';
import { SCENARIO_SECTIONS, DEFAULT_SCENARIO } from './scenarios/scenario.registry';

export interface ComposeParams {
  scenario?: string;
  channelType?: 'private' | 'group';
  currentStage?: string;
  /** 策略来源：wecom 读 released，test 读 testing，默认 released */
  strategySource?: 'released' | 'testing';
}

export interface ComposeResult {
  systemPrompt: string;
  stageGoals: Record<string, StageGoalConfig>;
  thresholds: Threshold[];
}

@Injectable()
export class ContextService implements OnModuleInit {
  private readonly logger = new Logger(ContextService.name);
  private readonly sections = new Map<string, PromptSection>();
  private readonly basePrompts = new Map<string, string>();
  private readonly promptsBasePath: string;

  constructor(private readonly strategyConfigService: BizStrategyConfigService) {
    const devPath = join(__dirname, 'prompts');
    const prodPath = join(__dirname, '..', '..', 'agent', 'context', 'prompts');
    this.promptsBasePath = existsSync(devPath) ? devPath : prodPath;
  }

  async onModuleInit() {
    await this.loadBasePrompts();
    this.registerSections();
    this.logger.log(
      `Context 初始化完成: ${this.sections.size} sections, ${this.basePrompts.size} prompts`,
    );
  }

  /**
   * 组装系统提示词 + stageGoals
   */
  async compose(params: ComposeParams = {}): Promise<ComposeResult> {
    const {
      scenario = DEFAULT_SCENARIO,
      channelType = 'private',
      currentStage,
      strategySource = 'released',
    } = params;

    const config = await this.strategyConfigService.getActiveConfig(strategySource);

    const ctx: PromptContext = {
      scenario,
      channelType,
      strategyConfig: config,
      currentStage,
    };

    const sectionNames = SCENARIO_SECTIONS[scenario];
    if (!sectionNames) {
      this.logger.warn(`未知场景: ${scenario}，使用默认场景`);
      return this.compose({ ...params, scenario: DEFAULT_SCENARIO });
    }

    const parts: string[] = [];
    for (const name of sectionNames) {
      const section = this.sections.get(name);
      if (!section) continue;
      const text = await section.build(ctx);
      if (text.trim()) parts.push(text.trim());
    }

    // 替换 {{CURRENT_TIME}} 占位符
    const now = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
    const systemPrompt = parts.join('\n\n').replace(/\{\{CURRENT_TIME\}\}/g, now);

    return {
      systemPrompt,
      stageGoals: this.buildStageGoalsMap(config),
      thresholds: config.red_lines.thresholds ?? [],
    };
  }

  /**
   * 获取已加载的场景列表（调试用）
   */
  getLoadedScenarios(): string[] {
    return Object.keys(SCENARIO_SECTIONS);
  }

  // ==================== 私有方法 ====================

  private registerSections(): void {
    // identity section 需要基础提示词，按场景创建不同实例
    // 目前只注册 candidate-consultation 的 identity
    const basePrompt = this.basePrompts.get('candidate-consultation') ?? '';
    this.sections.set('identity', new IdentitySection(basePrompt));
    this.sections.set('red-lines', new RedLinesSection());
    this.sections.set('thresholds', new ThresholdsSection());
    this.sections.set('stage-strategy', new StageStrategySection());
    this.sections.set('datetime', new DateTimeSection());
    this.sections.set('channel', new ChannelSection());
  }

  private async loadBasePrompts(): Promise<void> {
    const scenarios = ['candidate-consultation'];
    for (const scenario of scenarios) {
      const filePath = join(this.promptsBasePath, `${scenario}.md`);
      const content = await this.readTextFile(filePath);
      if (content) {
        this.basePrompts.set(scenario, content);
      }
    }
    this.logger.log(`基础提示词加载完成，共 ${this.basePrompts.size} 个场景`);
  }

  private buildStageGoalsMap(config: StrategyConfigRecord): Record<string, StageGoalConfig> {
    const result: Record<string, StageGoalConfig> = {};
    for (const stage of config.stage_goals.stages) {
      result[stage.stage] = stage;
    }
    return result;
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
