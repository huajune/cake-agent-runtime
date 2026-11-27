import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SupabaseService } from './supabase.service';
import { STRIDE_PRIMARY_CONNECTION } from '@/types/hosting-route';

const scope = new AsyncLocalStorage<{ tenantId: string | null }>();

/** An absent scope is a platform operation. A present null is an unresolved business event. */
export function businessTenant(): string | null | undefined {
  return scope.getStore()?.tenantId;
}

export function runForTenant<T>(tenantId: string | null, work: () => T): T {
  return scope.run({ tenantId }, work);
}

export function tenantMemoryKey(key: string): string {
  const tenantId = businessTenant();
  if (tenantId === undefined) return key;
  if (tenantId === null) throw new Error('业务归属待核实');
  return 'tenant:' + encodeURIComponent(tenantId) + ':' + key;
}

export interface BusinessSource {
  botId?: string;
  at: number;
  messageId?: string;
  groupId?: string;
}

@Injectable()
export class BusinessTenantResolver {
  constructor(private readonly db: SupabaseService) {}

  async historicalBot(chatId: string, at: number): Promise<string | null> {
    const client = this.db.getSupabaseClient();
    if (!client) throw new ServiceUnavailableException('业务归属服务暂不可用');
    const { data, error } = await client
      .rpc('hosting_session_bot', {
        p_chat: chatId,
        p_at: new Date(at).toISOString(),
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw new ServiceUnavailableException('暂时无法核实历史托管号');
    return data;
  }

  async resolve(sources: BusinessSource[]): Promise<Array<string | null>> {
    const client = this.db.getSupabaseClient();
    if (!client) throw new ServiceUnavailableException('业务归属服务暂不可用');
    const { data, error } = await client
      .rpc('hosting_event_tenants', {
        p_connection_id: STRIDE_PRIMARY_CONNECTION,
        p_events: sources.map(({ botId, at, messageId, groupId }) => ({
          bot: botId,
          at: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null,
          message_id: messageId,
          group_id: groupId,
        })),
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (
      error ||
      !Array.isArray(data) ||
      data.length !== sources.length ||
      data.some((value) => value !== null && typeof value !== 'string')
    )
      throw new ServiceUnavailableException('暂时无法核实业务归属');
    return data;
  }
}
