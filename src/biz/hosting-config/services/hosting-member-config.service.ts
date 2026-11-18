import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { normalizeBotImId } from '@biz/ops-events/services/bot-group-resolver.service';
import { type FeishuReceiver } from '@infra/feishu/interfaces/receiver.interface';
import { HostingMemberConfigRepository } from '../repositories/hosting-member-config.repository';
import { HostingMemberConfig, HostingMemberEntry } from '../types/hosting-member-config.types';

/**
 * 托管成员统一配置解析（飞书接收人 + 海绵 token），按 botImId 索引。
 *
 * 用稳定的 botImId 而非可改名的 wecomUserId 索引，飞书接收人只读数据库。
 * 刷新失败时保留最后一次成功读取的配置，不回退代码名单。
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

  /** 飞书接收人：数据库为唯一来源，未绑定时由调用方处理。 */
  async resolveFeishuReceiver(
    botImId: string | null | undefined,
  ): Promise<FeishuReceiver | undefined> {
    const entry = await this.getByBotImId(botImId);
    const openId = entry?.feishuOpenId?.trim();
    if (openId) return { openId, name: entry?.feishuName?.trim() || '' };
    return undefined;
  }

  /** 群满、拉群失败和群任务汇总的固定运营接收人。 */
  async resolveOperationsReceivers(): Promise<FeishuReceiver[]> {
    const config = await this.loadConfig();
    return Array.from(
      new Map(
        (config?.operationsReceivers ?? []).map(({ openId, name }) => [
          openId.trim(),
          { openId: openId.trim(), name: name.trim() },
        ]),
      ).values(),
    );
  }

  /** 总部特殊任务类别负责人；河南仍只使用本账号的飞书身份。 */
  async resolveTaskOwners(): Promise<NonNullable<HostingMemberConfig['taskOwners']>> {
    return (await this.loadConfig())?.taskOwners ?? {};
  }

  /** 海绵 token：按 botImId 取（唯一配置源）；查不到返回 null，由调用方回退 DULIDAY_API_TOKEN。 */
  async resolveDulidayToken(botImId: string | null | undefined): Promise<string | null> {
    const entry = await this.getByBotImId(botImId);
    return entry?.dulidayToken?.trim() || null;
  }

  /**
   * 已配置海绵 token 的托管账号 botImId 全集（带外工单补偿扫描按账号遍历）。
   * 无已读取配置时返回空数组，不使用默认 token 拉其他账号的工单。
   */
  async listTokenConfiguredBotImIds(): Promise<string[]> {
    const config = await this.loadConfig();
    return Object.entries(config?.members ?? {})
      .filter(([, entry]) => Boolean(entry?.dulidayToken?.trim()))
      .map(([botImId]) => botImId);
  }

  /**
   * Agent 账号身份（企微昵称/性别）：注入 system prompt 身份段（IdentitySection），
   * 让模型确知"自己是谁"。
   *
   * 两字段均来自 hosting_member_config（wecomNickname / gender，按 botImId 配置；
   * 昵称须与托管平台「托管账号名称」即候选人所见企微昵称一致，账号改名时同步改配置）。
   * 未配置的字段返回 null，由身份段降级为"不编造、轻带过"口径。
   */
  async resolveAgentAccountIdentity(
    botImId: string | null | undefined,
  ): Promise<{ nickname: string | null; gender: string | null }> {
    const entry = await this.getByBotImId(botImId);
    return {
      nickname: entry?.wecomNickname?.trim() || null,
      gender: entry?.gender?.trim() || null,
    };
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
          `读取 hosting_member_config 失败，保留上次成功配置: ${toErrorMessage(error)}`,
        );
        this.cacheExpireAt = Date.now() + this.TTL_MS;
        return this.cache;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }
}
