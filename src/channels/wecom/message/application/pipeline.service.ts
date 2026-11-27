import { Injectable } from '@nestjs/common';
import { BusinessTenantResolver, runForTenant } from '@infra/supabase/business-tenant';
import { ReplyDeferredError } from '@biz/reply-execution/reply-execution.types';
import { VERIFIED_HOSTING_ROUTE } from '@/types/hosting-route';
import { AcceptInboundMessageService } from './accept-inbound-message.service';
import { PendingHostingSourceService } from './pending-hosting-source.service';
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
    private readonly pendingSources: PendingHostingSourceService,
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
      await runForTenant(original, () =>
        this.replyWorkflow.processSingleMessage(
          messageData,
          this.selectReplay(messageData.imBotId, original),
        ),
      );
  }

  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
    assertOwned?: () => Promise<void>,
  ): Promise<'deferred' | void> {
    if (!messages.length) return;
    const botId = messages[messages.length - 1].imBotId;
    const batch = await this.ownedBatch(messages, botId);
    if (batch?.messages.length)
      return runForTenant(batch.tenant, () =>
        this.replyWorkflow.processMergedMessages(
          batch.messages,
          batchId,
          assertOwned,
          this.selectReplay(botId, batch.tenant),
        ),
      );
  }

  private selectReplay(botId: string, tenant: string) {
    return async (messages: EnterpriseMessageCallbackDto[]) => {
      let batch;
      try {
        batch = await this.ownedBatch(messages, botId);
      } catch {
        throw new ReplyDeferredError('pending_hosting_source_unavailable');
      }
      if (batch?.tenant !== tenant) throw new ReplyDeferredError('pending_hosting_owner_changed');
      return batch.messages;
    };
  }

  private async ownedBatch(messages: EnterpriseMessageCallbackDto[], botId: string) {
    const sources = [...messages.map((m) => this.source(m)), { botId, at: Date.now() }];
    let owners = await this.tenants.resolve(sources);
    if (!owners.at(-1)) return;
    let restored = false;
    for (const [i, message] of messages.entries()) {
      if (!owners[i] && message.imBotId === botId && (await this.pendingSources.restore(message)))
        restored = true;
    }
    if (restored) {
      sources[sources.length - 1] = { botId, at: Date.now() };
      owners = await this.tenants.resolve(sources);
    }
    const current = owners.pop();
    if (!current) return;
    return {
      tenant: current,
      messages: messages.filter((m, i) => m.imBotId === botId && owners[i] === current),
    };
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
