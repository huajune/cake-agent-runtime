import AnalyticsControlFilters, {
  type AnalyticsRangeOption,
} from '@/components/AnalyticsControlFilters';
import { formatDateTime } from '@/utils/format';
import type { DashboardTimeRange } from '@/api/types/analytics.types';
// import styles from './index.module.scss';

interface ControlPanelProps {
  timeRange: DashboardTimeRange;
  onTimeRangeChange: (range: DashboardTimeRange) => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  groups: string[];
  onGroupsChange: (groups: string[]) => void;
  healthStatus: 'healthy' | 'warning' | 'error' | 'loading';
  healthMessage: string;
  lastUpdate: number | null;
  children?: React.ReactNode;
}

const TIME_RANGE_OPTIONS: Array<AnalyticsRangeOption<DashboardTimeRange>> = [
  { key: 'today', label: '本日' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '近30天' },
  { key: 'twoMonths', label: '近2月' },
  { key: 'threeMonths', label: '近3月' },
];

export default function ControlPanel({
  timeRange,
  onTimeRangeChange,
  autoRefresh,
  onAutoRefreshChange,
  groups,
  onGroupsChange,
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
          <AnalyticsControlFilters
            range={timeRange}
            rangeOptions={TIME_RANGE_OPTIONS}
            onRangeChange={onTimeRangeChange}
            groups={groups}
            onGroupsChange={onGroupsChange}
          />
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
