import { ChannelSection } from './channel.section';
import { DateTimeSection } from './datetime.section';
import { MemorySection } from './memory.section';
import { StageStrategySection } from './stage-strategy.section';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 运行时上下文段落
 *
 * 聚合本轮会变化的上下文：阶段策略、记忆、时间、通道规范。
 */
export class RuntimeContextSection implements PromptSection {
  readonly name = 'runtime-context';

  constructor(
    private readonly stageStrategySection: PromptSection = new StageStrategySection(),
    private readonly memorySection: PromptSection = new MemorySection(),
    private readonly dateTimeSection: PromptSection = new DateTimeSection(),
    private readonly channelSection: PromptSection = new ChannelSection(),
  ) {}

  async build(ctx: PromptContext): Promise<string> {
    const parts: string[] = [];

    for (const section of [
      this.stageStrategySection,
      this.memorySection,
      this.dateTimeSection,
      this.channelSection,
    ]) {
      const text = await section.build(ctx);
      if (text.trim()) parts.push(text.trim());
    }

    return parts.join('\n\n');
  }
}
