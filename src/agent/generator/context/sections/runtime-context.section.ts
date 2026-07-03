import { ChannelSection } from './channel.section';
import { DateTimeSection } from './datetime.section';
import { HardConstraintsSection } from './hard-constraints.section';
import { MemorySection } from './memory.section';
import { StageStrategySection } from './stage-strategy.section';
import { TurnHintsSection } from './turn-hints.section';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 运行时上下文段落
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
    const parts: string[] = [];

    for (const section of [
      this.stageStrategySection,
      this.memorySection,
      this.turnHintsSection,
      this.hardConstraintsSection,
      this.dateTimeSection,
      this.channelSection,
    ]) {
      const text = await section.build(ctx);
      if (text.trim()) parts.push(text.trim());
    }

    return parts.join('\n\n');
  }
}
