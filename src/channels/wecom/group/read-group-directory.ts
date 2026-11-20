import { InternalServerErrorException } from '@nestjs/common';
import type { HostingGroup } from '../../../biz/ops-events/providers/group-directory.provider';

export async function readGroupDirectory(
  readPage: (current: number, pageSize: number) => Promise<unknown>,
): Promise<HostingGroup[]> {
  const groups = new Map<string, HostingGroup>();
  for (let current = 1; current <= 20; current++) {
    let data = await readPage(current, 100);
    for (let depth = 0; depth < 5 && data && typeof data === 'object' && 'data' in data; depth++) {
      if ('errcode' in data && data.errcode !== 0)
        throw new InternalServerErrorException('小组目录读取失败');
      data = data.data;
    }
    if (!Array.isArray(data)) throw new InternalServerErrorException('小组目录格式无效');
    for (const group of data) {
      if (typeof group?.id !== 'string' || typeof group?.name !== 'string')
        throw new InternalServerErrorException('小组目录身份字段缺失');
      if (groups.has(group.id)) throw new InternalServerErrorException('小组目录分页重复');
      groups.set(group.id, { id: group.id, name: group.name, description: group.description });
    }
    if (data.length < 100) return [...groups.values()];
  }
  throw new InternalServerErrorException('小组目录超过读取上限');
}
