import { Injectable, Logger } from '@nestjs/common';
import { ProceduralService } from './services/procedural.service';
import { LongTermService } from './services/long-term.service';
import { SessionService } from './services/session.service';
import {
  MemoryLifecycleService,
  type MemoryTurnStartMessage,
  type MemoryLifecycleTurnContext,
} from './services/memory-lifecycle.service';
import type { AgentMemoryContext } from './types/memory-runtime.types';
import type { MessageMetadata, SummaryData, UserProfile } from './types/long-term.types';
import type { InvitedGroupRecord } from './types/session-facts.types';
import type { ProceduralState } from './types/procedural.types';

/** memory 模块对外 facade，只保留真实外部入口。 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly procedural: ProceduralService,
    private readonly longTerm: LongTermService,
    private readonly session: SessionService,
    private readonly lifecycle: MemoryLifecycleService,
  ) {}

  /** 回合开始时读取运行时记忆。 */
  async onTurnStart(
    corpId: string,
    userId: string,
    sessionId: string,
    currentMessages?: MemoryTurnStartMessage[],
    options?: {
      includeShortTerm?: boolean;
    },
  ): Promise<AgentMemoryContext> {
    return await this.lifecycle.onTurnStart(corpId, userId, sessionId, currentMessages, options);
  }

  /** 回合结束时触发记忆收尾。 */
  async onTurnEnd(ctx: MemoryLifecycleTurnContext, assistantText?: string): Promise<void> {
    await this.lifecycle.onTurnEnd(ctx, assistantText);
  }

  /** 读取历史摘要（recent + archive），供 recall_history 或沉淀逻辑使用。 */
  async getSummaryData(corpId: string, userId: string): Promise<SummaryData | null> {
    return await this.longTerm.getSummaryData(corpId, userId);
  }

  /** 写入长期档案的外部高置信字段（如外部系统补充的性别）。 */
  async saveProfile(
    corpId: string,
    userId: string,
    profile: Partial<UserProfile>,
    metadata?: MessageMetadata,
  ): Promise<void> {
    await this.longTerm.saveProfile(corpId, userId, profile, metadata);
  }

  /** 清理指定用户的长期记忆（profile + summary） */
  async clearLongTermMemory(corpId: string, userId: string): Promise<boolean> {
    return await this.longTerm.clearUserMemory(corpId, userId);
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
    state: ProceduralState,
  ): Promise<void> {
    await this.procedural.set(corpId, userId, sessionId, state);
  }
}
