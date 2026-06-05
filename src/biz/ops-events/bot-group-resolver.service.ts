import { Injectable, Logger, Optional } from '@nestjs/common';
import { BotService } from '@channels/wecom/bot/bot.service';

export interface BotGroupInfo {
  managerName: string;
  groupName: string;
}

/**
 * bot（imBotId）→ 招聘经理 + 小组 兜底映射。
 *
 * 正常情况下 resolve() 走「从第三方托管平台（Stride）动态拉取」的映射（见 refreshGroupMap），
 * 本表仅作**离线兜底**：Stride 不可用或冷启动尚未拉到时用，保证盘子不崩。
 * 无需再手工维护——新增 / 改名 / 加 bot 由 Stride 自动带出。
 */
const BOT_GROUP_TABLE: Record<string, BotGroupInfo> = {
  '1688855974513959': { managerName: 'gaoyaqi', groupName: '琪琪组' },
  '1688854363869800': { managerName: 'ZhuDongSheng', groupName: '小祝组' },
  '1688857592548257': { managerName: 'HeMin', groupName: '小祝组' },
  '1688854359801821': { managerName: 'LiHanTing', groupName: '南瓜组' },
  '1688855171908166': { managerName: 'LiYuHang', groupName: '宇航组' },
  '1688854747775509': { managerName: 'WuPanPan', groupName: '盼盼组' },
};

/** name-based bot 兜底别名（同步前缀由 normalizeBotImId 归一化后再查）。 */
const BOT_GROUP_ALIASES: Record<string, BotGroupInfo> = {
  CongLingKaiShiDeXianShiShiJie: {
    managerName: 'CongLingKaiShiDeXianShiShiJie',
    groupName: '宇航组',
  },
  guoxiaoyang: {
    managerName: '郭晓阳',
    groupName: '晓阳组',
  },
};

/**
 * 合成 / 测试 bot：天然无小组，解析为 null 属预期，不告警（避免无意义噪声）。
 */
const KNOWN_UNGROUPED_BOTS = new Set(['unknown-bot', 'agent-test-bot']);

/**
 * 花卷 agentId 映射：botImId → `{manager_name}-cake-{index}`。
 *
 * 这是花卷上报的命名约定（含 CongLing→LiYuHang-cake-1 特例），Stride 不提供、无法动态推导，
 * 故保持硬编码。index = 同一 manager 下 bot 按 botImId 排序的 1-based 位置。
 */
const AGENT_ID_ALIASES: Record<string, string> = {
  CongLingKaiShiDeXianShiShiJie: 'LiYuHang-cake-1',
};

const AGENT_ID_BY_BOT: Record<string, string> = (() => {
  const botsByManager = new Map<string, string[]>();
  for (const [botImId, info] of Object.entries(BOT_GROUP_TABLE)) {
    const list = botsByManager.get(info.managerName) ?? [];
    list.push(botImId);
    botsByManager.set(info.managerName, list);
  }
  const result: Record<string, string> = {};
  for (const [managerName, botImIds] of botsByManager) {
    [...botImIds].sort().forEach((botImId, index) => {
      result[botImId] = `${managerName}-cake-${index + 1}`;
    });
  }
  return result;
})();

/** 数据同步给 bot_im_id 加的前缀（prod → 测试库镜像）。 */
const SYNC_BOT_PREFIX = 'prod-sync:';

/** 归一化 bot_im_id：剥掉同步前缀并 trim，使同步形态与原始 id 落到同一张映射表。 */
export function normalizeBotImId(botImId: string): string {
  const trimmed = botImId.trim();
  return trimmed.startsWith(SYNC_BOT_PREFIX)
    ? trimmed.slice(SYNC_BOT_PREFIX.length).trim()
    : trimmed;
}

/**
 * 从 botImId 解析招聘经理 + 小组（事件埋点的 manager/group 反范式来源）。
 *
 * 数据源优先级：Stride 动态表（getGroupBots，30min 缓存，wxid 与 wecomUserId 双键索引）
 * → 硬编码兜底表。BotService 用 @Optional 注入：单测裸 new 时为空，自动只走兜底表。
 */
@Injectable()
export class BotGroupResolverService {
  private readonly logger = new Logger(BotGroupResolverService.name);
  // 每个未登记 bot 只告警一次，避免逐事件刷屏（resolver 是单例，进程级去重即可）。
  private readonly warnedUnknownBots = new Set<string>();

  // 从 Stride 拉取的动态映射（归一化 key → 组信息），30min 刷新。
  private dynamicMap = new Map<string, BotGroupInfo>();
  private dynamicMapExpireAt = 0;
  private dynamicMapLoaded = false;
  private refreshing = false;
  private readonly DYNAMIC_TTL_MS = 30 * 60 * 1000;

  constructor(@Optional() private readonly botService?: BotService) {}

  /**
   * 确保动态映射已就绪（供仪表盘等读取侧在处理前 await，保证首次请求即用动态数据）。
   * 缓存有效或无 BotService 时立即返回；过期则同步等待一次刷新。
   */
  async warmUp(): Promise<void> {
    if (!this.botService) return;
    if (this.dynamicMapExpireAt > Date.now() && this.dynamicMap.size > 0) return;
    await this.refreshGroupMap();
  }

  resolve(botImId: string | null | undefined): BotGroupInfo | null {
    if (!botImId) return null;
    const key = normalizeBotImId(botImId);
    if (!key) return null;

    this.scheduleRefreshIfStale();

    const dynamic = this.dynamicMap.get(key);
    if (dynamic) return dynamic;

    const fallback = BOT_GROUP_TABLE[key] ?? BOT_GROUP_ALIASES[key] ?? null;
    // 仅在已成功拉到 Stride 数据后仍解析不出时才告警（避免冷启动期对 Stride 已有的 bot 误报）。
    if (!fallback && this.dynamicMapLoaded) this.warnUnmappedBot(botImId, key);
    return fallback;
  }

  /** 全部已知小组名（去重）：动态表优先，回退兜底表。供需要小组枚举的场景使用。 */
  listGroups(): string[] {
    const source =
      this.dynamicMap.size > 0
        ? Array.from(this.dynamicMap.values()).map((info) => info.groupName)
        : Object.values(BOT_GROUP_TABLE).map((info) => info.groupName);
    return Array.from(new Set(source));
  }

  /** botImId → 花卷 agentId（`{manager_name}-cake-{index}`）；未知 bot 返回 null。 */
  resolveAgentId(botImId: string | null | undefined): string | null {
    if (!botImId) return null;
    const key = normalizeBotImId(botImId);
    if (!key) return null;
    return AGENT_ID_BY_BOT[key] ?? AGENT_ID_ALIASES[key] ?? null;
  }

  /** 过期则后台异步刷新（非阻塞）：当前调用先用旧/兜底数据，下次调用用新数据。 */
  private scheduleRefreshIfStale(): void {
    if (!this.botService || this.refreshing) return;
    if (this.dynamicMapExpireAt > Date.now() && this.dynamicMap.size > 0) return;
    void this.refreshGroupMap();
  }

  /** 从 Stride getGroupBots 重建 wxid/wecomUserId → 组 映射；失败保留旧映射、不抛。 */
  private async refreshGroupMap(): Promise<void> {
    if (!this.botService || this.refreshing) return;
    this.refreshing = true;
    try {
      const bots = await this.botService.getConfiguredBotList();
      const map = new Map<string, BotGroupInfo>();
      for (const bot of bots) {
        const groupName = bot.groupName?.trim();
        if (!groupName) continue;
        const info: BotGroupInfo = {
          groupName,
          managerName: (bot.name || bot.wecomUserId || bot.wxid || '').trim() || '未知账号',
        };
        // 同一 bot 的数字形态(wxid) 与 名字形态(wecomUserId) 都建索引，覆盖两种 bot_im_id 落库形态。
        for (const rawKey of [bot.wxid, bot.wecomUserId]) {
          const normalized = rawKey?.trim() ? normalizeBotImId(rawKey) : '';
          if (normalized) map.set(normalized, info);
        }
      }
      if (map.size > 0) {
        this.dynamicMap = map;
        this.dynamicMapExpireAt = Date.now() + this.DYNAMIC_TTL_MS;
        this.dynamicMapLoaded = true;
      }
    } catch (error) {
      this.logger.warn(
        `刷新动态 bot→组 映射失败，沿用兜底表: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 未登记 bot 采样告警：每个 distinct（归一化后）bot 只告警一次，提示运营在 Stride 补登小组，
   * 避免新增/换号账号静默落「未分组」而不被发现。已知的合成/测试 bot 不告警。
   */
  private warnUnmappedBot(original: string, normalized: string): void {
    if (KNOWN_UNGROUPED_BOTS.has(normalized)) return;
    if (this.warnedUnknownBots.has(normalized)) return;
    this.warnedUnknownBots.add(normalized);
    this.logger.warn(
      `bot_im_id 在 Stride 与兜底表中均无小组，请在托管平台补登：原始="${original}" 归一化="${normalized}"`,
    );
  }
}
