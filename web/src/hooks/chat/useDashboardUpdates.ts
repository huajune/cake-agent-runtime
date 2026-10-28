import { useEffect, useState } from 'react';

/** 后端只推刷新信号；业务数据仍通过当前 IP 范围的接口获取。 */
export function useDashboardUpdates(refresh: () => void) {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const token = import.meta.env.API_GUARD_TOKEN;
        const response = await fetch('/dashboard/events', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get('content-type')?.includes('text/event-stream')
        )
          throw new Error('stream unavailable');
        setConnected(true);
        const reader = response.body.getReader();
        while (!controller.signal.aborted) {
          const { done } = await reader.read();
          if (done) break;
          if (document.visibilityState === 'visible') refresh();
        }
      } catch {
        /* 网络恢复后重连；不改用匿名数据库订阅。 */
      }
      if (!controller.signal.aborted) {
        setConnected(false);
        reconnect = setTimeout(() => void connect(), 5000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [refresh]);
  return connected;
}
