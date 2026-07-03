import { PromptSection, PromptContext } from './section.interface';

/**
 * 兼职群资源段落
 *
 * 预渲染由 ContextService 完成，本 section 只负责把已格式化的块插入 systemPrompt。
 * 目的是让 Agent 在调用 invite_to_group 前具备该城市可用群的"上帝视角"，
 * 避免漏传 industry 导致选到不匹配行业的群。
 */
export class GroupInventorySection implements PromptSection {
  readonly name = 'group-inventory';

  build(ctx: PromptContext): string {
    return ctx.groupInventoryBlock?.trim() ?? '';
  }
}
