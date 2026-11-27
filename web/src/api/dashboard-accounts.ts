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
  TenantAccountPage,
  TenantRole,
} from '../../../src/types/dashboard-account';
export {
  DASHBOARD_ACCOUNT_PAGE_SIZE,
  dashboardLoginIdentity,
  formatDashboardPhone,
  normalizeDashboardPhone,
  TENANT_ROLE_LABELS,
  TenantRole,
} from '../../../src/types/dashboard-account';
export type {
  DashboardAccount,
  Tenant,
  TenantAccountSummary,
} from '../../../src/types/dashboard-account';

export const loadAccountTenants = async (page: number) =>
  (await api.get<TenantAccountPage>('/dashboard/accounts/organizations', { params: { page } }))
    .data;

export const loadAccounts = async (organization: string, page: number) =>
  (await api.get<DashboardAccountPage>('/dashboard/accounts', { params: { organization, page } }))
    .data;

export const registerTenant = async (name: string) =>
  (await api.post<Tenant>('/dashboard/accounts/organizations', { name })).data;

export const deleteEmptyTenant = (id: string) =>
  api.delete('/dashboard/accounts/organizations/' + encodeURIComponent(id));

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
export const restoreAccount = (id: string) => api.post('/dashboard/accounts/' + id + '/restore');
export const deleteAccountLogin = (id: string) => api.delete('/dashboard/accounts/' + id);

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
