import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

export interface BotAccount {
  id?: string;
  wxid?: string;
  weixin?: string;
  nickName?: string;
  avatar?: string;
  online?: boolean;
  corpName?: string;
  aiStatus?: number;
  groupName?: string;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 获取托管账号列表
   */
  async getBotList(token: string) {
    try {
      const apiUrl = this.apiConfig.endpoints.bot.list();
      const params = { token };
      const result = await this.httpService.get(apiUrl, params);
      this.logger.log('获取托管账号列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取托管账号列表失败:', error);
      throw error;
    }
  }

  /**
   * 获取当前系统已配置小组 token 下的托管账号列表。
   * 前端不需要也不应该传小组 token，因此这里统一从 GROUP_TASK_TOKENS 读取。
   */
  async getConfiguredBotList(): Promise<BotAccount[]> {
    const tokenConfigs = this.parseGroupTaskTokens();
    if (tokenConfigs.length === 0) {
      this.logger.warn('GROUP_TASK_TOKENS 未配置，无法获取托管账号列表');
      return [];
    }

    const settledResults = await Promise.allSettled(
      tokenConfigs.map(async ({ groupName, token }) => {
        const response = await this.getBotList(token);
        return this.extractBotAccounts(response).map((bot) => ({
          ...bot,
          groupName,
        }));
      }),
    );

    const bots = new Map<string, BotAccount>();

    settledResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `获取小组 [${tokenConfigs[index]?.groupName || '未知'}] 托管账号失败: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
        return;
      }

      for (const bot of result.value) {
        const key = bot.wxid || bot.id || bot.weixin || bot.nickName;
        if (!key) continue;
        bots.set(key, { ...bots.get(key), ...bot });
      }
    });

    return Array.from(bots.values()).sort((a, b) => {
      if (a.online !== b.online) {
        return a.online ? -1 : 1;
      }
      return (a.nickName || a.weixin || a.wxid || '').localeCompare(
        b.nickName || b.weixin || b.wxid || '',
        'zh-Hans-CN',
        { numeric: true, sensitivity: 'base' },
      );
    });
  }

  private parseGroupTaskTokens(): Array<{ groupName: string; token: string }> {
    const raw = this.configService.get<string>('GROUP_TASK_TOKENS', '').trim();
    if (!raw) return [];

    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separatorIndex = item.indexOf(':');
        if (separatorIndex === -1) {
          return { groupName: item, token: item };
        }

        return {
          groupName: item.slice(0, separatorIndex).trim(),
          token: item.slice(separatorIndex + 1).trim(),
        };
      })
      .filter((item) => item.token);
  }

  private extractBotAccounts(response: unknown): BotAccount[] {
    let current = response;
    while (current && typeof current === 'object' && 'data' in current) {
      current = (current as { data: unknown }).data;
    }

    if (!Array.isArray(current)) {
      return [];
    }

    return current.filter((item): item is BotAccount => item !== null && typeof item === 'object');
  }
}
