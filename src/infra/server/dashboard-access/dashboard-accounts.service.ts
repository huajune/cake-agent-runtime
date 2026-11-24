import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthError, SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  DASHBOARD_ACCOUNT_PAGE_SIZE,
  DashboardAccount,
  DashboardAccountPage,
  Tenant,
  TenantAccountPage,
  TenantRole,
  isConfirmedDashboardAdminUser,
  isDashboardAdministrator,
} from '@/types/dashboard-account';

import type { HostingGroupSelection } from '@/types/hosting-binding';

const ACCOUNT_COLUMNS =
  'memberId:id,userId:user_id,loginName:login_name,name,organization,tenantRole:tenant_role,tenant:tenants!dashboard_accounts_tenant_fk!inner(name,readsAllTenants:reads_all_tenants),phone,disabled,hostingGroupId:hosting_group_id';
const TABLE = 'dashboard_accounts';

@Injectable()
export class DashboardAccountsService {
  private readonly logger = new Logger(DashboardAccountsService.name);
  constructor(private readonly supabase: SupabaseService) {}

  private get client(): SupabaseClient {
    const client = this.supabase.getSupabaseClient();
    if (!client) throw new ServiceUnavailableException('后台账号服务暂不可用');
    return client;
  }

  async identify(token: string): Promise<DashboardAccount> {
    const { data, error } = await this.client.auth.getUser(token);
    if (error && (!error.status || error.status >= 500 || error.status === 429))
      throw new ServiceUnavailableException('暂时无法验证登录状态');
    const user = data.user;
    if (error || !user) throw new UnauthorizedException('请重新登录');
    const account = await this.find('user_id', user.id);
    if (
      !account ||
      !account.tenant?.name ||
      account.disabled ||
      !(isDashboardAdministrator(account)
        ? isConfirmedDashboardAdminUser(user)
        : !account.loginName &&
          user.phone &&
          user.phone_confirmed_at &&
          account.phone === '+' + user.phone.replace(/^\+/, ''))
    ) {
      throw new ForbiddenException({
        code: 'DASHBOARD_ACCOUNT_INACTIVE',
        message: '该账号尚未开通或已停用，请联系总部',
      });
    }
    return account;
  }

  async listTenants(page: number): Promise<TenantAccountPage> {
    const offset = (page - 1) * DASHBOARD_ACCOUNT_PAGE_SIZE;
    const { data, error, count } = await this.client
      .from('tenants')
      .select('id,name,members:dashboard_accounts!dashboard_accounts_tenant_fk(count)', {
        count: 'exact',
      })
      .order('created_at')
      .order('id')
      .range(offset, offset + DASHBOARD_ACCOUNT_PAGE_SIZE - 1)
      .returns<Array<Tenant & { members: [{ count: number }] }>>();
    if (error) throw new ServiceUnavailableException('暂时无法读取组织名单');
    return {
      tenants: data.map(({ id, name, members }) => ({ id, name, accountCount: members[0].count })),
      total: count ?? 0,
    };
  }

  async list(page: number, organization?: string): Promise<DashboardAccountPage> {
    const offset = (page - 1) * DASHBOARD_ACCOUNT_PAGE_SIZE;
    const query = this.client.from(TABLE).select(ACCOUNT_COLUMNS, { count: 'exact' });
    if (organization !== undefined) query.eq('organization', organization);
    const { data, error, count } = await query
      .order('organization')
      .order('name')
      .order('phone')
      .order('id')
      .range(offset, offset + DASHBOARD_ACCOUNT_PAGE_SIZE - 1)
      .returns<DashboardAccount[]>();
    if (error) throw new ServiceUnavailableException('暂时无法读取账号名单');
    return { accounts: data, total: count ?? 0 };
  }

  async registerTenant(name: string, actor: string): Promise<Tenant> {
    const { data, error } = await this.client
      .from('tenants')
      .insert({ name })
      .select('id,name')
      .single<Tenant>();
    if (error) throw new ServiceUnavailableException('暂时无法登记组织');
    this.logger.log(`登记组织 actor=${actor} organization=${data.id}`);
    return data;
  }

  async create(
    input: {
      name: string;
      phone: string;
      organization: string;
      tenantRole?: TenantRole;
      password: string;
      memberId?: string;
      hostingBinding?: HostingGroupSelection;
    },
    actor: string,
  ): Promise<void> {
    const tenant = await this.client
      .from('tenants')
      .select('id')
      .eq('id', input.organization)
      .maybeSingle();
    if (tenant.error) throw new ServiceUnavailableException('暂时无法核对组织');
    if (!tenant.data) throw new BadRequestException('组织不存在，请刷新后选择');
    const existing = input.memberId
      ? await this.find('id', input.memberId)
      : await this.find('phone', input.phone);
    if (
      input.memberId &&
      (!existing ||
        existing.name !== input.name ||
        (existing.phone && existing.phone !== input.phone))
    )
      throw new ConflictException('待开通成员资料已变化，请刷新后核对');
    if (
      existing &&
      (existing.userId || existing.disabled || existing.organization !== input.organization)
    )
      throw new ConflictException('该手机号已有账号或所属组织与待开通名单不一致');
    const hostingBinding =
      (input.tenantRole ?? existing?.tenantRole) === TenantRole.TenantAdmin
        ? undefined
        : input.hostingBinding;
    const { data, error } = await this.client.auth.admin.createUser({
      phone: input.phone,
      password: input.password,
      phone_confirm: true,
      app_metadata: {
        cake_dashboard_account: {
          name: input.name,
          organization: input.organization,
          ...(input.tenantRole && { tenant_role: input.tenantRole }),
          ...(input.memberId && { member_id: input.memberId }),
          ...(hostingBinding && { hosting_binding: { ...hostingBinding, actor } }),
        },
      },
    });
    if (error && hostingBinding && error.code === 'unexpected_failure')
      throw new ConflictException('开户未完成，请同步 Stride 并核对组织和小组负责人后重试');
    if (error) this.throwAdminError(error);
    const opened = data.user && (await this.find('user_id', data.user.id));
    if (!opened || (input.tenantRole && opened.tenantRole !== input.tenantRole))
      throw new ServiceUnavailableException('账号绑定未完成，请核对后台账号迁移');
    this.logger.log(
      `开通后台账号 actor=${actor} user=${data.user.id} organization=${input.organization}`,
    );
  }

  async resetPassword(userId: string, password: string, actor: string): Promise<void> {
    const account = await this.find('user_id', userId);
    if (!account) throw new NotFoundException('后台账号不存在');
    if (account.disabled) throw new ConflictException('账号已停用');
    const { error } = await this.client.auth.admin.updateUserById(userId, { password });
    if (error) this.throwAdminError(error);
    this.logger.log(`重置后台密码 actor=${actor} user=${userId}`);
  }

  async update(
    userId: string,
    changes: { organization: string } | { disabled: true },
    actor: string,
  ): Promise<void> {
    if (userId === actor) throw new ConflictException('管理员账号固定归属总部并保持启用');
    if ('disabled' in changes) {
      const account = await this.find('user_id', userId);
      if (!account) throw new NotFoundException('后台账号不存在');
      if (account.disabled) return;
      // GoTrue and the account-status trigger commit the ban in one database transaction.
      const { error } = await this.client.auth.admin.updateUserById(userId, {
        ban_duration: '876000h',
      });
      if (error) this.throwAdminError(error);
      if (!(await this.find('user_id', userId))?.disabled)
        throw new ServiceUnavailableException('请检查后台账号停用状态同步迁移');
    } else {
      const { data, error } = await this.client
        .from(TABLE)
        .update(changes)
        .eq('user_id', userId)
        .eq('disabled', false)
        .select('user_id')
        .maybeSingle();
      if (error?.code === '23503') throw new BadRequestException('组织不存在，请刷新后选择');
      if (error) throw new ServiceUnavailableException('暂时无法调整所属组织');
      if (!data) throw new NotFoundException('找不到已启用的后台账号');
    }
    this.logger.log(
      `更新后台账号 actor=${actor} user=${userId} action=${'disabled' in changes ? 'disable' : changes.organization}`,
    );
  }

  private async find(
    column: 'id' | 'user_id' | 'phone',
    value: string,
  ): Promise<DashboardAccount | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(ACCOUNT_COLUMNS)
      .eq(column, value)
      .maybeSingle<DashboardAccount>();
    if (error) throw new ServiceUnavailableException('暂时无法确认后台账号权限');
    return data;
  }

  private throwAdminError(error: AuthError): never {
    if (['user_already_exists', 'phone_exists'].includes(error.code) || error.status === 409)
      throw new ConflictException('该手机号已存在，请在账号列表中核对');
    if (error.code === 'weak_password' || error.code === 'same_password')
      throw new BadRequestException('请使用符合项目密码要求的新密码');
    if (error.status === 400 || error.status === 422)
      throw new BadRequestException('手机号或密码不符合认证要求');
    throw new ServiceUnavailableException('账号服务暂不可用，请刷新名单后重试');
  }
}
