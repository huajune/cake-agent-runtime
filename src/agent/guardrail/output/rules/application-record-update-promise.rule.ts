import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { stripMessageDecorations } from '@resolution/candidate/student-identity';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 报名资料修改空头承诺。
 *
 * 候选人自曝报名经历是编造的时，Agent 应引导其从原报名渠道自行更正，或在面试时
 * 主动说明真实情况。当前 runtime 没有修改既有报名表/登记资料的工具，因此不能说
 * “我把报名表改掉 / 我帮你更新”。
 *
 * 规则只在近轮存在明确造假自曝时触发，并要求回复出现第一人称修改动作；
 * “建议你把报名表改成真实信息”这类候选人自行操作的合规建议不会命中。
 */

const FABRICATION_ADMISSION_PATTERN =
  /(?:随便|瞎|乱)[^。！？\n]{0,4}(?:写|填)|(?:写|填)[^。！？\n]{0,4}(?:是)?假(?:的)?|编(?:的|了一?个)|虚假(?:报名|信息|资料)/u;

const FIRST_PERSON_RECORD_ACTOR = String.raw`我(?:这边)?(?:来|先|现在|马上|直接|可以|能|会){0,3}(?:按你(?:刚)?说的)?(?:帮你|给你|替你)?`;
const APPLICATION_RECORD_OBJECT = String.raw`(?:报名表|报名信息|报名资料|登记信息|登记资料|这段经历|这条经历)`;
const APPLICATION_RECORD_DETAIL = String.raw`(?:(?:里|中)(?:的)?[^，,。！？!?\n]{0,8}经历)?`;
const APPLICATION_RECORD_ACTION = String.raw`(?:改(?:下|一下|掉)?|修改(?:下|一下)?|更正(?:下|一下)?|更新(?:下|一下)?|删(?:下|一下|掉)?|删除(?:下|一下)?)`;
const REPLY_PARTICLE = String.raw`(?:哈|呀|呢|吧|啦|哦|噢|哟)?`;

// 三种封闭语序都用白名单连接词组合，避免 `我不能/我无法 ... 报名表 ... 改掉`
// 被主语后的宽泛通配吞掉否定词后误判。
const EXPLICIT_APPLICATION_RECORD_UPDATE_PROMISE_PATTERN = new RegExp(
  String.raw`(?:${FIRST_PERSON_RECORD_ACTOR}(?:把)?(?:你(?:的)?)?${APPLICATION_RECORD_OBJECT}${APPLICATION_RECORD_DETAIL}(?:先|直接)?${APPLICATION_RECORD_ACTION}|${FIRST_PERSON_RECORD_ACTOR}${APPLICATION_RECORD_ACTION}(?:你(?:的)?)?${APPLICATION_RECORD_OBJECT}|${APPLICATION_RECORD_OBJECT}${APPLICATION_RECORD_DETAIL}${FIRST_PERSON_RECORD_ACTOR}${APPLICATION_RECORD_ACTION})`,
  'gu',
);

// 真实 repair 可能只删掉“报名表”宾语，留下“我帮你更新一下”。只有候选人近轮已明确
// 自曝报名经历造假时，才把这种句末省略宾语的第一人称承诺归到本规则；后面仍跟岗位、
// 联系方式等其它宾语时不命中。
const ELLIPTICAL_APPLICATION_RECORD_UPDATE_PROMISE_PATTERN = new RegExp(
  String.raw`(?:${FIRST_PERSON_RECORD_ACTOR}|(?:^|[，,。！？!?\n])(?:好的?|行|可以)?(?:[，,]\s*)?(?:这边)?(?:先|现在|马上|直接|可以)?(?:帮你|给你|替你))${APPLICATION_RECORD_ACTION}${REPLY_PARTICLE}(?=$|[，,。！？!?\n])`,
  'gu',
);

const NEGATED_FIRST_PERSON_PROMISE_PREFIX_PATTERN =
  /(?:不是|并非|不能|不可以|不会|不该|不由|无需|不用|别|不要)(?:由)?[^，,。！？!?\n]{0,8}$/u;

const META_QUOTE_PREFIX_PATTERN =
  /(?:不能说|不要说|别说|不该说|上一版|上一条|刚才那句|这句话|这种说法)[^，,。！？!?\n]{0,6}$/u;
const META_QUOTE_SUFFIX_PATTERN =
  /^[^。！？!?\n]{0,12}(?:不对|不准确|做不到|做不了|办不到|答案是(?:不行|不能)|不能成立|需要删除|要改掉|别这么说)/u;

/**
 * 只删除明确在复述/否定的旧错误话术；用引号强调的真实承诺仍保留并去掉引号参与检测。
 */
function normalizeQuotedSegments(text: string): string {
  return text.replace(
    /“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu,
    (quoted, offset: number) => {
      const prefix = text.slice(0, offset);
      const suffix = text.slice(offset + quoted.length);
      if (META_QUOTE_PREFIX_PATTERN.test(prefix) || META_QUOTE_SUFFIX_PATTERN.test(suffix)) {
        return ' '.repeat(quoted.length);
      }
      return quoted.slice(1, -1);
    },
  );
}

function hasNonNegatedPromise(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const subjectOffset = match[0].search(/我|帮你|给你|替你/u);
    if (subjectOffset < 0) continue;

    const subjectIndex = (match.index ?? 0) + subjectOffset;
    const prefix = text.slice(0, subjectIndex);
    if (!NEGATED_FIRST_PERSON_PROMISE_PREFIX_PATTERN.test(prefix)) return true;
  }
  return false;
}

export function detectUnsupportedApplicationRecordUpdatePromise(
  text: string,
  userMessage?: string,
  recentUserTexts?: readonly string[],
): RuleContradiction | null {
  const admission = [...(recentUserTexts ?? []), ...(userMessage ? [userMessage] : [])].some(
    (message) => FABRICATION_ADMISSION_PATTERN.test(stripMessageDecorations(message)),
  );
  if (!admission) return null;

  const candidateVisibleText = normalizeQuotedSegments(text);
  if (
    !hasNonNegatedPromise(
      candidateVisibleText,
      EXPLICIT_APPLICATION_RECORD_UPDATE_PROMISE_PATTERN,
    ) &&
    !hasNonNegatedPromise(
      candidateVisibleText,
      ELLIPTICAL_APPLICATION_RECORD_UPDATE_PROMISE_PATTERN,
    )
  ) {
    return null;
  }

  return {
    ruleId: 'application_record_update_promise',
    label:
      '候选人自曝报名经历造假后，回复承诺由 Agent 修改/更新既有报名资料；当前没有可支撑该动作的工具，候选人会误以为错误资料已被处理',
    action: GUARDRAIL_ACTION.REVISE,
    feedbackToGenerator:
      '候选人已说明报名经历是编造的，但当前没有修改既有报名表或登记资料的工具。上一版“我把报名表改掉/我帮你更新”属于无动作支撑的能力承诺，当前文本不可发送。' +
      '请改为候选人可自行执行的真实下一步：能从原报名渠道更正就先更正；暂时改不了，就在面试时主动说明真实情况。' +
      '保留拒绝造假与如实说明的内容，删除所有声称由你修改、更新或删除既有报名资料的话术，不得新增岗位事实。',
  };
}
