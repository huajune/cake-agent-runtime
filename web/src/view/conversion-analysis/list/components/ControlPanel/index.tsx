import { RefreshCw, Sparkles, TrendingUp, Zap } from 'lucide-react';
import AnalyticsControlFilters from '@/components/AnalyticsControlFilters';
import type { ConversionRange } from '@/api/types/conversion-analytics.types';
import heroArt from '@/assets/images/conversion-growth-hero.png';
import { formatDateTime } from '@/utils/format';
import HeroParticles from '../HeroParticles';
import { TIME_RANGE_OPTIONS } from '../../types';
import styles from '../../styles/index.module.scss';

interface ControlPanelProps {
  range: ConversionRange;
  groups: string[];
  lastUpdate: number | null;
  onRangeChange: (range: ConversionRange) => void;
  onGroupsChange: (groups: string[]) => void;
}

export default function ControlPanel({
  range,
  groups,
  lastUpdate,
  onRangeChange,
  onGroupsChange,
}: ControlPanelProps) {
  return (
    <section className={styles.heroPanel}>
      <img className={styles.heroImage} src={heroArt} alt="" aria-hidden="true" />
      <HeroParticles />

      <div className={styles.heroContent}>
        <div className={styles.heroEyebrow}>
          <Sparkles size={15} />
          <span>智能招聘 · 转化分析</span>
        </div>
        <h1>转化分析</h1>
        <p>按时间范围和小组查看新增好友到面试通过的转化表现。</p>
        <div className={styles.heroMeta}>
          <span>
            <TrendingUp size={14} />
            实时漏斗
          </span>
          <span>
            <Zap size={14} />
            账号对比
          </span>
          <span>
            <RefreshCw size={14} />
            {lastUpdate ? `静默刷新 · ${formatDateTime(lastUpdate)}` : '静默刷新中'}
          </span>
        </div>
      </div>

      <div className={styles.toolbar}>
        <AnalyticsControlFilters
          range={range}
          rangeOptions={TIME_RANGE_OPTIONS}
          onRangeChange={onRangeChange}
          groups={groups}
          onGroupsChange={onGroupsChange}
          groupSelectionMode="single"
        />
      </div>
    </section>
  );
}
