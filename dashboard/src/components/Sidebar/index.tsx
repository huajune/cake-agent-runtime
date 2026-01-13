import logoIcon from '@/assets/images/cake_recruiter_icon.png';
import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

// SVG 图标组件 - 新春节日限定版
const DashboardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <circle cx="12" cy="15" r="4" />
    <path d="M12 11v2" />
    <path d="M10 12l2 1l2-1" />
  </svg>
);

const UsersIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
    <path d="M12 3c4 0 5 2 5 4" />
    <path d="M16 3l-4-2l-4 2" />
    <circle cx="17" cy="7" r="1.5" />
  </svg>
);

const HostingIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <path d="M4 6c2 2 4-1 6 1s4-2 6 0s4 0 4 2" />
    <path d="M4 6c0-2 2-3 4-3h8c2 0 4 1 4 3" />
  </svg>
);

const ConfigIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" opacity="0" />
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    <path d="M12 9v6" />
    <path d="M9.5 10.5l5 3" />
    <path d="M9.5 13.5l5-3" />
  </svg>
);

const SystemIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12h3l2-3l2 3h2" />
    <path d="M14 12l2.5-4l2.5 4h3" />
    <path d="M16.5 8l-1.5-2l-1.5 2" />
    <path d="M16.5 4l1 1.5" />
    <path d="M16.5 4l-1 1.5" />
  </svg>
);

const AgentTestIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4" />
    <circle cx="5" cy="9" r="1" />
    <circle cx="5" cy="15" r="1" />
    <path d="M12 7h6" />
    <path d="M12 11h4" />
    <path d="M12 15h6" />
  </svg>
);

const TestSuiteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    <rect x="9" y="3" width="6" height="4" rx="1" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

const LogsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M10 14v4" />
    <path d="M10 14a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v1" />
    <path d="M10 16h2" />
    <path d="M10 18h2" />
  </svg>
);

const ChatRecordsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M8 9h8" />
    <path d="M8 13h6" />
  </svg>
);

export default function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Background Decorations */}
      {!isCollapsed && (
        <>
          <div className="sidebar-watermark">🏮</div>
          <div className="sidebar-watermark-2">🧧</div>
        </>
      )}

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
          <img src={logoIcon} alt="Logo" style={{ width: 36, height: 36, borderRadius: 10, objectFit: 'cover' }} />
          {!isCollapsed && '蛋糕私域托管'}
        </div>
      </div>

      <div className="sidebar-menu">
        {/* 概览 */}
        {!isCollapsed && <div className="group-title">概览</div>}
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '仪表盘' : undefined}
        >
          <span className="nav-icon"><DashboardIcon /></span>
          {!isCollapsed && <span className="nav-text">仪表盘</span>}
        </NavLink>

        {/* 管理 */}
        {!isCollapsed && <div className="group-title">管理</div>}
        <NavLink
          to="/users"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '今日托管' : undefined}
        >
          <span className="nav-icon"><UsersIcon /></span>
          {!isCollapsed && <span className="nav-text">今日托管</span>}
        </NavLink>
        <NavLink
          to="/logs"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '实时消息' : undefined}
        >
          <span className="nav-icon"><LogsIcon /></span>
          {!isCollapsed && <span className="nav-text">实时消息</span>}
        </NavLink>
        <NavLink
          to="/chat-records"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '消息总览' : undefined}
        >
          <span className="nav-icon"><ChatRecordsIcon /></span>
          {!isCollapsed && <span className="nav-text">消息总览</span>}
        </NavLink>
        <NavLink
          to="/hosting"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '托管设置' : undefined}
        >
          <span className="nav-icon"><HostingIcon /></span>
          {!isCollapsed && <span className="nav-text">托管设置</span>}
        </NavLink>
        <NavLink
          to="/config"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '回复设置' : undefined}
        >
          <span className="nav-icon"><ConfigIcon /></span>
          {!isCollapsed && <span className="nav-text">回复设置</span>}
        </NavLink>

        {/* 系统 */}
        {!isCollapsed && <div className="group-title">系统</div>}
        <NavLink
          to="/system"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '系统监控' : undefined}
        >
          <span className="nav-icon"><SystemIcon /></span>
          {!isCollapsed && <span className="nav-text">系统监控</span>}
        </NavLink>

        {/* 开发工具 */}
        {!isCollapsed && <div className="group-title">开发</div>}
        <NavLink
          to="/agent-test"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '对话测试' : undefined}
        >
          <span className="nav-icon"><AgentTestIcon /></span>
          {!isCollapsed && <span className="nav-text">对话测试</span>}
        </NavLink>
        <NavLink
          to="/test-suite"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          title={isCollapsed ? '飞书测试集' : undefined}
        >
          <span className="nav-icon"><TestSuiteIcon /></span>
          {!isCollapsed && <span className="nav-text">飞书测试集</span>}
        </NavLink>
      </div>

      {!isCollapsed && (
        <div className="sidebar-footer">
          <div className="spring-floating">🐎</div>

          {/* Spring Festival Decorative Element */}
          <div className="spring-card">
            <div className="spring-title">新春快乐! 🧧</div>
            <div className="spring-text">马年大吉，代码无 Bug，事业步步高升!</div>
            <div className="fireworks" aria-hidden="true">
              <div className="firework">✨</div>
              <div className="firework">🎇</div>
              <div className="firework">✨</div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
