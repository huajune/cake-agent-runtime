import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * 预约/报名流程口径错误规则。
 *
 * 职责：
 * - 管“reply 对约面流程状态的说法，与 precheck / handoff 等工具结构化结果冲突”的问题；
 * - 典型包括：precheck 已阻断却继续说可约、等通知岗位却编具体时间、无预约却说已转人工改期/取消；
 * - 也负责收资字段与 precheck 要求字段不一致的检测，因为它会直接影响后续 booking 成功率。
 *
 * 不负责：
 * - 不判断工具失败后是否声称成功，那属于 false-promises 的副作用工具对账；
 * - 不处理岗位事实本身是否可靠，如薪资、距离、品牌，这些分别在对应领域规则里；
 * - 不决定“下一步到底该怎么约”，只负责把明显冲突的对外口径标出来。
 *
 * 动作策略：
 * - 会误导候选人流程状态的口径用 revise，方便上层改写为收集信息/等待通知/首次约面的正确口径；
 * - 收资字段缺失已从 observe 升级为 revise，因为它会直接造成 booking 信息不完整。
 */

const PRECHECK_BLOCKED_BOOKING_CLAIM_PATTERN =
  /(?:可以|能)[^。！？\n]{0,8}(?:约|预约|报名|面试)|(?:预约|报名|面试|到店)[^。！？\n]{0,16}(?:成功|好了|约好了|安排好了)|(?:已|已经|帮你|给你)[^。！？\n]{0,18}(?:约好|预约|报名|安排(?:好)?面试)/;
const BOOKING_SUCCESS_CLAIM_PATTERN =
  /(?:预约|报名|面试|到店)[^。！？\n]{0,16}(?:成功|好了|约好了|安排好了|提交成功)|(?:已|已经|帮你|给你)[^。！？\n]{0,18}(?:约好|预约成功|报名成功|安排(?:好)?面试|提交(?:报名)?)/;
const CONCRETE_INTERVIEW_TIME_PATTERN =
  /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}\s*月\s*\d{1,2}\s*日?[^。！？\n]{0,16}(?:\d{1,2}[:：]\d{2}|\d{1,2}\s*点|[一二两三四五六七八九十]{1,3}\s*点|上午|下午|晚上)|(?:今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天])[^。！？\n]{0,16}(?:\d{1,2}[:：]\d{2}|\d{1,2}\s*点|[一二两三四五六七八九十]{1,3}\s*点|上午|下午|晚上)|\d{1,2}[:：]\d{2}/;
const INTERVIEW_TIME_COLLECTION_PATTERN =
  /(?:哪天|什么时候|什么时间|几点|上午|下午|晚上)[^。！？\n]{0,24}(?:方便|可以|能来|面试|到店)|(?:选|挑|确认|提供|发|补充)[^。！？\n]{0,12}(?:面试)?时间|面试时间[：:]/;
const WAIT_NOTICE_COMPLIANT_PATTERN =
  /不用|不需要|无需|等通知|电话(?:联系|通知)|面试官[^。！？\n]{0,12}(?:联系|通知)|保持电话|留意(?:电话|来电)/;
const HANDOFF_NO_BOOKING_CLAIM_PATTERN =
  /(?:已|已经|帮你|给你)[^。！？\n]{0,16}(?:转人工|反馈给人工|通知人工|改期|取消)|(?:改期|取消)[^。！？\n]{0,8}(?:成功|好了|完成)|人工[^。！？\n]{0,12}(?:联系你|处理)/;
// date_unavailable 的"规定动作"口径：说明所约日期约不上的原因（截止/来不及/已过点），
// 再给替代时段。stage 策略明文要求"unavailable 说明原因并给替代时段"，这种回复不是
// 违规而是标准答案（生产假阳 2026-07-06 守卫档案 id=9："今天已截止…最近能约明天下午1点"）。
const DATE_UNAVAILABLE_ACK_PATTERN =
  /截止|赶不上|来不及|约不了|约不上|报不上|错过|已经?过(?:了|点|时)|(?:今天|当天|这个时间|那天)[^。！？\n]{0,10}(?:不行|没法|约满|排满|满了)/;

export function detectPrecheckBlockedBookingClaim(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  // 先看 reply 是否说了“可约/已约/已安排”，没有成功口径就不需要读工具结果。
  if (!PRECHECK_BLOCKED_BOOKING_CLAIM_PATTERN.test(text)) return null;

  // 取最后一次 precheck，避免同一轮多次尝试时拿到旧判断。
  const precheckCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'duliday_interview_precheck' && call.result);
  const result = asRecord(precheckCall?.result);
  if (!result) return null;

  const nextAction = typeof result.nextAction === 'string' ? result.nextAction : null;
  const ageBoundary = asRecord(result.ageBoundary);
  const nameFieldGuard = asRecord(result.nameFieldGuard);
  const hardAgeReject = nextAction === 'age_rejected' || ageBoundary?.severity === 'hard_reject';
  const nameMustHandoff = nameFieldGuard?.mustHandoff === true;
  // 只有真正阻断 booking 的终态才算冲突。collect_fields / confirm_date 是正常推进态——
  // “填一下资料我帮你约面”正是收资阶段的标准话术，不能当成功口径冲突拦。
  // 上线首日 badcase（batch_6a475a42…935）：collect_fields 被当阻断态触发无谓 repair，
  // 重写版漏收资字段又被 booking_form_field_mismatch 正确拦下，连锁成 repair_exhausted 丢弃整轮。
  const nextActionBlocksBooking =
    nextAction === 'age_rejected' || nextAction === 'date_unavailable';

  // 只有 precheck 明确不允许进入 booking，才认为 reply 成功口径冲突。
  if (!hardAgeReject && !nameMustHandoff && !nextActionBlocksBooking) return null;

  // date_unavailable 仅指"所约那一天约不上"，不是整个 booking 被阻断——precheck 同时
  // 返回 bookableSlots 替代时段。回复只要承认了原日期约不上（说明原因），"最近能约
  // 明天下午1点"就是在转述工具给的替代时段，属于 stage 策略要求的标准动作，放行；
  // 但完成时态的"已约好/预约成功"仍然是编造，不豁免。
  if (nextAction === 'date_unavailable' && !hardAgeReject && !nameMustHandoff) {
    if (DATE_UNAVAILABLE_ACK_PATTERN.test(text) && !BOOKING_SUCCESS_CLAIM_PATTERN.test(text)) {
      return null;
    }
  }

  const reason = hardAgeReject
    ? 'age hard_reject/age_rejected'
    : nameMustHandoff
      ? 'nameFieldGuard.mustHandoff'
      : `nextAction=${nextAction}`;
  return {
    ruleId: 'precheck_blocked_booking_claim',
    label: `precheck 已阻止进入 booking（${reason}），但回复仍声称可约/已约/已安排面试，需改写为收集信息或人工处理口径`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectWaitNoticeTimeFabrication(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  // 必须同时出现约面语境和具体时间，避免把“等通知”本身误判。
  if (!/面试|到店|预约|报到/.test(text)) return null;
  if (!CONCRETE_INTERVIEW_TIME_PATTERN.test(text)) return null;

  const precheckCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'duliday_interview_precheck' && call.result);
  const result = asRecord(precheckCall?.result);
  const interview = asRecord(result?.interview);
  const interviewTimeMode =
    typeof interview?.interviewTimeMode === 'string'
      ? interview.interviewTimeMode
      : typeof result?.interviewTimeMode === 'string'
        ? result.interviewTimeMode
        : null;
  // wait_notice 表示门店/面试官后续通知时间，Agent 不能自己生成时段。
  if (interviewTimeMode !== 'wait_notice') return null;

  return {
    ruleId: 'wait_notice_time_fabrication',
    label:
      'precheck 返回 interviewTimeMode=wait_notice，但回复编造了具体面试/到店时间，需改写为“面试官电话通知/等通知”口径',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectWaitNoticeTimeCollection(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!INTERVIEW_TIME_COLLECTION_PATTERN.test(text)) return null;
  if (WAIT_NOTICE_COMPLIANT_PATTERN.test(text)) return null;

  const precheckCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'duliday_interview_precheck' && call.result);
  const result = asRecord(precheckCall?.result);
  const interview = asRecord(result?.interview);
  const interviewTimeMode =
    typeof interview?.interviewTimeMode === 'string'
      ? interview.interviewTimeMode
      : typeof result?.interviewTimeMode === 'string'
        ? result.interviewTimeMode
        : null;
  if (interviewTimeMode !== 'wait_notice') return null;

  return {
    ruleId: 'wait_notice_time_collection',
    label:
      'precheck 返回 interviewTimeMode=wait_notice，但回复仍在追问/收集面试时间；等通知岗位应说明面试官电话联系，不需要候选人选时间',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectConfirmedBookingTimeMissing(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!BOOKING_SUCCESS_CLAIM_PATTERN.test(text)) return null;
  if (CONCRETE_INTERVIEW_TIME_PATTERN.test(text)) return null;

  const result = readLatestSuccessfulBookingResult(toolCalls);
  if (!result) return null;

  const confirmedTime =
    typeof result._confirmedInterviewTimeHuman === 'string'
      ? result._confirmedInterviewTimeHuman.trim()
      : '';
  if (!confirmedTime) return null;

  // 等通知岗位没有具体时间点，不要求 reply 复述一个不存在的到店时间。
  if (/未指定|等通知|电话(?:联系|通知)|面试官/.test(confirmedTime)) return null;

  return {
    ruleId: 'confirmed_booking_time_missing',
    label: `booking 已成功并返回确认面试时间（${confirmedTime}），但回复只说预约成功、未告知具体时间`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectConfirmedBookingOnSiteScriptMissing(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!BOOKING_SUCCESS_CLAIM_PATTERN.test(text)) return null;

  const result = readLatestSuccessfulBookingResult(toolCalls);
  if (!result) return null;

  const onSiteScript = typeof result._onSiteScript === 'string' ? result._onSiteScript.trim() : '';
  if (!onSiteScript) return null;

  const mentionsDulike = /独立客/.test(text);
  const mentionsReceptionContext = /前台|店长|到店|门店|报(?:一下)?(?:名字|姓名)|应聘/.test(text);
  if (mentionsDulike && mentionsReceptionContext) return null;

  return {
    ruleId: 'confirmed_booking_onsite_script_missing',
    label: `booking 已成功并返回到店脚本（${onSiteScript}），但回复未教候选人到店自报家门`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectHandoffNoBookingClaim(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  // 只有 reply 声称“转人工/改期/取消已处理”时才检查 handoff 结果。
  if (!HANDOFF_NO_BOOKING_CLAIM_PATTERN.test(text)) return null;

  const handoffCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'request_handoff' && call.result);
  const result = asRecord(handoffCall?.result);
  if (!result) return null;
  // handoff.no_booking 的含义是：候选人没有可改/可取消的既有预约，应继续首次约面流程。
  if (result.errorType !== 'handoff.no_booking') return null;

  return {
    ruleId: 'handoff_no_booking_claim',
    label:
      'request_handoff 返回 handoff.no_booking（候选人无已确认预约，应按首次约面继续），但回复声称已转人工/已改期/已取消，需改写为首次约面推进口径',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectBookingFormFieldMismatch(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  // 只对“像收资模板”的回复做字段对账，普通聊天短句不检查。
  const fieldsInReply = extractFormFieldsFromReply(text);
  if (fieldsInReply.length < 3) return null;

  const expected = readExpectedFieldsFromPrecheck(toolCalls);
  if (!expected || expected.length === 0) return null;

  const replySet = new Set(fieldsInReply.map(normalizeFieldName));
  const missing = expected.filter((f) => !replySet.has(normalizeFieldName(f)));
  if (missing.length === 0) return null;

  // 如果候选人回复中已用括号提示或正文收了该字段，不要求字段标题完全一致。
  const trulyMissing = missing.filter((f) => !isFieldCollectedInReply(text, f));
  if (trulyMissing.length === 0) return null;

  return {
    ruleId: 'booking_form_field_mismatch',
    label: `收资模板字段与 precheck.requiredFieldsToCollectNow 不一致，漏掉字段: ${trulyMissing.join('/')}（badcase 67o8y2ez）`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

/**
 * 从候选人可见的模板行里提取字段名。
 * 只认“中文字段名：”这种强格式，并排除“10:30”这类时间冒号。
 */
function extractFormFieldsFromReply(reply: string): string[] {
  const fields: string[] = [];
  const fieldLineRegex = /^\s*([一-龥/]{2,8})(?:[（(][^）)]*[）)])*[：:](?!\s*\d)/;
  for (const line of reply.split(/\r?\n/)) {
    const match = line.match(fieldLineRegex);
    if (match) {
      const parts = match[1].split('/').filter(Boolean);
      fields.push(...parts);
    }
  }
  return fields;
}

/**
 * 读取 precheck 希望本轮收集的字段。
 *
 * 优先级说明：
 * - starterFields 是当前回复模板建议先收的一组字段；
 * - requiredFieldsToCollectNow 是必须收的字段；
 * - missingFields 是兜底字段列表。
 */
function readExpectedFieldsFromPrecheck(toolCalls: AgentToolCall[]): string[] | null {
  const precheck = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'duliday_interview_precheck' && call.result);
  if (!precheck || typeof precheck.result !== 'object' || precheck.result === null) return null;

  const result = precheck.result as Record<string, unknown>;
  const checklist = result.bookingChecklist as Record<string, unknown> | undefined;
  if (!checklist) return null;

  const strategy = checklist.collectionStrategy as Record<string, unknown> | undefined;
  const starterFields = strategy?.starterFields;
  if (Array.isArray(starterFields) && starterFields.length > 0) {
    return starterFields.filter((f): f is string => typeof f === 'string');
  }

  const required = checklist.requiredFieldsToCollectNow;
  if (Array.isArray(required) && required.length > 0) {
    return required.filter((f): f is string => typeof f === 'string');
  }

  const missing = checklist.missingFields;
  if (Array.isArray(missing) && missing.length > 0) {
    return missing.filter((f): f is string => typeof f === 'string');
  }

  return null;
}

function readLatestSuccessfulBookingResult(
  toolCalls: AgentToolCall[],
): Record<string, unknown> | null {
  const bookingCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'duliday_interview_booking' && call.result);
  const result = asRecord(bookingCall?.result);
  if (!result || result.success !== true) return null;
  return result;
}

/**
 * 字段名归一化。
 * 模板里的“联系方式/电话”“经历/经验”属于同义字段，不应因为文案差异误报漏字段。
 */
function normalizeFieldName(name: string): string {
  const trimmed = name.trim();
  if (/电话|联系方式/.test(trimmed)) return '电话';
  if (/经验|过往|经历|公司.*岗位/.test(trimmed)) return '经验';
  if (/健康证/.test(trimmed)) return '健康证';
  if (/学历/.test(trimmed)) return '学历';
  // "你想约哪天面试""想约哪天去面试""什么时候方便面试"都是面试时间字段的口语化写法。
  // 字面匹配曾把带同义标题的完整模板判成漏字段并连杀两版（2026-07-06 守卫档案 id=25）。
  if (
    /面试时间|(?:约|选|挑|定)[^。：:\n]{0,6}(?:哪天|哪一天|什么时候|时间)|哪天[^。：:\n]{0,8}(?:去)?面试|面试[^。：:\n]{0,8}哪天|什么时候[^。：:\n]{0,6}(?:去)?面试/.test(
      trimmed,
    )
  ) {
    return '面试时间';
  }
  if (/籍贯|户籍/.test(trimmed)) return '籍贯';
  if (/身份证(号)?/.test(trimmed)) return '身份证号';
  return trimmed;
}

/**
 * 判断字段是否已经在回复里被收集。
 * 支持两种常见写法：
 * - 字段名：候选人需填写的值；
 * - 括号补充说明中包含字段名，例如“姓名（与身份证一致）”。
 */
function isFieldCollectedInReply(reply: string, fieldName: string): boolean {
  const normalized = normalizeFieldName(fieldName);
  const original = fieldName.trim();
  const terms = [original, normalized].filter((v, i, a) => a.indexOf(v) === i);

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${escaped}(?:[（(][^）)]*[）)])*[：:]\\s*\\S`).test(reply)) return true;
    if (new RegExp(`[（(][^）)]*${escaped}[^）)]*[）)]`).test(reply)) return true;
  }
  if (normalized === '年龄' && /\d{1,3}岁/.test(reply)) return true;
  return false;
}
