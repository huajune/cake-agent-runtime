import type { AgentToolCall } from '@agent/agent-run.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * 突兀拉群检测（observe 收判例）。
 *
 * 运营反馈簇（recvnlMW3l3OXp"没有说拒绝的原因，直接给人拉群了"、
 * recvnBYuVLIQsV"啥也不说原因，就拉人进群，太突兀了"、recvo6fD7wHcMA×3）：
 * invite_to_group 成功了，但回复没向候选人解释为什么拉群（没岗兜底/新岗通知），
 * 候选人会困惑是有岗还是没岗。
 *
 * 外生信号：本轮 invite_to_group 成功结果 + 回复文本是否含"拉群理由"表述。
 * "理由是否充分"本质是语义判断，确定性词组只能抓"完全没解释"的下限，
 * 所以先 observe 收判例校准误报率，不阻断。
 */

const INVITE_REASON_PATTERN =
  /暂时没有|暂无|没有(?:找到|太|完全)?(?:合适|匹配)|没找到|不太匹配|有(?:新|合适的?)[^。！？\n]{0,10}(?:通知|同步|告诉|推|说)|群里[^。！？\n]{0,8}(?:通知|同步|说|告诉|更新|第一时间)|第一时间|方便[^。！？\n]{0,10}(?:推荐|通知|同步)|(?:招聘|岗位)(?:信息)?更新|你(?:之前|刚才)?(?:说|同意|想)[^。！？\n]{0,8}(?:进群|入群|拉群)/;

/** 回复正面提及拉群动作时才判定；只说"群已满"等失败话术不属于本规则场景。 */
const INVITE_MENTION_PATTERN =
  /拉你|邀请(?:已|发)|进(?:了)?群|入群|加入[^。！？\n]{0,10}群|帮你.{0,6}群/;

export function detectGroupInviteWithoutReason(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const inviteCall = [...toolCalls].reverse().find((call) => call.toolName === 'invite_to_group');
  if (!inviteCall) return null;

  const result = asRecord(inviteCall.result);
  if (result?.success !== true) return null;
  // 已在群路径的 replyInstruction 要求不提群相关内容，不属于"突兀拉群"场景
  if (result.alreadyInGroup === true) return null;

  if (!INVITE_MENTION_PATTERN.test(text)) return null;
  if (INVITE_REASON_PATTERN.test(text)) return null;

  return {
    ruleId: 'group_invite_without_reason',
    label:
      '本轮已成功拉群/发送群邀请，但回复没有向候选人解释拉群原因（无岗兜底/新岗通知），观感突兀（badcase recvnBYuVLIQsV / recvnlMW3l3OXp）',
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}
