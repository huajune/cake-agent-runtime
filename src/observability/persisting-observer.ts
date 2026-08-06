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
  // 语义评审分母：每次 shadow/enforce 评审一条（日均几百），是评审"总运行次数"的可靠计数源
  // （guardrail_review_records 按 trace 稀疏存储，不天然是分母）
  'semantic_review',
  // 歧义词形现场：不写状态故 brand_state_change 看不见，量级=冲突别名频率（每天个位数）
  'brand_resolution_ambiguous',
  // 抽取臆造字段拦截：量级应接近零，出现即弱模型劣化信号，必须可查（不能只打日志）
  'extraction_field_dropped',
  // 候选人事实裁决档案：claim 接受率/拒绝原因分布是证据化 Phase 1/2 的核心观测
  'fact_adjudication',
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
