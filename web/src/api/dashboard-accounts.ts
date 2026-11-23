import { api } from './client';
import type {
  HostingManagementDirectory,
  HostingGroupSelection,
} from '../../../src/types/hosting-binding';
export type {
  HostingManagementDirectory,
  HostingGroupSelection,
  ManagedHostingGroup,
} from '../../../src/types/hosting-binding';
import type {
  DashboardAccountPage,
  Tenant,
  TenantRole,
} from '../../../src/types/dashboard-account';
export {
  dashboardLoginIdentity,
  normalizeDashboardPhone,
  TENANT_ROLE_LABELS,
  TenantRole,
} from '../../../src/types/dashboard-account';
export type { DashboardAccount, Tenant } from '../../../src/types/dashboard-account';

export const loadAccounts = async (page: number) =>
  (await api.get<DashboardAccountPage>('/dashboard/accounts', { params: { page } })).data;

export const registerTenant = async (name: string) =>
  (await api.post<Tenant>('/dashboard/accounts/organizations', { name })).data;

export const openAccount = (input: {
  memberId?: string;
  hostingBinding?: HostingGroupSelection;
  name: string;
  phone: string;
  organization: string;
  tenantRole: TenantRole;
  password: string;
}) => api.post('/dashboard/accounts', input);
export const resetAccountPassword = (id: string, password: string) =>
  api.post('/dashboard/accounts/' + id + '/password', { password });
export const disableAccount = (id: string) => api.post('/dashboard/accounts/' + id + '/disable');
export const moveAccount = (id: string, organization: string) =>
  api.patch('/dashboard/accounts/' + id + '/organization', { organization });

const bindingsPath = '/dashboard/hosting-bindings';
export const loadHostingDirectory = async () =>
  (await api.get<HostingManagementDirectory>(bindingsPath)).data;
export const syncHostingDirectory = async () =>
  (await api.post<HostingManagementDirectory>(bindingsPath + '/sync')).data;
export const bindHostingGroup = (
  memberId: string,
  organization: string,
  selection: HostingGroupSelection,
) => api.post(bindingsPath + '/members/' + memberId, { organization, ...selection });
