export interface UserPageCursor {
  chatId: string;
  botId: string;
}

export interface ScopedUserPage<T> {
  users: T[];
  nextCursor: UserPageCursor | null;
}

/** 总部沿用完整数组；中心逐页读取后交给现有页面搜索和排序。失败不展示残缺总数。 */
export async function loadUserPages<T>(
  fetchPage: (cursor?: UserPageCursor) => Promise<T[] | ScopedUserPage<T>>,
): Promise<T[]> {
  const users: T[] = [];
  const seen = new Set<string>();
  let cursor: UserPageCursor | undefined;
  const startedAt = Date.now();
  for (let page = 0; page < 200 && Date.now() - startedAt < 30_000; page += 1) {
    const result = await fetchPage(cursor);
    if (Array.isArray(result)) return result;
    users.push(...result.users);
    if (!result.nextCursor) return users;
    const key = JSON.stringify(result.nextCursor);
    if (!result.users.length || seen.has(key)) throw new Error('用户分页游标异常，请重试');
    seen.add(key);
    cursor = result.nextCursor;
  }
  throw new Error('用户范围过大，请缩小日期范围后重试');
}
