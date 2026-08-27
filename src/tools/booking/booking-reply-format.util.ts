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

/**
 * 把 "YYYY-MM-DD HH:mm:ss" 格式的 interviewTime 转成候选人能直接读的自然时间。
 *
 * 示例：'2026-05-19 13:30:00' → '5月19日（周三）13:30'
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
 * 判断岗位是否为线上（非到店）面试，用于决定预约成功后要不要附带到店脚本。
 *
 * badcase chat 6a5f3080（佛山必胜客）：岗位面试备注写明"线上面试、群里发腾讯会议链接"，
 * 但 booking 成功结果无条件附带 _onSiteScript，Agent 同一轮既说"线上腾讯会议"又说
 * "到店跟前台说……"，自相矛盾。
 *
 * 判定口径刻意保守：只有面试方式或面试备注出现**明确线上信号**才判线上；
 * 空值/未知一律按到店处理，避免回归 badcase keciu6u6（漏发到店脚本，候选人
 * 到店被当陌生人）。面试方式明确写"线下/到店/现场"时，即便备注含"线上"字样
 * （如混合流程）也按到店处理。
 */
// “先电话沟通，合适后通知线下面试”属于两段式流程，初始环节不应发送到店脚本。
// 这里只收强电话初面信号；“保持电话畅通/有变动会电话联系”等到店岗常见措辞不收。
const ONLINE_INTERVIEW_SIGNAL_PATTERN =
  /线上面试|线上形式|线上进行|视频面试|电话面试|电话初面|电话初试|先电话沟通|电话沟通后|先电话联系|远程面试|腾讯会议|会议链接|入会|钉钉会议|飞书会议/;
const OFFLINE_INTERVIEW_METHOD_PATTERN = /线下|到店|现场|当面|门店面试/;

export function isOnlineInterview(params: {
  interviewType?: string | null;
  interviewRemark?: string | null;
  flowDescription?: string | null;
}): boolean {
  const type = params.interviewType?.trim() ?? '';
  if (OFFLINE_INTERVIEW_METHOD_PATTERN.test(type)) return false;
  if (/线上|视频|电话|远程/.test(type)) return true;
  const freeText = [params.interviewRemark, params.flowDescription]
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n');
  return ONLINE_INTERVIEW_SIGNAL_PATTERN.test(freeText);
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
 * 包含三要素：(1) "独立客招聘介绍来的"（badcase wcyayxpf：必须用「独立客」不能用变体），
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
