// 知识归类：working —— 平台资源数据非候选人事实，按本轮城市选取，属于轮作用域工作台资源。
import { PromptSection, PromptContext } from '../section.interface';

/**
 * 兼职群资源段落
 * 知识类型：working（按本轮城市选出的平台群库数据）。
 *
 * 预渲染由 ContextService 完成，本 section 只负责把已格式化的块插入 systemPrompt。
 * 操作约束统一归 invite_to_group description，本 section 不承载教学文本。
 */
export class GroupInventorySection implements PromptSection {
  readonly name = 'group-inventory';

  build(ctx: PromptContext): string {
    return ctx.groupInventoryBlock?.trim() ?? '';
  }
}
