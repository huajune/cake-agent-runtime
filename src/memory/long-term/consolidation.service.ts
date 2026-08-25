import { Inject, Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { MemoryConfig } from '../memory.config';
import { LongTermService } from './long-term.service';
import type { SummaryEntry } from './long-term.types';
import {
  type EntityExtractionResult,
  type SessionFacts,
  unwrapSessionFacts,
} from '../short-term/short-term.types';
import type { PersistedBrandState } from '@resolution/brand/brand-resolution.types';
import {
  MEMORY_CHAT_SESSION_PORT,
  MEMORY_SYSTEM_CONFIG_PORT,
  type MemoryChatSessionPort,
  type MemorySystemConfigPort,
} from '../memory.ports';

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要生成器。将招募经理与候选人的对话和提取事实压缩为结构化短摘要。

要求：
- 必须严格输出四节，标题依次为「求职目标」「关键约束」「进展与结果」「未决事项」
- 保留可检索标识符，包括 jobId、门店名、日期；没有的信息写“无”
- 拒绝品牌、不可接受的岗位/地点/时间等必须写入「关键约束」
- 不得把岗位要求或助手话术写成候选人事实
- 总长度不超过 150 字，使用第三人称`;

const CONSOLIDATION_FETCH_LIMIT = 500;
const CONSOLIDATION_MAX_PAGES = 10;

/** 摘要 LLM 输入的消息条数上限：分页扫描后旧会话段可能远超单页。 */
const SUMMARY_MAX_MESSAGES = 120;

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
 * - `agent_long_term_memories.consolidation_watermarks`（Supabase 永久）：上次已沉淀到哪条消息
 * - `chat_messages` 表里的真实消息时间戳：用来找会话间隔
 *
 * 1. 查询 chat_messages 最新消息并复核闲置时长；不足阈值时返回剩余 delay
 * 2. 读取 `bySession[sessionId]`，边界已覆盖最新消息即幂等跳过
 * 3. 分页读取水位后的当前咨询段，用当前 sessionFacts 作为已校验事实参考生成摘要
 * 4. 写入长期事实与摘要，并由同名 RPC 原子推进会话级沉淀水位
 */
@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    private readonly config: MemoryConfig,
    private readonly longTerm: LongTermService,
    @Inject(MEMORY_CHAT_SESSION_PORT)
    private readonly chatSession: MemoryChatSessionPort,
    private readonly llm: LlmExecutorService,
    @Inject(MEMORY_SYSTEM_CONFIG_PORT)
    private readonly systemConfig: MemorySystemConfigPort,
  ) {}

  async consolidateIdleSession(
    corpId: string,
    userId: string,
    sessionId: string,
    botUserId: string,
    sessionFacts: EntityExtractionResult | SessionFacts | null,
    botImId?: string,
    brandState?: PersistedBrandState | null,
  ): Promise<
    | { status: 'consolidated' | 'already_consolidated'; latestMessageAt: number }
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

    const watermarks = await this.longTerm.getConsolidationWatermarks(corpId, userId, botUserId);
    const lastConsolidatedAt =
      watermarks.bySession[sessionId] ?? watermarks.lastSettledMessageAt ?? null;
    const lastConsolidatedMs = lastConsolidatedAt ? new Date(lastConsolidatedAt).getTime() : 0;

    if (Number.isFinite(lastConsolidatedMs) && lastConsolidatedMs >= latestMessageAt) {
      return { status: 'already_consolidated', latestMessageAt };
    }

    const messages = await this.readUnconsolidatedMessages(
      sessionId,
      lastConsolidatedMs,
      latestMessageAt,
    );
    if (messages.length === 0) {
      throw new Error(`memory_consolidation_messages_missing:${sessionId}`);
    }

    // 首次接管存量 chat 时只沉淀最后一个连续咨询段，避免把多段历史合成一个 episode。
    const currentEpisode = lastConsolidatedAt ? messages : this.trimToLatestEpisode(messages);
    const sessionEndAt = new Date(latestMessageAt).toISOString();
    await this.generateAndSaveSummary(corpId, userId, sessionId, {
      facts: sessionFacts,
      botUserId,
      lastSettledMessageAt: lastConsolidatedAt,
      sessionEndAt,
      messages: currentEpisode,
      botImId,
      brandState: brandState ?? null,
    });

    return { status: 'consolidated', latestMessageAt };
  }

  // ==================== 内部方法 ====================

  private async readUnconsolidatedMessages(
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
    const summarizedMessages = messages.slice(-SUMMARY_MAX_MESSAGES);
    const conversationText = summarizedMessages
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

    const summary = result.text?.trim();
    if (!summary) {
      throw new Error(`memory_consolidation_summary_empty:${sessionId}`);
    }

    const firstMsgTime = summarizedMessages[0]
      ? new Date(summarizedMessages[0].timestamp).toISOString()
      : lastSettledMessageAt;

    const summaryEntry: SummaryEntry = {
      summary,
      sessionId,
      ...(botImId ? { originBotId: botImId } : {}),
      startTime: firstMsgTime,
      endTime: sessionEndAt,
      ...(messages.length > SUMMARY_MAX_MESSAGES
        ? { coverageNote: `仅覆盖末 ${SUMMARY_MAX_MESSAGES} 条（共 ${messages.length} 条）` }
        : {}),
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
    });

    this.logger.log(
      `[consolidation] 摘要已写入: userId=${userId}, sessionId=${sessionId}, endAt=${sessionEndAt}`,
    );
  }
}
