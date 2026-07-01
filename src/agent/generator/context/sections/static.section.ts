import { PromptSection, PromptContext } from './section.interface';

/**
 * 静态文本段落
 *
 * 适用于“整段固定提示词文本”这类资产，例如基础手册、最终自检。
 */
export class StaticSection implements PromptSection {
  constructor(
    readonly name: string,
    private readonly content: string,
  ) {}

  build(_ctx: PromptContext): string {
    return this.content.trim();
  }
}
