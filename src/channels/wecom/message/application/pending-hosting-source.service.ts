import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { STRIDE_PRIMARY_CONNECTION } from '@/types/hosting-route';
import { WECOM_API_TYPE } from '@shared-types/wecom-api.types';
import { GroupRouteCredentialsService } from '../credentials/group-route-credentials.service';
import {
  hasEnterpriseCallbackCredential,
  verifyGroupCallback,
} from '../credentials/verified-hosting-route';
import type { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';

@Injectable()
export class PendingHostingSourceService {
  constructor(
    private readonly db: SupabaseService,
    private readonly config: ConfigService,
    private readonly groups: GroupRouteCredentialsService,
  ) {}

  /** Older workers could enqueue a verified callback but store its history without routing columns. */
  async restore(message: EnterpriseMessageCallbackDto): Promise<boolean> {
    const at = Number(message.timestamp);
    if (
      !Number.isFinite(at) ||
      at <= 0 ||
      !message.messageId ||
      !message.chatId ||
      !message.imBotId
    )
      return false;
    const client = this.db.getSupabaseClient();
    if (!client) throw new ServiceUnavailableException('托管归属服务暂不可用');
    const identity = {
      message_id: message.messageId,
      chat_id: message.chatId,
      im_bot_id: message.imBotId,
      timestamp: new Date(at).toISOString(),
      role: 'user',
    };
    const { data: legacy, error } = await client
      .from('chat_messages')
      .select('hosting_connection_id,tenant_id')
      .match(identity)
      .abortSignal(AbortSignal.timeout(5000))
      .maybeSingle();
    if (error) throw new ServiceUnavailableException('暂时无法核对待回复消息');
    if (!legacy) return false;
    if (legacy.hosting_connection_id || legacy.tenant_id)
      return (
        legacy.hosting_connection_id === STRIDE_PRIMARY_CONNECTION && Boolean(legacy.tenant_id)
      );

    let source;
    if (message._apiType === WECOM_API_TYPE.GROUP) {
      const verified = await verifyGroupCallback(message, this.groups);
      if (!verified) return false;
      source = { hosting_observed_group_id: verified.groupId };
    } else {
      if (
        !hasEnterpriseCallbackCredential(
          message,
          this.config.get<string>('STRIDE_ENTERPRISE_TOKEN'),
        )
      )
        return false;
      source = { hosting_group_id: message.groupId ?? null };
    }
    // The database trigger derives the tenant at the message time. Never replace newer evidence.
    const { error: writeError } = await client
      .from('chat_messages')
      .update({ hosting_connection_id: STRIDE_PRIMARY_CONNECTION, ...source })
      .match(identity)
      .is('hosting_connection_id', null)
      .is('hosting_group_id', null)
      .is('hosting_observed_group_id', null)
      .is('tenant_id', null)
      .abortSignal(AbortSignal.timeout(5000));
    if (writeError) throw new ServiceUnavailableException('暂时无法登记待回复消息的来源');
    return true;
  }
}
