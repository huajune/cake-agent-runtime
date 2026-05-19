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

export async function refreshMemberCountsFromEnterpriseList(params: {
  groups: GroupContext[];
  roomService: Pick<RoomService, 'getEnterpriseGroupChatList'>;
  enterpriseToken: string;
  maxPages?: number;
}): Promise<GroupContext[]> {
  if (params.groups.length === 0) return params.groups;

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
  // 企微不同接口/版本的群人数命名不一致，按已见字段逐个探测。
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
