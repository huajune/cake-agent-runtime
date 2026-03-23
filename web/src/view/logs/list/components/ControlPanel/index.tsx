import { useState, useCallback } from 'react';
import { formatDuration } from '@/utils/format';

interface Stats {
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
}

interface ControlPanelProps {
  stats: Stats;
  activeTab: 'realtime' | 'slowest';
  onTabChange: (tab: 'realtime' | 'slowest') => void;
  realtimeCount: number;
  slowestCount: number;
  timeRange: 'today' | 'week' | 'month';
  onTimeRangeChange: (range: 'today' | 'week' | 'month') => void;
  searchUserName?: string;
  onSearchUserNameChange?: (userName: string) => void;
}

export default function ControlPanel({
  stats,
  activeTab,
  onTabChange,
  realtimeCount,
  slowestCount,
  timeRange,
  onTimeRangeChange,
  searchUserName = '',
  onSearchUserNameChange,
}: ControlPanelProps) {
  const [inputValue, setInputValue] = useState(searchUserName);

  // 防抖搜索
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setInputValue(value);
    },
    []
  );

  // 按回车时触发搜索
  const handleSearch = useCallback(() => {
    if (onSearchUserNameChange) {
      onSearchUserNameChange(inputValue.trim());
    }
  }, [inputValue, onSearchUserNameChange]);

  // 失焦时仅当搜索词变化才触发搜索（避免点击列表项时重复触发）
  const handleBlur = useCallback(() => {
    const trimmedValue = inputValue.trim();
    if (onSearchUserNameChange && trimmedValue !== searchUserName) {
      onSearchUserNameChange(trimmedValue);
    }
  }, [inputValue, searchUserName, onSearchUserNameChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleSearch();
      }
    },
    [handleSearch]
  );

  // 清空搜索
  const handleClear = useCallback(() => {
    setInputValue('');
    if (onSearchUserNameChange) {
      onSearchUserNameChange('');
    }
  }, [onSearchUserNameChange]);
  return (
    <section
      className="control-panel"
      style={{
        marginBottom: '20px',
        padding: '16px 20px',
      }}
    >
      {/* 单行布局：标题 + 统计 + Tab切换 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '24px',
        }}
      >
        {/* 左侧：标题 */}
        <h3
          style={{
            margin: 0,
            fontSize: '15px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: '16px' }}>💬</span>
          消息记录
        </h3>

        {/* 分隔线 */}
        <div style={{ width: '1px', height: '24px', background: 'var(--border)' }} />

        {/* 时间筛选 */}
        <div
          style={{
            display: 'flex',
            background: 'var(--bg-secondary)',
            borderRadius: '8px',
            padding: '3px',
          }}
        >
          <button
            onClick={() => onTimeRangeChange('today')}
            style={{
              padding: '6px 12px',
              background: timeRange === 'today' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              color: timeRange === 'today' ? 'var(--primary)' : 'var(--text-muted)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: timeRange === 'today' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            今天
          </button>
          <button
            onClick={() => onTimeRangeChange('week')}
            style={{
              padding: '6px 12px',
              background: timeRange === 'week' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              color: timeRange === 'week' ? 'var(--primary)' : 'var(--text-muted)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: timeRange === 'week' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            近7天
          </button>
          <button
            onClick={() => onTimeRangeChange('month')}
            style={{
              padding: '6px 12px',
              background: timeRange === 'month' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              color: timeRange === 'month' ? 'var(--primary)' : 'var(--text-muted)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: timeRange === 'month' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            近30天
          </button>
        </div>

        {/* 分隔线 */}
        <div style={{ width: '1px', height: '24px', background: 'var(--border)' }} />

        {/* 用户搜索框 */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="搜索用户昵称..."
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            style={{
              width: '160px',
              padding: '6px 30px 6px 12px',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              fontSize: '13px',
              color: 'var(--text-primary)',
              background: 'var(--bg-secondary)',
              outline: 'none',
              transition: 'border-color 0.15s ease',
            }}
          />
          {inputValue && (
            <button
              onClick={handleClear}
              style={{
                position: 'absolute',
                right: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                fontSize: '14px',
                padding: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="清空搜索"
            >
              ×
            </button>
          )}
        </div>

        {/* 分隔线 */}
        <div style={{ width: '1px', height: '24px', background: 'var(--border)' }} />

        {/* 统计数据 - 紧凑横向排列 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>总计</span>
            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--primary)' }}>
              {stats.total}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>成功</span>
            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--success)' }}>
              {stats.success}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>失败</span>
            <span
              style={{
                fontSize: '15px',
                fontWeight: 700,
                color: stats.failed > 0 ? 'var(--danger)' : 'var(--text-muted)',
              }}
            >
              {stats.failed}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>首响</span>
            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--warning)' }}>
              {formatDuration(stats.avgDuration)}
            </span>
          </div>
        </div>

        {/* 弹性空间 */}
        <div style={{ flex: 1 }} />

        {/* Tab 切换 - 简洁样式 */}
        <div
          style={{
            display: 'flex',
            background: 'var(--bg-secondary)',
            borderRadius: '8px',
            padding: '3px',
          }}
        >
          <button
            onClick={() => onTabChange('realtime')}
            style={{
              padding: '6px 14px',
              background: activeTab === 'realtime' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              color: activeTab === 'realtime' ? 'var(--primary)' : 'var(--text-muted)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: activeTab === 'realtime' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            实时 {realtimeCount}
          </button>
          <button
            onClick={() => onTabChange('slowest')}
            style={{
              padding: '6px 14px',
              background: activeTab === 'slowest' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              color: activeTab === 'slowest' ? 'var(--danger)' : 'var(--text-muted)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: activeTab === 'slowest' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            最慢 Top{slowestCount}
          </button>
        </div>
      </div>
    </section>
  );
}
