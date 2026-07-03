import { Injectable } from '@nestjs/common';
import { AgentTestFeedback, FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';
import { SubmitFeedbackRequestDto } from '../dto/test-chat.dto';

@Injectable()
export class TestFeedbackService {
  constructor(private readonly feishuBitableService: FeishuBitableSyncService) {}

  async submitFeedback(request: SubmitFeedbackRequestDto) {
    const feedback: AgentTestFeedback = {
      type: request.type,
      chatHistory: request.chatHistory,
      userMessage: request.userMessage,
      errorType: request.errorType,
      remark: request.remark,
      chatId: request.chatId,
      messageId: request.messageId,
      traceId: request.traceId,
      batchId: request.batchId,
      sourceTrace: request.sourceTrace,
      candidateName: request.candidateName,
      managerName: request.managerName,
    };

    const result = await this.feishuBitableService.writeAgentTestFeedback(feedback);
    if (!result.success) {
      throw new Error(result.error || '写入飞书表格失败');
    }

    return {
      success: true,
      data: {
        recordId: result.recordId,
        type: request.type,
        message: `${request.type === 'goodcase' ? 'GoodCase' : 'BadCase'} 已成功写入飞书表格`,
      },
    };
  }
}
