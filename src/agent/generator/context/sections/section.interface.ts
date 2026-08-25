import type { SessionFacts } from '@memory/short-term/session-semantic/facts/facts.types';
import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import type { CorpusDomain, PromptCorpusBlock } from '@shared-types/corpus.types';

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
  /**
   * 会话记忆中的已确认提取结果（**带信封的存储态**）；供 TurnHintsSection 做冲突比对、
   * HardConstraintsSection 做置信度门取值。
   *
   * 只接受 SessionFacts：裸 EntityExtractionResult 在 unwrapSessionFacts 里会在置信度
   * 比较**之前**原样返回，minConfidence 对它完全不生效——历史上联合类型让测试全走裸态
   * 分支，置信度门从未被执行过（core-flow-review 议题 1-1）。生产链路本就只有
   * `memory.sessionMemory?.facts`（SessionFacts）一条来源；测试用
   * `tests/helpers/session-facts.fixture.ts` 的 sessionFactsOf() 构造。
   */
  sessionFacts?: SessionFacts | null;
  /** 本轮前置识别得到的高置信结果；由 TurnHintsSection 拆分为普通/待确认线索后渲染。 */
  ruleFacts?: RuleFactClaims | null;
  /**
   * 本轮候选人消息原文（逐条，与规则轨输入同源）。
   * TurnHintsSection 用它判定 claim 的 quote 是否"就是整条当轮消息"——是且本轮只有一条
   * 消息时省略渲染，避免逐字段把同一条消息重复注入（议题 2-1）。
   */
  currentTurnTexts?: readonly string[];
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
  /** 测试/扩展 section 可显式覆盖；生产 section 统一由下方封闭注册表发牌。 */
  readonly domain?: CorpusDomain;
  /** 构建该段落的文本 */
  build(ctx: PromptContext): Promise<string> | string;
  /** 复合 section 展开子块，避免混合域在 join 后丢失标签。 */
  buildBlocks?(ctx: PromptContext): Promise<PromptCorpusBlock[]> | PromptCorpusBlock[];
}

/** 生产 prompt 叶子 section → 语料域的唯一封闭注册表。 */
const PROMPT_SECTION_DOMAIN_REGISTRY: Readonly<Record<string, CorpusDomain>> = {
  identity: 'teaching',
  'base-manual': 'teaching',
  'final-check': 'teaching',
  'red-lines': 'teaching',
  thresholds: 'teaching',
  'stage-strategy': 'teaching',
  channel: 'teaching',
  memory: 'evidence',
  'turn-hints': 'evidence',
  'hard-constraints': 'evidence',
  datetime: 'tool_result',
  'group-inventory': 'tool_result',
};

/** 展开一个 section；叶子 section 由固定 domain 直接包装。 */
export async function buildPromptSectionBlocks(
  section: PromptSection,
  ctx: PromptContext,
): Promise<PromptCorpusBlock[]> {
  if (section.buildBlocks) return section.buildBlocks(ctx);
  const content = (await section.build(ctx)).trim();
  if (!content) return [];
  const domain = section.domain ?? PROMPT_SECTION_DOMAIN_REGISTRY[section.name];
  if (!domain) throw new Error(`Prompt section 未登记语料域: ${section.name}`);
  return [{ id: section.name, domain, role: 'system', content }];
}

/** Prompt block 的唯一降维点；标签在此之前一直保留。 */
export function renderPromptBlocks(blocks: readonly PromptCorpusBlock[]): string {
  return blocks
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join('\n\n');
}
