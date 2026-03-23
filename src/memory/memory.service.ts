import { Injectable, Logger } from '@nestjs/common';
import { ShortTermService } from './short-term.service';
import { SessionFactsService } from './session-facts.service';
import { ProceduralService } from './procedural.service';
import { LongTermService } from './long-term.service';
import type { AgentMemoryContext } from './memory.types';

/**
 * 分层记忆服务 — 对外统一 API
 *
 * - recallAll(corpId, userId, sessionId) → AgentMemoryContext（一次性读取所有记忆）
 *
 * 子服务可通过 readonly 属性直接访问：
 * - shortTerm / sessionFacts / procedural / longTerm
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    readonly shortTerm: ShortTermService,
    readonly sessionFacts: SessionFactsService,
    readonly procedural: ProceduralService,
    readonly longTerm: LongTermService,
  ) {}

  /**
   * 一次性读取完整记忆上下文（Agent 每轮请求前调用）
   *
   * 并行读取 shortTerm + sessionFacts + procedural + profile。
   * sessionId 在 wecom 渠道中等同于 chatId。
   */
  async recallAll(corpId: string, userId: string, sessionId: string): Promise<AgentMemoryContext> {
    const [shortTermMessages, sessionState, proceduralState, profile] = await Promise.all([
      this.shortTerm.getMessages(sessionId),
      this.sessionFacts.getSessionState(corpId, userId, sessionId),
      this.procedural.get(corpId, userId, sessionId),
      this.longTerm.getProfile(corpId, userId),
    ]);

    return {
      shortTerm: shortTermMessages,
      longTerm: { profile },
      procedural: proceduralState,
      sessionFacts: sessionState.facts ? sessionState : null,
    };
  }
}
