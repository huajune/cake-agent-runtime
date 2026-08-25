import { ChannelSection } from '../procedural/channel.section';
import { DateTimeSection } from './datetime.section';
import { HardConstraintsSection } from '../procedural/hard-constraints.section';
import { MemorySection } from '../episodic/memory.section';
import { StageStrategySection } from '../procedural/stage-strategy.section';
import { TurnHintsSection } from './turn-hints.section';
import {
  buildPromptSectionBlocks,
  PromptContext,
  PromptSection,
  renderPromptBlocks,
} from '../procedural/section.interface';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';

/**
 * 运行时上下文段落
 * 知识类型：working 主导（本轮聚合），混合编排 procedural/episodic 输入。
 *
 * 聚合本轮会变化的上下文：阶段策略、跨轮记忆、本轮线索、查询硬约束、时间、通道规范。
 * 顺序约定：memory → turn-hints → hard-constraints，让 LLM 先看到已确认的跨轮信息，
 * 再看到本轮新增线索，最后是必须体现到工具 filter 的硬约束清单。
 */
export class RuntimeContextSection implements PromptSection {
  readonly name = 'runtime-context';

  constructor(
    private readonly stageStrategySection: PromptSection = new StageStrategySection(),
    private readonly memorySection: PromptSection = new MemorySection(),
    private readonly turnHintsSection: PromptSection = new TurnHintsSection(),
    private readonly hardConstraintsSection: PromptSection = new HardConstraintsSection(),
    private readonly dateTimeSection: PromptSection = new DateTimeSection(),
    private readonly channelSection: PromptSection = new ChannelSection(),
  ) {}

  async build(ctx: PromptContext): Promise<string> {
    return renderPromptBlocks(await this.buildBlocks(ctx));
  }

  async buildBlocks(ctx: PromptContext): Promise<PromptCorpusBlock[]> {
    const blocks: PromptCorpusBlock[] = [];
    for (const section of [
      this.stageStrategySection,
      this.memorySection,
      this.turnHintsSection,
      this.hardConstraintsSection,
      this.dateTimeSection,
      this.channelSection,
    ]) {
      blocks.push(...(await buildPromptSectionBlocks(section, ctx)));
    }
    return blocks;
  }
}
