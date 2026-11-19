import {
  DASHBOARD_ACCESS_DENIED_PATH,
  DASHBOARD_IP_DENIED,
} from '../../../src/types/dashboard-access.contract';

let redirecting = false;

/** 只响应网络准入拒绝；业务权限不足、网络超时继续由当前页面处理。 */
export function redirectIfDashboardIpDenied(status: number, code: unknown): void {
  if (status !== 403 || code !== DASHBOARD_IP_DENIED || redirecting) return;
  redirecting = true;
  // 整页跳转卸载旧缓存；目标由服务器直接返回，不加载后台及其接口。
  window.location.replace(DASHBOARD_ACCESS_DENIED_PATH);
}

/** 流式 fetch 与普通 API 使用相同拦截；clone 保留调用方的响应体。 */
export async function checkDashboardStreamAccess(response: Response): Promise<void> {
  if (response.status !== 403) return;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  redirectIfDashboardIpDenied(response.status, body?.error?.code);
}
