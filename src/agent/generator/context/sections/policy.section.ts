import { RedLinesSection } from './red-lines.section';
import { ThresholdsSection } from './thresholds.section';
import { PromptContext, PromptSection } from './section.interface';

/**
 * 政策段落 — 聚合动态红线与阈值
 *
 * 让业务硬约束在顶层结构中保持集中，便于模型理解优先级。
 */
export class PolicySection implements PromptSection {
  readonly name = 'policy';

  constructor(
    private readonly redLinesSection: PromptSection = new RedLinesSection(),
    private readonly thresholdsSection: PromptSection = new ThresholdsSection(),
  ) {}

  async build(ctx: PromptContext): Promise<string> {
    const parts: string[] = [];

    for (const section of [this.redLinesSection, this.thresholdsSection]) {
      const text = await section.build(ctx);
      if (text.trim()) parts.push(text.trim());
    }

    return parts.join('\n\n');
  }
}
