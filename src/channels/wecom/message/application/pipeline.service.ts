import { Injectable } from '@nestjs/common';
import { AcceptInboundMessageService } from './accept-inbound-message.service';
import { ReplyWorkflowService } from './reply-workflow.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';

/**
 * 消息处理管线服务
 *
 * 门面，对外暴露三个入口：
 *   execute(dto)             — 完整入站管线，委托 AcceptInboundMessageService
 *                              （自发消息/过滤/去重/写历史/前置打点）；MessageService 唯一调用点
 *   processSingleMessage()   — 直发路径，委托 ReplyWorkflowService
 *   processMergedMessages()  — 聚合路径，委托 ReplyWorkflowService（MessageProcessor 调用）
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
    initialSnapshotSize: number,
  ): Promise<void> {
    return this.replyWorkflow.processMergedMessages(messages, batchId, initialSnapshotSize);
  }
}
