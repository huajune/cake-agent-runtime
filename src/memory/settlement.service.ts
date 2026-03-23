import { Injectable, Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@providers/types';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MemoryConfig } from './memory.config';
import { SessionFactsService } from './session-facts.service';
import { LongTermService } from './long-term.service';
import type { UserProfile, SummaryEntry, EntityExtractionResult } from './memory.types';

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
 * 1. 检测 lastInteraction 距今是否 >= SESSION_TTL
 * 2. 从 Session Facts 提取身份字段 → 写入 Profile
 * 3. 从 chat_messages + Session Facts → LLM 生成摘要 → 追加到 Summary
 * 4. Session Facts / Stage 的 Redis key 自然过期
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly config: MemoryConfig,
    private readonly sessionFacts: SessionFactsService,
    private readonly longTerm: LongTermService,
    private readonly chatSession: ChatSessionService,
    private readonly router: RouterService,
  ) {}

  /**
   * 检测并执行沉淀（每轮对话开始时调用）
   *
   * @returns true 表示触发了沉淀（本次视为新会话），false 表示未触发
   */
  async checkAndSettle(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    try {
      const lastInteraction = await this.sessionFacts.getLastInteraction(corpId, userId, sessionId);
      if (!lastInteraction) return false;

      const elapsed = Date.now() - new Date(lastInteraction).getTime();
      const thresholdMs = this.config.sessionTtl * 1000;

      if (elapsed < thresholdMs) return false;

      this.logger.log(
        `空闲超时检测: userId=${userId}, 空闲 ${Math.round(elapsed / 3600000)}h >= ${this.config.sessionTtlDays}d，触发沉淀`,
      );

      // 1. 读取即将过期的 Session Facts
      const state = await this.sessionFacts.getSessionState(corpId, userId, sessionId);

      // 2. 身份字段沉淀到 Profile
      if (state.facts) {
        const identityFields = extractIdentityFields(state.facts);
        await this.longTerm.saveProfile(corpId, userId, identityFields);
        this.logger.log(`Profile 已沉淀: userId=${userId}`);
      }

      // 3. 生成对话摘要 → 追加到 Summary
      await this.generateAndSaveSummary(corpId, userId, sessionId, state.facts, lastInteraction);

      return true;
    } catch (error) {
      this.logger.warn('沉淀检测失败', error);
      return false;
    }
  }

  // ==================== 内部方法 ====================

  private async generateAndSaveSummary(
    corpId: string,
    userId: string,
    sessionId: string,
    facts: EntityExtractionResult | null,
    lastInteraction: string,
  ): Promise<void> {
    try {
      // 读取该时段的对话记录
      const messages = await this.chatSession.getChatHistory(sessionId, 30);
      if (messages.length === 0) {
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
      const model = this.router.resolveByRole(ModelRole.Extract);
      const result = await generateText({
        model,
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: `[对话记录]\n${conversationText}\n\n[提取信息]\n${factsText}`,
      });

      const summaryEntry: SummaryEntry = {
        summary: result.text || '（摘要生成失败）',
        sessionId,
        startTime: messages[0]
          ? new Date(messages[0].timestamp).toISOString()
          : new Date().toISOString(),
        endTime: lastInteraction,
      };

      // 追加到 Summary（带分层压缩）
      await this.longTerm.appendSummary(corpId, userId, summaryEntry, (overflow, existingArchive) =>
        this.compressArchive(overflow, existingArchive),
      );

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

    const model = this.router.resolveByRole(ModelRole.Extract);
    const result = await generateText({
      model,
      system: ARCHIVE_COMPRESS_PROMPT,
      prompt: parts.join('\n\n'),
    });

    return result.text || existingArchive || '';
  }
}
