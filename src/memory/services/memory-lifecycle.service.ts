import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage } from 'ai';
import { SpongeService } from '@sponge/sponge.service';
import { LongTermService } from './long-term.service';
import { MemoryEnrichmentService, type CandidateIdentityHint } from './memory-enrichment.service';
import { ProceduralService } from './procedural.service';
import { SettlementService } from './settlement.service';
import { SessionService } from './session.service';
import { ShortTermService } from './short-term.service';
import { extractHighConfidenceFacts } from '../facts/high-confidence-facts';
import type { AgentMemoryContext } from '../types/memory-runtime.types';
import type { ShortTermMessage } from '../types/short-term.types';
import {
  type EntityExtractionResult,
  type RecommendedJobSummary,
} from '../types/session-facts.types';

export interface MemoryLifecycleTurnContext {
  corpId: string;
  userId: string;
  sessionId: string;
  typedMessages: ModelMessage[];
  /** 本轮工具查到的候选池；回合结束时统一写入会话记忆。 */
  candidatePool?: RecommendedJobSummary[] | null;
}

/**
 * 统一处理回合开始读取、回合结束写回。
 *
 * 这个服务只负责 turn lifecycle：
 * - `onTurnStart` 读取运行时需要的四类记忆
 * - `onTurnEnd` 按固定顺序做收尾
 *
 * 它不直接承担具体的领域判断：
 * - 会话记忆投影交给 SessionService
 * - 长期记忆沉淀交给 SettlementService
 */
@Injectable()
export class MemoryLifecycleService {
  private readonly logger = new Logger(MemoryLifecycleService.name);

  constructor(
    private readonly shortTerm: ShortTermService,
    private readonly procedural: ProceduralService,
    private readonly longTerm: LongTermService,
    private readonly settlement: SettlementService,
    private readonly session: SessionService,
    private readonly sponge: SpongeService,
    private readonly enrichment: MemoryEnrichmentService,
  ) {}

  /**
   * @param currentUserMessage 本轮 user 的最新文本。同时服务于两件事：
   *   - 前置高置信识别（品牌/城市/年龄等规则抽取）
   *   - 短期窗口空兜底（includeShortTerm=true 但 DB/Redis 无数据时兜上）
   */
  async onTurnStart(
    corpId: string,
    userId: string,
    sessionId: string,
    currentUserMessage?: string,
    options?: {
      includeShortTerm?: boolean;
      /**
       * 外部身份定位，用于向外部系统补全快照中缺失的画像字段（如性别）。
       * 提供时触发 MemoryEnrichmentService。
       */
      enrichmentIdentity?: CandidateIdentityHint;
    },
  ): Promise<AgentMemoryContext> {
    const includeShortTerm = options?.includeShortTerm ?? true;

    const [rawShortTermMessages, sessionState, proceduralState, profile] = await Promise.all([
      includeShortTerm ? this.shortTerm.getMessages(sessionId) : Promise.resolve([]),
      this.session.getSessionState(corpId, userId, sessionId),
      this.procedural.get(corpId, userId, sessionId),
      this.longTerm.getProfile(corpId, userId),
    ]);

    const shortTermMessages = this.applyShortTermFallback(
      rawShortTermMessages,
      includeShortTerm ? currentUserMessage : undefined,
      sessionId,
    );

    const highConfidenceFacts = await this.detectHighConfidenceFacts(currentUserMessage);
    const warnings: string[] = [];
    if (includeShortTerm && this.shortTerm.lastLoadError) {
      warnings.push(`shortTerm: ${this.shortTerm.lastLoadError}`);
    }

    const snapshot: AgentMemoryContext = {
      shortTerm: {
        messageWindow: shortTermMessages,
      },
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      sessionMemory: this.hasStructuredSessionMemoryState(sessionState) ? sessionState : null,
      highConfidenceFacts,
      procedural: proceduralState,
      longTerm: { profile },
    };

    if (options?.enrichmentIdentity) {
      return await this.enrichment.enrich(snapshot, options.enrichmentIdentity);
    }

    return snapshot;
  }

  /**
   * 当短期窗口为空时，用调用方提供的 user 消息兜底。
   *
   * 这是 wecom 链路的瞬时故障兜底：当前轮消息刚写入 DB/Redis 但读回为空，
   * 模型至少拿到"这一轮 user 说了什么"而不会因为 messages=[] 直接抛错。
   */
  private applyShortTermFallback(
    messages: ShortTermMessage[],
    fallbackUserMessage: string | undefined,
    sessionId: string,
  ): ShortTermMessage[] {
    if (messages.length > 0) return messages;
    const trimmed = fallbackUserMessage?.trim();
    if (!trimmed) return messages;

    this.logger.warn(
      `短期记忆为空，使用 fallback 消息兜底: sessionId=${sessionId}, len=${trimmed.length}`,
    );
    return [{ role: 'user', content: trimmed }];
  }

  async onTurnEnd(ctx: MemoryLifecycleTurnContext, assistantText?: string): Promise<void> {
    const lastUserMsg = ctx.typedMessages.filter((m) => m.role === 'user').pop();
    if (!lastUserMsg) return;

    const lastUserText = this.extractTextFromContent(lastUserMsg.content);
    const previousState = await this.session
      .getSessionState(ctx.corpId, ctx.userId, ctx.sessionId)
      .catch((err) => {
        this.logger.warn('读取会话状态失败', err);
        return null;
      });

    // 先基于“上一段会话最后活跃时间”判断要不要沉淀旧会话。
    // 这里必须在写入新的 lastSessionActiveAt 之前判断，否则每轮都会把会话重新“刷新”为当前时间。
    if (previousState && this.settlement.shouldSettle(previousState.lastSessionActiveAt)) {
      this.settlement
        .settle(ctx.corpId, ctx.userId, ctx.sessionId, previousState)
        .catch((err) => this.logger.warn('记忆沉淀失败', err));
    }

    // 候选池是本轮工具的临时产物，统一在 turn end 落入会话记忆，
    // 这样 memory 的外部入口仍然保持 onTurnStart / onTurnEnd 两个固定时机。
    if (ctx.candidatePool?.length) {
      await this.session
        .saveLastCandidatePool(ctx.corpId, ctx.userId, ctx.sessionId, ctx.candidatePool)
        .catch((err) => this.logger.warn('候选池写入失败', err));
    }

    // 会话活跃时间是“这段 session 最后一次继续聊的时间”，
    // 它用于判断会话是否已结束，不等于记忆沉淀时间。
    await this.session
      .storeActivity(ctx.corpId, ctx.userId, ctx.sessionId, {
        lastSessionActiveAt: new Date().toISOString(),
      })
      .catch((err) => this.logger.warn('记忆存储失败', err));

    if (assistantText?.trim()) {
      await this.session
        .projectAssistantTurn({
          corpId: ctx.corpId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          userText: lastUserText,
          assistantText,
        })
        .catch((err) => this.logger.warn('岗位记忆投影失败', err));
    }

    const flatMessages = ctx.typedMessages.map((m) => ({
      role: String(m.role),
      content: this.extractTextFromContent(m.content),
    }));
    this.session
      .extractAndSave(ctx.corpId, ctx.userId, ctx.sessionId, flatMessages)
      .catch((err) => this.logger.warn('事实提取失败', err));
  }

  /** 把消息内容扁平化成纯文本。 */
  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
    }
    return '';
  }

  /** 判断会话记忆里是否已有可用的结构化状态。 */
  private hasStructuredSessionMemoryState(state: {
    facts: unknown;
    lastCandidatePool: unknown[] | null;
    presentedJobs: unknown[] | null;
    currentFocusJob: unknown | null;
    lastSessionActiveAt?: string;
  }): boolean {
    return Boolean(
      state.facts ||
        state.lastCandidatePool?.length ||
        state.presentedJobs?.length ||
        state.currentFocusJob ||
        state.lastSessionActiveAt,
    );
  }

  private async detectHighConfidenceFacts(
    currentUserMessage?: string,
  ): Promise<EntityExtractionResult | null> {
    const trimmed = currentUserMessage?.trim();
    if (!trimmed) return null;

    const brandData = await this.sponge.fetchBrandList();
    const highConfidenceFacts = extractHighConfidenceFacts([trimmed], brandData);
    if (!highConfidenceFacts) return null;

    this.logger.debug(`前置高置信识别命中: ${highConfidenceFacts.reasoning}`);
    return highConfidenceFacts;
  }
}
