// 知识归类：working —— 平台资源数据非候选人事实，按本轮城市选取，属于轮作用域工作台资源。
import { buildTextPromptBlock, type PromptSection } from '../section';
import type { PromptModel } from '../../context.types';

export interface GroupInventoryPromptView {
  city: string;
  industries: Array<{
    industry: string;
    groupCount: number;
    availableCount: number;
  }>;
}

/**
 * 兼职群资源段落
 * 知识类型：working（按本轮城市选出的平台群库数据）。
 *
 * 数据读取与容量聚合由 TurnDataLoader 完成，本 section 只渲染类型化快照。
 * 操作约束统一归 invite_to_group description，本 section 不承载教学文本。
 */
export class GroupInventorySection implements PromptSection {
  readonly id = 'group-inventory';
  readonly domain = 'tool_result' as const;
  readonly slot = 'working-context' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    const view = model.groupInventory;
    if (!view) return [];
    if (view.industries.length === 0) {
      return buildTextPromptBlock(
        this,
        [`## 兼职群资源（${view.city}）`, '- 该城市暂无可用兼职群'].join('\n'),
      );
    }
    const lines = view.industries.map(({ industry, groupCount, availableCount }) => {
      const capacity =
        availableCount === groupCount ? '均有空位' : `可用 ${availableCount}/${groupCount}`;
      return `- ${industry}：${groupCount} 个群（${capacity}）`;
    });
    return buildTextPromptBlock(this, [`## 兼职群资源（${view.city}）`, ...lines].join('\n'));
  }
}
