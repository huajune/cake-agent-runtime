import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { matchPath, Navigate, useLocation } from 'react-router-dom';
import { api } from '@/api/client';
import { dashboardAuth } from '@/api/dashboard-session';
import type { TenantRole } from '@/api/dashboard-accounts';
import Login from '@/view/login/list';

interface DashboardAccess {
  userId: string;
  displayName: string;
  isAdministrator: boolean;
  tenantRole: TenantRole | null;
  organization: string;
  centerId: string | null;
  name: string;
  scopeKey: string;
}
const AccessContext = createContext<DashboardAccess | null>(null);
export const CENTER_MENU_PATHS = [
  '/users',
  '/hosting',
  '/chat-records',
  '/message-processing',
  '/reengagement',
];
export const useDashboardAccess = () => useContext(AccessContext);

function ScopedQueries({ access, children }: { access: DashboardAccess; children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30000, retry: 1 } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  const location = useLocation();
  return (
    <AccessContext.Provider value={access}>
      <QueryClientProvider client={client}>
        {(!access.isAdministrator && matchPath('/accounts/*', location.pathname)) ||
        (access.centerId && !CENTER_MENU_PATHS.includes(location.pathname)) ? (
          <Navigate to="/hosting" replace />
        ) : (
          children
        )}
      </QueryClientProvider>
    </AccessContext.Provider>
  );
}

function AuthorizedDashboard({ userId, children }: { userId: string; children: ReactNode }) {
  const client = useQueryClient();
  useEffect(() => {
    const recheck = () => void client.invalidateQueries({ queryKey: ['dashboard-access', userId] });
    window.addEventListener('cake-dashboard-access-changed', recheck);
    return () => window.removeEventListener('cake-dashboard-access-changed', recheck);
  }, [client, userId]);
  const access = useQuery({
    queryKey: ['dashboard-access', userId],
    gcTime: 0,
    queryFn: async () => (await api.get<DashboardAccess>('/dashboard/access')).data,
    retry: false,
    staleTime: 0,
    refetchInterval: 30000,
    refetchOnWindowFocus: 'always',
  });
  if (access.isLoading) return <p role="status">正在确认访问范围…</p>;
  if (access.isError || !access.data || access.data.userId !== userId)
    return (
      <main className="dashboard-access-notice">
        <h1>暂时无法进入后台</h1>
        <p role="alert">{access.error?.message || '无法确认账号权限，请重新登录'}</p>
        <button onClick={() => void access.refetch()}>重试</button>
        <button onClick={() => void dashboardAuth?.signOut({ scope: 'local' })}>返回登录</button>
      </main>
    );
  return (
    <ScopedQueries
      key={[
        userId,
        access.data.organization,
        access.data.isAdministrator,
        access.data.scopeKey,
      ].join(':')}
      access={access.data}
    >
      {children}
    </ScopedQueries>
  );
}

function AccountSession({ userId, children }: { userId: string; children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <AuthorizedDashboard userId={userId}>{children}</AuthorizedDashboard>
    </QueryClientProvider>
  );
}

export function DashboardAccessBoundary({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null | undefined>(dashboardAuth ? undefined : null);
  const location = useLocation();
  useEffect(() => {
    if (!dashboardAuth) return;
    const { data } = dashboardAuth.onAuthStateChange((_event, session) =>
      setUserId(session?.user.id ?? null),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  if (userId === undefined) return <p role="status">正在恢复登录状态…</p>;
  if (!userId)
    return location.pathname === '/login' ? (
      <Login />
    ) : (
      <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
    );
  if (location.pathname === '/login') {
    const from = location.state?.from;
    return (
      <Navigate
        replace
        to={typeof from === 'string' && /^\/(?![/\\])/.test(from) && from !== '/login' ? from : '/'}
      />
    );
  }
  return (
    <AccountSession key={userId} userId={userId}>
      {children}
    </AccountSession>
  );
}
