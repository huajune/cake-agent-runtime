import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
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
 * - 不凭回复文本猜候选人真实身份，只消费记忆里已有的学生事实与本轮明确自报；
 * - 不拦如实转述（"这家不招暑假工，帮你留意后续岗位"是正确口径）。
 *
 * 动作策略：诚信红线用 revise——把"改身份过审"改写为如实告知/维护候选人口径；
 * 改写失败宁可丢弃本轮，也不能把教唆话术发出去。
 */

// 可被改写的身份口径（引号可选）
const IDENTITY_REWRITE_TARGET =
  '["“”\'『「〈《]?(?:非暑假工|不是暑假工|长期兼职|长期工|非学生|不是学生|社会人士)';
const REGISTER_VERB = '(?:登记|填写?|报名|申报|上报|录入|提交)';

// "按/写成/填成/报成…『非暑假工』…登记" 与 "登记/填…成『非暑假工』" 两个语序
const IDENTITY_REWRITE_THEN_REGISTER_PATTERN = new RegExp(
  `(?:按|写成|填成|报成|改成|先按|当成?)[^。！？\\n]{0,10}${IDENTITY_REWRITE_TARGET}[^。！？\\n]{0,16}${REGISTER_VERB}`,
);
const REGISTER_AS_IDENTITY_PATTERN = new RegExp(
  `${REGISTER_VERB}[^。！？\\n]{0,8}(?:成|为|按)[^。！？\\n]{0,4}${IDENTITY_REWRITE_TARGET}`,
);
const AGENT_AUTOFILL_IDENTITY_PATTERN =
  /(?:身份[^。！？\n]{0,8})?(?:帮你|给你|替你)[^。！？\n]{0,8}(?:填|登记|录入)(?:了|成|为|成了)?[^。！？\n]{0,6}(?:社会人士|非学生|不是学生)/;

// "为了(顺利)通过(系统)审核" 的规避语境 + 同句身份改写登记：无论方向，一律违规。
// 必须同时出现身份改写目标，避免把“通过审核请如实填写”之类诚信提醒误判为教唆。
const AUDIT_EVASION_PREFIX =
  '为了[^。！？\\n]{0,10}(?:过|通过|好过|顺利过)[^。！？\\n]{0,6}(?:系统)?(?:审核|审查|校验)';
const AUDIT_EVASION_PATTERN = new RegExp(
  `${AUDIT_EVASION_PREFIX}(?:[^。！？\\n]{0,24}${IDENTITY_REWRITE_TARGET}[^。！？\\n]{0,16}${REGISTER_VERB}|[^。！？\\n]{0,24}${REGISTER_VERB}[^。！？\\n]{0,8}(?:成|为|按)[^。！？\\n]{0,4}${IDENTITY_REWRITE_TARGET})`,
);

// "别说/不要提 你是暑假工/学生" 类隐瞒建议
const IDENTITY_CONCEALMENT_PATTERN =
  /(?:先?别|不要|先不|不用)(?:说|提|告诉|透露)[^。！？\n]{0,12}(?:暑假工|暑期工|学生)/;

// “你回复一句不是暑假工，才能完成登记/预约”类指定口径诱导。
// 候选人是否为暑假工只能来自其自主原话，Agent 不得把否定答案塞进请求里让其复述。
const COERCED_SUMMER_DENIAL_PATTERN =
  /(?:回复|回|说|确认|填写?|写)[^。！？\n]{0,16}(?:不是暑假工|非暑假工|不是暑期工|非暑期工)[^。！？\n]{0,24}(?:才能|才可以|才可|就能|完成|提交|登记|预约)|(?:需要|必须)[^。！？\n]{0,16}(?:回复|回|说|确认)[^。！？\n]{0,12}(?:不是暑假工|非暑假工|不是暑期工|非暑期工)/;

const STUDENT_IDENTITY_RECLASSIFICATION_PATTERN =
  /(?:不算|不是|不属于)(?:在校)?学生(?:了|身份|本人|哈|吧|呀|哦|$|[，,。！？!?\n])|(?:按|算作|视为|当作?)(?:社会身份|社会人士)|(?:可以|能)[^。！？\n]{0,12}(?:按社会身份|做社会兼职|报社会兼职)/;

const EXPLICIT_NON_STUDENT_SELF_REPORT_PATTERN =
  /我(?:现在)?(?:不是学生|是社会人士|已经工作了|在上班)|身份(?:是|：|:)社会人士/;

function readBooleanFact(
  memorySnapshot: AgentMemorySnapshot | undefined,
  key: string,
): boolean | null {
  const fact = memorySnapshot?.sessionFacts?.[key];
  if (typeof fact === 'boolean') return fact;
  if (typeof fact !== 'object' || fact === null || !('value' in fact)) return null;
  const value = (fact as { value?: unknown }).value;
  return typeof value === 'boolean' ? value : null;
}

/**
 * 检测教唆候选人以不实身份登记/隐瞒身份的话术。
 *
 * 触发分三档：
 * 1. 审核规避语境（"为了过系统审核…登记"）→ 无条件违规；
 * 2. 隐瞒身份建议（"别说你是暑假工"）→ 无条件违规；
 * 3. 身份改写登记（"按非暑假工登记/登记成社会人士"）→ 本轮 precheck 存在
 *    暑假工守卫，或 bookingChecklist 仍把身份列为 missing 时违规。候选人身份已由
 *    precheck 明确确认时，如实登记不受影响。
 * 4. 记忆已确认学生，回复却自行宣布“不算学生/按社会身份”→ 无需本轮工具即可违规；
 *    仅候选人本轮明确自报“我不是学生/我是社会人士”时豁免陈旧记忆。
 */
export function detectIdentityMisregistrationCoaching(
  text: string,
  toolCalls: AgentToolCall[],
  memorySnapshot?: AgentMemorySnapshot,
  userMessage?: string,
): RuleContradiction | null {
  const auditEvasion = AUDIT_EVASION_PATTERN.test(text);
  const concealment = IDENTITY_CONCEALMENT_PATTERN.test(text);
  const coercedSummerDenial = COERCED_SUMMER_DENIAL_PATTERN.test(text);
  const identityRewrite =
    IDENTITY_REWRITE_THEN_REGISTER_PATTERN.test(text) ||
    REGISTER_AS_IDENTITY_PATTERN.test(text) ||
    AGENT_AUTOFILL_IDENTITY_PATTERN.test(text);
  const contradictsKnownStudentIdentity =
    readBooleanFact(memorySnapshot, 'interview.is_student') === true &&
    !EXPLICIT_NON_STUDENT_SELF_REPORT_PATTERN.test(userMessage?.trim() ?? '') &&
    STUDENT_IDENTITY_RECLASSIFICATION_PATTERN.test(text);

  if (
    !auditEvasion &&
    !concealment &&
    !coercedSummerDenial &&
    !identityRewrite &&
    !contradictsKnownStudentIdentity
  ) {
    return null;
  }

  if (!auditEvasion && !concealment && !coercedSummerDenial && !contradictsKnownStudentIdentity) {
    // 第 3 档需要 precheck 作为"身份尚未确认/身份冲突"的结构化佐证。
    // 扫描本轮全部 precheck，而不是只看最后一次：模型可能先命中守卫或 missingFields，
    // 随后通过代填身份再调一次把最后结果洗成 ready_to_book。
    const guardActive = toolCalls.some((call) => {
      if (call.toolName !== 'duliday_interview_precheck' || !call.result) return false;
      const result = asRecord(call.result);
      const guard = asRecord(result?.temporarySummerWorkerGuard);
      const checklist = asRecord(result?.bookingChecklist);
      const missingFields = Array.isArray(checklist?.missingFields) ? checklist.missingFields : [];
      const identityFieldGuard = asRecord(result?.identityFieldGuard);
      return (
        guard?.status === 'blocked_non_summer_job' ||
        guard?.status === 'needs_confirmation' ||
        missingFields.some((field) => field === '身份' || field === '是否学生') ||
        identityFieldGuard?.mustAskCandidate === true
      );
    });
    if (!guardActive) return null;
  }

  const reason = auditEvasion
    ? '审核规避语境（为了过系统审核…登记）'
    : concealment
      ? '建议候选人隐瞒暑假工/学生身份'
      : coercedSummerDenial
        ? '要求候选人复述“不是暑假工”以完成登记/预约'
        : contradictsKnownStudentIdentity
          ? '会话事实仍为学生，Agent 却擅自改判为非学生/社会人士'
          : '身份仍是 precheck 缺失字段时，Agent 擅自代填非学生/社会人士口径';
  return {
    ruleId: 'identity_misregistration_coaching',
    label:
      `回复在教唆候选人以不实身份登记或隐瞒身份（${reason}），属诚信红线。` +
      '必须改写为如实口径：候选人身份如实登记；岗位不匹配时如实告知暂无匹配岗位并维护候选人，不得指导绕过系统审核',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
