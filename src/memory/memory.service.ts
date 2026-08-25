import { Injectable, Logger } from '@nestjs/common';
import { LongTermService } from './long-term/long-term.service';
import { SessionStateService } from './short-term/session-state.service';
import { SessionWorkbenchService } from './short-term/workbench.service';
import { MemoryLifecycleService, type MemoryLifecycleTurnContext } from './lifecycle.service';
import type { CandidateIdentityHint } from './enrichment.service';
import type { AgentMemoryContext } from './recall.types';
import type { SummaryEntry } from './long-term/long-term.types';
import type { InvitedGroupRecord } from './short-term/short-term.types';
import type { TurnHints } from '@resolution/evidence/claim.types';
import type { StageState } from './short-term/short-term.types';
import { formatExtractionFactLines } from './fact-lines.formatter';

export interface ProactiveMemoryRecall {
  recentMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  factLines: string[];
  warnings?: string[];
}

export type { CandidateIdentityHint } from './enrichment.service';

/** memory 模块对外 facade，只保留真实外部入口。 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly workbench: SessionWorkbenchService,
    private readonly longTerm: LongTermService,
    private readonly session: SessionStateService,
    private readonly lifecycle: MemoryLifecycleService,
  ) {}

  /**
   * 回合开始时读取运行时记忆。
   *
   * @param currentUserMessage 本轮 user 最新文本；用于前置高置信识别 + 短期窗口空兜底
   */
  async onTurnStart(
    corpId: string,
    userId: string,
    sessionId: string,
    currentUserMessage?: string,
    options?: {
      includeShortTerm?: boolean;
      shortTermEndTimeInclusive?: number;
      enrichmentIdentity?: CandidateIdentityHint;
      /** prep 已运行的本轮规则轨；memory 只装配，不重复判定。 */
      turnHints?: TurnHints | null;
      /** 当前托管账号的稳定企微身份（wecomUserId）。 */
      botUserId?: string;
    },
  ): Promise<AgentMemoryContext> {
    return await this.lifecycle.onTurnStart(corpId, userId, sessionId, currentUserMessage, options);
  }

  /** 回合结束时触发记忆收尾。 */
  async onTurnEnd(ctx: MemoryLifecycleTurnContext, assistantText?: string): Promise<void> {
    await this.lifecycle.onTurnEnd(ctx, assistantText);
  }

  /**
   * 主动复聊专用轻量 recall：复用记忆层的短期窗口与结构化事实 formatter。
   *
   * 复聊没有新的候选人输入，不需要完整 generator 上下文；但仍必须从 memory
   * 接缝读取，避免绕开 Redis 短期缓存、事实陈旧标注与统一字段文案。
   */
  async recallForProactiveFollowUp(
    corpId: string,
    userId: string,
    sessionId: string,
    options?: { shortTermEndTimeInclusive?: number; botUserId?: string },
  ): Promise<ProactiveMemoryRecall> {
    const memory = await this.onTurnStart(corpId, userId, sessionId, undefined, {
      includeShortTerm: true,
      shortTermEndTimeInclusive: options?.shortTermEndTimeInclusive,
      botUserId: options?.botUserId,
    });
    // messageWindow 已由 MessageWindowService 按与 Generator 相同的条数、时间和字符预算裁剪，
    // 这里不再二次截断或改写其时间后缀，只丢弃空正文。
    const recentMessages = memory.shortTerm.messageWindow
      .filter(
        (message): message is typeof message & { role: 'user' | 'assistant' } =>
          (message.role === 'user' || message.role === 'assistant') &&
          message.content.trim().length > 0,
      )
      .map((message) => ({ role: message.role, content: message.content }));
    const factLines = memory.shortTerm.sessionState?.facts
      ? formatExtractionFactLines(memory.shortTerm.sessionState.facts, {
          // 品牌唯一真相是 facts.brand（M5）；facts.preferences.brands 已退役
          currentBrandName:
            memory.shortTerm.sessionState.facts.brand?.currentBrand?.canonicalName ?? null,
        })
      : [];
    return {
      recentMessages,
      factLines,
      ...(memory._warnings?.length ? { warnings: memory._warnings } : {}),
    };
  }

  /** 读取历史咨询段摘要（裸 SummaryEntry[]），供 recall_history 按需使用。 */
  async getSessionSummaries(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<SummaryEntry[] | null> {
    return await this.longTerm.getSessionSummaries(corpId, userId, botUserId);
  }

  /** 清理指定用户的长期记忆（profile + summary） */
  async clearLongTermMemory(corpId: string, userId: string, botUserId: string): Promise<boolean> {
    return await this.longTerm.clearUserMemory(corpId, userId, botUserId);
  }

  async getStage(corpId: string, userId: string, sessionId: string): Promise<StageState> {
    return await this.workbench.getStage(corpId, userId, sessionId);
  }

  async clearSessionMemory(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    const [sessionCleared, stageCleared] = await Promise.all([
      this.session.clearSessionState(corpId, userId, sessionId),
      this.workbench.clearStage(corpId, userId, sessionId),
    ]);
    return sessionCleared || stageCleared;
  }

  /** 记录已邀入的兼职群，供 invite_to_group 工具调用。 */
  async saveInvitedGroup(
    corpId: string,
    userId: string,
    sessionId: string,
    record: InvitedGroupRecord,
  ): Promise<void> {
    await this.session.saveInvitedGroup(corpId, userId, sessionId, record);
  }

  /** 写入当前程序阶段，供 advance_stage 等外部模块调用。 */
  async setStage(
    corpId: string,
    userId: string,
    sessionId: string,
    state: StageState,
  ): Promise<void> {
    await this.workbench.setStage(corpId, userId, sessionId, state);
  }
}
