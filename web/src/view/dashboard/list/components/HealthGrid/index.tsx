import type { HealthStatus } from '@/api/types/agent.types';
import type { WorkerStatus } from '@/api/types/monitoring.types';
import styles from './index.module.scss';

interface HealthGridProps {
  health?: HealthStatus;
  workerStatus?: WorkerStatus;
}

export default function HealthGrid({ health, workerStatus }: HealthGridProps) {
  const getHealthState = (isHealthy: boolean | undefined): string => {
    if (isHealthy === undefined) return 'loading';
    return isHealthy ? 'healthy' : 'warning';
  };

  return (
    <div className={`health-grid ${styles.healthGrid}`}>
      {/* 1. Agent 服务 */}
      <article
        className={`health-item ${styles.healthItem}`}
        data-state={getHealthState(health?.status === 'healthy')}
      >
        <div className={styles.healthIcon}>🛰️</div>
        <div className={styles.healthInfo}>
          <div className={styles.healthTitle}>Agent 服务</div>
          <div className={styles.healthStatus}>
            {health?.status === 'healthy'
              ? '运行正常'
              : health?.status === 'degraded'
                ? '服务降级'
                : health?.status === 'unhealthy'
                  ? '服务异常'
                  : '-'}
          </div>
          <div className={styles.healthDesc}>{health?.message || '检查中...'}</div>
        </div>
      </article>

      {/* 2. AI 模型 */}
      <article
        className={`health-item ${styles.healthItem}`}
        data-state={getHealthState(health?.providers && health.providers.count > 0)}
      >
        <div className={styles.healthIcon}>🤖</div>
        <div className={styles.healthInfo}>
          <div className={styles.healthTitle}>AI 模型</div>
          <div className={styles.healthStatus}>
            {health?.providers && health.providers.count > 0 ? '服务可用' : health ? '需关注' : '-'}
          </div>
          <div className={styles.healthDesc}>
            {health?.providers
              ? `${health.providers.count} Provider / ${health.roles.count} 角色`
              : '检查中...'}
          </div>
        </div>
      </article>

      {/* 3. 工具服务 */}
      <article
        className={`health-item ${styles.healthItem}`}
        data-state={getHealthState(health?.tools && health.tools.total > 0)}
      >
        <div className={styles.healthIcon}>🧰</div>
        <div className={styles.healthInfo}>
          <div className={styles.healthTitle}>工具服务</div>
          <div className={styles.healthStatus}>
            {health?.tools && health.tools.total > 0 ? '响应正常' : health ? '需关注' : '-'}
          </div>
          <div className={styles.healthDesc}>
            {health?.tools
              ? `${health.tools.builtInCount} 内置${health.tools.mcpCount > 0 ? ` + ${health.tools.mcpCount} MCP` : ''}`
              : '检查中...'}
          </div>
        </div>
      </article>

      {/* 4. 消息队列 */}
      <article
        className={`health-item ${styles.healthItem}`}
        data-state={getHealthState(workerStatus !== undefined)}
      >
        <div className={styles.healthIcon}>📨</div>
        <div className={styles.healthInfo}>
          <div className={styles.healthTitle}>消息队列</div>
          <div className={styles.healthStatus}>
            {workerStatus ? (workerStatus.activeJobs > 0 ? '处理中' : '空闲') : '-'}
          </div>
          <div className={styles.healthDesc}>
            {workerStatus
              ? `并发 ${workerStatus.concurrency} / 活跃 ${workerStatus.activeJobs}`
              : '检查中...'}
          </div>
        </div>
      </article>
    </div>
  );
}
