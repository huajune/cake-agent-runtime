import type { Tenant } from './dashboard-account';

export interface HostingGroupSelection {
  groupId: string;
  previousGroupId: string | null;
  previousOwnerId: string | null;
}

export interface ManagedHostingGroup {
  id: string;
  name: string;
  tenantId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  bots: Array<{ id: string; name: string }>;
}

export interface HostingHandover {
  id: string;
  botId: string;
  botName: string;
  fromGroupId: string | null;
  toGroupId: string | null;
  reviewFrom: string;
  targetChangedSince: string | null;
  detectedAt: string;
}

export interface HostingManagementDirectory {
  tenants: Tenant[];
  checkedAt: string | null;
  groups: ManagedHostingGroup[];
  handovers: HostingHandover[];
}

export interface HostingScopeBindings {
  tenantNames: Record<string, string>;
  groups: Record<string, string>;
  bots: Record<string, string>;
}
