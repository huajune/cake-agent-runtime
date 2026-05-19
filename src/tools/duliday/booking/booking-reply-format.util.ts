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
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = Number.isNaN(date.getDay()) ? '' : `（${weekdays[date.getDay()]}）`;
  return `${Number(mm)}月${Number(dd)}日${weekday}${hh}:${min}`;
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
