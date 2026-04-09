import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  botInfo: { wxid: string; weixin: string; nickName: string };
  labels?: RoomLabel[];
  deleted?: boolean;
  memberCount?: number;
}

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

  /** 小组名称 → token 映射（从环境变量解析） */
  private readonly groupTokenMap: Record<string, string>;

  /** 群列表缓存 */
  private cachedGroups: GroupContext[] = [];
  private cacheExpiry = 0;
  private readonly cacheTtlMs = 10 * 60 * 1000; // 10 分钟
  /** 防止并发 fetch 导致缓存 stampede */
  private fetchPromise: Promise<GroupContext[]> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly roomService: RoomService,
  ) {
    // 格式: "艾酱:token1,宇航:token2,南瓜:token3"
    const raw = this.configService.get<string>('GROUP_TASK_TOKENS', '');
    this.groupTokenMap = {};
    for (const pair of raw.split(',').filter(Boolean)) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const name = pair.slice(0, colonIdx).trim();
      const token = pair.slice(colonIdx + 1).trim();
      if (name && token) this.groupTokenMap[name] = token;
    }
  }

  async onModuleInit(): Promise<void> {
    const names = Object.keys(this.groupTokenMap);
    if (names.length === 0) {
      this.logger.warn('⚠️ GROUP_TASK_TOKENS 未配置，群任务无法获取群列表');
      return;
    }
    this.logger.log(`✅ 群解析服务已启动 (小组: ${names.join('、')})`);
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
    if (!labels || labels.length === 0) return null;

    const names = labels.map((l) => l.name);
    const type = names[0]; // 抢单群 | 兼职群 | 店长群

    // 校验群类型
    const validTypes = ['抢单群', '兼职群', '店长群'];
    if (!validTypes.includes(type)) return null;

    // 店长群只需一级标签（不按城市分组），其他类型至少需要城市标签
    if (names.length < 2 && type !== '店长群') return null;

    return {
      type,
      city: names[1] || '全国',
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

    // 防止并发请求同时触发 fetch
    if (this.fetchPromise) return this.fetchPromise;
    this.fetchPromise = this.doFetchAllGroups();
    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  private async doFetchAllGroups(): Promise<GroupContext[]> {
    const tokens = Object.values(this.groupTokenMap);
    if (tokens.length === 0) {
      this.logger.error('GROUP_TASK_TOKENS 为空，无法获取群列表');
      return [];
    }

    const seen = new Map<string, GroupContext>();
    const names = Object.keys(this.groupTokenMap);

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
          memberCount: room.memberCount,
        });
      }

      // 分页判断：用 total 驱动，不依赖单页返回数量（API 可能过滤已删除记录导致实际返回数 < pageSize）
      const page = responseData?.page || result?.page;
      const total = page?.total || 0;
      current++;
      hasMore = current * pageSize < total;
    }
  }

  /**
   * 按群名搜索任意群（不要求有标签）
   *
   * 遍历所有小组 token 的群列表，按群名匹配（先精确，再模糊）。
   * 用于测试端点向指定群发送消息。
   */
  async findGroupByName(groupName: string): Promise<GroupContext | null> {
    const tokens = Object.values(this.groupTokenMap);
    const allRooms: Array<{
      token: string;
      wxid: string;
      topic: string;
      chatId: string;
      botWxid: string;
      memberCount?: number;
    }> = [];

    for (const token of tokens) {
      let current = 0;
      const pageSize = 100;
      let hasMore = true;

      while (hasMore) {
        const result = await this.roomService.getRoomSimpleList(token, current, pageSize);
        const responseData = result?.data || result;
        const rooms = responseData?.data || responseData || [];
        if (!Array.isArray(rooms) || rooms.length === 0) break;

        for (const room of rooms) {
          if (room.deleted) continue;
          allRooms.push({
            token,
            wxid: room.wxid,
            topic: room.topic || '',
            chatId: room.chatId || '',
            botWxid: room.botInfo?.wxid || '',
            memberCount: room.memberCount,
          });
        }

        const page = responseData?.page || result?.page;
        const total = page?.total || 0;
        current++;
        hasMore = current * pageSize < total;
      }
    }

    // 先精确匹配，再模糊匹配
    const match =
      allRooms.find((r) => r.topic === groupName) ||
      allRooms.find((r) => r.topic.includes(groupName));

    if (!match) return null;

    return {
      imRoomId: match.wxid,
      groupName: match.topic,
      city: '测试',
      tag: '测试',
      imBotId: match.botWxid,
      token: match.token,
      chatId: match.chatId,
      memberCount: match.memberCount,
    };
  }

  /**
   * 清除缓存（用于手动刷新）
   */
  clearCache(): void {
    this.cachedGroups = [];
    this.cacheExpiry = 0;
  }
}
