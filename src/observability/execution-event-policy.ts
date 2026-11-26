import { asRecord, asRecordArray } from '@infra/utils/object.util';
import type { AgentEvent } from './observer.interface';

type Payload = Record<string, unknown>;
type ObservationPolicy = string | null | ((payload: Payload) => string | undefined);

function toolObservation(event: Payload): string | undefined {
  const reasons = [];
  if (event.sideEffect === true) reasons.push('涉及外部业务动作');
  if (event.status === 'error') reasons.push('工具返回错误');
  if (event.status === 'empty') reasons.push('工具返回空结果');
  if (event.status === 'narrow') reasons.push('搜索只返回一个结果');
  if (typeof event.durationMs === 'number' && event.durationMs >= 3_000)
    reasons.push('工具耗时达到 3 秒');
  return reasons.join('、') || undefined;
}

/** 常规装配也会耗费数秒；数据源、装配和提示词体积各自按历史基线设置门槛。 */
function sourceObservation(event: Payload): string | undefined {
  const reasons = [];
  if (event.status === 'failure') reasons.push('读取回合数据源失败');
  if (
    asRecordArray(event.sources).some(
      (source) => source.status === 'degraded' || source.status === 'failed',
    )
  ) {
    reasons.push('有数据源降级或失败');
  }
  if (typeof event.totalDurationMs === 'number' && event.totalDurationMs >= 15_000)
    reasons.push('读取数据源耗时达到 15 秒');
  return reasons.join('、') || undefined;
}

function preparationObservation(event: Payload): string | undefined {
  const reasons = [];
  if (event.status === 'failure') reasons.push('回合装配失败');
  if (typeof event.totalDurationMs === 'number' && event.totalDurationMs >= 20_000)
    reasons.push('回合装配耗时达到 20 秒');
  const chars = asRecord(event.prompt)?.totalChars;
  if (typeof chars === 'number' && chars >= 50_000) reasons.push('提示词达到 5 万字符');
  return reasons.join('、') || undefined;
}

// 字符串表示每次发出均留存，函数只收录命中条件的事件，null 表示只写日志。
// 加入新事件时须同时决定运营能从中核查什么，以及哪些情况值得进时间线。
const policies: Record<AgentEvent['type'], ObservationPolicy> = {
  agent_start: null,
  agent_end: '核对回合正常收尾时的步数、用量和耗时',
  agent_error: '排查回合执行异常',
  agent_stream_timing: null,
  model_call: null,
  model_fallback: '核查模型切换及其原因',
  llm_execution: '核对模型实际尝试、重试与退避',
  tool_call: toolObservation,
  tool_error: '工具抛出异常',
  turn_data_sources: sourceObservation,
  turn_preparation: preparationObservation,
  candidate_progress_difference: '核查两种候选人进度判定的分歧',
  booking_snapshot: null,
  oob_reconcile_scan: null,
  prompt_injection_detected: '核查提示词注入规则命中及告警结果',
  brand_state_change: '回看会话品牌范围变更',
  brand_resolution_ambiguous: '核查品牌别名歧义',
  session_state_field_dropped: '排查会话字段校验失败',
  schedule_extraction_disagreement: '核查班次抽取与工具核验的分歧',
  collection_form_audit: '回看收资表单的处理决定',
  collection_identity_anchor_mismatch: '核查收资字段与身份标签的对应关系',
  collection_empty_contract: '核查岗位返回空收资配置',
  guardrail_repair: '回看出站守卫修复及最终处置',
  inbound_guardrail_handoff: '核查入站风险触发转人工的依据',
};

/** 写入与详情共用同一口径。未知的历史类型仍由详情原样展示。 */
export function executionObservationReason(type: string, payload: unknown): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(policies, type)) return undefined;
  const policy = policies[type as AgentEvent['type']];
  return typeof policy === 'function' ? policy(asRecord(payload) ?? {}) : (policy ?? undefined);
}
