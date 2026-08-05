import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * 敏感筛选拒绝翻案规则。
 *
 * badcase weurg1xg（chat 6a6c688b…，2026-07-31）：precheck 明确返回
 * nextAction="household_rejected"（户籍与岗位内部硬约束冲突），模型却抓住
 * ageBoundary=pass 回复"不是年龄问题，39岁符合的…刚才是我这边确认有误，
 * 我帮你预约果蔬好收银员"——把工具的结构化拒绝翻案成"条件符合"并继续承诺
 * 报名，候选人被反复拉扯后流失（最终真人经理接管收尾）。
 *
 * 职责（仅限本轮工具证据，跨轮口径粘性归 prompt 治理）：
 * - 本轮 precheck 返回四类敏感拒绝态（age/student/household/health_certificate
 *   _rejected）或 booking 返回 booking.rejected 时：
 *   a) 拦"确认有误/看错了/条件是符合的"类翻案话术；
 *   b) 拦对被拒岗位（按品牌/门店/岗位名绑定）的继续预约/报名承诺。
 *
 * 不负责：
 * - 转推其它岗位的正常承诺不拦（句级绑定被拒岗位名，转推肯德基不会命中果蔬好）；
 * - 部分条件的如实说明不拦（"39岁是符合的"不含"条件符合"整体翻案语义）；
 * - 无本轮拒绝证据时不触发。
 */

const REJECTED_NEXT_ACTIONS = new Set([
  'age_rejected',
  'student_rejected',
  'household_rejected',
  'health_certificate_rejected',
]);

// "刚才是我这边确认有误 / 是我看错了" 类翻案表述。这一支不做岗位绑定：
// 该词形本身就是对本轮拒绝结论的推翻，与具体岗位名无关。
const REJECTION_SELF_CORRECTION_PATTERN = /(?:确认|核实|看)(?:有误|错了?)/u;

// "你的条件是符合的" 类翻案表述。这一支必须做句级岗位绑定：被拒后转推其它岗位
// 是本规则 label 亲自要求的正确动作，而合规转推常带"肯德基这家你条件是符合的"
// ——不绑定会把处方本身打成违规（评审 874 实证假阳）。绑定判据：翻案句里出现
// 被拒岗位的名称 token 才算翻案；booking.rejected 无岗位名可绑时维持整句判定。
// 代价：不点名的裸"你条件是符合的"翻案漏过——生产 badcase 里该形态总是伴随
// "确认有误"或对被拒岗位的点名承诺出现，由另两支兜住。
const CONDITION_REVERSAL_PATTERN = /条件(?:是|都)?(?:符合|没问题|满足)/u;

// "帮你预约/报名/登记/提交" 类推进承诺（句级与被拒岗位名共现才算）
const BOOKING_PROMISE_PATTERN = /(?:帮|给|替)你(?:预约|约面?|报名?|登记|提交)/u;

interface RejectedJobRef {
  nameTokens: string[];
}

function collectRejectedJobs(toolCalls: AgentToolCall[]): {
  rejected: boolean;
  bookingRejected: boolean;
  bookingSucceeded: boolean;
  jobs: RejectedJobRef[];
} {
  const jobs: RejectedJobRef[] = [];
  let rejected = false;
  let bookingRejected = false;
  let bookingSucceeded = false;
  for (const call of toolCalls) {
    const result = asRecord(call.result);
    if (!result) continue;
    if (
      call.toolName === 'duliday_interview_precheck' &&
      typeof result.nextAction === 'string' &&
      REJECTED_NEXT_ACTIONS.has(result.nextAction)
    ) {
      rejected = true;
      const job = asRecord(result.job);
      const nameTokens = [job?.brandName, job?.storeName, job?.jobName]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .flatMap((value) => value.split(/[-·（）()\s]/u))
        .filter((token) => token.length >= 2);
      if (nameTokens.length > 0) jobs.push({ nameTokens: [...new Set(nameTokens)] });
    }
    if (call.toolName === 'duliday_interview_booking' && result.errorType === 'booking.rejected') {
      rejected = true;
      bookingRejected = true;
    }
    if (call.toolName === 'duliday_interview_booking' && result.success === true) {
      bookingSucceeded = true;
    }
  }
  return { rejected, bookingRejected, bookingSucceeded, jobs };
}

/**
 * 检测本轮敏感筛选拒绝后，回复翻案或继续承诺被拒岗位的话术。
 */
export function detectScreeningRejectionOverride(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const { rejected, bookingRejected, bookingSucceeded, jobs } = collectRejectedJobs(toolCalls);
  if (!rejected) return null;

  const conditionReversal = text.split(/[。！？\n]/u).some((sentence) => {
    if (!CONDITION_REVERSAL_PATTERN.test(sentence)) return false;
    if (jobs.length === 0) return true;
    return jobs.some((job) => job.nameTokens.some((token) => sentence.includes(token)));
  });
  const reversal = REJECTION_SELF_CORRECTION_PATTERN.test(text) || conditionReversal;
  // booking.rejected 的既有错误结构只有 jobId，没有可用于回复句绑定的岗位名。
  // 该工具已经明确拒绝了本轮预约，因此之后仍出现预约/报名承诺就属于同一失败
  // 动作的错误回执；不能因 jobs 为空而漏过。
  const promiseAfterBookingRejection =
    bookingRejected && !bookingSucceeded && BOOKING_PROMISE_PATTERN.test(text);
  const promiseToRejectedJob =
    promiseAfterBookingRejection ||
    (jobs.length > 0 &&
      text
        .split(/[。！？\n]/u)
        .some(
          (sentence) =>
            BOOKING_PROMISE_PATTERN.test(sentence) &&
            jobs.some((job) => job.nameTokens.some((token) => sentence.includes(token))),
        ));
  if (!reversal && !promiseToRejectedJob) return null;

  const reason = reversal
    ? '本轮工具已返回内部筛选拒绝，回复却宣称"确认有误/条件符合"翻案'
    : bookingRejected
      ? '本轮预约工具已返回内部筛选拒绝，回复仍继续承诺预约/报名'
      : '本轮工具已返回内部筛选拒绝，回复仍承诺帮候选人预约/报名被拒岗位';
  return {
    ruleId: 'screening_rejection_override',
    label:
      `回复在推翻本轮工具的内部筛选拒绝结论（${reason}）。` +
      '被内部硬条件拒绝的岗位不可继续推进：必须用中性理由说明当前岗位暂不匹配（不得透露具体筛选条件），' +
      '并转查其它岗位或拉群收口',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
