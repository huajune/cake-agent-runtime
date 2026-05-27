import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MemoryConfig } from '../memory.config';
import { LongTermService } from './long-term.service';
import type { SummaryEntry } from '../types/long-term.types';
import {
  type EntityExtractionResult,
  type SessionFacts,
  unwrapSessionFacts,
} from '../types/session-facts.types';

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要生成器。将招募经理与候选人的对话和提取的事实信息压缩为一段简洁的摘要。

要求：
- 一段话概括：候选人找什么工作、意向品牌/城市、是否安排了面试、最终结果
- 保留关键事实（岗位、门店、时间、结果）
- 不超过 100 字
- 使用第三人称`;

const SETTLEMENT_FETCH_LIMIT = 500;

const ARCHIVE_COMPRESS_PROMPT = `你是记忆压缩器。将多条历史求职摘要合并为一段简洁的总结。

要求：
- 合并重复信息，保留关键事实
- 按时间顺序概括
- 不超过 200 字
- 使用第三人称`;

/**
 * 沉淀服务 — 基于 DB 时间戳的间隔检测，将闲置会话记忆沉淀到长期记忆
 *
 * ## 设计背景
 *
 * 旧实现用 Redis 中的 `lastSessionActiveAt` 判断是否超时，但 Redis key 与沉淀
 * 阈值共用同一个 TTL，导致"能检测到 activeAt 时，距离它写入还不足 sessionTtl；
 * 等到真正超时时，key 已经 expire，永远读不到"——形成死锁，沉淀从未触发过。
 *
 * ## 新实现
 *
 * 不再依赖 Redis 中的活跃时间戳，改用两个持久化数据源：
 * - `agent_long_term_memories.summary_data.lastSettledMessageAt`（Supabase 永久）：上次已沉淀到哪条消息
 * - `chat_messages` 表里的真实消息时间戳：用来找会话间隔
 *
 * 检测逻辑：
 * 1. 读取 `lastSettledMessageAt`（若为 null，无历史可沉淀，跳过）
 * 2. 查询 `lastSettledMessageAt` 之后的所有消息，找最近一段会话的开始时间
 * 3. 若（当前会话第一条消息时间 - 上一段会话最后一条消息时间）>= settlementGapSeconds，
 *    认为上一段会话已闲置结束，对其执行沉淀
 * 4. 用当前 sessionFacts 作为已校验事实参考，生成摘要
 * 5. 写入 `summary_data`，更新 `lastSettledMessageAt`
 * 6. 将 sessionFacts 中的身份字段写入长期 profile_facts
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly config: MemoryConfig,
    private readonly longTerm: LongTermService,
    private readonly chatSession: ChatSessionService,
    private readonly llm: LlmExecutorService,
  ) {}

  /**
   * 检测并执行会话沉淀（DB-timestamp 驱动）。
   *
   * 在每个回合结束后调用。若检测到用户是在一段闲置后重新回来，
   * 就对闲置之前那段会话的消息异步生成摘要并写入长期记忆。
   *
   * @returns true = 触发了沉淀；false = 未达沉淀条件，跳过
   */
  async detectAndSettle(
    corpId: string,
    userId: string,
    sessionId: string,
    sessionFacts: EntityExtractionResult | SessionFacts | null,
  ): Promise<boolean> {
    try {
      const summaryData = await this.longTerm.getSummaryData(corpId, userId);
      const lastSettledAt = summaryData?.lastSettledMessageAt ?? null;

      // 快速跳过：若上次沉淀边界距今 < settlementGapSeconds，不可能存在闭合断层
      if (lastSettledAt) {
        const msSinceLastSettled = Date.now() - new Date(lastSettledAt).getTime();
        if (msSinceLastSettled < this.config.settlementGapSeconds * 1000) {
          return false;
        }
      }

      const effectiveSettledMs = lastSettledAt ? new Date(lastSettledAt).getTime() : 0;

      const messagesSince = await this.chatSession.getChatHistoryInRange(sessionId, {
        startTimeExclusive: effectiveSettledMs,
        limit: SETTLEMENT_FETCH_LIMIT,
      });

      if (messagesSince.length === 0) return false;

      const sorted = [...messagesSince].sort((a, b) => a.timestamp - b.timestamp);

      // 冷启动：首次无沉淀基准时，将边界初始化到最新消息，跳过历史全量沉淀
      if (!lastSettledAt) {
        const latestTs = new Date(sorted.at(-1)!.timestamp).toISOString();
        await this.longTerm.markLastSettledMessageAt(corpId, userId, latestTs);
        this.logger.log(
          `[detectAndSettle] 冷启动初始化边界: userId=${userId}, boundary=${latestTs}`,
        );
        return false;
      }

      const SESSION_GAP_MS = this.config.settlementGapSeconds * 1000;

      let gapBeforeIndex = -1;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
        if (gap >= SESSION_GAP_MS) {
          gapBeforeIndex = i;
          break;
        }
      }

      if (gapBeforeIndex === -1) return false;

      // gapBeforeIndex 之前的消息属于待沉淀的旧会话
      const prevSessionMessages = sorted.slice(0, gapBeforeIndex);
      const prevSessionEndMessage = prevSessionMessages.at(-1);
      if (!prevSessionEndMessage) return false;

      const sessionEndAt = new Date(prevSessionEndMessage.timestamp).toISOString();

      this.logger.log(
        `[detectAndSettle] 检测到会话断层: userId=${userId}, ` +
          `旧会话末尾=${sessionEndAt}, 待沉淀消息 ${prevSessionMessages.length} 条`,
      );

      await this.generateAndSaveSummary(corpId, userId, sessionId, {
        facts: sessionFacts,
        lastSettledMessageAt: lastSettledAt,
        sessionEndAt,
        messages: prevSessionMessages,
      });

      return true;
    } catch (error) {
      this.logger.warn('[detectAndSettle] 沉淀检测失败', error);
      return false;
    }
  }

  // ==================== 内部方法 ====================

  private async generateAndSaveSummary(
    corpId: string,
    userId: string,
    sessionId: string,
    params: {
      facts: EntityExtractionResult | SessionFacts | null;
      lastSettledMessageAt: string | null;
      sessionEndAt: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
    },
  ): Promise<void> {
    try {
      const { facts, lastSettledMessageAt, sessionEndAt, messages } = params;

      if (messages.length === 0) {
        await this.longTerm.markLastSettledMessageAt(corpId, userId, sessionEndAt);
        this.logger.debug('[settlement] 无对话记录，仅更新沉淀边界');
        return;
      }

      const conversationText = messages
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n');

      const factsForSummary = facts ? unwrapSessionFacts(facts) : null;
      const factsText = factsForSummary
        ? `已提取信息：${JSON.stringify(factsForSummary.interview_info)}，偏好：${JSON.stringify(factsForSummary.preferences)}`
        : '无提取信息';

      const result = await this.llm.generate({
        role: ModelRole.Extract,
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: `[对话记录]\n${conversationText}\n\n[提取信息]\n${factsText}`,
      });

      const firstMsgTime = messages[0]
        ? new Date(messages[0].timestamp).toISOString()
        : lastSettledMessageAt;

      const summaryEntry: SummaryEntry = {
        summary: result.text || '（摘要生成失败）',
        sessionId,
        startTime: firstMsgTime,
        endTime: sessionEndAt,
      };

      await this.longTerm.appendSummary(corpId, userId, summaryEntry, {
        lastSettledMessageAt: sessionEndAt,
        compressArchive: (overflow, existingArchive) =>
          this.compressArchive(overflow, existingArchive),
      });

      // 沉淀时将已校验/清洗过的 sessionFacts 身份信息写入 Profile。
      if (facts) {
        await this.longTerm.writeFromSettlement(corpId, userId, facts);
      }

      this.logger.log(
        `[settlement] 摘要已写入: userId=${userId}, sessionId=${sessionId}, endAt=${sessionEndAt}`,
      );
    } catch (error) {
      this.logger.warn('[settlement] 摘要生成/保存失败', error);
    }
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
      system: ARCHIVE_COMPRESS_PROMPT,
      prompt: parts.join('\n\n'),
    });

    return result.text || existingArchive || '';
  }
}
