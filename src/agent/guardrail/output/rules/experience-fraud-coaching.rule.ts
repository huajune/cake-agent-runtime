import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { stripMessageDecorations } from '@tools/shared/identity-statement.util';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 工作经历造假教唆规则（identity_misregistration_coaching 的经历轴姊妹规则）。
 *
 * badcase scyjp2kx（chat 6a702fae…，2026-08-03）：候选人自曝报名表里的
 * "盒马分拣"经历是"随便写的"（且已被其他平台判过虚假报名），Agent 先教
 * "面试时如实说有相关经验就行"，最后升级为"你就说之前在盒马做过一段时间，
 * 现在想换个离家近的继续做，这样反而更自然"，并编造"这家不查过往记录"背书。
 *
 * 职责：
 * - 仅当候选人近轮明确自曝信息是编造的（"随便写的/瞎填的/编的/填的是假的"）时，
 *   拦回复中的两类话术：
 *   a) 教唆在面试中声称拥有该经历（"就说做过/说有相关经验"）；
 *   b) 以"门店不查记录/不核对资料"为造假背书。
 * - 引导如实更正的话术不拦："就说之前没做过，愿意学就行"是本案的正确口径，
 *   由 (?<![没未]) 负向断言豁免。
 *
 * 不负责：
 * - 不猜候选人经历真假：无自曝证据时任何"说有经验"话术都不触发（真有经验的
 *   候选人被建议如实展示经验是正常辅导）；
 * - 年龄/健康证等其他字段的造假教唆仍是 residualRisk（identity 规则同款）。
 */

// 候选人自曝造假：随便/瞎/乱+写/填、"填的是假的"、"编的"、"虚假报名/信息"
const FABRICATION_ADMISSION_PATTERN =
  /(?:随便|瞎|乱)[^。！？\n]{0,4}(?:写|填)|(?:写|填)[^。！？\n]{0,4}(?:是)?假(?:的)?|编(?:的|了一?个)|虚假(?:报名|信息|资料)/u;

// 教唆声称经历："就说…做过/干过"、"说(有)相关经验"；(?<![没未]) 豁免"就说没做过"类如实引导
const CLAIM_EXPERIENCE_COACHING_PATTERN =
  /(?:你)?就说[^。！？\n]{0,20}(?<![没未])(?:做过|干过)|说[^。！？\n]{0,6}有(?:相关|这方面|这类)?经[验历]/u;

// "不查过往记录"类背书：Agent 无从得知门店核查机制，该断言本身即编造
const NO_RECORD_CHECK_CLAIM_PATTERN =
  /不(?:会)?(?:查|核对|核查|看)[^。！？\n]{0,8}(?:过往|历史|报名)?(?:记录|经历|资料)/u;

/**
 * 检测在候选人自曝经历造假后，教唆其在面试中继续声称该经历的话术。
 *
 * 触发门（两条件缺一不可）：
 * 1. 候选人近轮消息（含本轮）存在造假自曝；
 * 2. 回复含声称经历教唆或"不查记录"背书。
 */
export function detectExperienceFraudCoaching(
  text: string,
  userMessage?: string,
  recentUserTexts?: readonly string[],
): RuleContradiction | null {
  const coachingClaim = CLAIM_EXPERIENCE_COACHING_PATTERN.test(text);
  const noRecordCheckClaim = NO_RECORD_CHECK_CLAIM_PATTERN.test(text);
  if (!coachingClaim && !noRecordCheckClaim) return null;

  const admission = [...(recentUserTexts ?? []), ...(userMessage ? [userMessage] : [])].some(
    (message) => FABRICATION_ADMISSION_PATTERN.test(stripMessageDecorations(message)),
  );
  if (!admission) return null;

  const reason = coachingClaim
    ? '候选人已自曝该经历是编造的，回复仍教唆其在面试中声称做过/有经验'
    : '候选人已自曝信息造假，回复以"不查过往记录"为其背书';
  return {
    ruleId: 'experience_fraud_coaching',
    label:
      `回复在教唆候选人虚构工作经历（${reason}），属诚信红线。` +
      '必须改写为如实口径：引导候选人面试时如实说明没有相关经历但愿意学；' +
      '登记信息与事实不符时引导更正，不得声称门店不查记录',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
