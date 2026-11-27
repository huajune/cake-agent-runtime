import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const dashboardAuth =
  url && key
    ? createClient(url, key, {
        auth: { storageKey: 'cake-dashboard-auth', detectSessionInUrl: false },
      }).auth
    : null;

export let dashboardSignOutRequested = false;

export async function changeDashboardPassword(
  identity: { email: string } | { phone: string },
  current: string,
  password: string,
) {
  if (!url || !key) throw new Error('登录服务尚未配置，请联系管理员');
  // Checking the current password must not sign the login page into the workspace.
  const auth = createClient(url, key, {
    auth: {
      storageKey: 'cake-password-' + crypto.randomUUID(),
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }).auth;
  let signedIn = false;
  try {
    const { data, error } = await auth.signInWithPassword({ ...identity, password: current });
    if (error || !data.session) {
      if (error?.status === 429) throw new Error('尝试次数较多，请稍后再试');
      throw new Error('无法验证当前密码，请核对账号和密码');
    }
    signedIn = true;
    const access = await fetch('/dashboard/access', {
      headers: { Authorization: 'Bearer ' + data.session.access_token },
      cache: 'no-store',
    });
    if (access.status === 401 || access.status === 403)
      throw new Error('该账号无法使用后台，请联系管理员');
    if (!access.ok) throw new Error('暂时无法验证账号，请稍后再试');
    const result = await auth.updateUser({ current_password: current, password });
    if (result.error) {
      if (result.error.status === 429) throw new Error('尝试次数较多，请稍后再试');
      if (result.error.code === 'weak_password') throw new Error('新密码不符合要求，请更换后重试');
      throw new Error('修改密码失败，请核对当前密码后重试');
    }
  } finally {
    try {
      if (signedIn) await auth.signOut({ scope: 'local' });
    } finally {
      await auth.dispose();
    }
  }
}

export async function signOutOfDashboard() {
  if (!dashboardAuth || dashboardSignOutRequested) return;
  dashboardSignOutRequested = true;
  try {
    const { error } = await dashboardAuth.signOut({ scope: 'local' });
    if (error) throw error;
  } finally {
    dashboardSignOutRequested = false;
  }
}

export async function dashboardHeaders(): Promise<Record<string, string>> {
  const session = await dashboardAuth?.getSession();
  const token = session?.data.session?.access_token;
  if (!token) throw new Error('请登录运营后台');
  return { Authorization: 'Bearer ' + token };
}

export async function dashboardFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const auth = await dashboardHeaders();
  headers.set('Authorization', auth.Authorization);
  return fetch(input, { ...init, headers });
}
