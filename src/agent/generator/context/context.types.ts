import type { PromptInjectionCategory } from '@agent/guardrail/input/prompt-injection-detector';
import type { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import type { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import type { EntityExtractionResult, Preferences } from '@memory/short-term/short-term.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import type { TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';
import type { MemoryPromptView } from './sections/semantic/memory.section';
import type { GroupInventoryPromptView } from './sections/working/group-inventory.section';

export type PromptSlot =
  | 'stable-instructions'
  | 'strategy'
  | 'evidence'
  | 'working-context'
  | 'final-recitation'
  | 'input-security'
  | 'critical-guard';

export interface AccountIdentityPromptView {
  botUserId?: string;
  nickname?: string;
  gender?: string;
}

export interface StrategyPromptView {
  roleSetting: StrategyConfigRecord['role_setting'];
  persona: StrategyConfigRecord['persona'];
  redLines: StrategyConfigRecord['red_lines'];
  thresholds: Threshold[];
  stages: StageGoalConfig[];
  currentStage: StageGoalConfig | null;
}

export interface TurnHintsPromptView {
  current: TurnHints | null;
  pendingConfirmation: TurnHints | null;
  currentTurnTexts: readonly string[];
}

export interface HardConstraintsPromptView {
  facts: {
    interview: EntityExtractionResult['interview_info'];
    preferences: Preferences;
  } | null;
  brandState: SessionBrandState | null;
}

export interface PromptSecurityView {
  injectionWarning?: {
    ruleId: string;
    category: PromptInjectionCategory;
    instruction: string;
  };
}

/** Resolver 交给 Prompt 编译器的唯一、已裁决输入。 */
export interface PromptModel {
  scenario: string;
  channelType: 'private' | 'group';
  currentTimeText: string;
  identity: AccountIdentityPromptView;
  strategy: StrategyPromptView;
  memory?: MemoryPromptView;
  groupInventory?: GroupInventoryPromptView;
  turnHints: TurnHintsPromptView;
  hardConstraints?: HardConstraintsPromptView;
  security: PromptSecurityView;
  criticalTurnInstructions: readonly string[];
}

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

export interface ComposeResult {
  systemPrompt: string;
  /** StruQ scaffold：降为 systemPrompt 前仍保留 teaching/evidence/tool_result 标签。 */
  promptBlocks: PromptCorpusBlock[];
  orderHash: string;
  blockMetrics: PromptBlockMetric[];
  dynamicBlockIds: string[];
}
