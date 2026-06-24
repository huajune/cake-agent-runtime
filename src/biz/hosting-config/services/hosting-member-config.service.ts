import { Injectable, Logger } from '@nestjs/common';
import { normalizeBotImId } from '@biz/ops-events/bot-group-resolver.service';
import { BOT_TO_RECEIVER, type FeishuReceiver } from '@infra/feishu/constants/receivers';
import { HostingMemberConfigRepository } from '../repositories/hosting-member-config.repository';
import { HostingMemberConfig, HostingMemberEntry } from '../types/hosting-member-config.types';

/**
 * 托管成员统一配置解析（飞书接收人 + 海绵 token），按 botImId 索引。
 *
 * 用 botImId（wecom 系统分配的稳定数字 id，与硬编码 BOT_TO_RECEIVER 同 key）而非 wecomUserId
 * （可改的名字）。直接 config[botImId] 命中，无需绕 Stride 查经理。
 * 全程带硬编码/旧配置兜底：DB 未填时行为与原先一致（线上零中断）。
 *
 * @Global 注入：飞书 notifier、海绵 service 等可直接注入，无需各自 import 模块，避免 DI 环。
 */
@Injectable()
export class HostingMemberConfigService {
  private readonly logger = new Logger(HostingMemberConfigService.name);

  private cache: HostingMemberConfig | null = null;
  private cacheExpireAt = 0;
  private loadPromise: Promise<HostingMemberConfig | null> | null = null;
  // 配置可在线/web 改，TTL 取短（5min），改完很快生效。
  private readonly TTL_MS = 5 * 60 * 1000;

  constructor(private readonly repository: HostingMemberConfigRepository) {}

  /** 按 botImId（归一化去同步前缀）取配置项。 */
  async getByBotImId(botImId: string | null | undefined): Promise<HostingMemberEntry | null> {
    if (!botImId) return null;
    const key = normalizeBotImId(botImId);
    if (!key) return null;
    const config = await this.loadConfig();
    return config?.members?.[key] ?? null;
  }

  /** 飞书接收人：DB 配置优先，回退硬编码 BOT_TO_RECEIVER。 */
  async resolveFeishuReceiver(
    botImId: string | null | undefined,
  ): Promise<FeishuReceiver | undefined> {
    const entry = await this.getByBotImId(botImId);
    const openId = entry?.feishuOpenId?.trim();
    if (openId) return { openId, name: entry?.feishuName?.trim() || '' };
    return botImId ? BOT_TO_RECEIVER[botImId] : undefined;
  }

  /** 海绵 token：按 botImId 取（唯一配置源）；查不到返回 null，由调用方回退 DULIDAY_API_TOKEN。 */
  async resolveDulidayToken(botImId: string | null | undefined): Promise<string | null> {
    const entry = await this.getByBotImId(botImId);
    return entry?.dulidayToken?.trim() || null;
  }

  private async loadConfig(): Promise<HostingMemberConfig | null> {
    if (Date.now() < this.cacheExpireAt) return this.cache;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const config = await this.repository.readConfig();
        this.cache = config;
        this.cacheExpireAt = Date.now() + this.TTL_MS;
        return config;
      } catch (error) {
        this.logger.warn(
          `读取 hosting_member_config 失败，回退硬编码/旧配置: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.cache = null;
        this.cacheExpireAt = Date.now() + this.TTL_MS;
        return null;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }
}
