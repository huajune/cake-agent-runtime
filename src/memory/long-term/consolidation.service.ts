import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MemoryConfig } from '../memory.config';
import { LongTermService } from './long-term.service';
import type { SummaryEntry } from './long-term.types';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  type EntityExtractionResult,
  type SessionFacts,
  unwrapSessionFacts,
} from '../short-term/short-term.types';
import type { PersistedBrandState } from '@resolution/brand/brand-resolution.types';

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要生成器。将招募经理与候选人的对话和提取的事实信息压缩为一段简洁的摘要。

要求：
- 一段话概括：候选人找什么工作、意向品牌/城市、是否安排了面试、最终结果
- 保留关键事实（岗位、门店、时间、结果）
- 不超过 100 字
- 使用第三人称`;

const CONSOLIDATION_FETCH_LIMIT = 500;
const CONSOLIDATION_MAX_PAGES = 10;

/** 摘要 LLM 输入的消息条数上限：分页扫描后旧会话段可能远超单页。 */
const SUMMARY_MAX_MESSAGES = 120;

const ARCHIVE_COMPRESS_PROMPT = `你是记忆压缩器。将多条历史求职摘要合并为一段简洁的总结。

要求：
- 合并重复信息，保留关键事实
- 按时间顺序概括
- 不超过 200 字
- 使用第三人称`;

/**
 * 沉淀服务 — delayed job 到点后复核 DB 活跃时间，将闲置会话记忆沉淀到长期记忆
 *
 * ## 设计约束
 *
 * 每回合结束由 ConsolidationSchedulerService 刷新约 3 天的 Bull delayed job；本服务
 * 到点后用 chat_messages 最新时间复核闲置，避免旧任务与新消息竞态。facts key 比
 * 沉淀阈值多 12 小时余量，使本服务在状态过期前完成读取。
 *
 * ## 实现
 *
 * 幂等与边界使用两个持久化数据源：
 * - `agent_long_term_memories.episodic_session_summaries.lastSettledMessageAt`（Supabase 永久）：上次已沉淀到哪条消息
 * - `chat_messages` 表里的真实消息时间戳：用来找会话间隔
 *
 * 1. 查询 chat_messages 最新消息并复核闲置时长；不足阈值时返回剩余 delay
 * 2. 读取 `lastSettledBySession[sessionId]`，边界已覆盖最新消息即幂等跳过
 * 3. 分页读取水位后的当前咨询段，用当前 sessionFacts 作为已校验事实参考生成摘要
 * 4. 写入长期事实与摘要，并由同名 RPC 原子推进会话级沉淀水位
 */
@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    private readonly config: MemoryConfig,
    private readonly longTerm: LongTermService,
    private readonly chatSession: ChatSessionService,
    private readonly llm: LlmExecutorService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async settleIdleSession(
    corpId: string,
    userId: string,
    sessionId: string,
    botUserId: string,
    sessionFacts: EntityExtractionResult | SessionFacts | null,
    botImId?: string,
    brandState?: PersistedBrandState | null,
  ): Promise<
    | { status: 'settled' | 'already_settled'; latestMessageAt: number }
    | { status: 'not_idle'; latestMessageAt: number; retryDelayMs: number }
  > {
    const latest = (await this.chatSession.getChatHistory(sessionId, 1)).at(-1);
    if (!latest || !Number.isFinite(latest.timestamp)) {
      throw new Error(`memory_consolidation_latest_message_missing:${sessionId}`);
    }

    const latestMessageAt = latest.timestamp;
    const requiredIdleMs = this.config.consolidationGapSeconds * 1000;
    const idleMs = Date.now() - latestMessageAt;
    if (idleMs < requiredIdleMs) {
      return {
        status: 'not_idle',
        latestMessageAt,
        retryDelayMs: requiredIdleMs - Math.max(0, idleMs),
      };
    }

    const sessionSummaries = await this.longTerm.getSessionSummaries(corpId, userId, botUserId);
    const lastSettledAt =
      sessionSummaries?.lastSettledBySession?.[sessionId] ??
      sessionSummaries?.lastSettledMessageAt ??
      null;
    const lastSettledMs = lastSettledAt ? new Date(lastSettledAt).getTime() : 0;

    if (Number.isFinite(lastSettledMs) && lastSettledMs >= latestMessageAt) {
      return { status: 'already_settled', latestMessageAt };
    }

    const messages = await this.readUnsettledMessages(sessionId, lastSettledMs, latestMessageAt);
    if (messages.length === 0) {
      throw new Error(`memory_consolidation_messages_missing:${sessionId}`);
    }

    // 首次接管存量 chat 时只沉淀最后一个连续咨询段，避免把多段历史合成一个 episode。
    const currentEpisode = lastSettledAt ? messages : this.trimToLatestEpisode(messages);
    const sessionEndAt = new Date(latestMessageAt).toISOString();
    await this.generateAndSaveSummary(corpId, userId, sessionId, {
      facts: sessionFacts,
      botUserId,
      lastSettledMessageAt: lastSettledAt,
      sessionEndAt,
      messages: currentEpisode,
      botImId,
      brandState: brandState ?? null,
    });

    return { status: 'settled', latestMessageAt };
  }

  // ==================== 内部方法 ====================

  private async readUnsettledMessages(
    sessionId: string,
    startTimeExclusive: number,
    endTimeInclusive: number,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>> {
    const scanned: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];
    let cursor = startTimeExclusive;

    for (let page = 0; page < CONSOLIDATION_MAX_PAGES; page++) {
      const batch = await this.chatSession.getChatHistoryInRange(sessionId, {
        startTimeExclusive: cursor,
        endTimeInclusive,
        limit: CONSOLIDATION_FETCH_LIMIT,
      });
      if (batch.length === 0) break;

      const sortedBatch = [...batch].sort((a, b) => a.timestamp - b.timestamp);
      scanned.push(...sortedBatch);
      if (batch.length < CONSOLIDATION_FETCH_LIMIT) break;
      if (page === CONSOLIDATION_MAX_PAGES - 1) {
        throw new Error(`memory_consolidation_scan_limit_exceeded:${sessionId}`);
      }
      cursor = sortedBatch.at(-1)!.timestamp;
    }

    return scanned;
  }

  private trimToLatestEpisode(
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>,
  ): Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> {
    const gapMs = this.config.consolidationGapSeconds * 1000;
    for (let index = messages.length - 1; index > 0; index--) {
      if (messages[index].timestamp - messages[index - 1].timestamp >= gapMs) {
        return messages.slice(index);
      }
    }
    return messages;
  }

  private async generateAndSaveSummary(
    corpId: string,
    userId: string,
    sessionId: string,
    params: {
      facts: EntityExtractionResult | SessionFacts | null;
      botUserId: string;
      brandState?: PersistedBrandState | null;
      lastSettledMessageAt: string | null;
      sessionEndAt: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
      botImId?: string;
    },
  ): Promise<void> {
    const { facts, botUserId, lastSettledMessageAt, sessionEndAt, messages, botImId, brandState } =
      params;

    // 分页扫描后咨询段可能很长，摘要只取末尾一段，避免 LLM prompt 失控。
    const conversationText = messages
      .slice(-SUMMARY_MAX_MESSAGES)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n');

    const factsForSummary = facts ? unwrapSessionFacts(facts) : null;
    const factsText = factsForSummary
      ? `已提取信息：${JSON.stringify(factsForSummary.interview_info)}，偏好：${JSON.stringify(factsForSummary.preferences)}`
      : '无提取信息';

    const result = await this.llm.generate({
      role: ModelRole.Extract,
      modelId: await this.systemConfig.getExtractModelOverride(),
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: `[对话记录]\n${conversationText}\n\n[提取信息]\n${factsText}`,
    });

    const firstMsgTime = messages[0]
      ? new Date(messages[0].timestamp).toISOString()
      : lastSettledMessageAt;

    const summaryEntry: SummaryEntry = {
      summary: result.text || '（摘要生成失败）',
      sessionId,
      ...(botImId ? { originBotId: botImId } : {}),
      startTime: firstMsgTime,
      endTime: sessionEndAt,
    };

    // 长期事实先写、摘要水位后推：若摘要写失败，Bull 重试时事实覆盖写仍幂等。
    if (facts) {
      await this.longTerm.writeFromConsolidation(corpId, userId, botUserId, facts, {
        sessionId,
        botImId,
        brandState: brandState ?? null,
      });
    }

    await this.longTerm.appendSummary(corpId, userId, botUserId, summaryEntry, {
      lastSettledMessageAt: sessionEndAt,
      sessionId,
      compressArchive: (overflow, existingArchive) =>
        this.compressArchive(overflow, existingArchive),
    });

    this.logger.log(
      `[consolidation] 摘要已写入: userId=${userId}, sessionId=${sessionId}, endAt=${sessionEndAt}`,
    );
  }

  private async compressArchive(
    overflow: { summary: string }[],
    existingArchive: string | null,
  ): Promise<string> {
    const parts: string[] = [];
    if (existingArchive) parts.push(`已有总结：${existingArchive}`);
    parts.push(`需要合并的新记录：\n${overflow.map((e) => `- ${e.summary}`).join('\n')}`);

    const result = await this.llm.generate({
      role: ModelRole.Extract,
      modelId: await this.systemConfig.getExtractModelOverride(),
      system: ARCHIVE_COMPRESS_PROMPT,
      prompt: parts.join('\n\n'),
    });

    return result.text || existingArchive || '';
  }
}
