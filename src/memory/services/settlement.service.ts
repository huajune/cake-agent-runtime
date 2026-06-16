import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MemoryConfig } from '../memory.config';
import { LongTermService } from './long-term.service';
import type { SummaryEntry } from '../types/long-term.types';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
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

/** 摘要 LLM 输入的消息条数上限：分页扫描后旧会话段可能远超单页。 */
const SUMMARY_MAX_MESSAGES = 120;

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
    private readonly systemConfig: SystemConfigService,
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
    botImId?: string,
  ): Promise<boolean> {
    try {
      const summaryData = await this.longTerm.getSummaryData(corpId, userId);
      // 边界按会话（sessionId=chatId，bot 维度）隔离读取；旧的用户级边界仅作回退。
      // 否则双 bot 服务同一候选人时，bot A 推进用户级边界后，bot B 边界之前的
      // 会话消息会被快速跳过/查询起点裁掉，永不沉淀。
      const lastSettledAt =
        summaryData?.lastSettledBySession?.[sessionId] ?? summaryData?.lastSettledMessageAt ?? null;

      // 快速跳过：若上次沉淀边界距今 < settlementGapSeconds，不可能存在闭合断层
      if (lastSettledAt) {
        const msSinceLastSettled = Date.now() - new Date(lastSettledAt).getTime();
        if (msSinceLastSettled < this.config.settlementGapSeconds * 1000) {
          return false;
        }
      }

      const effectiveSettledMs = lastSettledAt ? new Date(lastSettledAt).getTime() : 0;
      const scan = await this.scanForSessionGap(sessionId, effectiveSettledMs);

      if (scan.messages.length === 0) return false;

      // 冷启动：首次无沉淀基准时，将边界初始化到最新消息，跳过历史全量沉淀
      if (!lastSettledAt) {
        const latestTs = new Date(scan.messages.at(-1)!.timestamp).toISOString();
        await this.longTerm.markLastSettledMessageAt(corpId, userId, latestTs, sessionId);
        this.logger.log(
          `[detectAndSettle] 冷启动初始化边界: userId=${userId}, sessionId=${sessionId}, boundary=${latestTs}`,
        );
        return false;
      }

      if (scan.gapBeforeIndex === -1) return false;

      // gapBeforeIndex 之前的消息属于待沉淀的旧会话
      const prevSessionMessages = scan.messages.slice(0, scan.gapBeforeIndex);
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
        botImId,
      });

      return true;
    } catch (error) {
      this.logger.warn('[detectAndSettle] 沉淀检测失败', error);
      return false;
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 从沉淀边界开始分页扫描消息，寻找首个会话断层（相邻消息间隔 ≥ settlementGap）。
   *
   * 修复：旧实现只取边界后最旧的 500 条，长会话（边界后 >500 条且断层在更后面）
   * 永远扫不到断层，`lastSettledMessageAt` 不再前进，该用户从此永不沉淀，
   * 且每轮重复拉同样 500 条做无效扫描。
   */
  private async scanForSessionGap(
    sessionId: string,
    startTimeExclusive: number,
  ): Promise<{
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
    gapBeforeIndex: number;
  }> {
    const SESSION_GAP_MS = this.config.settlementGapSeconds * 1000;
    const MAX_PAGES = 10;

    const scanned: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];
    let cursor = startTimeExclusive;

    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.chatSession.getChatHistoryInRange(sessionId, {
        startTimeExclusive: cursor,
        limit: SETTLEMENT_FETCH_LIMIT,
      });
      if (batch.length === 0) break;

      const sortedBatch = [...batch].sort((a, b) => a.timestamp - b.timestamp);
      const offset = scanned.length;
      scanned.push(...sortedBatch);

      // 从上一页与本页的衔接处开始找断层（i 从 max(1, offset) 起，覆盖跨页间隔）
      for (let i = Math.max(1, offset); i < scanned.length; i++) {
        if (scanned[i].timestamp - scanned[i - 1].timestamp >= SESSION_GAP_MS) {
          return { messages: scanned, gapBeforeIndex: i };
        }
      }

      if (batch.length < SETTLEMENT_FETCH_LIMIT) break;
      cursor = sortedBatch.at(-1)!.timestamp;
    }

    return { messages: scanned, gapBeforeIndex: -1 };
  }

  private async generateAndSaveSummary(
    corpId: string,
    userId: string,
    sessionId: string,
    params: {
      facts: EntityExtractionResult | SessionFacts | null;
      lastSettledMessageAt: string | null;
      sessionEndAt: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
      botImId?: string;
    },
  ): Promise<void> {
    try {
      const { facts, lastSettledMessageAt, sessionEndAt, messages, botImId } = params;

      if (messages.length === 0) {
        await this.longTerm.markLastSettledMessageAt(corpId, userId, sessionEndAt, sessionId);
        this.logger.debug('[settlement] 无对话记录，仅更新沉淀边界');
        return;
      }

      // 分页扫描后旧会话段可能很长，摘要只取末尾一段，避免 LLM prompt 失控。
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
        startTime: firstMsgTime,
        endTime: sessionEndAt,
      };

      await this.longTerm.appendSummary(corpId, userId, summaryEntry, {
        lastSettledMessageAt: sessionEndAt,
        sessionId,
        compressArchive: (overflow, existingArchive) =>
          this.compressArchive(overflow, existingArchive),
      });

      // 沉淀时将已校验/清洗过的 sessionFacts 身份信息写入 Profile。
      // 带上 sessionId/botImId 数据血缘，供跨 bot 追溯与跨会话口径使用。
      if (facts) {
        await this.longTerm.writeFromSettlement(corpId, userId, facts, { sessionId, botImId });
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
      modelId: await this.systemConfig.getExtractModelOverride(),
      system: ARCHIVE_COMPRESS_PROMPT,
      prompt: parts.join('\n\n'),
    });

    return result.text || existingArchive || '';
  }
}
