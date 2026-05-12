import { formatDateTime } from '@/utils/format';
// import styles from './index.module.scss';

interface ControlPanelProps {
  timeRange: 'today' | 'week' | 'month';
  onTimeRangeChange: (range: 'today' | 'week' | 'month') => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  aiEnabled: boolean;
  onAiToggle: (enabled: boolean) => void;
  healthStatus: 'healthy' | 'warning' | 'error' | 'loading';
  healthMessage: string;
  lastUpdate: number | null;
  children?: React.ReactNode;
}

export default function ControlPanel({
  timeRange,
  onTimeRangeChange,
  autoRefresh,
  onAutoRefreshChange,
  aiEnabled,
  onAiToggle,
  healthStatus,
  healthMessage,
  lastUpdate,
  children,
}: ControlPanelProps) {
  return (
    <section className="control-panel">
      {/* 装饰性光点 */}
      <span className="decorative-dot"></span>
      <span className="decorative-dot"></span>

      <div className="control-panel-header">
        <div className="control-panel-left">
          <div className="control-panel-title">系统控制</div>
          <div className="filters">
            <button
              className={timeRange === 'today' ? 'active' : ''}
              onClick={() => onTimeRangeChange('today')}
            >
              本日
            </button>
            <button
              className={timeRange === 'week' ? 'active' : ''}
              onClick={() => onTimeRangeChange('week')}
            >
              近7天
            </button>
            <button
              className={timeRange === 'month' ? 'active' : ''}
              onClick={() => onTimeRangeChange('month')}
            >
              近30天
            </button>
          </div>
          <label className="toggle-switch">
            <span>🤖 智能回复</span>
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(e) => onAiToggle(e.target.checked)}
            />
            <span className={`status-text ${aiEnabled ? 'enabled' : 'disabled'}`}>
              {aiEnabled ? '已启用' : '已禁用'}
            </span>
          </label>
        </div>

        <div className="control-panel-right">
          <span
            className={`health-panel-badge ${healthStatus === 'healthy' ? '' : healthStatus === 'error' ? 'error' : 'warning'}`}
          >
            {healthMessage}
          </span>
          <label className="auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => onAutoRefreshChange(e.target.checked)}
            />
            自动刷新
          </label>
          <div className="last-update">
            <span className="status-indicator"></span>
            <span>{lastUpdate ? formatDateTime(lastUpdate) : '-'}</span>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}
