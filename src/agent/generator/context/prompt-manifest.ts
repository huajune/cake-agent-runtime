import { createHash } from 'node:crypto';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';
import type { PromptModel, PromptSlot } from './prompt-model.types';
import type { PromptSection } from './sections/section.interface';
import { renderPromptBlocks } from './sections/section.interface';

/** Slot 的唯一顺序权威；新增尾部安全块无需调用方再做数组手术。 */
export const PROMPT_SLOT_ORDER: Readonly<Record<PromptSlot, number>> = {
  'stable-instructions': 10,
  strategy: 20,
  evidence: 30,
  'working-context': 40,
  'final-recitation': 50,
  'input-security': 60,
  'critical-guard': 70,
};

/** 场景只声明需要哪些 Section；跨类别顺序由 Section.slot + SLOT_ORDER 决定。 */
export const SCENARIO_PROMPT_MANIFEST: Readonly<Record<string, readonly string[]>> = {
  'candidate-consultation': [
    'identity',
    'base-manual',
    'channel',
    'stage-overview',
    'red-lines',
    'thresholds',
    'memory',
    'turn-hints',
    'hard-constraints',
    'datetime',
    'group-inventory',
    'stage-strategy',
    'final-check',
    'input-guard',
    'critical-turn-guard',
  ],
  'group-operations': ['identity', 'datetime', 'channel'],
  evaluation: ['identity'],
};

export const DEFAULT_SCENARIO = 'candidate-consultation';

export interface PromptBlockMetric {
  id: string;
  domain: PromptCorpusBlock['domain'];
  slot: PromptSlot;
  chars: number;
  dynamic: boolean;
}

export interface PromptProgram {
  blocks: PromptCorpusBlock[];
  rendered: string;
  orderHash: string;
  blockMetrics: PromptBlockMetric[];
  dynamicBlockIds: string[];
}

/** 确定性 Prompt Compiler：按 slot 排序、渲染、计算稳定顺序 hash 与逐块体积。 */
export function compilePromptProgram(input: {
  model: PromptModel;
  sections: ReadonlyMap<string, PromptSection>;
  manifest?: Readonly<Record<string, readonly string[]>>;
}): PromptProgram {
  const manifest = input.manifest ?? SCENARIO_PROMPT_MANIFEST;
  const requested = manifest[input.model.scenario] ?? manifest[DEFAULT_SCENARIO];
  if (!requested) throw new Error(`Prompt manifest 缺少默认场景: ${DEFAULT_SCENARIO}`);

  const orderedSections = requested
    .map((id, manifestIndex) => {
      const section = input.sections.get(id);
      if (!section) throw new Error(`Prompt manifest 引用了未注册 section: ${id}`);
      return { section, manifestIndex };
    })
    .sort(
      (left, right) =>
        PROMPT_SLOT_ORDER[left.section.slot] - PROMPT_SLOT_ORDER[right.section.slot] ||
        left.manifestIndex - right.manifestIndex,
    );

  const blockMetrics: PromptBlockMetric[] = [];
  const blocks: PromptCorpusBlock[] = [];
  for (const { section } of orderedSections) {
    for (const block of section.build(input.model)) {
      const normalized = {
        ...block,
        content: block.content.replace(/\{\{CURRENT_TIME\}\}/g, input.model.currentTimeText).trim(),
      };
      if (!normalized.content) continue;
      blocks.push(normalized);
      blockMetrics.push({
        id: normalized.id,
        domain: normalized.domain,
        slot: section.slot,
        chars: normalized.content.length,
        dynamic: section.dynamic,
      });
    }
  }

  const orderSignature = blockMetrics
    .map((block) => `${block.slot}:${block.id}:${block.domain}`)
    .join('|');
  return {
    blocks,
    rendered: renderPromptBlocks(blocks),
    orderHash: createHash('sha256').update(orderSignature).digest('hex'),
    blockMetrics,
    dynamicBlockIds: blockMetrics.filter((block) => block.dynamic).map((block) => block.id),
  };
}
