import { PromptSection, PromptContext } from './section.interface';

/**
 * 记忆段落
 *
 * 这里不负责读取或格式化记忆，只负责把已经渲染好的记忆块
 * 插入到 systemPrompt 的固定位置，确保整体顺序稳定。
 */
export class MemorySection implements PromptSection {
  readonly name = 'memory';

  build(ctx: PromptContext): string {
    return ctx.memoryBlock?.trim() ?? '';
  }
}
