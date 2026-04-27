import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

export interface BotAccount {
  id?: string;
  wxid?: string;
  weixin?: string;
  wecomUserId?: string;
  name?: string;
  nickName?: string;
  avatar?: string;
  online?: boolean;
  status?: number;
  corpName?: string;
  corpId?: string;
  aiStatus?: number;
  aiBotId?: string;
  groupId?: string;
  groupName?: string;
  groupAiBotId?: string;
}

interface GroupBotAccount {
  id?: string;
  wxid?: string;
  wecomUserId?: string;
  status?: number;
  name?: string;
  avatar?: string;
  corpId?: string;
  aiStatus?: number;
  aiBotId?: string;
  corpName?: string;
}

interface GroupBotsResponse {
  errcode?: number;
  errmsg?: string;
  groups?: Array<{
    id?: string;
    name?: string;
    groupAiBotId?: string;
    bots?: GroupBotAccount[];
  }>;
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
   * 获取企业内各小组托管账号信息。
   * 使用企业级接口统一读取托管开关同源的小组账号，不依赖 GROUP_TASK_TOKENS。
   */
  async getConfiguredBotList(): Promise<BotAccount[]> {
    const token = this.configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim();
    if (!token) {
      this.logger.warn('STRIDE_ENTERPRISE_TOKEN 未配置，无法获取企业托管账号列表');
      return [];
    }

    try {
      const apiUrl = this.apiConfig.endpoints.bot.groupBots();
      const response = (await this.httpService.get(apiUrl, { token })) as GroupBotsResponse;
      const bots = new Map<string, BotAccount>();

      for (const group of this.extractGroups(response)) {
        for (const bot of group.bots || []) {
          const key = bot.wxid || bot.id || bot.wecomUserId || bot.name;
          if (!key) continue;

          bots.set(key, {
            ...bots.get(key),
            id: bot.id,
            wxid: bot.wxid,
            weixin: bot.wecomUserId,
            wecomUserId: bot.wecomUserId,
            name: bot.name,
            nickName: bot.name,
            avatar: bot.avatar,
            status: bot.status,
            corpId: bot.corpId,
            corpName: bot.corpName,
            aiStatus: bot.aiStatus,
            aiBotId: bot.aiBotId,
            groupId: group.id,
            groupName: group.name,
            groupAiBotId: group.groupAiBotId,
          });
        }
      }

      this.logger.log(`获取企业托管账号列表成功: ${bots.size} 个账号`);
      return Array.from(bots.values()).sort((a, b) =>
        (a.nickName || a.weixin || a.wxid || '').localeCompare(
          b.nickName || b.weixin || b.wxid || '',
          'zh-Hans-CN',
          { numeric: true, sensitivity: 'base' },
        ),
      );
    } catch (error) {
      this.logger.error('获取企业托管账号列表失败:', error);
      throw error;
    }
  }

  private extractGroups(response: unknown): NonNullable<GroupBotsResponse['groups']> {
    let current = response;
    while (current && typeof current === 'object' && 'data' in current) {
      current = (current as { data: unknown }).data;
    }

    const groups =
      current && typeof current === 'object' && 'groups' in current
        ? (current as GroupBotsResponse).groups
        : undefined;

    if (!Array.isArray(groups)) {
      return [];
    }

    return groups.filter((group) => group !== null && typeof group === 'object');
  }
}
