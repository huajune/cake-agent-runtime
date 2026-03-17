import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoopService } from '@agent/loop.service';
import { ContextService } from '@agent/context/context.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import {
  AgentInvokeResult,
  AgentReply,
  FallbackMessageOptions,
} from '../types/wecom-message.types';
import { ReplyNormalizer } from '../utils/reply-normalizer.util';

/**
 * Agent 网关服务
 * 封装 Orchestrator 调用的完整流程 + 降级处理 + 监控埋点
 */
@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  private readonly defaultFallbackMessages: string[] = [
    '我确认下哈，马上回你~',
    '我这边查一下，稍等~',
    '让我看看哈，很快~',
    '这块我再核实下，确认好马上告诉你哈~',
    '这个涉及几个细节，我确认下再回你',
    '这块资料我这边暂时没看到，我先帮你记下来，确认好回你~',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly loop: LoopService,
    private readonly context: ContextService,
    private readonly monitoringService: MessageTrackingService,
  ) {}

  // ========================================
  // 降级消息管理
  // ========================================

  getFallbackMessage(options?: FallbackMessageOptions): string {
    if (options?.customMessage) return options.customMessage;

    const envMessage = this.configService.get<string>('AGENT_FALLBACK_MESSAGE', '');
    if (envMessage) return envMessage;

    if (options?.random === false) return this.defaultFallbackMessages[0];

    const index = Math.floor(Math.random() * this.defaultFallbackMessages.length);
    return this.defaultFallbackMessages[index];
  }

  // ========================================
  // Agent 调用（新路径：Orchestrator）
  // ========================================

  async invoke(params: {
    sessionId: string;
    userMessage: string;
    historyMessages: { role: string; content: string }[];
    scenario?: string;
    messageId?: string;
    recordMonitoring?: boolean;
    userId: string;
    corpId?: string;
  }): Promise<AgentInvokeResult> {
    const {
      userMessage,
      historyMessages,
      scenario = 'candidate-consultation',
      messageId,
      recordMonitoring = true,
      userId,
      corpId = 'default',
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;

    try {
      if (recordMonitoring && messageId) {
        this.monitoringService.recordAiStart(messageId);
        shouldRecordAiEnd = true;
      }

      // 构建消息列表：历史 + 当前用户消息
      const messages = [
        ...historyMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: userMessage },
      ];

      // 组装 systemPrompt，再调用 Loop
      const { systemPrompt, stageGoals } = await this.context.compose({ scenario });
      const result = await this.loop.run({
        systemPrompt,
        stageGoals,
        messages,
        userId,
        corpId,
      });

      const processingTime = Date.now() - startTime;

      // 提取并规范化回复内容
      const content = this.normalizeContent(result.text);
      if (!content) {
        throw new Error('Agent 返回空响应');
      }

      const reply: AgentReply = {
        content,
        usage: result.usage,
      };

      this.logger.log(
        `Agent 调用成功，耗时 ${processingTime}ms，tokens=${reply.usage?.totalTokens || 'N/A'}`,
      );

      return {
        reply,
        isFallback: false,
        processingTime,
      };
    } catch (error) {
      this.logger.error(`Agent 调用异常: ${error.message}`);
      throw error;
    } finally {
      if (shouldRecordAiEnd && messageId) {
        this.monitoringService.recordAiEnd(messageId);
      }
    }
  }

  private normalizeContent(rawContent: string): string {
    if (ReplyNormalizer.needsNormalization(rawContent)) {
      const normalizedContent = ReplyNormalizer.normalize(rawContent);
      this.logger.debug(
        `[ReplyNormalizer] 已清洗回复: "${rawContent.substring(0, 50)}..." → "${normalizedContent.substring(0, 50)}..."`,
      );
      return normalizedContent;
    }
    return rawContent;
  }
}
