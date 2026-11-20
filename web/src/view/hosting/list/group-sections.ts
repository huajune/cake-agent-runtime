import type { GroupInfo } from '../../../api/types/monitoring.types';
import {
  DASHBOARD_ORGANIZATIONS,
  isDashboardOrganization,
} from '../../../../../src/types/dashboard-account';
import {
  groupDescriptionLines,
  hostingGroupMarker,
  SHANGHAI_GROUP_NAMES,
} from '../../../../../src/types/hosting-group';

const UNASSIGNED = '归属待确认';

interface GroupSection {
  name: string;
  blocked: number;
  groups: { id: string; name: string; note: string; blocked: boolean }[];
}

export function summarizeHostingGroups(
  groups: GroupInfo[],
  blockedIds: string[],
  henanMarker: string,
  centerName?: string,
) {
  // 展示分组仅整理服务端已授权返回的小组。上海的两种备注分别代表不同团队。
  const namesByMarker = new Map([
    ...SHANGHAI_GROUP_NAMES,
    [henanMarker, DASHBOARD_ORGANIZATIONS.henan],
  ]);
  const byName = new Map<string, GroupSection>();
  const blacklist = new Set(blockedIds);
  let blockedCount = 0;
  for (const group of groups) {
    const lines = groupDescriptionLines(group.description);
    const marker = hostingGroupMarker(lines, henanMarker) ?? '';
    const registered = isDashboardOrganization(group.tenantId)
      ? DASHBOARD_ORGANIZATIONS[group.tenantId]
      : UNASSIGNED;
    const name =
      centerName ??
      (group.tenantId === undefined ? (namesByMarker.get(marker) ?? UNASSIGNED) : registered);
    let section = byName.get(name);
    if (!section) {
      section = { name, blocked: 0, groups: [] };
      byName.set(name, section);
    }
    const blocked = blacklist.has(group.id);
    if (blocked) {
      section.blocked++;
      blockedCount++;
    }
    section.groups.push({
      id: group.id,
      name: group.name,
      note: lines.filter((line) => line !== marker).join('\n'),
      blocked,
    });
  }
  const sections = [...byName.values()].sort(
    (a, b) => Number(a.name === UNASSIGNED) - Number(b.name === UNASSIGNED),
  );
  return { sections, total: groups.length, blockedCount };
}
