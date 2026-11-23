import { Injectable } from '@nestjs/common';
import { BusinessTenantResolver, runForTenant } from '@infra/supabase/business-tenant';
import { VERIFIED_HOSTING_ROUTE } from '@/types/hosting-route';
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
    private readonly tenants: BusinessTenantResolver,
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
    const [tenantId] = await this.tenants.resolve([this.source(messageData)]);
    return runForTenant(tenantId, () => this.acceptInboundMessage.execute(messageData));
  }

  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const [original, current] = await this.tenants.resolve([
      this.source(messageData),
      { botId: messageData.imBotId, at: Date.now() },
    ]);
    if (original && original === current)
      await runForTenant(original, () => this.replyWorkflow.processSingleMessage(messageData));
  }

  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
    assertOwned?: () => Promise<void>,
  ): Promise<'deferred' | void> {
    if (!messages.length) return;
    const botId = messages[messages.length - 1].imBotId;
    const owners = await this.tenants.resolve([
      ...messages.map((m) => this.source(m)),
      { botId, at: Date.now() },
    ]);
    const current = owners.pop();
    if (!current) return;
    const owned = messages.filter((m, i) => m.imBotId === botId && owners[i] === current);
    if (owned.length)
      return runForTenant(current, () =>
        this.replyWorkflow.processMergedMessages(owned, batchId, assertOwned),
      );
  }

  private source(message: EnterpriseMessageCallbackDto) {
    return {
      botId: message.imBotId,
      at: Number(message.timestamp),
      messageId: message.messageId,
      groupId: message[VERIFIED_HOSTING_ROUTE]?.groupId,
    };
  }
}
