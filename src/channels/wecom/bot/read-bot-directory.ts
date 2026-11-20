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

export interface GroupBotsResponse {
  errcode?: number;
  errmsg?: string;
  groups?: Array<{
    id?: string;
    name?: string;
    groupAiBotId?: string;
    bots?: GroupBotAccount[];
  }>;
}

export function readBotDirectory(
  response: unknown,
  strict = false,
): NonNullable<GroupBotsResponse['groups']> {
  let current = response;
  while (current && typeof current === 'object' && 'data' in current) {
    if (strict && 'errcode' in current && current.errcode !== 0)
      throw new Error('托管账号目录读取失败');
    current = (current as { data: unknown }).data;
  }

  if (
    strict &&
    current &&
    typeof current === 'object' &&
    'errcode' in current &&
    current.errcode !== 0
  )
    throw new Error('托管账号目录读取失败');

  const groups =
    current && typeof current === 'object' && 'groups' in current
      ? (current as GroupBotsResponse).groups
      : undefined;

  if (!Array.isArray(groups)) {
    if (strict) throw new Error('托管账号目录格式无效');
    return [];
  }

  if (strict) {
    const seen = new Set<string>();
    const groupIds = new Set<string>();
    for (const group of groups) {
      if (
        !group ||
        typeof group.id !== 'string' ||
        !group.id.trim() ||
        groupIds.has(group.id) ||
        !Array.isArray(group.bots)
      )
        throw new Error('托管账号目录缺少小组范围');
      groupIds.add(group.id);
      for (const bot of group.bots) {
        if (!bot || typeof bot.wxid !== 'string' || !bot.wxid.trim() || seen.has(bot.wxid.trim()))
          throw new Error('托管账号目录身份缺失或重复');
        seen.add(bot.wxid.trim());
      }
    }
  }

  return groups.filter((group) => group !== null && typeof group === 'object');
}
