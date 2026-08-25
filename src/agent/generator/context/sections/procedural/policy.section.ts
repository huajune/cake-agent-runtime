// 知识归类：procedural —— 本段聚合策略红线与业务阈值行为指令。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性政策聚合总账）
import { RedLinesSection } from './red-lines.section';
import { ThresholdsSection } from './thresholds.section';
import {
  buildPromptSectionBlocks,
  PromptContext,
  PromptSection,
  renderPromptBlocks,
} from '../section.interface';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';

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
    return renderPromptBlocks(await this.buildBlocks(ctx));
  }

  async buildBlocks(ctx: PromptContext): Promise<PromptCorpusBlock[]> {
    const blocks: PromptCorpusBlock[] = [];
    for (const section of [this.redLinesSection, this.thresholdsSection]) {
      blocks.push(...(await buildPromptSectionBlocks(section, ctx)));
    }
    return blocks;
  }
}
