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
