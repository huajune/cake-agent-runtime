// 归位依据：section 基础设施契约，不是模型可见 section，不参与知识分类。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（Prompt section 契约与语料域执法点）
import type { CorpusDomain, PromptCorpusBlock } from '@shared-types/corpus.types';
import type { PromptModel, PromptSlot } from '../prompt-model.types';

/** 同步纯渲染 Section；事实裁决、IO 与 block 排序均不属于这一层。 */
export interface PromptSection {
  readonly id: string;
  readonly domain: CorpusDomain;
  readonly slot: PromptSlot;
  /** true 表示内容随回合变化，供 Prompt 观测列出动态块。 */
  readonly dynamic: boolean;
  /** 空数组表示本轮不生成该 Section。 */
  build(model: PromptModel): PromptCorpusBlock[];
}

/** 单块 Section 的统一构造器；复合 Section 可直接返回多个块。 */
export function buildTextPromptBlock(
  section: Pick<PromptSection, 'id' | 'domain'>,
  content: string,
): PromptCorpusBlock[] {
  const normalized = content.trim();
  if (!normalized) return [];
  return [{ id: section.id, domain: section.domain, role: 'system', content: normalized }];
}

/** 测试/调试用降维；生产唯一降维点仍是 renderPromptBlocks。 */
export function renderPromptSection(section: PromptSection, model: PromptModel): string {
  return renderPromptBlocks(section.build(model));
}

/** Prompt block 的唯一降维点；标签在此之前一直保留。 */
export function renderPromptBlocks(blocks: readonly PromptCorpusBlock[]): string {
  return blocks
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join('\n\n');
}
