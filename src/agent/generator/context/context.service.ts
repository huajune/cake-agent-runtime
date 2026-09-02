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
import { type SessionFacts } from '@memory/short-term/short-term.types';
import type { TurnHintFieldPath, TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import { formatCurrentTime } from '@infra/utils/date.util';
import {
  buildPromptSectionBlocks,
  PromptSection,
  PromptContext,
  AccountIdentity,
  renderPromptBlocks,
} from './sections/section.interface';
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
import type { GroupInventoryPromptView } from './sections/working/group-inventory.section';
import { SCENARIO_SECTIONS, DEFAULT_SCENARIO } from './scenarios/scenario.registry';
import { StaticSection } from './sections/static.section';
import {
  CriticalTurnGuardSection,
  FinalCheckSection,
} from './sections/procedural/final-check.section';
import { InputSecuritySection } from './sections/procedural/input-security.section';
import type { ModelMessage } from 'ai';
import type { MemoryPromptView } from './sections/semantic/memory.section';

export interface ComposeParams {
  /** Loader 在每轮开始时读取的策略快照；Composer 本身不做外部 IO。 */
  strategyConfig: StrategyConfigRecord;
  scenario?: string;
  channelType?: 'private' | 'group';
  currentStage?: string;
  memory?: MemoryPromptView;
  groupInventory?: GroupInventoryPromptView;
  /** 会话记忆中的已确认提取结果（带信封的存储态）；供 TurnHintsSection 做冲突比对。 */
  sessionFacts?: SessionFacts | null;
  /** 本轮前置识别得到的高置信结果；由 TurnHintsSection 拆分/渲染。 */
  turnHints?: TurnHints | null;
  /** 渲染层裁决后的本轮增量提示；不影响工具/台账消费的原 turnHints。 */
  displayTurnHints?: TurnHints | null;
  /** 与跨层权威 facts 异值、需进入待确认块的字段。 */
  pendingTurnHintFields?: readonly TurnHintFieldPath[];
  /** 本轮候选人消息原文（逐条，与规则轨输入同源）；turn-hints 的原话渲染判据。 */
  currentTurnTexts?: readonly string[];
  /** 本轮合并后的候选人消息；critical-turn-guard current 规则输入。 */
  currentUserMessage?: string;
  /** 含短期近邻窗口的归一化消息；critical-turn-guard combined 规则输入。 */
  normalizedMessages?: readonly ModelMessage[];
  /** Prompt Injection 命中时的模型安全指令；由显式 input-guard section 渲染。 */
  inputSecurityInstruction?: string;
  /** 当前消息对用工形式的确定性 set/clear/ignore 决策。 */
  currentLaborFormIntent?: LaborFormIntentDecision;
  /** 本轮生效的会话品牌状态；turn-hints / hard-constraints 的品牌口径数据源。 */
  sessionBrandState?: SessionBrandState | null;
  /** 托管账号身份（昵称/性别/内部标识）；IdentitySection 账号身份锚定用。 */
  accountIdentity?: AccountIdentity;
}

export interface ComposeResult {
  systemPrompt: string;
  /** StruQ scaffold：降为 systemPrompt 前仍保留 teaching/evidence/tool_result 标签。 */
  promptBlocks: PromptCorpusBlock[];
  stageGoals: Record<string, StageGoalConfig>;
  thresholds: Threshold[];
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
  compose(params: ComposeParams): ComposeResult {
    const {
      strategyConfig: config,
      scenario = DEFAULT_SCENARIO,
      channelType = 'private',
      currentStage,
      memory,
      groupInventory,
      sessionFacts,
      turnHints,
      displayTurnHints,
      pendingTurnHintFields,
      currentTurnTexts,
      currentUserMessage,
      normalizedMessages,
      inputSecurityInstruction,
      currentLaborFormIntent,
      sessionBrandState,
      accountIdentity,
    } = params;

    const now = formatCurrentTime();

    const ctx: PromptContext = {
      scenario,
      channelType,
      strategyConfig: config,
      currentStage,
      memory,
      sessionFacts,
      turnHints,
      displayTurnHints,
      pendingTurnHintFields,
      currentTurnTexts,
      currentUserMessage,
      normalizedMessages,
      inputSecurityInstruction,
      currentLaborFormIntent,
      sessionBrandState,
      accountIdentity,
      currentTimeText: now,
      groupInventory,
    };

    const sectionNames = SCENARIO_SECTIONS[scenario];
    if (!sectionNames) {
      this.logger.warn(`未知场景: ${scenario}，使用默认场景`);
      return this.compose({ ...params, scenario: DEFAULT_SCENARIO });
    }

    const rawBlocks: PromptCorpusBlock[] = [];
    for (const name of sectionNames) {
      const section = this.sections.get(name);
      if (!section) continue;
      rawBlocks.push(...buildPromptSectionBlocks(section, ctx));
    }

    const promptBlocks = rawBlocks.map((block) => ({
      ...block,
      content: block.content.replace(/\{\{CURRENT_TIME\}\}/g, now),
    }));
    const systemPrompt = renderPromptBlocks(promptBlocks);

    return {
      systemPrompt,
      promptBlocks,
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
