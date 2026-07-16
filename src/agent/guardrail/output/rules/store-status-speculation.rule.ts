import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

const UNSUPPORTED_STORE_STATUS_PATTERN =
  /(?:可能|应该|估计|大概|也许|或许|看起来)?(?:已经|都|暂时)?(?:(?:招满|招完|不招了|停止招聘|关店|关了|搬了|装修|撤店|下架)|(?:门店|岗位)(?:那边|这边)?(?:有|做了|出现)?(?:调整|变动|变化))/u;

function hasNoMatchScript(call: AgentToolCall): boolean {
  if (call.toolName !== 'duliday_job_list' || call.status === 'error') return false;
  if (!call.result || typeof call.result !== 'object') return false;
  const noMatchScript = (call.result as Record<string, unknown>).noMatchScript;
  return Boolean(noMatchScript && typeof noMatchScript === 'object');
}

/**
 * noMatchScript 只能证明当前查询没有匹配岗位，不能证明门店已经招满、关店、搬迁或调整。
 * 规则仅在本轮岗位工具明确返回 noMatchScript 时生效，避免拦截有其它事实来源的表达。
 */
export function detectUnsupportedStoreStatusSpeculation(
  replyText: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!UNSUPPORTED_STORE_STATUS_PATTERN.test(replyText)) return null;
  if (!toolCalls.some(hasNoMatchScript)) return null;

  return {
    ruleId: 'unsupported_store_status_speculation',
    label:
      '岗位工具只返回了 noMatchScript，无法证明门店已招满、关店、搬迁或装修；' +
      '只能说明当前暂时没查到匹配的在招岗位',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
