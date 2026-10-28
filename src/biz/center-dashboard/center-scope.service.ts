import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BOT_ACCOUNT_PROVIDER,
  BotAccountInfo,
  BotAccountProvider,
} from '@biz/ops-events/providers/bot-account.provider';
import {
  GROUP_DIRECTORY_PROVIDER,
  GroupDirectoryProvider,
  HostingGroup,
} from '@biz/ops-events/providers/group-directory.provider';

export interface CenterScope {
  groups: HostingGroup[];
  bots: BotAccountInfo[];
  botIds: string[];
}

@Injectable()
export class CenterScopeService {
  private cache?: { expires: number; scope: CenterScope };
  private loading?: Promise<CenterScope>;
  private generation = 0;
  private readonly marker: string;
  constructor(
    @Inject(GROUP_DIRECTORY_PROVIDER) private readonly directory: GroupDirectoryProvider,
    @Inject(BOT_ACCOUNT_PROVIDER) private readonly accounts: BotAccountProvider,
    config: ConfigService,
  ) {
    this.marker = config.get<string>('HENAN_GROUP_DESCRIPTION_MARKER', '河南自招团队成员').trim();
    if (!this.marker) throw new Error('河南小组说明标记不能为空');
  }

  async getScope(fresh = false): Promise<CenterScope> {
    if (!fresh && this.cache && this.cache.expires > Date.now()) return this.cache.scope;
    if (!fresh && this.loading) return this.loading;
    const generation = ++this.generation;
    const load = this.load()
      .then((scope) => {
        if (generation === this.generation)
          this.cache = { scope, expires: Date.now() + 5 * 60_000 };
        return scope;
      })
      .catch(() => {
        if (generation === this.generation) this.cache = undefined;
        throw new ServiceUnavailableException('暂时无法确认河南小组范围，请稍后重试');
      });
    if (fresh) return load;
    this.loading = load;
    try {
      return await load;
    } finally {
      this.loading = undefined;
    }
  }

  private async load(): Promise<CenterScope> {
    const [groups, bots] = await Promise.all([
      this.directory.getAllGroups(),
      this.accounts.getConfiguredBotList(true),
    ]);
    // 固定文案独占一行，避免“非河南自招团队成员”等自然语言误授予权限。
    const selected = groups.filter(
      (group) =>
        typeof group.description === 'string' &&
        group.description.split(/\r?\n/).some((line) => line.trim() === this.marker),
    );
    const ids = new Set(selected.map((group) => group.id));
    const owned = bots.filter((bot) => ids.has(bot.groupId));
    return {
      groups: selected,
      bots: owned,
      botIds: [...new Set(owned.map((bot) => bot.wxid?.trim()).filter(Boolean))],
    };
  }
}
