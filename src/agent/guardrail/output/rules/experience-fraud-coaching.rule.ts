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
 * - 引导如实更正的话术不拦："就说之前没做过，愿意学就行"是本案的正确口径。
 *
 * 不负责：
 * - 不猜候选人经历真假：无自曝证据时任何"说有经验"话术都不触发（真有经验的
 *   候选人被建议如实展示经验是正常辅导）；
 * - 年龄/健康证等其他字段的造假教唆仍是 residualRisk（identity 规则同款）。
 */

// 候选人自曝造假：随便/瞎/乱+写/填、"填的是假的"、"编的"、"虚假报名/信息"
const FABRICATION_ADMISSION_PATTERN =
  /(?:随便|瞎|乱)[^。！？\n]{0,4}(?:写|填)|(?:写|填)[^。！？\n]{0,4}(?:是)?假(?:的)?|编(?:的|了一?个)|虚假(?:报名|信息|资料)/u;

const EXPERIENCE_ACTION_PATTERN = /(?:做过|干过)/gu;
const EXPERIENCE_CLAIM_PATTERN =
  /有(?!(?:没有|无|必要|可能|多少|几|哪些|什么))(?:(?:相关|这方面|这类)|[\p{Script=Han}A-Za-z0-9·_-]{1,8})?经[验历]/gu;
const CLAUSE_BOUNDARY_PATTERN = /[，,；;。！？!?\n]/u;
const SENTENCE_BOUNDARY_PATTERN = /[；;。！？!?\n]/u;
const SPEECH_CUE_PATTERN = /(?:说明|声称|表示|宣称|告诉|回答|答(?!案|复|应)|说(?!法)|讲(?!法))/gu;
const NEGATED_SPEECH_CUE_PATTERN =
  /(?:(?:请勿|不要|别|不能|不得|不会|不应|不该|不可以|不可|禁止|避免|无需|不必|没(?:有)?必要)|不建议(?:你|候选人)?)(?:(?![，,；;。！？!?\n]|但|不过|却|可是|而是|而要).){0,28}$/u;
const NON_SPEECH_NEGATION_PATTERN =
  /^(?:(?:不要|别)(?:(?:再|继续|总是|老是))?(?:担心|紧张|害怕|着急|慌|怕)|不要紧)/u;
const DOUBLE_NEGATED_SPEECH_PATTERN = /^(?:不能|不得|不会)不/u;
const AFFIRMATIVE_NON_OMISSION_SPEECH_PATTERN = /^(?:不会|不要|别)(?:忘记|忘了|漏(?:了|掉)?)/u;
const NEGATION_RESET_PATTERN = /(?:而是|而要|改(?:为|成)?)[^，,；;。！？!?\n]{0,6}$/u;
const THIRD_PARTY_SPEAKER_PATTERN =
  /^(?:根据|按照)?(?:这家|该|这个)?(?:岗位(?:介绍|要求)?|职位(?:介绍|要求)?|招聘(?:信息|方|人员)?|门店|店家|公司|面试官|店长|页面|公告|规则|数据|材料|文件|要求)(?:这边|那边)?$/u;
const RECOLLECTION_SPEAKER_PATTERN =
  /(?:^|[，,])你(?:刚才|之前|前面|先前|已经|曾经)(?:(?:跟|向)(?:我|我们))?$/u;
const CANDIDATE_SPEAKER_PATTERN = /^(?:你|候选人)$/u;
const TRUTHFUL_EXPERIENCE_CONDITION_PATTERN =
  /(?:如果|若|只有|前提是)(?:(?![；;。！？!?\n]).){0,36}(?:确实|真实|实际)(?:(?![；;。！？!?\n]).){0,18}(?:做过|干过|有(?:(?:相关|这方面|这类)|[\p{Script=Han}A-Za-z0-9·_-]{1,8})?经[验历])(?:(?![；;。！？!?\n]).){0,24}$/u;
const TRUTHFUL_CONTRAST_PREFIX_PATTERN =
  /与其[^，,；;。！？!?\n]{0,16}(?:说|讲)[^，,；;。！？!?\n]{0,8}$/u;
const TRUTHFUL_CONTRAST_SUFFIX_PATTERN =
  /^[^；;。！？!?\n]{0,24}(?:不如|倒不如|而应|而要)[^；;。！？!?\n]{0,16}(?:如实|坦诚|照实|真实)[^；;。！？!?\n]{0,12}(?:没有|没做过|没干过|无(?:相关)?经[验历])/u;

const EXPERIENCE_QUESTION_PATTERN =
  /问(?:你|候选人)?[^，,；;。！？!?\n]{0,10}(?:有没有|有无|是否有|有)(?:(?:相关|这方面|这类)|[\p{Script=Han}A-Za-z0-9·_-]{1,8})?经[验历](?:吗)?/gu;
const ELLIPTICAL_AFFIRMATIVE_ANSWER_PATTERN =
  /^(?:你)?(?:就|直接|要|得|应该|可以)?(?:说|回答|答(?!应))[：:]?[“"「『']?有(?:的)?[”"」』']?(?!没有|无|还是|或者|或|误)/u;
const EXPERIENCE_PACKAGING_PATTERN =
  /(?:把|将)[^，,；;。！？!?\n]{0,16}(?:经历|经验|履历|工作内容|报名信息)[^，,；;。！？!?\n]{0,8}(?:包装|美化)(?:成|为)[^，,；;。！？!?\n]{0,16}(?:做过|干过|有(?:(?:相关|这方面|这类)|[\p{Script=Han}A-Za-z0-9·_-]{1,8})?经[验历])/gu;
const NEGATED_PACKAGING_PREFIX_PATTERN =
  /(?:请勿|不要|别|不能|不得|不应|不该|不可以|不可|禁止|避免|拒绝|不建议)(?:再|继续|试图)?[^，,；;。！？!?\n]{0,6}$/u;
const TRUTHFUL_PACKAGING_CORRECTION_SUFFIX_PATTERN =
  /^(?:的说法|的话术)?(?:不对|不真实|是假的|应改回|要改回|改回|并如实|，?而应如实|，?要如实)/u;

function clausePrefixBefore(text: string, index: number, maxLength: number): string {
  const windowStart = Math.max(0, index - maxLength);
  const window = text.slice(windowStart, index);
  let boundary = -1;
  for (let cursor = window.length - 1; cursor >= 0; cursor -= 1) {
    if (CLAUSE_BOUNDARY_PATTERN.test(window[cursor])) {
      boundary = cursor;
      break;
    }
  }
  return window.slice(boundary + 1);
}

function sentencePrefixBefore(text: string, index: number, maxLength: number): string {
  const windowStart = Math.max(0, index - maxLength);
  const window = text.slice(windowStart, index);
  let boundary = -1;
  for (let cursor = window.length - 1; cursor >= 0; cursor -= 1) {
    if (SENTENCE_BOUNDARY_PATTERN.test(window[cursor])) {
      boundary = cursor;
      break;
    }
  }
  return window.slice(boundary + 1);
}

function hasNegatedExperienceAction(prefixAfterCue: string): boolean {
  return /(?:没有|没|未曾|从未|从来没(?:有)?|并没有|不曾)[^，,；;。！？!?\n]{0,12}$/u.test(
    prefixAfterCue,
  );
}

function hasNegatedExperienceClaim(prefixAfterSay: string): boolean {
  return /(?:并没有|从来没(?:有)?|从未|未曾|不曾|并非|不太|算不上|不具|没有|没|未)$/u.test(
    prefixAfterSay.trim(),
  );
}

function isInterrogativeExperienceAction(
  text: string,
  matchEnd: number,
  prefixAfterCue: string,
): boolean {
  if (/^(?:什么|哪些|哪类|多久|几年)/u.test(text.slice(matchEnd, matchEnd + 8))) return true;
  return /(?:是否|有无|有没有)$/u.test(prefixAfterCue.trim());
}

function isInterrogativeExperienceClaim(matchedText: string, prefixAfterCue: string): boolean {
  if (
    /^有(?:(?:过)?(?:没有|无|多少|几|哪些|什么|哪(?:些|方面|类)?)|(?:还是|或者|或)没有)/u.test(
      matchedText,
    )
  ) {
    return true;
  }
  return /(?:是否|有无)$/u.test(prefixAfterCue.trim());
}

function isRequirementClaim(text: string, matchEnd: number): boolean {
  return /^(?:要求|者优先)/u.test(text.slice(matchEnd, matchEnd + 8));
}

interface SpeechCueScope {
  beforeCue: string;
  afterCue: string;
  sentencePrefix: string;
  sentenceSuffix: string;
  negated: boolean;
  thirdPartySpeaker: boolean;
  recollection: boolean;
}

function findSpeechCueScope(text: string, assertionIndex: number): SpeechCueScope | null {
  const prefix = sentencePrefixBefore(text, assertionIndex, 64);
  const cues = Array.from(prefix.matchAll(SPEECH_CUE_PATTERN));
  const cue = cues.at(-1);
  if (!cue) return null;

  const cueIndex = cue.index ?? 0;
  const beforeCue = clausePrefixBefore(prefix, cueIndex, 64).trim();
  const match = beforeCue.match(NEGATED_SPEECH_CUE_PATTERN);
  const afterCue = prefix.slice(cueIndex + cue[0].length);
  const sentenceEndOffset = text.slice(assertionIndex).search(SENTENCE_BOUNDARY_PATTERN);
  const sentenceSuffix = text.slice(
    assertionIndex,
    sentenceEndOffset < 0 ? text.length : assertionIndex + sentenceEndOffset + 1,
  );

  if (!match) {
    return {
      beforeCue,
      afterCue,
      sentencePrefix: prefix,
      sentenceSuffix,
      negated: false,
      thirdPartySpeaker: THIRD_PARTY_SPEAKER_PATTERN.test(beforeCue),
      recollection: RECOLLECTION_SPEAKER_PATTERN.test(beforeCue),
    };
  }

  // “不是不能说”是双重否定，不能因末尾的“不能”把真正的正向教唆放行。
  const beforeNegation = beforeCue.slice(0, match.index ?? 0).trim();
  const negatedSpan = match[0].trim();
  const speechCueInsideNegatedSpan =
    Array.from(negatedSpan.matchAll(SPEECH_CUE_PATTERN)).length > 0;
  const doubleNegated =
    /(?:不是|并非)$/u.test(beforeNegation) || DOUBLE_NEGATED_SPEECH_PATTERN.test(negatedSpan);
  const nonSpeechNegation =
    NON_SPEECH_NEGATION_PATTERN.test(negatedSpan) ||
    AFFIRMATIVE_NON_OMISSION_SPEECH_PATTERN.test(negatedSpan);
  const negationReset = NEGATION_RESET_PATTERN.test(afterCue);
  return {
    beforeCue,
    afterCue,
    sentencePrefix: prefix,
    sentenceSuffix,
    negated: !doubleNegated && !nonSpeechNegation && !speechCueInsideNegatedSpan && !negationReset,
    thirdPartySpeaker: THIRD_PARTY_SPEAKER_PATTERN.test(beforeCue),
    recollection: RECOLLECTION_SPEAKER_PATTERN.test(beforeCue),
  };
}

function isQuestionOrChoiceAssertion(
  text: string,
  matchEnd: number,
  scope: SpeechCueScope,
): boolean {
  const suffix = text.slice(matchEnd, matchEnd + 28);
  if (/^(?:还是|或者|或)没(?:有)?(?:做过|干过)?/u.test(suffix)) return true;
  if (/^(?:吗|么|呢|？|\?)/u.test(suffix)) return true;

  // “你是说……其实不真实吗？”属于对候选人陈述的疑问承接，不是让其这样说。
  return (
    /(?:^|[，,])你(?:是|的意思是)$/u.test(scope.beforeCue) &&
    /(?:吗|么|呢|？|\?)/u.test(scope.sentenceSuffix)
  );
}

function isNonCoachingSpeechScope(scope: SpeechCueScope): boolean {
  if (scope.negated || scope.thirdPartySpeaker || scope.recollection) return true;
  if (
    CANDIDATE_SPEAKER_PATTERN.test(scope.beforeCue) &&
    FABRICATION_ADMISSION_PATTERN.test(scope.sentenceSuffix)
  ) {
    return true;
  }
  if (
    TRUTHFUL_CONTRAST_PREFIX_PATTERN.test(scope.sentencePrefix) &&
    TRUTHFUL_CONTRAST_SUFFIX_PATTERN.test(scope.sentenceSuffix)
  ) {
    return true;
  }
  return TRUTHFUL_EXPERIENCE_CONDITION_PATTERN.test(scope.sentencePrefix);
}

function containsExperienceCoachingClaim(text: string): boolean {
  for (const match of text.matchAll(EXPERIENCE_PACKAGING_PATTERN)) {
    const index = match.index ?? 0;
    const prefix = clausePrefixBefore(text, index, 32);
    const suffix = text.slice(index + match[0].length, index + match[0].length + 24);
    if (NEGATED_PACKAGING_PREFIX_PATTERN.test(prefix)) continue;
    if (TRUTHFUL_PACKAGING_CORRECTION_SUFFIX_PATTERN.test(suffix)) continue;
    return true;
  }

  for (const match of text.matchAll(EXPERIENCE_ACTION_PATTERN)) {
    const scope = findSpeechCueScope(text, match.index ?? 0);
    if (!scope || isNonCoachingSpeechScope(scope)) continue;
    if (
      isInterrogativeExperienceAction(text, (match.index ?? 0) + match[0].length, scope.afterCue) ||
      isQuestionOrChoiceAssertion(text, (match.index ?? 0) + match[0].length, scope)
    ) {
      continue;
    }
    if (!hasNegatedExperienceAction(scope.afterCue)) return true;
  }

  for (const match of text.matchAll(EXPERIENCE_CLAIM_PATTERN)) {
    const scope = findSpeechCueScope(text, match.index ?? 0);
    if (!scope || isNonCoachingSpeechScope(scope)) continue;
    if (isInterrogativeExperienceClaim(match[0], scope.afterCue)) continue;
    if (isQuestionOrChoiceAssertion(text, (match.index ?? 0) + match[0].length, scope)) {
      continue;
    }
    if (isRequirementClaim(text, (match.index ?? 0) + match[0].length)) continue;
    if (!hasNegatedExperienceClaim(scope.afterCue)) return true;
  }

  return containsEllipticalExperienceCoaching(text);
}

function containsEllipticalExperienceCoaching(text: string): boolean {
  for (const question of text.matchAll(EXPERIENCE_QUESTION_PATTERN)) {
    const questionEnd = (question.index ?? 0) + question[0].length;
    const remainder = text.slice(questionEnd);
    const boundaryIndex = remainder.search(SENTENCE_BOUNDARY_PATTERN);
    const sameSentenceRemainder = remainder.slice(0, boundaryIndex < 0 ? undefined : boundaryIndex);
    const answerClause = sameSentenceRemainder.replace(/^[^，,]{0,8}[，,]\s*/u, '').trim();
    if (ELLIPTICAL_AFFIRMATIVE_ANSWER_PATTERN.test(answerClause)) return true;
  }
  return false;
}

// "不查过往记录"类背书：Agent 无从得知门店核查机制，该断言本身即编造
const NO_RECORD_CHECK_CLAIM_PATTERN =
  /不(?:会)?(?:查|核对|核查|看)[^。！？\n]{0,8}(?:过往|历史|报名)?(?:记录|经历|资料)/gu;

function isMetaNegatedNoRecordClaim(text: string, index: number, end: number): boolean {
  const prefix = clausePrefixBefore(text, index, 28);
  if (
    /(?:这|那)?不(?:能)?代表[^，,；;。！？!?\n]{0,12}$|(?:并)?不是说[^，,；;。！？!?\n]{0,12}$|(?:我|我们)?没有说[^，,；;。！？!?\n]{0,12}$/u.test(
      prefix,
    )
  ) {
    return true;
  }
  if (
    /(?:不能|不要|别|不可|不应|不得|无法)(?:再)?(?:认为|觉得|以为|假设|指望|保证)?[^，,；;。！？!?\n]{0,6}$/u.test(
      prefix,
    )
  ) {
    return true;
  }

  const suffix = text.slice(end, end + 20);
  return /^[”」』"']?(?:这种|这个)?(?:说法|想法)?(?:不对|不成立|不可信|不能信|别信|不要信|是错的)/u.test(
    suffix,
  );
}

function containsNoRecordCheckClaim(text: string): boolean {
  for (const match of text.matchAll(NO_RECORD_CHECK_CLAIM_PATTERN)) {
    const index = match.index ?? 0;
    if (!isMetaNegatedNoRecordClaim(text, index, index + match[0].length)) return true;
  }
  return false;
}

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
  const coachingClaim = containsExperienceCoachingClaim(text);
  const noRecordCheckClaim = containsNoRecordCheckClaim(text);
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
