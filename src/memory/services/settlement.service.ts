import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MemoryConfig } from '../memory.config';
import { LongTermService } from './long-term.service';
import type { UserProfile, SummaryEntry } from '../types/long-term.types';
import type { EntityExtractionResult, WeworkSessionState } from '../types/session-facts.types';

/** 身份字段提取：从 EntityExtractionResult 中取出属于 Profile 的字段 */
function extractIdentityFields(facts: EntityExtractionResult): Partial<UserProfile> {
  const info = facts.interview_info;
  return {
    name: info.name,
    phone: info.phone,
    gender: info.gender,
    age: info.age,
    is_student: info.is_student,
    education: info.education,
    has_health_certificate: info.has_health_certificate,
  };
}

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要生成器。将招募经理与候选人的对话和提取的事实信息压缩为一段简洁的摘要。

要求：
- 一段话概括：候选人找什么工作、意向品牌/城市、是否安排了面试、最终结果
- 保留关键事实（岗位、门店、时间、结果）
- 不超过 100 字
- 使用第三人称`;

const ARCHIVE_COMPRESS_PROMPT = `你是记忆压缩器。将多条历史求职摘要合并为一段简洁的总结。

要求：
- 合并重复信息，保留关键事实
- 按时间顺序概括
- 不超过 200 字
- 使用第三人称`;

/**
 * 沉淀服务 — 空闲超时触发，将会话记忆沉淀到长期记忆
 *
 * 流程：
 * 1. 根据 lastSessionActiveAt 判断上一段会话是否已空闲超时
 * 2. 从 Session Facts 提取身份字段 → 写入 Profile
 * 3. 从 chat_messages + Session Facts → LLM 生成摘要 → 追加到 Summary
 * 4. Session Facts / Stage 的 Redis key 自然过期
 *
 * 关键边界：
 * - `lastSessionActiveAt` 决定“这一段会话何时结束”
 * - `lastSettledMessageAt` 决定“长期记忆已经沉淀到哪条消息为止”
 *
 * 两者不是同一个概念：
 * - 前者是会话活跃边界
 * - 后者是长期记忆摘要边界
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

  /** 是否达到沉淀阈值。只负责判断会话是否闲置够久。 */
  shouldSettle(lastSessionActiveAt: string | null | undefined): boolean {
    if (!lastSessionActiveAt) return false;
    const elapsed = Date.now() - new Date(lastSessionActiveAt).getTime();
    return elapsed >= this.config.sessionTtl * 1000;
  }

  /**
   * 对已结束的一段会话执行沉淀。
   *
   * 这里不会修改 Redis 会话态本身，只会把可沉淀的内容写入长期记忆。
   */
  async settle(
    corpId: string,
    userId: string,
    sessionId: string,
    state: Pick<WeworkSessionState, 'facts' | 'lastSessionActiveAt'>,
  ): Promise<void> {
    try {
      const lastSessionActiveAt = state.lastSessionActiveAt ?? null;
      if (!this.shouldSettle(lastSessionActiveAt)) return;

      const elapsed = Date.now() - new Date(lastSessionActiveAt).getTime();
      const summaryData = await this.longTerm.getSummaryData(corpId, userId);
      const lastSettledMessageAt = summaryData?.lastSettledMessageAt ?? null;

      // 如果长期记忆的摘要边界已经覆盖到这段会话末尾，就不再重复沉淀。
      if (
        lastSettledMessageAt &&
        new Date(lastSettledMessageAt).getTime() >= new Date(lastSessionActiveAt).getTime()
      ) {
        this.logger.debug(`会话已沉淀到最新边界，跳过: userId=${userId}, sessionId=${sessionId}`);
        return;
      }

      this.logger.log(
        `空闲超时检测: userId=${userId}, 空闲 ${Math.round(elapsed / 3600000)}h >= ${this.config.sessionTtlDays}d，触发沉淀`,
      );

      if (state.facts) {
        const identityFields = extractIdentityFields(state.facts);
        await this.longTerm.saveProfile(corpId, userId, identityFields);
        this.logger.log(`Profile 已沉淀: userId=${userId}`);
      }

      await this.generateAndSaveSummary(corpId, userId, sessionId, {
        facts: state.facts,
        lastSessionActiveAt,
        lastSettledMessageAt,
      });
    } catch (error) {
      this.logger.warn('记忆沉淀失败', error);
    }
  }

  // ==================== 内部方法 ====================

  private async generateAndSaveSummary(
    corpId: string,
    userId: string,
    sessionId: string,
    params: {
      facts: EntityExtractionResult | null;
      lastSessionActiveAt: string;
      lastSettledMessageAt: string | null;
    },
  ): Promise<void> {
    try {
      const { facts, lastSessionActiveAt, lastSettledMessageAt } = params;
      // 本次摘要只处理“上次已沉淀边界之后，到本次会话结束为止”的消息。
      // 这样可以避免多次 settlement 时重复吃到历史消息。
      const startTimeExclusive = lastSettledMessageAt
        ? new Date(lastSettledMessageAt).getTime()
        : undefined;
      const endTimeInclusive = new Date(lastSessionActiveAt).getTime();

      const messages = await this.chatSession.getChatHistoryInRange(sessionId, {
        startTimeExclusive,
        endTimeInclusive,
      });

      if (messages.length === 0) {
        await this.longTerm.markLastSettledMessageAt(corpId, userId, lastSessionActiveAt);
        this.logger.debug('无对话记录，跳过摘要生成');
        return;
      }

      const conversationText = messages
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n');

      const factsText = facts
        ? `已提取信息：${JSON.stringify(facts.interview_info)}，偏好：${JSON.stringify(facts.preferences)}`
        : '无提取信息';

      // LLM 生成摘要
      const result = await this.llm.generate({
        role: ModelRole.Extract,
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: `[对话记录]\n${conversationText}\n\n[提取信息]\n${factsText}`,
      });

      const summaryEntry: SummaryEntry = {
        summary: result.text || '（摘要生成失败）',
        sessionId,
        startTime: messages[0]
          ? new Date(messages[0].timestamp).toISOString()
          : new Date().toISOString(),
        endTime: lastSessionActiveAt,
      };

      // 追加到 Summary（带分层压缩）
      await this.longTerm.appendSummary(corpId, userId, summaryEntry, {
        lastSettledMessageAt: lastSessionActiveAt,
        compressArchive: (overflow, existingArchive) =>
          this.compressArchive(overflow, existingArchive),
      });

      this.logger.log(`Summary 已沉淀: userId=${userId}, sessionId=${sessionId}`);
    } catch (error) {
      this.logger.warn('摘要生成/保存失败', error);
    }
  }

  /**
   * 压缩 archive：将溢出的 recent 条目 + 旧 archive 合并为新 archive
   */
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
