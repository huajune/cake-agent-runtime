import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RoomService } from '@channels/wecom/room/room.service';
import { GroupContext, ParsedGroupTag } from '../group-task.types';

/** 小组级群列表 API 返回的标签项 */
interface RoomLabel {
  id: string;
  name: string;
}

/** 小组级群列表 API 返回的群项 */
interface SimpleRoomItem {
  wxid: string;
  topic: string;
  chatId: string;
  botInfo: { wxid: string; nickName: string };
  labels?: RoomLabel[];
  deleted?: boolean;
  memberCount?: number;
}

/** 小组名称 → token 映射（硬编码） */
const GROUP_TOKEN_MAP: Record<string, string> = {
  艾酱: '691d3b1c77279273a79275f5',
  宇航: '69241d742f26ed67f01f8f2d',
  南瓜: '69c4c344299b6af7d2cdf02e',
  琪琪: '68f88a31d53018ed04950739',
};

/**
 * 群解析服务
 *
 * 通过小组级 API（/stream-api/room/simpleList）获取群列表，
 * 从 labels 字段解析群标签（群类型、城市、行业），按类型筛选目标群。
 *
 * 遍历所有小组 token，合并去重。群列表带 10 分钟内存缓存。
 */
@Injectable()
export class GroupResolverService implements OnModuleInit {
  private readonly logger = new Logger(GroupResolverService.name);

  /** 群列表缓存 */
  private cachedGroups: GroupContext[] = [];
  private cacheExpiry = 0;
  private readonly cacheTtlMs = 10 * 60 * 1000; // 10 分钟

  constructor(private readonly roomService: RoomService) {}

  async onModuleInit(): Promise<void> {
    const names = Object.keys(GROUP_TOKEN_MAP).join('、');
    this.logger.log(`✅ 群解析服务已启动 (小组: ${names})`);
  }

  /**
   * 从 labels 数组解析群标签
   *
   * labels 结构: [{ name: '抢单群' }, { name: '武汉' }]
   * 或: [{ name: '兼职群' }, { name: '上海' }, { name: '餐饮' }]
   *
   * 规则：第一个标签 = 群类型，第二个 = 城市，第三个 = 行业（可选）
   */
  parseLabels(labels: RoomLabel[]): ParsedGroupTag | null {
    if (!labels || labels.length < 2) return null;

    const names = labels.map((l) => l.name);
    const type = names[0]; // 抢单群 | 兼职群 | 店长群

    // 校验群类型
    const validTypes = ['抢单群', '兼职群', '店长群'];
    if (!validTypes.includes(type)) return null;

    return {
      type,
      city: names[1],
      industry: names[2],
    };
  }

  /**
   * 获取指定类型的目标群列表
   *
   * @param tagPrefix 群类型标签，如 '抢单群'、'兼职群'、'店长群'
   */
  async resolveGroups(tagPrefix: string): Promise<GroupContext[]> {
    const allGroups = await this.fetchAllGroups();
    return allGroups.filter((g) => g.tag === tagPrefix);
  }

  /**
   * 获取全量已标记群列表（带缓存）
   *
   * 遍历所有小组 token，合并去重（按 imRoomId）。
   */
  private async fetchAllGroups(): Promise<GroupContext[]> {
    if (this.cachedGroups.length > 0 && Date.now() < this.cacheExpiry) {
      return this.cachedGroups;
    }

    const tokens = Object.values(GROUP_TOKEN_MAP);
    if (tokens.length === 0) {
      this.logger.error('GROUP_TOKEN_MAP 为空');
      return [];
    }

    const seen = new Map<string, GroupContext>();
    const names = Object.keys(GROUP_TOKEN_MAP);

    for (let i = 0; i < tokens.length; i++) {
      try {
        await this.fetchGroupsFromToken(tokens[i], seen);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`小组 [${names[i]}] 获取群列表失败: ${message}`);
      }
    }

    this.cachedGroups = [...seen.values()];
    this.cacheExpiry = Date.now() + this.cacheTtlMs;

    this.logger.log(`群列表已刷新: ${this.cachedGroups.length} 个已标记群`);
    return this.cachedGroups;
  }

  /**
   * 从单个小组 token 获取群列表，分页拉取全量
   */
  private async fetchGroupsFromToken(
    token: string,
    seen: Map<string, GroupContext>,
  ): Promise<void> {
    let current = 0;
    const pageSize = 100; // API 单页最大 100
    let hasMore = true;

    while (hasMore) {
      const result = await this.roomService.getRoomSimpleList(token, current, pageSize);

      // RoomService 返回 { code, data: [...], page: {...} }
      const responseData = result?.data || result;
      const rooms: SimpleRoomItem[] = responseData?.data || responseData || [];
      if (!Array.isArray(rooms) || rooms.length === 0) break;

      for (const room of rooms) {
        // 跳过已删除的群
        if (room.deleted) continue;

        // 跳过已处理的群（按 wxid 去重）
        if (seen.has(room.wxid)) continue;

        // 解析标签
        const parsed = this.parseLabels(room.labels || []);
        if (!parsed) continue;

        seen.set(room.wxid, {
          imRoomId: room.wxid,
          groupName: room.topic || '',
          city: parsed.city,
          industry: parsed.industry,
          tag: parsed.type,
          imBotId: room.botInfo?.wxid || '',
          token,
          chatId: room.chatId || '',
        });
      }

      // 分页判断
      const page = responseData?.page || result?.page;
      const total = page?.total || 0;
      current++;
      hasMore = rooms.length >= pageSize && current * pageSize < total;
    }
  }

  /**
   * 清除缓存（用于手动刷新）
   */
  clearCache(): void {
    this.cachedGroups = [];
    this.cacheExpiry = 0;
  }
}
