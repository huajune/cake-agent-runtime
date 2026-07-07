import { MouseEvent, useCallback } from 'react';
import logoIcon from '@/assets/images/cake_recruiter_icon.png';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BellRing,
  Bug,
  ClipboardCheck,
  Layers,
  LayoutDashboard,
  MessageSquare,
  MessageSquareCode,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  Table2,
  ToggleRight,
  TrendingUp,
  Users,
} from 'lucide-react';
import { preloadRouteChunk, type AppRoutePath } from '@/routes/lazy-pages';
import { markRouteNavigationStart } from '@/utils/perf';
import { BADCASE_FEISHU_URL, OPERATION_METRICS_FEISHU_URL } from '@/constants';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

// 统一图标尺寸与线宽，保证清爽一致的视觉
const NAV_ICON_SIZE = 19;
const NAV_ICON_STROKE = 1.6;

export default function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const shouldInterceptNavigation = (event: MouseEvent<HTMLAnchorElement>) =>
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.currentTarget.target;

  const bindPreload = useCallback(
    (path: AppRoutePath) => ({
      onMouseEnter: () => {
        void preloadRouteChunk(path);
      },
      onFocus: () => {
        void preloadRouteChunk(path);
      },
      onTouchStart: () => {
        void preloadRouteChunk(path);
      },
      onClick: async (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldInterceptNavigation(event)) return;
        if (location.pathname === path) return;

        event.preventDefault();
        markRouteNavigationStart(path);
        try {
          await preloadRouteChunk(path);
        } catch {
          // Fall through to route navigation even if background preload fails.
        }
        navigate(path);
      },
    }),
    [location.pathname, navigate],
  );

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* 背景水印装饰 */}
      <span className="sidebar-watermark">🌸</span>
      <span className="sidebar-watermark-2">🦋</span>

      {/* 收起/展开按钮 - 放在侧边栏右边缘 */}
      <button
        className="sidebar-toggle"
        onClick={onToggle}
        title={isCollapsed ? '展开菜单 (⌘S)' : '收起菜单 (⌘S)'}
      >
        {isCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
      </button>

      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img
            src={logoIcon}
            alt="Logo"
            style={{ width: 36, height: 36, borderRadius: 10, objectFit: 'cover' }}
          />
          {!isCollapsed && '蛋糕私域托管'}
        </div>
      </div>

      <div className="sidebar-menu">
        {/* 数据概览 */}
        {!isCollapsed && <div className="group-title">数据概览</div>}
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '仪表盘' : undefined}
          {...bindPreload('/')}
        >
          <span className="nav-icon">
            <LayoutDashboard size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">仪表盘</span>}
        </NavLink>
        <NavLink
          to="/conversion-analysis"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '转化分析' : undefined}
          {...bindPreload('/conversion-analysis')}
        >
          <span className="nav-icon">
            <TrendingUp size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">转化分析</span>}
        </NavLink>
        <a
          href={OPERATION_METRICS_FEISHU_URL}
          className="nav-item"
          title={isCollapsed ? '运营日报' : undefined}
          target="_blank"
          rel="noreferrer"
        >
          <span className="nav-icon">
            <Table2 size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">运营日报</span>}
        </a>

        {/* 客户运营 */}
        {!isCollapsed && <div className="group-title">客户运营</div>}
        <NavLink
          to="/users"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '托管用户' : undefined}
          {...bindPreload('/users')}
        >
          <span className="nav-icon">
            <Users size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">托管用户</span>}
        </NavLink>
        <NavLink
          to="/hosting"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '托管设置' : undefined}
          {...bindPreload('/hosting')}
        >
          <span className="nav-icon">
            <ToggleRight size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">托管开关</span>}
        </NavLink>

        <NavLink
          to="/chat-records"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '消息总览' : undefined}
          {...bindPreload('/chat-records')}
        >
          <span className="nav-icon">
            <MessageSquare size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">聊天记录</span>}
        </NavLink>

        {/* 策略与质量 */}
        {!isCollapsed && <div className="group-title">策略与质量</div>}

        <NavLink
          to="/strategy"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '策略配置' : undefined}
          {...bindPreload('/strategy')}
        >
          <span className="nav-icon">
            <Layers size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">策略配置</span>}
        </NavLink>
        <NavLink
          to="/agent-test"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '对话调试' : undefined}
          {...bindPreload('/agent-test')}
        >
          <span className="nav-icon">
            <MessageSquareCode size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">对话调试</span>}
        </NavLink>
        <a
          href={BADCASE_FEISHU_URL}
          className="nav-item"
          title={isCollapsed ? 'BadCase' : undefined}
          target="_blank"
          rel="noreferrer"
        >
          <span className="nav-icon">
            <Bug size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">BadCase</span>}
        </a>
        <NavLink
          to="/test-suite"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '飞书评测集' : undefined}
          {...bindPreload('/test-suite')}
        >
          <span className="nav-icon">
            <ClipboardCheck size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">飞书评测集</span>}
        </NavLink>

        {/* 系统 */}
        {!isCollapsed && <div className="group-title">系统</div>}

        <NavLink
          to="/config"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '运行时配置' : undefined}
          {...bindPreload('/config')}
        >
          <span className="nav-icon">
            <Settings size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">运行时配置</span>}
        </NavLink>
        <NavLink
          to="/message-processing"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '实时消息' : undefined}
          {...bindPreload('/message-processing')}
        >
          <span className="nav-icon">
            <ScrollText size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">消息处理流水</span>}
        </NavLink>
        <NavLink
          to="/reengagement"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '二次触发追溯' : undefined}
          {...bindPreload('/reengagement')}
        >
          <span className="nav-icon">
            <BellRing size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">二次触发追溯</span>}
        </NavLink>
        <NavLink
          to="/system"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '系统监控' : undefined}
          {...bindPreload('/system')}
        >
          <span className="nav-icon">
            <Activity size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
          </span>
          {!isCollapsed && <span className="nav-text">系统监控</span>}
        </NavLink>
      </div>
    </aside>
  );
}
