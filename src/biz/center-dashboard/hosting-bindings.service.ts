import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CRON_JOB } from '@infra/queue/cron.constants';
import { CronRunnerService } from '@infra/queue/cron-runner.service';
import {
  BOT_ACCOUNT_PROVIDER,
  type BotAccountProvider,
} from '@biz/ops-events/providers/bot-account.provider';
import {
  GROUP_DIRECTORY_PROVIDER,
  type GroupDirectoryProvider,
} from '@biz/ops-events/providers/group-directory.provider';
import type { HostingGroupSelection } from '@/types/hosting-binding';
import { HostingBindingsRepository } from './hosting-bindings.repository';
import { CenterScopeService } from './center-scope.service';

@Injectable()
export class HostingBindingsService {
  private readonly logger = new Logger(HostingBindingsService.name);
  private syncing?: Promise<number>;
  constructor(
    private readonly repository: HostingBindingsRepository,
    @Inject(GROUP_DIRECTORY_PROVIDER) private readonly groups: GroupDirectoryProvider,
    @Inject(BOT_ACCOUNT_PROVIDER) private readonly bots: BotAccountProvider,
    private readonly scopes: CenterScopeService,
    private readonly cron: CronRunnerService,
    private readonly config: ConfigService,
  ) {}

  @Cron('23 */5 * * * *', { timeZone: 'Asia/Shanghai' })
  async scheduledSync() {
    if (this.config.get<string>('NODE_ENV') !== 'production') return;
    await this.cron.run(
      CRON_JOB.HOSTING_DIRECTORY_SYNC,
      { timeMs: 90_000, maxRows: 12_300 },
      async (budget) => {
        await budget.checkpoint();
        budget.recordProcessed(await this.repository.call<number>('reconcile_hosting_handover'));
        await budget.checkpoint();
        budget.recordProcessed(await this.repository.call<number>('reconcile_business_handover'));
        await budget.checkpoint();
        budget.recordProcessed(await this.sync());
      },
    );
  }

  sync(): Promise<number> {
    this.assertWritable();
    return (this.syncing ??= this.readAndSync().finally(() => {
      this.syncing = undefined;
    }));
  }

  async bind(memberId: string, tenant: string, binding: HostingGroupSelection, actor: string) {
    await this.sync();
    await this.repository.call('bind_dashboard_hosting_group', {
      p_member_id: memberId,
      p_tenant: tenant,
      p_group_id: binding.groupId,
      p_previous_group: binding.previousGroupId,
      p_previous_owner: binding.previousOwnerId,
      p_actor: actor,
    });
    this.scopes.invalidate();
  }

  async confirm(id: string, target: string | null, effectiveAt: string, actor: string) {
    await this.sync();
    await this.repository.call('confirm_hosting_handover', {
      p_id: id,
      p_target_group: target,
      p_effective_at: effectiveAt,
      p_actor: actor,
    });
    this.scopes.invalidate();
    // Confirmation is durable. The scheduled worker resumes from its cursor if this first batch fails.
    try {
      await this.repository.call('reconcile_hosting_handover');
      await this.repository.call('reconcile_business_handover');
    } catch {
      this.logger.warn('托管号交接已确认，业务归属核对将在下次同步时重试');
    }
  }

  private assertWritable() {
    if (this.config.get<string>('READ_ONLY_PREVIEW') === 'true')
      throw new ConflictException('此预览环境为只读');
  }

  private async readAndSync(): Promise<number> {
    const startedAt = new Date().toISOString();
    const deadline = AbortSignal.timeout(60_000);
    const [groups, bots] = await Promise.all([
      this.groups.getAllGroups(deadline),
      this.bots.getConfiguredBotList(true, deadline),
    ]).catch(() => {
      throw new ServiceUnavailableException('Stride 目录读取失败，请稍后重新同步');
    });
    if (groups.length > 2000 || bots.length > 10000 || Date.now() - Date.parse(startedAt) > 90_000)
      throw new ServiceUnavailableException('本轮 Stride 目录超出同步范围，请重新核对');
    await this.repository.call('sync_hosting_directory', {
      p_started_at: startedAt,
      p_groups: groups.map(({ id, name }) => ({ id, name })),
      p_bots: bots.map((bot) => ({
        id: bot.wxid?.trim(),
        group_id: bot.groupId,
        name: bot.name || bot.wxid,
      })),
    });
    this.scopes.invalidate();
    return groups.length + bots.length;
  }
}
