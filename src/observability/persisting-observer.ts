import { toErrorMessage } from '@infra/utils/error.util';
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
  // LLM 尝试轨迹：条件采样（下方 shouldPersist）会漏掉本事件要抓的重试与慢尝试
  'llm_execution',
  // 品牌状态迁移：仅状态变化时发射，前后快照不可重放，必须落库（§12）
  'brand_state_change',
  // 歧义词形现场：不写状态故 brand_state_change 看不见，量级=冲突别名频率（每天个位数）
  'brand_resolution_ambiguous',
  // 落盘态字段被逐字段校验丢弃：Redis 是 facts（含 brand）/terminal 的唯一事实源，
  // 丢一个字段就是丢一段事实（terminal 丢了复聊会去骚扰已约面的人）。量级应恒为零，
  // 非零即存储完整性事故——只打日志等于没发生（记忆审计风险点 8）。
  'session_state_field_dropped',
  // 收资表单审计：公证拒收/判不合格/改口/配置债/熔断。拒收量是臆造防线的验收指标，
  // escalated 量是死锁根治的验收指标——生产 collectionStalled 此前只有 logger.warn，
  // 正是 0819 排障实测撞上的观测盲区（§10.1 观测配套）。
  'collection_form_audit',
  // 身份锚点断链与空标签岗：两者量级都应恒为零，非零即上游数据/配置出事。
  'collection_identity_anchor_mismatch',
  'collection_empty_contract',
  // 守卫过程（观测 P1-2）：repair 四种终局与入站拦截此前只有 logger.warn，
  // 每回合至多各一条，量级可控；正文不进事件。
  'guardrail_repair',
  'inbound_guardrail_block',
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
      this.logger.warn(`[agent-events] 持久化失败: ${toErrorMessage(error)}`);
    });
  }

  private shouldPersist(event: AgentEvent): boolean {
    if (ALWAYS_PERSISTED_EVENT_TYPES.has(event.type)) return true;
    if (event.type !== 'tool_call') return false;

    // empty / narrow（观测 P1-4）：假无岗与窄召回的历史趋势只有这里能留下来——
    // mpr.tool_calls 七天后 NULL 化，事件表是唯一长期来源。量约 +250 条/天。
    return (
      event.sideEffect === true ||
      event.status === 'error' ||
      event.status === 'empty' ||
      event.status === 'narrow' ||
      (event.durationMs ?? 0) >= SLOW_TOOL_THRESHOLD_MS
    );
  }
}
