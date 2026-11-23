import type { GroupInfo } from '../../../api/types/monitoring.types';
const UNASSIGNED = '归属待确认';

interface GroupSection {
  id: string | null;
  name: string;
  blocked: number;
  groups: { id: string; name: string; note: string; blocked: boolean; canToggle: boolean }[];
}

export function summarizeHostingGroups(
  groups: GroupInfo[],
  blockedIds: string[],
  access?: { organization: string; name?: string; isAdministrator: boolean } | null,
) {
  const byId = new Map<string | null, GroupSection>();
  const blacklist = new Set(blockedIds);
  let blockedCount = 0;
  for (const group of groups) {
    const id = group.tenantId ?? null;
    let section = byId.get(id);
    if (!section) {
      const name =
        group.tenantName ??
        (id && id === access?.organization ? access.name : null) ??
        id ??
        UNASSIGNED;
      section = { id, name, blocked: 0, groups: [] };
      byId.set(id, section);
    }
    const blocked = blacklist.has(group.id);
    if (blocked) {
      section.blocked++;
      blockedCount++;
    }
    section.groups.push({
      id: group.id,
      name: group.name,
      note: group.description?.trim() ?? '',
      blocked,
      canToggle: Boolean(
        access && (access.isAdministrator || group.tenantId === access.organization),
      ),
    });
  }
  const sections = [...byId.values()].sort((a, b) => Number(a.id === null) - Number(b.id === null));
  return { sections, total: groups.length, blockedCount };
}
