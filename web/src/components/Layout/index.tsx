import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import AutumnGarland from '@/components/AutumnGarland';
import {
  ALL_ROUTE_PATHS,
  preloadRouteChunks,
  type AppRoutePath,
} from '@/routes/lazy-pages';
import { markRouteNavigationComplete } from '@/utils/perf';

function RouteContentFallback() {
  return (
    <div
      style={{
        minHeight: 'calc(100vh - 140px)',
        display: 'grid',
        gap: '20px',
        alignContent: 'start',
      }}
    >
      <div
        style={{
          height: '120px',
          borderRadius: '24px',
          border: '1px solid rgba(138, 137, 173, 0.16)',
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.92) 0%, rgba(250, 249, 255, 0.92) 100%)',
          boxShadow: '0 12px 32px rgba(20, 19, 43, 0.06)',
        }}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '20px',
        }}
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            style={{
              height: '180px',
              borderRadius: '24px',
              border: '1px solid rgba(138, 137, 173, 0.16)',
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.92) 0%, rgba(250, 249, 255, 0.92) 100%)',
              boxShadow: '0 12px 32px rgba(20, 19, 43, 0.06)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function Layout() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const location = useLocation();
  const disableAmbientAnimations = location.pathname.startsWith('/agent-test');
  const hasScheduledRouteWarmup = useRef(false);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  // Cmd/Ctrl + B 是常见的侧栏切换快捷键；Cmd/Ctrl + S 留给表单页面保存。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  useEffect(() => {
    markRouteNavigationComplete(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (hasScheduledRouteWarmup.current) return;
    hasScheduledRouteWarmup.current = true;

    const currentPath = ALL_ROUTE_PATHS.includes(location.pathname as AppRoutePath)
      ? (location.pathname as AppRoutePath)
      : null;
    const pathsToWarm = currentPath
      ? ALL_ROUTE_PATHS.filter((path) => path !== currentPath)
      : ALL_ROUTE_PATHS;

    let cancelled = false;
    const warmRoutes = async () => {
      if (cancelled) return;
      await preloadRouteChunks(pathsToWarm);
    };

    const globalWindow = window;

    if (typeof globalWindow.requestIdleCallback === 'function') {
      const idleId = globalWindow.requestIdleCallback(() => {
        void warmRoutes();
      }, { timeout: 1500 });

      return () => {
        cancelled = true;
        globalWindow.cancelIdleCallback(idleId);
      };
    }

    const timer = globalThis.setTimeout(() => {
      void warmRoutes();
    }, 1200);

    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [location.pathname]);

  return (
    <>
      {!disableAmbientAnimations && (
        <>
          {/* 柔和背景动画 */}
          <div className="background-gradients">
            <span className="bg-blue"></span>
            <span className="bg-purple"></span>
          </div>

          {/* 秋日装饰 - 飘落的秋叶 */}
          <AutumnGarland sidebarCollapsed={isSidebarCollapsed} />
        </>
      )}

      <div className={`app-layout ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
        <main className="content">
          <div className="container">
            <Suspense fallback={<RouteContentFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </>
  );
}
