import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_HENAN_GROUP_MARKER } from '@/types/hosting-group';
import {
  BOT_ACCOUNT_PROVIDER,
  type BotAccountInfo,
  type BotAccountProvider,
} from '@biz/ops-events/providers/bot-account.provider';
import {
  GROUP_DIRECTORY_PROVIDER,
  type GroupDirectoryProvider,
  type HostingGroup,
} from '@biz/ops-events/providers/group-directory.provider';
import type { DashboardCenter } from '@/types/dashboard-account';
import { HostingBindingsRepository } from './hosting-bindings.repository';

export interface CenterScope {
  groups: HostingGroup[];
  bots: BotAccountInfo[];
  botIds: string[];
}
type Directory = [HostingGroup[], BotAccountInfo[]];

@Injectable()
export class CenterScopeService {
  private cache?: { expires: number; directory: Directory };
  private loading?: Promise<Directory>;
  private generation = 0;
  readonly henanGroupMarker: string;
  constructor(
    @Inject(GROUP_DIRECTORY_PROVIDER) private readonly directory: GroupDirectoryProvider,
    @Inject(BOT_ACCOUNT_PROVIDER) private readonly accounts: BotAccountProvider,
    config: ConfigService,
    private readonly bindings: HostingBindingsRepository,
  ) {
    this.henanGroupMarker = config
      .get<string>('HENAN_GROUP_DESCRIPTION_MARKER', DEFAULT_HENAN_GROUP_MARKER)
      .trim();
    if (!this.henanGroupMarker) throw new Error('河南小组说明标记不能为空');
  }
  invalidate() {
    ++this.generation;
    this.cache = undefined;
    this.loading = undefined;
  }

  async getScope(fresh = false, organization: DashboardCenter = 'henan'): Promise<CenterScope> {
    try {
      const [groups, bots] = await this.liveDirectory(fresh);
      // A cached Stride snapshot never grants access on its own after a move.
      const bound = await this.bindings.scope(
        groups.map((g) => g.id),
        bots.flatMap((b) => (b.wxid ? [b.wxid] : [])),
      );
      const selected = groups.filter((g) => bound.groups[g.id] === organization);
      const ids = new Set(selected.map((g) => g.id));
      const owned = bots.filter(
        (b) => b.wxid && ids.has(b.groupId) && bound.bots[b.wxid] === b.groupId,
      );
      return { groups: selected, bots: owned, botIds: [...new Set(owned.map((b) => b.wxid))] };
    } catch {
      throw new ServiceUnavailableException('暂时无法确认组织小组范围，请稍后重试');
    }
  }

  private async liveDirectory(fresh: boolean): Promise<Directory> {
    if (!fresh && this.cache && this.cache.expires > Date.now()) return this.cache.directory;
    if (!fresh && this.loading) return this.loading;
    const generation = ++this.generation;
    const load = Promise.all([
      this.directory.getAllGroups(),
      this.accounts.getConfiguredBotList(true),
    ]);
    this.loading = load;
    try {
      const directory = await load;
      if (generation === this.generation) this.cache = { directory, expires: Date.now() + 300_000 };
      return directory;
    } catch (error) {
      if (generation === this.generation) this.cache = undefined;
      throw error;
    } finally {
      if (this.loading === load) this.loading = undefined;
    }
  }
}
