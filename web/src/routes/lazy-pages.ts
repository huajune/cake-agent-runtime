import { lazy } from 'react';

type RouteLoader = () => Promise<unknown>;

export type AppRoutePath =
  | '/'
  | '/users'
  | '/hosting'
  | '/config'
  | '/system'
  | '/logs'
  | '/chat-records'
  | '/agent-test'
  | '/test-suite'
  | '/strategy';

const dashboardLoader = () => import('@/view/dashboard/list');
const usersLoader = () => import('@/view/users/list');
const hostingLoader = () => import('@/view/hosting/list');
const configLoader = () => import('@/view/config/list');
const systemLoader = () => import('@/view/system/list');
const logsLoader = () => import('@/view/logs/list');
const chatRecordsLoader = () => import('@/view/chat-records/list');
const agentTestLoader = () => import('@/view/agent-test/list');
const testSuiteLoader = () => import('@/view/test-suite/list');
const strategyLoader = () => import('@/view/strategy/list');

export const Dashboard = lazy(dashboardLoader);
export const Users = lazy(usersLoader);
export const Hosting = lazy(hostingLoader);
export const Config = lazy(configLoader);
export const System = lazy(systemLoader);
export const Logs = lazy(logsLoader);
export const ChatRecords = lazy(chatRecordsLoader);
export const AgentTest = lazy(agentTestLoader);
export const TestSuite = lazy(testSuiteLoader);
export const Strategy = lazy(strategyLoader);

export const ALL_ROUTE_PATHS: AppRoutePath[] = [
  '/',
  '/users',
  '/hosting',
  '/config',
  '/system',
  '/logs',
  '/chat-records',
  '/agent-test',
  '/test-suite',
  '/strategy',
];

const routeLoaders: Record<AppRoutePath, RouteLoader> = {
  '/': dashboardLoader,
  '/users': usersLoader,
  '/hosting': hostingLoader,
  '/config': configLoader,
  '/system': systemLoader,
  '/logs': logsLoader,
  '/chat-records': chatRecordsLoader,
  '/agent-test': agentTestLoader,
  '/test-suite': testSuiteLoader,
  '/strategy': strategyLoader,
};

const preloadPromises = new Map<AppRoutePath, Promise<unknown>>();

export function preloadRouteChunk(path: AppRoutePath): Promise<unknown> {
  const existingPromise = preloadPromises.get(path);
  if (existingPromise) return existingPromise;

  const promise = routeLoaders[path]().catch((error) => {
    preloadPromises.delete(path);
    throw error;
  });

  preloadPromises.set(path, promise);
  return promise;
}

export async function preloadRouteChunks(paths: AppRoutePath[]): Promise<void> {
  for (const path of paths) {
    try {
      await preloadRouteChunk(path);
    } catch {
      // Ignore background preload failures and allow future retries.
    }
  }
}
