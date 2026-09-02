import type { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import type { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import type { PromptInjectionCategory } from '@agent/guardrail/input/prompt-injection-detector';
import type { TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import type { EntityExtractionResult, Preferences } from '@memory/short-term/short-term.types';
import type { MemoryPromptView } from './sections/semantic/memory.section';
import type { GroupInventoryPromptView } from './sections/working/group-inventory.section';

/** Prompt 编译阶段的粗粒度位置；数字权重只存在于 compiler，不散落在调用方。 */
export type PromptSlot =
  | 'stable-instructions'
  | 'strategy'
  | 'evidence'
  | 'working-context'
  | 'final-recitation'
  | 'input-security'
  | 'critical-guard';

/** 托管账号对模型可见的身份视图。 */
export interface AccountIdentityPromptView {
  botUserId?: string;
  nickname?: string;
  gender?: string;
}

/** 策略配置经过 Resolver 投影后的 Prompt 视图；Section 不再接触数据库实体。 */
export interface StrategyPromptView {
  roleSetting: StrategyConfigRecord['role_setting'];
  persona: StrategyConfigRecord['persona'];
  redLines: StrategyConfigRecord['red_lines'];
  thresholds: Threshold[];
  stages: StageGoalConfig[];
  currentStage: StageGoalConfig | null;
}

/** TurnHints 已完成冲突裁决与分流后的渲染视图。 */
export interface TurnHintsPromptView {
  current: TurnHints | null;
  pendingConfirmation: TurnHints | null;
  currentTurnTexts: readonly string[];
}

/** 会话事实与本轮线索完成权威合并后的查询约束视图。 */
export interface HardConstraintsPromptView {
  facts: {
    interview: EntityExtractionResult['interview_info'];
    preferences: Preferences;
  } | null;
  brandState: SessionBrandState | null;
}

/** Prompt Injection 的模型视图；不携带完整用户输入。 */
export interface PromptSecurityView {
  injectionWarning?: {
    ruleId: string;
    category: PromptInjectionCategory;
    instruction: string;
  };
}

/**
 * Resolver 交给 Prompt Compiler 的唯一输入。
 *
 * 这里没有 Redis/Supabase/海绵实体、原始消息或“待裁决的两份事实”；所有字段都已投影成
 * 本轮唯一视图，Section 只负责同步渲染。
 */
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
