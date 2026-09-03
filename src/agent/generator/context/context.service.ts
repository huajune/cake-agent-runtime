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
import { createHash } from 'node:crypto';
import { renderPromptBlocks, type PromptSection } from './sections/section';
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
import { StaticSection } from './sections/section';
import {
  CriticalTurnGuardSection,
  FinalCheckSection,
} from './sections/procedural/final-check.section';
import { InputSecuritySection } from './sections/procedural/input-security.section';
import type {
  ComposeResult,
  PromptBlockMetric,
  PromptModel,
  PromptProgram,
  PromptSlot,
} from './context.types';

export const PROMPT_SLOT_ORDER: Readonly<Record<PromptSlot, number>> = {
  'stable-instructions': 10,
  strategy: 20,
  evidence: 30,
  'working-context': 40,
  'final-recitation': 50,
  'input-security': 60,
  'critical-guard': 70,
};

export const SCENARIO_PROMPT_MANIFEST: Readonly<Record<string, readonly string[]>> = {
  'candidate-consultation': [
    'identity',
    'base-manual',
    'channel',
    'stage-overview',
    'red-lines',
    'thresholds',
    'memory',
    'turn-hints',
    'hard-constraints',
    'datetime',
    'group-inventory',
    'stage-strategy',
    'final-check',
    'input-guard',
    'critical-turn-guard',
  ],
  // 非默认场景同样要带输入安全块：检测/告警是场景无关的，只有防护指令按 manifest 发牌，
  // 漏发等于「告警说已加固、模型没收到指令」。顺序与 slot 一致（见 assertManifestSlotOrder）。
  'group-operations': ['identity', 'channel', 'datetime', 'input-guard'],
  evaluation: ['identity', 'input-guard'],
};

export const DEFAULT_SCENARIO = 'candidate-consultation';

/**
 * manifest 顺序必须已经是 slot 顺序，排序只作恒等兜底。
 *
 * 否则「manifest 声明场景包含哪些 Section 且按此渲染」是假的：新 Section 填错 slot
 * 会被静默挪走，正是本次重构要消灭的「块被悄悄移位」那一类问题。
 */
function assertOrderedBySlot(
  ordered: readonly { section: PromptSection; manifestIndex: number }[],
  scenario: string,
): void {
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].manifestIndex < ordered[index - 1].manifestIndex) {
      throw new Error(
        `Prompt manifest 顺序与 slot 顺序冲突（scenario=${scenario}）：` +
          `${ordered[index].section.id}(slot=${ordered[index].section.slot}) 被 slot 排序挪到了 ` +
          `${ordered[index - 1].section.id}(slot=${ordered[index - 1].section.slot}) 之后；请直接调整 manifest 顺序。`,
      );
    }
  }
}

/** 确定性 Prompt 编译器：slot 排序、降维、顺序 hash 与逐块体积统一在这里。 */
export function compilePromptProgram(input: {
  model: PromptModel;
  sections: ReadonlyMap<string, PromptSection>;
  manifest?: Readonly<Record<string, readonly string[]>>;
}): PromptProgram {
  const manifest = input.manifest ?? SCENARIO_PROMPT_MANIFEST;
  const requested = manifest[input.model.scenario] ?? manifest[DEFAULT_SCENARIO];
  if (!requested) throw new Error(`Prompt manifest 缺少默认场景: ${DEFAULT_SCENARIO}`);

  const orderedSections = requested
    .map((id, manifestIndex) => {
      const section = input.sections.get(id);
      if (!section) throw new Error(`Prompt manifest 引用了未注册 section: ${id}`);
      return { section, manifestIndex };
    })
    .sort(
      (left, right) =>
        PROMPT_SLOT_ORDER[left.section.slot] - PROMPT_SLOT_ORDER[right.section.slot] ||
        left.manifestIndex - right.manifestIndex,
    );

  assertOrderedBySlot(orderedSections, input.model.scenario);

  const blockMetrics: PromptBlockMetric[] = [];
  const blocks: PromptCorpusBlock[] = [];
  for (const { section } of orderedSections) {
    for (const block of section.build(input.model)) {
      const normalized = {
        ...block,
        content: block.content.replace(/\{\{CURRENT_TIME\}\}/g, input.model.currentTimeText).trim(),
      };
      if (!normalized.content) continue;
      blocks.push(normalized);
      blockMetrics.push({
        id: normalized.id,
        domain: normalized.domain,
        slot: section.slot,
        chars: normalized.content.length,
        dynamic: section.dynamic,
      });
    }
  }

  const orderSignature = blockMetrics
    .map((block) => `${block.slot}:${block.id}:${block.domain}`)
    .join('|');
  return {
    blocks,
    rendered: renderPromptBlocks(blocks),
    orderHash: createHash('sha256').update(orderSignature).digest('hex'),
    blockMetrics,
    dynamicBlockIds: blockMetrics.filter((block) => block.dynamic).map((block) => block.id),
  };
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
