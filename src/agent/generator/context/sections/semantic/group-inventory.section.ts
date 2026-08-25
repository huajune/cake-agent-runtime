// 知识归类：semantic —— 本段呈现兼职群库的事实数据。
import { PromptSection, PromptContext } from '../section.interface';

/**
 * 兼职群资源段落
 * 知识类型：semantic（兼职群库事实数据），混合承载对应操作约束。
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
