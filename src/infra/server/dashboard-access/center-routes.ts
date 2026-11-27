import type { Request } from 'express';
import { isDashboardAdministrator, type DashboardAccount } from '@/types/dashboard-account';

export const CENTER_READ_ROUTES = {
  '/dashboard/access': 'access',
  '/dashboard/events': 'events',
  '/group/list': 'groups',
  '/bot/configured-list': 'bots',
  '/config/blacklist': 'blacklist',
  '/analytics/users': 'users',
  '/analytics/user-trend': 'user-trend',
  '/analytics/chat-sessions': 'sessions',
  '/analytics/chat-sessions-optimized': 'sessions',
  '/analytics/chat-summary-stats': 'chat-stats',
  '/analytics/chat-business-daily-trend': 'business-trend',
  '/analytics/chat-daily-stats': 'chat-trend',
  '/analytics/message-processing-records': 'processing',
  '/analytics/message-stats': 'processing-stats',
  '/analytics/slowest-messages': 'slowest',
  '/analytics/reengagement-records': 'touches',
  '/analytics/reengagement-records/detail': 'touch-detail',
  '/analytics/reengagement-candidates': 'candidates',
  '/analytics/reengagement-stats': 'touch-stats',
  '/analytics/reengagement-weekly-funnel': 'weekly',
  '/analytics/reengagement-scenarios': 'scenarios',
} as const;
export type CenterRoute =
  | (typeof CENTER_READ_ROUTES)[keyof typeof CENTER_READ_ROUTES]
  | 'messages'
  | 'processing-detail'
  | 'user-switch'
  | 'group-switch';
export function requiresTenantScope(account: DashboardAccount, route: CenterRoute | undefined) {
  return (
    account.tenant?.readsAllTenants !== true ||
    ((route === 'group-switch' || route === 'user-switch') && !isDashboardAdministrator(account))
  );
}

export function centerRoute(request: Request): CenterRoute | undefined {
  // Use the handler Express actually matched, including its canonical path casing.
  const matchedPath: unknown = request.route?.path;
  const path =
    (typeof matchedPath === 'string' ? matchedPath : request.path).replace(/\/+$/, '') || '/';
  if (request.method === 'GET') {
    if (/^\/analytics\/chat-sessions\/[^/]+\/messages$/.test(path)) return 'messages';
    if (/^\/analytics\/message-processing-records\/[^/]+$/.test(path)) return 'processing-detail';
    return CENTER_READ_ROUTES[path];
  }
  if (['POST', 'DELETE'].includes(request.method) && path === '/config/blacklist')
    return 'group-switch';
  if (request.method === 'POST' && path === '/user/users/:chatId/hosting') return 'user-switch';
}
