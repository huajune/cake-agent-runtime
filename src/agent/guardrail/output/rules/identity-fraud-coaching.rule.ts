import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * 身份造假教唆规则。
 *
 * 职责：
 * - 拦 "为了通过系统审核，把候选人身份按不实口径登记" 的教唆话术
 *   （badcase chat 6a50827c：暑假工候选人被建议"按'非暑假工（长期兼职）'登记上去，
 *   面试时你跟店长如实说下暑期能做两个月就行"，由真人经理手动拦下）；
 * - 拦 "别说你是暑假工/学生" 类隐瞒身份建议。
 *
 * 不负责：
 * - 不判断候选人真实身份是什么（那是 precheck 身份粘性的职责）；
 * - 不拦如实转述（"这家不招暑假工，帮你留意后续岗位"是正确口径）。
 *
 * 动作策略：诚信红线用 revise——把"改身份过审"改写为如实告知/维护候选人口径；
 * 改写失败宁可丢弃本轮，也不能把教唆话术发出去。
 */

// 可被改写的身份口径（引号可选）
const IDENTITY_REWRITE_TARGET =
  '["“”\'『「〈《]?(?:非暑假工|不是暑假工|长期兼职|长期工|非学生|不是学生|社会人士)';
const REGISTER_VERB = '(?:登记|填写?|报名|申报|上报|录入|提交|报)';

// "按/写成/填成/报成…『非暑假工』…登记" 与 "登记/填…成『非暑假工』" 两个语序
const IDENTITY_REWRITE_THEN_REGISTER_PATTERN = new RegExp(
  `(?:按|写成|填成|报成|改成|先按|当成?)[^。！？\\n]{0,10}${IDENTITY_REWRITE_TARGET}[^。！？\\n]{0,16}${REGISTER_VERB}`,
);
const REGISTER_AS_IDENTITY_PATTERN = new RegExp(
  `${REGISTER_VERB}[^。！？\\n]{0,8}(?:成|为|按)[^。！？\\n]{0,4}${IDENTITY_REWRITE_TARGET}`,
);

// "为了(顺利)通过(系统)审核" 的规避语境 + 同句登记动作：无论方向，一律违规
const AUDIT_EVASION_PATTERN = new RegExp(
  `为了[^。！？\\n]{0,10}(?:过|通过|好过|顺利过)[^。！？\\n]{0,6}(?:系统)?(?:审核|审查|校验)[^。！？\\n]{0,24}${REGISTER_VERB}`,
);

// "别说/不要提 你是暑假工/学生" 类隐瞒建议
const IDENTITY_CONCEALMENT_PATTERN =
  /(?:先?别|不要|先不|不用)(?:说|提|告诉|透露)[^。！？\n]{0,12}(?:暑假工|暑期工|学生)/;

/**
 * 检测教唆候选人以不实身份登记/隐瞒身份的话术。
 *
 * 触发分三档：
 * 1. 审核规避语境（"为了过系统审核…登记"）→ 无条件违规；
 * 2. 隐瞒身份建议（"别说你是暑假工"）→ 无条件违规；
 * 3. 身份改写登记（"按非暑假工登记/登记成社会人士"）→ 仅当本轮 precheck 存在
 *    暑假工守卫状态（blocked/needs_confirmation）时违规——守卫在场说明身份
 *    未解或已确认暑假工，此时改写登记就是绕守卫；候选人真是非暑假工时守卫
 *    返回 null，如实登记不受影响。
 */
export function detectIdentityMisregistrationCoaching(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const auditEvasion = AUDIT_EVASION_PATTERN.test(text);
  const concealment = IDENTITY_CONCEALMENT_PATTERN.test(text);
  const identityRewrite =
    IDENTITY_REWRITE_THEN_REGISTER_PATTERN.test(text) || REGISTER_AS_IDENTITY_PATTERN.test(text);

  if (!auditEvasion && !concealment && !identityRewrite) return null;

  if (!auditEvasion && !concealment) {
    // 第 3 档需要守卫在场作为"身份不实"的结构化佐证
    const precheckCall = [...toolCalls]
      .reverse()
      .find((call) => call.toolName === 'duliday_interview_precheck' && call.result);
    const result = asRecord(precheckCall?.result);
    const guard = asRecord(result?.temporarySummerWorkerGuard);
    const guardActive =
      guard?.status === 'blocked_non_summer_job' || guard?.status === 'needs_confirmation';
    if (!guardActive) return null;
  }

  const reason = auditEvasion
    ? '审核规避语境（为了过系统审核…登记）'
    : concealment
      ? '建议候选人隐瞒暑假工/学生身份'
      : '暑假工守卫在场时建议按非暑假工/社会人士口径登记';
  return {
    ruleId: 'identity_misregistration_coaching',
    label:
      `回复在教唆候选人以不实身份登记或隐瞒身份（${reason}），属诚信红线。` +
      '必须改写为如实口径：候选人身份如实登记；岗位不匹配时如实告知暂无匹配岗位并维护候选人，不得指导绕过系统审核',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
