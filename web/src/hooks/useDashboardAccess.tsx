import { createContext, useContext, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '@/api/client';

interface DashboardAccess {
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
  // 网络身份或小组成员变化时丢弃旧查询缓存，防止先前总部数据闪现。
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30000, retry: 1 } } }),
  );
  const location = useLocation();
  return (
    <AccessContext.Provider value={access}>
      <QueryClientProvider client={client}>
        {access.centerId && !CENTER_MENU_PATHS.includes(location.pathname) ? (
          <Navigate to="/hosting" replace />
        ) : (
          children
        )}
      </QueryClientProvider>
    </AccessContext.Provider>
  );
}

export function DashboardAccessBoundary({ children }: { children: ReactNode }) {
  const access = useQuery({
    queryKey: ['dashboard-access'],
    queryFn: async () => (await api.get<DashboardAccess>('/dashboard/access')).data,
    retry: false,
    staleTime: 0,
    refetchInterval: 30000,
    refetchOnWindowFocus: 'always',
  });
  if (access.isLoading) return <p role="status">正在确认访问范围…</p>;
  if (access.isError || !access.data)
    return <p role="alert">无法确认访问范围，请检查网络后刷新页面。</p>;
  return (
    <ScopedQueries key={`${access.data.centerId}:${access.data.scopeKey}`} access={access.data}>
      {children}
    </ScopedQueries>
  );
}
