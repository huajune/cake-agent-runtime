import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const dashboardAuth =
  url && key
    ? createClient(url, key, {
        auth: { storageKey: 'cake-dashboard-auth', detectSessionInUrl: false },
      }).auth
    : null;

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
