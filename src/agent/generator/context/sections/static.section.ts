// 归位依据：内容无关的静态文本适配器，属于 section 基础设施，不参与知识分类。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性静态手册/自检总账）
import { buildTextPromptBlock, type PromptSection } from './section.interface';
import type { PromptModel, PromptSlot } from '../prompt-model.types';

/**
 * 静态文本段落
 *
 * 适用于“整段固定提示词文本”这类资产，例如基础手册。
 */
export class StaticSection implements PromptSection {
  constructor(
    readonly id: string,
    private readonly content: string,
    readonly slot: PromptSlot = 'stable-instructions',
  ) {}

  readonly domain = 'teaching' as const;
  readonly dynamic = false;

  build(_model: PromptModel) {
    return buildTextPromptBlock(this, this.content);
  }
}
