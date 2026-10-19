/**
 * 把 booking 工具结果格式化成 Agent 直接照实复述的回复字段。
 *
 * 历史 badcase 三件套：
 * - waugdoxa / 2za5e0ek：约面成功后 Agent 只说"周三 13:30-16:30 都行"区间话术，候选人不知道几点到
 * - keciu6u6：Agent 漏说"到店跟前台说独立客招聘介绍来的"，候选人到店被店长当陌生人推托
 *
 * 把"精确时间点"和"到店脚本"作为工具事实输出（`_confirmedInterviewTimeHuman` / `_onSiteScript`），
 * Agent 看到结构化字段就会照实复述，不依赖 prompt 文字约束。
 */

import { WEEKDAY_LABELS_SHORT } from '@infra/utils/chinese-numeral.util';
import { requiresStoreVisit, type InterviewMethod } from '@sponge/interview-method';

/**
 * 把 "YYYY-MM-DD HH:mm:ss" 格式的 interviewTime 转成候选人能直接读的自然时间。
 *
 * 示例：'13:30:00' → '5月19日（周三）13:30'
 *
 * 输入不符合预期格式时原样返回，让上游 Agent 至少有兜底信息。
 */
export function formatInterviewTimeForReply(interviewTime: string): string {
  const match = interviewTime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):\d{2}$/);
  if (!match) return interviewTime;
  const [, , mm, dd, hh, min] = match;
  const date = new Date(interviewTime.replace(' ', 'T'));
  const weekday = Number.isNaN(date.getDay()) ? '' : `（${WEEKDAY_LABELS_SHORT[date.getDay()]}）`;
  return `${Number(mm)}月${Number(dd)}日${weekday}${hh}:${min}`;
}

/**
 * 预约成功回执的到店形态，决定附带到店脚本还是线上提醒。
 *
 * - `on_site`：面试方式为线下面试，附 `_onSiteScript`。
 * - `remote`：AI / 电话 / 视频面试，附 `_onlineInterviewGuide`；无条件附到店脚本会让
 *   Agent 在同一轮既说"线上完成"又说"到店跟前台说……"。
 * - `unknown`：面试方式缺失或枚举外（后台必填，生产只见于岗位失效），两样都不附。
 *
 * 面试方式是海绵四值单选（`@sponge/interview-method`），这里不再读备注自由文本做分类。
 */
export type InterviewReceiptMode = 'on_site' | 'remote' | 'unknown';

export function resolveInterviewReceiptMode(
  interviewMethod: InterviewMethod | null | undefined,
): InterviewReceiptMode {
  if (!interviewMethod) return 'unknown';
  return requiresStoreVisit(interviewMethod) ? 'on_site' : 'remote';
}

/**
 * 等通知岗位（提交时不选面试时间）的候选人可见口径，按海绵四值面试方式分支。
 *
 * 此前一律「面试官会电话联系你」：AI 面试岗位实际是短信发面试链接，候选人等电话
 * 等不到就流失（生产 trace batch_6acf1cc3ce406a6aeee8d66c_1791960188741，precheck 已返回
 * interview.method=AI面试）。措辞草案待运营最终裁定。
 *
 * booking 回执、转人工前回执与 precheck 时间模式说明共用本函数，不得各自再写话术。
 */
export function describeWaitNoticeForCandidate(
  interviewMethod: InterviewMethod | null | undefined,
  processRemark?: string | null,
): string {
  switch (interviewMethod) {
    case 'AI面试':
      return (
        '第一轮是 AI 面试，面试链接会短信发到你手机，留意短信并按时完成；通过后店长再联系你。' +
        (firstSentence(processRemark) ? `流程说明：「${firstSentence(processRemark)}」。` : '')
      );
    case '视频面试':
      return '面试形式是视频面试，留意视频面试通知，请保持手机畅通。';
    case '电话面试':
      return '面试官会电话联系你，请保持电话畅通。';
    case '线下面试':
      return '面试形式是线下面试，请等待具体面试安排，保持手机畅通。';
    default:
      return '请等待面试安排通知，保持手机畅通。';
  }
}

/**
 * 给模型的等通知回执指引（`_waitNoticeReplyGuide`）：候选人口径 + 面试方式对应的禁令，
 * AI 面试再并入岗位流程说明第一句（海绵「面试备注」常写明链接发送时间/完成截止）。
 */
export function buildWaitNoticeReplyGuide(params: {
  interviewMethod: InterviewMethod | null | undefined;
  processRemark?: string | null;
}): string {
  const candidateLine = describeWaitNoticeForCandidate(
    params.interviewMethod,
    params.processRemark,
  );
  const base = `告知候选人资料已提交，并照实说明：${candidateLine}禁止编造时间。`;
  if (params.interviewMethod === 'AI面试') {
    return `${base}这个岗位第一轮是 AI 面试，禁止说"面试官会电话联系"。`;
  }
  if (params.interviewMethod === '视频面试') {
    return `${base}禁止说"面试官会电话联系"或"到店面试"。`;
  }
  return base;
}

function firstSentence(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const lead = trimmed.split(/[。；;！!\n]/u)[0]?.trim();
  return lead ? lead : null;
}

export interface ManualInterviewGroupHandling {
  required: true;
  delivery: 'manual';
  groupNameHint?: string;
  candidateGuide: string;
}

const INTERVIEW_GROUP_SIGNAL_PATTERN = /面试群/u;
const INTERVIEW_GROUP_NAME_PATTERN = /((?:[\u4e00-\u9fa5A-Za-z0-9&·_-]{1,16})面试群)/u;

/**
 * 识别“预约成功后需要由当前企微账号手动补发面试群”的岗位流程。
 *
 * invite_to_group 只能发送兼职岗位信息群，不能完成面试群邀请。这里把两类群的
 * 语义边界固化为 booking 结构化结果，供 Agent 回执和 post-delivery handoff 共用。
 */
export function resolveManualInterviewGroupHandling(params: {
  interviewRemark?: string | null;
  flowDescription?: string | null;
}): ManualInterviewGroupHandling | null {
  const policyText = [params.interviewRemark, params.flowDescription]
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n');
  if (!INTERVIEW_GROUP_SIGNAL_PATTERN.test(policyText)) return null;

  const rawGroupName = policyText.match(INTERVIEW_GROUP_NAME_PATTERN)?.[1];
  const groupNameHint = rawGroupName
    ?.replace(/^(?:让人选|请候选人|候选人)?(?:添加|加入|进入|进)/u, '')
    .trim();

  return {
    required: true,
    delivery: 'manual',
    ...(groupNameHint ? { groupNameHint } : {}),
    candidateGuide:
      '这次面试用的是单独的面试群，我这边接着发你邀请。收到后进群备注好姓名+手机号，' +
      '群里会发腾讯会议链接，到时候按时上线入会就行。',
  };
}

/**
 * 构造候选人到店报到时的自报家门脚本。
 *
 * 包含三要素：(1) "独立客招聘介绍来的"（必须用「独立客」不能用变体），
 * (2) 候选人真实姓名，(3) 应聘岗位名。任一缺失时跳过该要素，保持脚本可读。
 */
export function buildOnSiteScript(params: {
  candidateName: string | null | undefined;
  jobName: string | null | undefined;
}): string {
  const parts: string[] = ['独立客招聘介绍来的'];
  if (params.candidateName?.trim()) parts.push(`姓名 ${params.candidateName.trim()}`);
  if (params.jobName?.trim()) parts.push(`应聘 ${params.jobName.trim()}`);
  return `到店跟前台/店长说"${parts.join('，')}"`;
}
