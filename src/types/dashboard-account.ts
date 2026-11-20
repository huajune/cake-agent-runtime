import type { User } from '@supabase/supabase-js';

export const DASHBOARD_ORGANIZATIONS = {
  headquarters: '总部',
  henan: '河南自招中心',
  shanghai_recruitment: '上海自招团队',
} as const;
export type DashboardOrganization = keyof typeof DASHBOARD_ORGANIZATIONS;
export type DashboardCenter = Exclude<DashboardOrganization, 'headquarters'>;

export const DASHBOARD_ADMIN_LOGIN = 'cakeadmin';
// A non-deliverable Auth identity. Operators enter only the login name in the dashboard.
export const DASHBOARD_ADMIN_EMAIL = 'cakeadmin@dashboard.cake.invalid';

export function dashboardLoginIdentity(
  input: string,
): { email: string } | { phone: string } | null {
  if (input.trim() === DASHBOARD_ADMIN_LOGIN) return { email: DASHBOARD_ADMIN_EMAIL };
  const phone = normalizeDashboardPhone(input);
  return phone ? { phone } : null;
}

export function isDashboardAdministrator(
  account: Pick<DashboardAccount, 'loginName' | 'organization'>,
): boolean {
  return account.loginName === DASHBOARD_ADMIN_LOGIN && account.organization === 'headquarters';
}

export function isConfirmedDashboardAdminUser(user: User): boolean {
  return Boolean(
    user.email === DASHBOARD_ADMIN_EMAIL &&
      user.email_confirmed_at &&
      !user.phone &&
      user.app_metadata?.cake_dashboard_account?.login_name === DASHBOARD_ADMIN_LOGIN,
  );
}

export function isDashboardOrganization(value: unknown): value is DashboardOrganization {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DASHBOARD_ORGANIZATIONS, value)
  );
}

/** Mainland local numbers and explicitly international E.164 numbers are accepted. */
export function normalizeDashboardPhone(input: string): string | null {
  const phone = input.trim();
  if (/^1[3-9]\d{9}$/.test(phone)) return '+86' + phone;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export interface DashboardAccount {
  memberId?: string;
  loginName?: typeof DASHBOARD_ADMIN_LOGIN | null;
  userId: string | null;
  name: string;
  organization: DashboardOrganization;
  hostingGroupId?: string | null;
  phone: string | null;
  disabled: boolean;
}
export interface DashboardAccountPage {
  accounts: DashboardAccount[];
  total: number;
}
