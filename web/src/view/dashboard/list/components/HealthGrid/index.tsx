import { useState } from 'react';
import type { HealthStatus } from '@/api/types/agent.types';
import type { AvailableModelsResponse, ConfiguredToolsResponse } from '@/api/services/agent.service';
import type { WorkerStatus } from '@/api/types/monitoring.types';
import styles from './index.module.scss';

interface HealthGridProps {
  health?: HealthStatus;
  modelsData?: AvailableModelsResponse;
  toolsData?: ConfiguredToolsResponse;
  workerStatus?: WorkerStatus;
}

export default function HealthGrid({ health, modelsData, toolsData, workerStatus }: HealthGridProps) {
  const [hoveredCard, setHoveredCard] = useState<'agent' | 'model' | 'tool' | 'queue' | null>(null);

  const getHealthState = (isHealthy: boolean | undefined): string => {
    if (isHealthy === undefined) return 'loading';
    return isHealthy ? 'healthy' : 'warning';
  };

  return (
    <div className={`health-grid ${styles.healthGrid}`}>
      {/* 1. Agent 服务 */}
      <article
        className={`health-item ${styles.healthItem} ${styles.hoverable}`}
        data-state={getHealthState(health?.status === 'healthy')}
        onMouseEnter={() => setHoveredCard('agent')}
        onMouseLeave={() => setHoveredCard(null)}
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
        {hoveredCard === 'agent' && health?.checks && (
          <div className={styles.healthTooltip}>
            <div className={styles.tooltipTitle}>依赖检测</div>
            <div className={styles.tooltipContent}>
              <ul className={styles.tooltipList}>
                <li>
                  {health.checks.redis ? '✅' : '❌'} Redis（消息队列）
                </li>
                <li>
                  {health.checks.supabase ? '✅' : '❌'} Supabase（数据库）
                </li>
              </ul>
            </div>
          </div>
        )}
      </article>

      {/* 2. AI 模型 */}
      <article
        className={`health-item ${styles.healthItem} ${styles.hoverable}`}
        data-state={getHealthState(health?.providers && health.providers.count > 0)}
        onMouseEnter={() => setHoveredCard('model')}
        onMouseLeave={() => setHoveredCard(null)}
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
        {hoveredCard === 'model' && health?.roles && (
          <div className={styles.healthTooltip}>
            <div className={styles.tooltipTitle}>角色 → 模型映射</div>
            <div className={styles.tooltipContent}>
              <ul className={styles.tooltipList}>
                {Object.entries(health.roles.details).map(([role, config]) => (
                  <li key={role}>
                    <span className={styles.roleLabel}>{role}</span>
                    <span className={styles.modelName}>{config.model.split('/').pop()}</span>
                  </li>
                ))}
              </ul>
            </div>
            {modelsData && (
              <div className={styles.tooltipFooter}>
                共 {modelsData.availableModels.length} 个可用模型
              </div>
            )}
          </div>
        )}
      </article>

      {/* 3. 工具服务 */}
      <article
        className={`health-item ${styles.healthItem} ${styles.hoverable}`}
        data-state={getHealthState(health?.tools && health.tools.total > 0)}
        onMouseEnter={() => setHoveredCard('tool')}
        onMouseLeave={() => setHoveredCard(null)}
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
        {hoveredCard === 'tool' && (toolsData || health?.tools) && (
          <div className={styles.healthTooltip}>
            <div className={styles.tooltipTitle}>工具列表</div>
            <div className={styles.tooltipContent}>
              {health?.tools && health.tools.builtIn.length > 0 && (
                <ul className={styles.tooltipList}>
                  {health.tools.builtIn.map((tool) => (
                    <li key={tool}>{tool}</li>
                  ))}
                </ul>
              )}
              {health?.tools && health.tools.mcp.length > 0 && (
                <>
                  <div className={styles.tooltipSubtitle}>MCP 工具</div>
                  <ul className={styles.tooltipList}>
                    {health.tools.mcp.map((tool) => (
                      <li key={tool}>{tool}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className={styles.tooltipFooter}>
              共 {health?.tools?.total ?? toolsData?.count ?? 0} 个工具
            </div>
          </div>
        )}
      </article>

      {/* 4. 消息队列 */}
      <article
        className={`health-item ${styles.healthItem} ${styles.hoverable}`}
        data-state={getHealthState(workerStatus !== undefined)}
        onMouseEnter={() => setHoveredCard('queue')}
        onMouseLeave={() => setHoveredCard(null)}
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
        {hoveredCard === 'queue' && workerStatus && (
          <div className={styles.healthTooltip}>
            <div className={styles.tooltipTitle}>队列状态</div>
            <div className={styles.tooltipContent}>
              <ul className={styles.tooltipList}>
                <li>当前并发: {workerStatus.concurrency}</li>
                <li>活跃任务: {workerStatus.activeJobs}</li>
                <li>并发范围: {workerStatus.minConcurrency} - {workerStatus.maxConcurrency}</li>
                <li>消息聚合: {workerStatus.messageMergeEnabled ? '已启用' : '已禁用'}</li>
              </ul>
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
