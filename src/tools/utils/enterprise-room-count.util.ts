import { Logger } from '@nestjs/common';
import type { RoomService } from '@channels/wecom/room/room.service';
import type { GroupContext } from '@biz/group-task/group-task.types';

const logger = new Logger('enterprise_room_count');
const DEFAULT_MAX_ENTERPRISE_GROUP_LIST_PAGES = 10;

interface EnterpriseRoomItem {
  imRoomId?: string;
  wxid?: string;
  roomWxid?: string;
  roomId?: string;
  chatId?: string;
  groupChatId?: string;
  roomWecomChatId?: string;
  wecomChatId?: string;
  memberList?: unknown[];
  members?: unknown[];
  [key: string]: unknown;
}

/**
 * 通过企业级 API 刷新群的真实成员数。
 *
 * 为什么不在 resolveGroups（小组级 simpleList）里完成？
 * - simpleList 返回的 memberCount 是小组 API 缓存值，经常严重偏低（实测 156 vs 真实 356）
 * - syncRoom 只刷新企业 API 侧的数据，不影响 simpleList 的 memberCount
 * - 因此必须：先 syncRoom → 再用企业级 groupChat/list 查，两步配合才能拿到真实人数
 *
 * 流程：
 * 1. 按 imBotId 去重，调 syncRoom 触发平台侧群成员数据同步
 * 2. 调 groupChat/list(imBotId=xxx) 批量获取同步后的 memberList.length
 * 3. 用 imRoomId/chatId 匹配回 GroupContext，覆盖 memberCount
 */
export async function refreshMemberCountsFromEnterpriseList(params: {
  groups: GroupContext[];
  roomService: Pick<RoomService, 'getEnterpriseGroupChatList' | 'syncRoom'>;
  enterpriseToken: string;
  maxPages?: number;
}): Promise<GroupContext[]> {
  if (params.groups.length === 0) return params.groups;

  // Step 1: 按 imBotId 去重，触发 syncRoom 确保企业 API 侧成员数据是最新的
  // syncRoom 只影响企业 API（groupChat/list、groupChat/detail），不影响小组 API（simpleList）
  const uniqueBotIds = [...new Set(params.groups.map((g) => g.imBotId).filter(Boolean))];
  const syncResults = await Promise.all(
    uniqueBotIds.map(async (botId) => {
      try {
        const result = await params.roomService.syncRoom(params.enterpriseToken, botId);
        const accepted = isSuccessfulSyncResult(result);
        if (!accepted) {
          logger.warn(
            `syncRoom 返回失败 (imBotId=${botId})，跳过企业级人数覆盖，避免使用过期群人数`,
          );
        }
        return { botId, accepted };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`syncRoom 失败 (imBotId=${botId})，继续使用原始人数: ${message}`);
        return { botId, accepted: false };
      }
    }),
  );
  const syncedBotIds = new Set(
    syncResults.filter((result) => result.accepted).map((result) => result.botId),
  );
  if (uniqueBotIds.length > 0 && !syncedBotIds.has(uniqueBotIds[0])) {
    logger.warn('企业级群同步未成功，跳过 groupChat/list 人数刷新，交由拉群接口做最终容量判定');
    return params.groups;
  }

  // Step 2: 调企业级 groupChat/list 批量获取同步后的真实 memberCount
  // 传 imBotId 过滤，避免同一群因多个 bot 返回多条记录导致人数被覆盖为错误值
  const groupKeyByRoomIdentifier = new Map<string, string>();
  for (const group of params.groups) {
    for (const id of [group.imRoomId, group.chatId]) {
      if (id) groupKeyByRoomIdentifier.set(id, group.imRoomId);
    }
  }
  const memberCounts = new Map<string, number>();
  const pageSize = 1000;
  const maxPages = params.maxPages ?? DEFAULT_MAX_ENTERPRISE_GROUP_LIST_PAGES;
  let current = 1;
  let hasMore = true;

  try {
    while (hasMore && memberCounts.size < params.groups.length && current <= maxPages) {
      const result = await params.roomService.getEnterpriseGroupChatList(
        params.enterpriseToken,
        current,
        pageSize,
        uniqueBotIds[0],
      );
      const rooms = extractEnterpriseRooms(result);
      if (rooms.length === 0) break;

      for (const room of rooms) {
        const groupKey = extractEnterpriseRoomIds(room)
          .map((roomId) => groupKeyByRoomIdentifier.get(roomId))
          .find((matched): matched is string => Boolean(matched));
        if (!groupKey) continue;

        const memberCount = extractMemberCount(room);
        if (memberCount !== undefined) memberCounts.set(groupKey, memberCount);
      }

      hasMore = rooms.length >= pageSize;
      current++;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`刷新企业级群人数失败，使用缓存人数继续: ${message}`);
    return params.groups;
  }

  if (memberCounts.size === 0) return params.groups;

  return params.groups.map((group) => {
    const freshCount = memberCounts.get(group.imRoomId);
    if (freshCount === undefined) return group;
    return { ...group, memberCount: freshCount };
  });
}

export function extractEnterpriseRooms(result: unknown): EnterpriseRoomItem[] {
  if (Array.isArray(result)) return result.filter(isEnterpriseRoomItem);
  if (!result || typeof result !== 'object') return [];

  const record = result as Record<string, unknown>;
  const data = record.data;
  if (Array.isArray(data)) return data.filter(isEnterpriseRoomItem);

  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>;
    for (const key of ['data', 'list', 'records', 'rows']) {
      const value = nested[key];
      if (Array.isArray(value)) return value.filter(isEnterpriseRoomItem);
    }
  }

  for (const key of ['list', 'records', 'rows']) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter(isEnterpriseRoomItem);
  }

  return [];
}

function isEnterpriseRoomItem(value: unknown): value is EnterpriseRoomItem {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function extractEnterpriseRoomId(room: EnterpriseRoomItem): string | undefined {
  return extractEnterpriseRoomIds(room)[0];
}

export function extractEnterpriseRoomIds(room: EnterpriseRoomItem): string[] {
  const ids: string[] = [];
  for (const key of [
    'imRoomId',
    'wxid',
    'roomWxid',
    'roomId',
    'chatId',
    'groupChatId',
    'roomWecomChatId',
    'wecomChatId',
  ]) {
    const value = room[key];
    if (typeof value === 'string' && value.trim()) ids.push(value.trim());
  }
  return Array.from(new Set(ids));
}

export function extractMemberCount(room: EnterpriseRoomItem): number | undefined {
  for (const key of [
    'memberCount',
    'member_count',
    'memberNum',
    'member_num',
    'memberCnt',
    'member_cnt',
    'membersCount',
    'memberTotal',
    'totalMember',
    'roomMemberCount',
  ]) {
    const parsed = parseCount(room[key]);
    if (parsed !== undefined) return parsed;
  }

  if (Array.isArray(room.memberList)) return room.memberList.length;
  if (Array.isArray(room.members)) return room.members.length;

  return undefined;
}

export function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isSuccessfulSyncResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return true;

  const record = result as Record<string, unknown>;
  const errcode = parseCount(record.errcode);
  if (errcode !== undefined) return errcode === 0;

  const code = parseCount(record.code);
  if (code !== undefined) return code === 0;

  if (record.success === false) return false;
  return true;
}
