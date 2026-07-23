import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  SessionFacts,
} from '@memory/types/session-facts.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import type { LaborFormIntentDecision } from '@memory/facts/labor-form';

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
  /** 已渲染好的记忆块；由 PreparationService 提前格式化后注入。 */
  memoryBlock?: string;
  /** 当前时间文本；由 ContextService 统一生成，避免各 section 各算各的。 */
  currentTimeText?: string;
  /** 候选人意向城市的兼职群资源块；由 ContextService 预渲染。 */
  groupInventoryBlock?: string;
  /** 会话记忆中的已确认提取结果；供 TurnHintsSection 做冲突比对。 */
  sessionFacts?: EntityExtractionResult | SessionFacts | null;
  /** 本轮前置识别得到的高置信结果；由 TurnHintsSection 拆分为普通/待确认线索后渲染。 */
  highConfidenceFacts?: HighConfidenceFacts | null;
  /** 当前消息对用工形式的 set/clear/ignore 决策；用于区分撤销旧偏好与岗位事实问句。 */
  currentLaborFormIntent?: LaborFormIntentDecision;
  /** 本轮生效的会话品牌状态（currentBrand + excludedBrands，§9）；品牌提示的唯一数据源。 */
  sessionBrandState?: SessionBrandState | null;
  /**
   * 托管账号身份信息。IdentitySection 用它锚定"候选人看到的这个账号就是你本人"，
   * 让模型确知自己的名字/性别，防止把账号主人说成"另一个真人"或另编姓名性别
   * （badcase chat 6a5dedb2ce406a6aeee1ea62：自称"李娜"+"我是女生"，把账号主人
   * "东升"说成"真人招募经理"）。
   */
  accountIdentity?: AccountIdentity;
}

/** 托管账号身份信息（IdentitySection 渲染用）。 */
export interface AccountIdentity {
  /** 渠道回调 botUserId（多为拼音/英文内部标识，如 "ZhuDongSheng"）。 */
  botUserId?: string;
  /** 企微账号对外昵称（候选人看到的名字）；来自 hosting_member_config.wecomNickname。 */
  nickname?: string;
  /** 账号人设性别（"男"/"女"）；来自 hosting_member_config.gender。 */
  gender?: string;
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
