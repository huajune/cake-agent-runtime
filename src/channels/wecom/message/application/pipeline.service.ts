import { Injectable } from '@nestjs/common';
import { AcceptInboundMessageService } from './accept-inbound-message.service';
import { ReplyWorkflowService } from './reply-workflow.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';

/**
 * 消息处理管线服务
 *
 * 对外暴露：
 *   execute(dto)             — 完整管线入口（MessageService 唯一调用点）
 *   processSingleMessage()   — 直发路径
 *   processMergedMessages()  — 聚合路径（MessageProcessor 调用）
 *
 * 管线步骤全部私有，由 execute() 内部编排：
 *   step0: handleSelfMessage
 *   step1: filterMessage（只判断，不写副作用）
 *   step2: checkDuplication
 *   step3: recordHistory（含 historyOnly 分支）
 *   step4: recordMonitoring
 */
@Injectable()
export class MessagePipelineService {
  constructor(
    private readonly acceptInboundMessage: AcceptInboundMessageService,
    private readonly replyWorkflow: ReplyWorkflowService,
  ) {}

  // ========================================
  // 公开入口
  // ========================================

  /**
   * 消息处理管线入口（MessageService 的唯一调用点）
   *
   * 返回值：
   *   shouldDispatch=true  — 需要触发 AI，由 MessageService 决定是否 dispatch
   *   shouldDispatch=false — 管线已终止，response 是最终响应
   */
  async execute(messageData: EnterpriseMessageCallbackDto): Promise<{
    shouldDispatch: boolean;
    response: { success: boolean; message: string };
    content?: string;
  }> {
    return this.acceptInboundMessage.execute(messageData);
  }

  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    return this.replyWorkflow.processSingleMessage(messageData);
  }

  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    return this.replyWorkflow.processMergedMessages(messages, batchId);
  }
}
