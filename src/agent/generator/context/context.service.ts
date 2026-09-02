/**
 * Context 服务 — 系统提示词组装
 *
 * 职责：按场景组合 PromptSection，输出最终 systemPrompt 字符串。
 * 唯一调用方是 PreparationService（generator 域内），compose 产物拼进 finalPrompt。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { type PromptSection } from './sections/section.interface';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';
import { IdentitySection } from './sections/procedural/identity.section';
import { RedLinesSection } from './sections/procedural/red-lines.section';
import { DateTimeSection } from './sections/working/datetime.section';
import { ChannelSection } from './sections/procedural/channel.section';
import {
  StageOverviewSection,
  StageStrategySection,
} from './sections/procedural/stage-strategy.section';
import { ThresholdsSection } from './sections/procedural/thresholds.section';
import { MemorySection } from './sections/semantic/memory.section';
import { TurnHintsSection } from './sections/working/turn-hints.section';
import { HardConstraintsSection } from './sections/working/hard-constraints.section';
import { GroupInventorySection } from './sections/working/group-inventory.section';
import { StaticSection } from './sections/static.section';
import {
  CriticalTurnGuardSection,
  FinalCheckSection,
} from './sections/procedural/final-check.section';
import { InputSecuritySection } from './sections/procedural/input-security.section';
import type { PromptModel } from './prompt-model.types';
import {
  compilePromptProgram,
  DEFAULT_SCENARIO,
  SCENARIO_PROMPT_MANIFEST,
  type PromptBlockMetric,
} from './prompt-manifest';

export interface ComposeResult {
  systemPrompt: string;
  /** StruQ scaffold：降为 systemPrompt 前仍保留 teaching/evidence/tool_result 标签。 */
  promptBlocks: PromptCorpusBlock[];
  orderHash: string;
  blockMetrics: PromptBlockMetric[];
  dynamicBlockIds: string[];
}

@Injectable()
export class ContextService implements OnModuleInit {
  private readonly logger = new Logger(ContextService.name);
  private readonly sections = new Map<string, PromptSection>();
  private readonly promptAssets = new Map<string, string>();
  private readonly promptsBasePath: string;

  constructor() {
    const devPath = join(__dirname, 'sections', 'procedural');
    const prodPath = join(__dirname, '..', '..', 'agent', 'context', 'sections', 'procedural');
    this.promptsBasePath = existsSync(devPath) ? devPath : prodPath;
  }

  async onModuleInit() {
    await this.loadPromptAssets();
    this.registerSections();
    this.logger.log(
      `Context 初始化完成: ${this.sections.size} sections, ${this.promptAssets.size} prompts`,
    );
  }

  /**
   * 组装系统提示词 + stageGoals
   */
  compose(model: PromptModel): ComposeResult {
    if (!SCENARIO_PROMPT_MANIFEST[model.scenario]) {
      this.logger.warn(`未知场景: ${model.scenario}，使用默认场景`);
      return this.compose({ ...model, scenario: DEFAULT_SCENARIO });
    }
    const program = compilePromptProgram({ model, sections: this.sections });
    return {
      systemPrompt: program.rendered,
      promptBlocks: program.blocks,
      orderHash: program.orderHash,
      blockMetrics: program.blockMetrics,
      dynamicBlockIds: program.dynamicBlockIds,
    };
  }

  /**
   * 获取已加载的场景列表（调试用）
   */
  getLoadedScenarios(): string[] {
    return Object.keys(SCENARIO_PROMPT_MANIFEST);
  }

  // ==================== 私有方法 ====================

  private registerSections(): void {
    const baseManual = this.promptAssets.get('candidate-consultation') ?? '';

    this.sections.set('identity', new IdentitySection());
    this.sections.set('base-manual', new StaticSection('base-manual', baseManual));
    this.sections.set('final-check', new FinalCheckSection());
    this.sections.set('input-guard', new InputSecuritySection());
    this.sections.set('critical-turn-guard', new CriticalTurnGuardSection());
    this.sections.set('red-lines', new RedLinesSection());
    this.sections.set('thresholds', new ThresholdsSection());
    this.sections.set('stage-overview', new StageOverviewSection());
    this.sections.set('stage-strategy', new StageStrategySection());
    this.sections.set('memory', new MemorySection());
    this.sections.set('turn-hints', new TurnHintsSection());
    this.sections.set('hard-constraints', new HardConstraintsSection());
    this.sections.set('datetime', new DateTimeSection());
    this.sections.set('channel', new ChannelSection());
    this.sections.set('group-inventory', new GroupInventorySection());
  }

  private async loadPromptAssets(): Promise<void> {
    const assetNames = ['candidate-consultation'];
    for (const assetName of assetNames) {
      const filePath = join(this.promptsBasePath, `${assetName}.md`);
      const content = await this.readTextFile(filePath);
      if (content) {
        this.promptAssets.set(assetName, this.stripMaintainerComments(content));
      }
    }
    this.logger.log(`提示词资产加载完成，共 ${this.promptAssets.size} 个文件`);
  }

  /**
   * 剥离 HTML 注释（<!-- ... -->）：badcase 溯源、修订注记等维护者信息只留在
   * 源 md 文件里，不进模型上下文——省 token 且避免内部事故细节被模型回显。
   */
  private stripMaintainerComments(content: string): string {
    return content
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n');
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
