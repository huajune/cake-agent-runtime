import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { matchPath, Navigate, parsePath, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, ApiError } from '@/api/client';
import { dashboardAuth, dashboardSignOutRequested } from '@/api/dashboard-session';
import type { TenantRole } from '@/api/dashboard-accounts';
import Login from '@/view/login/list';
import { MESSAGE_PROCESSING_DETAIL_PATH } from '@/routes/lazy-pages';

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

function canOpen(access: DashboardAccess, pathname: string) {
  if (matchPath('/accounts/*', pathname) && !access.isAdministrator) return false;
  return (
    !access.centerId ||
    CENTER_MENU_PATHS.some((path) => matchPath(path, pathname)) ||
    Boolean(matchPath(MESSAGE_PROCESSING_DETAIL_PATH, pathname))
  );
}

function ScopedQueries({
  access,
  children,
}: {
  access: DashboardAccess | null;
  children: ReactNode;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30000, retry: 1 } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <AccessContext.Provider value={access}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AccessContext.Provider>
  );
}

function AuthorizedDashboard({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null | undefined>(dashboardAuth ? undefined : null);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    if (!dashboardAuth) return;
    const { data } = dashboardAuth.onAuthStateChange((event, session) => {
      setUserId(session?.user.id ?? null);
      setSignedOut(event === 'SIGNED_OUT' && dashboardSignOutRequested);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  const atLogin = Boolean(matchPath('/login', location.pathname));
  const needsSignIn = atLogin && location.state?.needsSignIn === true;
  useEffect(() => {
    const recheck = () => void client.invalidateQueries({ queryKey: ['dashboard-access', userId] });
    window.addEventListener('cake-dashboard-access-changed', recheck);
    return () => window.removeEventListener('cake-dashboard-access-changed', recheck);
  }, [client, userId]);
  const access = useQuery({
    queryKey: ['dashboard-access', userId],
    enabled: Boolean(userId) && !needsSignIn,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<DashboardAccess>('/dashboard/access', { signal });
      if (!data || data.userId !== userId)
        throw new ApiError('ACCESS_DENIED', '没有权限', undefined, 403);
      return data;
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 30000,
    refetchOnWindowFocus: 'always',
  });
  const confirmed = access.data?.userId === userId ? (access.data ?? null) : null;
  const refused =
    access.error instanceof ApiError &&
    (access.error.status === 401 || access.error.status === 403);
  const from = atLogin ? location.state?.from : location.pathname + location.search + location.hash;
  const target = typeof from === 'string' && /^\/(?![/\\])/.test(from) ? from : undefined;
  const targetPath = target && parsePath(target).pathname;
  const requestedPage = targetPath && !matchPath('/login', targetPath) ? targetPath : undefined;
  const centerHome = confirmed?.centerId && requestedPage === '/';
  const forbiddenPage =
    confirmed && requestedPage && !centerHome && !canOpen(confirmed, requestedPage);
  const redirectToLogin =
    !needsSignIn && (refused || forbiddenPage || (!atLogin && userId === null));

  useLayoutEffect(() => {
    if (!redirectToLogin) return;
    if (!signedOut) toast.error('没有权限', { id: 'dashboard-access-denied' });
    navigate('/login', {
      replace: true,
      state: {
        from: signedOut || (atLogin && forbiddenPage) ? undefined : target,
        needsSignIn: true,
      },
    });
  }, [redirectToLogin, signedOut, navigate, atLogin, forbiddenPage, target]);

  useEffect(() => {
    if (access.isError && !refused && !needsSignIn) {
      toast.error('暂时无法确认权限，请稍后重试', { id: 'dashboard-access-unavailable' });
    }
  }, [access.isError, refused, needsSignIn]);

  if (redirectToLogin) return null;
  if (centerHome && !needsSignIn) return <Navigate replace to="/hosting" />;
  if (atLogin) {
    if (confirmed && !needsSignIn) {
      const home = confirmed.centerId ? '/hosting' : '/';
      return <Navigate replace to={requestedPage && target ? target : home} />;
    }
    return (
      <Login
        onSignedIn={(id) => {
          if (needsSignIn) {
            client.removeQueries({ queryKey: ['dashboard-access', id], exact: true });
            navigate('/login', { replace: true, state: { from } });
          } else if (id === userId && access.isError) {
            void access.refetch();
          }
        }}
      />
    );
  }
  return (
    <ScopedQueries
      key={
        confirmed
          ? [userId, confirmed.organization, confirmed.isAdministrator, confirmed.scopeKey].join(
              ':',
            )
          : 'pending'
      }
      access={confirmed}
    >
      {children}
    </ScopedQueries>
  );
}

export function DashboardAccessBoundary({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <AuthorizedDashboard>{children}</AuthorizedDashboard>
    </QueryClientProvider>
  );
}
