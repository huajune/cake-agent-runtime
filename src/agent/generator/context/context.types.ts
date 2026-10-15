import type { PromptInjectionCategory } from '@agent/guardrail/input/prompt-injection-detector';
import type { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import type { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import type { EntityExtractionResult, Preferences } from '@memory/short-term/short-term.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import type { StudentEligibility } from '@resolution/job';
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

/** 会话已展示/焦点岗位对在校学生的资格结论（取自岗位记忆的结构化社会身份档位）。 */
export interface StudentJobVerdictView {
  jobId: number;
  /** 品牌-门店-岗位，供模型对照 [会话记忆] 定位。 */
  label: string;
  isFocus: boolean;
  eligibility: StudentEligibility;
}

export interface HardConstraintsPromptView {
  facts: {
    interview: EntityExtractionResult['interview_info'];
    preferences: Preferences;
  } | null;
  brandState: SessionBrandState | null;
  /**
   * 合并后 is_student === true 时，会话已展示岗位与当前焦点岗位（按 jobId 去重，焦点在前）的逐岗结论；
   * is_student 为 null/false 或会话没有岗位记忆时为空。零工具轮回答"这家收不收学生"只能依据它。
   */
  studentJobVerdicts?: readonly StudentJobVerdictView[];
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
