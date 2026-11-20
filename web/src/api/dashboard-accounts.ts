import { api } from './client';
import type {
  HostingManagementDirectory,
  HostingGroupSelection,
} from '../../../src/types/hosting-binding';
export type {
  HostingManagementDirectory,
  HostingGroupSelection,
  HostingHandover,
  ManagedHostingGroup,
} from '../../../src/types/hosting-binding';
import type {
  DashboardAccountPage,
  DashboardOrganization,
} from '../../../src/types/dashboard-account';
export {
  DASHBOARD_ORGANIZATIONS,
  dashboardLoginIdentity,
  normalizeDashboardPhone,
} from '../../../src/types/dashboard-account';
export type { DashboardAccount, DashboardOrganization } from '../../../src/types/dashboard-account';

export const loadAccounts = async (page: number) =>
  (await api.get<DashboardAccountPage>('/dashboard/accounts', { params: { page } })).data;

export const openAccount = (input: {
  memberId?: string;
  hostingBinding?: HostingGroupSelection;
  name: string;
  phone: string;
  organization: DashboardOrganization;
  password: string;
}) => api.post('/dashboard/accounts', input);
export const resetAccountPassword = (id: string, password: string) =>
  api.post('/dashboard/accounts/' + id + '/password', { password });
export const disableAccount = (id: string) => api.post('/dashboard/accounts/' + id + '/disable');
export const moveAccount = (id: string, organization: DashboardOrganization) =>
  api.patch('/dashboard/accounts/' + id + '/organization', { organization });

const bindingsPath = '/dashboard/hosting-bindings';
export const loadHostingDirectory = async () =>
  (await api.get<HostingManagementDirectory>(bindingsPath)).data;
export const syncHostingDirectory = async () =>
  (await api.post<HostingManagementDirectory>(bindingsPath + '/sync')).data;
export const bindHostingGroup = (
  memberId: string,
  organization: DashboardOrganization,
  selection: HostingGroupSelection,
) => api.post(bindingsPath + '/members/' + memberId, { organization, ...selection });
export const confirmHostingHandover = (
  id: string,
  targetGroupId: string | null,
  effectiveAt: string,
) => api.post(bindingsPath + '/handovers/' + id, { targetGroupId, effectiveAt });
