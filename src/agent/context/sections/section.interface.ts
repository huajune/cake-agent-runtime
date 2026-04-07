import type { EntityExtractionResult } from '@memory/types/session-facts.types';
import { StrategyConfigRecord } from '@shared-types/strategy-config.types';

/**
 * 提示词组装上下文 — 所有 section 共享
 */
export interface PromptContext {
  /** 场景标识 */
  scenario: string;
  /** 渠道类型 */
  channelType: 'private' | 'group';
  /** 策略配置（from Supabase） */
  strategyConfig: StrategyConfigRecord;
  /** 当前对话阶段标识（从 Redis 读取，默认第一阶段） */
  currentStage?: string;
  /** 已渲染好的记忆块；由 AgentPreparationService 提前格式化后注入。 */
  memoryBlock?: string;
  /** 当前时间文本；由 ContextService 统一生成，避免各 section 各算各的。 */
  currentTimeText?: string;
  /** 会话记忆中的已确认提取结果；供 TurnHintsSection 做冲突比对。 */
  sessionFacts?: EntityExtractionResult | null;
  /** 本轮前置识别得到的高置信结果；由 TurnHintsSection 拆分为普通/待确认线索后渲染。 */
  highConfidenceFacts?: EntityExtractionResult | null;
}

/**
 * 提示词段落接口
 *
 * 每个 section 代表 system prompt 中一个功能段落。
 * build() 返回空串表示跳过该段落。
 */
export interface PromptSection {
  /** 段落名称（用于日志和调试） */
  readonly name: string;
  /** 构建该段落的文本 */
  build(ctx: PromptContext): Promise<string> | string;
}
