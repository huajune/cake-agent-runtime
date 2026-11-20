import type { DashboardOrganization } from './dashboard-account';
export const DEFAULT_HENAN_GROUP_MARKER = '河南自招团队成员';
export const SHANGHAI_RECRUITMENT_MARKER = '上海自招团队成员';
const SHANGHAI_HQ_MARKER = '上海智能体组内部成员';
export const SHANGHAI_GROUP_NAMES: ReadonlyMap<string, string> = new Map([
  [SHANGHAI_HQ_MARKER, '上海智能体组'],
  [SHANGHAI_RECRUITMENT_MARKER, '上海自招团队'],
]);

/** Stride 小组备注可含其他说明，组织标识匹配独占的一整行。 */
export function groupDescriptionLines(description?: string | null): string[] {
  if (typeof description !== 'string') return [];
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Distinct organization markers on the same group leave its ownership unresolved. */
export function hostingGroupMarker(lines: string[], henanMarker: string): string | null {
  const markers = [
    ...new Set(lines.filter((line) => line === henanMarker || SHANGHAI_GROUP_NAMES.has(line))),
  ];
  if (markers.length !== 1) return null;
  const [marker] = markers;
  return marker === henanMarker && SHANGHAI_GROUP_NAMES.has(marker) ? null : marker;
}

export function hostingGroupOrganization(
  description: string | null | undefined,
  henanMarker: string,
): DashboardOrganization | null {
  const marker = hostingGroupMarker(groupDescriptionLines(description), henanMarker);
  if (marker === SHANGHAI_HQ_MARKER) return 'headquarters';
  if (marker === SHANGHAI_RECRUITMENT_MARKER) return 'shanghai_recruitment';
  return marker && marker === henanMarker ? 'henan' : null;
}
