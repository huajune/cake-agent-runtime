import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentTestFeedback, FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';
import { SubmitFeedbackRequestDto } from '../dto/test-chat.dto';

/** 单张截图解码后大小上限 */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** 截图经 base64 编码后仍需和聊天记录一起落在全局 20MB JSON 请求上限内 */
const MAX_TOTAL_SCREENSHOT_BYTES = 10 * 1024 * 1024;

@Injectable()
export class TestFeedbackService {
  constructor(private readonly feishuBitableService: FeishuBitableSyncService) {}

  async submitFeedback(request: SubmitFeedbackRequestDto) {
    this.assertScreenshotSizes(request.screenshots);

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
      source: request.source,
      screenshots: request.screenshots,
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

  private assertScreenshotSizes(screenshots?: string[]): void {
    if (!screenshots?.length) return;
    let totalBytes = 0;
    for (const [index, dataUrl] of screenshots.entries()) {
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      // base64 长度 * 3/4 即解码后字节数的上界，避免为校验做完整解码
      const approxBytes = Math.floor(base64.length * 0.75);
      if (approxBytes > MAX_SCREENSHOT_BYTES) {
        throw new BadRequestException(`第 ${index + 1} 张截图超过 5MB 限制`);
      }
      totalBytes += approxBytes;
      if (totalBytes > MAX_TOTAL_SCREENSHOT_BYTES) {
        throw new BadRequestException('截图总大小超过 10MB 限制');
      }
    }
  }
}
