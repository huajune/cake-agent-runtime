import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { STRIDE_PRIMARY_CONNECTION } from '@/types/hosting-route';
import type { HostingManagementDirectory, HostingScopeBindings } from '@/types/hosting-binding';

@Injectable()
export class HostingBindingsRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async call<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.supabase.getSupabaseClient();
    if (!client) throw new ServiceUnavailableException('托管归属服务暂不可用');
    const { data, error } = await client
      .rpc(name, { p_connection_id: STRIDE_PRIMARY_CONNECTION, ...params })
      .abortSignal(AbortSignal.timeout(12_000));
    if (error?.code === '42501') throw new ForbiddenException('此操作需要管理员权限');
    if (error && ['23514', '22023'].includes(error.code))
      throw new ConflictException(error.message);
    if (error) throw new ServiceUnavailableException('暂时无法核实托管归属，请稍后重试');
    return data as T;
  }

  directory() {
    return this.call<HostingManagementDirectory>('hosting_management_directory');
  }

  scope(groupIds: string[], botIds: string[]) {
    return this.call<HostingScopeBindings>('hosting_scope_bindings', {
      p_groups: groupIds,
      p_bots: botIds,
    });
  }
}
