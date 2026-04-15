import { Injectable, Logger } from '@nestjs/common';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { MessageParser } from '@wecom/message/utils/message-parser.util';
import { ConversationRiskActionService } from './conversation-risk-action.service';
import { ConversationRiskContextService } from './conversation-risk-context.service';
import { ConversationRiskDetectorService } from './conversation-risk-detector.service';
import { ConversationRiskLlmAnalyzerService } from './conversation-risk-llm-analyzer.service';
import { ConversationRiskHandleResult } from '../types/conversation-risk.types';

@Injectable()
export class ConversationRiskService {
  private readonly logger = new Logger(ConversationRiskService.name);

  constructor(
    private readonly contextService: ConversationRiskContextService,
    private readonly detectorService: ConversationRiskDetectorService,
    private readonly llmAnalyzerService: ConversationRiskLlmAnalyzerService,
    private readonly actionService: ConversationRiskActionService,
  ) {}

  async checkAndHandle(params: {
    messageData: EnterpriseMessageCallbackDto;
    content: string;
  }): Promise<ConversationRiskHandleResult> {
    const { messageData, content } = params;
    const parsed = MessageParser.parse(messageData);
    const chatId = parsed.chatId;
    const userId = parsed.imContactId || messageData.externalUserId || chatId;
    const corpId = parsed.orgId || 'default';
    const pauseTargetId = chatId || userId;

    if (!chatId || !userId || !content.trim()) {
      return { hit: false, paused: false, alerted: false };
    }

    const context = await this.contextService.buildContext({
      corpId,
      chatId,
      userId,
      pauseTargetId,
      messageId: parsed.messageId,
      contactName: parsed.contactName,
      botImId: parsed.imBotId,
      currentMessageContent: content,
    });

    const detection = this.detectorService.detect(context);
    if (detection.hit) {
      this.logger.warn(
        `[交流异常] 命中规则检测 [${parsed.messageId}], chatId=${chatId}, type=${detection.riskType}, reason=${detection.reason}`,
      );

      return this.actionService.handleHit(context, detection);
    }

    const reviewSignal = this.detectorService.buildLlmReviewSignal(context);
    if (!reviewSignal) {
      return { hit: false, paused: false, alerted: false };
    }

    const llmDetection = await this.llmAnalyzerService.analyze(context, reviewSignal);
    if (!llmDetection.hit) {
      return { hit: false, paused: false, alerted: false };
    }

    this.logger.warn(
      `[交流异常] 命中LLM复判 [${parsed.messageId}], chatId=${chatId}, type=${llmDetection.riskType}, reason=${llmDetection.reason}`,
    );

    return this.actionService.handleHit(context, llmDetection);
  }
}
