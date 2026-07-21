import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AgentEvent, Observer } from './observer.interface';
import {
  AGENT_EVENT_PERSISTER,
  type AgentEventPersister,
} from './persistence/agent-event-persister.interface';

const ALWAYS_PERSISTED_EVENT_TYPES = new Set<AgentEvent['type']>([
  'agent_end',
  'agent_error',
  'model_fallback',
  'tool_error',
  // 品牌状态迁移：仅状态变化时发射，前后快照不可重放，必须落库（§12）
  'brand_state_change',
  // 语义评审分母：每次 shadow/enforce 评审一条（日均几百），pass 判例仅此一处可查
  'semantic_review',
  // 新旧品牌匹配差异（临时，随旧路径下线删除）：目录时变不可离线重放（§12/§15.6）
  'brand_resolution_shadow_diff',
  // 上者的分母：每 100 次一致落一条，二者相除即 §15.6 的差异率门禁（临时，同批下线）
  'brand_resolution_shadow_agreement',
  // 歧义词形现场：不写状态故 brand_state_change 看不见，量级=冲突别名频率（每天个位数）
  'brand_resolution_ambiguous',
]);

const SLOW_TOOL_THRESHOLD_MS = 3000;

@Injectable()
export class PersistingObserver implements Observer, OnApplicationBootstrap {
  private readonly logger = new Logger(PersistingObserver.name);
  private persister?: AgentEventPersister;

  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    try {
      this.persister = this.moduleRef.get<AgentEventPersister>(AGENT_EVENT_PERSISTER, {
        strict: false,
      });
    } catch {
      this.logger.warn('AGENT_EVENT_PERSISTER 未注册，Agent 执行事件将仅写日志');
    }
  }

  emit(event: AgentEvent): void {
    if (!this.persister || !this.shouldPersist(event)) return;

    void this.persister.persist(event).catch((error: unknown) => {
      this.logger.warn(
        `[agent-events] 持久化失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private shouldPersist(event: AgentEvent): boolean {
    if (ALWAYS_PERSISTED_EVENT_TYPES.has(event.type)) return true;
    if (event.type !== 'tool_call') return false;

    return (
      event.sideEffect === true ||
      event.status === 'error' ||
      (event.durationMs ?? 0) >= SLOW_TOOL_THRESHOLD_MS
    );
  }
}
