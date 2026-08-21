/**
 * Context 服务 — 系统提示词组装
 *
 * 职责：按场景组合 PromptSection，输出最终 systemPrompt 字符串。
 * 唯一调用方是 PreparationService（generator 域内），compose 产物拼进 finalPrompt。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { StrategyConfigService as BizStrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { unwrapSessionFacts, type SessionFacts } from '@memory/session/session-facts.types';
import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import { formatCurrentTime } from '@infra/utils/date.util';
import {
  buildPromptSectionBlocks,
  PromptSection,
  PromptContext,
  AccountIdentity,
  renderPromptBlocks,
} from './sections/section.interface';
import type { PromptCorpusBlock } from '@shared-types/corpus.types';
import { IdentitySection } from './sections/identity.section';
import { RedLinesSection } from './sections/red-lines.section';
import { DateTimeSection } from './sections/datetime.section';
import { ChannelSection } from './sections/channel.section';
import { StageStrategySection } from './sections/stage-strategy.section';
import { ThresholdsSection } from './sections/thresholds.section';
import { MemorySection } from './sections/memory.section';
import { TurnHintsSection } from './sections/turn-hints.section';
import { HardConstraintsSection } from './sections/hard-constraints.section';
import { GroupInventorySection } from './sections/group-inventory.section';
import { SCENARIO_SECTIONS, DEFAULT_SCENARIO } from './scenarios/scenario.registry';
import { StaticSection } from './sections/static.section';
import { PolicySection } from './sections/policy.section';
import { RuntimeContextSection } from './sections/runtime-context.section';

export interface ComposeParams {
  scenario?: string;
  channelType?: 'private' | 'group';
  currentStage?: string;
  memoryBlock?: string;
  /** 会话记忆中的已确认提取结果（带信封的存储态）；供 TurnHintsSection 做冲突比对。 */
  sessionFacts?: SessionFacts | null;
  /** 本轮前置识别得到的高置信结果；由 TurnHintsSection 拆分/渲染。 */
  ruleFacts?: RuleFactClaims | null;
  /** 本轮候选人消息原文（逐条，与规则轨输入同源）；turn-hints 的原话渲染判据。 */
  currentTurnTexts?: readonly string[];
  /** 当前消息对用工形式的确定性 set/clear/ignore 决策。 */
  currentLaborFormIntent?: LaborFormIntentDecision;
  /** 本轮生效的会话品牌状态；turn-hints / hard-constraints 的品牌口径数据源。 */
  sessionBrandState?: SessionBrandState | null;
  /** 托管账号身份（昵称/性别/内部标识）；IdentitySection 账号身份锚定用。 */
  accountIdentity?: AccountIdentity;
  /** 策略来源：wecom 读 released，test 读 testing，默认 released */
  strategySource?: 'released' | 'testing';
}

export interface ComposeResult {
  systemPrompt: string;
  /** StruQ scaffold：降为 systemPrompt 前仍保留 teaching/evidence/tool_result 标签。 */
  promptBlocks: PromptCorpusBlock[];
  stageGoals: Record<string, StageGoalConfig>;
  thresholds: Threshold[];
}

@Injectable()
export class ContextService implements OnModuleInit {
  private readonly logger = new Logger(ContextService.name);
  private readonly sections = new Map<string, PromptSection>();
  private readonly promptAssets = new Map<string, string>();
  private readonly promptsBasePath: string;
  private readonly groupMemberLimit: number;

  constructor(
    private readonly strategyConfigService: BizStrategyConfigService,
    private readonly groupResolver: GroupResolverService,
    private readonly configService: ConfigService,
  ) {
    const devPath = join(__dirname, 'procedural');
    const prodPath = join(__dirname, '..', '..', 'agent', 'context', 'procedural');
    this.promptsBasePath = existsSync(devPath) ? devPath : prodPath;
    this.groupMemberLimit = parseInt(
      this.configService.get<string>('GROUP_MEMBER_LIMIT', '200'),
      10,
    );
  }

  async onModuleInit() {
    await this.loadPromptAssets();
    this.registerSections();
    this.logger.log(
      `Context 初始化完成: ${this.sections.size} sections, ${this.promptAssets.size} prompts`,
    );
  }

  /**
   * 组装系统提示词 + stageGoals
   */
  async compose(params: ComposeParams = {}): Promise<ComposeResult> {
    const {
      scenario = DEFAULT_SCENARIO,
      channelType = 'private',
      currentStage,
      memoryBlock,
      sessionFacts,
      ruleFacts,
      currentTurnTexts,
      currentLaborFormIntent,
      sessionBrandState,
      accountIdentity,
      strategySource = 'released',
    } = params;

    const config = await this.strategyConfigService.getActiveConfig(strategySource);

    const now = formatCurrentTime();

    const groupInventoryBlock = await this.renderGroupInventoryBlock(sessionFacts);

    const ctx: PromptContext = {
      scenario,
      channelType,
      strategyConfig: config,
      currentStage,
      memoryBlock,
      sessionFacts,
      ruleFacts,
      currentTurnTexts,
      currentLaborFormIntent,
      sessionBrandState,
      accountIdentity,
      currentTimeText: now,
      groupInventoryBlock,
    };

    const sectionNames = SCENARIO_SECTIONS[scenario];
    if (!sectionNames) {
      this.logger.warn(`未知场景: ${scenario}，使用默认场景`);
      return this.compose({ ...params, scenario: DEFAULT_SCENARIO });
    }

    const rawBlocks: PromptCorpusBlock[] = [];
    for (const name of sectionNames) {
      const section = this.sections.get(name);
      if (!section) continue;
      rawBlocks.push(...(await buildPromptSectionBlocks(section, ctx)));
    }

    const promptBlocks = rawBlocks.map((block) => ({
      ...block,
      content: block.content.replace(/\{\{CURRENT_TIME\}\}/g, now),
    }));
    const systemPrompt = renderPromptBlocks(promptBlocks);

    return {
      systemPrompt,
      promptBlocks,
      stageGoals: this.buildStageGoalsMap(config),
      thresholds: config.red_lines.thresholds ?? [],
    };
  }

  /**
   * 获取已加载的场景列表（调试用）
   */
  getLoadedScenarios(): string[] {
    return Object.keys(SCENARIO_SECTIONS);
  }

  // ==================== 私有方法 ====================

  private registerSections(): void {
    const baseManual = this.promptAssets.get('candidate-consultation') ?? '';
    const finalCheck = this.promptAssets.get('candidate-consultation-final-check') ?? '';

    // 顶层结构（推荐用于 candidate-consultation）
    this.sections.set('identity', new IdentitySection());
    this.sections.set('base-manual', new StaticSection('base-manual', baseManual));
    this.sections.set('policy', new PolicySection());
    this.sections.set('runtime-context', new RuntimeContextSection());
    this.sections.set('final-check', new StaticSection('final-check', finalCheck));

    // 叶子 section 仍保留，便于其他场景或测试复用
    this.sections.set('red-lines', new RedLinesSection());
    this.sections.set('thresholds', new ThresholdsSection());
    this.sections.set('stage-strategy', new StageStrategySection());
    this.sections.set('memory', new MemorySection());
    this.sections.set('turn-hints', new TurnHintsSection());
    this.sections.set('hard-constraints', new HardConstraintsSection());
    this.sections.set('datetime', new DateTimeSection());
    this.sections.set('channel', new ChannelSection());
    this.sections.set('group-inventory', new GroupInventorySection());
  }

  /**
   * 根据 sessionFacts 中候选人意向城市，预渲染该城市兼职群资源概览。
   *
   * - 目的：让 Agent 在调用 invite_to_group 前对该城市群库有"上帝视角"
   * - 行为：无城市/无群数据/查询失败时返回空串，不影响 prompt 组装
   *
   * 城市取值必须与硬约束段同门（minConfidence='high'，议题 1-2）：本块不只是"参考信息"，
   * 群库为空时会输出「禁止承诺拉群」这类有行为后果的指令，城市取错两个方向都会错。
   * 此前直读 `.value` 绕过置信度门——Redis 旧档归一化出的 confidence='unknown' 城市
   * 会让 prompt 里出现「兼职群资源（南京）… 禁止承诺拉群」而硬约束段根本没有该城市。
   * 放宽的风险由 invite_to_group 自己的 invite-city-gate 兜底。
   */
  private async renderGroupInventoryBlock(sessionFacts?: SessionFacts | null): Promise<string> {
    const city = unwrapSessionFacts(sessionFacts, {
      minConfidence: 'high',
    })?.preferences.city?.value?.trim();
    if (!city) return '';

    let cityGroups: GroupContext[];
    try {
      const allGroups = await this.groupResolver.resolveGroups('兼职群');
      const normalizedTargetCity = normalizeCity(city);
      cityGroups = allGroups.filter((group) => normalizeCity(group.city) === normalizedTargetCity);
    } catch (error) {
      this.logger.warn(`预渲染兼职群资源失败 (city=${city}): ${(error as Error).message}`);
      return '';
    }

    if (cityGroups.length === 0) {
      return [
        `## 兼职群资源（${city}）`,
        '- 该城市暂无可用兼职群',
        '',
        '本城市群库为空：禁止承诺"我先把你拉进群/进我们群/发群邀请/后面群里通知"等拉群相关动作；',
        '本城市本就没有兼职群（区别于群满），属于"推荐无岗且没有兼职群"场景，不要转人工，继续托管即可：礼貌告知暂时没有合适岗位、后续有匹配会主动联系，引导候选人留意后续主动联系，不要调用 request_handoff。',
      ].join('\n');
    }

    const byIndustry = new Map<string, { groupCount: number; availableCount: number }>();
    for (const group of cityGroups) {
      const industry = group.industry ?? '未分类';
      const entry = byIndustry.get(industry) ?? { groupCount: 0, availableCount: 0 };
      entry.groupCount += 1;
      const hasCapacity =
        group.memberCount === undefined || group.memberCount < this.groupMemberLimit;
      if (hasCapacity) entry.availableCount += 1;
      byIndustry.set(industry, entry);
    }

    const lines = Array.from(byIndustry.entries())
      .sort((left, right) => right[1].groupCount - left[1].groupCount)
      .map(([industry, stats]) => {
        const capacity =
          stats.availableCount === stats.groupCount
            ? '均有空位'
            : `可用 ${stats.availableCount}/${stats.groupCount}`;
        return `- ${industry}：${stats.groupCount} 个群（${capacity}）`;
      });

    return [
      `## 兼职群资源（${city}）`,
      ...lines,
      '',
      '调用 invite_to_group 时，若候选人求职意向明确（如餐饮/零售），必须传对应 industry 参数。',
      '否则工具会按"人数最少"兜底，可能选到不匹配行业的群引起候选人疑问。',
    ].join('\n');
  }

  private async loadPromptAssets(): Promise<void> {
    const assetNames = ['candidate-consultation', 'candidate-consultation-final-check'];
    for (const assetName of assetNames) {
      const filePath = join(this.promptsBasePath, `${assetName}.md`);
      const content = await this.readTextFile(filePath);
      if (content) {
        this.promptAssets.set(assetName, this.stripMaintainerComments(content));
      }
    }
    this.logger.log(`提示词资产加载完成，共 ${this.promptAssets.size} 个文件`);
  }

  /**
   * 剥离 HTML 注释（<!-- ... -->）：badcase 溯源、修订注记等维护者信息只留在
   * 源 md 文件里，不进模型上下文——省 token 且避免内部事故细节被模型回显。
   */
  private stripMaintainerComments(content: string): string {
    return content
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  private buildStageGoalsMap(config: StrategyConfigRecord): Record<string, StageGoalConfig> {
    const result: Record<string, StageGoalConfig> = {};
    for (const stage of config.stage_goals.stages) {
      result[stage.stage] = stage;
    }
    return result;
  }

  private async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      if (!existsSync(filePath)) {
        this.logger.warn(`文件不存在: ${filePath}`);
        return undefined;
      }
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      this.logger.error(`读取文本文件失败: ${filePath}`, error);
      return undefined;
    }
  }
}
